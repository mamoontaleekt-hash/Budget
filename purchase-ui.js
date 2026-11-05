(function () {
  "use strict";
  window.PFMPurchaseUI = { create };
  function create({getState, saveState, startPurchase, goToBudgets, notify}) {
    const Model = window.PFMPurchaseModel, Format = window.PFMDisplayFormat;
    const $ = selector => document.querySelector(selector);
    const money = Format.formatMoney, monthLabel = Format.formatMonthKey;
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; };
    let editing = null, activeMonth = currentMonth(), previousMonth = null;
    const section = document.createElement("div"); section.className = "card future-purchases"; section.id = "futurePurchases";
    section.innerHTML = `
      <div class="hd"><div><h2>المشتريات القادمة</h2><p>خطّط لما تريد شراءه، ووزّع الأهداف على أشهر السنة.</p></div><button class="btn primary small" id="btnNewPurchase" type="button">إضافة مشتريات</button></div>
      <div class="bd">
        <div class="help">المبالغ هنا للتخطيط فقط. لن تتغير مصروفاتك أو رصيدك حتى تختار «تسجيل الشراء» وتحفظ العملية الفعلية.</div>
        <details id="purchaseEditor"><summary>تفاصيل المشتريات</summary>
          <form id="purchaseForm" class="purchase-form">
            <div class="purchase-wide"><label for="purchaseTitle">ماذا تريدون شراءه؟</label><input id="purchaseTitle" required maxlength="180" placeholder="مثال: غرفة غيث" /></div>
            <div><label for="purchaseMonth">الشهر المستهدف</label><input id="purchaseMonth" type="month" required /></div>
            <div><label for="purchaseAmount">التكلفة التقديرية (د.ع)</label><input id="purchaseAmount" type="number" required min="1" step="any" inputmode="decimal" placeholder="500000" /></div>
            <div><label for="purchaseSaved">المبلغ المخصص حالياً (د.ع)</label><input id="purchaseSaved" type="number" min="0" step="any" inputmode="decimal" value="0" aria-describedby="purchaseSavedHelp" /></div>
            <div><label for="purchaseCategory">التصنيف</label><select id="purchaseCategory"></select></div>
            <div><label for="purchasePriority">الأولوية</label><select id="purchasePriority"><option value="normal">متوسطة</option><option value="high">مهمة</option><option value="low">يمكن تأجيلها</option></select></div>
            <div><label for="purchaseNote">ملاحظة</label><input id="purchaseNote" placeholder="المقاس، المتجر، أو أي تفاصيل تريد تذكرها" /></div>
            <p class="mini purchase-wide" id="purchaseSavedHelp">المبلغ المخصص للتذكير فقط؛ لا ينشئ حركة مالية ولا يُخصم من الرصيد.</p>
            <div class="row purchase-wide"><button class="btn primary" type="submit" id="btnSavePurchase">حفظ الخطة</button><button class="btn" id="btnCancelPurchaseEdit" type="button">إلغاء</button><span id="purchaseFormStatus" role="status" aria-live="polite"></span></div>
          </form>
        </details>
        <div class="row purchase-year"><label for="purchaseYear">خطة السنة</label><input id="purchaseYear" type="number" min="2000" max="2200" step="1" /><span id="purchaseYearTotal" class="mini"></span></div>
        <div id="purchaseMonthNotice" class="help" hidden></div>
        <div id="purchaseTimeline" class="purchase-timeline"></div>
      </div>`;
    $("#view-budgets").append(section);
    $("#btnUpcomingPurchases")?.addEventListener("click", () => section.scrollIntoView({behavior:"smooth",block:"start"}));
    const reminder = document.createElement("div"); reminder.id = "purchaseDashboardReminder"; reminder.className = "help purchase-reminder"; reminder.hidden = true;
    reminder.innerHTML = `<span id="purchaseReminderText"></span><button class="btn small" type="button" id="btnReviewPurchases">مراجعة الخطة</button>`;
    $(".dashboard-utility-row").after(reminder);
    $("#btnReviewPurchases").addEventListener("click", () => { goToBudgets(); section.scrollIntoView({behavior:"smooth",block:"start"}); });
    function reset() {
      editing = null; $("#purchaseForm").reset(); $("#purchaseMonth").value = activeMonth;
      $("#purchaseFormStatus").textContent = ""; $("#btnSavePurchase").textContent = "حفظ الخطة";
    }
    $("#btnNewPurchase").addEventListener("click", () => { reset(); $("#purchaseEditor").open = true; $("#purchaseTitle").focus(); });
    $("#btnCancelPurchaseEdit").addEventListener("click", () => { reset(); $("#purchaseEditor").open = false; });
    $("#purchaseYear").addEventListener("input", () => render(activeMonth));
    $("#purchaseForm").addEventListener("submit", event => {
      event.preventDefault();
      try {
        const values = {title:$("#purchaseTitle").value, month:$("#purchaseMonth").value, amount:$("#purchaseAmount").value, savedAmount:$("#purchaseSaved").value, categoryId:$("#purchaseCategory").value, priority:$("#purchasePriority").value, note:$("#purchaseNote").value};
        const id = editing || (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        saveState(Model.withPurchase(getState(), values, id));
        $("#purchaseYear").value = values.month.slice(0,4);
        reset(); $("#purchaseEditor").open = false; render(activeMonth); notify("تم حفظ خطة المشتريات");
      } catch (error) { $("#purchaseFormStatus").textContent = error.message; }
    });
    $("#purchaseTimeline").addEventListener("click", event => {
      const button = event.target.closest("button[data-purchase-action]"); if (!button) return;
      const item = getState().plannedPurchases?.[button.dataset.id]; if (!item) return;
      const action = button.dataset.purchaseAction;
      if (action === "buy") { startPurchase(item); return; }
      if (action === "edit") {
        editing = item.id;
        for (const [id, value] of Object.entries({purchaseTitle:item.title,purchaseMonth:item.month,purchaseAmount:item.amount,purchaseSaved:item.savedAmount || 0,purchaseCategory:item.categoryId,purchasePriority:item.priority,purchaseNote:item.note})) $("#"+id).value = value || "";
        $("#purchaseEditor").open = true; $("#btnSavePurchase").textContent = "حفظ التعديل"; $("#purchaseTitle").focus(); return;
      }
      const state = getState(), updated = {...item, status:action === "cancel" ? "cancelled" : "planned"};
      saveState({...state, plannedPurchases:{...state.plannedPurchases,[item.id]:updated}});
      notify(action === "cancel" ? "تم إلغاء الخطة؛ يمكنك إعادتها لاحقاً" : "تمت إعادة المشتريات إلى الخطة");
    });
    function render(month) {
      activeMonth = month;
      if (previousMonth !== month) { $("#purchaseYear").value = month.slice(0,4); previousMonth = month; }
      if (!$("#purchaseMonth").value) $("#purchaseMonth").value = month;
      const state = getState(), category = $("#purchaseCategory"), selected = category.value;
      category.innerHTML = `<option value="">اختر التصنيف عند الشراء</option>` + state.categories.filter(c => c.type === "expense").map(c => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join(""); category.value = selected;
      const year = $("#purchaseYear").value;
      if (!/^\d{4}$/.test(year)) return;
      const all = Model.list(state), planned = all.filter(item => item.status !== "cancelled" && (!Model.linkedTransaction(state,item) || Model.linkedTransaction(state,item)?.deletedAt));
      const annual = planned.filter(item => item.month.startsWith(year + "-"));
      $("#purchaseYearTotal").textContent = `${annual.length} مشتريات متبقية · ${money(annual.reduce((sum,item) => sum + Number(item.amount),0))}`;
      const thisMonth = Model.summary(state, month, currentMonth());
      $("#purchaseMonthNotice").hidden = !thisMonth.total;
      $("#purchaseMonthNotice").textContent = `مشتريات مخططة للشهر المحدد: ${money(thisMonth.total)}. راجع ميزانيات التصنيفات لتوفير هذا المبلغ؛ لا يُضاف إليها تلقائياً.`;
      $("#purchaseTimeline").innerHTML = Array.from({length:12},(_,index) => {
        const key = `${year}-${String(index+1).padStart(2,"0")}`, summary = Model.summary(state,key,currentMonth());
        return `<details class="purchase-month" ${summary.items.length ? "open" : ""}><summary><span>${escape(monthLabel(key))}</span><span>${summary.items.length ? `${summary.items.length} مشتريات · ${money(summary.total)} متبقية` : "لا توجد مشتريات"}</span></summary>
          ${summary.remaining > 0 && key >= currentMonth() ? `<p class="mini">المتبقي للتخصيص: ${money(summary.remaining)} · تخصيص شهري مقترح من هذا الشهر: ${money(summary.monthlySaving)}</p>` : ""}
          ${summary.items.map(item => {
            const tx = Model.linkedTransaction(state,item), completed = tx && !tx.deletedAt, cancelled = item.status === "cancelled", priority = {high:"مهمة",normal:"متوسطة",low:"يمكن تأجيلها"}[item.priority] || "متوسطة";
            return `<article class="purchase-item" data-purchase-id="${escape(item.id)}"><div><b>${escape(item.title)}</b><p>${money(item.amount)} <span class="pill">${completed ? "تم الشراء" : cancelled ? "ملغاة" : item.month < currentMonth() ? "موعدها مضى · راجع الخطة" : priority}</span></p>${item.savedAmount ? `<p class="mini">مخصص: ${money(item.savedAmount)}</p>` : ""}${item.note ? `<p class="mini">${escape(item.note)}</p>` : ""}${tx?.deletedAt ? `<p class="mini">العملية المرتبطة محذوفة؛ الخطة ما زالت ظاهرة للمراجعة.</p>` : ""}${completed ? `<p class="mini">الفعلي: ${money(tx.amount)} · ${escape(tx.date)}</p>` : ""}</div><div class="row">${!completed && !cancelled ? `<button class="btn small primary" data-purchase-action="buy" data-id="${escape(item.id)}">تسجيل الشراء</button><button class="btn small" data-purchase-action="edit" data-id="${escape(item.id)}">تعديل / تأجيل</button><button class="btn small danger" data-purchase-action="cancel" data-id="${escape(item.id)}">إلغاء الخطة</button>` : cancelled ? `<button class="btn small" data-purchase-action="restore" data-id="${escape(item.id)}">إعادة للخطة</button>` : ""}</div></article>`;
          }).join("")}</details>`;
      }).join("");
      reminder.hidden = !planned.length;
      const due = planned.filter(item => item.month <= month), next = [...planned].sort((a,b) => a.month.localeCompare(b.month))[0];
      $("#purchaseReminderText").textContent = due.length ? `${due.length} مشتريات مستحقة حتى الشهر المحدد، بإجمالي ${money(due.reduce((sum,item) => sum+Number(item.amount),0))}` : next ? `المشتريات القادمة: ${next.title} · ${monthLabel(next.month)} · ${money(next.amount)}` : "";
    }
    return { render };
  }
})();
