const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const Storage=require("../cloud-storage.js"),Sync=require("../sync-model.js");
const base=()=>({version:1,categories:[{id:"family",type:"expense",name:"عائلة"}],transactions:[],budgets:{}});
function largeData(){
  const data=base();
  data.transactions=Array.from({length:863},(_,index)=>({id:"transaction-"+index,type:"expense",amount:1000+index,date:"2026-11-05",categoryId:"family",note:"تفاصيل المشتريات العائلية والحساب الشهري ".repeat(30)}));
  return Sync.recordChanges(base(),data,"large-device");
}
test("863 records larger than the reported 1.3 MB roundtrip below the Firestore document limit",async()=>{
  const data=largeData();assert.ok(Buffer.byteLength(JSON.stringify(data))>1318063);
  const packed=await Storage.pack(data);
  assert.equal(packed.documents.length,0);
  assert.ok(Buffer.byteLength(JSON.stringify({data:packed.manifest}))<1048576);
  assert.deepEqual(await Storage.unpack(packed.manifest),data);
});
test("incompressible data is split into bounded independent documents and verified as a whole",async()=>{
  const data=base();data.transactions=[{id:"large",note:crypto.randomBytes(950000).toString("base64")}];
  const packed=await Storage.pack(data);assert.ok(packed.documents.length>1);
  for(const doc of packed.documents)assert.ok(Buffer.byteLength(JSON.stringify(doc.data))<200000);
  const parts=new Map(packed.documents.map(doc=>[doc.id,doc.data]));
  assert.deepEqual(await Storage.unpack(packed.manifest,async id=>parts.get(id)),data);
  parts.delete(packed.documents[0].id);
  await assert.rejects(()=>Storage.unpack(packed.manifest,async id=>parts.get(id)),{code:"data-loss"});
});
test("rejects corrupted compressed content and checksum mismatches",async()=>{
  const packed=await Storage.pack(base());
  await assert.rejects(()=>Storage.unpack({...packed.manifest,sha256:"0".repeat(64)}),{code:"data-loss"});
  await assert.rejects(()=>Storage.unpack({...packed.manifest,parts:["invalid"]}),{code:"data-loss"});
});
test("legacy cloud data remains readable without migration or data loss",async()=>{
  const data=base();assert.equal(await Storage.unpack(data),data);
});
test("does not fetch arbitrary chunk paths from an invalid manifest",async()=>{
  const packed=await Storage.pack(base(),0);let reads=0;
  await assert.rejects(()=>Storage.unpack({...packed.manifest,partIds:["../other-account"]},async()=>{reads++;}),{code:"data-loss"});
  assert.equal(reads,0);
});
