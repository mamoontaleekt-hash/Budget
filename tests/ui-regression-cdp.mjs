import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9351;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${resolve(profilePath)}`,
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function target(){
  for(let attempt=0; attempt<80; attempt+=1){
    try{
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((candidate) => candidate.type === "page");
      if(page) return page;
    }catch{}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener("open", resolveOpen, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
const errors = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if(message.id){
    const job = pending.get(message.id);
    if(!job) return;
    pending.delete(message.id);
    if(message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result || {});
    return;
  }
  const queue = eventWaiters.get(message.method);
  if(queue?.length) queue.shift()(message.params || {});
  if(message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.text || "Runtime exception");
  if(message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(message.params.entry.text);
});

function send(method, params={}){
  const id = ++nextId;
  return new Promise((resolveSend, reject) => {
    pending.set(id, {resolve:resolveSend, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
function waitEvent(method, timeout=20000){
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeout);
    const queue = eventWaiters.get(method) || [];
    queue.push((params) => { clearTimeout(timer); resolveEvent(params); });
    eventWaiters.set(method, queue);
  });
}
async function evaluate(expression){
  const response = await send("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true, userGesture:true});
  if(response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Evaluation failed");
  return response.result?.value;
}
async function navigate(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", {url:appUrl});
  await loaded;
  await delay(1500);
}
async function reload(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", {ignoreCache:false});
  await loaded;
  await delay(1000);
}

const synthetic = {
  version:1,
  categories:[
    {id:"in_salary",type:"income",name:"راتب"},
    {id:"in_other",type:"income",name:"دخل آخر"},
    {id:"ex_living",type:"expense",name:"معيشة"},
  ],
  transactions:[
    {id:"june-income",type:"income",amount:1000,date:"2026-06-01",categoryId:"in_salary",note:"راتب حزيران",createdAt:"2026-06-01"},
    {id:"june-expense",type:"expense",amount:400,date:"2026-06-02",categoryId:"ex_living",note:"معيشة",createdAt:"2026-06-02"},
    {id:"july-income",type:"income",amount:500,date:"2026-07-01",categoryId:"in_salary",note:"راتب تموز",createdAt:"2026-07-01"},
    {id:"july-expense",type:"expense",amount:100,date:"2026-07-02",categoryId:"ex_living",note:"معيشة",createdAt:"2026-07-02"},
    {id:"aug-legacy",type:"income",amount:300000,date:"2026-08-01",categoryId:"in_other",note:"رصيد مرحل قديم",createdAt:"2026-08-01"},
    {id:"aug-income",type:"income",amount:3000000,date:"2026-08-02",categoryId:"in_salary",note:"راتب آب",createdAt:"2026-08-02"},
    {id:"aug-expense",type:"expense",amount:2500000,date:"2026-08-03",categoryId:"ex_living",note:"معيشة آب",createdAt:"2026-08-03"},
    {id:"deleted",type:"expense",amount:999999,date:"2026-08-04",categoryId:"ex_living",note:"محذوف",createdAt:"2026-08-04",deletedAt:"2026-08-05"},
    {id:"sep-income",type:"income",amount:100000,date:"2026-09-01",categoryId:"in_salary",note:"دخل أيلول",createdAt:"2026-09-01"},
  ],
  budgets:{"2026-08":{plan:{income1:3000000,income2:0,note:"خطة"},items:{ex_living:{amount:2600000,note:"ميزانية"}}}},
};

try{
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Network.enable"),send("Log.enable")]);
  await navigate();
  await evaluate(`localStorage.setItem('pfm_data_v1', ${JSON.stringify(JSON.stringify(synthetic))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-08'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);

  const legacyBaseline = await evaluate(`window.PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-08')`);
  assert.equal(legacyBaseline.openingBalance, 0);
  assert.equal(legacyBaseline.trueIncome, 3300000);
  assert.equal(await evaluate(`document.body.innerText.includes('رصيد افتتاحي')`), false);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
  const defaultMode = await evaluate(`document.querySelector('#openingBalanceMode').value`);
  assert.equal(defaultMode, "");

  const panelStates = await evaluate(`(() => {
    const select=document.querySelector('#openingBalanceMode');
    const states={};
    for(const mode of ['manual','carry','legacy']){
      select.value=mode; select.dispatchEvent(new Event('change',{bubbles:true}));
      states[mode]={manual:!document.querySelector('#openingManualPanel').hidden,carry:!document.querySelector('#openingCarryPanel').hidden,legacy:!document.querySelector('#openingLegacyPanel').hidden};
    }
    return states;
  })()`);
  assert.deepEqual(panelStates.manual, {manual:true,carry:false,legacy:false});
  assert.deepEqual(panelStates.carry, {manual:false,carry:true,legacy:false});
  assert.deepEqual(panelStates.legacy, {manual:false,carry:false,legacy:true});

  await evaluate(`(() => {
    const select=document.querySelector('#openingBalanceMode');
    select.value='manual'; select.dispatchEvent(new Event('change',{bubbles:true}));
    const amount=document.querySelector('#openingBalanceAmount'); amount.value='300000'; amount.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#btnSaveFinancialSettings').click();
  })()`);
  let stored = await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  assert.equal(stored.financialSettings.months["2026-08"].openingBalanceMode, "manual");
  assert.equal(stored.financialSettings.months["2026-08"].openingBalanceAmount, 300000);

  await evaluate(`(() => { const select=document.querySelector('#openingBalanceMode'); select.value='carry'; select.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveFinancialSettings').click(); })()`);
  stored = await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  assert.equal(stored.financialSettings.months["2026-08"].openingBalanceMode, "carry");

  await evaluate(`(() => {
    const select=document.querySelector('#openingBalanceMode'); select.value='legacy'; select.dispatchEvent(new Event('change',{bubbles:true}));
    const checkbox=document.querySelector('[data-legacy-opening-id="aug-legacy"]'); checkbox.checked=true; checkbox.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#btnSaveFinancialSettings').click();
  })()`);
  const legacyConfigured = await evaluate(`window.PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-08')`);
  assert.equal(legacyConfigured.openingBalance, 300000);
  assert.equal(legacyConfigured.trueIncome, 3000000);
  assert.equal(legacyConfigured.availableCash, 3300000);
  assert.equal(legacyConfigured.closingBalance, 800000);
  assert.equal(legacyConfigured.netCashFlow, 500000);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#txTableBody').innerText.includes('رصيد افتتاحي')`), true);
  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click()`);
  const dashboard = await evaluate(`(() => Object.fromEntries(['kpiOpening','kpiIncome','kpiAvailable','kpiExpense','kpiClosing','kpiNet','kpiSavingRate'].map(id => [id,document.querySelector('#'+id).innerText])))()`);
  assert.ok(dashboard.kpiOpening.includes("٣٠٠٬٠٠٠"));
  assert.ok(dashboard.kpiIncome.includes("٣٬٠٠٠٬٠٠٠"));
  assert.ok(dashboard.kpiClosing.includes("٨٠٠٬٠٠٠"));

  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="budgets"]').click(); const select=document.querySelector('#openingBalanceMode'); select.value='carry'; select.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveFinancialSettings').click(); })()`);
  const september = await evaluate(`window.PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-09')`);
  assert.equal(september.openingBalance, 800000);
  assert.equal(september.closingBalance, 900000);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="reports"]').click()`);
  await delay(300);
  assert.equal(await evaluate(`document.querySelectorAll('#monthlySummaryBody tr').length > 0 && document.querySelector('#view-reports').innerText.includes('الدخل الحقيقي')`), true);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
  const viewports = {};
  for(const width of [390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride", {width,height:900,deviceScaleFactor:1,mobile:false});
    await delay(100);
    viewports[width] = await evaluate(`(() => ({
      appVisible: document.querySelector('.app').getBoundingClientRect().width > 0,
      openingControlsVisible: document.querySelector('#openingBalanceMode').getBoundingClientRect().width > 0,
      tabsVisible: [...document.querySelectorAll('#tabs .tab')].every(tab => tab.getBoundingClientRect().width > 0),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    }))()`);
    assert.equal(viewports[width].appVisible, true);
    assert.equal(viewports[width].openingControlsVisible, true);
    assert.equal(viewports[width].tabsVisible, true);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const backupRoundTrip = await evaluate(`(() => {
    document.querySelector('#btnExport').click();
    const exported = document.querySelector('#exportText').value;
    const newBackup = JSON.parse(exported);
    const expectedSettings = JSON.stringify(newBackup.financialSettings);
    document.querySelector('#modalExport [data-close]').click();

    const legacyBackup = structuredClone(newBackup);
    delete legacyBackup.financialSettings;
    window.confirm = () => true;
    document.querySelector('#importText').value = JSON.stringify(legacyBackup);
    document.querySelector('#btnDoImport').click();
    const legacyState = JSON.parse(localStorage.getItem('pfm_data_v1'));
    const legacyFinancials = PFMFinancialModel.calculateMonthFinancials(legacyState, '2026-09');

    document.querySelector('#importText').value = exported;
    document.querySelector('#btnDoImport').click();
    const restored = JSON.parse(localStorage.getItem('pfm_data_v1'));

    return {
      exportHasSettings: Boolean(newBackup.financialSettings),
      legacyHasNoSettings: !Object.hasOwn(legacyState, 'financialSettings'),
      legacyOpening: legacyFinancials.openingBalance,
      restoredSettings: JSON.stringify(restored.financialSettings) === expectedSettings
    };
  })()`);
  assert.equal(backupRoundTrip.exportHasSettings, true);
  assert.equal(backupRoundTrip.legacyHasNoSettings, true);
  assert.equal(backupRoundTrip.legacyOpening, 0);
  assert.equal(backupRoundTrip.restoredSettings, true);

  await reload();
  const sw = await evaluate(`navigator.serviceWorker.ready.then(async registration => ({active:!!registration.active,controlled:!!navigator.serviceWorker.controller,cacheKeys:await caches.keys(),financialAsset:!!(await caches.match('./financial-model.js'))}))`);
  assert.equal(sw.active, true);
  assert.equal(sw.controlled, true);
  assert.ok(sw.cacheKeys.includes("pfm-pwa-v6"));
  assert.equal(sw.financialAsset, true);

  const errorCountBeforeOffline = errors.length;
  await send("Network.emulateNetworkConditions", {offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await reload();
  const offline = await evaluate(`({heading:document.querySelector('h1')?.innerText,model:!!window.PFMFinancialModel,reportScript:[...document.scripts].filter(script=>script.src.endsWith('/report-enhancements.js')).length,css:[...document.styleSheets].filter(sheet=>sheet.href?.endsWith('/mobile-enhancements.css')).length})`);
  assert.equal(offline.heading, "إدارة المصاريف الشخصية");
  assert.equal(offline.model, true);
  assert.equal(offline.reportScript, 1);
  assert.equal(offline.css, 1);
  assert.deepEqual(errors.slice(errorCountBeforeOffline), []);
  await send("Network.emulateNetworkConditions", {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({result:"PASS",legacyBaseline,legacyConfigured,september,dashboard,panelStates,viewports,backupRoundTrip,sw,offline,errors}, null, 2));
} finally {
  try{ socket.close(); }catch{}
  chrome.kill();
}

