import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9361;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (chunk) => { stderr += chunk; });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function target() { for (let i = 0; i < 100; i += 1) { try { const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()); const page = pages.find((candidate) => candidate.type === "page"); if (page) return page; } catch {} await delay(100); } throw new Error(`Chrome did not start: ${stderr}`); }
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let id = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); } const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {}); if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text); if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`); });
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload(wait = 800) { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(wait); }
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

const longCategory = "مستلزمات المنزل والمدرسة والرعاية الصحية طويلة الاسم";
const categories = [
  { id: "income", type: "income", name: "الراتب" },
  { id: "grocery", type: "expense", name: "السوبرماركت" },
  { id: "long", type: "expense", name: longCategory },
  { id: "rent", type: "expense", name: "الإيجار والخدمات" },
];
const tx = (id, date, type, amount, categoryId) => ({ id, date, type, amount, categoryId, note: id });
const debt = { id: "loan", name: "قسط منزل متأخر", type: "house", totalAmount: 25000000, paidBeforeTracking: 0, startDate: "2026-06-01", scheduleMode: "fixed", installmentAmount: 1000000, frequency: "monthly", firstDueDate: "2026-07-01", status: "active", createdAt: "2026-06-01T00:00:00.000Z" };
const scenario = {
  version: 1,
  categories,
  transactions: [
    tx("aug-income", "2026-08-01", "income", 25000000, "income"),
    tx("aug-grocery", "2026-08-04", "expense", 800000, "grocery"),
    tx("sep-income", "2026-09-01", "income", 25000000, "income"),
    tx("sep-grocery", "2026-09-03", "expense", 1100000, "grocery"),
    tx("sep-long", "2026-09-05", "expense", 850000, "long"),
    tx("sep-rent", "2026-09-07", "expense", 6800000, "rent"),
  ],
  budgets: { "2026-09": { plan: {}, items: { grocery: { amount: 1000000 }, long: { amount: 1000000 } } } },
  financialSettings: { months: { "2026-09": { openingBalanceMode: "manual", openingBalanceAmount: 12500000 } } },
  debtSettings: { obligations: { loan: debt }, paymentLinks: {} },
};

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url: appUrl });
  await loaded;
  await delay(900);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await delay(250);

  const loadedStyles = await evaluate(`[...document.styleSheets].map(sheet=>sheet.href).filter(Boolean)`);
  assert.ok(loadedStyles.some((href) => href.endsWith("/visual-polish.css?v=20260909-ux2")));
  assert.ok(loadedStyles.some((href) => href.endsWith("/mobile-enhancements.css?v=20260908-ux1")));

  const responsive = {};
  for (const width of [360, 390, 430, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 430 });
    await delay(100);
    responsive[width] = {};
    for (const view of ["dash", "tx", "budgets", "debts", "reports", "settings"]) {
      await evaluate(`document.querySelector('#tabs [data-tab="${view}"]').click()`);
      await delay(50);
      const layout = await evaluate(`(() => { const root=document.querySelector('#view-${view}'); const values=[...root.querySelectorAll('.value')]; const clipped=values.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.id||el.innerText); const tables=[...root.querySelectorAll('table')]; return {display:getComputedStyle(root).display,doc:document.documentElement.scrollWidth,viewport:innerWidth,clipped,tablesUsable:tables.every(table=>{const parent=table.parentElement;return table.scrollWidth<=parent.clientWidth+1||['auto','scroll'].includes(getComputedStyle(parent).overflowX)})}; })()`);
      assert.equal(layout.display, "block");
      assert.ok(layout.doc <= layout.viewport + 1, JSON.stringify({ width, view, layout }));
      assert.deepEqual(layout.clipped, [], JSON.stringify({ width, view, layout }));
      assert.equal(layout.tablesUsable, true, JSON.stringify({ width, view, layout }));
      responsive[width][view] = layout;
    }
    await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click()`);
    const hierarchy = await evaluate(`(() => { const primary=document.querySelector('.dashboard-primary-summary .kpi .value'); const secondary=document.querySelector('#kpiOpening'); const card=document.querySelector('#view-dash > .card'); const nested=document.querySelector('#view-settings .card .card'); const h2=document.querySelector('#view-dash .card .hd h2'); const h3=document.querySelector('.dashboard-section-head h3'); return {primarySize:parseFloat(getComputedStyle(primary).fontSize),primaryWeight:Number(getComputedStyle(primary).fontWeight),secondarySize:parseFloat(getComputedStyle(secondary).fontSize),secondaryWeight:Number(getComputedStyle(secondary).fontWeight),cardRadius:parseFloat(getComputedStyle(card).borderRadius),cardBorder:getComputedStyle(card).borderTopWidth,nestedShadow:getComputedStyle(nested).boxShadow,h2Size:parseFloat(getComputedStyle(h2).fontSize),h3Size:parseFloat(getComputedStyle(h3).fontSize)}; })()`);
    assert.ok(hierarchy.primarySize > hierarchy.secondarySize, JSON.stringify({ width, hierarchy }));
    assert.ok(hierarchy.primaryWeight >= hierarchy.secondaryWeight);
    assert.ok(hierarchy.cardRadius >= 14);
    assert.notEqual(hierarchy.cardBorder, "0px");
    assert.equal(hierarchy.nestedShadow, "none");
    assert.ok(hierarchy.h2Size >= hierarchy.h3Size);
    responsive[width].hierarchy = hierarchy;
  }

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click()`);
  const semantics = await evaluate(`(() => { const primary=getComputedStyle(document.querySelector('#btnAddTx')); const normal=getComputedStyle(document.querySelector('#btnDashboardOpeningBalance')); const danger=getComputedStyle(document.querySelector('#btnClearAll')); const warn=getComputedStyle(document.querySelector('.pill.warn')); const exceeded=getComputedStyle(document.querySelector('.pill.danger')); const attentionDanger=getComputedStyle(document.querySelector('.attention-item.danger')); const muted=getComputedStyle(document.querySelector('.mini')); const nav=document.querySelector('#tabs'); return {primaryBackground:primary.backgroundImage,primaryColor:primary.backgroundColor,primaryShadow:primary.boxShadow,primaryWeight:Number(primary.fontWeight),normalBackground:normal.backgroundImage,normalColor:normal.backgroundColor,normalShadow:normal.boxShadow,normalWeight:Number(normal.fontWeight),dangerColor:danger.color,dangerBorder:danger.borderColor,warnBackground:warn.backgroundColor,exceededBackground:exceeded.backgroundColor,attentionBackground:attentionDanger.backgroundColor,mutedSize:parseFloat(muted.fontSize),mutedColor:muted.color,navPosition:getComputedStyle(nav).position,navColumns:getComputedStyle(nav).gridTemplateColumns.split(' ').length}; })()`);
  assert.equal(semantics.primaryBackground, "none");
  assert.notEqual(semantics.primaryColor, semantics.normalColor);
  assert.notEqual(semantics.primaryShadow, semantics.normalShadow);
  assert.ok(semantics.primaryWeight > semantics.normalWeight);
  assert.notEqual(semantics.dangerBorder, "rgba(0, 0, 0, 0)");
  assert.notEqual(semantics.warnBackground, semantics.exceededBackground);
  assert.notEqual(semantics.attentionBackground, semantics.warnBackground);
  assert.ok(semantics.mutedSize >= 11.5);
  assert.equal(semantics.navPosition, "fixed");
  assert.equal(semantics.navColumns, 6);

  await evaluate(`document.querySelector('#btnAddTx').focus()`);
  const focus = await evaluate(`(() => { const style=getComputedStyle(document.querySelector('#btnAddTx')); const rule=[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(item=>item.cssText.includes('.btn:focus-visible'))}catch{return false}}); return {width:style.outlineWidth,style:style.outlineStyle,rule}; })()`);
  assert.notEqual(focus.width, "0px");
  assert.equal(focus.rule, true);

  await evaluate(`document.querySelector('#btnAddTx').click()`);
  const layering = await evaluate(`(() => { const modal=document.querySelector('#modalTx'); const nav=document.querySelector('#tabs'); return {modalZ:Number(getComputedStyle(modal).zIndex),navZ:Number(getComputedStyle(nav).zIndex)}; })()`);
  assert.ok(layering.modalZ > layering.navZ);
  await evaluate(`document.querySelector('#btnSaveTx').click()`);
  const toast = await evaluate(`(() => { const toast=document.querySelector('#toast'); const nav=document.querySelector('#tabs'); return {bottom:Math.round(toast.getBoundingClientRect().bottom),navTop:Math.round(nav.getBoundingClientRect().top)}; })()`);
  assert.ok(toast.bottom <= toast.navTop);
  await evaluate(`document.querySelector('#modalTx').classList.remove('open')`);

  const longText = await evaluate(`(() => { document.querySelector('#tabs [data-tab="budgets"]').click(); const row=[...document.querySelectorAll('#budgetTableBody tr')].find(tr=>tr.innerText.includes(${JSON.stringify(longCategory)})); const cell=row?.querySelector('td'); return {found:!!row,wrap:cell?getComputedStyle(cell).whiteSpace:null,doc:document.documentElement.scrollWidth,viewport:innerWidth}; })()`);
  assert.equal(longText.found, true);
  assert.notEqual(longText.wrap, "nowrap");
  assert.ok(longText.doc <= longText.viewport + 1);

  const stored = await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  for (const key of ["themeSettings", "uiSettings", "typographySettings", "visualSettings", "layoutSettings"]) assert.equal(Object.hasOwn(stored, key), false);

  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),visual:!!(await caches.match('./visual-polish.css?v=20260909-ux2')),mobile:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v20"));
  assert.ok(!pwa.keys.includes("pfm-pwa-v15"));
  assert.equal(pwa.visual, true);
  assert.equal(pwa.mobile, true);
  if (!pwa.controller) await reload();
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" });
  await reload();
  assert.equal(await evaluate(`[...document.styleSheets].some(sheet=>sheet.href?.endsWith('/visual-polish.css?v=20260909-ux2'))`), true);
  for (const view of ["dash", "tx", "budgets", "debts", "reports", "settings"]) {
    await evaluate(`document.querySelector('#tabs [data-tab="${view}"]').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#view-${view}')).display`), "block");
  }
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "wifi" });

  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", responsive, semantics, focus, layering, toast, longText, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
