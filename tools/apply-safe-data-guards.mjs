import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    if (text.includes(to)) return text;
    throw new Error(`Missing expected block: ${label}`);
  }
  return text.replace(from, () => to);
}

function insertBefore(text, marker, insert, label) {
  if (text.includes(insert.trim())) return text;
  if (!text.includes(marker)) throw new Error(`Missing marker: ${label}`);
  return text.replace(marker, () => `${insert}${marker}`);
}

function insertAfter(text, marker, insert, label) {
  if (text.includes(insert.trim())) return text;
  if (!text.includes(marker)) throw new Error(`Missing marker: ${label}`);
  return text.replace(marker, () => `${marker}${insert}`);
}

function lineBlock(lines) {
  return `${lines.join("\n")}\n`;
}

const trashModal = `
    <div class="modal" id="modalTrash">
      <div class="dialog">
        <div class="hd">
          <div>
            <h3>سلة المحذوفات</h3>
            <div class="mini">العمليات المحذوفة لا تدخل في التقارير، ويمكن استعادتها في أي وقت.</div>
          </div>
          <button class="btn icon" data-close="#modalTrash">✖</button>
        </div>
        <div class="bd">
          <div class="help">يتم الاحتفاظ بالعمليات هنا بدل حذفها نهائياً حتى لا تضيع البيانات بسبب ضغط خاطئ.</div>
          <div class="hr"></div>
          <div style="overflow:auto">
            <table>
              <thead>
                <tr>
                  <th style="min-width:120px">التاريخ</th>
                  <th style="min-width:110px">النوع</th>
                  <th style="min-width:140px">التصنيف</th>
                  <th style="min-width:130px">المبلغ</th>
                  <th>ملاحظة</th>
                  <th style="min-width:140px">إجراء</th>
                </tr>
              </thead>
              <tbody id="trashTableBody">
                <tr><td colspan="6" class="muted">—</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="ft">
          <button class="btn" data-close="#modalTrash">إغلاق</button>
        </div>
      </div>
    </div>
`;

