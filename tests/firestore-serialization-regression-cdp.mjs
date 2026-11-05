import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9372;
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
 await Promise.all([send('Page.enable'),send('Runtime.enable')]);const loaded=waitEvent('Page.loadEventFired');await send('Page.navigate',{url:appUrl});await loaded;await delay(900);
 const result=await evaluate(`(async()=>{
  if(!window.firebase?.firestore)return {available:false};
  const app=firebase.initializeApp({projectId:'demo-family-expenses-validation',apiKey:'demo-key',appId:'demo-app'},'sdk-validation');
  const db=firebase.firestore(app);db.useEmulator('127.0.0.1',9198);
  const base={version:1,categories:[{id:'family',type:'expense',name:'Family'}],transactions:[],budgets:{}};
  const a=PFMSyncModel.recordChanges(base,{...base,transactions:[{id:'one',type:'expense',amount:100,date:'2026-11-05'}]},'a');
  const b=PFMSyncModel.recordChanges(base,{...base,transactions:[{id:'one',type:'expense',amount:200,date:'2026-11-05'}]},'b');
  const cases={legacy:base,revisions:PFMSyncModel.merge(base,a),conflict:PFMSyncModel.merge(a,b)};
  const results={};
  for(const [key,data] of Object.entries(cases)){
    try{db.batch().set(db.doc('validation/'+key),{data,version:1,updatedBy:'test',updatedByClientId:'test',createdAt:firebase.firestore.Timestamp.now(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()});results[key]={valid:true};}
    catch(e){results[key]={valid:false,code:e.code,message:e.message};}
  }
  const realFirebase=window.firebase;
  const ref=db.doc('validation/controller');
  const user={uid:'sdk-validation-account',email:'validation@example.test'};
  const auth={currentUser:user,onAuthStateChanged(fn){this.listener=fn;}};
  const fakeDb={collection:()=>({doc:()=>({})}),runTransaction:async fn=>fn({
    get:async()=>({exists:true,data:()=>({data:base})}),
    // Exercise the real SDK parser, with no commit or server write.
    set:(reference,payload)=>db.batch().set(ref,{...payload,unsupportedUndefined:undefined}),
  })};
  const firestore=()=>fakeDb;firestore.FieldValue=realFirebase.firestore.FieldValue;
  window.firebase={apps:[{}],auth:()=>auth,firestore};
  localStorage.setItem('pfm_data_v1',JSON.stringify(a));localStorage.removeItem('pfm_sync_owner_v2');
  const controller=PFMCloudSync.start({});auth.listener(user);await controller.syncNow('validation');
  const diagnostic={phase:controller.getState().lastFailure?.phase,code:controller.getState().lastFailure?.code,visible:!document.querySelector('#cloudErrorDetails').hidden,message:document.querySelector('#cloudErrorMessage').value,preserved:JSON.parse(localStorage.getItem('pfm_data_v1')).transactions.length===1};
  window.firebase=realFirebase;
  await db.terminate();await app.delete();return {available:true,results,diagnostic};
 })()`);
 assert.equal(result.available,true,'Firebase SDK must be available for serializer validation');
 assert.ok(Object.values(result.results).every(item=>item.valid),JSON.stringify(result.results));
 assert.equal(result.diagnostic.phase,'write');assert.equal(result.diagnostic.code,'invalid-argument');
 assert.equal(result.diagnostic.visible,true);assert.equal(result.diagnostic.preserved,true);
 assert.match(result.diagnostic.message,/Unsupported field value: undefined/);
 assert.equal(requests.some(request=>request.url.includes('127.0.0.1:9198')),false,'Validation must not commit a write');
 console.log(JSON.stringify(result,null,2));
}finally{socket.close();chrome.kill();}
