import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9366;
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
async function reload(wait = 650) {
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", { ignoreCache: false });
  await loaded;
  await delay(wait);
}
const expectedFirebaseError = (value) => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

const healthy = {
  version: 1,
  categories: [{ id:"income", type:"income", name:"الراتب" }, { id:"living", type:"expense", name:"المعيشة" }],
  transactions: [
    { id:"aug-income", date:"2026-08-01", type:"income", amount:3235000, categoryId:"income", note:"دخل" },
    { id:"aug-expense", date:"2026-08-05", type:"expense", amount:1142600, categoryId:"living", note:"مصروف" },
    { id:"sep-income", date:"2026-09-01", type:"income", amount:3235000, categoryId:"income", note:"دخل" },
    { id:"sep-expense", date:"2026-09-06", type:"expense", amount:1142600, categoryId:"living", note:"مصروف" },
  ],
  budgets:{ "2026-09":{ plan:{}, items:{ living:{ amount:2000000, note:"" } } } },
  financialSettings:{ months:{ "2026-09":{ openingBalanceMode:"manual", openingBalanceAmount:500000 } } },
  expenseSettings:{}, debtSettings:{ obligations:{}, paymentLinks:{} }, shoppingSettings:{}, tagSettings:{},
};

try {
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url:appUrl });
  await loaded;
  await delay(900);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(healthy))})`);
  await reload();
  await evaluate(`(() => { const p=document.querySelector('#monthPicker'); p.value='2026-09'; p.dispatchEvent(new Event('change',{bubbles:true})); })()`);

  const theme = await evaluate(`(() => {
    const root=getComputedStyle(document.documentElement), body=getComputedStyle(document.body), top=getComputedStyle(document.querySelector('.topbar'));
    const add=getComputedStyle(document.querySelector('#btnAddTx')), card=getComputedStyle(document.querySelector('.card'));
    return {tokens:{bg:root.getPropertyValue('--theme-bg').trim(),surface:root.getPropertyValue('--theme-surface').trim(),text:root.getPropertyValue('--theme-text').trim(),muted:root.getPropertyValue('--theme-text-muted').trim(),border:root.getPropertyValue('--theme-border').trim(),primary:root.getPropertyValue('--theme-primary').trim(),secondary:root.getPropertyValue('--theme-secondary').trim(),success:root.getPropertyValue('--theme-success').trim(),warning:root.getPropertyValue('--theme-warning').trim(),danger:root.getPropertyValue('--theme-danger').trim()},body:body.backgroundColor,top:{bg:top.backgroundColor,blur:top.backdropFilter,shadow:top.boxShadow},add:{bg:add.backgroundColor,image:add.backgroundImage,color:add.color},card:{bg:card.backgroundColor,shadow:card.boxShadow}};
  })()`);
  assert.deepEqual(theme.tokens, { bg:"#f5f7fb", surface:"#ffffff", text:"#172033", muted:"#667085", border:"#e3e8ef", primary:"#2f6bff", secondary:"#0f9f8c", success:"#178a60", warning:"#b7791f", danger:"#c94b52" });
  assert.equal(theme.body, "rgb(245, 247, 251)");
  assert.equal(theme.top.bg, "rgb(255, 255, 255)");
  assert.ok(theme.top.blur === "none" || theme.top.blur === "");
  assert.equal(theme.add.bg, "rgb(47, 107, 255)"); assert.equal(theme.add.image, "none"); assert.equal(theme.add.color, "rgb(255, 255, 255)");
  assert.equal(theme.card.bg, "rgb(255, 255, 255)");

  const shell = await evaluate(`(() => ({nav:document.querySelectorAll('#tabs .tab').length,navIcons:document.querySelectorAll('#tabs .tab svg use').length,kpis:document.querySelectorAll('.dashboard-primary-summary>.kpi').length,kpiIcons:document.querySelectorAll('.dashboard-primary-summary .kpi-icon svg use').length,launchers:document.querySelectorAll('[data-dashboard-panel]').length,launcherIcons:document.querySelectorAll('[data-dashboard-panel] svg use').length,title:document.querySelector('.brand h1').innerText,subtitle:document.querySelector('.brand-subtitle').innerText,month:document.querySelector('#monthPickerDisplay').innerText,values:[...document.querySelectorAll('.dashboard-primary-summary .value')].map(x=>x.innerText),arabicDigits:/[٠-٩۰-۹]/.test(document.querySelector('#view-dash').innerText),attention:document.querySelector('#dashboardAttentionSection').hidden,stored:Object.keys(JSON.parse(localStorage.getItem('pfm_data_v1'))).filter(k=>/theme|appearance|color|icon|ux6/i.test(k))}))()`);
  assert.equal(shell.nav, 6); assert.equal(shell.navIcons, 6); assert.equal(shell.kpis, 4); assert.equal(shell.kpiIcons, 4); assert.equal(shell.launchers, 6); assert.equal(shell.launcherIcons, 6);
  assert.equal(shell.title, "إدارة المصاريف الشخصية"); assert.equal(shell.subtitle, "نظرة واضحة على أموالك هذا الشهر."); assert.equal(shell.month, "أيلول 2026");
  assert.deepEqual(shell.values, ["2,592,400 د.ع", "1,142,600 د.ع", "3,235,000 د.ع", "857,400 د.ع"]); assert.equal(shell.arabicDigits, false); assert.equal(shell.attention, true); assert.deepEqual(shell.stored, []);

  for (const name of ["financial", "comparison", "expenses", "debts", "budget", "charts"]) {
    const panel = await evaluate(`(() => { const b=document.querySelector('[data-dashboard-panel="${name}"]'); b.click(); return {visible:[...document.querySelectorAll('[data-dashboard-panel-target]')].filter(x=>!x.hidden).map(x=>x.dataset.dashboardPanelTarget),expanded:b.getAttribute('aria-expanded')}; })()`);
    assert.deepEqual(panel.visible, [name]); assert.equal(panel.expanded, "true");
  }
  await evaluate(`document.querySelector('[data-dashboard-panel="charts"]').click()`);

  const layouts = {};
  for (const width of [360, 390, 430, 768, 1200]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height:width <= 430 ? 844 : 900, deviceScaleFactor:1, mobile:width <= 430 });
    await delay(120);
    layouts[width] = await evaluate(`(() => { const tabs=[...document.querySelectorAll('#tabs .tab')]; return {doc:document.documentElement.scrollWidth,viewport:innerWidth,tabs:tabs.length,allNavVisible:tabs.every(x=>x.getClientRects().length),icons:tabs.every(x=>!!x.querySelector('svg use')),labels:tabs.every(x=>x.innerText.trim().length>0),bottom:getComputedStyle(document.querySelector('#tabs')).position==='fixed',primary:document.querySelectorAll('.dashboard-primary-summary>.kpi').length,longWrap:getComputedStyle(tabs[2]).whiteSpace}; })()`);
    assert.ok(layouts[width].doc <= layouts[width].viewport + 1, JSON.stringify({width, layout:layouts[width]}));
    assert.equal(layouts[width].tabs, 6); assert.equal(layouts[width].allNavVisible, true); assert.equal(layouts[width].icons, true); assert.equal(layouts[width].labels, true); assert.equal(layouts[width].primary, 4);
    if(width <= 430) assert.equal(layouts[width].bottom, true);
    if(width >= 768) assert.equal(layouts[width].bottom, false);
  }

  await send("Emulation.setDeviceMetricsOverride", { width:390, height:844, deviceScaleFactor:1, mobile:true });
  for (const tab of ["tx", "budgets", "debts", "reports", "settings", "dash"]) {
    const preservation = await evaluate(`(() => { document.querySelector('[data-tab="${tab}"]').click(); const view=document.querySelector('#view-${tab}'); return {visible:getComputedStyle(view).display!=='none',overflow:document.documentElement.scrollWidth<=innerWidth+1,txCards:document.querySelectorAll('.tx-mobile-card').length,budgetInputs:document.querySelectorAll('.budgetInput').length,debt:!!document.querySelector('#debtList'),reports:!!document.querySelector('#view-reports canvas'),settings:!!document.querySelector('#btnExport2')&&!!document.querySelector('#btnImport2')}; })()`);
    assert.equal(preservation.visible, true, `${tab}: view hidden`);
    assert.equal(preservation.overflow, true, `${tab}: horizontal overflow`);
    assert.equal(preservation.debt, true, `${tab}: debt surface missing`);
    assert.equal(preservation.reports, true, `${tab}: report surface missing`);
    assert.equal(preservation.settings, true, `${tab}: settings surface missing`);
    if(tab === "tx") assert.ok(preservation.txCards > 0, "transaction cards missing");
    if(tab === "budgets") assert.ok(preservation.budgetInputs > 0, "budget inputs missing");
  }

  const buttonSystem = await evaluate(`(() => { const p=getComputedStyle(document.querySelector('#btnAddTx')),s=getComputedStyle(document.querySelector('#btnExport')),d=getComputedStyle(document.querySelector('.btn.danger')); return {p:p.backgroundColor,s:s.backgroundColor,d:d.backgroundColor,distinct:new Set([p.backgroundColor,s.backgroundColor,d.backgroundColor]).size}; })()`);
  assert.equal(buttonSystem.distinct, 3);
  const inputs = await evaluate(`(() => { document.querySelector('[data-tab="tx"]').click(); const el=document.querySelector('#filterSearch'),s=getComputedStyle(el); return {height:el.getBoundingClientRect().height,bg:s.backgroundColor,radius:s.borderRadius,border:s.borderColor}; })()`);
  assert.ok(inputs.height >= 40); assert.equal(inputs.bg, "rgb(255, 255, 255)"); assert.equal(inputs.radius, "12px");

  await evaluate(`document.activeElement?.blur()`);
  for(let index=0; index<3; index+=1){
    await send("Input.dispatchKeyEvent", { type:"keyDown", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
    await send("Input.dispatchKeyEvent", { type:"keyUp", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
  }
  const focus = await evaluate(`(() => { const active=document.activeElement,el=active.id==='monthPicker'?active.closest('.month-picker-shell'):active,s=getComputedStyle(el); return {id:active.id,outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor}; })()`);
  assert.notEqual(focus.outline, "none", JSON.stringify(focus)); assert.equal(focus.width, "3px");

  await send("Emulation.setEmulatedMedia", { media:"screen", features:[{ name:"prefers-reduced-motion", value:"reduce" }] });
  const reduced = await evaluate(`({duration:getComputedStyle(document.querySelector('#btnAddTx')).transitionDuration,matched:matchMedia('(prefers-reduced-motion: reduce)').matches})`);
  assert.equal(reduced.matched, true, JSON.stringify(reduced));
  assert.ok(reduced.duration.split(",").every((value) => parseFloat(value) <= 0.01), JSON.stringify(reduced));
  await send("Emulation.setEmulatedMedia", { media:"screen", features:[] });

  const overdue = { id:"loan", name:"قسط متأخر", type:"personal", totalAmount:900000, paidBeforeTracking:0, startDate:"2026-06-01", scheduleMode:"fixed", installmentAmount:300000, frequency:"monthly", firstDueDate:"2026-07-01", status:"active", createdAt:"2026-06-01T00:00:00.000Z" };
  const actionable = { ...healthy, budgets:{"2026-09":{plan:{},items:{living:{amount:1200000}}}}, debtSettings:{obligations:{loan:overdue},paymentLinks:{}} };
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(actionable))})`);
  await reload();
  const status = await evaluate(`(() => { const items=[...document.querySelectorAll('#dashboardAttentionList .attention-item')],styles=items.map(x=>({class:x.className,bg:getComputedStyle(x).backgroundColor,color:getComputedStyle(x).color,text:x.innerText})); return {hidden:document.querySelector('#dashboardAttentionSection').hidden,styles,distinct:new Set(styles.map(x=>x.bg)).size}; })()`);
  assert.equal(status.hidden, false); assert.ok(status.styles.some(x=>x.class.includes("danger"))); assert.ok(status.styles.some(x=>x.class.includes("warn"))); assert.ok(status.distinct >= 2);

  const iconRequests = requests.filter((request) => /fontawesome|font-awesome|lucide|heroicons|material-icons|fonts\.googleapis|cdnjs|unpkg|\.svg(?:\?|$)/i.test(request.url));
  assert.deepEqual(iconRequests, []);
  assert.equal(requests.some((request) => /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com/i.test(request.url) && request.method !== "GET"), false);

  await evaluate(`navigator.serviceWorker.ready`);
  await reload();
  const pwa = await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),theme:!!(await caches.match('./theme-system.css?v=20260909-ux6')),ux5:!!(await caches.match('./dashboard-polish.css?v=20260909-ux5')),ux4:!!(await caches.match('./budget-polish.css?v=20260909-ux4')),ux3:!!(await caches.match('./interaction-polish.css?v=20260909-ux3')),ux2:!!(await caches.match('./visual-polish.css?v=20260909-ux2')),ux1:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v20")); for (const key of ["theme","ux5","ux4","ux3","ux2","ux1"]) assert.equal(pwa[key], true);
  if(!pwa.controller) await reload();
  const errorCount = errors.length;
  await send("Network.emulateNetworkConditions", { offline:true, latency:0, downloadThroughput:0, uploadThroughput:0, connectionType:"none" });
  await reload();
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor==='rgb(245, 247, 251)' && document.querySelectorAll('#tabs .tab svg use').length===6`), true);
  assert.deepEqual(errors.slice(errorCount).filter((error) => !expectedFirebaseError(error)), []);
  await send("Network.emulateNetworkConditions", { offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"wifi" });

  assert.deepEqual(errors.filter((error) => !expectedFirebaseError(error)), []);
  console.log(JSON.stringify({ result:"PASS", theme, shell, layouts, buttonSystem, inputs, focus, reduced, status, pwa }, null, 2));
} finally {
  try { socket.close(); } catch {}
  chrome.kill();
}