const safetyAndTrashFunctions = lineBlock([
  "  function createLocalSafetyBackup(reason){",
  "    const payload = {",
  "      reason,",
  "      at: new Date().toISOString(),",
  "      data: state",
  "    };",
  "    try{",
  "      localStorage.setItem(SAFETY_BACKUP_KEY, JSON.stringify(payload));",
  "      return true;",
  "    }catch(e){",
  '      console.warn("Safety backup failed", e);',
  "      return false;",
  "    }",
  "  }",
  "",
  "  function restoreLatestSafetyBackup(){",
  "    try{",
  "      const raw = localStorage.getItem(SAFETY_BACKUP_KEY);",
  '      if(!raw){ toast("لا توجد نسخة أمان محلية بعد"); return; }',
  "      const payload = JSON.parse(raw);",
  "      if(!payload || !payload.data || !payload.data.categories || !payload.data.transactions || !payload.data.budgets){",
  '        toast("نسخة الأمان غير صالحة");',
  "        return;",
  "      }",
  '      const ok = confirm("استعادة آخر نسخة أمان محلية؟ سيتم استبدال البيانات الحالية ثم مزامنتها تلقائياً إذا كنت متصلاً.");',
  "      if(!ok) return;",
  "      state = payload.data;",
  "      save();",
  "      render();",
  '      toast("تمت استعادة نسخة الأمان ✅");',
  "    }catch(e){",
  "      console.error(e);",
  '      toast("تعذر استعادة نسخة الأمان");',
  "    }",
  "  }",
  "",
  "  function deletedTransactions(){",
  "    return state.transactions",
  "      .filter(t => t.deletedAt)",
  '      .sort((a,b)=> (b.deletedAt||"").localeCompare(a.deletedAt||""));',
  "  }",
  "",
  "  function openTrashModal(){",
  "    renderTrashModal();",
  '    openModal("#modalTrash");',
  "  }",
  "",
  "  function renderTrashModal(){",
  '    const tbody = $("#trashTableBody");',
  "    const deleted = deletedTransactions();",
  "    if(deleted.length===0){",
  '      tbody.innerHTML = `<tr><td colspan="6" class="muted">سلة المحذوفات فارغة.</td></tr>`;',
  "      return;",
  "    }",
  "    tbody.innerHTML = deleted.map(t=>{",
  '      const signClass = t.type==="income" ? "pos" : "neg";',
  '      const labelType = t.type==="income" ? `<span class="pill ok">إيراد</span>` : `<span class="pill danger">مصروف</span>`;',
  "      return `<tr>",
  '        <td>${escapeHTML(t.date||"")}</td>',
  "        <td>${labelType}</td>",
  "        <td><span class=\"tag\">🏷️ ${escapeHTML(catName(t.categoryId))}</span></td>",
  "        <td class=\"money ${signClass}\">${fmtCompact(t.amount)}</td>",
  '        <td>${escapeHTML(t.note||"")}</td>',
  "        <td><button class=\"btn small\" data-restore-tx=\"${t.id}\">↩️ استعادة</button></td>",
  "      </tr>`;",
  '    }).join("");',
  '    $$("[data-restore-tx]", tbody).forEach(b => b.addEventListener("click", () => restoreTx(b.getAttribute("data-restore-tx"))));',
  "  }",
  "",
  "  function restoreTx(id){",
  "    const tx = state.transactions.find(t=>t.id===id);",
  "    if(!tx) return;",
  "    delete tx.deletedAt;",
  "    delete tx.deletedReason;",
  "    tx.restoredAt = new Date().toISOString();",
  "    save();",
  "    renderTrashModal();",
  "    render();",
  '    toast("تمت استعادة العملية ✅");',
  "  }",
  "",
  "  async function updateInstalledApp(){",
  '    const ok = confirm("سيتم تحديث كاش التطبيق وإعادة تحميل الصفحة. البيانات لن تُحذف.");',
  "    if(!ok) return;",
  "    try{",
  '      if("serviceWorker" in navigator){',
  "        const regs = await navigator.serviceWorker.getRegistrations();",
  "        await Promise.all(regs.map(r => r.update().catch(()=>{})));",
  "      }",
  "      if(window.caches){",
  "        const keys = await caches.keys();",
  '        await Promise.all(keys.filter(k => k.startsWith("pfm-pwa-")).map(k => caches.delete(k)));',
  "      }",
  '      toast("تم تحديث التطبيق، سيتم إعادة التحميل...");',
  "      setTimeout(()=> location.reload(), 500);",
  "    }catch(e){",
  "      console.error(e);",
  '      toast("تعذر تحديث الكاش، جرّب Ctrl+F5");',
  "    }",
  "  }",
  ""
]);

const importHandler = lineBlock([
  '  $("#btnDoImport").addEventListener("click", () => {',
  '    const txt = ($("#importText").value||"").trim();',
  '    if(!txt){ toast("الصق JSON أو حمّل من ملف"); return; }',
  "    try{",
  "      const parsed = JSON.parse(txt);",
  "      if(!parsed.categories || !parsed.transactions || !parsed.budgets){",
  '        toast("ملف غير صالح");',
  "        return;",
  "      }",
  "      const txCount = Array.isArray(parsed.transactions) ? parsed.transactions.length : 0;",
  "      const ok = confirm(`سيتم استبدال البيانات الحالية بملف يحتوي على ${txCount} عملية. سيتم إنشاء نسخة أمان محلية قبل الاستيراد. هل تريد المتابعة؟`);",
  "      if(!ok) return;",
  '      createLocalSafetyBackup("before-import");',
  "      state = parsed;",
  "      save();",
  '      closeModal("#modalImport");',
  '      toast("تم الاستيراد ✅");',
  "      render();",
  "    }catch(e){",
  '      toast("JSON غير صالح");',
  "    }",
  "  });",
]);

const clearAllHandler = lineBlock([
  '  $("#btnClearAll").addEventListener("click", () => {',
  '    const ok = confirm("سيتم إنشاء نسخة أمان محلية ثم مسح كل البيانات من هذا الجهاز ومزامنة ذلك إذا كنت متصلاً. هل أنت متأكد؟");',
  "    if(!ok) return;",
  '    const typed = prompt("للتأكيد اكتب كلمة: مسح");',
  '    if(typed !== "مسح"){ toast("تم إلغاء المسح"); return; }',
  '    createLocalSafetyBackup("before-clear-all");',
  "    localStorage.removeItem(STORAGE_KEY);",
  "    state = defaultData();",
  "    save();",
  '    toast("تم مسح البيانات");',
  "    render();",
  "  });",
]);

