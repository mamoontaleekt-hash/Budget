(function () {
  "use strict";
  const STORAGE_KEY = "pfm_data_v1";
  const FinancialModel = window.PFMFinancialModel;
  const ExpenseModel = window.PFMExpenseModel;
  const BudgetModel = window.PFMBudgetModel;
  const ComparisonModel = window.PFMComparisonModel;
  const CategoryAnalyticsModel = window.PFMCategoryAnalyticsModel;
  if (!FinancialModel || !ExpenseModel || !BudgetModel || !ComparisonModel || !CategoryAnalyticsModel) throw new Error("A report model failed to load");
  const fmt = new Intl.NumberFormat("ar-IQ", { style: "currency", currency: "IQD", maximumFractionDigits: 0 });
  const $ = (selector, root = document) => root.querySelector(selector);
  const money = (value) => fmt.format(Math.round(Number(value) || 0));
  const escapeHTML = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  let selectorActiveMonth = null;
  let selectedComparisonMonth = null;
  let categorySelectorActiveMonth = null;
  let selectedCategoryId = null;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        ...parsed,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        budgets: parsed.budgets && typeof parsed.budgets === "object" ? parsed.budgets : {},
        financialSettings: parsed.financialSettings && typeof parsed.financialSettings === "object" ? parsed.financialSettings : undefined,
        expenseSettings: parsed.expenseSettings && typeof parsed.expenseSettings === "object" ? parsed.expenseSettings : undefined,
        debtSettings: parsed.debtSettings && typeof parsed.debtSettings === "object" ? parsed.debtSettings : undefined,
      };
    } catch (error) {
      console.warn("Report enhancements could not read local data", error);
      return { categories: [], transactions: [], budgets: {} };
    }
  }

  function monthLabel(month) {
    const [year, rawMonth] = String(month || "").split("-").map(Number);
    if (!year || !rawMonth) return month || "-";
    return new Intl.DateTimeFormat("ar-IQ", { month: "long", year: "numeric" }).format(new Date(year, rawMonth - 1, 1));
  }
  function lastMonths(activeMonth, count) {
    const months = [];
    for (let i = count - 1; i >= 0; i -= 1) months.push(ComparisonModel.addMonths(activeMonth, -i));
    return months;
  }
  function totalsForMonth(state, month) {
    const financials = FinancialModel.calculateMonthFinancials(state, month);
    const expenses = ExpenseModel.calculateExpenseAnalytics(state, month);
    return { month, income: financials.trueIncome, expense: financials.totalExpenses, net: financials.netCashFlow, closingBalance: financials.closingBalance, costOfLiving: expenses.costOfLiving, exceptionalExpenses: expenses.exceptionalExpenses, debtPayments: expenses.debtPayments, nonLivingOutflows: expenses.nonLivingOutflows, count: financials.transactions.length };
  }
  function categoryName(state, categoryId) {
    if (categoryId === CategoryAnalyticsModel.UNCATEGORIZED) return "غير مصنف";
    return state.categories.find((category) => category?.id === categoryId)?.name || "تصنيف غير موجود";
  }
  function categoryOptionLabel(state, categoryId) {
    const name = categoryName(state, categoryId);
    return name === "تصنيف غير موجود" ? `${name} (${categoryId})` : name;
  }

  function ensureReportsPanel() {
    const reportsBody = $("#view-reports .bd");
    const firstSplit = reportsBody?.querySelector(".split");
    if (!reportsBody || !firstSplit) return null;
    let panel = $("#reportEnhancementsPanel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "reportEnhancementsPanel";
    panel.innerHTML = `
      <style>
        #reportEnhancementsPanel .comparison-head{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap}
        #reportEnhancementsPanel .comparison-control{display:grid;gap:5px;min-width:180px}
        #reportEnhancementsPanel .comparison-table-wrap{overflow:auto;margin-top:10px}
        #reportEnhancementsPanel .comparison-table{min-width:720px}
        #reportEnhancementsPanel .comparison-table td,#reportEnhancementsPanel .comparison-table th{white-space:nowrap}
        #reportEnhancementsPanel .delta-up,#reportEnhancementsPanel .delta-down{font-weight:800}
        #reportEnhancementsPanel .delta-up{color:#b45309} #reportEnhancementsPanel .delta-down{color:#047857}
        #reportEnhancementsPanel .drivers-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
        #reportEnhancementsPanel .driver-card{border:1px solid var(--border,#d9dde5);border-radius:12px;padding:12px;min-width:0}
        #reportEnhancementsPanel .driver-list{display:grid;gap:8px;margin-top:10px}
        #reportEnhancementsPanel .driver-row{display:grid;grid-template-columns:minmax(110px,1fr) auto;gap:6px 12px;padding-bottom:8px;border-bottom:1px solid var(--border,#e5e7eb)}
        #reportEnhancementsPanel .driver-row:last-child{border-bottom:0;padding-bottom:0}
        #reportEnhancementsPanel .driver-values{font-size:.82em;color:var(--muted,#64748b);grid-column:1/-1;overflow-wrap:anywhere}
        #reportEnhancementsPanel .comparison-note{margin-top:10px;padding:9px 11px;border-radius:10px;background:#fff7ed;color:#9a3412}
        #reportEnhancementsPanel .gross-summary{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}
        #reportEnhancementsPanel .category-head{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap}
        #reportEnhancementsPanel .category-control{display:grid;gap:5px;min-width:0;width:min(100%,320px);max-width:100%}
        #reportEnhancementsPanel #categoryAnalyticsSelector{width:100%;min-width:0;max-width:100%}
        #reportEnhancementsPanel .category-kpis{margin-top:12px}
        #reportEnhancementsPanel .category-trend{display:grid;gap:8px;margin-top:12px}
        #reportEnhancementsPanel .category-trend-row{display:grid;grid-template-columns:minmax(105px,145px) minmax(100px,1fr) minmax(145px,auto);gap:10px;align-items:center}
        #reportEnhancementsPanel .category-bar-track{height:12px;border-radius:999px;background:#e8edf4;overflow:hidden}
        #reportEnhancementsPanel .category-bar{height:100%;border-radius:inherit;background:var(--primary,#2563eb);min-width:0}
        #reportEnhancementsPanel .category-trend-value{text-align:left;font-size:.82em;overflow-wrap:anywhere}
        #reportEnhancementsPanel .category-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
        #reportEnhancementsPanel .category-fact{border:1px solid var(--border,#d9dde5);border-radius:10px;padding:10px;min-width:0;overflow-wrap:anywhere}
        #reportEnhancementsPanel .category-overview-wrap{overflow:auto;margin-top:12px}
        #reportEnhancementsPanel .category-overview{min-width:1050px}
        #reportEnhancementsPanel .category-overview td,#reportEnhancementsPanel .category-overview th{white-space:nowrap}
        #reportEnhancementsPanel .category-explorer{display:grid;gap:8px;margin-top:10px}
        #reportEnhancementsPanel .category-explorer-row{display:grid;grid-template-columns:minmax(105px,auto) minmax(0,1fr) auto;gap:10px;align-items:center;border-bottom:1px solid var(--border,#e5e7eb);padding:0 0 8px}
        #reportEnhancementsPanel .category-explorer-row:last-child{border-bottom:0}
        @media(max-width:760px){#reportEnhancementsPanel .drivers-grid{grid-template-columns:1fr}#reportEnhancementsPanel .category-trend-row{grid-template-columns:minmax(90px,120px) 1fr}#reportEnhancementsPanel .category-trend-value{grid-column:1/-1;text-align:right}#reportEnhancementsPanel .category-facts{grid-template-columns:1fr}#reportEnhancementsPanel .category-explorer-row{grid-template-columns:1fr auto}#reportEnhancementsPanel .category-explorer-note{grid-column:1/-1}}
      </style>
      <div class="hr"></div><div class="kpis">
        <div class="kpi"><div><div class="label">متوسط المصروف الشهري</div><div class="value" id="reportAvgExpense">-</div><div class="hint">آخر 12 شهر نشط</div></div></div>
        <div class="kpi"><div><div class="label">أفضل شهر صافي</div><div class="value" id="reportBestNet">-</div><div class="hint" id="reportBestNetMonth">-</div></div></div>
        <div class="kpi"><div><div class="label">تغير المصروف</div><div class="value" id="reportExpenseChange">-</div><div class="hint" id="reportExpenseChangeHint">حسب شهر المقارنة</div></div></div>
        <div class="kpi"><div><div class="label">الالتزام بالميزانية</div><div class="value" id="reportBudgetCommitment">-</div><div class="hint">للتصنيفات المخططة</div></div></div>
      </div>
      <div class="hr"></div><section aria-labelledby="monthlyComparisonHeading">
        <div class="comparison-head"><div><h3 id="monthlyComparisonHeading" style="margin:0 0 4px">مقارنة شهرية</h3><div class="mini" id="comparisonMonthsLabel">-</div></div><label class="comparison-control"><span class="mini">مقارنة مع</span><input type="month" id="comparisonMonthPicker" aria-label="شهر المقارنة"></label></div>
        <div class="comparison-note" id="incompleteMonthWarning" hidden>الشهر الحالي غير مكتمل؛ المقارنة مع شهر كامل قد لا تكون مباشرة.</div>
        <div class="comparison-note" id="comparisonEmptyState" hidden>لا توجد بيانات كافية للمقارنة بين الشهرين.</div>
        <div class="comparison-table-wrap"><table class="comparison-table"><thead><tr><th>المؤشر</th><th id="comparisonCurrentHeading">الشهر المحدد</th><th id="comparisonPreviousHeading">شهر المقارنة</th><th>الفرق</th><th>التغير</th></tr></thead><tbody id="monthlyComparisonBody"></tbody></table></div>
      </section>
      <div class="drivers-grid">
        <section class="driver-card" aria-labelledby="increaseDriversHeading"><h3 id="increaseDriversHeading" style="margin:0">محركات زيادة المصروف</h3><div class="driver-list" id="increaseDriversList"></div></section>
        <section class="driver-card" aria-labelledby="decreaseDriversHeading"><h3 id="decreaseDriversHeading" style="margin:0">عوامل خفض المصروف</h3><div class="driver-list" id="decreaseDriversList"></div></section>
      </div><div class="gross-summary mini" id="grossDriverSummary"></div>
      <div class="hr"></div><section aria-labelledby="reportInsightsHeading"><h3 id="reportInsightsHeading" style="margin:0 0 4px">رؤى المقارنة</h3><div class="mini">ملاحظات حسابية موجزة مشتقة من بيانات الشهرين.</div><div class="help" id="reportInsights" style="margin-top:10px"></div></section>
      <div class="hr"></div><section id="categoryAnalyticsSection" aria-labelledby="categoryAnalyticsHeading">
        <div class="category-head"><div><h3 id="categoryAnalyticsHeading" style="margin:0 0 4px">تحليل التصنيفات</h3><div class="mini">سلوك المصروف داخل كل تصنيف خلال 12 شهراً تقويمياً، دون توقعات أو أحكام.</div></div><label class="category-control" for="categoryAnalyticsSelector"><span class="mini">التصنيف المحدد</span><select id="categoryAnalyticsSelector" aria-label="اختر تصنيفاً لتحليله"></select></label></div>
        <div id="categoryAnalyticsEmpty" class="comparison-note" hidden>لا توجد بيانات مصروف كافية لتحليل التصنيفات.</div>
        <div id="categoryAnalyticsContent">
          <div class="kpis category-kpis">
            <div class="kpi"><div><div class="label">مصروف هذا الشهر</div><div class="value" id="categoryCurrentAmount">-</div><div class="hint" id="categoryCurrentChange">-</div></div></div>
            <div class="kpi"><div><div class="label">إجمالي آخر 12 شهر</div><div class="value" id="categoryTwelveTotal">-</div><div class="hint" id="categoryTwelveShare">-</div></div></div>
            <div class="kpi"><div><div class="label">متوسط 12 شهراً</div><div class="value" id="categoryCalendarAverage">-</div><div class="hint">يشمل الأشهر الصفرية</div></div></div>
            <div class="kpi"><div><div class="label">متوسط الأشهر النشطة</div><div class="value" id="categoryActiveAverage">-</div><div class="hint" id="categoryActiveCount">-</div></div></div>
            <div class="kpi"><div><div class="label">عدد العمليات</div><div class="value" id="categoryTransactionCount">-</div><div class="hint">خلال 12 شهراً</div></div></div>
            <div class="kpi"><div><div class="label">متوسط العملية</div><div class="value" id="categoryTransactionAverage">-</div><div class="hint">المبلغ ÷ عدد العمليات</div></div></div>
            <div class="kpi"><div><div class="label">الحصة من إجمالي المصروف</div><div class="value" id="categoryExpenseShare">-</div><div class="hint">خلال 12 شهراً</div></div></div>
            <div class="kpi"><div><div class="label">ترتيب التصنيف</div><div class="value" id="categoryRank">-</div><div class="hint">هذا الشهر / 12 شهراً</div></div></div>
          </div>
          <div class="category-facts" id="categoryFacts"></div>
          <div class="hr"></div><h4 style="margin:0">اتجاه التصنيف — 12 شهراً</h4><div class="mini">القيمة وعدد العمليات متاحان نصياً لكل شهر؛ طول الشريط تمثيل بصري مساعد.</div><div class="category-trend" id="categoryTrend" role="list"></div>
          <div class="help" id="categoryInsights" style="margin-top:12px"></div>
          <div class="hr"></div><h4 style="margin:0">أكبر 5 عمليات في الشهر المحدد</h4><div class="mini">عرض للقراءة فقط؛ التعديل والحذف من صفحة العمليات.</div><div class="category-explorer" id="categoryTransactions"></div>
        </div>
        <div class="hr"></div><div><h4 style="margin:0">نظرة عامة على التصنيفات</h4><div class="mini" id="categoryOverviewInsight">مرتبة حسب إجمالي آخر 12 شهراً.</div></div>
        <div class="category-overview-wrap"><table class="category-overview"><thead><tr><th>التصنيف</th><th>هذا الشهر</th><th>الشهر السابق</th><th>الفرق</th><th>إجمالي 12 شهر</th><th>الحصة من مصروف 12 شهر</th><th>الأشهر النشطة</th><th>العمليات</th><th>الترتيب</th></tr></thead><tbody id="categoryOverviewBody"></tbody></table></div>
      </section>
      <div class="hr"></div><section aria-labelledby="monthlySummaryHeading"><h3 id="monthlySummaryHeading" style="margin:0 0 4px">ملخص آخر 12 شهر</h3><div class="mini">الدخل الحقيقي، إجمالي المصروف، تكلفة المعيشة، المصروف الاستثنائي، سداد الدين، صافي الحركة، والرصيد الختامي.</div><div style="overflow:auto;margin-top:10px"><table><thead><tr><th style="min-width:130px">الشهر</th><th style="min-width:140px">الدخل الحقيقي</th><th style="min-width:140px">المصروف</th><th style="min-width:140px">تكلفة المعيشة</th><th style="min-width:140px">استثنائي</th><th style="min-width:140px">سداد دين</th><th style="min-width:140px">صافي الحركة</th><th style="min-width:140px">الرصيد الختامي</th><th style="min-width:100px">العمليات</th></tr></thead><tbody id="monthlySummaryBody"><tr><td colspan="9" class="muted">-</td></tr></tbody></table></div></section>`;
    firstSplit.insertAdjacentElement("afterend", panel);
    return panel;
  }

  function signedMoney(value) { return value === 0 ? money(0) : `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`; }
  function stateText(metric) {
    if (metric.state === "NEW") return "جديد";
    if (metric.state === "STOPPED") return metric.percentChange === null ? "توقف" : `توقف (${metric.percentChange.toFixed(1)}%)`;
    if (metric.percentChange === null) return metric.state === "UNCHANGED" ? "دون تغير" : "—";
    return `${metric.percentChange > 0 ? "+" : ""}${metric.percentChange.toFixed(1)}%`;
  }
  function renderMetricRows(comparison) {
    const definitions = [["الدخل الحقيقي", "trueIncome"], ["إجمالي المصروف", "totalExpenses"], ["تكلفة المعيشة (المصروف المنتظم)", "costOfLiving"], ["المصروف الاستثنائي", "exceptionalExpenses"], ["سداد الدين", "debtPayments"], ["التدفقات غير المعيشية", "nonLivingOutflows"], ["صافي الحركة النقدية", "netCashFlow"], ["الرصيد الختامي", "closingBalance"]];
    const favorableIncreaseMetrics = new Set(["trueIncome", "netCashFlow", "closingBalance"]);
    $("#monthlyComparisonBody").innerHTML = definitions.map(([label, key]) => {
      const metric = comparison.metrics[key];
      const favorableIncrease = favorableIncreaseMetrics.has(key);
      const adverseChange = favorableIncrease ? metric.delta < 0 : metric.delta > 0;
      const deltaClass = metric.delta === 0 ? "" : adverseChange ? "delta-up" : "delta-down";
      return `<tr><td><b>${escapeHTML(label)}</b></td><td>${money(metric.current)}</td><td>${money(metric.previous)}</td><td class="${deltaClass}">${signedMoney(metric.delta)}</td><td>${stateText(metric)}</td></tr>`;
    }).join("");
  }
  function driverMarkup(state, driver, increase) {
    const share = increase ? driver.shareOfGrossIncrease : driver.shareOfGrossDecrease;
    const shareText = share === null ? "" : ` · ${(share * 100).toFixed(1)}% من إجمالي ${increase ? "الزيادات" : "الانخفاضات"}`;
    return `<div class="driver-row"><b>${escapeHTML(categoryName(state, driver.categoryId))}</b><span class="${increase ? "delta-up" : "delta-down"}">${signedMoney(driver.delta)}</span><div class="driver-values">الحالي ${money(driver.current)} · المقارنة ${money(driver.previous)}${shareText}</div></div>`;
  }
  function renderDrivers(state, comparison) {
    const drivers = comparison.spendingDrivers;
    $("#increaseDriversList").innerHTML = drivers.increaseDrivers.length ? drivers.increaseDrivers.slice(0, 5).map((driver) => driverMarkup(state, driver, true)).join("") : '<div class="muted">لا توجد زيادات على مستوى التصنيفات.</div>';
    $("#decreaseDriversList").innerHTML = drivers.decreaseDrivers.length ? drivers.decreaseDrivers.slice(0, 5).map((driver) => driverMarkup(state, driver, false)).join("") : '<div class="muted">لا توجد انخفاضات على مستوى التصنيفات.</div>';
    $("#grossDriverSummary").innerHTML = `<span>إجمالي الزيادات: <b>${money(drivers.grossIncreaseAmount)}</b></span><span>إجمالي الانخفاضات: <b>${money(drivers.grossDecreaseAmount)}</b></span><span>صافي الفرق: <b>${signedMoney(drivers.netExpenseDelta)}</b></span>`;
  }
  function renderInsights(state, comparison) {
    const insights = $("#reportInsights");
    if (!comparison.hasAnyActivity) { insights.textContent = "لا توجد بيانات كافية للمقارنة بين الشهرين."; return; }
    const rows = ComparisonModel.generateInsights(comparison, { formatAmount: money, getCategoryName: (id) => categoryName(state, id) });
    insights.innerHTML = rows.map((row) => `<div>${escapeHTML(row)}</div>`).join("");
  }

  function percent(value) { return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`; }
  function renderCategoryAnalytics(state, activeMonth) {
    const overview = CategoryAnalyticsModel.calculateCategoryOverview(state, activeMonth, 12);
    const selector = $("#categoryAnalyticsSelector");
    const spendingIds = new Set(overview.rows.map((row) => row.categoryId));
    const categoryIds = [];
    state.categories.forEach((category) => {
      if (!category || typeof category.id !== "string" || !category.id.trim()) return;
      if (category.type === "expense" || spendingIds.has(category.id)) categoryIds.push(category.id);
    });
    overview.rows.forEach((row) => { if (!categoryIds.includes(row.categoryId)) categoryIds.push(row.categoryId); });
    if (categorySelectorActiveMonth !== activeMonth) {
      categorySelectorActiveMonth = activeMonth;
      selectedCategoryId = CategoryAnalyticsModel.getDefaultCategoryId(state, activeMonth, 12);
    }
    if (!selectedCategoryId || !categoryIds.includes(selectedCategoryId)) selectedCategoryId = CategoryAnalyticsModel.getDefaultCategoryId(state, activeMonth, 12);
    selector.innerHTML = categoryIds.length
      ? categoryIds.map((categoryId) => `<option value="${escapeHTML(categoryId)}">${escapeHTML(categoryOptionLabel(state, categoryId))}</option>`).join("")
      : '<option value="">لا يوجد تصنيف مصروف</option>';
    selector.disabled = categoryIds.length === 0;
    selector.value = selectedCategoryId || "";

    $("#categoryAnalyticsEmpty").hidden = overview.hasData;
    $("#categoryAnalyticsContent").hidden = !overview.hasData || !selectedCategoryId;
    $("#categoryOverviewBody").innerHTML = overview.rows.length ? overview.rows.map((row) => `<tr>
      <td><b>${escapeHTML(categoryOptionLabel(state, row.categoryId))}</b></td><td>${money(row.currentMonthAmount)}</td><td>${money(row.previousMonthAmount)}</td><td>${signedMoney(row.currentVsPreviousDelta)}</td><td>${money(row.twelveMonthTotal)}</td><td>${percent(row.twelveMonthExpenseShare)}</td><td>${row.activeMonthCount} / 12</td><td>${row.transactionCount12m}</td><td>${row.twelveMonthRank ?? "—"}</td>
    </tr>`).join("") : '<tr><td colspan="9" class="muted">لا توجد بيانات مصروف كافية لتحليل التصنيفات.</td></tr>';
    const leader = overview.twelveMonth[0];
    $("#categoryOverviewInsight").textContent = leader
      ? `أكبر تصنيف خلال آخر 12 شهراً هو ${categoryOptionLabel(state, leader.categoryId)} بقيمة ${money(leader.amount)}. أعلى 3 تصنيفات تمثل ${percent(overview.top3Share)} من إجمالي المصروف.`
      : "مرتبة حسب إجمالي آخر 12 شهراً.";
    if (!overview.hasData || !selectedCategoryId) return;

    const result = CategoryAnalyticsModel.calculateCategoryAnalytics(state, selectedCategoryId, activeMonth, { rankings: overview, count: 12 });
    $("#categoryCurrentAmount").textContent = money(result.currentMonthAmount);
    $("#categoryCurrentChange").textContent = `${stateText(result.currentVsPrevious)} عن الشهر السابق (${signedMoney(result.currentVsPreviousDelta)})`;
    $("#categoryTwelveTotal").textContent = money(result.twelveMonthTotal);
    $("#categoryTwelveShare").textContent = `${percent(result.twelveMonthExpenseShare)} من مصروف 12 شهراً`;
    $("#categoryCalendarAverage").textContent = money(result.twelveMonthCalendarAverage);
    $("#categoryActiveAverage").textContent = result.activeMonthAverage === null ? "—" : money(result.activeMonthAverage);
    $("#categoryActiveCount").textContent = `${result.activeMonthCount} من 12 شهراً نشطاً`;
    $("#categoryTransactionCount").textContent = String(result.transactionCount12m);
    $("#categoryTransactionAverage").textContent = result.averageTransactionAmount12m === null ? "—" : money(result.averageTransactionAmount12m);
    $("#categoryExpenseShare").textContent = percent(result.twelveMonthExpenseShare);
    $("#categoryRank").textContent = `${result.currentRank ?? "—"} / ${result.twelveMonthRank ?? "—"}`;
    $("#categoryFacts").innerHTML = [
      ["أعلى شهر", result.highestMonth ? `${monthLabel(result.highestMonth.month)} · ${money(result.highestMonth.amount)}` : "—"],
      ["أقل شهر نشط", result.lowestActiveMonth ? `${monthLabel(result.lowestActiveMonth.month)} · ${money(result.lowestActiveMonth.amount)}` : "—"],
      ["أكبر عملية", result.largestTransaction ? `${result.largestTransaction.date || "—"} · ${money(result.largestTransaction.amount)} · ${result.largestTransaction.note || "—"}` : "—"],
    ].map(([label, value]) => `<div class="category-fact"><div class="mini">${escapeHTML(label)}</div><b>${escapeHTML(value)}</b></div>`).join("");
    const maximum = Math.max(0, ...result.series.map((row) => row.amount));
    $("#categoryTrend").innerHTML = result.series.map((row) => {
      const width = maximum > 0 ? (row.amount / maximum) * 100 : 0;
      const share = row.shareOfMonthExpenses === null ? "—" : percent(row.shareOfMonthExpenses);
      return `<div class="category-trend-row" role="listitem"><b>${escapeHTML(monthLabel(row.month))}</b><div class="category-bar-track" aria-hidden="true"><div class="category-bar" style="width:${width.toFixed(2)}%"></div></div><div class="category-trend-value">${money(row.amount)} · ${row.transactionCount} عملية · ${share}</div></div>`;
    }).join("");
    const insightRows = [
      `${categoryName(state, selectedCategoryId)} ظهر في ${result.activeMonthCount} من آخر 12 شهراً.`,
      `إجمالي ${categoryName(state, selectedCategoryId)} خلال 12 شهراً هو ${money(result.twelveMonthTotal)}.`,
    ];
    if (result.highestMonth) insightRows.push(`أعلى شهر كان ${monthLabel(result.highestMonth.month)} بقيمة ${money(result.highestMonth.amount)}.`);
    if (result.currentVsPreviousDelta > 0) insightRows.push(`مصروف هذا الشهر أعلى من الشهر السابق بمقدار ${money(result.currentVsPreviousDelta)}.`);
    else if (result.currentVsPreviousDelta < 0) insightRows.push(`مصروف هذا الشهر أقل من الشهر السابق بمقدار ${money(Math.abs(result.currentVsPreviousDelta))}.`);
    else insightRows.push("مصروف هذا الشهر مساوٍ للشهر السابق.");
    $("#categoryInsights").innerHTML = insightRows.slice(0, 4).map((row) => `<div>${escapeHTML(row)}</div>`).join("");
    $("#categoryTransactions").innerHTML = result.currentMonthTopTransactions.length
      ? result.currentMonthTopTransactions.map((transaction) => `<div class="category-explorer-row"><time datetime="${escapeHTML(transaction.date || "")}">${escapeHTML(transaction.date || "—")}</time><span class="category-explorer-note">${escapeHTML(transaction.note || "—")}</span><b>${money(transaction.amount)}</b></div>`).join("")
      : '<div class="muted">لا توجد عمليات لهذا التصنيف في الشهر المحدد.</div>';
  }

  function renderEnhancedReports() {
    if (!ensureReportsPanel()) return;
    const state = loadState();
    const activeMonth = $("#monthPicker")?.value || new Date().toISOString().slice(0, 7);
    if (selectorActiveMonth !== activeMonth) { selectorActiveMonth = activeMonth; selectedComparisonMonth = ComparisonModel.addMonths(activeMonth, -1); }
    const picker = $("#comparisonMonthPicker");
    if (picker && picker.value !== selectedComparisonMonth) picker.value = selectedComparisonMonth;
    const comparison = ComparisonModel.calculateMonthlyComparison(state, activeMonth, selectedComparisonMonth);
    const series = lastMonths(activeMonth, 12).map((month) => totalsForMonth(state, month));
    const monthsWithExpense = series.filter((row) => row.expense > 0);
    const avgExpense = monthsWithExpense.reduce((sum, row) => sum + row.expense, 0) / Math.max(1, monthsWithExpense.length);
    const bestNet = series.reduce((best, row) => (!best || row.net > best.net ? row : best), null);
    const budgetAnalytics = BudgetModel.calculateBudgetAnalytics(state, activeMonth);
    const commitment = budgetAnalytics.budgetedCategoryCount > 0 ? ((budgetAnalytics.budgetedCategoryCount - budgetAnalytics.exceededCategoryCount) / budgetAnalytics.budgetedCategoryCount) * 100 : null;
    $("#reportAvgExpense").textContent = avgExpense > 0 ? money(avgExpense) : "-";
    $("#reportBestNet").textContent = bestNet ? money(bestNet.net) : "-";
    $("#reportBestNetMonth").textContent = bestNet ? monthLabel(bestNet.month) : "-";
    $("#reportExpenseChange").textContent = stateText(comparison.metrics.totalExpenses);
    $("#reportExpenseChangeHint").textContent = `مقارنة مع ${monthLabel(comparison.comparisonMonth)}`;
    $("#reportBudgetCommitment").textContent = commitment === null ? "-" : `${commitment.toFixed(0)}%`;
    $("#comparisonMonthsLabel").textContent = `${monthLabel(activeMonth)} مقابل ${monthLabel(comparison.comparisonMonth)}`;
    $("#comparisonCurrentHeading").textContent = monthLabel(activeMonth); $("#comparisonPreviousHeading").textContent = monthLabel(comparison.comparisonMonth);
    $("#incompleteMonthWarning").hidden = !ComparisonModel.isIncompleteCurrentMonth(activeMonth, new Date());
    $("#comparisonEmptyState").hidden = comparison.hasAnyActivity;
    renderMetricRows(comparison); renderDrivers(state, comparison); renderInsights(state, comparison); renderCategoryAnalytics(state, activeMonth);
    $("#monthlySummaryBody").innerHTML = series.slice().reverse().map((row) => `<tr><td><b>${escapeHTML(monthLabel(row.month))}</b></td><td>${money(row.income)}</td><td>${money(row.expense)}</td><td>${money(row.costOfLiving)}</td><td>${money(row.exceptionalExpenses)}</td><td>${money(row.debtPayments)}</td><td>${money(row.net)}</td><td>${money(row.closingBalance)}</td><td>${row.count}</td></tr>`).join("");
  }
  function scheduleRender() {
    const run = () => { try { renderEnhancedReports(); } catch (error) { console.error("Report enhancements failed", error); } };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run); else setTimeout(run, 0);
  }
  document.addEventListener("DOMContentLoaded", scheduleRender); window.addEventListener("pfm:changed", scheduleRender); window.addEventListener("pfm:apply", scheduleRender);
  document.addEventListener("click", (event) => { const target = event.target; if (target instanceof Element && target.matches("#btnRefreshReports, #tabs .tab[data-tab='reports']")) setTimeout(scheduleRender, 50); });
  document.addEventListener("change", (event) => {
    const target = event.target; if (!(target instanceof Element)) return;
    if (target.matches("#monthPicker")) scheduleRender();
    if (target.matches("#comparisonMonthPicker")) { selectedComparisonMonth = target.value || ComparisonModel.addMonths(selectorActiveMonth, -1); scheduleRender(); }
    if (target.matches("#categoryAnalyticsSelector")) { selectedCategoryId = target.value || null; scheduleRender(); }
  });
  try { renderEnhancedReports(); } catch (error) { console.error("Report enhancements failed", error); }
  scheduleRender(); setTimeout(scheduleRender, 300);
})();
