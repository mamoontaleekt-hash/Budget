import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9355;
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
    const job = pending.get(message.id); if(!job) return; pending.delete(message.id);
    if(message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result || {}); return;
  }
  const queue = waiters.get(message.method); if(queue?.length) queue.shift()(message.params || {});
  if(message.method === "Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Runtime exception");
  if(message.method === "Log.entryAdded" && message.params?.entry?.level === "error") errors.push(`${message.params.entry.text}${message.params.entry.url ? ` (${message.params.entry.url})` : ""}`);
});
function send(method, params={}){
  const id = ++nextId;
  return new Promise((resolveSend, reject) => { pending.set(id,{resolve:resolveSend,reject}); socket.send(JSON.stringify({id,method,params})); });
}
function waitEvent(method, timeout=20000){
  return new Promise((resolveEvent, reject) => {
    const timer=setTimeout(()=>reject(new Error(`Timeout: ${method}`)),timeout); const queue=waiters.get(method)||[];
    queue.push(params=>{clearTimeout(timer);resolveEvent(params);}); waiters.set(method,queue);
  });
}
async function evaluate(expression){
  const response=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});
  if(response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed");
  return response.result?.value;
}
async function navigate(){ const loaded=waitEvent("Page.loadEventFired"); await send("Page.navigate",{url:appUrl}); await loaded; await delay(1000); }
async function controlledReload(){ const loaded=waitEvent("Page.loadEventFired"); await send("Page.reload",{ignoreCache:false}); await loaded; await delay(700); }
const scenario={
  version:1,
  categories:[{id:"in_salary",type:"income",name:"راتب"},{id:"ex_grocery",type:"expense",name:"سوبرماركت"},{id:"ex_misc",type:"expense",name:"متفرقات"}],
  transactions:[
    {id:"existing",type:"expense",categoryId:"ex_misc",amount:100000,date:"2026-08-06",note:"عملية بلا وسم",createdAt:"2026-08-06T09:00:00.000Z"},
    {id:"income",type:"income",categoryId:"in_salary",amount:500000,date:"2026-08-01",note:"راتب",createdAt:"2026-08-01T09:00:00.000Z"},
  ], budgets:{},
};
const expectedFirebaseError=value=>String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

