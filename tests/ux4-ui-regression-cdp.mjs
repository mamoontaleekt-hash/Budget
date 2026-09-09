import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9361;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() {
  for (let i = 0; i < 100; i += 1) {
    try { const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()); const page = pages.find((candidate) => candidate.type === "page"); if (page) return page; } catch {}
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
  if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); }
  const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {});
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text);
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`);
  if (message.method === "Network.requestWillBeSent") requests.push({ url: message.params.request.url, method: message.params.request.method });
});
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload(wait = 700) { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(wait); }
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));
const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const money = (value) => new RegExp(String(value).split("").map((digit) => `[${digit}${arabicDigits[Number(digit)]}]`).join("[,٬]?"));

const categories = [
  { id: "in_salary", type: "income", name: "الراتب" },
  { id: "rent", type: "expense", name: "الإيجار" },
  { id: "grocery", type: "expense", name: "البقالة" },
  { id: "electric", type: "expense", name: "الكهرباء" },
  { id: "health", type: "expense", name: "المستلزمات المنزلية والمدرسية والرعاية الصحية طويلة الاسم للاختبار" },
  ...Array.from({ length: 21 }, (_, i) => ({ id: `extra_${i + 1}`, type: "expense", name: `تصنيف إضافي ${i + 1}` })),
];
const scenario = {
  version: 1,
  categories,
  transactions: [
    { id: "salary-sep", type: "income", categoryId: "in_salary", amount: 2000000, date: "2026-09-01" },
    { id: "grocery-sep", type: "expense", categoryId: "grocery", amount: 510000, date: "2026-09-04" },
    { id: "electric-sep", type: "expense", categoryId: "electric", amount: 300000, date: "2026-09-05" },
    { id: "health-sep", type: "expense", categoryId: "health", amount: 200000, date: "2026-09-06" },
    { id: "legacy-sep", type: "income", categoryId: "in_salary", amount: 150000, date: "2026-09-02", note: "رصيد قديم" },
    { id: "income-aug", type: "income", categoryId: "in_salary", amount: 900000, date: "2026-08-01" },
    { id: "expense-aug", type: "expense", categoryId: "grocery", amount: 100000, date: "2026-08-02" },
  ],
  budgets: {
    "2026-09": { plan: { income1: 1000000, income2: 2000000, note: "خطة أيلول" }, items: { rent: { amount: 1000000, note: "بداية الشهر" }, grocery: { amount: 600000, note: "أسبوعي" }, electric: { amount: 300000, note: "فاتورة" } } },
    "2026-08": { plan: { income1: 111000, income2: 222000, note: "خطة آب" }, items: { rent: { amount: 123000, note: "إيجار آب" } } },
  },
  financialSettings: { months: {
    "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 100000 },
    "2026-09": { openingBalanceMode: "manual", openingBalanceAmount: 500000 },
  } },
  expenseSettings: {}, debtSettings: { obligations: [] }, shoppingSettings: {}, tagSettings: {},
};

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired"); await send("Page.navigate", { url: appUrl }); await loaded; await delay(1000);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs [data-tab="budgets"]').click(); })()`);

  const initial = await evaluate(`(() => ({
    rows:document.querySelectorAll('#budgetTableBody tr[data-cat]').length,
    inputs:document.querySelectorAll('#budgetTableBody .budgetInput').length,
    notes:document.querySelectorAll('#budgetTableBody .budgetNote').length,
    planned:document.querySelector('#budgetSummaryPlanned').innerText,
    unallocated:document.querySelector('#planUnallocated').innerText,
    unbudgeted:document.querySelector('#budgetSummaryUnbudgeted').innerText,
    grocery:document.querySelector('[data-cat="grocery"]').innerText,
    electric:document.querySelector('[data-cat="electric"]').innerText,
    health:document.querySelector('[data-cat="health"]').innerText,
    remaining:document.querySelector('[data-cat="grocery"] .budgetRemaining').innerText,
    labels:['planIncome1','planIncome2','planNote'].map(id=>document.querySelector('label[for="'+id+'"]')?.innerText),
    sections:[...document.querySelectorAll('#view-budgets .budget-section h3')].map(x=>x.innerText),
  }))()`);
  assert.equal(initial.rows, 25); assert.equal(initial.inputs, 25); assert.equal(initial.notes, 25);
  assert.match(initial.planned, money(1900000)); assert.match(initial.unallocated, money(1100000)); assert.match(initial.unbudgeted, money(200000));
  assert.match(initial.grocery, /85%/); assert.match(initial.grocery, /اقتربت من الحد/); assert.match(initial.electric, /100%/); assert.match(initial.electric, /تم استهلاك الميزانية/);
  assert.match(initial.health, /بدون ميزانية/); assert.doesNotMatch(initial.health, /تجاوز الميزانية/); assert.match(initial.remaining, money(90000));
  assert.deepEqual(initial.labels, ["الدخل المخطط الأول", "الدخل المخطط الثاني", "ملاحظة الخطة"]);
  for (const heading of ["ملخص الميزانية", "الدخل المخطط", "ميزانيات التصنيفات"]) assert.ok(initial.sections.includes(heading));

  const financial = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const f=PFMFinancialModel.calculateMonthFinancials(s,'2026-09'); return {trueIncome:f.trueIncome,opening:f.openingBalance,mode:document.querySelector('#openingBalanceMode').value,amount:+document.querySelector('#openingBalanceAmount').value,separate:document.querySelector('#btnSaveFinancialSettings')!==document.querySelector('#btnSaveBudgets')}; })()`);
  assert.equal(financial.trueIncome, 2150000); assert.equal(financial.opening, 500000); assert.equal(financial.mode, "manual"); assert.equal(financial.amount, 500000); assert.equal(financial.separate, true);
  const planningOnlyBefore = financial.trueIncome;

  const live = await evaluate(`(() => { const input=document.querySelector('[data-cat="grocery"] .budgetInput'); const read=()=>({status:document.querySelector('[data-cat="grocery"] .budgetStatus').innerText,percent:document.querySelector('[data-cat="grocery"] .budgetPercent').innerText,remaining:document.querySelector('[data-cat="grocery"] .budgetRemaining').innerText}); input.value='510000'; input.dispatchEvent(new Event('input',{bubbles:true})); const at=read(); input.value='400000'; input.dispatchEvent(new Event('input',{bubbles:true})); const exceeded=read(); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); const none=read(); input.value='600000'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#planIncome1').value='1200000'; document.querySelector('#planIncome1').dispatchEvent(new Event('input',{bubbles:true})); return {at,exceeded,none,total:document.querySelector('#planBudgetTotal').innerText,unallocated:document.querySelector('#planUnallocated').innerText}; })()`);
  assert.match(live.at.status, /تم استهلاك الميزانية/); assert.match(live.at.percent, /100%/);
  assert.match(live.exceeded.status, /تجاوز الميزانية/); assert.match(live.exceeded.percent, /12[78]%/); assert.match(live.exceeded.remaining, /110,000|١١٠٬٠٠٠|110000/);
  assert.match(live.none.status, /بدون ميزانية/); assert.match(live.total, money(1900000)); assert.match(live.unallocated, money(1300000));
  assert.equal(await evaluate(`PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-09').trueIncome`), planningOnlyBefore);

  const beforeSuggestion = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  await evaluate(`document.querySelector('#btnAutoSuggestions').click()`);
  assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), beforeSuggestion);
  assert.notEqual(await evaluate(`document.querySelector('[data-cat="rent"] .budgetInput').value`), "1000000");
  await reload(); await evaluate(`document.querySelector('#tabs [data-tab="budgets"]').click()`);

  const layouts = {};
  for (const width of [360, 390, 430, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 430 }); await delay(100);
    await evaluate(`document.querySelector('#tabs [data-tab="budgets"]').click()`);
    layouts[width] = await evaluate(`(() => { const wrap=document.querySelector('.budget-table-wrap'),row=document.querySelector('#budgetTableBody tr[data-cat]'),thead=document.querySelector('.budget-table thead'),mobileSave=document.querySelector('#btnSaveBudgetsMobile'),long=document.querySelector('[data-cat="health"] .budget-category'); const r=long.getBoundingClientRect(); return {viewport:innerWidth,doc:document.documentElement.scrollWidth,wrapClient:wrap.clientWidth,wrapScroll:wrap.scrollWidth,rowDisplay:getComputedStyle(row).display,theadDisplay:getComputedStyle(thead).display,mobileSave:getComputedStyle(mobileSave.parentElement).display,rows:document.querySelectorAll('#budgetTableBody tr[data-cat]').length,inputs:document.querySelectorAll('#budgetTableBody .budgetInput').length,notes:document.querySelectorAll('#budgetTableBody .budgetNote').length,longClient:long.clientWidth,longScroll:long.scrollWidth,longHeight:r.height,lineHeight:parseFloat(getComputedStyle(long).lineHeight)||20}; })()`);
    assert.ok(layouts[width].doc <= width + 1, JSON.stringify({ width, layout: layouts[width] }));
    assert.equal(layouts[width].rows, 25); assert.equal(layouts[width].inputs, 25); assert.equal(layouts[width].notes, 25);
    if (width <= 720) {
      assert.equal(layouts[width].rowDisplay, "grid"); assert.equal(layouts[width].theadDisplay, "none"); assert.equal(layouts[width].mobileSave, "block");
      assert.ok(layouts[width].wrapScroll <= layouts[width].wrapClient + 1); assert.ok(layouts[width].longScroll <= layouts[width].longClient + 1); assert.ok(layouts[width].longHeight > layouts[width].lineHeight);
    } else {
      assert.equal(layouts[width].rowDisplay, "table-row"); assert.equal(layouts[width].theadDisplay, "table-header-group"); assert.equal(layouts[width].mobileSave, "none");
    }
  }

  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const topSave = await evaluate(`(() => { const original=Storage.prototype.setItem; window.__ux4Writes=0; Storage.prototype.setItem=function(k,v){if(k==='pfm_data_v1')window.__ux4Writes+=1;return original.call(this,k,v)}; const row=document.querySelector('[data-cat="rent"]'); row.querySelector('.budgetInput').value='1050000'; row.querySelector('.budgetNote').value='موعد الدفع بداية الشهر'; document.querySelector('#btnSaveBudgets').click(); Storage.prototype.setItem=original; const saved=JSON.parse(localStorage.getItem('pfm_data_v1')).budgets['2026-09'].items.rent; return {writes:window.__ux4Writes,saved}; })()`);
  assert.equal(topSave.writes, 1); assert.deepEqual(topSave.saved, { amount: 1050000, note: "موعد الدفع بداية الشهر" });
  await reload(); await evaluate(`document.querySelector('#tabs [data-tab="budgets"]').click()`);
  assert.deepEqual(await evaluate(`({amount:+document.querySelector('[data-cat="rent"] .budgetInput').value,note:document.querySelector('[data-cat="rent"] .budgetNote').value})`), { amount: 1050000, note: "موعد الدفع بداية الشهر" });

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  const mobileSave = await evaluate(`(() => { document.querySelector('#tabs [data-tab="dash"]').click(); document.querySelector('#tabs [data-tab="budgets"]').click(); const original=Storage.prototype.setItem; window.__ux4Writes=0; Storage.prototype.setItem=function(k,v){if(k==='pfm_data_v1')window.__ux4Writes+=1;return original.call(this,k,v)}; document.querySelector('[data-cat="rent"] .budgetInput').value='1060000'; document.querySelector('#btnSaveBudgetsMobile').click(); Storage.prototype.setItem=original; return {writes:window.__ux4Writes,amount:JSON.parse(localStorage.getItem('pfm_data_v1')).budgets['2026-09'].items.rent.amount,toast:document.querySelector('#toast').innerText}; })()`);
  assert.equal(mobileSave.writes, 1); assert.equal(mobileSave.amount, 1060000); assert.match(mobileSave.toast, /تم حفظ تقسيم الميزانية/);

  const monthSwitch = await evaluate(`(() => { const p=document.querySelector('#monthPicker'); const snap=()=>({i1:+document.querySelector('#planIncome1').value,i2:+document.querySelector('#planIncome2').value,note:document.querySelector('#planNote').value,rent:+document.querySelector('[data-cat="rent"] .budgetInput').value,rentNote:document.querySelector('[data-cat="rent"] .budgetNote').value,mode:document.querySelector('#openingBalanceMode').value,opening:+document.querySelector('#openingBalanceAmount').value}); p.value='2026-08'; p.dispatchEvent(new Event('change',{bubbles:true})); const aug=snap(); p.value='2026-09'; p.dispatchEvent(new Event('change',{bubbles:true})); const sep=snap(); return {aug,sep}; })()`);
  assert.deepEqual(monthSwitch.aug, { i1:111000, i2:222000, note:"خطة آب", rent:123000, rentNote:"إيجار آب", mode:"manual", opening:100000 });
  assert.equal(monthSwitch.sep.i1, 1000000); assert.equal(monthSwitch.sep.i2, 2000000); assert.equal(monthSwitch.sep.rent, 1060000); assert.equal(monthSwitch.sep.rentNote, "موعد الدفع بداية الشهر");

  const openingModes = await evaluate(`(() => { const select=document.querySelector('#openingBalanceMode'); const show=(mode)=>{select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));return {manual:!document.querySelector('#openingManualPanel').hidden,carry:!document.querySelector('#openingCarryPanel').hidden,legacy:!document.querySelector('#openingLegacyPanel').hidden,preview:document.querySelector('#openingBalancePreview').innerText}}; return {manual:show('manual'),carry:show('carry'),legacy:show('legacy'),legacyChoices:document.querySelectorAll('[data-legacy-opening-id]').length}; })()`);
  assert.equal(openingModes.manual.manual, true); assert.equal(openingModes.carry.carry, true); assert.match(openingModes.carry.preview, money(900000)); assert.equal(openingModes.legacy.legacy, true); assert.ok(openingModes.legacyChoices >= 2);

  await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click()`);
  const dashboard = await evaluate(`document.querySelector('#budgetAlertsList').innerText`);
  assert.match(dashboard, /البقالة/); assert.match(dashboard, /الكهرباء/);
  await evaluate(`document.querySelector('#tabs [data-tab="tx"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#tabs .tab').length`), 6);
  assert.ok(await evaluate(`document.querySelectorAll('#txMobileList .tx-mobile-card').length>0`));

  const persisted = await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  for (const key of ["mobileBudgetData", "budgetCardData", "budgetDraftState", "budgetViewState", "budgetUISettings", "ux4Settings"]) assert.equal(Object.hasOwn(persisted, key), false);
  assert.deepEqual(Object.keys(persisted.budgets["2026-09"]).sort(), ["items", "plan"]);

  const emptyState = await evaluate(`(() => { const saved=localStorage.getItem('pfm_data_v1'); window.dispatchEvent(new CustomEvent('pfm:apply',{detail:{version:1,categories:[{id:'in_salary',type:'income',name:'الراتب'}],transactions:[],budgets:{}}})); document.querySelector('#tabs [data-tab="budgets"]').click(); const row=document.querySelector('#budgetTableBody tr'); const result={categoryRows:document.querySelectorAll('#budgetTableBody tr[data-cat]').length,text:row.innerText,display:getComputedStyle(row).display,doc:document.documentElement.scrollWidth,viewport:innerWidth}; window.dispatchEvent(new CustomEvent('pfm:apply',{detail:JSON.parse(saved)})); return result; })()`);
  assert.equal(emptyState.categoryRows, 0); assert.match(emptyState.text, /لا توجد تصنيفات مصروف/); assert.equal(emptyState.display, "block"); assert.ok(emptyState.doc <= emptyState.viewport + 1);

  await evaluate(`navigator.serviceWorker.ready`); await reload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),ux4:!!(await caches.match('./budget-polish.css?v=20260909-ux4')),ux3:!!(await caches.match('./interaction-polish.css?v=20260909-ux3')),ux2:!!(await caches.match('./visual-polish.css?v=20260909-ux2')),ux1:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v20")); assert.equal(pwa.ux4, true); assert.equal(pwa.ux3, true); assert.equal(pwa.ux2, true); assert.equal(pwa.ux1, true);
  if (!pwa.controller) await reload();
  const errorCount = errors.length;
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" }); await reload();
  await evaluate(`document.querySelector('#tabs [data-tab="budgets"]').click()`);
  assert.equal(await evaluate(`[...document.styleSheets].some(x=>x.href?.endsWith('/budget-polish.css?v=20260909-ux4'))`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#budgetTableBody tr[data-cat]')).display`), "grid");
  assert.deepEqual(errors.slice(errorCount).filter((error) => !expectedFirebaseError(error)), []);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "wifi" });

  assert.equal(requests.some((request) => /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com/i.test(request.url) && request.method !== "GET"), false);
  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result:"PASS", initial, financial, live, layouts, topSave, mobileSave, monthSwitch, openingModes, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
