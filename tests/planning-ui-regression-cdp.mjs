import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9370;
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

const expectedFirebaseError = value => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));
const fixture = { version:1, categories:[{id:"family",type:"expense",name:"عائلة / منزل"}], transactions:[], budgets:{} };
const selectMonth = () => evaluate(`(() => { const p=document.querySelector('#monthPicker');p.value='2027-01';p.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-tab="budgets"]').click(); })()`);
try {
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Network.enable"),send("Log.enable")]);
  const loaded=waitEvent("Page.loadEventFired");await send("Page.navigate",{url:appUrl});await loaded;await delay(900);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(fixture))})`);await reload();await selectMonth();
  await evaluate(`(() => {document.querySelector('#btnNewPurchase').click();document.querySelector('#purchaseTitle').value='غرفة غيث';document.querySelector('#purchaseMonth').value='2027-01';document.querySelector('#purchaseAmount').value='500000';document.querySelector('#purchaseSaved').value='100000';document.querySelector('#purchaseCategory').value='family';document.querySelector('#purchasePriority').value='high';document.querySelector('#purchaseNote').value='غرفة مع خزانة <img src=x onerror=alert(1)>';document.querySelector('#purchaseForm').requestSubmit();})()`);
  const planned=await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  const [id]=Object.keys(planned.plannedPurchases);
  assert.equal(planned.plannedPurchases[id].amount,500000);assert.equal(planned.transactions.length,0);assert.ok(planned._sync);
  assert.equal(await evaluate(`document.querySelectorAll('#purchaseTimeline img').length`),0);
  assert.equal(await evaluate(`PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')),'2027-01').totalExpenses`),0);
  await reload();await selectMonth();
  assert.equal(await evaluate(`document.querySelectorAll('[data-purchase-id]').length`),1);
  await evaluate(`document.querySelector('[data-purchase-action="cancel"]').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).plannedPurchases[${JSON.stringify(id)}].status`),"cancelled");
  await evaluate(`document.querySelector('[data-purchase-action="restore"]').click();document.querySelector('[data-purchase-action="edit"]').click();document.querySelector('#purchaseMonth').value='2027-02';document.querySelector('#purchaseForm').requestSubmit()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).plannedPurchases[${JSON.stringify(id)}].month`),"2027-02");
  const layouts={};
  for(const width of [360,390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`document.querySelector('#btnNewPurchase').click()`);
    layouts[width]=await evaluate(`({doc:document.documentElement.scrollWidth,width:innerWidth,form:!!document.querySelector('#purchaseForm'),months:document.querySelectorAll('.purchase-month').length})`);
    assert.ok(layouts[width].doc<=layouts[width].width+1,JSON.stringify(layouts[width]));assert.equal(layouts[width].months,12);
    await evaluate(`document.querySelector('#btnCancelPurchaseEdit').click()`);
  }
  if(process.argv[5]) {
    await send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.querySelector('#futurePurchases').scrollIntoView({behavior:'instant',block:'start'})`);await delay(150);
    const screenshot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    writeFileSync(process.argv[5],Buffer.from(screenshot.data,"base64"));
  }
  await evaluate(`document.querySelector('[data-purchase-action="buy"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#txDate').value`),"");
  await evaluate(`document.querySelector('#btnSaveTx').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).transactions.length`),0);
  await evaluate(`document.querySelector('#txDate').value='2027-02-10';document.querySelector('#txAmount').value='480000';document.querySelector('#btnSaveTx').click();document.querySelector('#btnSaveTx').click()`);
  const purchased=await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  assert.equal(purchased.transactions.length,1);assert.equal(purchased.transactions[0].amount,480000);assert.equal(purchased.transactions[0].plannedPurchaseId,id);
  assert.equal(purchased.plannedPurchases[id].transactionId,purchased.transactions[0].id);
  assert.match(await evaluate(`document.querySelector('[data-purchase-id]').innerText`),/تم الشراء/);
  await evaluate(`document.querySelector('[data-tab="dash"]').click();document.querySelector('#btnExport').click()`);
  assert.equal(await evaluate(`Object.keys(JSON.parse(document.querySelector('#exportText').value).plannedPurchases).length`),1);
  await evaluate(`document.querySelector('#modalExport [data-close]').click()`);
  // Simulate a second tab's addition arriving before this tab's next local edit.
  const other=await evaluate(`(() => { const before=JSON.parse(localStorage.getItem('pfm_data_v1')),next=JSON.parse(JSON.stringify(before));next.transactions.push({id:'other-tab',type:'income',amount:1000000,date:'2027-02-01'});return PFMSyncModel.recordChanges(before,next,'other-tab-actor');})()`);
  await evaluate(`(() => {const value=${JSON.stringify(JSON.stringify(other))};localStorage.setItem('pfm_data_v1',value);window.dispatchEvent(new StorageEvent('storage',{key:'pfm_data_v1',newValue:value}));})()`);
  assert.equal(await evaluate(`PFMGetState().transactions.length`),2);
  await evaluate(`navigator.serviceWorker.ready`);await reload();
  const assets=await evaluate(`Promise.all(['sync-model.js?v=20261105-sync2','cloud-sync.js?v=20261105-sync2','purchase-model.js?v=20261105-planning1','purchase-ui.js?v=20261105-planning1','planning.css?v=20261105-planning1'].map(async x=>!!await caches.match('./'+x)))`);
  assert.ok(assets.every(Boolean));
  const errorCount=errors.length;
  await send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await reload();await selectMonth();
  assert.equal(await evaluate(`document.querySelectorAll('[data-purchase-id]').length`),1);
  assert.equal(await evaluate(`!!window.PFMSyncModel&&!!window.PFMCloudSync&&!!window.PFMPurchaseModel`),true);
  assert.deepEqual(errors.slice(errorCount).filter(x=>!expectedFirebaseError(x)),[]);
  assert.deepEqual(errors.filter(x=>!expectedFirebaseError(x)),[]);
  console.log(JSON.stringify({result:'PASS',layouts,planned:500000,actual:480000,transactions:purchased.transactions.length,offlineAssets:assets.length,storageTabMerge:true}));
} finally {try{socket.close();}catch{}chrome.kill();}
