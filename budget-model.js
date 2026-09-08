(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMBudgetModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NO_BUDGET = "NO_BUDGET";
  const OK = "OK";
  const WARNING = "WARNING";
  const AT_LIMIT = "AT_LIMIT";
  const EXCEEDED = "EXCEEDED";
  const WARNING_THRESHOLD = 0.8;
  const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function finiteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string" || value.trim() === "") return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function positiveAmount(value) {
    const number = finiteNumber(value);
    return number > 0 ? number : 0;
  }

  function getMonthBudget(state, month) {
    const budget = isRecord(state?.budgets) && isRecord(state.budgets[month])
      ? state.budgets[month]
      : null;
    return budget || { plan: { income1: 0, income2: 0, note: "" }, items: {} };
  }

  function getCategoryBudget(state, month, categoryId) {
    const items = getMonthBudget(state, month).items;
    return isRecord(items) && isRecord(items[categoryId]) ? items[categoryId] : null;
  }

  function calculateCategoryActuals(state, month) {
    const actuals = {};
    if (!MONTH_PATTERN.test(String(month || ""))) return actuals;
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    transactions.forEach((transaction) => {
      if (!isRecord(transaction)
        || transaction.type !== "expense"
        || transaction.deletedAt
        || String(transaction.date || "").slice(0, 7) !== month) return;
      const amount = positiveAmount(transaction.amount);
      if (amount <= 0) return;
      const categoryId = typeof transaction.categoryId === "string" && transaction.categoryId.length > 0
        ? transaction.categoryId
        : "uncat";
      actuals[categoryId] = (actuals[categoryId] || 0) + amount;
    });
    return actuals;
  }

  function calculateCategoryBudgetStatus(planned, actual) {
    const plannedAmount = positiveAmount(planned);
    const actualAmount = positiveAmount(actual);
    if (plannedAmount <= 0) {
      return {
        plannedAmount: 0,
        actualAmount,
        remainingAmount: null,
        percentUsed: null,
        status: NO_BUDGET,
      };
    }

    const remainingAmount = plannedAmount - actualAmount;
    const percentUsed = (actualAmount / plannedAmount) * 100;
    let status = OK;
    if (actualAmount > plannedAmount) status = EXCEEDED;
    else if (actualAmount === plannedAmount) status = AT_LIMIT;
    else if (actualAmount / plannedAmount >= WARNING_THRESHOLD) status = WARNING;

    return { plannedAmount, actualAmount, remainingAmount, percentUsed, status };
  }

  function calculateBudgetAnalytics(state, month) {
    const budget = getMonthBudget(state, month);
    const items = isRecord(budget.items) ? budget.items : {};
    const actualsByCategory = calculateCategoryActuals(state, month);
    const categoryIds = new Set([...Object.keys(items), ...Object.keys(actualsByCategory)]);
    const categories = Array.from(categoryIds).map((categoryId) => ({
      categoryId,
      ...calculateCategoryBudgetStatus(items[categoryId]?.amount, actualsByCategory[categoryId]),
    }));

    const budgeted = categories.filter((row) => row.plannedAmount > 0);
    const unbudgeted = categories.filter((row) => row.plannedAmount <= 0 && row.actualAmount > 0);
    const plannedBudgetTotal = budgeted.reduce((sum, row) => sum + row.plannedAmount, 0);
    const budgetedActualTotal = budgeted.reduce((sum, row) => sum + row.actualAmount, 0);
    const unbudgetedActualTotal = unbudgeted.reduce((sum, row) => sum + row.actualAmount, 0);
    const totalExpenseActual = budgetedActualTotal + unbudgetedActualTotal;
    const plan = isRecord(budget.plan) ? budget.plan : {};
    const plannedIncomeTotal = finiteNumber(plan.income1) + finiteNumber(plan.income2);
    const alerts = budgeted
      .filter((row) => row.status === WARNING || row.status === AT_LIMIT || row.status === EXCEEDED)
      .sort((a, b) => {
        const severity = { [EXCEEDED]: 3, [AT_LIMIT]: 2, [WARNING]: 1 };
        return severity[b.status] - severity[a.status] || b.percentUsed - a.percentUsed;
      });
    const overallStatus = budgeted.length === 0
      ? NO_BUDGET
      : budgeted.some((row) => row.status === EXCEEDED)
        ? EXCEEDED
        : budgeted.some((row) => row.status === AT_LIMIT)
          ? AT_LIMIT
          : budgeted.some((row) => row.status === WARNING)
            ? WARNING
            : OK;

    return {
      month,
      plannedBudgetTotal,
      allocatedBudgetTotal: plannedBudgetTotal,
      budgetedActualTotal,
      unbudgetedActualTotal,
      totalExpenseActual,
      remainingBudgetTotal: plannedBudgetTotal - budgetedActualTotal,
      plannedIncomeTotal,
      plannedUnallocated: plannedIncomeTotal - plannedBudgetTotal,
      allocationExceedsPlannedIncome: plannedIncomeTotal > 0 && plannedBudgetTotal > plannedIncomeTotal,
      overallStatus,
      budgetedCategoryCount: budgeted.length,
      warningCategoryCount: budgeted.filter((row) => row.status === WARNING).length,
      atLimitCategoryCount: budgeted.filter((row) => row.status === AT_LIMIT).length,
      exceededCategoryCount: budgeted.filter((row) => row.status === EXCEEDED).length,
      actualsByCategory,
      categories,
      alerts,
    };
  }

  return {
    NO_BUDGET,
    OK,
    WARNING,
    AT_LIMIT,
    EXCEEDED,
    WARNING_THRESHOLD,
    getMonthBudget,
    getCategoryBudget,
    calculateCategoryActuals,
    calculateCategoryBudgetStatus,
    calculateBudgetAnalytics,
  };
});
