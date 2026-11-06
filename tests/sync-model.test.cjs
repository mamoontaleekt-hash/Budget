const test = require("node:test");
const assert = require("node:assert/strict");
const Sync = require("../sync-model.js");
const empty = () => ({version:1,categories:[{id:"family",type:"expense",name:"عائلة"}],transactions:[],budgets:{}});
const tx = (id, amount=100) => ({id,type:"expense",date:"2026-11-05",categoryId:"family",amount,note:""});
const copy = data => JSON.parse(JSON.stringify(data));
const change = (base, actor, fn) => { const next = copy(base); fn(next); return Sync.recordChanges(base,next,actor); };

test("two offline devices retain every separately added transaction in either merge order", () => {
  const base = empty(), wife = change(base,"wife",s => s.transactions.push(tx("wife-day1"),tx("wife-day2"))), husband = change(base,"husband",s => s.transactions.push(tx("husband")));
  const merged = Sync.merge(wife,husband);
  assert.deepEqual(merged.transactions.map(t=>t.id).sort(),["husband","wife-day1","wife-day2"]);
  assert.ok(Sync.equivalent(merged,Sync.merge(husband,wife)));
  assert.equal(Sync.conflicts(merged).length,0);
});
test("concurrent changes to the same transaction preserve both alternatives and converge after resolution", () => {
  const base = change(empty(),"seed",s=>s.transactions.push(tx("same")));
  const a=change(base,"a",s=>s.transactions[0].amount=200), b=change(base,"b",s=>s.transactions[0].amount=300);
  const merged=Sync.merge(a,b), [[id,conflict]]=Sync.conflicts(merged);
  assert.equal(Sync.conflicts(merged).length,1);
  assert.deepEqual(conflict.alternatives.map(x=>x.value.amount).sort(),[200,300]);
  const resolved=Sync.resolveConflict(merged,id,0,"reviewer");
  const replay=Sync.merge(b,Sync.merge(a,resolved));
  assert.equal(Sync.conflicts(replay).length,0);
  assert.equal(replay.transactions[0].amount,conflict.alternatives[0].value.amount);
});
test("causally later edits are not mislabeled conflicts",()=>{
  const a=change(empty(),"a",s=>s.transactions.push(tx("one")));
  const b=change(Sync.merge(empty(),a),"b",s=>s.transactions[0].amount=400);
  const merged=Sync.merge(a,b);
  assert.equal(merged.transactions[0].amount,400); assert.equal(Sync.conflicts(merged).length,0);
});
test("hard deletions and removed optional settings do not return from stale devices",()=>{
  const base=change(empty(),"a",s=>{s.transactions.push(tx("gone"));s.budgets["2026-11"]={items:{family:{amount:100}}};s.expenseSettings={transactionClasses:{gone:"exceptional"}};});
  const removed=change(base,"b",s=>{s.transactions=[];delete s.budgets["2026-11"].items.family;delete s.expenseSettings;});
  const merged=Sync.merge(removed,base);
  assert.equal(merged.transactions.length,0); assert.deepEqual(merged.budgets,{});assert.equal(merged.expenseSettings,undefined);
});
test("soft delete versus concurrent edit retains recoverable conflict",()=>{
  const base=change(empty(),"a",s=>s.transactions.push(tx("one")));
  const deleted=change(base,"b",s=>s.transactions[0].deletedAt="2026-11-05"), edited=change(base,"c",s=>s.transactions[0].amount=800);
  assert.equal(Sync.conflicts(Sync.merge(deleted,edited)).length,1);
});
test("budget categories, metadata assignments and planned purchases merge independently",()=>{
  const base=empty();
  const a=change(base,"a",s=>{s.budgets={"2027-01":{items:{room:{amount:500000}}}};s.plannedPurchases={room:{id:"room",title:"غرفة غيث",amount:500000,month:"2027-01"}};s.tagSettings={transactionTags:{one:["family"]}};});
  const b=change(base,"b",s=>{s.budgets={"2027-01":{items:{rent:{amount:1000000}}}};s.plannedPurchases={school:{id:"school",title:"مدرسة",amount:100000,month:"2027-09"}};});
  const merged=Sync.merge(a,b);
  assert.equal(Object.keys(merged.plannedPurchases).length,2);assert.equal(Object.keys(merged.budgets["2027-01"].items).length,2);assert.deepEqual(merged.tagSettings.transactionTags.one,["family"]);
});
test("migration preserves unknown legacy records and flags conflicting legacy values",()=>{
  const a=empty(),b=empty();a.transactions=[tx("wife"),tx("same",1)];b.transactions=[tx("husband"),tx("same",2)];
  const merged=Sync.merge(a,b);assert.equal(merged.transactions.length,3);assert.equal(Sync.conflicts(merged).length,1);
});
test("merge is idempotent and does not mutate either input",()=>{
  const a=change(empty(),"a",s=>s.transactions.push(tx("a"))),b=change(empty(),"b",s=>s.transactions.push(tx("b")));
  const aa=copy(a),bb=copy(b),merged=Sync.merge(a,b);
  assert.deepEqual(a,aa);assert.deepEqual(b,bb);assert.ok(Sync.equivalent(merged,Sync.merge(merged,merged)));
});
test("long conflicting notes produce bounded Firestore field names",()=>{
  const a=change(empty(),"a",s=>s.transactions.push({...tx("same"),note:"أ".repeat(5000)})),b=change(empty(),"b",s=>s.transactions.push(tx("same")));
  const [[id]]=Sync.conflicts(Sync.merge(a,b));assert.equal(id.length,32);
});
test("a higher observed logical clock wins even with device wall clocks skewed",()=>{
  let a=change(empty(),"a",s=>s.transactions.push(tx("one")));
  for(let i=0;i<10;i++)a=change(a,"a",s=>s.transactions[0].amount+=1);
  const b=change(Sync.merge(empty(),a),"b",s=>s.transactions[0].amount=999);
  assert.equal(Sync.merge(a,b).transactions[0].amount,999);
});
test("equivalence ignores object property order and preserves array order",()=>{
  assert.equal(Sync.equivalent({a:[{id:"one",amount:100}],b:{x:1,y:2}},{b:{y:2,x:1},a:[{amount:100,id:"one"}]}),true);
  assert.equal(Sync.equivalent({transactions:[{id:"a"},{id:"b"}]},{transactions:[{id:"b"},{id:"a"}]}),false);
  assert.equal(Sync.equivalent({amount:100},{amount:200}),false);
});

