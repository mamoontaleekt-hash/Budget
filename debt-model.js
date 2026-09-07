(function (root, factory) {
  const financialModel =
    typeof module === "object" && module.exports
      ? require("./financial-model.js")
      : root.PFMFinancialModel;
  const api = factory(financialModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMDebtModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (FinancialModel) {
  "use strict";

  if (!FinancialModel) throw new Error("Financial model is required by debt model");

  const TYPES = new Set(["house", "car", "appliance", "personal", "installment", "other"]);
  const SCHEDULE_MODES = new Set(["fixed", "irregular"]);
  const FREQUENCIES = new Set(["monthly", "weekly"]);
  const STATUSES = new Set(["active", "paused", "completed"]);
  const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const transactionIndexes = new WeakMap();

  function finiteAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nonNegativeAmount(value) {
    const amount = finiteAmount(value);
    return amount === null ? 0 : Math.max(amount, 0);
  }

  function positiveAmount(value) {
    const amount = finiteAmount(value);
    return amount !== null && amount > 0 ? amount : null;
  }

  function isDateOnly(value) {
    const match = DATE_PATTERN.exec(String(value || ""));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function formatDateUTC(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function addDaysDateOnly(dateOnly, days) {
    if (!isDateOnly(dateOnly) || !Number.isInteger(days)) return null;
    const [year, month, day] = dateOnly.split("-").map(Number);
    return formatDateUTC(new Date(Date.UTC(year, month - 1, day + days)));
  }

  function addMonthsDateOnly(dateOnly, months) {
    if (!isDateOnly(dateOnly) || !Number.isInteger(months)) return null;
    const [year, month, day] = dateOnly.split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1 + months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(day, lastDay));
    return formatDateUTC(first);
  }

  function addMonthsMonth(month, amount) {
    const match = MONTH_PATTERN.exec(String(month || ""));
    if (!match || !Number.isInteger(amount)) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function todayDateOnly() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function obligationsObject(state) {
    const obligations = state?.debtSettings?.obligations;
    return obligations && typeof obligations === "object" && !Array.isArray(obligations) ? obligations : null;
  }

  function paymentLinksObject(state) {
    const links = state?.debtSettings?.paymentLinks;
    return links && typeof links === "object" && !Array.isArray(links) ? links : null;
  }

  function getObligation(state, obligationId) {
    if (typeof obligationId !== "string" || obligationId.length === 0) return null;
    const obligation = obligationsObject(state)?.[obligationId];
    if (!obligation || typeof obligation !== "object" || Array.isArray(obligation)) return null;
    return obligation.id === obligationId && validateObligation(obligation).length === 0 ? obligation : null;
  }

  function getObligations(state) {
    return Object.keys(obligationsObject(state) || {})
      .map((id) => getObligation(state, id))
      .filter(Boolean);
  }

  function getTransaction(state, transactionId) {
    if (typeof transactionId !== "string" || transactionId.length === 0) return null;
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    let cached = transactionIndexes.get(transactions);
    if (!cached || cached.length !== transactions.length) {
      const firstIndexById = new Map();
      transactions.forEach((transaction, index) => {
        if (typeof transaction?.id === "string" && transaction.id.length > 0 && !firstIndexById.has(transaction.id)) {
          firstIndexById.set(transaction.id, index);
        }
      });
      cached = { length: transactions.length, firstIndexById };
      transactionIndexes.set(transactions, cached);
    }
    const index = cached.firstIndexById.get(transactionId);
    if (!Number.isInteger(index)) return null;
    const transaction = transactions[index];
    if (transaction?.id !== transactionId) {
      transactionIndexes.delete(transactions);
      return getTransaction(state, transactionId);
    }
    return transaction;
  }

  function isActiveExpense(transaction) {
    return !!transaction && typeof transaction === "object" && transaction.type === "expense" && !transaction.deletedAt;
  }

  function getValidLinkedObligationId(state, transactionOrId) {
    const transactionId = typeof transactionOrId === "string" ? transactionOrId : transactionOrId?.id;
    const transaction = getTransaction(state, transactionId);
    if (typeof transactionOrId !== "string" && transaction !== transactionOrId) return null;
    if (!isActiveExpense(transaction) || typeof transaction.id !== "string") return null;
    const obligationId = paymentLinksObject(state)?.[transaction.id];
    return getObligation(state, obligationId) ? obligationId : null;
  }

  function isValidDebtPaymentLink(state, transactionId) {
    return getValidLinkedObligationId(state, transactionId) !== null;
  }

  function getLinkedPaymentTransactions(state, obligationId) {
    if (!getObligation(state, obligationId)) return [];
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
    return transactions
      .filter((transaction) => getValidLinkedObligationId(state, transaction) === obligationId)
      .slice()
      .sort((a, b) => {
        const byDate = String(a.date || "").localeCompare(String(b.date || ""));
        if (byDate) return byDate;
        const byCreated = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        return byCreated || String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function sumPayments(transactions) {
    return transactions.reduce((sum, transaction) => sum + nonNegativeAmount(transaction.amount), 0);
  }

  function normalizedStoredStatus(obligation) {
    return STATUSES.has(obligation?.status) ? obligation.status : "active";
  }

  function generateFixedSchedule(obligation) {
    if (!obligation || obligation.scheduleMode !== "fixed") return [];
    const totalAmount = nonNegativeAmount(obligation.totalAmount);
    const paidBeforeTracking = Math.min(nonNegativeAmount(obligation.paidBeforeTracking), totalAmount);
    const scheduledTotal = Math.max(totalAmount - paidBeforeTracking, 0);
    const installmentAmount = positiveAmount(obligation.installmentAmount);
    const frequency = obligation.frequency;
    const firstDueDate = obligation.firstDueDate;
    if (scheduledTotal <= 0 || !installmentAmount || !FREQUENCIES.has(frequency) || !isDateOnly(firstDueDate)) return [];

    const count = Math.ceil(scheduledTotal / installmentAmount);
    if (!Number.isSafeInteger(count) || count > 10000) return [];
    const schedule = [];
    let allocated = 0;
    for (let index = 0; index < count; index += 1) {
      const dueDate = frequency === "weekly"
        ? addDaysDateOnly(firstDueDate, index * 7)
        : addMonthsDateOnly(firstDueDate, index);
      const amount = Math.min(installmentAmount, scheduledTotal - allocated);
      schedule.push({ index, dueDate, amount });
      allocated += amount;
    }
    return schedule;
  }

  function allocatePaymentsToSchedule(schedule, linkedPaymentAmount) {
    let available = nonNegativeAmount(linkedPaymentAmount);
    return (Array.isArray(schedule) ? schedule : []).map((entry) => {
      const amount = nonNegativeAmount(entry?.amount);
      const paidAmount = Math.min(amount, available);
      available -= paidAmount;
      return {
        ...entry,
        amount,
        paidAmount,
        outstandingAmount: Math.max(amount - paidAmount, 0),
      };
    });
  }

  function normalizeReferenceDate(value) {
    if (isDateOnly(value)) return value;
    if (MONTH_PATTERN.test(String(value || ""))) return `${value}-01`;
    return todayDateOnly();
  }

  function calculateObligation(state, obligationOrId, referenceDate) {
    const obligation = typeof obligationOrId === "string"
      ? getObligation(state, obligationOrId)
      : obligationOrId;
    if (!obligation || typeof obligation !== "object") return null;

    const totalAmount = nonNegativeAmount(obligation.totalAmount);
    const paidBeforeTracking = nonNegativeAmount(obligation.paidBeforeTracking);
    const reference = normalizeReferenceDate(referenceDate);
    const paymentTransactions = getLinkedPaymentTransactions(state, obligation.id);
    const countedPaymentTransactions = paymentTransactions.filter(
      (transaction) => isDateOnly(transaction.date) && transaction.date <= reference
    );
    const futurePaymentTransactions = paymentTransactions.filter(
      (transaction) => isDateOnly(transaction.date) && transaction.date > reference
    );
    const linkedPayments = sumPayments(countedPaymentTransactions);
    const totalPaid = paidBeforeTracking + linkedPayments;
    const remaining = Math.max(totalAmount - totalPaid, 0);
    const overpayment = Math.max(totalPaid - totalAmount, 0);
    const storedStatus = normalizedStoredStatus(obligation);
    const effectiveStatus = remaining === 0 ? "completed" : storedStatus;
    const schedule = generateFixedSchedule(obligation);
    const allocatedSchedule = allocatePaymentsToSchedule(schedule, linkedPayments);
    const scheduledOutstanding = allocatedSchedule.filter((entry) => entry.outstandingAmount > 0);
    let overdueAmount = effectiveStatus === "active"
      ? scheduledOutstanding
        .filter((entry) => entry.dueDate < reference)
        .reduce((sum, entry) => sum + entry.outstandingAmount, 0)
      : 0;

    let nextDue = null;
    if (effectiveStatus === "active") {
      if (obligation.scheduleMode === "fixed") {
        const entry = scheduledOutstanding[0];
        if (entry) nextDue = { date: entry.dueDate, amount: entry.outstandingAmount, source: "fixed" };
      } else if (
        obligation.scheduleMode === "irregular" &&
        isDateOnly(obligation.manualNextDueDate) &&
        positiveAmount(obligation.manualNextDueAmount) &&
        remaining > 0
      ) {
        const manualPayments = sumPayments(countedPaymentTransactions.filter(
          (transaction) => isDateOnly(transaction.date) && transaction.date >= obligation.manualNextDueDate
        ));
        const manualOutstanding = Math.max(positiveAmount(obligation.manualNextDueAmount) - manualPayments, 0);
        if (manualOutstanding <= 0) {
          nextDue = null;
        } else {
          nextDue = {
            date: obligation.manualNextDueDate,
            amount: Math.min(manualOutstanding, remaining),
            source: "manual",
          };
        }
      }
    }
    if (effectiveStatus === "active" && nextDue?.source === "manual" && nextDue.date < reference) {
      overdueAmount = nextDue.amount;
    }

    return {
      obligation,
      totalAmount,
      paidBeforeTracking,
      linkedPayments,
      totalPaid,
      remaining,
      overpayment,
      storedStatus,
      effectiveStatus,
      paymentTransactions,
      countedPaymentTransactions,
      futurePaymentTransactions,
      schedule,
      allocatedSchedule,
      scheduledOutstanding,
      overdueAmount,
      nextDue,
    };
  }

  function getPlannedPaymentsForMonth(state, month, referenceDate) {
    if (!MONTH_PATTERN.test(String(month || ""))) return [];
    const rows = [];
    getObligations(state).forEach((obligation) => {
      const calculation = calculateObligation(state, obligation, referenceDate);
      if (!calculation || calculation.effectiveStatus !== "active") return;
      if (obligation.scheduleMode === "fixed") {
        calculation.scheduledOutstanding
          .filter((entry) => entry.dueDate.slice(0, 7) === month)
          .forEach((entry) => rows.push({
            obligationId: obligation.id,
            name: obligation.name,
            dueDate: entry.dueDate,
            amount: entry.outstandingAmount,
            source: "fixed",
          }));
      } else if (calculation.nextDue?.date.slice(0, 7) === month) {
        rows.push({
          obligationId: obligation.id,
          name: obligation.name,
          dueDate: calculation.nextDue.date,
          amount: calculation.nextDue.amount,
          source: "manual",
        });
      }
    });
    return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name, "ar"));
  }

  function getForecast(state, startMonth, months, referenceDate) {
    const count = Number(months);
    if (!MONTH_PATTERN.test(String(startMonth || "")) || !Number.isInteger(count) || count <= 0) return [];
    return Array.from({ length: count }, (_, index) => {
      const month = addMonthsMonth(startMonth, index);
      const payments = getPlannedPaymentsForMonth(state, month, referenceDate);
      return {
        month,
        amount: payments.reduce((sum, payment) => sum + payment.amount, 0),
        payments,
      };
    });
  }

  function calculateSummary(state, referenceDate) {
    const calculations = getObligations(state)
      .map((obligation) => calculateObligation(state, obligation, referenceDate))
      .filter(Boolean);
    const active = calculations.filter((item) => item.effectiveStatus === "active");
    const nearestDue = active
      .map((item) => item.nextDue ? { ...item.nextDue, obligationId: item.obligation.id, name: item.obligation.name } : null)
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    return {
      obligations: calculations,
      activeCount: active.length,
      totalOriginal: calculations.reduce((sum, item) => sum + item.totalAmount, 0),
      totalPaid: calculations.reduce((sum, item) => sum + item.totalPaid, 0),
      totalRemaining: calculations.reduce((sum, item) => sum + item.remaining, 0),
      totalOverpayment: calculations.reduce((sum, item) => sum + item.overpayment, 0),
      totalOverdue: calculations.reduce((sum, item) => sum + item.overdueAmount, 0),
      nearestDue,
    };
  }

  function cleanDebtSettings(state, nextSettings) {
    const nextState = { ...state };
    const hasObligations = Object.keys(nextSettings.obligations || {}).length > 0;
    const hasLinks = Object.keys(nextSettings.paymentLinks || {}).length > 0;
    if (hasObligations || hasLinks) {
      nextState.debtSettings = {};
      if (hasObligations) nextState.debtSettings.obligations = nextSettings.obligations;
      if (hasLinks) nextState.debtSettings.paymentLinks = nextSettings.paymentLinks;
    } else {
      delete nextState.debtSettings;
    }
    return nextState;
  }

  function withObligation(state, obligation) {
    if (!state || typeof state !== "object" || !obligation || typeof obligation !== "object") return state;
    if (typeof obligation.id !== "string" || obligation.id.length === 0) return state;
    const obligations = { ...(obligationsObject(state) || {}), [obligation.id]: { ...obligation } };
    return cleanDebtSettings(state, { obligations, paymentLinks: { ...(paymentLinksObject(state) || {}) } });
  }

  function withObligationStatus(state, obligationId, status) {
    const obligation = getObligation(state, obligationId);
    if (!obligation || !STATUSES.has(status)) return state;
    return withObligation(state, { ...obligation, status });
  }

  function withPaymentLink(state, transactionId, obligationId) {
    if (!state || typeof state !== "object" || !getObligation(state, obligationId)) return state;
    const transaction = getTransaction(state, transactionId);
    if (!isActiveExpense(transaction) || typeof transactionId !== "string") return state;
    const currentLinks = paymentLinksObject(state) || {};
    if (getValidLinkedObligationId(state, transaction)) return state;
    const paymentLinks = { ...currentLinks, [transactionId]: obligationId };
    return cleanDebtSettings(state, { obligations: { ...(obligationsObject(state) || {}) }, paymentLinks });
  }

  function withoutPaymentLink(state, transactionId) {
    if (!state || typeof state !== "object" || typeof transactionId !== "string") return state;
    const currentLinks = paymentLinksObject(state);
    if (!currentLinks || !Object.prototype.hasOwnProperty.call(currentLinks, transactionId)) return state;
    const paymentLinks = { ...currentLinks };
    delete paymentLinks[transactionId];
    return cleanDebtSettings(state, { obligations: { ...(obligationsObject(state) || {}) }, paymentLinks });
  }

  function isEligibleUnlinkedExpense(state, transaction) {
    if (!isActiveExpense(transaction) || typeof transaction.id !== "string" || transaction.id.length === 0) return false;
    if (getTransaction(state, transaction.id) !== transaction) return false;
    return !getValidLinkedObligationId(state, transaction);
  }

  function validateObligation(input) {
    const errors = [];
    if (!input || typeof input !== "object") return ["invalid"];
    if (typeof input.id !== "string" || !input.id) errors.push("id");
    if (typeof input.name !== "string" || !input.name.trim()) errors.push("name");
    if (!TYPES.has(input.type)) errors.push("type");
    if (!positiveAmount(input.totalAmount)) errors.push("totalAmount");
    if (finiteAmount(input.paidBeforeTracking) === null || finiteAmount(input.paidBeforeTracking) < 0) errors.push("paidBeforeTracking");
    if (!isDateOnly(input.startDate)) errors.push("startDate");
    if (!SCHEDULE_MODES.has(input.scheduleMode)) errors.push("scheduleMode");
    if (!STATUSES.has(input.status)) errors.push("status");
    if (input.scheduleMode === "fixed") {
      if (!positiveAmount(input.installmentAmount)) errors.push("installmentAmount");
      if (!FREQUENCIES.has(input.frequency)) errors.push("frequency");
      if (!isDateOnly(input.firstDueDate)) errors.push("firstDueDate");
      const total = positiveAmount(input.totalAmount);
      const installment = positiveAmount(input.installmentAmount);
      if (total && installment) {
        const scheduledTotal = Math.max(total - nonNegativeAmount(input.paidBeforeTracking), 0);
        if (Math.ceil(scheduledTotal / installment) > 10000) errors.push("scheduleSize");
      }
    }
    if (input.scheduleMode === "irregular") {
      const hasDate = input.manualNextDueDate !== undefined && input.manualNextDueDate !== "";
      const hasAmount = input.manualNextDueAmount !== undefined && input.manualNextDueAmount !== "";
      if (hasDate !== hasAmount) errors.push("manualNextDue");
      if (hasDate && !isDateOnly(input.manualNextDueDate)) errors.push("manualNextDueDate");
      if (hasAmount && !positiveAmount(input.manualNextDueAmount)) errors.push("manualNextDueAmount");
    }
    return [...new Set(errors)];
  }

  return {
    TYPES,
    SCHEDULE_MODES,
    FREQUENCIES,
    STATUSES,
    finiteAmount,
    isDateOnly,
    addDaysDateOnly,
    addMonthsDateOnly,
    addMonthsMonth,
    getObligation,
    getObligations,
    getValidLinkedObligationId,
    isValidDebtPaymentLink,
    getLinkedPaymentTransactions,
    generateFixedSchedule,
    allocatePaymentsToSchedule,
    calculateObligation,
    getPlannedPaymentsForMonth,
    getForecast,
    calculateSummary,
    withObligation,
    withObligationStatus,
    withPaymentLink,
    withoutPaymentLink,
    isEligibleUnlinkedExpense,
    validateObligation,
  };
});
