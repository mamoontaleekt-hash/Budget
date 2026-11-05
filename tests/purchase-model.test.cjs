const test=require("node:test"),assert=require("node:assert/strict");
const Model=require("../purchase-model.js"),Financial=require("../financial-model.js");
const empty=()=>({categories:[],transactions:[],budgets:{}});
test("a future room purchase survives JSON backup without changing actual balances",()=>{
  const state=Model.withPurchase(empty(),{title:"غرفة غيث",month:"2027-01",amount:500000,savedAmount:100000},"room");
  const roundtrip=JSON.parse(JSON.stringify(state)),summary=Model.summary(roundtrip,"2027-01","2026-11");
  assert.equal(summary.total,500000);assert.equal(summary.remaining,400000);assert.equal(summary.monthlySaving,133334);
  assert.equal(Financial.calculateMonthFinancials(state,"2027-01").totalExpenses,0);
  assert.equal(state.transactions.length,0);
});
test("postponing updates the month; cancellation and actual purchase remove outstanding totals",()=>{
  let s=Model.withPurchase(empty(),{title:"غرفة",month:"2027-01",amount:500000},"room");
  s=Model.withPurchase(s,{...s.plannedPurchases.room,month:"2027-02"},"room");
  assert.equal(Model.summary(s,"2027-01","2026-11").total,0);
  s.plannedPurchases.room.status="cancelled";assert.equal(Model.summary(s,"2027-02","2026-11").total,0);
  s.plannedPurchases.room.status="planned";s.transactions.push({id:"planned_room",type:"expense",amount:480000,date:"2027-02-02"});
  assert.equal(Model.summary(s,"2027-02","2026-11").total,0);
  s.transactions[0].deletedAt="2027-02-03";assert.equal(Model.summary(s,"2027-02","2026-11").total,500000);
});
test("rejects invalid costs, invalid month and excessive earmarked funds",()=>{
  for(const values of [{amount:Infinity,month:"2027-01"},{amount:-1,month:"2027-01"},{amount:1,month:"2027-13"},{amount:100,month:"2027-01",savedAmount:101}])assert.throws(()=>Model.withPurchase(empty(),{title:"غرفة",...values},"room"));
});
test("accepts Arabic and Persian digits, grouped amounts, and Arabic decimal separators",()=>{
  for(const amount of ["500000","500,000","٥٠٠٬٠٠٠","۵۰۰٬۰۰۰","500 000"]){
    const s=Model.withPurchase(empty(),{title:"غرفة",month:"2027-01",amount,savedAmount:"١٠٠٬٠٠٠"},"room");
    assert.equal(s.plannedPurchases.room.amount,500000);assert.equal(s.plannedPurchases.room.savedAmount,100000);
  }
  const s=Model.withPurchase(empty(),{title:"غرفة",month:"2027-01",amount:"١٢٣٫٥٠"},"room");
  assert.equal(s.plannedPurchases.room.amount,123.5);
});
test("rejects malformed numeric grouping instead of silently changing its value",()=>{
  for(const amount of ["500,5","5,00,000","خمسمائة","", "NaN"]){
    assert.throws(()=>Model.withPurchase(empty(),{title:"غرفة",month:"2027-01",amount},"room"));
  }
});
