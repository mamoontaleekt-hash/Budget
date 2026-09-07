(function (root, factory) {
  const financialModel =
    typeof module === "object" && module.exports
      ? require("./financial-model.js")
      : root.PFMFinancialModel;
  const api = factory(financialModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMExpenseModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (FinancialModel) {
  "use strict";

  if (!FinancialModel) throw new Error("Financial model is required by expense model");

  const REGULAR = "regular";
  const EXCEPTIONAL = "exceptional";
  const DEBT_PAYMENT = "debt_payment";
  const VALID_CLASSES = new Set([REGULAR, EXCEPTIONAL, DEBT_PAYMENT]);

  function numericAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string" || value.trim() === "") return 0;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
  }

  function getTransactionClasses(state) {
    const classes = state?.expenseSettings?.transactionClasses;
    if (!classes || typeof classes !== "object" || Array.isArray(classes)) return null;
    return classes;
  }

  function getExplicitExpenseClass(state, transactionId) {
    if (typeof transactionId !== "string" || transactionId.length === 0) return null;
    const value = getTransactionClasses(state)?.[transactionId];
    return VALID_CLASSES.has(value) ? value : null;
  }

  function isActiveExpense(transaction) {
    return !!transaction && typeof transaction === "object" && transaction.type === "expense" && !transaction.deletedAt;
  }

  function getValidLinkedObligationId(state, transaction) {
    if (!isActiveExpense(transaction) || typeof transaction.id !== "string") return null;
    const links = state?.debtSettings?.paymentLinks;
    const obligations = state?.debtSettings?.obligations;
    if (!links || typeof links !== "object" || Array.isArray(links)) return null;
    if (!obligations || typeof obligations !== "object" || Array.isArray(obligations)) return null;
    const obligationId = links[transaction.id];
    const obligation = obligations[obligationId];
    return obligation && typeof obligation === "object" && !Array.isArray(obligation) && obligation.id === obligationId
      ? obligationId
      : null;
  }

  function resolveExpenseClass(state, transaction) {
    if (!isActiveExpense(transaction)) return null;
    if (getValidLinkedObligationId(state, transaction)) return DEBT_PAYMENT;
    const explicit = getExplicitExpenseClass(state, transaction.id);
    if (explicit) return explicit;
    return transaction.categoryId === "ex_debt" ? DEBT_PAYMENT : REGULAR;
  }

  function withExplicitExpenseClass(state, transactionId, expenseClass) {
    if (!state || typeof state !== "object" || typeof transactionId !== "string" || transactionId.length === 0) {
      return state;
    }
    const currentSettings = state.expenseSettings && typeof state.expenseSettings === "object" && !Array.isArray(state.expenseSettings)
      ? state.expenseSettings
      : {};
    const transactionClasses = { ...(getTransactionClasses(state) || {}) };
    if (VALID_CLASSES.has(expenseClass)) transactionClasses[transactionId] = expenseClass;
    else delete transactionClasses[transactionId];

    const nextSettings = { ...currentSettings };
    if (Object.keys(transactionClasses).length > 0) nextSettings.transactionClasses = transactionClasses;
    else delete nextSettings.transactionClasses;

    const nextState = { ...state };
    if (Object.keys(nextSettings).length > 0) nextState.expenseSettings = nextSettings;
    else delete nextState.expenseSettings;
    return nextState;
  }

  function calculateExpenseAnalytics(state, month) {
    const financials = FinancialModel.calculateMonthFinancials(state, month);
    const regularTransactions = [];
    const exceptionalTransactions = [];
    const debtPaymentTransactions = [];

    financials.transactions
      .filter((transaction) => transaction?.type === "expense")
      .forEach((transaction) => {
        const resolved = resolveExpenseClass(state, transaction);
        if (resolved === EXCEPTIONAL) exceptionalTransactions.push(transaction);
        else if (resolved === DEBT_PAYMENT) debtPaymentTransactions.push(transaction);
        else regularTransactions.push(transaction);
      });

    const sum = (transactions) => transactions.reduce(
      (total, transaction) => total + numericAmount(transaction.amount),
      0
    );
    const regularExpenses = sum(regularTransactions);
    const exceptionalExpenses = sum(exceptionalTransactions);
    const debtPayments = sum(debtPaymentTransactions);
    const totalExpenses = regularExpenses + exceptionalExpenses + debtPayments;
    const nonLivingOutflows = exceptionalExpenses + debtPayments;
    const costOfLivingRatio = financials.trueIncome > 0
      ? (regularExpenses / financials.trueIncome) * 100
      : null;

    return {
      month,
      totalExpenses,
      regularExpenses,
      exceptionalExpenses,
      debtPayments,
      costOfLiving: regularExpenses,
      nonLivingOutflows,
      costOfLivingRatio,
      regularTransactions,
      exceptionalTransactions,
      debtPaymentTransactions,
    };
  }

  function isRegularExpense(state, transaction) {
    return resolveExpenseClass(state, transaction) === REGULAR;
  }

  function isExceptionalExpense(state, transaction) {
    return resolveExpenseClass(state, transaction) === EXCEPTIONAL;
  }

  function isDebtPayment(state, transaction) {
    return resolveExpenseClass(state, transaction) === DEBT_PAYMENT;
  }

  return {
    REGULAR,
    EXCEPTIONAL,
    DEBT_PAYMENT,
    getExplicitExpenseClass,
    getValidLinkedObligationId,
    resolveExpenseClass,
    withExplicitExpenseClass,
    calculateExpenseAnalytics,
    isRegularExpense,
    isExceptionalExpense,
    isDebtPayment,
  };
});