const deleteTxFunction = lineBlock([
  "  function deleteTx(id){",
  '    const ok = confirm("نقل العملية إلى سلة المحذوفات؟ يمكنك استعادتها لاحقاً من الإعدادات.");',
  "    if(!ok) return;",
  "    const tx = state.transactions.find(t=>t.id===id);",
  "    if(!tx) return;",
  "    tx.deletedAt = new Date().toISOString();",
  '    tx.deletedReason = "user-delete";',
  "    save();",
  '    toast("تم نقل العملية إلى سلة المحذوفات");',
  "    render();",
  "  }",
]);

const prepareCloudSessionFunction = lineBlock([
  "  async function prepareCloudSession(docRef){",
  "    const snap = await docRef.get();",
  "    if(!snap.exists){",
  "      const data = readLocal();",
  "      await docRef.set({",
  "        data: data || {},",
  "        createdAt: FieldValue.serverTimestamp(),",
  "        updatedAt: FieldValue.serverTimestamp(),",
  "        updatedBy: auth.currentUser.uid,",
  "        updatedByClientId: clientId,",
  "        version: 1",
  "      }, {merge:true});",
  "      lastLocalStr = localString();",
  "      dirty = false;",
  "      return { created: true, appliedRemote: false };",
  "    }",
  "    const remote = snap.data() || {};",
  "    const remoteData = remote.data || null;",
  "    if(remoteData && Object.keys(remoteData).length > 0){",
  "      const remoteStr = JSON.stringify(remoteData);",
  "      const localStr = JSON.stringify(readLocal() || {});",
  "      const remoteHash = hashStr(remoteStr);",
  "      if(remoteHash !== hashStr(localStr)){",
  "        backupLocalBeforeRemote();",
  "        lastAppliedRemoteHash = remoteHash;",
  '        window.dispatchEvent(new CustomEvent("pfm:apply", {detail: remoteData}));',
  "      }",
  "      lastLocalStr = localString();",
  "      dirty = false;",
  '      setStatus("الحالة: تم جلب بيانات السحابة قبل بدء الحفظ التلقائي ✅");',
  '      setPill("☁️ متصل", "ok");',
  "      setLast(nowClock());",
  "      return { created: false, appliedRemote: true };",
  "    }",
  "    lastLocalStr = localString();",
  "    dirty = false;",
  "    return { created: false, appliedRemote: false };",
  "  }",
]);

