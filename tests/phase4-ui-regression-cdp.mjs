import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9354;
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank",
], { stdio:["ignore","pipe","pipe"] });
let stderr = "";
chrome.stderr.on("data", chunk => { stderr += chunk.toString(); });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function findTarget(){
  for(let attempt=0; attempt<80; attempt+=1){
    try{
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      const page = targets.find(candidate => candidate.type === "page");
      if(page) return page;
    }catch{}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}

const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener("open", resolveOpen, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
let nextId = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if(message.id){
    const job = pending.get(message.id);
    if(!job) return;
    pending.delete(message.id);
    if(message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result || {});
    return;
  }
  const queue = waiters.get(message.method);
  if(queue?.length) queue.shift()(message.params || {});
  if(message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Runtime exception");
  if(message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
    const entry=message.params.entry;
    errors.push(`${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
  }
});
function send(method, params={}){
  const id = ++nextId;
  return new Promise((resolveSend, reject) => { pending.set(id,{resolve:resolveSend,reject}); socket.send(JSON.stringify({id,method,params})); });
}
function waitEvent(method, timeout=20000){
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeout);
    const queue = waiters.get(method) || [];
    queue.push(params => { clearTimeout(timer); resolveEvent(params); });
    waiters.set(method, queue);
  });
}
async function evaluate(expression){
  const response = await send("Runtime.evaluate", { expression, awaitPromise:true, returnByValue:true, userGesture:true });
  if(response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed");
  return response.result?.value;
}
async function navigate(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", {url:appUrl});
  await loaded;
  await delay(1000);
}
async function reload(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", {ignoreCache:true});
  await loaded;
  await delay(700);
}
async function controlledReload(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", {ignoreCache:false});
  await loaded;
  await delay(700);
}
const scenario = {
  version:1,
  categories:[
    {id:"in_salary",type:"income",name:"راتب"},
    {id:"ex_grocery",type:"expense",name:"سوبرماركت"},
    {id:"ex_misc",type:"expense",name:"متفرقات"},
  ],
  transactions:[
    {id:"existing",type:"expense",categoryId:"ex_grocery",amount:180000,date:"2026-08-05",note:"فاتورة موجودة",createdAt:"2026-08-05T09:00:00.000Z"},
    {id:"untagged",type:"expense",categoryId:"ex_grocery",amount:100000,date:"2026-08-06",note:"لحم حليب منظفات",createdAt:"2026-08-06T09:00:00.000Z"},
    {id:"income",type:"income",categoryId:"in_salary",amount:500000,date:"2026-08-01",note:"راتب",createdAt:"2026-08-01T09:00:00.000Z"},
  ],
  budgets:{},
  shoppingSettings:{transactionSubcategories:{existing:["meat","dairy","cleaning"]}},
};
const expectedFirebaseError = value => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource: net::ERR_/i.test(String(value));

try{
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Network.enable"),send("Log.enable")]);
  await navigate();
  await evaluate(`localStorage.setItem('pfm_data_v1', ${JSON.stringify(JSON.stringify(scenario))})`);
  await evaluate(`navigator.serviceWorker.ready`);
  await controlledReload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-08'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);

  const baseline = await evaluate(`PFMShoppingModel.calculateShoppingAnalytics(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-08')`);
  assert.equal(baseline.totalShoppingAmount,280000);
  assert.equal(baseline.shoppingTransactionCount,2);
  assert.equal(baseline.taggedShoppingTransactionCount,1);
  assert.equal(baseline.untaggedShoppingTransactionCount,1);
  assert.equal(baseline.countBySubcategory.meat,1);
  assert.equal(baseline.countBySubcategory.dairy,1);
  assert.equal(baseline.countBySubcategory.cleaning,1);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click(); document.querySelector('#btnAddTx2').click()`);
  const initialForm = await evaluate(`({hidden:document.querySelector('#txShoppingSubcategoryField').hidden,settings:Object.hasOwn(JSON.parse(localStorage.getItem('pfm_data_v1')),'shoppingSettings')})`);
  assert.equal(initialForm.settings,true);
  await evaluate(`(() => { const type=document.querySelector('#txType'); type.value='income'; type.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelector('#txShoppingSubcategoryField').hidden`),true);
  await evaluate(`(() => { const type=document.querySelector('#txType'); type.value='expense'; type.dispatchEvent(new Event('change',{bubbles:true})); const category=document.querySelector('#txCategory'); category.value='ex_misc'; category.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelector('#txShoppingSubcategoryField').hidden`),true);
  await evaluate(`(() => {
    const category=document.querySelector('#txCategory'); category.value='ex_grocery'; category.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#txDate').value='2026-08-10'; document.querySelector('#txAmount').value='120000'; document.querySelector('#txNote').value='فاتورة جديدة';
    for(const id of ['meat','dairy','cleaning']){ const input=document.querySelector('[data-shopping-subcategory][value="'+id+'"]'); input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); }
  })()`);
  assert.equal(await evaluate(`document.querySelector('#txShoppingSubcategoryField').hidden`),false);
  await evaluate(`document.querySelector('#btnSaveTx').click()`);
  const created = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const t=s.transactions.find(item=>item.note==='فاتورة جديدة'); return {id:t.id,transaction:t,tags:s.shoppingSettings.transactionSubcategories[t.id]}; })()`);
  assert.deepEqual(created.tags,["meat","dairy","cleaning"]);
  assert.equal(created.transaction.amount,120000);
  assert.equal(Object.hasOwn(created.transaction,"shoppingSubcategories"),false);

  await evaluate(`document.querySelector('[data-edit="${created.id}"]').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-shopping-subcategory]:checked')].map(input=>input.value)`),["meat","dairy","cleaning"]);
  await evaluate(`(() => { const dairy=document.querySelector('[data-shopping-subcategory][value="dairy"]'); dairy.checked=false; const produce=document.querySelector('[data-shopping-subcategory][value="produce"]'); produce.checked=true; produce.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveTx').click(); })()`);
  let editedTags = await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).shoppingSettings.transactionSubcategories[${JSON.stringify(created.id)}]`);
  assert.deepEqual(editedTags,["meat","produce","cleaning"]);

  await evaluate(`document.querySelector('[data-edit="${created.id}"]').click(); (() => { const mixed=document.querySelector('[data-shopping-subcategory][value="mixed"]'); mixed.checked=true; mixed.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-shopping-subcategory]:checked')].map(input=>input.value)`),["mixed"]);
  await evaluate(`(() => { const meat=document.querySelector('[data-shopping-subcategory][value="meat"]'); meat.checked=true; meat.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-shopping-subcategory]:checked')].map(input=>input.value)`),["meat"]);
  await evaluate(`document.querySelector('#btnSaveTx').click()`);

  await evaluate(`document.querySelector('[data-edit="${created.id}"]').click(); (() => { const category=document.querySelector('#txCategory'); category.value='ex_misc'; category.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveTx').click(); })()`);
  let dormant = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const t=s.transactions.find(item=>item.id===${JSON.stringify(created.id)}); return {tags:s.shoppingSettings.transactionSubcategories[t.id],count:PFMShoppingModel.calculateShoppingAnalytics(s,'2026-08').shoppingTransactionCount}; })()`);
  assert.deepEqual(dormant.tags,["meat"]);
  assert.equal(dormant.count,2);
  await evaluate(`document.querySelector('[data-edit="${created.id}"]').click(); (() => { const category=document.querySelector('#txCategory'); category.value='ex_grocery'; category.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveTx').click(); })()`);

  const table = await evaluate(`document.querySelector('#txTableBody').innerText`);
  assert.ok(table.includes("لحوم · ألبان · +1"));
  await evaluate(`(() => { const filter=document.querySelector('#filterShoppingSubcategory'); filter.value='cleaning'; filter.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelectorAll('#txTableBody tr').length`),1);
  assert.ok((await evaluate(`document.querySelector('#txTableBody').innerText`)).includes("فاتورة موجودة"));
  await evaluate(`document.querySelector('#btnClearFilters').click(); document.querySelector('#tabs .tab[data-tab="reports"]').click()`);
  await delay(200);
  const report = await evaluate(`document.querySelector('#shoppingReportSummary').innerText`);
  assert.ok(report.includes("٤٠٠٬٠٠٠"));
  assert.ok(report.includes("عدد الفواتير التي تضمنت الصنف"));
  assert.ok(report.includes("لحوم ودواجن وأسماك"));
  assert.equal(/إنفاق.*لحوم|مبلغ.*ألبان/.test(report),false);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click(); document.querySelector('[data-edit="${created.id}"]').click(); (() => { document.querySelectorAll('[data-shopping-subcategory]').forEach(input=>{ input.checked=false; }); document.querySelector('#btnSaveTx').click(); })()`);
  assert.equal(await evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('pfm_data_v1')).shoppingSettings.transactionSubcategories,${JSON.stringify(created.id)})`),false);

  const viewports = {};
  for(const width of [390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click(); document.querySelector('[data-edit="${created.id}"]').click()`);
    viewports[width] = await evaluate(`({modal:document.querySelector('#modalTx .dialog').getBoundingClientRect().width,options:document.querySelector('#txShoppingSubcategoryOptions').getBoundingClientRect().width,viewport:innerWidth})`);
    assert.ok(viewports[width].modal>0 && viewports[width].modal<=viewports[width].viewport);
    assert.ok(viewports[width].options>0);
    await evaluate(`document.querySelector('#modalTx [data-close]').click()`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`document.querySelector('#btnExport').click()`);
  const roundtrip = await evaluate(`(() => { const exported=document.querySelector('#exportText').value; const expected=JSON.parse(exported).shoppingSettings; document.querySelector('#modalExport [data-close]').click(); window.confirm=()=>true; document.querySelector('#importText').value=exported; document.querySelector('#btnDoImport').click(); return JSON.stringify(JSON.parse(localStorage.getItem('pfm_data_v1')).shoppingSettings)===JSON.stringify(expected); })()`);
  assert.equal(roundtrip,true);

  await controlledReload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async registration => ({active:!!registration.active,controlled:!!navigator.serviceWorker.controller,keys:await caches.keys(),shopping:!!(await caches.match('./shopping-model.js?v=20260908-phase4'))}))`);
  console.log("PWA snapshot",pwa);
  assert.equal(pwa.active,true); assert.equal(pwa.controlled,true); assert.ok(pwa.keys.includes("pfm-pwa-v16")); assert.equal(pwa.shopping,true);
  assert.equal(pwa.keys.some(key=>key==="pfm-pwa-v8"),false);
  const errorCount = errors.length;
  await send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await controlledReload();
  assert.deepEqual(await evaluate(`({heading:document.querySelector('h1')?.innerText,shopping:!!window.PFMShoppingModel})`),{heading:"إدارة المصاريف الشخصية",shopping:true});
  assert.deepEqual(errors.slice(errorCount).filter(error=>!expectedFirebaseError(error)),[]);
  await send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  assert.deepEqual(errors.filter(error=>!expectedFirebaseError(error)),[]);
  console.log(JSON.stringify({result:"PASS",baseline,created,editedTags,dormant,viewports,roundtrip,pwa},null,2));
} finally {
  try{ socket.close(); }catch{}
  chrome.kill();
}
