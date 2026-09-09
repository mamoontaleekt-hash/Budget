import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9356;
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function findTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((candidate) => candidate.type === "page");
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}
const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", fail, { once: true });
});
let nextId = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const job = pending.get(message.id); if (!job) return; pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result || {});
    return;
  }
  const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {});
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Runtime exception");
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`);
});
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((done, fail) => { pending.set(id, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id, method, params })); });
}
function waitEvent(method, timeout = 20000) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout);
    const queue = waiters.get(method) || [];
    queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue);
  });
}
async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed");
  return response.result?.value;
}
async function reload() { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(700); }

const categories = [
  { id: "in_salary", type: "income", name: "راتب" },
  { id: "ex_grocery", type: "expense", name: "سوبرماركت" },
  { id: "ex_transport", type: "expense", name: "نقل" },
  { id: "ex_misc", type: "expense", name: "متفرقات" },
  { id: "ex_debt", type: "expense", name: "دين" },
  { id: "ex_restaurant", type: "expense", name: "مطاعم" },
];
const transactions = [
  { id: "g", type: "expense", categoryId: "ex_grocery", amount: 500000, date: "2026-09-03" },
  { id: "w", type: "expense", categoryId: "ex_transport", amount: 800000, date: "2026-09-04" },
  { id: "l", type: "expense", categoryId: "ex_misc", amount: 1000000, date: "2026-09-05" },
  { id: "x", type: "expense", categoryId: "ex_debt", amount: 1200000, date: "2026-09-06", debtObligationId: "d1" },
  { id: "u", type: "expense", categoryId: "ex_restaurant", amount: 300000, date: "2026-09-07" },
];
const scenario = {
  version: 1, categories, transactions,
  budgets: { "2026-09": { plan: { income1: 5000000, income2: 0, note: "خطة قديمة" }, items: {
    ex_grocery: { amount: 1000000, note: "طعام" }, ex_transport: { amount: 1000000, note: "نقل" },
    ex_misc: { amount: 1000000, note: "حد" }, ex_debt: { amount: 1000000, note: "دين" },
  } } },
  expenseSettings: { transactionClasses: { g: "exceptional" } },
  shoppingSettings: { transactionSubcategories: { g: ["meat", "dairy", "cleaning"] } },
  tagSettings: { definitions: {
    family: { id: "family", name: "عائلة", status: "active" }, event: { id: "event", name: "مناسبة", status: "active" },
  }, transactionTags: { g: ["family", "event"] } },
  debtSettings: { obligations: [{ id: "d1", name: "قرض", originalAmount: 2000000, status: "active" }] },
};
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired"); await send("Page.navigate", { url: appUrl }); await loaded; await delay(1000);
  await evaluate(`localStorage.setItem('pfm_data_v1', ${JSON.stringify(JSON.stringify(scenario))})`);
  await reload();
  await evaluate(`(() => { const m=document.querySelector('#monthPicker'); m.value='2026-09'; m.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="budgets"]').click(); })()`);

  const rows = await evaluate(`Object.fromEntries([...document.querySelectorAll('#budgetTableBody tr[data-cat]')].map(row=>[row.dataset.cat,row.innerText]))`);
  assert.match(rows.ex_grocery, /50%/); assert.match(rows.ex_grocery, /ضمن الميزانية/);
  assert.match(rows.ex_transport, /80%/); assert.match(rows.ex_transport, /اقتربت من الحد/);
  assert.match(rows.ex_misc, /100%/); assert.match(rows.ex_misc, /تم استهلاك الميزانية/);
  assert.match(rows.ex_debt, /120%/); assert.match(rows.ex_debt, /تجاوز الميزانية/); assert.match(rows.ex_debt, /200,000|٢٠٠٬٠٠٠/);
  assert.match(rows.ex_restaurant, /بدون ميزانية/);
  const summary = await evaluate(`({planned:document.querySelector('#budgetSummaryPlanned').innerText,actual:document.querySelector('#budgetSummaryActual').innerText,unbudgeted:document.querySelector('#budgetSummaryUnbudgeted').innerText,remaining:document.querySelector('#budgetSummaryRemaining').innerText})`);
  assert.match(summary.unbudgeted, /300,000|٣٠٠٬٠٠٠/); assert.match(summary.remaining, /500,000|٥٠٠٬٠٠٠/);

  const model = await evaluate(`PFMBudgetModel.calculateBudgetAnalytics(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-09')`);
  assert.equal(model.actualsByCategory.ex_grocery, 500000);
  assert.deepEqual(model.alerts.map((alert) => alert.status), ["EXCEEDED", "AT_LIMIT", "WARNING"]);
  assert.equal(model.totalExpenseActual, 3800000); assert.equal(model.unbudgetedActualTotal, 300000);

  const beforeSuggestion = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  await evaluate(`document.querySelector('#btnAutoSuggestions').click()`);
  const afterSuggestion = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  assert.equal(afterSuggestion, beforeSuggestion);
  assert.notEqual(await evaluate(`document.querySelector('[data-cat="ex_grocery"] .budgetInput').value`), "1000000");

  await evaluate(`document.querySelector('#tabs .tab[data-tab="dash"]').click()`);
  const alerts = await evaluate(`document.querySelector('#budgetAlertsList').innerText`);
  assert.ok(alerts.indexOf("دين") < alerts.indexOf("متفرقات")); assert.match(alerts, /نقل/);
  assert.match(alerts, /300,000|٣٠٠٬٠٠٠/);
  await evaluate(`document.querySelector('#tabs .tab[data-tab="reports"]').click()`);
  const reportText = await evaluate(`document.querySelector('#planVsActualBody').innerText`);
  for (const wording of ["ضمن الميزانية", "اقتربت من الحد", "تم استهلاك الميزانية", "تجاوز الميزانية", "بدون ميزانية"]) assert.match(reportText, new RegExp(wording));

  const lifecycle = await evaluate(`(() => {
    const s=${JSON.stringify(scenario)};
    const deleted=structuredClone(s); deleted.transactions.find(t=>t.id==='g').deletedAt='2026-09-09';
    const restored=structuredClone(deleted); delete restored.transactions.find(t=>t.id==='g').deletedAt;
    const changed=structuredClone(s); changed.transactions.find(t=>t.id==='g').categoryId='ex_restaurant';
    const moved=structuredClone(s); moved.transactions.find(t=>t.id==='g').date='2026-10-01';
    return {
      deleted:PFMBudgetModel.calculateCategoryActuals(deleted,'2026-09').ex_grocery||0,
      restored:PFMBudgetModel.calculateCategoryActuals(restored,'2026-09').ex_grocery||0,
      oldAfterCategory:PFMBudgetModel.calculateCategoryActuals(changed,'2026-09').ex_grocery||0,
      newAfterCategory:PFMBudgetModel.calculateCategoryActuals(changed,'2026-09').ex_restaurant||0,
      sepAfterMove:PFMBudgetModel.calculateCategoryActuals(moved,'2026-09').ex_grocery||0,
      octAfterMove:PFMBudgetModel.calculateCategoryActuals(moved,'2026-10').ex_grocery||0,
    };
  })()`);
  assert.deepEqual(lifecycle, { deleted: 0, restored: 500000, oldAfterCategory: 0, newAfterCategory: 800000, sepAfterMove: 0, octAfterMove: 500000 });

  const noCategories = { version: 1, categories: [{ id: "in_salary", type: "income", name: "راتب" }], transactions: [{ id: "orphan", type: "expense", categoryId: "", amount: 300000, date: "2026-09-08" }], budgets: {} };
  await evaluate(`window.dispatchEvent(new CustomEvent('pfm:apply',{detail:${JSON.stringify(noCategories)}})); document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
  const emptyBudgetView = await evaluate(`({table:document.querySelector('#budgetTableBody').innerText,unbudgeted:document.querySelector('#budgetSummaryUnbudgeted').innerText,overall:document.querySelector('#budgetOverallStatus').innerText})`);
  assert.match(emptyBudgetView.table, /لا توجد تصنيفات مصروف/);
  assert.match(emptyBudgetView.unbudgeted, /300,000|٣٠٠٬٠٠٠/);
  assert.match(emptyBudgetView.overall, /بدون ميزانية/);
  await evaluate(`window.dispatchEvent(new CustomEvent('pfm:apply',{detail:${JSON.stringify(scenario)}})); document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);

  const viewports = {};
  for (const width of [390, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('#tabs .tab[data-tab="budgets"]').click()`);
    viewports[width] = await evaluate(`({summary:document.querySelector('#budgetSummary').getBoundingClientRect().width,viewport:innerWidth,documentScroll:document.documentElement.scrollWidth,tableScroll:document.querySelector('#budgetTableBody').closest('div').scrollWidth})`);
    assert.ok(viewports[width].summary > 0 && viewports[width].summary <= viewports[width].viewport);
    assert.ok(viewports[width].documentScroll <= viewports[width].viewport + 1);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`document.querySelector('#btnExport').click()`);
  const roundtrip = await evaluate(`(() => { const raw=document.querySelector('#exportText').value; const expected=JSON.parse(raw).budgets; document.querySelector('#modalExport [data-close]').click(); window.confirm=()=>true; document.querySelector('#importText').value=raw; document.querySelector('#btnDoImport').click(); return JSON.stringify(JSON.parse(localStorage.getItem('pfm_data_v1')).budgets)===JSON.stringify(expected); })()`);
  assert.equal(roundtrip, true);

  await evaluate(`navigator.serviceWorker.ready`); await reload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async r=>({active:!!r.active,controlled:!!navigator.serviceWorker.controller,keys:await caches.keys(),budget:!!(await caches.match('./budget-model.js?v=20260908-phase6'))}))`);
  assert.equal(pwa.active, true); assert.equal(pwa.controlled, true); assert.ok(pwa.keys.includes("pfm-pwa-v16")); assert.equal(pwa.budget, true); assert.equal(pwa.keys.includes("pfm-pwa-v10"), false);
  const errorCount = errors.length;
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }); await reload();
  assert.deepEqual(await evaluate(`({heading:document.querySelector('h1')?.innerText,budget:!!window.PFMBudgetModel})`), { heading: "إدارة المصاريف الشخصية", budget: true });
  assert.deepEqual(errors.slice(errorCount).filter((error) => !expectedFirebaseError(error)), []);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", summary, model, lifecycle, viewports, roundtrip, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
