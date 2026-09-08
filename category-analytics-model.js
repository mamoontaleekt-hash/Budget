(function (root, factory) {
  const financialModel =
    typeof module === "object" && module.exports
      ? require("./financial-model.js")
      : root.PFMFinancialModel;
  const comparisonModel =
    typeof module === "object" && module.exports
      ? require("./comparison-model.js")
      : root.PFMComparisonModel;
  const api = factory(financialModel, comparisonModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMCategoryAnalyticsModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (FinancialModel, ComparisonModel) {
  "use strict";

  if (!FinancialModel) throw new Error("Financial model is required by category analytics model");
  if (!ComparisonModel) throw new Error("Comparison model is required by category analytics model");

  const UNCATEGORIZED = ComparisonModel.UNCATEGORIZED || "uncat";
  const DEFAULT_MONTH_COUNT = 12;

  function finiteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeCategoryId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : UNCATEGORIZED;
  }

  function getAnalyticsMonths(activeMonth, count) {
    const requested = Number.isInteger(count) && count > 0 ? count : DEFAULT_MONTH_COUNT;
    const months = [];
    for (let offset = requested - 1; offset >= 0; offset -= 1) {
      const month = ComparisonModel.addMonths(activeMonth, -offset);
      if (!month) return [];
      months.push(month);
    }
    return months;
  }

  function validExpenseTransactions(state, allowedMonths, categoryId) {
    const months = allowedMonths instanceof Set ? allowedMonths : new Set(allowedMonths || []);
    const selected = categoryId === undefined ? null : normalizeCategoryId(categoryId);
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    return transactions.filter((transaction) => {
      if (!transaction || typeof transaction !== "object" || transaction.deletedAt || transaction.type !== "expense") return false;
      const amount = finiteNumber(transaction.amount);
      const month = String(transaction.date || "").slice(0, 7);
      if (amount === null || amount <= 0 || !months.has(month)) return false;
      return selected === null || normalizeCategoryId(transaction.categoryId) === selected;
    });
  }

  function compareTransactions(left, right) {
    const amountDifference = (finiteNumber(right.amount) || 0) - (finiteNumber(left.amount) || 0);
    if (amountDifference) return amountDifference;
    const dateDifference = String(right.date || "").localeCompare(String(left.date || ""));
    if (dateDifference) return dateDifference;
    return String(left.id || "").localeCompare(String(right.id || ""));
  }

  function createAnalyticsContext(state, activeMonth, count) {
    const months = getAnalyticsMonths(activeMonth, count);
    const transactions = validExpenseTransactions(state, new Set(months));
    const monthly = new Map(months.map((month) => [month, { total: 0, categories: new Map() }]));
    const categoryTransactions = new Map();
    transactions.forEach((transaction) => {
      const month = String(transaction.date || "").slice(0, 7);
      const categoryId = normalizeCategoryId(transaction.categoryId);
      const amount = finiteNumber(transaction.amount);
      const monthRow = monthly.get(month);
      monthRow.total += amount;
      const categoryRow = monthRow.categories.get(categoryId) || { amount: 0, transactions: [] };
      categoryRow.amount += amount;
      categoryRow.transactions.push(transaction);
      monthRow.categories.set(categoryId, categoryRow);
      const allCategoryTransactions = categoryTransactions.get(categoryId) || [];
      allCategoryTransactions.push(transaction);
      categoryTransactions.set(categoryId, allCategoryTransactions);
    });
    monthly.forEach((row, month) => {
      row.financialTotal = FinancialModel.calculateMonthFinancials(state, month).totalExpenses;
      row.categories.forEach((category) => category.transactions.sort(compareTransactions));
    });
    categoryTransactions.forEach((rows) => rows.sort(compareTransactions));
    return { activeMonth, months, monthly, categoryTransactions };
  }

  function statsFromContext(context, categoryId, month) {
    const normalizedId = normalizeCategoryId(categoryId);
    const monthRow = context.monthly.get(month) || { total: 0, financialTotal: 0, categories: new Map() };
    const categoryRow = monthRow.categories.get(normalizedId) || { amount: 0, transactions: [] };
    const financialTotalIsValid = Number.isFinite(monthRow.financialTotal) && Math.abs(monthRow.financialTotal - monthRow.total) < 1e-8;
    const denominator = financialTotalIsValid ? monthRow.financialTotal : monthRow.total;
    return {
      month,
      categoryId: normalizedId,
      amount: categoryRow.amount,
      transactionCount: categoryRow.transactions.length,
      shareOfMonthExpenses: denominator > 0 ? categoryRow.amount / denominator : null,
      transactions: categoryRow.transactions,
    };
  }

  function getCategoryMonthStats(state, categoryId, month) {
    return statsFromContext(createAnalyticsContext(state, month, 1), categoryId, month);
  }

  function getCategorySeries(state, categoryId, activeMonth, count) {
    const context = createAnalyticsContext(state, activeMonth, count);
    return context.months.map((month) => {
      const stats = statsFromContext(context, categoryId, month);
      return {
        month: stats.month,
        amount: stats.amount,
        transactionCount: stats.transactionCount,
        shareOfMonthExpenses: stats.shareOfMonthExpenses,
      };
    });
  }

  function rankingsFromContext(context) {
    function rank(transactions) {
      const totals = new Map();
      transactions.forEach((transaction) => {
        const categoryId = normalizeCategoryId(transaction.categoryId);
        const row = totals.get(categoryId) || { categoryId, amount: 0, transactionCount: 0 };
        row.amount += finiteNumber(transaction.amount);
        row.transactionCount += 1;
        totals.set(categoryId, row);
      });
      const totalExpenses = [...totals.values()].reduce((sum, row) => sum + row.amount, 0);
      return [...totals.values()]
        .filter((row) => row.amount > 0)
        .sort((left, right) => right.amount - left.amount || left.categoryId.localeCompare(right.categoryId))
        .map((row, index) => ({
          ...row,
          share: totalExpenses > 0 ? row.amount / totalExpenses : null,
          rank: index + 1,
        }));
    }

    const currentMonth = context.monthly.get(context.activeMonth);
    const currentTransactions = currentMonth ? [...currentMonth.categories.values()].flatMap((row) => row.transactions) : [];
    const windowTransactions = [...context.categoryTransactions.values()].flat();
    const current = rank(currentTransactions);
    const twelveMonth = rank(windowTransactions);
    const currentTotalExpenses = current.reduce((sum, row) => sum + row.amount, 0);
    const twelveMonthTotalExpenses = twelveMonth.reduce((sum, row) => sum + row.amount, 0);
    const top3Amount = twelveMonth.slice(0, 3).reduce((sum, row) => sum + row.amount, 0);
    return {
      months: context.months,
      current,
      twelveMonth,
      currentTotalExpenses,
      twelveMonthTotalExpenses,
      top3Amount,
      top3Share: twelveMonthTotalExpenses > 0 ? top3Amount / twelveMonthTotalExpenses : null,
    };
  }

  function calculateCategoryRankings(state, activeMonth, count) {
    return rankingsFromContext(createAnalyticsContext(state, activeMonth, count));
  }

  function calculateCategoryAnalytics(state, categoryId, activeMonth, options) {
    const count = Number.isInteger(options?.count) && options.count > 0 ? options.count : DEFAULT_MONTH_COUNT;
    const normalizedId = normalizeCategoryId(categoryId);
    const context = options?.context || createAnalyticsContext(state, activeMonth, count);
    const months = context.months;
    const series = months.map((month) => {
      const stats = statsFromContext(context, normalizedId, month);
      return { month, amount: stats.amount, transactionCount: stats.transactionCount, shareOfMonthExpenses: stats.shareOfMonthExpenses };
    });
    const previousMonth = ComparisonModel.addMonths(activeMonth, -1);
    const currentStats = statsFromContext(context, normalizedId, activeMonth);
    const previousStats = context.monthly.has(previousMonth)
      ? statsFromContext(context, normalizedId, previousMonth)
      : getCategoryMonthStats(state, normalizedId, previousMonth);
    const currentVsPrevious = ComparisonModel.compareMetric(currentStats.amount, previousStats.amount);
    const rankings = options?.rankings || rankingsFromContext(context);
    const transactions = context.categoryTransactions.get(normalizedId) || [];
    const twelveMonthTotal = series.reduce((sum, row) => sum + row.amount, 0);
    const activeRows = series.filter((row) => row.amount > 0);
    const activeMonthCount = activeRows.length;
    const transactionCount12m = transactions.length;
    const highestMonth = activeRows.reduce((best, row) => (
      !best || row.amount > best.amount || (row.amount === best.amount && row.month > best.month) ? row : best
    ), null);
    const lowestActiveMonth = activeRows.reduce((best, row) => (
      !best || row.amount < best.amount || (row.amount === best.amount && row.month > best.month) ? row : best
    ), null);
    const currentRanking = rankings.current.find((row) => row.categoryId === normalizedId) || null;
    const twelveMonthRanking = rankings.twelveMonth.find((row) => row.categoryId === normalizedId) || null;
    return {
      categoryId: normalizedId,
      months,
      series,
      currentMonthAmount: currentStats.amount,
      previousMonthAmount: previousStats.amount,
      currentMonthTransactionCount: currentStats.transactionCount,
      currentVsPrevious,
      currentVsPreviousDelta: currentVsPrevious.delta,
      currentVsPreviousPercent: currentVsPrevious.percentChange,
      twelveMonthTotal,
      twelveMonthCalendarAverage: months.length > 0 ? twelveMonthTotal / months.length : 0,
      activeMonthCount,
      activeMonthAverage: activeMonthCount > 0 ? twelveMonthTotal / activeMonthCount : null,
      transactionCount12m,
      averageTransactionsPerActiveMonth: activeMonthCount > 0 ? transactionCount12m / activeMonthCount : null,
      averageTransactionAmount12m: transactionCount12m > 0 ? twelveMonthTotal / transactionCount12m : null,
      largestTransaction: transactions[0]
        ? { id: transactions[0].id, date: transactions[0].date, amount: finiteNumber(transactions[0].amount), note: transactions[0].note }
        : null,
      highestMonth: highestMonth ? { ...highestMonth } : null,
      lowestActiveMonth: lowestActiveMonth ? { ...lowestActiveMonth } : null,
      currentMonthExpenseShare: currentStats.shareOfMonthExpenses,
      twelveMonthExpenseShare: rankings.twelveMonthTotalExpenses > 0 ? twelveMonthTotal / rankings.twelveMonthTotalExpenses : null,
      currentRank: currentRanking?.rank || null,
      twelveMonthRank: twelveMonthRanking?.rank || null,
      currentMonthTopTransactions: currentStats.transactions.slice(0, 5).map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        amount: finiteNumber(transaction.amount),
        note: transaction.note,
      })),
    };
  }

  function calculateCategoryOverview(state, activeMonth, count) {
    const context = createAnalyticsContext(state, activeMonth, count);
    const rankings = rankingsFromContext(context);
    const categoryIds = new Set([
      ...rankings.current.map((row) => row.categoryId),
      ...rankings.twelveMonth.map((row) => row.categoryId),
    ]);
    const rows = [...categoryIds].map((categoryId) => {
      const analytics = calculateCategoryAnalytics(state, categoryId, activeMonth, { count, rankings, context });
      return {
        categoryId,
        currentMonthAmount: analytics.currentMonthAmount,
        previousMonthAmount: analytics.previousMonthAmount,
        currentVsPreviousDelta: analytics.currentVsPreviousDelta,
        currentVsPreviousPercent: analytics.currentVsPreviousPercent,
        currentVsPreviousState: analytics.currentVsPrevious.state,
        twelveMonthTotal: analytics.twelveMonthTotal,
        twelveMonthExpenseShare: analytics.twelveMonthExpenseShare,
        activeMonthCount: analytics.activeMonthCount,
        transactionCount12m: analytics.transactionCount12m,
        currentRank: analytics.currentRank,
        twelveMonthRank: analytics.twelveMonthRank,
      };
    }).sort((left, right) => right.twelveMonthTotal - left.twelveMonthTotal || left.categoryId.localeCompare(right.categoryId));
    return { ...rankings, rows, hasData: rankings.twelveMonthTotalExpenses > 0 };
  }

  function getDefaultCategoryId(state, activeMonth, count) {
    const rankings = calculateCategoryRankings(state, activeMonth, count);
    if (rankings.current[0]) return rankings.current[0].categoryId;
    if (rankings.twelveMonth[0]) return rankings.twelveMonth[0].categoryId;
    const categories = Array.isArray(state?.categories) ? state.categories : [];
    return categories.find((category) => category?.type === "expense" && typeof category.id === "string" && category.id.trim())?.id || null;
  }

  return {
    UNCATEGORIZED,
    DEFAULT_MONTH_COUNT,
    getAnalyticsMonths,
    getCategoryMonthStats,
    getCategorySeries,
    calculateCategoryAnalytics,
    calculateCategoryRankings,
    calculateCategoryOverview,
    getDefaultCategoryId,
  };
});
