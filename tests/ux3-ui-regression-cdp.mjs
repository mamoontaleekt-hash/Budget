import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [chromePath, profilePath, appUrl] = process.argv.slice(2);
const port = 9363;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(profilePath)}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", chunk => { stderr += chunk; });
const delay = ms => new Promise(done => setTimeout(done, ms));
async function target(){ for(let i=0;i<100;i+=1){ try{ const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()); const page=pages.find(x=>x.type==="page"); if(page) return page; }catch{} await delay(100); } throw new Error(`Chrome did not start: ${stderr}`); }
const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done,fail)=>{ socket.addEventListener("open",done,{once:true}); socket.addEventListener("error",fail,{once:true}); });
let id = 0;
const pending = new Map();
const waiters = new Map();
const errors = [];
socket.addEventListener("message", event => { const message=JSON.parse(event.data); if(message.id){ const job=pending.get(message.id); pending.delete(message.id); return message.error?job.reject(new Error(message.error.message)):job.resolve(message.result||{}); } const queue=waiters.get(message.method); if(queue?.length) queue.shift()(message.params||{}); if(message.method==="Runtime.exceptionThrown") errors.push(message.params?.exceptionDetails?.exception?.description||message.params?.exceptionDetails?.text); if(message.method==="Log.entryAdded"&&message.params?.entry?.level==="error") errors.push(`${message.params.entry.text}${message.params.entry.url?` (${message.params.entry.url})`:""}`); });
const send = (method,params={}) => new Promise((done,fail)=>{ const next=++id; pending.set(next,{resolve:done,reject:fail}); socket.send(JSON.stringify({id:next,method,params})); });
const waitEvent = (method,timeout=20000) => new Promise((done,fail)=>{ const timer=setTimeout(()=>fail(new Error(`Timeout: ${method}`)),timeout); const queue=waiters.get(method)||[]; queue.push(params=>{clearTimeout(timer);done(params);}); waiters.set(method,queue); });
async function evaluate(expression){ const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true}); if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text); return result.result?.value; }
async function reload(wait=700){ const loaded=waitEvent("Page.loadEventFired"); await send("Page.reload",{ignoreCache:false}); await loaded; await delay(wait); }
const expectedFirebaseError = value => String(value).includes("www.gstatic.com/firebasejs/10.13.0/") && /Failed to load resource|ERR_/i.test(String(value));

const longText = "ملاحظة عربية طويلة جداً لاختبار التفاف النص داخل بطاقة العملية على الهاتف من دون أي تمرير أفقي غير مقصود";
const scenario = {
  version: 1,
  categories: [
    { id:"in_salary", type:"income", name:"الراتب" },
    { id:"ex_grocery", type:"expense", name:"مشتريات منزلية وعائلية ذات اسم عربي طويل جداً" },
    { id:"ex_rent", type:"expense", name:"الإيجار" },
    { id:"ex_debt", type:"expense", name:"دين / سداد" },
  ],
  transactions: [
    { id:"income-1", date:"2026-09-02", type:"income", amount:3000000, categoryId:"in_salary", note:"راتب" },
    { id:"grocery-1", date:"2026-09-08", type:"expense", amount:2500000, categoryId:"ex_grocery", note:longText },
    { id:"rent-1", date:"2026-09-06", type:"expense", amount:500000, categoryId:"ex_rent", note:"إيجار" },
    { id:"debt-1", date:"2026-09-04", type:"expense", amount:200000, categoryId:"ex_debt", note:"قسط" },
  ],
  budgets: {},
  expenseSettings: { transactionClasses: { "rent-1":"exceptional" } },
  shoppingSettings: { transactionSubcategories: { "grocery-1":["pantry","cleaning"] } },
  tagSettings: { definitions:{"tag-long":{id:"tag-long",name:"وسم عائلي طويل للاختبار",status:"active"},"tag-two":{id:"tag-two",name:"شهري",status:"active"}}, transactionTags:{"grocery-1":["tag-long","tag-two"]} },
  debtSettings: { obligations:{ loan:{id:"loan",name:"قسط المنزل",type:"house",totalAmount:1000000,paidBeforeTracking:0,startDate:"2026-01-01",scheduleMode:"fixed",installmentAmount:200000,frequency:"monthly",firstDueDate:"2026-09-04",status:"active"} }, paymentLinks:{"debt-1":"loan"} },
};
const performanceScenario = {
  ...scenario,
  transactions: Array.from({length:200},(_,index)=>({id:`perf-${index}`,date:`2026-09-${String((index%28)+1).padStart(2,"0")}`,type:index%4===0?"income":"expense",amount:(index+1)*1000,categoryId:index%4===0?"in_salary":"ex_rent",note:`عملية اختبار ${index}`})),
  expenseSettings: {}, shoppingSettings: {}, tagSettings: {}, debtSettings: {},
};

