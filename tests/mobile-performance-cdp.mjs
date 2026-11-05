import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9374;
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


try{
 await Promise.all([send('Page.enable'),send('Runtime.enable')]);
 await send('Fetch.enable',{patterns:[{urlPattern:'*www.gstatic.com/firebasejs/*',requestStage:'Request'}]});
 await send('Page.navigate',{url:appUrl});
 let interactive=false;
 for(let attempt=0;attempt<60;attempt++){interactive=await evaluate(`typeof window.PFMGetState==='function'`);if(interactive)break;await delay(50);}
 assert.equal(interactive,true,'The local app must start even while the Firebase CDN is stalled');
 assert.equal(await evaluate(`(()=>{document.querySelector('#btnAddTx').click();const ready=document.querySelector('#modalTx').classList.contains('open');document.querySelector('#modalTx [data-close]').click();return ready;})()`),true);
 assert.equal(await evaluate(`Promise.race([navigator.serviceWorker.ready.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))])`),true,'PWA updates must not wait for the cloud SDK');
 await send('Fetch.disable');await delay(900);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await send('Emulation.setCPUThrottlingRate',{rate:6});
 await evaluate(`(()=>{
 const transactions=Array.from({length:863},(_,i)=>({id:'perf-'+i,type:i%8?'expense':'income',date:'2026-11-05',amount:1000+i,categoryId:'family',note:'تفاصيل مالية للأسرة '.repeat(32)}));
 const conflicts={};for(let i=0;i<100;i++)conflicts['conflict-'+i]={path:['transactions',transactions[i].id],alternatives:[{stamp:{n:1,actor:'a'},deleted:false,value:transactions[i]},{stamp:{n:1,actor:'b'},deleted:false,value:{...transactions[i],amount:2000+i}}]};
 const data={version:1,categories:[{id:'family',type:'expense',name:'عائلة'}],transactions,budgets:{},_sync:{version:2,clock:1,vector:{a:1,b:1},revisions:{},conflicts}};
 window.dispatchEvent(new CustomEvent('pfm:apply',{detail:data}));
 const original=Storage.prototype.getItem;window.__dataReads=0;Storage.prototype.getItem=function(key){if(key==='pfm_data_v1')window.__dataReads++;return original.call(this,key)};
 })()`);
 const result=await evaluate(`(()=>{window.__dataReads=0;document.querySelector('#modalCloud').classList.remove('open');const start=performance.now();window.dispatchEvent(new CustomEvent('pfm:changed'));return {closedMs:performance.now()-start,reads:window.__dataReads,cards:document.querySelectorAll('#cloudConflicts .sync-conflict').length,bytes:new TextEncoder().encode(localStorage.getItem('pfm_data_v1')).length};})()`);
 console.log(JSON.stringify(result));
 assert.equal(result.cards,0,'Closed sync modal must not render conflict cards');
 assert.ok(result.reads<=2,'A sync event must not parse the entire ledger for each conflict');
 assert.ok(result.closedMs<150,'A hidden cloud panel must not block interaction');
 const open=await evaluate(`(()=>{window.__dataReads=0;const start=performance.now();document.querySelector('#btnCloud').click();const first=document.querySelector('#cloudConflicts .sync-conflict').dataset.conflictId;const paging=document.querySelector('[data-conflict-page]').parentElement;paging.querySelector('button:last-child').click();return {ms:performance.now()-start,reads:window.__dataReads,cards:document.querySelectorAll('#cloudConflicts .sync-conflict').length,first,next:document.querySelector('#cloudConflicts .sync-conflict').dataset.conflictId,page:document.querySelector('[data-conflict-page]').textContent};})()`);
 assert.equal(open.cards,10);assert.notEqual(open.first,open.next);assert.ok(open.reads<=2);
 const compression=await evaluate(`(async()=>{document.querySelector('#modalCloud').classList.remove('open');const data=PFMGetState(),gaps=[];let previous=performance.now();const timer=setInterval(()=>{const now=performance.now();gaps.push(now-previous);previous=now;},10);const start=performance.now();for(let i=0;i<2;i++)await PFMCloudStorage.pack(data);await new Promise(resolve=>setTimeout(resolve,50));clearInterval(timer);return {ms:performance.now()-start,maxGap:Math.max(...gaps)};})()`);
 console.log(JSON.stringify({open,compression}));
 assert.equal(await evaluate(`PFMCloudStorage.backgroundState().active`),true);
 assert.ok(compression.maxGap<250,'Compression must leave the UI event loop responsive');
 await evaluate(`document.querySelector('#cloudConflicts .sync-conflict button').click()`);
 const preserved=await evaluate(`({records:PFMGetState().transactions.length,conflicts:PFMSyncModel.conflicts(PFMGetState()).length})`);
 assert.equal(preserved.records,863);assert.equal(preserved.conflicts,99);
 await evaluate(`document.querySelector('#modalCloud').classList.remove('open');document.querySelector('[data-tab="reports"]').click()`);await delay(700);
 assert.equal(await evaluate(`document.querySelectorAll('#monthlySummaryBody tr').length`),12);
 assert.match(await evaluate(`document.querySelector('#comparisonMonthsLabel').textContent`),/2026/);
}finally{socket.close();chrome.kill();}
