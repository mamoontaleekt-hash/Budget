import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9365;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() {
  for (let index = 0; index < 100; index += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((candidate) => candidate.type === "page");
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let id = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
const requests = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const job = pending.get(message.id);
    pending.delete(message.id);
    return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {});
  }
  const queue = waiters.get(message.method);
  if (queue?.length) queue.shift()(message.params || {});
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`);
  if (message.method === "Network.requestWillBeSent") requests.push(message.params.request);
});
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function reload(wait = 700) {
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", { ignoreCache: false });
  await loaded;
  await delay(wait);
}
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

const categories = [
  { id: "income", type: "income", name: "الراتب" },
  { id: "living", type: "expense", name: "المعيشة" },
];
const transaction = (id, date, type, amount, categoryId) => ({ id, date, type, amount, categoryId, note: id });
const healthy = {
  version: 1,
  categories,
  transactions: [
    transaction("aug-income", "2026-08-01", "income", 3235000, "income"),
    transaction("aug-expense", "2026-08-05", "expense", 1142600, "living"),
    transaction("sep-income", "2026-09-01", "income", 3235000, "income"),
    transaction("sep-expense", "2026-09-06", "expense", 1142600, "living"),
  ],
  budgets: { "2026-09": { plan: {}, items: { living: { amount: 2000000, note: "" } } } },
  financialSettings: { months: { "2026-09": { openingBalanceMode: "manual", openingBalanceAmount: 500000 } } },
  expenseSettings: {}, debtSettings: { obligations: {}, paymentLinks: {} }, shoppingSettings: {}, tagSettings: {},
};

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url: appUrl });
  await loaded;
  await delay(900);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(healthy))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await delay(150);

  const initial = await evaluate(`(() => {
    const primary=[...document.querySelectorAll('.dashboard-primary-summary>.kpi')];
    const panels=[...document.querySelectorAll('[data-dashboard-panel-target]')];
    const state=JSON.parse(localStorage.getItem('pfm_data_v1'));
    const model=PFMDashboardModel.calculateDashboardSummary(state,'2026-09','2026-09-09');
    return {
      primaryCount:primary.length, primaryVisible:primary.filter(x=>x.getClientRects().length).length,
      closing:document.querySelector('#kpiClosing').innerText, expense:document.querySelector('#kpiExpense').innerText,
      income:document.querySelector('#kpiIncome').innerText, budget:document.querySelector('#dashboardBudgetRemaining').innerText,
      budgetHint:document.querySelector('#dashboardBudgetRemainingHint').innerText,
      model:{closing:model.financials.closingBalance,expense:model.financials.totalExpenses,income:model.financials.trueIncome,budget:model.budget.remainingBudgetTotal},
      attentionHidden:document.querySelector('#dashboardAttentionSection').hidden,
      panelVisible:panels.filter(x=>!x.hidden).length, expanded:[...document.querySelectorAll('[data-dashboard-panel]')].filter(x=>x.getAttribute('aria-expanded')==='true').length,
      launcher:document.querySelectorAll('[data-dashboard-panel]').length,
      monthValue:document.querySelector('#monthPicker').value, monthText:document.querySelector('#monthPickerDisplay').innerText,
      subtitle:document.querySelector('.brand-subtitle').innerText, cloudVisible:document.querySelector('#cloudBadge').getClientRects().length>0,
      moreButtons:[...document.querySelectorAll('#topbarMore button')].map(x=>x.id),
      arabicDigits:/[٠-٩۰-۹]/.test(document.querySelector('#view-dash').innerText),
      persisted:Object.keys(state).filter(k=>/dashboard|layout|locale|numberFormat|ux5/i.test(k)),
    };
  })()`);
  assert.equal(initial.primaryCount, 4); assert.equal(initial.primaryVisible, 4);
  assert.equal(initial.closing, "2,592,400 د.ع"); assert.equal(initial.expense, "1,142,600 د.ع"); assert.equal(initial.income, "3,235,000 د.ع"); assert.equal(initial.budget, "857,400 د.ع");
  assert.deepEqual(initial.model, { closing:2592400, expense:1142600, income:3235000, budget:857400 });
  assert.equal(initial.attentionHidden, true); assert.equal(initial.panelVisible, 0); assert.equal(initial.expanded, 0); assert.equal(initial.launcher, 6);
  assert.equal(initial.monthValue, "2026-09"); assert.equal(initial.monthText, "أيلول 2026"); assert.equal(initial.subtitle, "نظرة واضحة على أموالك هذا الشهر.");
  assert.equal(initial.cloudVisible, true); assert.deepEqual(initial.moreButtons, ["btnExport", "btnImport", "btnCloud"]); assert.equal(initial.arabicDigits, false); assert.deepEqual(initial.persisted, []);

  await evaluate(`document.querySelector('[data-dashboard-panel="financial"]').click()`);
  const financialPanel = await evaluate(`({available:document.querySelector('#kpiAvailable').innerText,opening:document.querySelector('#kpiOpening').innerText,net:document.querySelector('#kpiNet').innerText,savings:document.querySelector('#kpiSavingRate').innerText,status:document.querySelector('#pillStatus').innerText,savingsStatus:document.querySelector('#pillSavingsStatus').innerText})`);
  assert.deepEqual(financialPanel, { available:"3,735,000 د.ع", opening:"500,000 د.ع", net:"2,092,400 د.ع", savings:"64.7%", status:"الرصيد الختامي موجب ✅", savingsStatus:"ادخار من دخل الشهر" });
  assert.equal(/[٠-٩۰-۹]/.test(Object.values(financialPanel).join(" ")), false);
  await evaluate(`document.querySelector('[data-dashboard-panel="financial"]').click()`);

  const panelNames = ["financial", "comparison", "expenses", "debts", "budget", "charts"];
  for (const name of panelNames) {
    const result = await evaluate(`(() => { const button=document.querySelector('[data-dashboard-panel="${name}"]'); button.click(); const panels=[...document.querySelectorAll('[data-dashboard-panel-target]')]; return {visible:panels.filter(x=>!x.hidden).map(x=>x.dataset.dashboardPanelTarget),expanded:[...document.querySelectorAll('[data-dashboard-panel]')].filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.dataset.dashboardPanel)}; })()`);
    assert.deepEqual(result.visible, [name]); assert.deepEqual(result.expanded, [name]);
  }
  await delay(150);
  const charts = await evaluate(`(() => { const pie=document.querySelector('#pieExpense'),bar=document.querySelector('#barIncomeExpense'); return {pieCount:document.querySelectorAll('#pieExpense').length,barCount:document.querySelectorAll('#barIncomeExpense').length,pieWidth:pie.width,pieRect:pie.getBoundingClientRect().width,barWidth:bar.width,barRect:bar.getBoundingClientRect().width}; })()`);
  assert.equal(charts.pieCount, 1); assert.equal(charts.barCount, 1); assert.ok(charts.pieWidth > 0 && charts.pieRect > 0 && charts.barWidth > 0 && charts.barRect > 0, JSON.stringify(charts));
  const closed = await evaluate(`(() => { document.querySelector('[data-dashboard-panel="charts"]').click(); return {visible:[...document.querySelectorAll('[data-dashboard-panel-target]')].filter(x=>!x.hidden).length,expanded:document.querySelector('[data-dashboard-panel="charts"]').getAttribute('aria-expanded')}; })()`);
  assert.deepEqual(closed, { visible:0, expanded:"false" });

  await evaluate(`document.querySelector('[data-dashboard-panel="financial"]').click()`);
  await reload();
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-dashboard-panel-target]')].filter(x=>!x.hidden).length`), 0);

  const storedBeforeOpening = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  await evaluate(`window.scrollTo(0,document.body.scrollHeight); document.querySelector('#btnDashboardOpeningBalance').click()`);
  await delay(250);
  const opening = await evaluate(`(() => { const rect=document.querySelector('.opening-settings').getBoundingClientRect(); return {budgetVisible:document.querySelector('#view-budgets').style.display==='block',current:document.querySelector('[data-tab="budgets"]').getAttribute('aria-current'),focused:document.activeElement.id,inView:rect.top>=0&&rect.top<innerHeight,modal:document.querySelector('#modalTx').classList.contains('open')}; })()`);
  assert.deepEqual(opening, { budgetVisible:true, current:"page", focused:"openingBalanceMode", inView:true, modal:false });
  assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), storedBeforeOpening);

  const months = await evaluate(`(() => { const p=document.querySelector('#monthPicker'); p.value='2026-08'; p.dispatchEvent(new Event('change',{bubbles:true})); const aug=document.querySelector('#monthPickerDisplay').innerText; p.value='2026-09'; p.dispatchEvent(new Event('change',{bubbles:true})); return {aug,sep:document.querySelector('#monthPickerDisplay').innerText,value:p.value}; })()`);
  assert.deepEqual(months, { aug:"آب 2026", sep:"أيلول 2026", value:"2026-09" });

  const noBudget = { ...healthy, budgets:{} };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(noBudget))})`);
  await reload();
  await evaluate(`(() => { const p=document.querySelector('#monthPicker');p.value='2026-09';p.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.deepEqual(await evaluate(`({value:document.querySelector('#dashboardBudgetRemaining').innerText,hint:document.querySelector('#dashboardBudgetRemainingHint').innerText})`), { value:"—", hint:"لم تحدد ميزانية لهذا الشهر" });

  const budgetScenario = { ...healthy, transactions:healthy.transactions.map((item) => item.id.endsWith('expense') ? { ...item, amount:1200000 } : item) };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(budgetScenario))})`);
  await reload();
  const budgetRemaining = await evaluate(`(() => { const state=JSON.parse(localStorage.getItem('pfm_data_v1')),analytics=PFMBudgetModel.calculateBudgetAnalytics(state,'2026-09'); return {ui:document.querySelector('#dashboardBudgetRemaining').innerText,model:analytics.remainingBudgetTotal}; })()`);
  assert.deepEqual(budgetRemaining, { ui:"800,000 د.ع", model:800000 });

  const overdueDebt = { id:"loan", name:"قسط متأخر", type:"personal", totalAmount:900000, paidBeforeTracking:0, startDate:"2026-06-01", scheduleMode:"fixed", installmentAmount:300000, frequency:"monthly", firstDueDate:"2026-07-01", status:"active", createdAt:"2026-06-01T00:00:00.000Z" };
  const actionable = { ...healthy, budgets:{"2026-09":{plan:{},items:{living:{amount:100000}}}}, debtSettings:{obligations:{loan:overdueDebt},paymentLinks:{}} };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(actionable))})`);
  await reload();
  const attention = await evaluate(`({hidden:document.querySelector('#dashboardAttentionSection').hidden,count:document.querySelectorAll('#dashboardAttentionList .attention-item').length,text:document.querySelector('#dashboardAttentionList').innerText})`);
  assert.equal(attention.hidden, false); assert.ok(attention.count > 0 && attention.count <= 3); assert.match(attention.text, /قسط متأخر/); assert.match(attention.text, /تجاوز ميزانيته/);

  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(healthy))})`);
  await reload();
  await send("Emulation.setDeviceMetricsOverride", { width:1200, height:1200, deviceScaleFactor:1, mobile:false });
  const defaultHeight = await evaluate(`document.querySelector('#view-dash>.card').getBoundingClientRect().height`);
  await evaluate(`document.querySelector('[data-dashboard-panel="financial"]').click()`);
  const openHeight = await evaluate(`document.querySelector('#view-dash>.card').getBoundingClientRect().height`);
  assert.ok(defaultHeight < openHeight, JSON.stringify({ defaultHeight, openHeight }));

  const layouts = {};
  for (const width of [1200, 768, 430, 390, 360]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height:1100, deviceScaleFactor:1, mobile:width <= 430 });
    await delay(80);
    layouts[width] = await evaluate(`(() => { const grid=document.querySelector('.dashboard-primary-summary'),cards=[...grid.children].filter(x=>x.classList.contains('kpi')),controls=[...document.querySelectorAll('.controls>*')]; const first=cards[0].getBoundingClientRect(),third=cards[2].getBoundingClientRect(); return {doc:document.documentElement.scrollWidth,viewport:innerWidth,visible:cards.filter(x=>x.getClientRects().length).length,twoColumns:Math.abs(first.left-third.left)<2,oneRow:Math.abs(first.top-third.top)<2,rects:cards.map(x=>({left:x.getBoundingClientRect().left,top:x.getBoundingClientRect().top,width:x.getBoundingClientRect().width})),grid:getComputedStyle(grid).gridTemplateColumns,controlRows:new Set(controls.map(x=>Math.round(x.getBoundingClientRect().top))).size,subtitle:getComputedStyle(document.querySelector('.brand-subtitle')).display,launcher:[...document.querySelectorAll('[data-dashboard-panel]')].every(x=>x.getBoundingClientRect().width>0),bottomNav:document.querySelectorAll('#tabs .tab').length}; })()`);
    assert.ok(layouts[width].doc <= layouts[width].viewport + 1, JSON.stringify({ width, layout:layouts[width] }));
    assert.equal(layouts[width].visible, 4); assert.equal(layouts[width].launcher, true); assert.equal(layouts[width].bottomNav, 6);
    if (width <= 430) { assert.equal(layouts[width].twoColumns, true); assert.ok(layouts[width].controlRows <= 2); }
    if (width === 1200) assert.equal(layouts[width].oneRow, true, JSON.stringify(layouts[width]));
    if (width <= 720) assert.equal(layouts[width].subtitle, "none");
  }

  await send("Emulation.setDeviceMetricsOverride", { width:1200, height:1000, deviceScaleFactor:1, mobile:false });
  const menu = await evaluate(`(() => { const details=document.querySelector('#topbarMore'); details.open=true; const click=(id,modal)=>{document.querySelector('#'+id).click(); const opened=document.querySelector(modal).classList.contains('open'); document.querySelector(modal).classList.remove('open'); return opened}; return {exported:click('btnExport','#modalExport'),imported:click('btnImport','#modalImport'),cloud:click('btnCloud','#modalCloud')}; })()`);
  assert.deepEqual(menu, { exported:true, imported:true, cloud:true });

  const preservation = await evaluate(`({tabs:document.querySelectorAll('#tabs .tab').length,tx:!!document.querySelector('#txTableBody'),budget:!!document.querySelector('#budgetTableBody'),debts:!!document.querySelector('#debtList'),reports:!!document.querySelector('#view-reports'),settings:!!document.querySelector('#view-settings'),inputs:[...document.querySelectorAll('input[type="number"]')].every(x=>!/[,٬]/.test(x.value))})`);
  assert.deepEqual(preservation, { tabs:6, tx:true, budget:true, debts:true, reports:true, settings:true, inputs:true });

  await evaluate(`navigator.serviceWorker.ready`);
  await reload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),ux5:!!(await caches.match('./dashboard-polish.css?v=20260909-ux5')),format:!!(await caches.match('./display-format.js?v=20260909-ux5')),report:!!(await caches.match('./report-enhancements.js?v=20260909-ux5')),staleReport:!!(await caches.match('./report-enhancements.js?v=20260908-phase8')),ux4:!!(await caches.match('./budget-polish.css?v=20260909-ux4')),ux3:!!(await caches.match('./interaction-polish.css?v=20260909-ux3')),ux2:!!(await caches.match('./visual-polish.css?v=20260909-ux2')),ux1:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v20")); for (const key of ["ux5", "format", "report", "ux4", "ux3", "ux2", "ux1"]) assert.equal(pwa[key], true); assert.equal(pwa.staleReport, false);
  if (!pwa.controller) await reload();
  const errorCount = errors.length;
  await send("Network.emulateNetworkConditions", { offline:true, latency:0, downloadThroughput:0, uploadThroughput:0, connectionType:"none" });
  await reload();
  await evaluate(`document.querySelector('[data-dashboard-panel="charts"]').click()`);
  await delay(120);
  assert.equal(await evaluate(`!!window.PFMDisplayFormat && !document.querySelector('#dashboardPanelCharts').hidden && document.querySelector('#pieExpense').width>0`), true);
  assert.deepEqual(errors.slice(errorCount).filter((error) => !expectedFirebaseError(error)), []);
  await send("Network.emulateNetworkConditions", { offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"wifi" });

  assert.equal(requests.some((request) => /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com/i.test(request.url) && request.method !== "GET"), false);
  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result:"PASS", initial, charts, opening, months, attention, layouts, menu, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
