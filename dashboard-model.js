(function (root, factory) {
  const load = (path, browserValue) =>
    typeof module === "object" && module.exports ? require(path) : browserValue;
  const api = factory(
    load("./financial-model.js", root.PFMFinancialModel),
    load("./expense-model.js", root.PFMExpenseModel),
    load("./debt-model.js", root.PFMDebtModel),
    load("./budget-model.js", root.PFMBudgetModel),
    load("./comparison-model.js", root.PFMComparisonModel),
    load("./category-analytics-model.js", root.PFMCategoryAnalyticsModel)
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMDashboardModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (
  FinancialModel,
  ExpenseModel,
  DebtModel,
  BudgetModel,
  ComparisonModel,
  CategoryAnalyticsModel
) {
  "use strict";

  if (!FinancialModel || !ExpenseModel || !DebtModel || !BudgetModel || !ComparisonModel || !CategoryAnalyticsModel) {
    throw new Error("Phase 1-8 models are required by dashboard model");
  }

  const MAX_ATTENTION_ITEMS = 3;

  function dateOnly(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function localDate(value) {
    const normalized = dateOnly(value);
    if (!normalized) return new Date(NaN);
    const [year, month, day] = normalized.split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function hasFinancialActivity(financials) {
    return financials.trueIncome !== 0 || financials.totalExpenses !== 0 ||
      financials.openingBalance !== 0 || financials.closingBalance !== 0;
  }

  function calculateComparison(state, activeMonth, today, prepared) {
    const comparisonMonth = FinancialModel.getPreviousMonth(activeMonth);
    const currentFinancials = prepared?.financials || FinancialModel.calculateMonthFinancials(state, activeMonth);
    const previousFinancials = FinancialModel.calculateMonthFinancials(state, comparisonMonth);
    const currentExpenses = prepared?.expenses || ExpenseModel.calculateExpenseAnalytics(state, activeMonth);
    const previousExpenses = ExpenseModel.calculateExpenseAnalytics(state, comparisonMonth);
    const metrics = {
      totalExpenses: ComparisonModel.compareMetric(currentFinancials.totalExpenses, previousFinancials.totalExpenses),
      costOfLiving: ComparisonModel.compareMetric(currentExpenses.costOfLiving, previousExpenses.costOfLiving),
      netCashFlow: ComparisonModel.compareMetric(currentFinancials.netCashFlow, previousFinancials.netCashFlow, { supportsPercent: false }),
    };
    const spendingDrivers = ComparisonModel.calculateSpendingDrivers(state, activeMonth, comparisonMonth);
    const hasAnyActivity = hasFinancialActivity(currentFinancials) || hasFinancialActivity(previousFinancials);
    return {
      currentMonth: activeMonth,
      comparisonMonth,
      metrics,
      spendingDrivers,
      hasAnyActivity,
      isIncompleteCurrentMonth: ComparisonModel.isIncompleteCurrentMonth(activeMonth, localDate(today)),
    };
  }

  function selectDriverHighlight(comparison) {
    if (!comparison.hasAnyActivity) return null;
    const total = comparison.metrics.totalExpenses;
    if (total.delta > 0 && comparison.spendingDrivers.increaseDrivers[0]) {
      return { kind: "increase", driver: comparison.spendingDrivers.increaseDrivers[0] };
    }
    if (total.delta < 0 && comparison.spendingDrivers.decreaseDrivers[0]) {
      return { kind: "decrease", driver: comparison.spendingDrivers.decreaseDrivers[0] };
    }
    if (total.delta === 0 && comparison.spendingDrivers.compositionChanged) {
      return { kind: "composition_changed", driver: null };
    }
    return null;
  }

  function calculateDebtAttention(debtSummary, today) {
    const referenceDate = dateOnly(today);
    if (debtSummary.totalOverdue > 0) {
      return { state: "overdue", amount: debtSummary.totalOverdue, due: debtSummary.nearestDue };
    }
    if (debtSummary.nearestDue?.date === referenceDate) {
      return { state: "due_today", amount: debtSummary.nearestDue.amount, due: debtSummary.nearestDue };
    }
    if (debtSummary.nearestDue) {
      return { state: "upcoming", amount: debtSummary.nearestDue.amount, due: debtSummary.nearestDue };
    }
    return { state: debtSummary.activeCount > 0 ? "unknown" : "none", amount: 0, due: null };
  }

  function calculateAttention(financials, comparison, budget, debt) {
    const candidates = [];
    let order = 0;
    const add = (priority, item) => candidates.push({ ...item, priority, order: order++ });

    if (debt.totalOverdue > 0) add(1, { type: "overdue_debt", target: "debts", amount: debt.totalOverdue });
    budget.alerts.forEach((alert) => {
      const priorities = {
        [BudgetModel.EXCEEDED]: 2,
        [BudgetModel.AT_LIMIT]: 3,
        [BudgetModel.WARNING]: 4,
      };
      if (priorities[alert.status]) add(priorities[alert.status], {
        type: "budget_alert",
        target: "budgets",
        categoryId: alert.categoryId,
        status: alert.status,
        actualAmount: alert.actualAmount,
        plannedAmount: alert.plannedAmount,
        percentUsed: alert.percentUsed,
        amount: alert.status === BudgetModel.EXCEEDED ? alert.actualAmount - alert.plannedAmount : alert.actualAmount,
      });
    });
    if (financials.closingBalance < 0) add(5, { type: "negative_closing", target: "reports", amount: Math.abs(financials.closingBalance) });
    if (financials.netCashFlow < 0) add(6, { type: "negative_net", target: "reports", amount: Math.abs(financials.netCashFlow) });
    if (comparison.hasAnyActivity && comparison.metrics.totalExpenses.delta > 0) {
      add(7, { type: "expense_increase", target: "reports", amount: comparison.metrics.totalExpenses.delta, percentChange: comparison.metrics.totalExpenses.percentChange });
    }
    if (budget.unbudgetedActualTotal > 0) add(8, { type: "unbudgeted_spending", target: "budgets", amount: budget.unbudgetedActualTotal });

    const items = candidates
      .sort((left, right) => left.priority - right.priority || left.order - right.order)
      .slice(0, MAX_ATTENTION_ITEMS)
      .map(({ order: ignored, ...item }) => item);
    return items.length ? items : [{ type: "quiet", target: null, priority: 99, amount: 0 }];
  }

  function calculateDashboardSummary(state, activeMonth, today) {
    const safeState = state && typeof state === "object" ? state : {};
    const referenceDate = dateOnly(today) || dateOnly();
    const financials = FinancialModel.calculateMonthFinancials(safeState, activeMonth);
    const expenses = ExpenseModel.calculateExpenseAnalytics(safeState, activeMonth);
    const comparison = calculateComparison(safeState, activeMonth, referenceDate, { financials, expenses });
    const categoryRankings = CategoryAnalyticsModel.calculateCategoryRankings(safeState, activeMonth, 1);
    const budget = BudgetModel.calculateBudgetAnalytics(safeState, activeMonth);
    const debt = DebtModel.calculateSummary(safeState, referenceDate);
    return {
      activeMonth,
      referenceDate,
      financials,
      expenses,
      comparison,
      categoryRankings,
      topCategory: categoryRankings.current[0] || null,
      budget,
      debt,
      debtAttention: calculateDebtAttention(debt, referenceDate),
      driverHighlight: selectDriverHighlight(comparison),
      attention: calculateAttention(financials, comparison, budget, debt),
      maxAttentionItems: MAX_ATTENTION_ITEMS,
    };
  }

  return {
    MAX_ATTENTION_ITEMS,
    calculateDashboardSummary,
    calculateComparison,
    calculateDebtAttention,
    selectDriverHighlight,
    calculateAttention,
  };
});
