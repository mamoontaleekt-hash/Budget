(function (root, factory) {
  const financialModel =
    typeof module === "object" && module.exports
      ? require("./financial-model.js")
      : root.PFMFinancialModel;
  const expenseModel =
    typeof module === "object" && module.exports
      ? require("./expense-model.js")
      : root.PFMExpenseModel;
  const api = factory(financialModel, expenseModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMComparisonModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (FinancialModel, ExpenseModel) {
  "use strict";

  if (!FinancialModel) throw new Error("Financial model is required by comparison model");
  if (!ExpenseModel) throw new Error("Expense model is required by comparison model");

  const UNCATEGORIZED = "uncat";
  const EPSILON = 1e-8;

  function finiteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function addMonths(month, delta) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ""));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function comparisonState(current, previous) {
    if (current === previous) return "UNCHANGED";
    if (previous === 0 && current > 0) return "NEW";
    if (previous > 0 && current === 0) return "STOPPED";
    return current > previous ? "INCREASED" : "DECREASED";
  }

  function compareMetric(currentValue, previousValue, options) {
    const current = finiteNumber(currentValue) ?? 0;
    const previous = finiteNumber(previousValue) ?? 0;
    const delta = current - previous;
    const supportsPercent = options?.supportsPercent !== false;
    const percentChange = supportsPercent && previous > 0 && current >= 0
      ? (delta / previous) * 100
      : null;
    return {
      current,
      previous,
      delta,
      absoluteDelta: Math.abs(delta),
      percentChange: Number.isFinite(percentChange) ? percentChange : null,
      state: comparisonState(current, previous),
    };
  }

  function getMonthCategoryExpenses(state, month) {
    const totals = Object.create(null);
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    transactions.forEach((transaction) => {
      if (!transaction || transaction.deletedAt || transaction.type !== "expense") return;
      if (String(transaction.date || "").slice(0, 7) !== month) return;
      const amount = finiteNumber(transaction.amount);
      if (amount === null || amount <= 0) return;
      const rawCategoryId = typeof transaction.categoryId === "string" ? transaction.categoryId.trim() : "";
      const categoryId = rawCategoryId || UNCATEGORIZED;
      totals[categoryId] = (totals[categoryId] || 0) + amount;
    });
    return totals;
  }

  function compareExpenseCategories(state, currentMonth, comparisonMonth) {
    const currentTotals = getMonthCategoryExpenses(state, currentMonth);
    const previousTotals = getMonthCategoryExpenses(state, comparisonMonth);
    const categoryIds = new Set([...Object.keys(currentTotals), ...Object.keys(previousTotals)]);
    return [...categoryIds]
      .sort()
      .map((categoryId) => ({
        categoryId,
        ...compareMetric(currentTotals[categoryId] || 0, previousTotals[categoryId] || 0),
        currentAmount: currentTotals[categoryId] || 0,
        previousAmount: previousTotals[categoryId] || 0,
      }));
  }

  function calculateSpendingDrivers(state, currentMonth, comparisonMonth) {
    const categories = compareExpenseCategories(state, currentMonth, comparisonMonth);
    const increaseDrivers = categories
      .filter((item) => item.delta > 0)
      .sort((a, b) => b.delta - a.delta || a.categoryId.localeCompare(b.categoryId));
    const decreaseDrivers = categories
      .filter((item) => item.delta < 0)
      .sort((a, b) => b.absoluteDelta - a.absoluteDelta || a.categoryId.localeCompare(b.categoryId));
    const unchanged = categories.filter((item) => item.delta === 0);
    const grossIncreaseAmount = increaseDrivers.reduce((sum, item) => sum + item.delta, 0);
    const grossDecreaseAmount = decreaseDrivers.reduce((sum, item) => sum + item.absoluteDelta, 0);

    increaseDrivers.forEach((item) => {
      item.shareOfGrossIncrease = grossIncreaseAmount > 0 ? item.delta / grossIncreaseAmount : null;
      item.shareOfGrossDecrease = null;
    });
    decreaseDrivers.forEach((item) => {
      item.shareOfGrossIncrease = null;
      item.shareOfGrossDecrease = grossDecreaseAmount > 0 ? item.absoluteDelta / grossDecreaseAmount : null;
    });
    unchanged.forEach((item) => {
      item.shareOfGrossIncrease = null;
      item.shareOfGrossDecrease = null;
    });

    const currentCategoryTotal = categories.reduce((sum, item) => sum + item.current, 0);
    const comparisonCategoryTotal = categories.reduce((sum, item) => sum + item.previous, 0);
    const netExpenseDelta = grossIncreaseAmount - grossDecreaseAmount;
    return {
      categories,
      increaseDrivers,
      decreaseDrivers,
      unchanged,
      grossIncreaseAmount,
      grossDecreaseAmount,
      netExpenseDelta,
      currentCategoryTotal,
      comparisonCategoryTotal,
      compositionChanged: increaseDrivers.length > 0 || decreaseDrivers.length > 0,
    };
  }

  function approximatelyEqual(left, right) {
    return Math.abs(left - right) <= EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
  }

  function calculateHistoricalContext(state, currentMonth, currentExpense) {
    const expenses = [];
    for (let offset = 1; offset <= 6; offset += 1) {
      const month = addMonths(currentMonth, -offset);
      if (month) expenses.push(FinancialModel.calculateMonthFinancials(state, month).totalExpenses);
    }
    const averageExpense = expenses.length
      ? expenses.reduce((sum, amount) => sum + amount, 0) / expenses.length
      : 0;
    const difference = currentExpense - averageExpense;
    const percentFromAverage = averageExpense > 0 ? (difference / averageExpense) * 100 : null;
    return {
      monthsConsidered: expenses.length,
      averageExpense,
      difference,
      percentFromAverage,
      isUnusual: percentFromAverage !== null && Math.abs(percentFromAverage) >= 25,
    };
  }

  function calculateMonthlyComparison(state, currentMonth, comparisonMonth) {
    const resolvedComparisonMonth = comparisonMonth || FinancialModel.getPreviousMonth(currentMonth);
    const currentFinancials = FinancialModel.calculateMonthFinancials(state, currentMonth);
    const comparisonFinancials = FinancialModel.calculateMonthFinancials(state, resolvedComparisonMonth);
    const currentExpenses = ExpenseModel.calculateExpenseAnalytics(state, currentMonth);
    const comparisonExpenses = ExpenseModel.calculateExpenseAnalytics(state, resolvedComparisonMonth);
    const spendingDrivers = calculateSpendingDrivers(state, currentMonth, resolvedComparisonMonth);

    const metrics = {
      trueIncome: compareMetric(currentFinancials.trueIncome, comparisonFinancials.trueIncome),
      totalExpenses: compareMetric(currentFinancials.totalExpenses, comparisonFinancials.totalExpenses),
      costOfLiving: compareMetric(currentExpenses.costOfLiving, comparisonExpenses.costOfLiving),
      regularExpenses: compareMetric(currentExpenses.regularExpenses, comparisonExpenses.regularExpenses),
      exceptionalExpenses: compareMetric(currentExpenses.exceptionalExpenses, comparisonExpenses.exceptionalExpenses),
      debtPayments: compareMetric(currentExpenses.debtPayments, comparisonExpenses.debtPayments),
      nonLivingOutflows: compareMetric(currentExpenses.nonLivingOutflows, comparisonExpenses.nonLivingOutflows),
      netCashFlow: compareMetric(currentFinancials.netCashFlow, comparisonFinancials.netCashFlow, { supportsPercent: false }),
      closingBalance: compareMetric(currentFinancials.closingBalance, comparisonFinancials.closingBalance, { supportsPercent: false }),
    };
    const currentClassTotal = currentExpenses.regularExpenses + currentExpenses.exceptionalExpenses + currentExpenses.debtPayments;
    const comparisonClassTotal = comparisonExpenses.regularExpenses + comparisonExpenses.exceptionalExpenses + comparisonExpenses.debtPayments;
    const financialNetDelta = metrics.totalExpenses.delta;

    return {
      currentMonth,
      comparisonMonth: resolvedComparisonMonth,
      metrics,
      spendingDrivers,
      currentFinancials,
      comparisonFinancials,
      currentExpenses,
      comparisonExpenses,
      historicalContext: calculateHistoricalContext(state, currentMonth, currentFinancials.totalExpenses),
      hasAnyActivity:
        currentFinancials.trueIncome !== 0 || currentFinancials.totalExpenses !== 0 ||
        comparisonFinancials.trueIncome !== 0 || comparisonFinancials.totalExpenses !== 0 ||
        currentFinancials.openingBalance !== 0 || currentFinancials.closingBalance !== 0 ||
        comparisonFinancials.openingBalance !== 0 || comparisonFinancials.closingBalance !== 0,
      invariants: {
        currentCategoriesMatchExpenses: approximatelyEqual(spendingDrivers.currentCategoryTotal, currentFinancials.totalExpenses),
        comparisonCategoriesMatchExpenses: approximatelyEqual(spendingDrivers.comparisonCategoryTotal, comparisonFinancials.totalExpenses),
        categoryDeltaMatchesExpenseDelta: approximatelyEqual(spendingDrivers.netExpenseDelta, financialNetDelta),
        currentClassesMatchExpenses: approximatelyEqual(currentClassTotal, currentFinancials.totalExpenses),
        comparisonClassesMatchExpenses: approximatelyEqual(comparisonClassTotal, comparisonFinancials.totalExpenses),
      },
    };
  }

  function isIncompleteCurrentMonth(month, now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    if (Number.isNaN(date.getTime())) return false;
    const currentMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (month !== currentMonth) return false;
    return true;
  }

  function generateInsights(comparison, options) {
    if (!comparison?.hasAnyActivity) return [];
    const formatAmount = typeof options?.formatAmount === "function"
      ? options.formatAmount
      : (amount) => String(Math.round(amount));
    const getCategoryName = typeof options?.getCategoryName === "function"
      ? options.getCategoryName
      : (categoryId) => categoryId;
    const rows = [];
    const expense = comparison.metrics.totalExpenses;
    if (expense.delta > 0) rows.push(`ارتفع إجمالي المصروف بمقدار ${formatAmount(expense.absoluteDelta)} مقارنة بشهر المقارنة.`);
    else if (expense.delta < 0) rows.push(`انخفض إجمالي المصروف بمقدار ${formatAmount(expense.absoluteDelta)} مقارنة بشهر المقارنة.`);
    else if (comparison.spendingDrivers.compositionChanged) rows.push("إجمالي المصروف لم يتغير، لكن توزيع الإنفاق بين التصنيفات تغيّر.");
    else rows.push("لم يتغير إجمالي المصروف بين الشهرين.");

    const living = comparison.metrics.costOfLiving;
    if (living.delta > 0) rows.push(`ارتفعت تكلفة المعيشة بمقدار ${formatAmount(living.absoluteDelta)}.`);
    else if (living.delta < 0) rows.push(`انخفضت تكلفة المعيشة بمقدار ${formatAmount(living.absoluteDelta)}.`);

    const topIncrease = comparison.spendingDrivers.increaseDrivers[0];
    if (topIncrease) rows.push(`${getCategoryName(topIncrease.categoryId)} هو أكبر مساهم في زيادة المصروف، بزيادة ${formatAmount(topIncrease.delta)}.`);
    const topDecrease = comparison.spendingDrivers.decreaseDrivers[0];
    if (topDecrease) rows.push(`انخفض الإنفاق على ${getCategoryName(topDecrease.categoryId)} بمقدار ${formatAmount(topDecrease.absoluteDelta)} وساهم في تخفيف المصروف.`);

    const exceptional = comparison.metrics.exceptionalExpenses;
    const debt = comparison.metrics.debtPayments;
    if (exceptional.delta !== 0 || debt.delta !== 0) {
      const parts = [];
      if (exceptional.delta !== 0) parts.push(`المصروف الاستثنائي ${exceptional.delta > 0 ? "ارتفع" : "انخفض"} ${formatAmount(exceptional.absoluteDelta)}`);
      if (debt.delta !== 0) parts.push(`سداد الدين ${debt.delta > 0 ? "ارتفع" : "انخفض"} ${formatAmount(debt.absoluteDelta)}`);
      rows.push(`${parts.join("، بينما ")}.`);
    }

    const net = comparison.metrics.netCashFlow;
    if (net.delta > 0) rows.push(`تحسن صافي الحركة النقدية بمقدار ${formatAmount(net.absoluteDelta)}.`);
    else if (net.delta < 0) rows.push(`تراجع صافي الحركة النقدية بمقدار ${formatAmount(net.absoluteDelta)}.`);

    if (comparison.historicalContext.isUnusual && rows.length < 6) {
      const history = comparison.historicalContext;
      rows.push(`مصروف الشهر ${history.difference > 0 ? "أعلى" : "أقل"} من متوسط الأشهر الستة الأخيرة بمقدار ${formatAmount(Math.abs(history.difference))}.`);
    }
    return rows.slice(0, 6);
  }

  return {
    UNCATEGORIZED,
    addMonths,
    compareMetric,
    getMonthCategoryExpenses,
    compareExpenseCategories,
    calculateSpendingDrivers,
    calculateMonthlyComparison,
    isIncompleteCurrentMonth,
    generateInsights,
  };
});
