(function () {
  "use strict";
  const STORAGE_KEY = "pfm_data_v1";
  const FinancialModel = window.PFMFinancialModel;
  const ExpenseModel = window.PFMExpenseModel;
  const BudgetModel = window.PFMBudgetModel;
  const ComparisonModel = window.PFMComparisonModel;
  if (!FinancialModel || !ExpenseModel || !BudgetModel || !ComparisonModel) throw new Error("A report model failed to load");
  const fmt = new Intl.NumberFormat("ar-IQ", { style: "currency", currency: "IQD", maximumFractionDigits: 0 });
  const $ = (selector, root = document) => root.querySelector(selector);
  const money = (value) => fmt.format(Math.round(Number(value) || 0));
  const escapeHTML = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  let selectorActiveMonth = null;
  let selectedComparisonMonth = null;

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
    if (categoryId === ComparisonModel.UNCATEGORIZED) return "غير مصنف";
    return state.categories.find((category) => category?.id === categoryId)?.name || "تصنيف غير موجود";
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
        @media(max-width:760px){#reportEnhancementsPanel .drivers-grid{grid-template-columns:1fr}}
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
    renderMetricRows(comparison); renderDrivers(state, comparison); renderInsights(state, comparison);
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
  });
  try { renderEnhancedReports(); } catch (error) { console.error("Report enhancements failed", error); }
  scheduleRender(); setTimeout(scheduleRender, 300);
})();
