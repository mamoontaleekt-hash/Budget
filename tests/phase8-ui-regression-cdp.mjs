import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9358;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() { for (let i = 0; i < 80; i += 1) { try { const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()); const page = pages.find((candidate) => candidate.type === "page"); if (page) return page; } catch {} await delay(100); } throw new Error(`Chrome did not start: ${stderr}`); }
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let id = 0; const pending = new Map(); const waiters = new Map(); const errors = [];
socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); } const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {}); if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text); if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`); });
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload() { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(700); }

const categories = [
  { id: "grocery", type: "expense", name: "السوبرماركت" }, { id: "rent", type: "expense", name: "الإيجار" },
  { id: "fuel", type: "expense", name: "الوقود" }, { id: "long", type: "expense", name: "تصنيف مصروف عربي طويل جداً لاختبار التفاف النص والاستجابة" },
  { id: "salary", type: "income", name: "الراتب" },
];
const transactions = [
  { id: "oct", date: "2025-10-10", type: "expense", amount: 300000, categoryId: "grocery" },
  { id: "dec", date: "2025-12-10", type: "expense", amount: 600000, categoryId: "grocery", note: "فاتورة كبيرة" },
  ...[300000, 200000, 150000, 100000, 80000, 70000].map((amount, index) => ({ id: `sep${index}`, date: `2026-09-${String(index + 1).padStart(2, "0")}`, type: "expense", amount, categoryId: "grocery", note: index ? "" : "الأكبر هذا الشهر" })),
  { id: "rent", date: "2026-09-08", type: "expense", amount: 500000, categoryId: "rent" },
  { id: "fuel", date: "2026-08-08", type: "expense", amount: 250000, categoryId: "fuel" },
  { id: "uncat", date: "2026-09-09", type: "expense", amount: 300000, categoryId: "" },
  { id: "missing", date: "2026-09-10", type: "expense", amount: 200000, categoryId: "ex_removed" },
  { id: "deleted", date: "2026-09-11", type: "expense", amount: 9999999, categoryId: "grocery", deletedAt: "x" },
  { id: "income", date: "2026-09-12", type: "income", amount: 9999999, categoryId: "grocery" },
  { id: "other", date: "2026-09-12", type: "expense", amount: 9999999, categoryId: "rent", deletedAt: "x" },
  { id: "future", date: "2026-10-01", type: "expense", amount: 9999999, categoryId: "grocery" },
];
transactions[2].shopping = { subcategories: ["meat", "dairy", "cleaning"] }; transactions[2].tagIds = ["family", "event"];
const scenario = { version: 1, categories, transactions, budgets: {}, expenseSettings: { transactionClasses: { sep0: "exceptional", sep1: "debt_payment" } }, debtSettings: { obligations: [{ id: "debt-1", totalAmount: 1 }] }, shoppingSettings: { transactionSubcategories: { sep0: ["meat", "dairy", "cleaning"] } }, tagSettings: { transactionTags: { sep0: ["family", "event"] } } };
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired"); await send("Page.navigate", { url: appUrl }); await loaded; await delay(600);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`); await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="reports"]').click(); })()`); await delay(350);

  const model = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const a=PFMCategoryAnalyticsModel.calculateCategoryAnalytics(s,'grocery','2026-09'); const o=PFMCategoryAnalyticsModel.calculateCategoryOverview(s,'2026-09'); return {months:a.series.map(x=>[x.month,x.amount,x.transactionCount]),total:a.twelveMonthTotal,calendar:a.twelveMonthCalendarAverage,active:a.activeMonthCount,activeAverage:a.activeMonthAverage,count:a.transactionCount12m,average:a.averageTransactionAmount12m,largest:a.largestTransaction,high:a.highestMonth,low:a.lowestActiveMonth,top:a.currentMonthTopTransactions.map(x=>x.amount),rows:o.rows.map(x=>x.categoryId),sum:o.rows.reduce((n,x)=>n+x.twelveMonthTotal,0),den:o.twelveMonthTotalExpenses}; })()`);
  assert.equal(model.months.length, 12); assert.deepEqual(model.months[0].slice(0, 2), ["2025-10", 300000]); assert.deepEqual(model.months[1].slice(0, 2), ["2025-11", 0]); assert.equal(model.months.at(-1)[1], 900000);
  assert.equal(model.total, 1800000); assert.equal(model.calendar, 150000); assert.equal(model.active, 3); assert.equal(model.activeAverage, 600000); assert.equal(model.count, 8); assert.equal(model.average, 225000);
  assert.equal(model.largest.id, "dec"); assert.equal(model.high.amount, 900000); assert.equal(model.low.amount, 300000); assert.deepEqual(model.top, [300000, 200000, 150000, 100000, 80000]);
  assert.ok(model.rows.includes("uncat")); assert.ok(model.rows.includes("ex_removed")); assert.equal(model.sum, model.den);

  const ui = await evaluate(`({selected:document.querySelector('#categoryAnalyticsSelector').value,options:document.querySelector('#categoryAnalyticsSelector').innerText,kpis:document.querySelector('.category-kpis').innerText,trendRows:document.querySelectorAll('.category-trend-row').length,trend:document.querySelector('#categoryTrend').innerText,overview:document.querySelector('#categoryOverviewBody').innerText,explorer:document.querySelector('#categoryTransactions').innerText,buttons:document.querySelector('#categoryTransactions').querySelectorAll('button,input,select').length,insights:document.querySelector('#categoryInsights').innerText})`);
  assert.equal(ui.selected, "grocery"); assert.match(ui.options, /غير مصنف/); assert.match(ui.options, /تصنيف غير موجود \(ex_removed\)/); assert.match(ui.kpis, /١٥٠/); assert.match(ui.kpis, /٦٠٠/); assert.equal(ui.trendRows, 12); assert.match(ui.trend, /تشرين الثاني/); assert.match(ui.trend, /٠/); assert.match(ui.overview, /غير مصنف/); assert.match(ui.overview, /تصنيف غير موجود/); assert.equal(ui.buttons, 0); assert.match(ui.explorer, /٣٠٠/); assert.doesNotMatch(ui.explorer, /٩٬٩٩٩٬٩٩٩/); assert.doesNotMatch(ui.insights, /يجب|تبالغ|غير صحي|الأسعار/);

  const storedBefore = await evaluate(`localStorage.getItem('pfm_data_v1')`); const comparisonBefore = await evaluate(`document.querySelector('#comparisonMonthPicker').value`);
  await evaluate(`(() => { const selector=document.querySelector('#categoryAnalyticsSelector'); selector.value='rent'; selector.dispatchEvent(new Event('change',{bubbles:true})); })()`); await delay(200);
  assert.equal(await evaluate(`document.querySelector('#categoryAnalyticsSelector').value`), "rent"); assert.equal(await evaluate(`document.querySelector('#monthPicker').value`), "2026-09"); assert.equal(await evaluate(`document.querySelector('#comparisonMonthPicker').value`), comparisonBefore); assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), storedBefore);

  for (const width of [390, 768, 1200]) { await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false }); const layout = await evaluate(`({doc:document.documentElement.scrollWidth,viewport:innerWidth,selector:document.querySelector('#categoryAnalyticsSelector').getBoundingClientRect().right-document.querySelector('#categoryAnalyticsSelector').getBoundingClientRect().left,panel:document.querySelector('#reportEnhancementsPanel').getBoundingClientRect().width})`); assert.ok(layout.doc <= layout.viewport + 1, JSON.stringify({ width, layout })); assert.ok(layout.selector <= layout.panel); }
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`localStorage.setItem('pfm_data_v1',JSON.stringify({version:1,categories:${JSON.stringify(categories)},transactions:[],budgets:{}})); window.dispatchEvent(new Event('pfm:changed'))`); await delay(200);
  assert.deepEqual(await evaluate(`({empty:!document.querySelector('#categoryAnalyticsEmpty').hidden,content:document.querySelector('#categoryAnalyticsContent').hidden,text:document.querySelector('#categoryAnalyticsEmpty').innerText,trend:document.querySelectorAll('.category-trend-row').length})`), { empty: true, content: true, text: "لا توجد بيانات مصروف كافية لتحليل التصنيفات.", trend: 12 });
  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", model, ui }, null, 2));
} finally { try { socket.close(); } catch {} chrome.kill(); }