const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortedKeys(value[key])])) : value;
test("Firestore map ordering neither creates conflicts nor stamps a new edit",()=>{
  const base=change(empty(),'seed',s=>s.transactions.push(...Array.from({length:863},(_,i)=>tx('t'+i,i))));
  const cloud=sortedKeys(base);cloud.budgets['2026-11']={amount:100};
  const merged=Sync.merge(base,cloud);
  assert.equal(Sync.conflicts(merged).length,0);
  assert.deepEqual(merged.transactions,base.transactions.slice().sort((a,b)=>a.id.localeCompare(b.id,'en')));
  const recorded=Sync.recordChanges(base,sortedKeys(base),'reopened');
  assert.deepEqual(recorded._sync,base._sync);
});
test("1714 historic order-only conflicts are repaired without changing any ledger field or dropping alternatives",()=>{
  const data=change(empty(),'seed',s=>s.transactions.push(...Array.from({length:863},(_,i)=>tx('t'+i,i))));
  for(let i=0;i<1714;i++){
    const value=data.transactions[i%857];
    data._sync.conflicts['old-'+i]={path:['transactions',value.id],alternatives:[{stamp:{n:1,actor:'seed'},deleted:false,value:copy(value)},{stamp:{n:1,actor:'seed'},deleted:false,value:sortedKeys(value)}]};
  }
  const before=copy(data),fixed=Sync.merge(data,sortedKeys(data));
  assert.deepEqual(fixed.transactions,data.transactions);assert.deepEqual(fixed.categories,data.categories);
  assert.deepEqual(fixed.budgets,data.budgets);assert.deepEqual(fixed._sync.revisions,data._sync.revisions);
  assert.equal(Object.keys(fixed._sync.conflicts).length,1714);assert.equal(Sync.conflicts(fixed).length,0);
  for(const [id,c] of Object.entries(fixed._sync.conflicts))assert.deepEqual(c.alternatives,before._sync.conflicts[id].alternatives);
  assert.equal(Sync.conflicts(Sync.merge(fixed,before)).length,0);assert.deepEqual(data,before);
});
test("real conflict identity and winning value are stable across property ordering",()=>{
  const base=change(empty(),'seed',s=>s.transactions.push(tx('same')));
  const a=change(base,'a',s=>s.transactions[0].amount=200),b=change(base,'b',s=>s.transactions[0].amount=300);
  assert.ok(Sync.equivalent(Sync.merge(a,b),Sync.merge(sortedKeys(b),sortedKeys(a))));
});
test("bulk first choice resolves each record once, preserves unrelated fields and retains all alternatives",()=>{
  const base=change(empty(),'seed',s=>s.transactions.push(tx('one'),tx('two'),tx('untouched')));
  const a=change(base,'a',s=>{s.transactions[0].amount=200;s.transactions[1].amount=400;});
  const b=change(base,'b',s=>{s.transactions[0].amount=300;s.transactions[1].amount=500;});
  const merged=Sync.merge(a,b),original=copy(merged);
  const entries=Sync.conflicts(merged);
  merged._sync.conflicts.alias=sortedKeys(entries[0][1]);
  assert.equal(Sync.conflicts(merged).length,2);
  const fixed=Sync.resolveAllFirst(merged,'reviewer');
  for(const [,c] of entries)assert.deepEqual(fixed.transactions.find(t=>t.id===c.path[1]),c.alternatives[0].value);
  assert.equal(fixed.transactions.length,3);assert.equal(Sync.conflicts(fixed).length,0);
  assert.deepEqual(fixed.transactions.find(t=>t.id==='untouched'),original.transactions.find(t=>t.id==='untouched'));
  for(const [id,c] of Object.entries(merged._sync.conflicts))assert.deepEqual(fixed._sync.conflicts[id].alternatives,c.alternatives);
  // A stale client can reintroduce a different old conflict ID. Its decision is covered.
  const stale=copy(b);stale._sync.conflicts['late-old-id']=sortedKeys(entries[0][1]);
  const replay=Sync.merge(stale,Sync.merge(a,fixed));
  assert.equal(Sync.conflicts(replay).length,0);assert.deepEqual(replay.transactions,fixed.transactions);
  const edit1=change(fixed,'new-a',s=>s.transactions[0].amount=700),edit2=change(fixed,'new-b',s=>s.transactions[0].amount=900);
  assert.equal(Sync.conflicts(Sync.merge(edit1,edit2)).length,1,'Future genuine conflicts must remain visible');
});
test("bulk first choice never deletes or soft-deletes a record",()=>{
  const data=change(empty(),'seed',s=>s.transactions.push(tx('one'),tx('two')));
  data._sync.conflicts.hard={path:['transactions','one'],alternatives:[{stamp:{n:1,actor:'a'},deleted:true},{stamp:{n:1,actor:'b'},deleted:false,value:tx('one')}]};
  data._sync.conflicts.soft={path:['transactions','two'],alternatives:[{stamp:{n:1,actor:'a'},deleted:false,value:{...tx('two'),deletedAt:'2026-11-06'}},{stamp:{n:1,actor:'b'},deleted:false,value:tx('two')}]};
  const result=Sync.resolveAllFirst(data,'reviewer');
  assert.deepEqual(result.transactions,data.transactions);assert.equal(Sync.conflicts(result).length,2);
});
