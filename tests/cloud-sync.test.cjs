const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const Sync=require("../sync-model.js");
const source=fs.readFileSync(path.join(__dirname,"../cloud-sync.js"),"utf8");
const copy=value=>JSON.parse(JSON.stringify(value));
const empty=()=>({version:1,categories:[],transactions:[],budgets:{}});
function backend(initial=empty()){
  return {document:{data:initial},version:0,listeners:new Set(),gate:null,fail:false,writes:0,
    snapshot(){const data=copy(this.document);return {exists:!!data,metadata:{hasPendingWrites:false,fromCache:false},data:()=>data};},
    async transaction(fn){
      for(let attempts=0;attempts<10;attempts++){
        if(this.fail)throw Object.assign(new Error("offline"),{code:"unavailable"});
        const version=this.version,snapshot=this.snapshot();let write;
        const result=await fn({get:async()=>snapshot,set:(ref,data)=>{write=copy(data);}});
        if(this.gate){const gate=this.gate;this.gate=null;await gate;}
        if(version!==this.version)continue;
        if(write){this.document=write;this.version++;this.writes++;for(const listener of this.listeners)listener(this.snapshot());}
        return result;
      }
      throw new Error("transaction retries exhausted");
    }};
}
function client(server,actor,stored){
  const storage=stored || new Map([["pfm_data_v1",JSON.stringify(empty())]]);
  const nodes=new Map(),events=new EventTarget(),docEvents=new EventTarget(),tasks=new Map();let taskId=0,authChanged;
  const node=()=>({textContent:"",value:"",style:{},classList:{remove(){},add(){}},addEventListener(){},replaceChildren(){},hidden:false});
  const getNode=selector=>{if(selector==="#cloudConflicts")return null;if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))};
  const auth={currentUser:null,onAuthStateChanged:fn=>{authChanged=fn;},async signOut(){this.currentUser=null;authChanged(null);}};
  const db={collection:()=>({doc:()=>({onSnapshot(options,fn){server.listeners.add(fn);return ()=>server.listeners.delete(fn);}})}),runTransaction:fn=>server.transaction(fn)};
  const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>"server-time"};
  const sandbox={console,Event,CustomEvent,JSON,Date,Map,Set,Promise,TextEncoder,navigator:{onLine:true},localStorage,
    document:{querySelector:getNode,addEventListener:docEvents.addEventListener.bind(docEvents)},
    addEventListener:events.addEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
    setTimeout:(fn,ms)=>{const id=++taskId;tasks.set(id,{fn,ms});return id;},clearTimeout:id=>tasks.delete(id),
    PFMSyncModel:Sync,PFMSyncActor:actor,PFMDisplayFormat:{westernizeDigits:String},firebase:{apps:[{}],auth:()=>auth,firestore},};
  sandbox.window=sandbox;
  events.addEventListener("pfm:apply",event=>localStorage.setItem("pfm_data_v1",JSON.stringify(event.detail)));
  vm.runInNewContext(source,sandbox,{filename:"cloud-sync.js"});
  const api=sandbox.PFMCloudSync.start({});
  return {api,storage,sandbox,tasks,read:()=>JSON.parse(storage.get("pfm_data_v1")),
    async login(uid="family"){auth.currentUser={uid,email:"family@example.test"};authChanged(auth.currentUser);await api.syncNow("wait login");},
    edit(id,amount=100){const before=JSON.parse(storage.get("pfm_data_v1")),after=copy(before);after.transactions.push({id,type:"expense",amount,date:"2026-11-05"});localStorage.setItem("pfm_data_v1",JSON.stringify(Sync.recordChanges(before,after,actor)));events.dispatchEvent(new Event("pfm:changed"));},
    status:()=>getNode("#cloudStatus").textContent,
  };
}
test("real controller transaction retries retain concurrent additions from two devices",async()=>{
  const server=backend(),wife=client(server,"wife"),husband=client(server,"husband");
  await wife.login();await husband.login();
  wife.edit("wife-week");husband.edit("husband");
  await Promise.all([wife.api.syncNow("wife"),husband.api.syncNow("husband")]);
  await wife.api.syncNow("settle");await husband.api.syncNow("settle");
  assert.deepEqual(server.document.data.transactions.map(t=>t.id).sort(),["husband","wife-week"]);
  assert.equal(wife.read().transactions.length,2);assert.equal(husband.read().transactions.length,2);
});
test("offline edits survive closing the app and merge with the cloud on next login",async()=>{
  const server=backend(),wife=client(server,"wife");await wife.login();
  wife.sandbox.navigator.onLine=false;wife.edit("offline-week");await wife.api.syncNow("offline");
  assert.match(wife.status(),/محفوظة/);
  server.listeners.clear();
  const husband=client(server,"husband");await husband.login();husband.edit("online");await husband.api.syncNow("online");
  // Simulate the closed page: stop its snapshot listener, reuse only durable storage.
  server.listeners.clear();
  const reopened=client(server,"wife-reopened",wife.storage);await reopened.login();
  assert.deepEqual(server.document.data.transactions.map(t=>t.id).sort(),["offline-week","online"]);
});
test("edits made during an in-flight write remain pending and are uploaded next",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("first");
  let release;server.gate=new Promise(resolve=>release=resolve);
  const pending=c.api.syncNow("slow");await Promise.resolve();await Promise.resolve();c.edit("second");release();await pending;
  assert.equal(c.read().transactions.length,2);assert.equal(c.api.getState().dirty,true);
  await c.api.syncNow("next");assert.equal(server.document.data.transactions.length,2);assert.equal(c.api.getState().dirty,false);
});
test("failed writes never report cloud success and retry without dropping saved data",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("retained");server.fail=true;
  assert.equal(await c.api.syncNow("fail"),false);assert.equal(c.read().transactions.length,1);assert.match(c.status(),/لم تؤكد السحابة/);assert.ok(c.tasks.size);
  server.fail=false;await c.api.syncNow("retry");assert.equal(server.document.data.transactions.length,1);assert.equal(c.api.getState().dirty,false);
});
test("invalid remote payloads cannot overwrite valid local data",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("safe");server.document={data:{broken:true}};
  await c.api.syncNow("invalid");assert.equal(c.read().transactions[0].id,"safe");assert.equal(server.document.data.broken,true);
});
test("account changes do not merge one family's records into another account",async()=>{
  const server=backend(),c=client(server,"a");await c.login("one");c.edit("private");const before=copy(server.document);
  await c.login("two");assert.deepEqual(server.document,before);assert.match(c.status(),/حساب آخر/);
});
test("reports the exact server rejection and its phase without replacing local records",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("retained");
  server.transaction=async fn=>{
    await fn({get:async()=>server.snapshot(),set(){}});
    throw Object.assign(new Error("Document path projects/demo/documents/pfm_users/family is too large"),{code:"invalid-argument"});
  };
  assert.equal(await c.api.syncNow("reject"),false);
  assert.equal(c.api.getState().lastFailure.code,"invalid-argument");
  assert.equal(c.api.getState().lastFailure.phase,"commit");
  assert.match(c.api.getState().lastFailure.message,/is too large/);
  assert.ok(!c.api.getState().lastFailure.message.includes('/family'));
  assert.equal(c.read().transactions[0].id,"retained");
});
