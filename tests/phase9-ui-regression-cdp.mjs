import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9359;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() { for (let i = 0; i < 100; i += 1) { try { const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()); const page = pages.find((candidate) => candidate.type === "page"); if (page) return page; } catch {} await delay(100); } throw new Error(`Chrome did not start: ${stderr}`); }
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let id = 0; const pending = new Map(); const waiters = new Map(); const errors = [];
socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); } const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {}); if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text); if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`); });
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload(wait = 800) { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(wait); }

const categories = [
  { id: "income", type: "income", name: "الراتب" },
  { id: "grocery", type: "expense", name: "السوبرماركت" },
  { id: "rent", type: "expense", name: "الإيجار" },
  { id: "fuel", type: "expense", name: "الوقود" },
];
const tx = (id, date, type, amount, categoryId, extra = {}) => ({ id, date, type, amount, categoryId, note: id, ...extra });
const debt = {
  id: "loan", name: "قسط المنزل", type: "house", totalAmount: 900000, paidBeforeTracking: 0,
  startDate: "2026-06-01", scheduleMode: "fixed", installmentAmount: 300000,
  frequency: "monthly", firstDueDate: "2026-07-01", status: "active", createdAt: "2026-06-01T00:00:00.000Z",
};
const scenario = {
  version: 1, categories, budgets: { "2026-09": { plan: {}, items: { grocery: { amount: 1000000 }, rent: { amount: 200000 } } } },
  transactions: [
    tx("aug-income", "2026-08-01", "income", 3000000, "income"),
    tx("aug-grocery", "2026-08-05", "expense", 800000, "grocery"),
    tx("aug-rent", "2026-08-06", "expense", 200000, "rent"),
    tx("sep-income", "2026-09-01", "income", 3000000, "income"),
    tx("sep-grocery", "2026-09-05", "expense", 1100000, "grocery"),
    tx("sep-rent", "2026-09-06", "expense", 200000, "rent"),
  ],
  financialSettings: { months: { "2026-09": { openingBalanceMode: "manual", openingBalanceAmount: 500000 } } },
  debtSettings: { obligations: { loan: debt }, paymentLinks: {} },
};
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired"); await send("Page.navigate", { url: appUrl }); await loaded; await delay(800);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`); await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`); await delay(250);

  const dashboard = await evaluate(`({
    model:!!window.PFMDashboardModel,
    available:document.querySelector('#kpiAvailable').innerText,
    closing:document.querySelector('#kpiClosing').innerText,
    net:document.querySelector('#kpiNet').innerText,
    comparison:document.querySelector('#dashboardExpenseComparison').innerText,
    living:document.querySelector('#dashboardLivingComparison').innerText,
    top:document.querySelector('#dashboardTopCategory').innerText,
    driver:document.querySelector('#dashboardDriverHighlight').innerText,
    attention:[...document.querySelectorAll('#dashboardAttentionList .attention-item')].map(x=>x.innerText),
    budget:document.querySelector('#budgetAlertsList').innerText,
    debt:document.querySelector('#dashboardDebtAttention').innerText,
    warning:!document.querySelector('#dashboardIncompleteNote').hidden,
    quick:document.querySelectorAll('.dashboard-quick-actions button').length,
    dashboardSettings:Object.hasOwn(JSON.parse(localStorage.getItem('pfm_data_v1')),'dashboardSettings')
  })`);
  assert.equal(dashboard.model, true);
  assert.match(dashboard.available, /٣٬٥٠٠٬٠٠٠/); assert.match(dashboard.closing, /٢٬٢٠٠٬٠٠٠/); assert.match(dashboard.net, /١٬٧٠٠٬٠٠٠/);
  assert.match(dashboard.comparison, /٣٠٠٬٠٠٠/); assert.match(dashboard.comparison, /30\.0%/); assert.match(dashboard.comparison, /الحالي/); assert.match(dashboard.living, /أعلى/);
  assert.match(dashboard.top, /السوبرماركت/); assert.match(dashboard.top, /84\.6%/); assert.match(dashboard.driver, /السوبرماركت/); assert.match(dashboard.driver, /٣٠٠٬٠٠٠/);
  assert.ok(dashboard.attention.length <= 3); assert.match(dashboard.attention[0], /قسط متأخر/); assert.match(dashboard.attention[1], /تجاوز ميزانيته/); assert.match(dashboard.budget, /1 متجاوزة/); assert.match(dashboard.debt, /دفعات متأخرة/);
  assert.equal(dashboard.warning, true); assert.equal(dashboard.quick, 4); assert.equal(dashboard.dashboardSettings, false);

  const storedBeforeNavigation = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  await evaluate(`document.querySelector('#btnDashboardComparisonReports').click()`); await delay(150);
  assert.equal(await evaluate(`document.querySelector('#view-reports').style.display`), "block");
  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click(); document.querySelector('#btnDashboardBudgets').click()`); await delay(100);
  assert.equal(await evaluate(`document.querySelector('#view-budgets').style.display`), "block");
  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click(); document.querySelector('#btnDashboardDebts').click()`); await delay(100);
  assert.equal(await evaluate(`document.querySelector('#view-debts').style.display`), "block");
  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click(); document.querySelector('#btnDashboardAddTx').click()`); await delay(100);
  assert.equal(await evaluate(`document.querySelector('#modalTx').classList.contains('open')`), true);
  assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), storedBeforeNavigation);

  await evaluate(`document.querySelector('#modalTx').classList.remove('open'); document.querySelector('#tabs .tab[data-tab="dash"]').click(); (()=>{const p=document.querySelector('#monthPicker');p.value='2026-10';p.dispatchEvent(new Event('change',{bubbles:true}));})()`); await delay(150);
  const switched = await evaluate(`({top:document.querySelector('#dashboardTopCategory').innerText,expense:document.querySelector('#kpiExpense').innerText,month:document.querySelector('#dashboardComparisonMonths').innerText})`);
  assert.match(switched.top, /لا توجد بيانات/); assert.match(switched.expense, /٠/); assert.match(switched.month, /تشرين الأول/);

  for (const width of [390, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluate(`({doc:document.documentElement.scrollWidth,viewport:innerWidth,comparison:document.querySelector('#dashboardComparisonRows').getBoundingClientRect().width,card:document.querySelector('#view-dash .card').getBoundingClientRect().width})`);
    assert.ok(layout.doc <= layout.viewport + 1, JSON.stringify({ width, layout })); assert.ok(layout.comparison <= layout.card + 1);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const mixed = {
    version: 1, categories, budgets: {}, transactions: [
      tx("income", "2026-09-01", "income", 1000000, "income"),
      tx("uncat", "2026-09-02", "expense", 900000, ""),
      tx("missing", "2026-09-03", "expense", 600000, "removed"),
    ], financialSettings: { months: { "2026-09": { openingBalanceMode: "manual", openingBalanceAmount: 2000000 } } },
  };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(mixed))})`); await reload();
  const mixedUi = await evaluate(`({closing:document.querySelector('#kpiClosing').innerText,net:document.querySelector('#kpiNet').innerText,attention:document.querySelector('#dashboardAttentionList').innerText,top:document.querySelector('#dashboardTopCategory').innerText})`);
  assert.match(mixedUi.closing, /١٬٥٠٠٬٠٠٠/); assert.match(mixedUi.net, /٥٠٠٬٠٠٠/); assert.match(mixedUi.attention, /دخل الشهر الحقيقي/); assert.doesNotMatch(mixedUi.attention, /الرصيد الختامي المتوقع.*سالب/); assert.match(mixedUi.top, /غير مصنف/);

  const missingTop = { ...mixed, transactions: mixed.transactions.map((item) => item.id === "missing" ? { ...item, amount: 1200000 } : item) };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(missingTop))})`); await reload();
  assert.match(await evaluate(`document.querySelector('#dashboardTopCategory').innerText`), /تصنيف غير موجود \(removed\)/);

  await evaluate(`localStorage.setItem('pfm_data_v1',JSON.stringify({version:1,categories:${JSON.stringify(categories)},transactions:[],budgets:{}}))`); await reload(1000);
  const empty = await evaluate(`({attention:document.querySelector('#dashboardAttentionList').innerText,comparison:!document.querySelector('#dashboardComparisonEmpty').hidden,top:document.querySelector('#dashboardTopCategory').innerText,budget:document.querySelector('#budgetAlertsList').innerText,debt:document.querySelector('#dashboardDebtAttention').innerText,nan:document.querySelector('#view-dash').innerText.includes('NaN')||document.querySelector('#view-dash').innerText.includes('Infinity')})`);
  assert.match(empty.attention, /لا توجد حالات/); assert.equal(empty.comparison, true); assert.match(empty.top, /لا توجد بيانات/); assert.match(empty.budget, /لا توجد ميزانيات/); assert.match(empty.debt, /لا توجد التزامات/); assert.equal(empty.nan, false);

  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),asset:!!(await caches.match('./dashboard-model.js?v=20260908-phase9'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v17")); assert.equal(pwa.asset, true);
  if (!pwa.controller) await reload(500);
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" });
  await reload(600);
  assert.equal(await evaluate(`!!window.PFMDashboardModel`), true);
  await evaluate(`document.querySelector('#btnDashboardReports').click()`); await delay(100);
  assert.equal(await evaluate(`document.querySelector('#view-reports').style.display`), "block");
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "wifi" });

  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", dashboard, switched, mixedUi, empty, pwa }, null, 2));
} finally { try { socket.close(); } catch {} chrome.kill(); }
