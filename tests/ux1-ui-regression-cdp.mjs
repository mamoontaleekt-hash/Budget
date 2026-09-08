import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9360;
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
socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); pending.delete(message.id); return message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result || {}); } const queue = waiters.get(message.method); if (queue?.length) queue.shift()(message.params || {}); if (message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text); if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(message.params.entry.text); });
const send = (method, params = {}) => new Promise((done, fail) => { const next = ++id; pending.set(next, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id: next, method, params })); });
const waitEvent = (method, timeout = 20000) => new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error(`Timeout: ${method}`)), timeout); const queue = waiters.get(method) || []; queue.push((params) => { clearTimeout(timer); done(params); }); waiters.set(method, queue); });
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function reload(wait = 700) { const loaded = waitEvent("Page.loadEventFired"); await send("Page.reload", { ignoreCache: false }); await loaded; await delay(wait); }
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

const scenario = {
  version: 1,
  categories: [{ id: "salary", type: "income", name: "الراتب" }, { id: "food", type: "expense", name: "الطعام" }],
  transactions: [{ id: "income", type: "income", amount: 2000000, date: "2026-09-01", categoryId: "salary" }, { id: "food", type: "expense", amount: 900000, date: "2026-09-02", categoryId: "food" }],
  budgets: { "2026-09": { plan: {}, items: { food: { amount: 500000 } } } },
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

  const initial = await evaluate(`({navs:document.querySelectorAll('#tabs').length,tabs:[...document.querySelectorAll('#tabs .tab')].map(x=>({tag:x.tagName,type:x.type,target:x.dataset.tab,current:x.getAttribute('aria-current')})),active:document.querySelector('#tabs .active')?.dataset.tab})`);
  assert.equal(initial.navs, 1);
  assert.deepEqual(initial.tabs.map((tab) => tab.target), ["dash", "tx", "budgets", "debts", "reports", "settings"]);
  assert.ok(initial.tabs.every((tab) => tab.tag === "BUTTON" && tab.type === "button"));
  assert.equal(initial.active, "dash");
  assert.equal(initial.tabs.filter((tab) => tab.current === "page").length, 1);

  const widths = {};
  for (const width of [360, 390, 430, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 430 });
    await delay(80);
    widths[width] = await evaluate(`(() => { const nav=document.querySelector('#tabs'); const top=document.querySelector('.topbar'); const controls=[...document.querySelectorAll('.controls > *')].map(x=>({text:x.innerText||x.value,rect:x.getBoundingClientRect().toJSON()})); const style=getComputedStyle(nav); return {doc:document.documentElement.scrollWidth,viewport:innerWidth,navPosition:style.position,navBottom:Math.round(nav.getBoundingClientRect().bottom),navWidth:Math.round(nav.getBoundingClientRect().width),navHeight:Math.round(nav.getBoundingClientRect().height),overflowX:style.overflowX,topPosition:getComputedStyle(top).position,columns:getComputedStyle(nav).gridTemplateColumns.split(' ').length,controls}; })()`);
    assert.ok(widths[width].doc <= widths[width].viewport + 1, JSON.stringify({ width, layout: widths[width] }));
    if (width <= 430) {
      assert.equal(widths[width].navPosition, "fixed");
      assert.equal(widths[width].navBottom, 900);
      assert.equal(widths[width].navWidth, width);
      assert.equal(widths[width].columns, 6);
      assert.equal(widths[width].topPosition, "static");
      assert.ok(widths[width].navHeight >= 44);
    } else {
      assert.notEqual(widths[width].navPosition, "fixed");
    }
  }

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  assert.equal(Math.round(widths[390].controls[1].rect.top), Math.round(widths[390].controls[2].rect.top));
  assert.equal(Math.round(widths[390].controls[3].rect.top), Math.round(widths[390].controls[4].rect.top));
  assert.ok(widths[390].controls.every((control) => control.rect.left >= 0 && control.rect.right <= 390));
  const activeVisual = await evaluate(`(() => { const active=document.querySelector('#tabs .active'); const inactive=document.querySelector('#tabs .tab:not(.active)'); return {activeWeight:getComputedStyle(active).fontWeight,inactiveWeight:getComputedStyle(inactive).fontWeight,activeMarker:getComputedStyle(active,'::before').backgroundColor,inactiveMarker:getComputedStyle(inactive,'::before').backgroundColor}; })()`);
  assert.notEqual(activeVisual.activeWeight, activeVisual.inactiveWeight);
  assert.notEqual(activeVisual.activeMarker, activeVisual.inactiveMarker);
  const storedBeforeNavigation = await evaluate(`localStorage.getItem('pfm_data_v1')`);
  for (const targetName of ["tx", "budgets", "debts", "reports", "settings"]) {
    await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click(); document.querySelector('#tabs [data-tab="${targetName}"]').click()`);
    const state = await evaluate(`({active:document.querySelector('#tabs .active')?.dataset.tab,current:document.querySelectorAll('#tabs [aria-current="page"]').length,visible:getComputedStyle(document.querySelector('#view-${targetName}')).display})`);
    assert.deepEqual(state, { active: targetName, current: 1, visible: "block" });
    await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#view-dash')).display`), "block");
  }

  await evaluate(`document.querySelector('#tabs [data-tab="reports"]').click(); (()=>{const p=document.querySelector('#monthPicker');p.value='2026-08';p.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  assert.equal(await evaluate(`document.querySelector('#tabs .active').dataset.tab`), "reports");
  await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click()`);

  for (const [button, expected] of [["btnDashboardBudgets", "budgets"], ["btnDashboardDebts", "debts"], ["btnDashboardReports", "reports"]]) {
    await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click(); document.querySelector('#${button}').click()`);
    assert.equal(await evaluate(`document.querySelector('#tabs .active').dataset.tab`), expected);
  }
  await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click(); document.querySelector('#btnDashboardAddTx').click()`);
  assert.equal(await evaluate(`document.querySelector('#modalTx').classList.contains('open')`), true);
  const modalLayout = await evaluate(`(() => { const modal=document.querySelector('#modalTx'); const nav=document.querySelector('#tabs'); const footer=document.querySelector('#modalTx .ft'); return {modalZ:Number(getComputedStyle(modal).zIndex),navZ:Number(getComputedStyle(nav).zIndex),footerBottom:Math.round(footer.getBoundingClientRect().bottom),viewport:innerHeight,scrollable:getComputedStyle(document.querySelector('#modalTx .bd')).overflowY}; })()`);
  assert.ok(modalLayout.modalZ > modalLayout.navZ);
  assert.ok(modalLayout.footerBottom <= modalLayout.viewport + 1);
  assert.match(modalLayout.scrollable, /auto|scroll/);
  await evaluate(`document.querySelector('#btnSaveTx').click()`);
  const toastLayout = await evaluate(`(() => { const toast=document.querySelector('#toast'); const nav=document.querySelector('#tabs'); return {bottom:Math.round(toast.getBoundingClientRect().bottom),navTop:Math.round(nav.getBoundingClientRect().top),pointerEvents:getComputedStyle(toast).pointerEvents}; })()`);
  assert.ok(toastLayout.bottom <= toastLayout.navTop);
  assert.equal(toastLayout.pointerEvents, "none");
  await evaluate(`document.querySelector('#modalTx [data-close]').click()`);

  for (const [button, modal] of [["btnAddTx", "modalTx"], ["btnExport", "modalExport"], ["btnImport", "modalImport"], ["btnCloud", "modalCloud"]]) {
    await evaluate(`document.querySelector('#${button}').click()`);
    assert.equal(await evaluate(`document.querySelector('#${modal}').classList.contains('open')`), true);
    await evaluate(`document.querySelector('#${modal}').classList.remove('open')`);
  }
  const controls = await evaluate(`({month:!!document.querySelector('#monthPicker'),add:!!document.querySelector('#btnAddTx'),export:!!document.querySelector('#btnExport'),importButton:!!document.querySelector('#btnImport'),cloud:!!document.querySelector('#btnCloud'),badge:document.querySelector('#cloudBadge').innerText.trim(),focusRule:[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('.tab:focus-visible'))}catch{return false}})})`);
  assert.ok(controls.month && controls.add && controls.export && controls.importButton && controls.cloud);
  assert.ok(controls.badge.length > 0);
  assert.equal(controls.focusRule, true);
  await evaluate(`document.querySelector('#tabs [data-tab="tx"]').focus()`);
  assert.deepEqual(await evaluate(`({focused:document.activeElement?.dataset.tab,tabIndex:document.activeElement?.tabIndex})`), { focused: "tx", tabIndex: 0 });

  for (const targetName of ["dash", "tx", "budgets", "debts", "reports", "settings"]) {
    await evaluate(`document.querySelector('#tabs [data-tab="${targetName}"]').click(); scrollTo(0,document.documentElement.scrollHeight)`);
    await delay(50);
    const clearance = await evaluate(`(() => { const view=document.querySelector('#view-${targetName}'); const last=view.lastElementChild || view; const nav=document.querySelector('#tabs'); return {lastBottom:Math.round(last.getBoundingClientRect().bottom),navTop:Math.round(nav.getBoundingClientRect().top),scrollY:Math.round(scrollY),maxScroll:Math.round(document.documentElement.scrollHeight-innerHeight)}; })()`);
    assert.ok(clearance.lastBottom <= clearance.navTop + 1, JSON.stringify({ targetName, clearance }));
  }

  await evaluate(`document.querySelector('#tabs [data-tab="dash"]').click(); for(let i=0;i<5;i++){ for(const tab of document.querySelectorAll('#tabs .tab')) tab.click(); } document.querySelector('#tabs [data-tab="dash"]').click()`);
  assert.equal(await evaluate(`localStorage.getItem('pfm_data_v1')`), storedBeforeNavigation);
  assert.equal(await evaluate(`document.querySelectorAll('#tabs .tab').length`), 6);

  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs [data-tab="dash"]').click(); })()`);
  const attentionTarget = await evaluate(`document.querySelector('#dashboardAttentionList [data-dashboard-target]')?.dataset.dashboardTarget || null`);
  assert.ok(attentionTarget);
  await evaluate(`document.querySelector('#dashboardAttentionList [data-dashboard-target]').click()`);
  assert.equal(await evaluate(`document.querySelector('#tabs .active').dataset.tab`), attentionTarget);

  await reload();
  assert.equal(await evaluate(`document.querySelector('#tabs .active').dataset.tab`), "dash");
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),css:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v15"));
  assert.ok(!pwa.keys.includes("pfm-pwa-v14"));
  assert.equal(pwa.css, true);
  if (!pwa.controller) await reload();
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" });
  await reload();
  for (const targetName of ["dash", "tx", "budgets", "debts", "reports", "settings"]) {
    await evaluate(`document.querySelector('#tabs [data-tab="${targetName}"]').click()`);
    assert.equal(await evaluate(`document.querySelector('#tabs .active').dataset.tab`), targetName);
  }
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "wifi" });

  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result: "PASS", widths, activeVisual, modalLayout, toastLayout, controls, attentionTarget, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
