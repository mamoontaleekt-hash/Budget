import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9375;
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

try {
  await Promise.all([send('Page.enable'),send('Runtime.enable'),send('Network.enable')]);
  const loaded=waitEvent('Page.loadEventFired');await send('Page.navigate',{url:appUrl});await loaded;await delay(800);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Emulation.setCPUThrottlingRate',{rate:6});
  const repair=await evaluate(`(()=>{
    const transactions=Array.from({length:863},(_,i)=>({id:'test-'+i,type:'expense',date:'2026-11-05',amount:1000+i,categoryId:'family',note:'سجل الأسرة '+i}));
    const data={version:1,categories:[{id:'family',type:'expense',name:'عائلة'}],transactions,budgets:{},_sync:{version:2,clock:2,vector:{a:2,b:2},revisions:{},conflicts:{}}};
    const sorted=value=>Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]));
    for(let i=0;i<1714;i++){const value=transactions[i%857];data._sync.conflicts['old-'+i]={path:['transactions',value.id],alternatives:[{stamp:{n:1,actor:'a'},deleted:false,value},{stamp:{n:1,actor:'a'},deleted:false,value:sorted(value)}]};}
    for(let i=0;i<2;i++){const value=transactions[861+i];data._sync.conflicts['actual-'+i]={path:['transactions',value.id],alternatives:[{stamp:{n:2,actor:'a'},deleted:false,value:{...value,amount:700+i}},{stamp:{n:2,actor:'b'},deleted:false,value:{...value,amount:900+i}}]};}
    window.__originalFixture=JSON.parse(JSON.stringify(data));
    const start=performance.now(),repaired=PFMSyncModel.repairConflicts(data);
    const repairMs=performance.now()-start;
    if(!PFMSyncModel.equivalent(data.transactions,repaired.transactions))throw new Error('Repair changed transaction values');
    window.dispatchEvent(new CustomEvent('pfm:apply',{detail:repaired}));
    document.querySelector('#btnCloud').click();
    return {repairMs,visible:document.querySelectorAll('.sync-conflict').length,unresolved:PFMSyncModel.conflicts(PFMGetState()).length,totalHistory:Object.keys(PFMGetState()._sync.conflicts).length,overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  assert.equal(repair.visible,2);assert.equal(repair.unresolved,2);assert.equal(repair.totalHistory,1716);assert.equal(repair.overflow,false);
  await evaluate(`document.querySelector('#btnCloudResolveAllFirst').click()`);
  let finished=false;
  for(let i=0;i<100;i++){finished=await evaluate(`PFMSyncModel.conflicts(PFMGetState()).length===0`);if(finished)break;await delay(100);}
  assert.equal(finished,true,await evaluate(`JSON.stringify({status:document.querySelector('#cloudStatus').textContent,error:document.querySelector('#cloudErrorMessage').value,backup:!!localStorage.getItem('pfm_conflict_backup_latest_v1'),worker:PFMCloudStorage.backgroundState()})`));
  const result=await evaluate(`(async()=>{
    const data=PFMGetState(),key=localStorage.getItem('pfm_conflict_backup_latest_v1'),backup=JSON.parse(localStorage.getItem(key));
    const parts=new Map(backup.documents.map(p=>[p.id,p.data]));
    const restored=await PFMCloudStorage.unpack(backup.manifest,async id=>parts.get(id));
    const unchanged=window.__originalFixture.transactions.slice(0,861).every(tx=>PFMSyncModel.equivalent(tx,data.transactions.find(t=>t.id===tx.id)));
    return {records:data.transactions.length,firstAmounts:[861,862].map(i=>data.transactions.find(t=>t.id==='test-'+i).amount),unchanged,backupRecords:restored.transactions.length,backupConflicts:PFMSyncModel.conflicts(restored).length,history:Object.keys(data._sync.conflicts).length,backupBytes:new TextEncoder().encode(localStorage.getItem(key)).length};
  })()`);
  assert.equal(result.records,863);assert.deepEqual(result.firstAmounts,[700,701]);assert.equal(result.unchanged,true);
  assert.equal(result.backupRecords,863);assert.equal(result.backupConflicts,2);assert.equal(result.history,1716);
  await evaluate(`navigator.serviceWorker.ready`);await reload();
  assert.equal(await evaluate(`PFMSyncModel.conflicts(PFMGetState()).length`),0);
  assert.equal(await evaluate(`PFMGetState().transactions.length`),863);
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await reload();
  assert.equal(await evaluate(`PFMGetState().transactions.length`),863);
  assert.equal(await evaluate(`PFMSyncModel.conflicts(PFMGetState()).length`),0);
  console.log(JSON.stringify({result:'PASS',repair,adoption:result,offlinePreserved:true}));
} finally {socket.close();chrome.kill();}

