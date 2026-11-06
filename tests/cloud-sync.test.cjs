const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const Sync=require("../sync-model.js");
const Storage=require("../cloud-storage.js");
const source=fs.readFileSync(path.join(__dirname,"../cloud-sync.js"),"utf8");
const copy=value=>JSON.parse(JSON.stringify(value));
const empty=()=>({version:1,categories:[],transactions:[],budgets:{}});
function backend(initial=empty()){
  const documents=new Map([["root",{data:initial}]]);
  return {documents,version:0,listeners:new Set(),gate:null,fail:false,writes:0,maxBytes:1048576,denyChunks:false,
    get document(){return documents.get('root');},set document(value){documents.set('root',value);},
    snapshot(path='root'){const value=documents.get(path),data=value ? copy(value) : null;return {exists:!!data,metadata:{hasPendingWrites:false,fromCache:false},data:()=>data};},
    async appData(){return Storage.unpack(this.document.data,async id=>documents.get('snapshots/'+id));},
    async transaction(fn){
      for(let attempts=0;attempts<10;attempts++){
        if(this.fail)throw Object.assign(new Error("offline"),{code:"unavailable"});
        const version=this.version,pending=new Map();
        const result=await fn({get:async ref=>this.snapshot(ref.path),set:(ref,data)=>{pending.set(ref.path,copy(data));}});
        if(this.gate){const gate=this.gate;this.gate=null;await gate;}
        if(version!==this.version)continue;
        for(const [path,data] of pending){
          if(Buffer.byteLength(JSON.stringify(data))>this.maxBytes)throw Object.assign(new Error('Document size exceeds maximum'),{code:'invalid-argument'});
          if(this.denyChunks&&path!=='root')throw Object.assign(new Error('Chunk permission denied'),{code:'permission-denied'});
        }
        if(pending.size){for(const [path,data] of pending)documents.set(path,data);this.version++;this.writes+=pending.size;for(const listener of this.listeners)listener(this.snapshot());}
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
  function reference(path){return {path,collection:()=>({doc:id=>reference('snapshots/'+id)}),get:async()=>server.snapshot(path),onSnapshot(options,fn){server.listeners.add(fn);return ()=>server.listeners.delete(fn);}};}
  const db={collection:()=>({doc:()=>reference('root')}),runTransaction:fn=>server.transaction(fn)};
  const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>"server-time"};
  const sandbox={console,Event,CustomEvent,JSON,Date,Map,Set,Promise,TextEncoder,navigator:{onLine:true},localStorage,
    document:{querySelector:getNode,addEventListener:docEvents.addEventListener.bind(docEvents)},
    addEventListener:events.addEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
    setTimeout:(fn,ms)=>{const id=++taskId;tasks.set(id,{fn,ms});return id;},clearTimeout:id=>tasks.delete(id),
    PFMSyncModel:Sync,PFMCloudStorage:Storage,PFMSyncActor:actor,PFMDisplayFormat:{westernizeDigits:String},firebase:{apps:[{}],auth:()=>auth,firestore},};
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
  assert.deepEqual((await server.appData()).transactions.map(t=>t.id).sort(),["husband","wife-week"]);
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
  assert.deepEqual((await server.appData()).transactions.map(t=>t.id).sort(),["offline-week","online"]);
});
test("edits made during an in-flight write remain pending and are uploaded next",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("first");
  let release;server.gate=new Promise(resolve=>release=resolve);
  const pending=c.api.syncNow("slow");await Promise.resolve();await Promise.resolve();c.edit("second");release();await pending;
  assert.equal(c.read().transactions.length,2);assert.equal(c.api.getState().dirty,true);
  await c.api.syncNow("next");assert.equal((await server.appData()).transactions.length,2);assert.equal(c.api.getState().dirty,false);
});
test("failed writes never report cloud success and retry without dropping saved data",async()=>{
  const server=backend(),c=client(server,"a");await c.login();c.edit("retained");server.fail=true;
  assert.equal(await c.api.syncNow("fail"),false);assert.equal(c.read().transactions.length,1);assert.match(c.status(),/لم تؤكد السحابة/);assert.ok(c.tasks.size);
  server.fail=false;await c.api.syncNow("retry");assert.equal((await server.appData()).transactions.length,1);assert.equal(c.api.getState().dirty,false);
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
test("a 1.3 MB offline journal migrates atomically and another device receives all 863 records",async()=>{
  const server=backend(),wife=client(server,"wife");
  const data=empty();data.transactions=Array.from({length:863},(_,i)=>({id:"week-"+i,amount:1000+i,type:"expense",date:"2026-11-05",note:"تفاصيل المصروفات العائلية ".repeat(40)}));
  const journal=Sync.recordChanges(empty(),data,"wife");
  assert.ok(Buffer.byteLength(JSON.stringify(journal))>1318063);
  wife.storage.set("pfm_data_v1",JSON.stringify(journal));await wife.login();
  assert.equal(wife.api.getState().lastFailure,null);
  assert.ok(Storage.isPacked(server.document.data));
  assert.equal((await server.appData()).transactions.length,863);
  const husband=client(server,"husband");await husband.login();
  assert.equal(husband.read().transactions.length,863);
  assert.ok(husband.read().transactions.some(tx=>tx.id==="week-862"));
});
test("chunk writes and manifest are atomic, and a rejected chunk leaves the local journal intact",async()=>{
  const server=backend(),c=client(server,"a"),noise=require('node:crypto').randomBytes(950000).toString('base64');
  await c.login();c.edit("large");
  const old=c.read(),next=copy(old);next.transactions[0].note=noise;
  c.storage.set("pfm_data_v1",JSON.stringify(Sync.recordChanges(old,next,"a")));
  const before=copy(server.document);server.denyChunks=true;
  assert.equal(await c.api.syncNow("rejected pieces"),false);
  assert.deepEqual(server.document,before);assert.equal(server.documents.size,1);assert.equal(c.read().transactions[0].note,noise);
  server.denyChunks=false;await c.api.syncNow("pieces");
  assert.ok(server.document.data.partIds.length>1);assert.equal((await server.appData()).transactions[0].note,noise);
  const second=client(server,"b");await second.login();assert.equal(second.read().transactions[0].note,noise);
});

function disputedState(){
  const base=empty(),a=copy(base),b=copy(base);
  a.transactions=[{id:'one',type:'expense',date:'2026-11-06',amount:100,note:'first'}];
  b.transactions=[{id:'one',type:'expense',date:'2026-11-06',amount:200,note:'second'}];
  return Sync.merge(Sync.recordChanges(base,a,'a'),Sync.recordChanges(base,b,'b'));
}
test("bulk adoption saves a durable lossless backup before syncing the first versions to both devices",async()=>{
  const initial=disputedState(),server=backend(initial),c=client(server,'reviewer');
  await c.login();const before=c.read(),first=Sync.conflicts(before)[0][1].alternatives[0].value;
  assert.equal(await c.api.adoptFirstVersions(),true);
  const key=c.storage.get('pfm_conflict_backup_latest_v1'),backup=JSON.parse(c.storage.get(key));
  const parts=new Map(backup.documents.map(p=>[p.id,p.data]));
  assert.deepEqual(await Storage.unpack(backup.manifest,async id=>parts.get(id)),before);
  assert.deepEqual(c.read().transactions,[first]);
  await c.api.syncNow('publish choice');server.listeners.clear();
  const stale=copy(initial);stale._sync.conflicts.alias=copy(Sync.conflicts(initial)[0][1]);
  const other=client(server,'stale-device',new Map([['pfm_data_v1',JSON.stringify(stale)]]));
  await other.login();
  assert.deepEqual(other.read().transactions,[first]);assert.equal(Sync.conflicts(other.read()).length,0);
  assert.deepEqual((await server.appData()).transactions,[first]);
  assert.equal(Sync.conflicts(await server.appData()).length,0);
});
test("failed recovery-backup writes abort bulk adoption without changing any data",async()=>{
  const server=backend(disputedState()),c=client(server,'a');await c.login();
  const before=copy(c.read()),remote=copy(server.document),original=c.sandbox.localStorage.setItem;
  c.sandbox.localStorage.setItem=(key,value)=>{if(key.startsWith('pfm_conflict_backup_v1:'))throw new Error('QuotaExceededError');original(key,value);};
  assert.equal(await c.api.adoptFirstVersions(),false);
  assert.deepEqual(c.read(),before);assert.deepEqual(server.document,remote);
});
test("edits during asynchronous backup are never overwritten by stale bulk selection",async()=>{
  const server=backend(disputedState()),c=client(server,'a');await c.login();
  const pending=c.api.adoptFirstVersions();c.edit('made-during-backup',321);
  assert.equal(await pending,false);assert.equal(c.read().transactions.length,2);
  assert.equal(Sync.conflicts(c.read()).length,1);
  assert.equal(await c.api.adoptFirstVersions(),true);assert.equal(c.read().transactions.length,2);
  await c.api.syncNow('settle');assert.equal((await server.appData()).transactions.length,2);
});
