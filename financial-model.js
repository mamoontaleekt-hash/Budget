(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMFinancialModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VALID_MODES = new Set(["manual", "carry", "legacy"]);
  const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

  function finiteAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function numericAmount(value) {
    return finiteAmount(value) ?? 0;
  }

  function getPreviousMonth(month) {
    const match = MONTH_PATTERN.exec(String(month || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const monthNumber = Number(match[2]);
    if (monthNumber === 1) return `${year - 1}-12`;
    return `${year}-${String(monthNumber - 1).padStart(2, "0")}`;
  }

  function getMonthFinancialSettings(state, month) {
    const months = state?.financialSettings?.months;
    if (!months || typeof months !== "object" || Array.isArray(months)) return null;
    const settings = months[month];
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
    return settings;
  }

  function openingBalanceMode(state, month) {
    const mode = getMonthFinancialSettings(state, month)?.openingBalanceMode;
    return VALID_MODES.has(mode) ? mode : null;
  }

  function transactionsForMonth(state, month) {
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    return transactions.filter(
      (transaction) =>
        transaction &&
        typeof transaction === "object" &&
        !transaction.deletedAt &&
        String(transaction.date || "").slice(0, 7) === month
    );
  }

  function getLegacyOpeningTransactions(state, month) {
    if (openingBalanceMode(state, month) !== "legacy") return [];
    const configuredIds = getMonthFinancialSettings(state, month)?.legacyOpeningTransactionIds;
    if (!Array.isArray(configuredIds)) return [];
    const ids = new Set(configuredIds.filter((id) => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return [];
    return transactionsForMonth(state, month).filter(
      (transaction) =>
        transaction.type === "income" &&
        typeof transaction.id === "string" &&
        ids.has(transaction.id) &&
        finiteAmount(transaction.amount) !== null
    );
  }

  function calculateSingleMonth(state, month, carriedOpeningBalance) {
    const transactions = transactionsForMonth(state, month);
    const mode = openingBalanceMode(state, month);
    const settings = getMonthFinancialSettings(state, month);
    const incomeTotal = transactions
      .filter((transaction) => transaction.type === "income")
      .reduce((sum, transaction) => sum + numericAmount(transaction.amount), 0);
    const totalExpenses = transactions
      .filter((transaction) => transaction.type === "expense")
      .reduce((sum, transaction) => sum + numericAmount(transaction.amount), 0);

    let openingBalance = 0;
    let legacyOpeningTransactions = [];
    if (mode === "manual") openingBalance = numericAmount(settings?.openingBalanceAmount);
    if (mode === "carry") openingBalance = numericAmount(carriedOpeningBalance);
    if (mode === "legacy") {
      legacyOpeningTransactions = getLegacyOpeningTransactions(state, month);
      openingBalance = legacyOpeningTransactions.reduce(
        (sum, transaction) => sum + numericAmount(transaction.amount),
        0
      );
    }

    const legacyOpeningAmount = mode === "legacy" ? openingBalance : 0;
    const trueIncome = incomeTotal - legacyOpeningAmount;
    const availableCash = openingBalance + trueIncome;
    const closingBalance = availableCash - totalExpenses;
    const netCashFlow = trueIncome - totalExpenses;
    const savingsRate = trueIncome > 0 ? (netCashFlow / trueIncome) * 100 : null;

    return {
      month,
      openingBalanceMode: mode,
      openingBalance,
      trueIncome,
      availableCash,
      totalExpenses,
      closingBalance,
      netCashFlow,
      savingsRate,
      transactions,
      legacyOpeningTransactions,
      income: trueIncome,
      expense: totalExpenses,
      net: netCashFlow,
      txs: transactions,
    };
  }

  function calculateMonthFinancials(state, month) {
    if (!MONTH_PATTERN.test(String(month || ""))) return calculateSingleMonth(state, String(month || ""), 0);

    const configuredMonths = state?.financialSettings?.months;
    const configuredCount =
      configuredMonths && typeof configuredMonths === "object" && !Array.isArray(configuredMonths)
        ? Object.keys(configuredMonths).length
        : 0;
    const carryChain = [];
    const seen = new Set();
    let cursor = month;
    const maximumSteps = configuredCount + 2;

    while (openingBalanceMode(state, cursor) === "carry" && carryChain.length < maximumSteps) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      carryChain.push(cursor);
      const previous = getPreviousMonth(cursor);
      if (!previous) break;
      cursor = previous;
    }

    let result = calculateSingleMonth(state, cursor, 0);
    for (let index = carryChain.length - 1; index >= 0; index -= 1) {
      result = calculateSingleMonth(state, carryChain[index], result.closingBalance);
    }
    return result;
  }

  function isLegacyOpeningTransaction(state, month, transactionId) {
    return getLegacyOpeningTransactions(state, month).some(
      (transaction) => transaction.id === transactionId
    );
  }

  return {
    getPreviousMonth,
    getMonthFinancialSettings,
    getLegacyOpeningTransactions,
    calculateOpeningBalance(state, month) {
      return calculateMonthFinancials(state, month).openingBalance;
    },
    calculateMonthFinancials,
    isLegacyOpeningTransaction,
  };
});