try{
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Network.enable"),send("Log.enable")]);
  await navigate();
  await evaluate(`localStorage.setItem('pfm_data_v1', ${JSON.stringify(JSON.stringify(scenario))})`);
  await evaluate(`navigator.serviceWorker.ready`);
  await controlledReload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-08'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs .tab[data-tab="tx"]').click(); })()`);
  assert.equal(await evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('pfm_data_v1')),'tagSettings')`),false);
  await evaluate(`document.querySelector('#btnTags').click()`);
  for(const name of ["سفر","عمل","طارئ"]){
    await evaluate(`(() => { document.querySelector('#newTagName').value=${JSON.stringify(name)}; document.querySelector('#btnCreateTag').click(); })()`);
  }
  let tags=await evaluate(`PFMTagModel.getTagDefinitions(JSON.parse(localStorage.getItem('pfm_data_v1')))`);
  assert.equal(tags.length,3);
  const travel=tags.find(tag=>tag.name==="سفر").id;
  const work=tags.find(tag=>tag.name==="عمل").id;
  const emergency=tags.find(tag=>tag.name==="طارئ").id;
  await evaluate(`window.prompt=()=>"عمل رسمي"; document.querySelector('[data-rename-tag="${work}"]').click()`);
  assert.equal(await evaluate(`PFMTagModel.getTag(JSON.parse(localStorage.getItem('pfm_data_v1')),${JSON.stringify(work)}).name`),"عمل رسمي");
  await evaluate(`document.querySelector('[data-archive-tag="${emergency}"]').click()`);
  assert.equal(await evaluate(`PFMTagModel.getTag(JSON.parse(localStorage.getItem('pfm_data_v1')),${JSON.stringify(emergency)}).status`),"archived");
  await evaluate(`document.querySelector('[data-restore-tag="${emergency}"]').click()`);
  assert.equal(await evaluate(`PFMTagModel.getTag(JSON.parse(localStorage.getItem('pfm_data_v1')),${JSON.stringify(emergency)}).status`),"active");
  await evaluate(`document.querySelector('#modalTags [data-close]').click(); document.querySelector('#btnAddTx2').click()`);

  await evaluate(`(() => {
    document.querySelector('#txDate').value='2026-08-10'; document.querySelector('#txAmount').value='180000'; document.querySelector('#txNote').value='فاتورة مناسبة';
    const category=document.querySelector('#txCategory'); category.value='ex_grocery'; category.dispatchEvent(new Event('change',{bubbles:true}));
    for(const id of ['meat','dairy','cleaning']) document.querySelector('[data-shopping-subcategory][value="'+id+'"]').checked=true;
    for(const id of [${JSON.stringify(travel)},${JSON.stringify(work)}]) document.querySelector('[data-transaction-tag][value="'+id+'"]').checked=true;
    document.querySelector('#btnSaveTx').click();
  })()`);
  const created=await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const t=s.transactions.find(x=>x.note==='فاتورة مناسبة'); return {id:t.id,transaction:t,shopping:s.shoppingSettings.transactionSubcategories[t.id],tags:s.tagSettings.transactionTags[t.id]}; })()`);
  assert.deepEqual(created.shopping,["meat","dairy","cleaning"]);
  assert.deepEqual(created.tags,[travel,work]);
  assert.equal(created.transaction.amount,180000);
  assert.equal(Object.hasOwn(created.transaction,"tags"),false);
  assert.equal(Object.hasOwn(created.transaction,"shoppingSubcategories"),false);
  const financialAfterCreate=await evaluate(`PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-08')`);

  await evaluate(`document.querySelector('[data-edit="${created.id}"]').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-transaction-tag]:checked')].map(input=>input.value)`),[travel,work]);
  await evaluate(`document.querySelector('#txNote').value='تعديل غير محفوظ'; document.querySelector('#btnManageTagsFromTx').click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.deepEqual(await evaluate(`({tagsOpen:document.querySelector('#modalTags').classList.contains('open'),txOpen:document.querySelector('#modalTx').classList.contains('open'),note:document.querySelector('#txNote').value})`),{tagsOpen:false,txOpen:true,note:"تعديل غير محفوظ"});
  await evaluate(`document.querySelector('#txNote').value='فاتورة مناسبة'`);
  await evaluate(`document.querySelector('#btnManageTagsFromTx').click(); document.querySelector('[data-archive-tag="${travel}"]').click(); document.querySelector('#modalTags [data-close]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-transaction-tag][value="${travel}"]').checked`),true);
  assert.ok((await evaluate(`document.querySelector('#txTagOptions').innerText`)).includes("مؤرشف"));
  await evaluate(`document.querySelector('#btnSaveTx').click()`);
  assert.ok((await evaluate(`document.querySelector('#txTableBody').innerText`)).includes("#سفر (مؤرشف)"));

  await evaluate(`(() => { const filter=document.querySelector('#filterTransactionTag'); filter.value=${JSON.stringify(travel)}; filter.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelectorAll('#txTableBody tr').length`),1);
  assert.ok((await evaluate(`document.querySelector('#txTableBody').innerText`)).includes("فاتورة مناسبة"));
  await evaluate(`document.querySelector('#btnClearFilters').click(); document.querySelector('[data-edit="${created.id}"]').click(); document.querySelectorAll('[data-transaction-tag]').forEach(input=>input.checked=false); document.querySelector('#btnSaveTx').click()`);
  assert.equal(await evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('pfm_data_v1')).tagSettings.transactionTags||{},${JSON.stringify(created.id)})`),false);

  await evaluate(`document.querySelector('#btnTags').click(); document.querySelector('[data-restore-tag="${travel}"]').click(); document.querySelector('#modalTags [data-close]').click(); document.querySelector('[data-edit="${created.id}"]').click(); document.querySelector('[data-transaction-tag][value="${travel}"]').checked=true; document.querySelector('#btnSaveTx').click()`);
  await evaluate(`document.querySelector('[data-edit="income"]').click(); document.querySelector('[data-transaction-tag][value="${work}"]').checked=true; document.querySelector('#btnSaveTx').click()`);
  const analytics=await evaluate(`PFMTagModel.calculateTagAnalytics(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-08')`);
  assert.equal(analytics.taggedTransactionCount,2);
  assert.equal(analytics.untaggedTransactionCount,1);
  assert.equal(analytics.countByTag[travel],1);
  assert.equal(analytics.countByTag[work],1);
  assert.equal(Object.hasOwn(analytics,"amountByTag"),false);
  const financialAfter=await evaluate(`PFMFinancialModel.calculateMonthFinancials(JSON.parse(localStorage.getItem('pfm_data_v1')),'2026-08')`);
  assert.deepEqual(financialAfter,financialAfterCreate);

  await evaluate(`document.querySelector('#tabs .tab[data-tab="settings"]').click()`);
  const summary=await evaluate(`document.querySelector('#tagAnalyticsSummary').innerText`);
  assert.ok(summary.includes("عمليات موسومة: 2")); assert.ok(summary.includes("غير موسومة: 1")); assert.ok(summary.includes("سفر — 1 عمليات"));

  const viewports={};
  for(const width of [390,768,1200]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('#tabs .tab[data-tab="tx"]').click(); document.querySelector('[data-edit="${created.id}"]').click()`);
    viewports[width]=await evaluate(`({modal:document.querySelector('#modalTx .dialog').getBoundingClientRect().width,tags:document.querySelector('#txTagOptions').getBoundingClientRect().width,viewport:innerWidth,scroll:document.documentElement.scrollWidth})`);
    assert.ok(viewports[width].modal>0 && viewports[width].modal<=viewports[width].viewport); assert.ok(viewports[width].tags>0);
    await evaluate(`document.querySelector('#modalTx [data-close]').click()`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`document.querySelector('#btnExport').click()`);
  const roundtrip=await evaluate(`(() => { const exported=document.querySelector('#exportText').value; const expected=JSON.parse(exported).tagSettings; document.querySelector('#modalExport [data-close]').click(); window.confirm=()=>true; document.querySelector('#importText').value=exported; document.querySelector('#btnDoImport').click(); const restored=JSON.parse(localStorage.getItem('pfm_data_v1')); return JSON.stringify(restored.tagSettings)===JSON.stringify(expected) && !restored.transactions.some(t=>Object.hasOwn(t,'tags')); })()`);
  assert.equal(roundtrip,true);

  await controlledReload();
  const pwa=await evaluate(`navigator.serviceWorker.ready.then(async registration=>({active:!!registration.active,controlled:!!navigator.serviceWorker.controller,keys:await caches.keys(),tag:!!(await caches.match('./tag-model.js?v=20260908-phase5'))}))`);
  assert.equal(pwa.active,true); assert.equal(pwa.controlled,true); assert.ok(pwa.keys.includes("pfm-pwa-v19")); assert.equal(pwa.tag,true); assert.equal(pwa.keys.includes("pfm-pwa-v10"),false);
  const errorCount=errors.length;
  await send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0}); await controlledReload();
  assert.deepEqual(await evaluate(`({heading:document.querySelector('h1')?.innerText,tag:!!window.PFMTagModel})`),{heading:"إدارة المصاريف الشخصية",tag:true});
  assert.deepEqual(errors.slice(errorCount).filter(error=>!expectedFirebaseError(error)),[]);
  await send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  assert.deepEqual(errors.filter(error=>!expectedFirebaseError(error)),[]);
  console.log(JSON.stringify({result:"PASS",created,analytics,viewports,roundtrip,pwa},null,2));
} finally {
  try{socket.close();}catch{} chrome.kill();
}
