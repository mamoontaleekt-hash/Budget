(function () {
  "use strict";
  window.PFMCloudSync = { start };
  function start(firebaseConfig) {
    const Sync = window.PFMSyncModel, Storage = window.PFMCloudStorage, DisplayFormat = window.PFMDisplayFormat;
    const STORAGE_KEY = "pfm_data_v1", BACKUP_KEY = "pfm_backup_before_remote_v1", OWNER_KEY = "pfm_sync_owner_v2";
    const clientId = window.PFMSyncActor;
    const $ = selector => document.querySelector(selector);
    let auth, db, FieldValue, session = 0, timer, retryTimer, pulseTimer, unsubscribe;
    let inFlight = null, flightId = 0, ready = false, dirty = false, failures = 0, started = false, loadingSDK = null;
    let lastFailure = null, remoteEvent = 0;
    const text = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    function status(message, label, kind = "warn") {
      clearTimeout(pulseTimer);
      text("#cloudStatus", message);
      for (const id of ["#cloudBadge", "#cloudConnPill"]) {
        const el = $(id); if (!el) continue;
        text(id + " span", label);
        el.classList.remove("ok", "warn", "danger"); el.classList.add(kind);
      }
    }
    function readLocal() { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : window.PFMGetState?.() || null; }
    function isValidAppState(data) { return Sync.valid(data); }
    function rejectInvalidRemote(source) {
      console.warn(`Rejected invalid remote app state (${source})`);
      throw new Error("بيانات السحابة غير صالحة؛ بقيت نسخة هذا الجهاز محفوظة");
    }
    function clock() { return DisplayFormat.westernizeDigits(new Date().toLocaleString("ar-IQ", {hour12:true})); }
    function pending(message = "التعديلات محفوظة على هذا الجهاز وتنتظر تأكيد السحابة") {
      status(message, navigator.onLine === false ? "محفوظ محلياً · دون إنترنت" : "بانتظار المزامنة");
    }
    function showFailure(error, phase, data) {
      const labels = {read:"قراءة نسخة السحابة",merge:"دمج نسختي البيانات",write:"تجهيز البيانات للرفع",commit:"تأكيد الحفظ من الخادم",apply:"حفظ النسخة المدمجة على الجهاز",listen:"استقبال تحديث من جهاز آخر"};
      let message = String(error.message || error).slice(0,6000);
      const uid = auth?.currentUser?.uid;
      if (uid) message = message.split(uid).join("[account]");
      message = message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[email]");
      lastFailure = {release:"20261105-sync4",phase,code:error.code || "unknown",message};
      const lines = ["الإصدار: " + lastFailure.release,"المرحلة: " + (labels[phase] || phase),"الرمز: " + lastFailure.code,"التفاصيل: " + message];
      if (data) {
        lines.push("عدد العمليات: " + data.transactions.length,"حجم JSON بالبايت: " + new TextEncoder().encode(JSON.stringify(data)).length);
      }
      const panel = $("#cloudErrorDetails"), field = $("#cloudErrorMessage");
      if (panel) { panel.hidden = false; panel.open = true; }
      if (field) field.value = lines.join("\n");
      text("#cloudErrorCopyStatus", "");
    }
    function backupLocalBeforeRemote(data) {
      try {
        const current = readLocal();
        if (!current || Sync.equivalent(current, data)) return;
        const old = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
        const history = [{ at: new Date().toISOString(), data: current }, ...(old?.history || (old?.data ? [{at:old.at,data:old.data}] : []))].slice(0, 3);
        while (history.length > 1 && JSON.stringify(history).length > 700000) history.pop();
        localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...history[0], history }));
      } catch (error) { console.warn("Could not update recovery backup", error); }
    }
    function apply(data) {
      if (!isValidAppState(data)) throw new Error("Invalid merged state");
      if (Sync.equivalent(readLocal(), data)) return;
      backupLocalBeforeRemote(data);
      window.dispatchEvent(new CustomEvent("pfm:apply", {detail:data}));
      if (!Sync.equivalent(readLocal(), data)) throw new Error("تعذر حفظ التحديث على هذا الجهاز؛ تحقق من مساحة التخزين");
      renderConflicts();
    }
    function renderConflicts() {
      const panel = $("#cloudConflicts"); if (!panel) return;
      panel.replaceChildren();
      const entries = Sync.conflicts(readLocal());
      panel.hidden = !entries.length;
      if (!entries.length) return;
      const heading = document.createElement("p"); heading.textContent = "توجد تعديلات مختلفة على البيانات نفسها. احتفظنا بالنسختين؛ اختر النسخة الصحيحة لكل تعارض."; panel.append(heading);
      for (const [id, conflict] of entries) {
        const card = document.createElement("div"); card.className = "sync-conflict";
        const title = document.createElement("b");
        const name = conflict.alternatives.find(item => item.value?.note || item.value?.name || item.value?.title)?.value;
        title.textContent = name?.note || name?.name || name?.title || ({budgets:"ميزانية",financialSettings:"الرصيد الافتتاحي",transactions:"عملية مالية",plannedPurchases:"شراء مخطط"}[conflict.path[0]] || "إعداد مالي"); card.append(title);
        conflict.alternatives.forEach((item, index) => {
          const detail = document.createElement("p");
          const value = item.value;
          const category = readLocal()?.categories.find(c => c.id === value?.categoryId)?.name;
          detail.textContent = item.deleted ? "هذه النسخة تحذف السجل" : value && typeof value === "object"
            ? [value.title || value.name || value.note, value.amount != null ? DisplayFormat.formatMoney(value.amount) : "", value.date || (value.month ? DisplayFormat.formatMonthKey(value.month) : ""), category, value.deletedAt ? "نُقلت إلى سلة المحذوفات" : ""].filter(Boolean).join(" · ") || "إعداد محفوظ"
            : typeof value === "number" ? DisplayFormat.formatMoney(value) : String(value);
          const button = document.createElement("button"); button.className = "btn small"; button.textContent = `اعتماد النسخة ${index + 1}`;
          button.addEventListener("click", () => {
            const resolved = Sync.resolveConflict(readLocal(), id, index, clientId);
            apply(resolved); dirty = true; pending(); schedule("حل تعارض", 0);
          });
          card.append(detail, button);
        });
        panel.append(card);
      }
    }
    function showSaved() {
      lastFailure = null;
      const errorPanel = $("#cloudErrorDetails"); if (errorPanel) errorPanel.hidden = true;
      const count = Sync.conflicts(readLocal()).length;
      status(count ? `تمت المزامنة؛ توجد ${count} تعديلات تحتاج مراجعتك في المزامنة السحابية` : "تم حفظ البيانات محلياً وتأكيد حفظها في السحابة", count ? "تعارض يحتاج مراجعة" : "تمت المزامنة", count ? "warn" : "ok");
      text("#cloudLast", "آخر تأكيد من السحابة: " + clock());
      renderConflicts();
    }
    function schedule(reason, delay = 250) {
      clearTimeout(timer);
      timer = setTimeout(() => { syncNow(reason).catch(() => {}); }, delay);
    }
    function retry() {
      clearTimeout(retryTimer);
      if (!auth?.currentUser) return;
      retryTimer = setTimeout(() => { syncNow("إعادة محاولة").catch(() => {}); }, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
    async function syncNow(reason) {
      if (!auth?.currentUser) { status("البيانات محفوظة على هذا الجهاز فقط. سجّل الدخول بالحساب العائلي نفسه لمشاركتها.", "محفوظ على هذا الجهاز"); return false; }
      if (inFlight) { dirty = true; return inFlight; }
      const user = auth.currentUser, generation = session;
      const ownFlight = ++flightId;
      const owner = localStorage.getItem(OWNER_KEY);
      if (owner && owner !== user.uid) {
        status("بيانات هذا الجهاز مرتبطة بحساب آخر. سجّل الدخول بالحساب السابق لحمايتها.", "حساب مختلف", "danger"); return false;
      }
      if (navigator.onLine === false) { dirty = true; pending(); return false; }
      const captured = readLocal();
      if (!isValidAppState(captured)) { pending("لا توجد بيانات محلية صالحة للحفظ؛ لم تُستبدل بيانات السحابة"); return false; }
      localStorage.setItem(OWNER_KEY, user.uid);
      const docRef = db.collection("pfm_users").doc(user.uid);
      let phase = "read", attemptedData = captured, storagePlan = null;
      status("جارٍ دمج البيانات وتأكيد الحفظ في السحابة…", "جارٍ المزامنة");
      inFlight = (async () => {
        try {
          const committed = await db.runTransaction(async transaction => {
            phase = "read";
            const snap = await transaction.get(docRef);
            if (generation !== session || auth.currentUser?.uid !== user.uid) throw new Error("تغير الحساب أثناء المزامنة");
            const remote = snap.exists ? snap.data() : {};
            const remoteData = snap.exists ? await Storage.unpack(remote.data, async id => {
              const part = await transaction.get(docRef.collection("snapshots").doc(id));
              return part.exists ? part.data() : null;
            }) : null;
            if (snap.exists && !isValidAppState(remoteData)) rejectInvalidRemote("transaction");
            phase = "merge";
            const data = snap.exists ? Sync.merge(captured, remoteData) : captured;
            attemptedData = data;
            if (!snap.exists || !Storage.isPacked(remote.data) || !Sync.equivalent(data, remoteData)) {
              storagePlan = await Storage.pack(data);
              phase = "write";
              // All referenced pieces and the manifest commit together. Old pieces stay
              // immutable so readers holding an older snapshot can finish safely.
              for (const part of storagePlan.documents) transaction.set(docRef.collection("snapshots").doc(part.id),part.data);
              transaction.set(docRef, {
                ...remote, data:storagePlan.manifest, version:1,
                createdAt:remote.createdAt || FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp(),
                updatedBy:user.uid, updatedByClientId:clientId,
              });
            }
            phase = "commit";
            return data;
          });
          if (generation !== session || auth.currentUser?.uid !== user.uid) return false;
          // A user may keep editing while the server write is in flight.
          phase = "apply";
          const current = readLocal();
          const merged = Sync.merge(current, committed);
          apply(merged);
          dirty = !Sync.equivalent(merged, committed);
          failures = 0; clearTimeout(retryTimer); ready = true;
          if (!unsubscribe) startRealtime(docRef, generation);
          if (dirty) pending(); else showSaved();
          return true;
        } catch (error) {
          if (generation !== session) return false;
          dirty = true; failures += 1;
          showFailure(error,phase,attemptedData);
          if (storagePlan?.documents.length && error.code === "permission-denied") {
            const diagnostic = $("#cloudErrorMessage");
            if (diagnostic) diagnostic.value = "تحتاج مزامنة هذا الحجم إلى السماح للحساب نفسه بقراءة وكتابة المسار pfm_users/{uid}/snapshots/{snapshotId}. بياناتك المحلية لم تُحذف.\n" + diagnostic.value;
          }
          status("لم تؤكد السحابة الحفظ. بياناتك باقية على الجهاز. سبب الرفض موضح في تفاصيل الخطأ أدناه" + (error.code ? ` (${error.code})` : ""), "محفوظ محلياً · تعذر الرفع", "danger");
          retry(); return false;
        } finally {
          if (ownFlight === flightId) {
            inFlight = null;
            if (generation === session && dirty && !failures && navigator.onLine !== false) schedule("تعديلات جديدة", 0);
          }
        }
      })();
      return inFlight;
    }
    function startRealtime(docRef, generation) {
      unsubscribe = docRef.onSnapshot({includeMetadataChanges:true}, async snap => {
        if (generation !== session || !snap.exists || snap.metadata?.hasPendingWrites || snap.metadata?.fromCache) return;
        const sequence = ++remoteEvent;
        try {
          const remoteData = await Storage.unpack(snap.data()?.data, async id => {
            const part = await docRef.collection("snapshots").doc(id).get({source:"server"});
            return part.exists ? part.data() : null;
          });
          if (generation !== session || sequence !== remoteEvent) return;
          if (!isValidAppState(remoteData)) rejectInvalidRemote("realtime update");
          const merged = Sync.merge(readLocal(), remoteData);
          apply(merged);
          if (!Sync.equivalent(merged, remoteData)) { dirty = true; pending(); schedule("دمج جهاز آخر"); }
          else if (!inFlight) { dirty = false; showSaved(); }
        } catch (error) { showFailure(error,"listen"); status(error.message, "تحديث يحتاج مراجعة", "danger"); }
      }, error => {
        if (generation !== session) return;
        unsubscribe?.(); unsubscribe = null; ready = false; dirty = true; failures += 1;
        status("تعذر استقبال التحديثات؛ بقيت بيانات هذا الجهاز محفوظة" + (error.code ? ` (${error.code})` : ""), "تعذر الاتصال", "danger"); retry();
      });
    }
    function connect() {
      if (started || typeof window.firebase === "undefined") return;
      started = true;
      try {
        if (!firebase.apps?.length) firebase.initializeApp(firebaseConfig);
        auth = firebase.auth(); db = firebase.firestore(); FieldValue = firebase.firestore.FieldValue;
        auth.onAuthStateChanged(user => {
          session += 1; flightId += 1; inFlight = null; clearTimeout(timer); clearTimeout(retryTimer); unsubscribe?.(); unsubscribe = null; ready = false;
          for (const [id, visible] of [["#btnCloudLogin",!user],["#btnCloudLogout",!!user],["#cloudCreds",!user]]) {
            const el = $(id); if (el) el.style.display = visible ? (id === "#cloudCreds" ? "grid" : "inline-flex") : "none";
          }
          text("#cloudAccount", user ? `الحساب العائلي: ${user.email || user.uid} — استخدم الحساب نفسه على جميع الأجهزة` : "استخدم الحساب العائلي نفسه على أجهزتك وأجهزة زوجتك");
          if (user) { pending("جارٍ التحقق من نسخة السحابة ودمج إدخالات هذا الجهاز…"); syncNow("بدء الجلسة").catch(() => {}); }
          else status("البيانات محفوظة على هذا الجهاز فقط. سجّل الدخول لمزامنتها مع بقية الأجهزة.", "محفوظ على هذا الجهاز");
        });
      } catch (error) { started = false; status("تعذر تشغيل المزامنة؛ البيانات محفوظة محلياً — " + error.message, "المزامنة غير متاحة", "danger"); }
    }
    async function ensureSDK() {
      if (started || navigator.onLine === false) return;
      if (loadingSDK) return loadingSDK;
      loadingSDK = (async () => {
        const modules = [["app",()=>!!window.firebase],["auth",()=>typeof window.firebase?.auth === "function"],["firestore",()=>typeof window.firebase?.firestore === "function"]];
        for (const [name, available] of modules) if (!available()) await new Promise((resolve,reject) => {
          const script = document.createElement("script");
          const timeout = setTimeout(() => { script.remove(); reject(new Error("SDK timeout")); },15000);
          script.src = `https://www.gstatic.com/firebasejs/10.13.0/firebase-${name}-compat.js`;
          script.onload = () => {clearTimeout(timeout);resolve();};
          script.onerror = () => {clearTimeout(timeout);script.remove();reject(new Error("SDK unavailable"));};
          document.head.append(script);
        });
        connect();
      })().catch(() => {
        status("تعذر تحميل المزامنة؛ بيانات هذا الجهاز محفوظة وسنعيد الاتصال تلقائياً", "محفوظ محلياً · لا مزامنة");
        clearTimeout(retryTimer); retryTimer = setTimeout(() => ensureSDK(),30000);
      }).finally(() => {loadingSDK = null;});
      return loadingSDK;
    }
    $("#btnCloud")?.addEventListener("click", () => { $("#modalCloud")?.classList.add("open"); renderConflicts(); });
    $("#btnCloudLogin")?.addEventListener("click", async () => {
      connect();
      if (!auth) { status("تعذر تحميل خدمة المزامنة. اتصل بالإنترنت وأعد فتح التطبيق؛ البيانات المحلية محفوظة.", "المزامنة غير متاحة", "danger"); return; }
      try { await auth.signInWithEmailAndPassword($("#cloudEmail").value.trim(), $("#cloudPass").value); $("#cloudPass").value = ""; }
      catch (error) { status("تعذر تسجيل الدخول" + (error.code ? ` (${error.code})` : ""), "لم يتم الدخول", "danger"); }
    });
    $("#btnCloudLogout")?.addEventListener("click", async () => {
      if (dirty && (!await syncNow("قبل تسجيل الخروج") || dirty)) return;
      try { await auth?.signOut(); } catch (error) { status("تعذر تسجيل الخروج", "خطأ", "danger"); }
    });
    $("#btnCloudPush")?.addEventListener("click", () => syncNow("يدوي"));
    $("#btnCopyCloudError")?.addEventListener("click", async () => {
      const field = $("#cloudErrorMessage"); if (!field?.value) return;
      try {
        await navigator.clipboard.writeText(field.value);
        text("#cloudErrorCopyStatus", "تم نسخ التفاصيل؛ يمكنك إرسالها للدعم");
      } catch (error) {
        field.focus(); field.select();
        text("#cloudErrorCopyStatus", "حدد النص وانسخه من الحقل أعلاه");
      }
    });
    $("#btnCloudPull")?.addEventListener("click", () => { /* A manual fetch also merges unsent edits. */ syncNow("manual fetch"); });
    $("#btnCloudRestoreBackup")?.addEventListener("click", () => {
      try {
        const backup = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
        if (!isValidAppState(backup?.data)) { pending("لا توجد نسخة احتياطية صالحة للاستعادة"); return; }
        // Recovery combines records rather than erasing newer entries.
        apply(Sync.merge(readLocal(), backup.data)); dirty = true; pending("تم دمج النسخة الاحتياطية؛ راجع أي تعارضات ثم زامن البيانات"); schedule("استعادة نسخة", 0);
      } catch (error) { status("تعذرت استعادة النسخة الاحتياطية — " + error.message, "لم تتم الاستعادة", "danger"); }
    });
    window.addEventListener("pfm:changed", () => { dirty = true; pending(); renderConflicts(); schedule("تغيير"); });
    window.addEventListener("pfm:savefailed", () => {
      status("لم يتم حفظ آخر تعديل على الجهاز. تحقق من مساحة التخزين وصدّر نسخة احتياطية قبل إغلاق التطبيق.", "لم يُحفظ آخر تعديل", "danger");
    });
    window.addEventListener("pfm:merged", () => { dirty = true; schedule("علامة تبويب أخرى"); });
    window.addEventListener("offline", () => { dirty = true; pending(); });
    window.addEventListener("online", () => { ensureSDK(); schedule("عودة الاتصال", 0); });
    window.addEventListener("pageshow", () => { if (auth?.currentUser) schedule("فتح التطبيق", 0); });
    document.addEventListener("visibilitychange", () => { if (auth?.currentUser) schedule("تغيير الظهور", 0); });
    window.addEventListener("pagehide", () => { if (dirty) syncNow("إغلاق الصفحة"); });
    connect();
    if (!started) {
      status("خدمة المزامنة غير متاحة الآن. البيانات محفوظة على هذا الجهاز وسنعيد الاتصال تلقائياً.", "محفوظ محلياً · لا مزامنة");
      ensureSDK();
    }
    return { syncNow, getState: () => ({ready,dirty,session,lastFailure}) };
  }
})();