try {
  await Promise.all([send("Page.enable"),send("Runtime.enable"),send("Network.enable"),send("Log.enable")]);
  let loaded=waitEvent("Page.loadEventFired"); await send("Page.navigate",{url:appUrl}); await loaded; await delay(900);
  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(scenario))})`);
  await reload();
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs [data-tab="tx"]').click(); })()`);
  await delay(200);

  const styles = await evaluate(`[...document.styleSheets].map(x=>x.href).filter(Boolean)`);
  assert.ok(styles.some(href=>href.endsWith("/interaction-polish.css?v=20260909-ux3")));
  assert.ok(styles.findIndex(href=>href.includes("visual-polish")) < styles.findIndex(href=>href.includes("mobile-enhancements")));
  assert.ok(styles.findIndex(href=>href.includes("mobile-enhancements")) < styles.findIndex(href=>href.includes("interaction-polish")));

  const labels = await evaluate(`['filterSearch','filterType','filterCategory','filterExpenseClass','filterShoppingSubcategory','filterTransactionTag','filterFrom','filterTo','filterMin','filterMax','txType','txDate','txCategory','txAmount','txNote','txExpenseClass'].every(id=>document.querySelectorAll('#'+id).length===1&&!!document.querySelector('label[for="'+id+'"]'))`);
  assert.equal(labels,true);

  const layout = {};
  for(const width of [360,390,430,768,1200]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:width<=430}); await delay(80);
    layout[width]=await evaluate(`(() => { const table=document.querySelector('.tx-table-wrap'); const cards=document.querySelector('#txMobileList'); return {table:getComputedStyle(table).display,cards:getComputedStyle(cards).display,rows:document.querySelectorAll('#txTableBody tr[data-tx-id]').length,cardCount:document.querySelectorAll('#txMobileList [data-tx-id]').length,rowIds:[...document.querySelectorAll('#txTableBody tr[data-tx-id]')].map(x=>x.dataset.txId),cardIds:[...document.querySelectorAll('#txMobileList [data-tx-id]')].map(x=>x.dataset.txId),count:document.querySelector('#txCount').textContent,doc:document.documentElement.scrollWidth,viewport:innerWidth}; })()`);
    assert.equal(layout[width].rows,4); assert.equal(layout[width].cardCount,4); assert.deepEqual(layout[width].rowIds,layout[width].cardIds); assert.equal(layout[width].count,"4 عملية"); assert.ok(layout[width].doc<=layout[width].viewport+1,JSON.stringify(layout[width]));
    if(width<=430){ assert.equal(layout[width].table,"none"); assert.notEqual(layout[width].cards,"none"); }
    else { assert.notEqual(layout[width].table,"none"); assert.equal(layout[width].cards,"none"); }
  }

  await send("Emulation.setDeviceMetricsOverride",{width:390,height:780,deviceScaleFactor:1,mobile:true});
  const mobileContent=await evaluate(`(() => { const card=document.querySelector('#txMobileList [data-tx-id="grocery-1"]'); return {text:card.innerText,amount:card.querySelector('.tx-card-amount').innerText,overflow:card.scrollWidth<=card.clientWidth+1}; })()`);
  assert.match(mobileContent.text,/مصروف/); assert.match(mobileContent.text,/2026-09-08/); assert.match(mobileContent.text,/مشتريات منزلية/); assert.match(mobileContent.text,/وسم عائلي/); assert.match(mobileContent.text,/مواد جافة|منظفات/); assert.match(mobileContent.amount,/2|٢/); assert.equal(mobileContent.overflow,true);

  await evaluate(`(() => { const field=document.querySelector('#filterMin'); field.value='400000'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const advanced=await evaluate(`({open:document.querySelector('#txAdvancedFilters').open,count:document.querySelector('#txAdvancedFilterCount').textContent,rows:[...document.querySelectorAll('#txTableBody tr[data-tx-id]')].map(x=>x.dataset.txId),cards:[...document.querySelectorAll('#txMobileList [data-tx-id]')].map(x=>x.dataset.txId),txCount:document.querySelector('#txCount').textContent})`);
  assert.equal(advanced.open,true); assert.equal(advanced.count,"1 فلاتر مفعلة"); assert.deepEqual(advanced.rows,advanced.cards); assert.deepEqual(advanced.rows,["grocery-1","rent-1","income-1"]); assert.equal(advanced.txCount,"3 عملية");

  await evaluate(`(() => { const field=document.querySelector('#filterSearch'); field.value='لا تطابق'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.match(await evaluate(`document.querySelector('#txEmptyState').innerText`),/لا توجد نتائج تطابق الفلاتر الحالية/);
  await evaluate(`document.querySelector('#txEmptyState [data-clear-tx-filters]').click()`);
  assert.equal(await evaluate(`document.querySelector('#txCount').textContent`),"4 عملية");
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-10'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.match(await evaluate(`document.querySelector('#txEmptyState').innerText`),/لا توجد عمليات في هذا الشهر/);
  await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);

  await evaluate(`document.querySelector('#txMobileList [data-tx-id="grocery-1"] [data-edit]').click()`);
  const editOpen=await evaluate(`({open:document.querySelector('#modalTx').classList.contains('open'),date:document.querySelector('#txDate').value,hint:getComputedStyle(document.querySelector('#txEditingHint')).display,debtHidden:document.querySelector('#txDebtLinkInfo').hidden})`);
  assert.equal(editOpen.open,true); assert.equal(editOpen.date,"2026-09-08"); assert.notEqual(editOpen.hint,"none"); assert.equal(editOpen.debtHidden,true);
  await evaluate(`(() => { document.querySelector('#txNote').value='تم التعديل'; document.querySelector('#btnSaveTx').click(); })()`); await delay(100);
  const edited=await evaluate(`(() => { const s=JSON.parse(localStorage.getItem('pfm_data_v1')); const matches=s.transactions.filter(x=>x.id==='grocery-1'); return {count:s.transactions.length,matches:matches.length,note:matches[0].note,shopping:s.shoppingSettings.transactionSubcategories['grocery-1'],tags:s.tagSettings.transactionTags['grocery-1']}; })()`);
  assert.equal(edited.count,4); assert.equal(edited.matches,1); assert.equal(edited.note,"تم التعديل"); assert.deepEqual(edited.shopping,["pantry","cleaning"]); assert.deepEqual([...edited.tags].sort(),["tag-long","tag-two"]);

  await evaluate(`document.querySelector('#txMobileList [data-tx-id="debt-1"] [data-edit]').click()`);
  const debtLink=await evaluate(`({hidden:document.querySelector('#txDebtLinkInfo').hidden,text:document.querySelector('#txDebtLinkInfo').innerText,disabled:document.querySelector('#txExpenseClass').disabled})`);
  assert.equal(debtLink.hidden,false); assert.match(debtLink.text,/قسط المنزل/); assert.equal(debtLink.disabled,true);
  await evaluate(`document.querySelector('#modalTx [data-close]').click()`);

  const newDate=await evaluate(`(() => { document.querySelector('#btnAddTx2').click(); return document.querySelector('#txDate').value; })()`);
  assert.equal(newDate,"");
  const modalLayout=await evaluate(`(() => { const modal=document.querySelector('#modalTx'),nav=document.querySelector('#tabs'),save=document.querySelector('#btnSaveTx'); return {modalZ:+getComputedStyle(modal).zIndex,navZ:+getComputedStyle(nav).zIndex,saveBottom:save.getBoundingClientRect().bottom,height:innerHeight}; })()`);
  assert.ok(modalLayout.modalZ>modalLayout.navZ); assert.ok(modalLayout.saveBottom<=modalLayout.height);
  await evaluate(`document.querySelector('#modalTx [data-close]').click()`);

  await send("Emulation.setDeviceMetricsOverride",{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('#btnAddTx2').click()`);
  const shortDesktopModal=await evaluate(`(() => { const dialog=document.querySelector('#modalTx .dialog'),body=document.querySelector('#modalTx .bd'),footer=document.querySelector('#modalTx .ft'),rect=dialog.getBoundingClientRect(),footerRect=footer.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,height:innerHeight,bodyOverflow:getComputedStyle(body).overflowY,footerTop:footerRect.top,footerBottom:footerRect.bottom}; })()`);
  assert.ok(shortDesktopModal.top>=0); assert.ok(shortDesktopModal.bottom<=shortDesktopModal.height); assert.equal(shortDesktopModal.bodyOverflow,"auto"); assert.ok(shortDesktopModal.footerTop>=shortDesktopModal.top); assert.ok(shortDesktopModal.footerBottom<=shortDesktopModal.height);
  await evaluate(`document.querySelector('#modalTx [data-close]').click()`);
  await send("Emulation.setDeviceMetricsOverride",{width:390,height:780,deviceScaleFactor:1,mobile:true});

  const confirmCalls=await evaluate(`(() => { window.__ux3ConfirmCalls=0; window.confirm=()=>{window.__ux3ConfirmCalls+=1;return true}; document.querySelector('#txMobileList [data-tx-id="rent-1"] [data-del]').click(); return window.__ux3ConfirmCalls; })()`);
  assert.equal(confirmCalls,1);
  const deleted=await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1')).transactions.find(x=>x.id==='rent-1')`);
  assert.ok(deleted.deletedAt); assert.equal(deleted.deletedReason,"user-delete");

  const persisted=await evaluate(`JSON.parse(localStorage.getItem('pfm_data_v1'))`);
  for(const key of ["transactionViewMode","filterPanelState","advancedFiltersOpen","mobileCardPreference","interactionSettings","ux3Settings"]) assert.equal(Object.hasOwn(persisted,key),false);

  await evaluate(`localStorage.setItem('pfm_data_v1',${JSON.stringify(JSON.stringify(performanceScenario))})`); await reload();
  const performance=await evaluate(`(() => { const picker=document.querySelector('#monthPicker'); picker.value='2026-09'; picker.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#tabs [data-tab="tx"]').click(); const start=performance.now(); const search=document.querySelector('#filterSearch'); for(let i=0;i<20;i+=1){ search.value=i%2?'عملية':''; search.dispatchEvent(new Event('input',{bubbles:true})); } return {duration:performance.now()-start,rows:document.querySelectorAll('#txTableBody tr[data-tx-id]').length,cards:document.querySelectorAll('#txMobileList [data-tx-id]').length,count:document.querySelector('#txCount').textContent}; })()`);
  assert.equal(performance.rows,200); assert.equal(performance.cards,200); assert.equal(performance.count,"200 عملية"); assert.ok(performance.duration<2000,JSON.stringify(performance));

  const pwa=await evaluate(`navigator.serviceWorker.ready.then(async()=>({controller:!!navigator.serviceWorker.controller,keys:await caches.keys(),ux3:!!(await caches.match('./interaction-polish.css?v=20260909-ux3')),ux2:!!(await caches.match('./visual-polish.css?v=20260909-ux2')),ux1:!!(await caches.match('./mobile-enhancements.css?v=20260908-ux1'))}))`);
  assert.ok(pwa.keys.includes("pfm-pwa-v18")); assert.equal(pwa.ux3,true); assert.equal(pwa.ux2,true); assert.equal(pwa.ux1,true);
  if(!pwa.controller) await reload();
  await send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0,connectionType:"none"}); await reload();
  await evaluate(`document.querySelector('#tabs [data-tab="tx"]').click()`);
  assert.equal(await evaluate(`[...document.styleSheets].some(x=>x.href?.endsWith('/interaction-polish.css?v=20260909-ux3'))`),true);
  assert.ok(await evaluate(`document.querySelectorAll('#txMobileList .tx-mobile-card').length>0`));
  await evaluate(`document.querySelector('#btnAddTx2').click()`);
  assert.equal(await evaluate(`document.querySelector('#modalTx').classList.contains('open')`),true);
  await send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"wifi"});

  assert.deepEqual(errors.filter(error=>!expectedFirebaseError(error)),[]);
  console.log(JSON.stringify({result:"PASS",layout,advanced,mobileContent,edited,debtLink,modalLayout,shortDesktopModal,performance,pwa},null,2));
} finally {
  try{socket.close();}catch{}
  chrome.kill();
}