export function applyToText(input) {
  let text = input;

  text = replaceOnce(text,
    "<title>نظام إدارة المصاريف الشخصية (محلي - LocalStorage)</title>",
    "<title>نظام إدارة المصاريف الشخصية (أونلاين - Firebase)</title>",
    "title"
  );

  text = replaceOnce(text,
    '  const STORAGE_KEY = "pfm_data_v1";',
    '  const STORAGE_KEY = "pfm_data_v1";\n  const SAFETY_BACKUP_KEY = "pfm_safety_backup_latest_v1";',
    "safety backup key"
  );

  text = replaceOnce(text,
    lineBlock([
      '                  <button class="btn" id="btnExport2">⬇️ تصدير JSON</button>',
      '                  <button class="btn" id="btnImport2">⬆️ استيراد JSON</button>',
    ]).trimEnd(),
    lineBlock([
      '                  <button class="btn" id="btnExport2">⬇️ تصدير JSON</button>',
      '                  <button class="btn" id="btnImport2">⬆️ استيراد JSON</button>',
      '                  <button class="btn" id="btnTrash">🗑️ سلة المحذوفات</button>',
      '                  <button class="btn" id="btnRestoreSafety">🛟 استعادة آخر نسخة أمان</button>',
      '                  <button class="btn" id="btnUpdateApp">🔄 تحديث التطبيق</button>',
    ]).trimEnd(),
    "settings data buttons"
  );

  text = replaceOnce(text,
    '<div class="mini" style="margin-top:10px">تحذير: مسح البيانات لا يمكن التراجع عنه. استخدم التصدير قبل المسح.</div>',
    '<div class="mini" style="margin-top:10px">تحذير: سيتم إنشاء نسخة أمان محلية قبل الاستيراد أو المسح، ومع ذلك يفضّل تنزيل JSON قبل أي تغيير كبير.</div>',
    "clear warning"
  );

  text = replaceOnce(text,
    '<div>📌 <b>معلومة تقنية:</b> البيانات تُخزَّن داخل المتصفح (LocalStorage) على هذا الجهاز فقط. إذا فتحت الملف في متصفح آخر أو جهاز آخر ستحتاج إلى استيراد ملف JSON.</div>',
    '<div>📌 <b>معلومة تقنية:</b> البيانات تُحفظ محلياً أولاً ثم تُزامن تلقائياً مع Firebase بعد تسجيل الدخول. عند فتح جهاز جديد، يتم جلب بيانات السحابة قبل أي حفظ جديد لحماية بياناتك القديمة.</div>',
    "technical note"
  );

  text = insertBefore(text, "\n  </div>\n\n\n  \n    <div class=\"modal\" id=\"modalCloud\">", trashModal, "trash modal");

  text = replaceOnce(text,
    lineBlock([
      "  function txInMonth(month){",
      "    return state.transactions.filter(t => monthFromDate(t.date)===month);",
      "  }",
    ]).trimEnd(),
    lineBlock([
      "  function txInMonth(month){",
      "    return state.transactions.filter(t => !t.deletedAt && monthFromDate(t.date)===month);",
      "  }",
    ]).trimEnd(),
    "txInMonth excludes trash"
  );

  text = replaceOnce(text,
    "      .filter(t => monthFromDate(t.date)===activeMonth)",
    "      .filter(t => !t.deletedAt && monthFromDate(t.date)===activeMonth)",
    "transaction table excludes trash"
  );

  text = insertAfter(text,
    lineBlock([
      '  $("#btnImport").addEventListener("click", () => openImportModal());',
      '  $("#btnImport2").addEventListener("click", () => openImportModal());',
    ]).trimEnd(),
    "\n  $(\"#btnTrash\").addEventListener(\"click\", () => openTrashModal());\n  $(\"#btnRestoreSafety\").addEventListener(\"click\", () => restoreLatestSafetyBackup());\n  $(\"#btnUpdateApp\").addEventListener(\"click\", () => updateInstalledApp());",
    "settings button listeners"
  );

  text = insertBefore(text, '  $("#btnLoadFromFile").addEventListener("click", async () => {', safetyAndTrashFunctions, "safety/trash functions");

  text = replaceOnce(text,
    lineBlock([
      '  $("#btnDoImport").addEventListener("click", () => {',
      '    const txt = ($("#importText").value||"").trim();',
      '    if(!txt){ toast("الصق JSON أو حمّل من ملف"); return; }',
      "    try{",
      "      const parsed = JSON.parse(txt);",
      "      if(!parsed.categories || !parsed.transactions || !parsed.budgets){",
      '        toast("ملف غير صالح");',
      "        return;",
      "      }",
      "      state = parsed;",
      "      save();",
      '      closeModal("#modalImport");',
      '      toast("تم الاستيراد ✅");',
      "      render();",
      "    }catch(e){",
      '      toast("JSON غير صالح");',
      "    }",
      "  });",
    ]).trimEnd(),
    importHandler.trimEnd(),
    "import guard"
  );

  text = replaceOnce(text,
    lineBlock([
      '  $("#btnClearAll").addEventListener("click", () => {',
      '    const ok = confirm("هل أنت متأكد من مسح كل البيانات؟");',
      "    if(!ok) return;",
      "    localStorage.removeItem(STORAGE_KEY);",
      "    state = defaultData();",
      "    save();",
      '    toast("تم مسح البيانات");',
      "    render();",
      "  });",
    ]).trimEnd(),
    clearAllHandler.trimEnd(),
    "clear all guard"
  );

  text = replaceOnce(text,
    lineBlock([
      "  function deleteTx(id){",
      '    const ok = confirm("حذف العملية؟");',
      "    if(!ok) return;",
      "    state.transactions = state.transactions.filter(t=>t.id!==id);",
      "    save();",
      '    toast("تم الحذف");',
      "    render();",
      "  }",
    ]).trimEnd(),
    deleteTxFunction.trimEnd(),
    "soft delete transaction"
  );

  text = replaceOnce(text,
    '    if(!ok) return;\n\n    // remove from categories',
    '    if(!ok) return;\n    createLocalSafetyBackup("before-delete-category");\n\n    // remove from categories',
    "category delete backup"
  );

  text = replaceOnce(text,
    "  let dirty = false;\n  let lastLocalStr = null;",
    "  let dirty = false;\n  let cloudReady = false;\n  let lastLocalStr = null;",
    "cloudReady flag"
  );

  text = replaceOnce(text,
    lineBlock([
      "  async function ensureDoc(docRef){",
      "    const snap = await docRef.get();",
      "    if(!snap.exists){",
      "      const data = readLocal();",
      "      await docRef.set({",
      "        data: data || {},",
      "        createdAt: FieldValue.serverTimestamp(),",
      "        updatedAt: FieldValue.serverTimestamp(),",
      "        updatedBy: auth.currentUser.uid,",
      "        updatedByClientId: clientId,",
      "        version: 1",
      "      }, {merge:true});",
      "    }",
      "  }",
    ]).trimEnd(),
    prepareCloudSessionFunction.trimEnd(),
    "prepare cloud session"
  );

  text = replaceOnce(text,
    '    if(!auth.currentUser){ setStatus("الحالة: غير متصل (سجّل الدخول)"); return; }\n    const uid = auth.currentUser.uid;',
    '    if(!auth.currentUser){ setStatus("الحالة: غير متصل (سجّل الدخول)"); return; }\n    if(!cloudReady){ setStatus("الحالة: ينتظر اكتمال جلب السحابة قبل الحفظ"); return; }\n    const uid = auth.currentUser.uid;',
    "push waits for cloud"
  );

  text = replaceOnce(text,
    "  function schedulePush(reason){\n    clearTimeout(pushTimer);",
    '  function schedulePush(reason){\n    if(!cloudReady){ setStatus("الحالة: ينتظر اكتمال جلب السحابة قبل الحفظ"); return; }\n    clearTimeout(pushTimer);',
    "schedule waits for cloud"
  );

  text = replaceOnce(text,
    "    if(!auth.currentUser) return;",
    "    if(!auth.currentUser || !cloudReady) return;",
    "change listener waits for cloud"
  );

  text = replaceOnce(text,
    lineBlock([
      "  auth.onAuthStateChanged(async (user)=>{",
      "    updateAuthUI(user);",
      "    if(unsubSnap){ try{ unsubSnap(); }catch(e){} unsubSnap=null; }",
      "    if(!user) return;",
      "",
      "    const docRef = db.collection(\"pfm_users\").doc(user.uid);",
      "",
      "    // Ensure document exists then start realtime listener",
      "    try{",
      "      await ensureDoc(docRef);",
      "      startRealtime(docRef);",
      "      // First push to ensure cloud has latest (debounced)",
      "      schedulePush(\"بدء\");",
      "    }catch(err){",
    ]).trimEnd(),
    lineBlock([
      "  auth.onAuthStateChanged(async (user)=>{",
      "    updateAuthUI(user);",
      "    if(unsubSnap){ try{ unsubSnap(); }catch(e){} unsubSnap=null; }",
      "    cloudReady = false;",
      "    if(!user) return;",
      "",
      "    const docRef = db.collection(\"pfm_users\").doc(user.uid);",
      "",
      "    // Ensure document exists then start realtime listener",
      "    try{",
      "      setStatus(\"الحالة: جارٍ جلب بيانات السحابة أولاً لحماية البيانات...\");",
      "      await prepareCloudSession(docRef);",
      "      startRealtime(docRef);",
      "      cloudReady = true;",
      "    }catch(err){",
    ]).trimEnd(),
    "auth cloud-first startup"
  );

  text = replaceOnce(text,
    '      navigator.serviceWorker.register("./sw.js").catch((err) => {',
    '      navigator.serviceWorker.register("./sw.js").then((reg) => {\n        reg.update().catch(()=>{});\n      }).catch((err) => {',
    "service worker update"
  );

  return text;
}

export async function applyToFile(inputPath = "index.html", outputPath = inputPath) {
  const input = await readFile(inputPath, "utf8");
  const output = applyToText(input);
  await writeFile(outputPath, output, "utf8");
  return { changed: input !== output, bytes: Buffer.byteLength(output, "utf8") };
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("apply-safe-data-guards.mjs")) {
  const inputPath = process.argv[2] || "index.html";
  const outputPath = process.argv[3] || inputPath;
  applyToFile(inputPath, outputPath)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
