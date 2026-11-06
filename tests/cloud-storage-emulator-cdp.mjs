import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9373;
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

const project='demo-family-expenses-validation';
// Only the disposable local emulator is cleared; no production endpoint is used.
const cleared=await fetch(`http://127.0.0.1:9198/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});
assert.equal(cleared.ok,true,'Start the isolated Firestore emulator on 127.0.0.1:9198');
try{
 await Promise.all([send('Page.enable'),send('Runtime.enable')]);const loaded=waitEvent('Page.loadEventFired');await send('Page.navigate',{url:appUrl});await loaded;await delay(900);
 const result=await evaluate(`(async()=>{
  if(!window.firebase?.firestore)return {available:false};
  const realFirebase=window.firebase,apps=[],databases=[];
  const base={version:1,categories:[{id:'family',type:'expense',name:'عائلة'}],transactions:[],budgets:{}};
  async function connect(uid,data,label){
    window.__emulatorPhase='connecting '+label;
    const app=realFirebase.initializeApp({projectId:'demo-family-expenses-validation',apiKey:'demo-key',appId:'demo-app'},label);
    const db=realFirebase.firestore(app);db.useEmulator('127.0.0.1',9198,{mockUserToken:{sub:uid}});apps.push(app);databases.push(db);
    const auth={currentUser:{uid,email:'test@example.test'},onAuthStateChanged(fn){this.listener=fn;}};
    const firestore=()=>db;firestore.FieldValue=realFirebase.firestore.FieldValue;
    window.firebase={apps:[{}],auth:()=>auth,firestore};
    localStorage.removeItem('pfm_backup_before_remote_v1');localStorage.removeItem('pfm_sync_owner_v2');
    localStorage.setItem('pfm_data_v1',JSON.stringify(data));window.PFMSyncActor=label;
    const api=PFMCloudSync.start({});auth.listener(auth.currentUser);await api.syncNow('wait initialization');
    if(api.getState().ready)await api.syncNow('settle');
    return {api,db,ref:db.collection('pfm_users').doc(uid),stop(){auth.currentUser=null;auth.listener(null);}};
  }
  const large={...base,transactions:Array.from({length:863},(_,i)=>({id:'day-'+i,type:'expense',categoryId:'family',date:'2026-11-05',amount:1000+i,note:'تفاصيل المصروفات العائلية '.repeat(40)}))};
  const journal=PFMSyncModel.recordChanges(base,large,'offline-wife');
  const rawBytes=new TextEncoder().encode(JSON.stringify(journal)).length;
  const preApp=realFirebase.initializeApp({projectId:'demo-family-expenses-validation',apiKey:'demo-key',appId:'demo-app'},'legacy-size-rejection');
  const preDb=realFirebase.firestore(preApp);preDb.useEmulator('127.0.0.1',9198,{mockUserToken:{sub:'size-test'}});apps.push(preApp);databases.push(preDb);
  await preDb.doc('pfm_users/size-test').set({data:{...base,transactions:[{id:'remote-preserved',type:'income',date:'2026-10-01',amount:5000,categoryId:'family',note:'older cloud record'}]}});
  let rawRejected=false;try{await preDb.doc('pfm_users/size-test').set({data:journal});}catch(e){rawRejected=e.code==='invalid-argument' && /size|maximum|bytes/i.test(e.message);}
  const wife=await connect('size-test',journal,'wife-device');
  if(!wife.api.getState().ready)throw new Error(JSON.stringify(wife.api.getState().lastFailure));
  const snapshot=await wife.ref.get({source:'server'}),packed=snapshot.data().data;
  const storedBytes=new TextEncoder().encode(JSON.stringify(snapshot.data())).length;
  wife.stop();
  const husband=await connect('size-test',base,'husband-device');
  if(!husband.api.getState().ready)throw new Error(JSON.stringify(husband.api.getState().lastFailure));
  const restored=JSON.parse(localStorage.getItem('pfm_data_v1'));
  husband.stop();
  // Exercise real Firestore map-key reordering, then migrate historical conflicts.
  const legacy={...base,transactions:[{id:'ordered-map',type:'expense',date:'2026-11-06',amount:100,categoryId:'family',note:'unchanged'}]};
  const serverLegacy={...legacy,transactions:legacy.transactions.map(tx=>Object.fromEntries(Object.keys(tx).sort().map(key=>[key,tx[key]])))};
  await preDb.doc('pfm_users/size-test').set({data:serverLegacy});
  const reordered=(await preDb.doc('pfm_users/size-test').get({source:'server'})).data().data;
  const firestoreReordered=JSON.stringify(reordered.transactions[0])!==JSON.stringify(legacy.transactions[0]);
  const mapClient=await connect('size-test',legacy,'map-order-device');
  const mapConflicts=PFMSyncModel.conflicts(JSON.parse(localStorage.getItem('pfm_data_v1'))).length;
  mapClient.stop();
  const history={...base,transactions:Array.from({length:863},(_,i)=>({id:'history-'+i,type:'expense',date:'2026-11-06',amount:1000+i,categoryId:'family',note:'سجل '+i})),_sync:{version:2,clock:2,vector:{a:2,b:2},revisions:{},conflicts:{}}};
  for(let i=0;i<1714;i++){const value=history.transactions[i%857],sorted=Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]]));history._sync.conflicts['old-'+i]={path:['transactions',value.id],alternatives:[{stamp:{n:1,actor:'a'},deleted:false,value},{stamp:{n:1,actor:'a'},deleted:false,value:sorted}]};}
  for(let i=0;i<2;i++){const value=history.transactions[861+i];history._sync.conflicts['real-'+i]={path:['transactions',value.id],alternatives:[{stamp:{n:2,actor:'a'},deleted:false,value:{...value,amount:700+i}},{stamp:{n:2,actor:'b'},deleted:false,value:{...value,amount:900+i}}]};}
  await preDb.doc('pfm_users/size-test').set({data:(await PFMCloudStorage.pack(history)).manifest});
  const repairClient=await connect('size-test',history,'repair-device');
  const repaired=JSON.parse(localStorage.getItem('pfm_data_v1'));
  const repairPreservesValues=history.transactions.every(tx=>PFMSyncModel.equivalent(tx,repaired.transactions.find(item=>item.id===tx.id)));
  const remainingRealConflicts=PFMSyncModel.conflicts(repaired).length;
  window.__emulatorPhase='adopting';
  const adopted=await repairClient.api.adoptFirstVersions();await repairClient.api.syncNow('publish all first');repairClient.stop();
  const replayClient=await connect('size-test',history,'old-phone-reconnect');
  const afterReplay=JSON.parse(localStorage.getItem('pfm_data_v1'));
  const replayConflicts=PFMSyncModel.conflicts(afterReplay).length;
  const firstChoicesPreserved=[861,862].every(i=>afterReplay.transactions.find(tx=>tx.id==='history-'+i).amount===700+i-861);
  replayClient.stop();
  const random=new Uint8Array(950000);for(let i=0;i<random.length;i+=65536)crypto.getRandomValues(random.subarray(i,Math.min(i+65536,random.length)));
  let binary='';for(let i=0;i<random.length;i+=16000)binary+=String.fromCharCode.apply(null,random.subarray(i,i+16000));
  const chunkData=PFMSyncModel.recordChanges(base,{...base,transactions:[{id:'large-note',type:'expense',categoryId:'family',date:'2026-11-05',amount:1000,note:btoa(binary)}]},'chunk-device');
  const chunked=await connect('chunk-test',chunkData,'chunk-device');
  if(!chunked.api.getState().ready)throw new Error(JSON.stringify(chunked.api.getState().lastFailure));
  const chunkSnapshot=await chunked.ref.get({source:'server'}),manifest=chunkSnapshot.data().data;
  const decoded=await PFMCloudStorage.unpack(manifest,async id=>(await chunked.ref.collection('snapshots').doc(id).get({source:'server'})).data());
  const chunkSizes=await Promise.all(manifest.partIds.map(async id=>new TextEncoder().encode(JSON.stringify((await chunked.ref.collection('snapshots').doc(id).get({source:'server'})).data())).length));
  const output={available:true,rawRejected,rawBytes,storedBytes,compressedInline:!!packed.parts,recordsRestored:restored.transactions.length,lastRecord:restored.transactions.some(tx=>tx.id==='day-862'),legacyRecordPreserved:restored.transactions.some(tx=>tx.id==='remote-preserved'),firestoreReordered,mapConflicts,repairPreservesValues,remainingRealConflicts,adopted,replayConflicts,firstChoicesPreserved,replayRecords:afterReplay.transactions.length,chunkCount:manifest.partIds.length,largestChunk:Math.max(...chunkSizes),chunkRoundtrip:decoded.transactions.find(tx=>tx.id==='large-note')?.note===chunkData.transactions[0].note};
  window.__emulatorPhase='terminating';
  window.firebase=realFirebase;for(const db of databases)await db.terminate();for(const app of apps)await app.delete();return output;
 })()`);
 assert.equal(result.available,true);assert.equal(result.rawRejected,true);assert.ok(result.rawBytes>1318063);
 assert.ok(result.storedBytes<1048576);assert.equal(result.compressedInline,true);
 assert.equal(result.recordsRestored,864);assert.equal(result.lastRecord,true);assert.equal(result.legacyRecordPreserved,true);
 assert.equal(result.firestoreReordered,true);assert.equal(result.mapConflicts,0);assert.equal(result.repairPreservesValues,true);
 assert.equal(result.remainingRealConflicts,2);assert.equal(result.adopted,true);assert.equal(result.replayConflicts,0);
 assert.equal(result.firstChoicesPreserved,true);assert.equal(result.replayRecords,863);
 assert.ok(result.chunkCount>1);assert.ok(result.largestChunk<1048576);assert.equal(result.chunkRoundtrip,true);
 console.log(JSON.stringify({result:'PASS',...result},null,2));
}finally{socket.close();chrome.kill();}
