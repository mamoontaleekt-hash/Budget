import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9351;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
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
const isExpectedFirebaseResourceError = (error) => error.includes("www.gstatic.com/firebasejs/10.13.0/") && error.includes("Failed to load resource: net::ERR_");

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
  if(message.method === "Runtime.exceptionThrown") {
    const details=message.params?.exceptionDetails;
    errors.push(details?.exception?.description || `${details?.text || "Runtime exception"}${details?.url ? ` at ${details.url}:${details.lineNumber || 0}` : ""}`);
  }
  if(message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
    const entry=message.params.entry;
    errors.push(`${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
  }
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
    {id:"ex_debt",type:"expense",name:"دين"},
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

  await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click()`);
  const incomeFieldHidden = await evaluate(`(() => {
    document.querySelector('#btnAddTx2').click();
    const type=document.querySelector('#txType');
    type.value='income'; type.dispatchEvent(new Event('change',{bubbles:true}));
    const hidden=document.querySelector('#txExpenseClassField').hidden;
    document.querySelector('#modalTx [data-close]').click();
    return hidden;
  })()`);
  assert.equal(incomeFieldHidden, true);

  const created = await evaluate(`(() => {
    const addExpense=(note,amount,expenseClass) => {
      document.querySelector('#btnAddTx2').click();
      const type=document.querySelector('#txType');
      type.value='expense'; type.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#txDate').value='2026-08-10';
      document.querySelector('#txCategory').value='ex_living';
      document.querySelector('#txAmount').value=String(amount);
      document.querySelector('#txNote').value=note;
      document.querySelector('#txExpenseClass').value=expenseClass;
      document.querySelector('#btnSaveTx').click();
    };
    addExpense('اختبار تلقائي',100000,'');
    const afterAuto=JSON.parse(localStorage.getItem('pfm_data_v1'));
    addExpense('اختبار معيشي صريح',110000,'regular');
    addExpense('اختبار استثنائي',120000,'exceptional');
    addExpense('اختبار سداد دين',130000,'debt_payment');
    addExpense('اختبار تعديل التصنيف',140000,'regular');
    const finalState=JSON.parse(localStorage.getItem('pfm_data_v1'));
    return {
      autoDidNotCreateSettings: !Object.hasOwn(afterAuto,'expenseSettings'),
      ids:Object.fromEntries(finalState.transactions.filter(tx=>tx.note.startsWith('اختبار')).map(tx=>[tx.note,tx.id])),
      originalPayloadUnchanged: !Object.hasOwn(finalState.transactions.find(tx=>tx.id==='aug-expense'),'expenseClass')
    };
  })()`);
  assert.equal(created.autoDidNotCreateSettings, true);
  assert.equal(created.originalPayloadUnchanged, true);

  const editResult = await evaluate(`(() => {
    const id=${JSON.stringify(created.ids["اختبار تعديل التصنيف"])};
    document.querySelector('[data-edit="'+id+'"]').click();
    document.querySelector('#txExpenseClass').value='exceptional';
    document.querySelector('#btnSaveTx').click();
    let state=JSON.parse(localStorage.getItem('pfm_data_v1'));
    const afterExceptional=state.expenseSettings.transactionClasses[id];
    document.querySelector('[data-edit="'+id+'"]').click();
    document.querySelector('#txExpenseClass').value='';
    document.querySelector('#btnSaveTx').click();
    state=JSON.parse(localStorage.getItem('pfm_data_v1'));
    const hasOverride=Object.hasOwn(state.expenseSettings.transactionClasses,id);
    return {
      afterExceptional,
      hasOverride,
      resolved:PFMExpenseModel.resolveExpenseClass(state,state.transactions.find(tx=>tx.id===id))
    };
  })()`);
  assert.equal(editResult.afterExceptional, "exceptional");
  assert.equal(editResult.hasOverride, false);
  assert.equal(editResult.resolved, "regular");

  const phase2Analytics = await evaluate(`PFMExpenseModel.calculateExpenseAnalytics(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-08')`);
  assert.equal(phase2Analytics.regularExpenses, 2850000);
  assert.equal(phase2Analytics.exceptionalExpenses, 120000);
  assert.equal(phase2Analytics.debtPayments, 130000);
  assert.equal(phase2Analytics.costOfLiving, 2850000);
  assert.equal(phase2Analytics.nonLivingOutflows, 250000);
  assert.equal(phase2Analytics.totalExpenses, 3100000);
  assert.equal(phase2Analytics.regularExpenses + phase2Analytics.exceptionalExpenses + phase2Analytics.debtPayments, phase2Analytics.totalExpenses);
  const phase2Financials = await evaluate(`PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-08')`);
  assert.equal(phase2Financials.totalExpenses, 3100000);
  assert.equal(phase2Financials.closingBalance, 200000);
  assert.equal(phase2Financials.netCashFlow, -100000);

  const classificationUi = await evaluate(`(() => {
    const allText=document.querySelector('#txTableBody').innerText;
    const filter=document.querySelector('#filterExpenseClass');
    filter.value='exceptional'; filter.dispatchEvent(new Event('change',{bubbles:true}));
    const filteredText=document.querySelector('#txTableBody').innerText;
    const filteredRows=document.querySelectorAll('#txTableBody tr').length;
    filter.value=''; filter.dispatchEvent(new Event('change',{bubbles:true}));
    return {allText,filteredText,filteredRows};
  })()`);
  assert.ok(classificationUi.allText.includes("معيشي"));
  assert.ok(classificationUi.allText.includes("استثنائي"));
  assert.ok(classificationUi.allText.includes("سداد دين"));
  assert.ok(classificationUi.filteredText.includes("اختبار استثنائي"));
  assert.equal(classificationUi.filteredText.includes("راتب آب"), false);
  assert.equal(classificationUi.filteredRows, 1);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click()`);
  const phase2Dashboard = await evaluate(`(() => Object.fromEntries(['kpiExpense','kpiCostOfLiving','kpiExceptionalExpenses','kpiDebtPayments','kpiClosing','kpiNet','kpiSavingRate'].map(id => [id,document.querySelector('#'+id).innerText])))()`);
  assert.ok(phase2Dashboard.kpiExpense.includes("٣٬١٠٠٬٠٠٠"));
  assert.ok(phase2Dashboard.kpiCostOfLiving.includes("٢٬٨٥٠٬٠٠٠"));
  assert.ok(phase2Dashboard.kpiExceptionalExpenses.includes("١٢٠٬٠٠٠"));
  assert.ok(phase2Dashboard.kpiDebtPayments.includes("١٣٠٬٠٠٠"));
  assert.ok(phase2Dashboard.kpiClosing.includes("٢٠٠٬٠٠٠"));
  assert.ok(phase2Dashboard.kpiNet.length > 0);

  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="budgets"]').click(); const select=document.querySelector('#openingBalanceMode'); select.value='carry'; select.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#btnSaveFinancialSettings').click(); })()`);
  const september = await evaluate(`window.PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')), '2026-09')`);
  assert.equal(september.openingBalance, 200000);
  assert.equal(september.closingBalance, 300000);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="reports"]').click()`);
  await delay(300);
  const reportText = await evaluate(`document.querySelector('#view-reports').innerText`);
  assert.equal(await evaluate(`document.querySelectorAll('#monthlySummaryBody tr').length > 0`), true);
  assert.ok(reportText.includes('الدخل الحقيقي'));
  assert.ok(reportText.includes('تكلفة المعيشة'));
  assert.ok(reportText.includes('استثنائي'));
  assert.ok(reportText.includes('سداد دين'));
  assert.ok(reportText.includes('٣٬١٠٠٬٠٠٠'));
  assert.ok(reportText.includes('٢٬٨٥٠٬٠٠٠'));

  await evaluate(`document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
  const viewports = {};
  for(const width of [390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride", {width,height:900,deviceScaleFactor:1,mobile:false});
    await delay(100);
    await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click(); document.querySelector('#btnAddTx2').click()`);
    viewports[width] = await evaluate(`(() => ({
      appVisible: document.querySelector('.app').getBoundingClientRect().width > 0,
      expenseClassVisible: document.querySelector('#txExpenseClass').getBoundingClientRect().width > 0,
      tabsVisible: [...document.querySelectorAll('#tabs .tab')].every(tab => tab.getBoundingClientRect().width > 0),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    }))()`);
    await evaluate(`document.querySelector('#modalTx [data-close]').click(); document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
    viewports[width].openingControlsVisible = await evaluate(`document.querySelector('#openingBalanceMode').getBoundingClientRect().width > 0`);
    assert.equal(viewports[width].appVisible, true);
    assert.equal(viewports[width].expenseClassVisible, true);
    assert.equal(viewports[width].openingControlsVisible, true);
    assert.equal(viewports[width].tabsVisible, true);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const backupRoundTrip = await evaluate(`(() => {
    document.querySelector('#btnExport').click();
    const exported = document.querySelector('#exportText').value;
    const newBackup = JSON.parse(exported);
    const expectedFinancialSettings = JSON.stringify(newBackup.financialSettings);
    const expectedExpenseSettings = JSON.stringify(newBackup.expenseSettings);
    const expectedTransactions = JSON.stringify(newBackup.transactions);
    document.querySelector('#modalExport [data-close]').click();

    const legacyBackup = structuredClone(newBackup);
    delete legacyBackup.financialSettings;
    delete legacyBackup.expenseSettings;
    window.confirm = () => true;
    document.querySelector('#importText').value = JSON.stringify(legacyBackup);
    document.querySelector('#btnDoImport').click();
    const legacyState = JSON.parse(localStorage.getItem('pfm_data_v1'));
    const legacyFinancials = PFMFinancialModel.calculateMonthFinancials(legacyState, '2026-09');

    const phase1Backup = structuredClone(newBackup);
    delete phase1Backup.expenseSettings;
    document.querySelector('#importText').value = JSON.stringify(phase1Backup);
    document.querySelector('#btnDoImport').click();
    const phase1State = JSON.parse(localStorage.getItem('pfm_data_v1'));

    document.querySelector('#importText').value = exported;
    document.querySelector('#btnDoImport').click();
    const restored = JSON.parse(localStorage.getItem('pfm_data_v1'));

    return {
      exportHasFinancialSettings: Boolean(newBackup.financialSettings),
      exportHasExpenseSettings: Boolean(newBackup.expenseSettings),
      legacyHasNoSettings: !Object.hasOwn(legacyState, 'financialSettings') && !Object.hasOwn(legacyState, 'expenseSettings'),
      legacyOpening: legacyFinancials.openingBalance,
      legacyTransactionsUnchanged: JSON.stringify(legacyState.transactions) === expectedTransactions,
      phase1FinancialSettingsPreserved: JSON.stringify(phase1State.financialSettings) === expectedFinancialSettings,
      phase1HasNoExpenseSettings: !Object.hasOwn(phase1State,'expenseSettings'),
      phase1TransactionsUnchanged: JSON.stringify(phase1State.transactions) === expectedTransactions,
      restoredFinancialSettings: JSON.stringify(restored.financialSettings) === expectedFinancialSettings,
      restoredExpenseSettings: JSON.stringify(restored.expenseSettings) === expectedExpenseSettings,
      restoredTransactionsUnchanged: JSON.stringify(restored.transactions) === expectedTransactions
    };
  })()`);
  assert.equal(backupRoundTrip.exportHasFinancialSettings, true);
  assert.equal(backupRoundTrip.exportHasExpenseSettings, true);
  assert.equal(backupRoundTrip.legacyHasNoSettings, true);
  assert.equal(backupRoundTrip.legacyOpening, 0);
  assert.equal(backupRoundTrip.legacyTransactionsUnchanged, true);
  assert.equal(backupRoundTrip.phase1FinancialSettingsPreserved, true);
  assert.equal(backupRoundTrip.phase1HasNoExpenseSettings, true);
  assert.equal(backupRoundTrip.phase1TransactionsUnchanged, true);
  assert.equal(backupRoundTrip.restoredFinancialSettings, true);
  assert.equal(backupRoundTrip.restoredExpenseSettings, true);
  assert.equal(backupRoundTrip.restoredTransactionsUnchanged, true);

  await reload();
  const sw = await evaluate(`navigator.serviceWorker.ready.then(async registration => ({active:!!registration.active,controlled:!!navigator.serviceWorker.controller,cacheKeys:await caches.keys(),financialAsset:!!(await caches.match('./financial-model.js?v=20260907-phase3')),expenseAsset:!!(await caches.match('./expense-model.js?v=20260907-phase3')),debtAsset:!!(await caches.match('./debt-model.js?v=20260908-phase3-corrective')),shoppingAsset:!!(await caches.match('./shopping-model.js?v=20260908-phase4')),staleDebtAsset:!!(await caches.match('./debt-model.js?v=20260907-phase3')),reportAsset:!!(await caches.match('./report-enhancements.js?v=20260907-phase3'))}))`);
  assert.equal(sw.active, true);
  assert.equal(sw.controlled, true);
  assert.ok(sw.cacheKeys.includes("pfm-pwa-v9"));
  assert.equal(sw.financialAsset, true);
  assert.equal(sw.expenseAsset, true);
  assert.equal(sw.debtAsset, true);
  assert.equal(sw.shoppingAsset, true);
  assert.equal(sw.staleDebtAsset, false);
  assert.equal(sw.reportAsset, true);

  const errorCountBeforeOffline = errors.length;
  await send("Network.emulateNetworkConditions", {offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await reload();
  const offline = await evaluate(`({heading:document.querySelector('h1')?.innerText,financialModel:!!window.PFMFinancialModel,expenseModel:!!window.PFMExpenseModel,debtModel:!!window.PFMDebtModel,shoppingModel:!!window.PFMShoppingModel,debtScript:[...document.scripts].filter(script=>script.src.includes('/debt-model.js?v=20260908-phase3-corrective')).length,shoppingScript:[...document.scripts].filter(script=>script.src.includes('/shopping-model.js?v=20260908-phase4')).length,reportScript:[...document.scripts].filter(script=>script.src.includes('/report-enhancements.js?v=20260907-phase3')).length,css:[...document.styleSheets].filter(sheet=>sheet.href?.endsWith('/mobile-enhancements.css')).length})`);
  assert.equal(offline.heading, "إدارة المصاريف الشخصية");
  assert.equal(offline.financialModel, true);
  assert.equal(offline.expenseModel, true);
  assert.equal(offline.debtModel, true);
  assert.equal(offline.shoppingModel, true);
  assert.equal(offline.shoppingScript, 1);
  assert.equal(offline.debtScript, 1);
  assert.equal(offline.reportScript, 1);
  assert.equal(offline.css, 1);
  const offlineErrors = errors.slice(errorCountBeforeOffline);
  const unexpectedOfflineErrors = offlineErrors.filter(error => !isExpectedFirebaseResourceError(error));
  assert.deepEqual(unexpectedOfflineErrors, []);
  await send("Network.emulateNetworkConditions", {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});

  const unexpectedErrors = errors.filter(error => !isExpectedFirebaseResourceError(error));
  assert.deepEqual(unexpectedErrors, []);
  console.log(JSON.stringify({result:"PASS",legacyBaseline,legacyConfigured,phase2Analytics,phase2Financials,september,dashboard,phase2Dashboard,panelStates,classificationUi,editResult,viewports,backupRoundTrip,sw,offline,offlineErrors,unexpectedErrors}, null, 2));
} finally {
  try{ socket.close(); }catch{}
  chrome.kill();
}
