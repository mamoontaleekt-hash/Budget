(function () {
  "use strict";

  const STORAGE_KEY = "pfm_data_v1";
  const FinancialModel = window.PFMFinancialModel;
  if (!FinancialModel) throw new Error("Financial model failed to load for reports");
  const fmt = new Intl.NumberFormat("ar-IQ", {
    style: "currency",
    currency: "IQD",
    maximumFractionDigits: 0,
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const money = (value) => fmt.format(Math.round(Number(value) || 0));
  const monthFromDate = (iso) => String(iso || "").slice(0, 7);
  const escapeHTML = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        budgets: parsed.budgets && typeof parsed.budgets === "object" ? parsed.budgets : {},
        financialSettings:
          parsed.financialSettings && typeof parsed.financialSettings === "object"
            ? parsed.financialSettings
            : undefined,
      };
    } catch (error) {
      console.warn("Report enhancements could not read local data", error);
      return { categories: [], transactions: [], budgets: {} };
    }
  }

  function monthLabel(month) {
    const [year, rawMonth] = String(month || "").split("-").map(Number);
    if (!year || !rawMonth) return month || "-";
    return new Intl.DateTimeFormat("ar-IQ", { month: "short", year: "numeric" }).format(
      new Date(year, rawMonth - 1, 1)
    );
  }

  function addMonths(month, delta) {
    const [year, rawMonth] = String(month || "").split("-").map(Number);
    const date = new Date(year || new Date().getFullYear(), (rawMonth || 1) - 1 + delta, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function lastMonths(activeMonth, count) {
    const months = [];
    for (let i = count - 1; i >= 0; i -= 1) months.push(addMonths(activeMonth, -i));
    return months;
  }

  function txInMonth(state, month) {
    return state.transactions.filter((tx) => !tx.deletedAt && monthFromDate(tx.date) === month);
  }

  function totalsForMonth(state, month) {
    const financials = FinancialModel.calculateMonthFinancials(state, month);
    return {
      month,
      income: financials.trueIncome,
      expense: financials.totalExpenses,
      net: financials.netCashFlow,
      closingBalance: financials.closingBalance,
      count: financials.transactions.length,
    };
  }

  function categoryName(state, id) {
    return state.categories.find((category) => category.id === id)?.name || "غير مصنف";
  }

  function expenseByCategory(state, month) {
    const map = {};
    txInMonth(state, month)
      .filter((tx) => tx.type === "expense")
      .forEach((tx) => {
        const id = tx.categoryId || "uncat";
        map[id] = (map[id] || 0) + (Number(tx.amount) || 0);
      });
    return map;
  }

  function budgetForMonth(state, month) {
    return state.budgets?.[month] || { plan: {}, items: {} };
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
      <div class="hr"></div>
      <div class="kpis">
        <div class="kpi">
          <div>
            <div class="label">متوسط المصروف الشهري</div>
            <div class="value" id="reportAvgExpense">-</div>
            <div class="hint">آخر 12 شهر</div>
          </div>
        </div>
        <div class="kpi">
          <div>
            <div class="label">أفضل شهر صافي</div>
            <div class="value" id="reportBestNet">-</div>
            <div class="hint" id="reportBestNetMonth">-</div>
          </div>
        </div>
        <div class="kpi">
          <div>
            <div class="label">تغير المصروف</div>
            <div class="value" id="reportExpenseChange">-</div>
            <div class="hint">مقارنة بالشهر السابق</div>
          </div>
        </div>
        <div class="kpi">
          <div>
            <div class="label">الالتزام بالميزانية</div>
            <div class="value" id="reportBudgetCommitment">-</div>
            <div class="hint">للتصنيفات المخططة</div>
          </div>
        </div>
      </div>

      <div class="hr"></div>
      <div style="font-weight:800;margin-bottom:4px">رؤى الشهر</div>
      <div class="mini">ملخص سريع يساعدك تعرف أين تغيّر الصرف وما الذي يحتاج انتباه.</div>
      <div class="help" id="reportInsights" style="margin-top:10px"></div>

      <div class="hr"></div>
      <div style="font-weight:800;margin-bottom:4px">ملخص آخر 12 شهر</div>
      <div class="mini">دخل الشهر الحقيقي، المصروف، صافي الحركة، الرصيد الختامي، وعدد العمليات.</div>
      <div style="overflow:auto;margin-top:10px">
        <table>
          <thead>
            <tr>
              <th style="min-width:130px">الشهر</th>
              <th style="min-width:140px">الدخل الحقيقي</th>
              <th style="min-width:140px">المصروف</th>
              <th style="min-width:140px">صافي الحركة</th>
              <th style="min-width:140px">الرصيد الختامي</th>
              <th style="min-width:100px">العمليات</th>
            </tr>
          </thead>
          <tbody id="monthlySummaryBody">
            <tr><td colspan="6" class="muted">-</td></tr>
          </tbody>
        </table>
      </div>
    `;

    firstSplit.insertAdjacentElement("afterend", panel);
    return panel;
  }

  function renderInsights({ current, previous, avgExpense, topCategory, plannedCount, overBudgetCount }) {
    const insights = $("#reportInsights");
    if (!insights) return;

    const rows = [];
    if (current.income <= 0 && current.expense <= 0) {
      rows.push("لا توجد بيانات كافية لهذا الشهر بعد.");
    } else {
      rows.push(`صافي حركة دخل هذا الشهر ${money(current.net)} بعد مصروف ${money(current.expense)}.`);
      if (current.net < 0 && current.closingBalance >= 0) {
        rows.push(`مصاريف الشهر أعلى من دخله، لكن الرصيد الختامي ما زال موجباً عند ${money(current.closingBalance)}.`);
      }
    }

    if (previous.expense > 0) {
      const change = current.expense - previous.expense;
      const pct = (change / previous.expense) * 100;
      const direction = change > 0 ? "ارتفع" : change < 0 ? "انخفض" : "لم يتغير";
      rows.push(`المصروف ${direction} عن الشهر السابق بمقدار ${money(Math.abs(change))} (${Math.abs(pct).toFixed(1)}%).`);
    } else if (current.expense > 0) {
      rows.push("هذا أول شهر فيه مصاريف ضمن المقارنة الحالية.");
    }

    if (topCategory) {
      rows.push(`أكبر تصنيف صرف هو ${topCategory.label} بقيمة ${money(topCategory.value)}.`);
    }

    if (avgExpense > 0) {
      const diff = current.expense - avgExpense;
      rows.push(
        diff > 0
          ? `صرف هذا الشهر أعلى من متوسط آخر 12 شهر بمقدار ${money(diff)}.`
          : `صرف هذا الشهر أقل من متوسط آخر 12 شهر بمقدار ${money(Math.abs(diff))}.`
      );
    }

    if (plannedCount > 0) {
      rows.push(
        overBudgetCount > 0
          ? `${overBudgetCount} تصنيف مخطط تجاوز الميزانية هذا الشهر.`
          : "كل التصنيفات المخططة ما زالت ضمن الميزانية."
      );
    }

    insights.innerHTML = rows.map((row) => `<div>${escapeHTML(row)}</div>`).join("");
  }

  function signedExpenseChange(current, previous) {
    if (previous.expense <= 0) return current.expense > 0 ? "جديد" : "-";
    const pct = ((current.expense - previous.expense) / previous.expense) * 100;
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  }

  function renderEnhancedReports() {
    if (!ensureReportsPanel()) return;

    const state = loadState();
    const activeMonth = $("#monthPicker")?.value || new Date().toISOString().slice(0, 7);
    const months = lastMonths(activeMonth, 12);
    const series = months.map((month) => totalsForMonth(state, month));
    const current = totalsForMonth(state, activeMonth);
    const previous = totalsForMonth(state, addMonths(activeMonth, -1));
    const monthsWithExpense = series.filter((row) => row.expense > 0);
    const avgExpense =
      monthsWithExpense.reduce((sum, row) => sum + row.expense, 0) / Math.max(1, monthsWithExpense.length);
    const bestNet = series.reduce((best, row) => (row.net > best.net ? row : best), series[0] || current);

    const byCategory = expenseByCategory(state, activeMonth);
    const topCategory = Object.entries(byCategory)
      .map(([id, value]) => ({ label: categoryName(state, id), value }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)[0];

    const budget = budgetForMonth(state, activeMonth);
    const planned = state.categories
      .filter((category) => category.type === "expense")
      .map((category) => {
        const plannedAmount = Number(budget.items?.[category.id]?.amount || 0);
        const actual = Number(byCategory[category.id] || 0);
        return { plannedAmount, actual };
      })
      .filter((row) => row.plannedAmount > 0);
    const overBudgetCount = planned.filter((row) => row.actual > row.plannedAmount).length;
    const commitment = planned.length > 0 ? ((planned.length - overBudgetCount) / planned.length) * 100 : null;

    $("#reportAvgExpense").textContent = avgExpense > 0 ? money(avgExpense) : "-";
    $("#reportBestNet").textContent = bestNet ? money(bestNet.net) : "-";
    $("#reportBestNetMonth").textContent = bestNet ? monthLabel(bestNet.month) : "-";
    $("#reportExpenseChange").textContent = signedExpenseChange(current, previous);
    $("#reportBudgetCommitment").textContent = commitment === null ? "-" : `${commitment.toFixed(0)}%`;

    renderInsights({ current, previous, avgExpense, topCategory, plannedCount: planned.length, overBudgetCount });

    const monthlySummary = $("#monthlySummaryBody");
    if (monthlySummary) {
      monthlySummary.innerHTML = series
        .slice()
        .reverse()
        .map(
          (row) => `<tr>
            <td><b>${escapeHTML(monthLabel(row.month))}</b></td>
            <td>${money(row.income)}</td>
            <td>${money(row.expense)}</td>
            <td>${money(row.net)}</td>
            <td>${money(row.closingBalance)}</td>
            <td>${row.count}</td>
          </tr>`
        )
        .join("");
    }
  }

  function scheduleRender() {
    const run = () => {
      try {
        renderEnhancedReports();
      } catch (error) {
        console.error("Report enhancements failed", error);
      }
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  document.addEventListener("DOMContentLoaded", scheduleRender);
  window.addEventListener("pfm:changed", scheduleRender);
  window.addEventListener("pfm:apply", scheduleRender);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches("#btnRefreshReports, #tabs .tab[data-tab='reports']")) {
      setTimeout(scheduleRender, 50);
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target instanceof Element && event.target.matches("#monthPicker")) scheduleRender();
  });

  try {
    renderEnhancedReports();
  } catch (error) {
    console.error("Report enhancements failed", error);
  }
  scheduleRender();
  setTimeout(scheduleRender, 300);
})();

