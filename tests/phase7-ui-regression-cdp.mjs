import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9357;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() {
  for (let i = 0; i < 80; i += 1) {
    try { const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); const page = pages.find((candidate) => candidate.type === "page"); if (page) return page; } catch {}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let id = 0; const pending = new Map(); const waiters = new Map(); const errors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); }
  const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {});
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(message.params.entry.text);
});
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload() { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(800); }

const categories = [
  { id: "income", type: "income", name: "راتب" }, { id: "grocery", type: "expense", name: "السوبرماركت" },
  { id: "restaurants", type: "expense", name: "المطاعم" }, { id: "fuel", type: "expense", name: "الوقود" },
  { id: "health", type: "expense", name: "الصحة" }, { id: "long", type: "expense", name: "تصنيف مصروف طويل جداً لاختبار الاستجابة" },
];
const transactions = [
  { id: "pi", date: "2026-08-01", type: "income", amount: 2000000, categoryId: "income" },
  { id: "pg", date: "2026-08-02", type: "expense", amount: 500000, categoryId: "grocery" },
  { id: "pr", date: "2026-08-03", type: "expense", amount: 300000, categoryId: "restaurants" },
  { id: "pf", date: "2026-08-04", type: "expense", amount: 200000, categoryId: "fuel" },
  { id: "ci", date: "2026-09-01", type: "income", amount: 2500000, categoryId: "income" },
  { id: "cg", date: "2026-09-02", type: "expense", amount: 800000, categoryId: "grocery", shopping: { subcategories: ["meat", "dairy", "cleaning"] }, tagIds: ["family", "event"] },
  { id: "cr", date: "2026-09-03", type: "expense", amount: 100000, categoryId: "restaurants" },
  { id: "cf", date: "2026-09-04", type: "expense", amount: 250000, categoryId: "fuel" },
  { id: "ch", date: "2026-09-05", type: "expense", amount: 150000, categoryId: "health" },
];
const scenario = { version: 1, categories, transactions, budgets: {}, expenseSettings: { transactionClasses: { cg: "exceptional", cf: "debt_payment" } }, shoppingSettings: { transactionSubcategories: { cg: ["meat", "dairy", "cleaning"] } }, tagSettings: { transactionTags: { cg: ["family", "event"] } } };
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired"); await send("Page.navigate", { url: appUrl }); await loaded; await delay(800);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`); await reload();
  await evaluate(`(() => { const m=document.querySelector('#monthPicker'); m.value='2026-09'; m.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="reports"]').click(); })()`); await delay(300);

  const model = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const c=PFMComparisonModel.calculateMonthlyComparison(s,'2026-09','2026-08'); return {expense:c.metrics.totalExpenses,grossUp:c.spendingDrivers.grossIncreaseAmount,grossDown:c.spendingDrivers.grossDecreaseAmount,net:c.spendingDrivers.netExpenseDelta,ups:c.spendingDrivers.increaseDrivers.map(x=>[x.categoryId,x.delta,x.shareOfGrossIncrease]),downs:c.spendingDrivers.decreaseDrivers.map(x=>[x.categoryId,x.delta]),invariants:c.invariants}; })()`);
  assert.equal(model.expense.delta, 300000); assert.equal(model.expense.percentChange, 30); assert.equal(model.grossUp, 500000); assert.equal(model.grossDown, 200000); assert.equal(model.net, 300000);
  assert.deepEqual(model.ups.map((x) => x[0]), ["grocery", "health", "fuel"]); assert.deepEqual(model.ups.map((x) => x[2]), [0.6, 0.3, 0.1]); assert.deepEqual(model.downs[0], ["restaurants", -200000]);
  assert.ok(Object.values(model.invariants).every(Boolean));

  const ui = await evaluate(`({selector:document.querySelector('#comparisonMonthPicker').value,metrics:document.querySelector('#monthlyComparisonBody').innerText,deltaClasses:Object.fromEntries([...document.querySelectorAll('#monthlyComparisonBody tr')].map(row=>[row.cells[0].innerText,row.cells[3].className])),up:document.querySelector('#increaseDriversList').innerText,down:document.querySelector('#decreaseDriversList').innerText,gross:document.querySelector('#grossDriverSummary').innerText,insights:document.querySelector('#reportInsights').innerText})`);
  assert.equal(ui.selector, "2026-08"); assert.match(ui.metrics, /30\.0%/); assert.match(ui.up, /السوبرماركت/); assert.match(ui.up, /60\.0%/); assert.match(ui.down, /المطاعم/); assert.match(ui.insights, /أكبر مساهم/); assert.doesNotMatch(ui.insights, /غلاء|بسبب السفر|بسبب مناسبة/);
  assert.equal(ui.deltaClasses["الدخل الحقيقي"], "delta-down"); assert.equal(ui.deltaClasses["إجمالي المصروف"], "delta-up"); assert.equal(ui.deltaClasses["صافي الحركة النقدية"], "delta-down"); assert.equal(ui.deltaClasses["الرصيد الختامي"], "delta-down");

  const storedBefore = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  await evaluate(`(() => { const p=document.querySelector('#comparisonMonthPicker'); p.value='2026-07'; p.dispatchEvent(new Event('change',{bubbles:true})); })()`); await delay(200);
  assert.equal(await evaluate(`document.querySelector('#monthPicker').value`), "2026-09"); assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), storedBefore);

  const lifecycle = await evaluate(`(() => { const s=${JSON.stringify(scenario)}; const deleted=structuredClone(s); deleted.transactions.find(t=>t.id==='cg').deletedAt='x'; const restored=structuredClone(deleted); delete restored.transactions.find(t=>t.id==='cg').deletedAt; const moved=structuredClone(s); moved.transactions.find(t=>t.id==='cg').date='2026-08-10'; const renamed=structuredClone(s); renamed.categories.find(c=>c.id==='grocery').name='اسم جديد'; return {deleted:PFMComparisonModel.getMonthCategoryExpenses(deleted,'2026-09').grocery||0,restored:PFMComparisonModel.getMonthCategoryExpenses(restored,'2026-09').grocery||0,movedCurrent:PFMComparisonModel.getMonthCategoryExpenses(moved,'2026-09').grocery||0,movedPrevious:PFMComparisonModel.getMonthCategoryExpenses(moved,'2026-08').grocery||0,renamed:PFMComparisonModel.getMonthCategoryExpenses(renamed,'2026-09').grocery}; })()`);
  assert.deepEqual(lifecycle, { deleted: 0, restored: 800000, movedCurrent: 0, movedPrevious: 1300000, renamed: 800000 });

  const viewports = {};
  for (const width of [390, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    viewports[width] = await evaluate(`({doc:document.documentElement.scrollWidth,viewport:innerWidth,panel:document.querySelector('#reportEnhancementsPanel').getBoundingClientRect().width,drivers:getComputedStyle(document.querySelector('.drivers-grid')).gridTemplateColumns})`);
    assert.ok(viewports[width].doc <= viewports[width].viewport + 1); assert.ok(viewports[width].panel <= viewports[width].viewport);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const warning = await evaluate(`(() => { const d=new Date(); const current=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); const historical=(d.getFullYear()-1)+'-'+String(d.getMonth()+1).padStart(2,'0'); return {pure:PFMComparisonModel.isIncompleteCurrentMonth(current,new Date(d.getFullYear(),d.getMonth(),1)),historical:PFMComparisonModel.isIncompleteCurrentMonth(historical,new Date(d.getFullYear(),d.getMonth(),1))}; })()`);
  assert.deepEqual(warning, { pure: true, historical: false });

  await evaluate(`navigator.serviceWorker.ready`); await reload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async r=>({active:!!r.active,controlled:!!navigator.serviceWorker.controller,keys:await caches.keys(),comparison:!!(await caches.match('./comparison-model.js?v=20260908-phase7')),report:!!(await caches.match('./report-enhancements.js?v=20260908-phase7')),stale:!!(await caches.match('./report-enhancements.js?v=20260908-phase6'))}))`);
  assert.equal(pwa.active, true); assert.equal(pwa.controlled, true); assert.ok(pwa.keys.includes("pfm-pwa-v12")); assert.equal(pwa.comparison, true); assert.equal(pwa.report, true); assert.equal(pwa.stale, false);
  const errorCount = errors.length; await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }); await reload();
  assert.deepEqual(await evaluate(`({heading:document.querySelector('h1')?.innerText,comparison:!!window.PFMComparisonModel,report:!!document.querySelector('#monthlyComparisonHeading')})`), { heading: "إدارة المصاريف الشخصية", comparison: true, report: true });
  assert.deepEqual(errors.slice(errorCount).filter((error) => !expectedFirebaseError(error)), []);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", model, ui, lifecycle, viewports, warning, pwa }, null, 2));
} finally { try { socket.close(); } catch {} chrome.kill(); }
