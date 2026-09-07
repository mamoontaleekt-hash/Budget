import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9352;
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank",
], { stdio:["ignore","pipe","pipe"] });
let stderr = "";
chrome.stderr.on("data", chunk => { stderr += chunk.toString(); });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function findTarget(){
  for(let attempt=0; attempt<80; attempt+=1){
    try{
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      const page = targets.find(candidate => candidate.type === "page");
      if(page) return page;
    }catch{}
    await delay(100);
  }
  throw new Error(`Chrome did not start: ${stderr}`);
}

const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener("open", resolveOpen, { once:true });
  socket.addEventListener("error", reject, { once:true });
});
let nextId = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if(message.id){
    const job = pending.get(message.id);
    if(!job) return;
    pending.delete(message.id);
    if(message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result || {});
    return;
  }
  const queue = waiters.get(message.method);
  if(queue?.length) queue.shift()(message.params || {});
  if(message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Runtime exception");
  if(message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(message.params.entry.text);
});
function send(method, params={}){
  const id = ++nextId;
  return new Promise((resolveSend, reject) => { pending.set(id,{resolve:resolveSend,reject}); socket.send(JSON.stringify({id,method,params})); });
}
function waitEvent(method, timeout=20000){
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeout);
    const queue = waiters.get(method) || [];
    queue.push(params => { clearTimeout(timer); resolveEvent(params); });
    waiters.set(method, queue);
  });
}
async function evaluate(expression){
  const response = await send("Runtime.evaluate", { expression, awaitPromise:true, returnByValue:true, userGesture:true });
  if(response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed");
  return response.result?.value;
}
async function navigate(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", {url:appUrl});
  await loaded;
  await delay(1000);
}
async function reload(){
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.reload", {ignoreCache:true});
  await loaded;
  await delay(700);
}

const fixed = (id,name,type,total,paid,amount,first,status="active") => ({
  id,name,type,totalAmount:total,paidBeforeTracking:paid,startDate:"2026-01-01",scheduleMode:"fixed",
  installmentAmount:amount,frequency:"monthly",firstDueDate:first,status,createdAt:"2026-01-01T00:00:00.000Z",
});
const scenario = {
  version:1,
  categories:[
    {id:"in_salary",type:"income",name:"راتب"},{id:"ex_living",type:"expense",name:"معيشة"},
    {id:"ex_debt",type:"expense",name:"دين/سداد"},{id:"ex_misc",type:"expense",name:"متفرقات"},
  ],
  transactions:[
    {id:"home-pay",type:"expense",categoryId:"ex_misc",amount:300000,date:"2026-08-05",note:"دفعة منزل",createdAt:"2026-08-05T09:00:00.000Z"},
    {id:"appliance-pay",type:"expense",categoryId:"ex_debt",amount:100000,date:"2026-08-10",note:"دفعة جهاز",createdAt:"2026-08-10T09:00:00.000Z"},
    {id:"eligible-pay",type:"expense",categoryId:"ex_debt",amount:80000,date:"2026-08-12",note:"دفعة قديمة غير مربوطة",createdAt:"2026-08-12T09:00:00.000Z"},
    {id:"living",type:"expense",categoryId:"ex_living",amount:50000,date:"2026-08-13",note:"معيشة",createdAt:"2026-08-13T09:00:00.000Z"},
  ],
  budgets:{},
  expenseSettings:{transactionClasses:{"home-pay":"exceptional"}},
  debtSettings:{
    obligations:{
      home:fixed("home","دفعات المنزل","house",3000000,500000,500000,"2026-07-01"),
      car:fixed("car","دفعات السيارة","car",1200000,200000,200000,"2026-08-15","paused"),
      appliance:fixed("appliance","جهاز منزلي","appliance",600000,100000,100000,"2026-08-20"),
      personal:{id:"personal",name:"التزام شخصي",type:"personal",totalAmount:900000,paidBeforeTracking:0,startDate:"2026-04-01",scheduleMode:"irregular",manualNextDueDate:"2026-08-25",manualNextDueAmount:150000,status:"active",createdAt:"2026-04-01T00:00:00.000Z"},
    },
    paymentLinks:{"home-pay":"home","appliance-pay":"appliance"},
  },
};

try{
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Log.enable")]);
  await navigate();
  await evaluate(`localStorage.setItem('pfm_data_v1', ${JSON.stringify(JSON.stringify(scenario))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-08'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);

  const calculated = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const x=PFMDebtModel.calculateSummary(s,'2026-09-07'); return {count:x.obligations.length,active:x.activeCount,original:x.totalOriginal,paid:x.totalPaid,remaining:x.totalRemaining,homeClass:PFMExpenseModel.resolveExpenseClass(s,s.transactions.find(t=>t.id==='home-pay'))}; })()`);
  assert.deepEqual(calculated, {count:4,active:3,original:5700000,paid:1200000,remaining:4500000,homeClass:"debt_payment"});

  await evaluate(`document.querySelector('#tabs .tab[data-tab="debts"]').click()`);
  const pageState = await evaluate(`({cards:document.querySelectorAll('[data-debt-open]').length,forecastRows:document.querySelectorAll('#debtForecastBody tr').length,heading:document.querySelector('#view-debts h2').innerText,total:document.querySelector('#debtTotalRemaining').innerText})`);
  assert.equal(pageState.cards,4);
  assert.equal(pageState.forecastRows,3);
  assert.equal(pageState.heading,"الديون والأقساط");
  assert.ok(pageState.total.includes("٤٬٥٠٠٬٠٠٠"));

  await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#txTableBody').innerText.includes('دفعات المنزل')`),true);
  await evaluate(`document.querySelector('[data-edit="home-pay"]').click()`);
  const linkedEdit = await evaluate(`({disabled:document.querySelector('#txExpenseClass').disabled,visible:!document.querySelector('#txDebtLinkInfo').hidden,text:document.querySelector('#txDebtLinkInfo').innerText})`);
  assert.equal(linkedEdit.disabled,true);
  assert.equal(linkedEdit.visible,true);
  assert.ok(linkedEdit.text.includes("دفعات المنزل"));
  await evaluate(`document.querySelector('#modalTx [data-close]').click()`);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="debts"]').click(); document.querySelector('[data-debt-open="personal"]').click(); document.querySelector('[data-record-debt-payment]').click()`);
  await evaluate(`(() => { document.querySelector('#debtPaymentDate').value='2026-08-18'; document.querySelector('#debtPaymentAmount').value='150000'; document.querySelector('#btnSaveDebtPayment').click(); })()`);
  const recorded = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const added=s.transactions.filter(t=>!['home-pay','appliance-pay','eligible-pay','living'].includes(t.id)); return {count:added.length,type:added[0]?.type,category:added[0]?.categoryId,link:s.debtSettings.paymentLinks[added[0]?.id],amount:added[0]?.amount}; })()`);
  assert.deepEqual(recorded,{count:1,type:"expense",category:"ex_debt",link:"personal",amount:150000});

  await evaluate(`document.querySelector('#modalDebtDetails [data-close]').click(); document.querySelector('[data-debt-open="personal"]').click(); document.querySelector('[data-link-existing]').click(); document.querySelector('[data-link-payment="eligible-pay"]').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).debtSettings.paymentLinks['eligible-pay']`),"personal");

  await evaluate(`document.querySelector('#modalDebtDetails [data-close]').click(); document.querySelector('[data-debt-open="home"]').click(); document.querySelector('[data-unlink-payment="home-pay"]').click()`);
  const unlinked = await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const t=s.transactions.find(x=>x.id==='home-pay'); return {hasLink:Object.hasOwn(s.debtSettings.paymentLinks,'home-pay'),amount:t.amount,note:t.note,explicit:s.expenseSettings.transactionClasses['home-pay'],resolved:PFMExpenseModel.resolveExpenseClass(s,t)}; })()`);
  assert.deepEqual(unlinked,{hasLink:false,amount:300000,note:"دفعة منزل",explicit:"exceptional",resolved:"exceptional"});

  await evaluate(`document.querySelector('#modalDebtDetails [data-close]').click(); document.querySelector('[data-debt-open="car"]').click(); document.querySelector('[data-debt-status="active"]').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).debtSettings.obligations.car.status`),"active");
  await evaluate(`document.querySelector('[data-debt-status="paused"]').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).debtSettings.obligations.car.status`),"paused");

  await evaluate(`document.querySelector('#modalDebtDetails [data-close]').click(); document.querySelector('[data-debt-open="appliance"]').click(); document.querySelector('[data-edit-debt]').click(); document.querySelector('#debtName').value='جهاز المطبخ'; document.querySelector('#btnSaveDebt').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).debtSettings.obligations.appliance.name`),"جهاز المطبخ");

  const viewports = {};
  for(const width of [390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await delay(100);
    await evaluate(`document.querySelector('#tabs .tab[data-tab="debts"]').click(); document.querySelector('#btnAddDebt').click()`);
    viewports[width] = await evaluate(`({tab:document.querySelector('#view-debts').getBoundingClientRect().width>0,form:document.querySelector('#modalDebt .dialog').getBoundingClientRect().width>0,tabs:[...document.querySelectorAll('#tabs .tab')].every(x=>x.getBoundingClientRect().width>0),scroll:document.documentElement.scrollWidth,viewport:innerWidth})`);
    assert.equal(viewports[width].tab,true);
    assert.equal(viewports[width].form,true);
    assert.equal(viewports[width].tabs,true);
    assert.ok(viewports[width].scroll <= viewports[width].viewport + 2);
    await evaluate(`document.querySelector('#modalDebt [data-close]').click()`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`document.querySelector('#btnExport').click()`);
  const backupRoundTrip = await evaluate(`(() => {
    const exportedText=document.querySelector('#exportText').value;
    const exported=JSON.parse(exportedText);
    const expected=JSON.stringify(exported.debtSettings);
    document.querySelector('#modalExport [data-close]').click();
    window.confirm=()=>true;
    document.querySelector('#importText').value=exportedText;
    document.querySelector('#btnDoImport').click();
    const restored=JSON.parse(localStorage.getItem('pfm_data_v1'));
    return {exported:Boolean(exported.debtSettings),restored:JSON.stringify(restored.debtSettings)===expected,transactions:JSON.stringify(restored.transactions)===JSON.stringify(exported.transactions)};
  })()`);
  assert.deepEqual(backupRoundTrip,{exported:true,restored:true,transactions:true});

  const unexpected = errors.filter(error => !error.includes("www.gstatic.com/firebasejs/10.13.0/") && !error.includes("ERR_"));
  assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({result:"PASS",calculated,pageState,recorded,unlinked,viewports,backupRoundTrip},null,2));
} finally {
  try{ socket.close(); }catch{}
  chrome.kill();
}
