const assert = require("node:assert/strict");
const Debt = require("../debt-model.js");
const Expense = require("../expense-model.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function obligation(overrides = {}) {
  return {
    id: "home",
    name: "دفعة المنزل",
    type: "house",
    totalAmount: 1200,
    paidBeforeTracking: 200,
    startDate: "2026-01-01",
    scheduleMode: "fixed",
    installmentAmount: 300,
    frequency: "monthly",
    firstDueDate: "2026-02-28",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function tx(id, amount, date = "2026-02-10", overrides = {}) {
  return { id, type: "expense", categoryId: "ex_misc", amount, date, note: "دفعة", createdAt: `${date}T10:00:00.000Z`, ...overrides };
}

function stateWith(obligations = [obligation()], transactions = [], paymentLinks = {}) {
  return {
    categories: [], budgets: {}, transactions,
    debtSettings: {
      obligations: Object.fromEntries(obligations.map((item) => [item.id, item])),
      paymentLinks,
    },
  };
}

test("date accepts leap day", () => assert.equal(Debt.isDateOnly("2028-02-29"), true));
test("date rejects non leap day", () => assert.equal(Debt.isDateOnly("2027-02-29"), false));
test("date rejects timestamp", () => assert.equal(Debt.isDateOnly("2026-01-01T00:00:00Z"), false));
test("date rejects impossible month", () => assert.equal(Debt.isDateOnly("2026-13-01"), false));
test("date rejects impossible day", () => assert.equal(Debt.isDateOnly("2026-04-31"), false));
test("add week preserves date only", () => assert.equal(Debt.addDaysDateOnly("2026-01-28", 7), "2026-02-04"));
test("add week crosses year", () => assert.equal(Debt.addDaysDateOnly("2026-12-29", 7), "2027-01-05"));
test("monthly clamps February", () => assert.equal(Debt.addMonthsDateOnly("2026-01-31", 1), "2026-02-28"));
test("monthly restores source day", () => assert.equal(Debt.addMonthsDateOnly("2026-01-31", 2), "2026-03-31"));
test("monthly leap clamp", () => assert.equal(Debt.addMonthsDateOnly("2028-01-31", 1), "2028-02-29"));
test("month addition crosses year", () => assert.equal(Debt.addMonthsMonth("2026-11", 3), "2027-02"));
test("invalid month addition returns null", () => assert.equal(Debt.addMonthsMonth("2026-99", 1), null));

test("missing settings produces no obligations", () => assert.deepEqual(Debt.getObligations({ transactions: [] }), []));
test("array settings produces no obligations", () => assert.deepEqual(Debt.getObligations({ debtSettings: { obligations: [] } }), []));
test("mismatched embedded id is ignored", () => assert.equal(Debt.getObligation({ debtSettings: { obligations: { a: { id: "b" } } } }, "a"), null));
test("valid obligation is returned", () => assert.equal(Debt.getObligation(stateWith(), "home").name, "دفعة المنزل"));
test("missing obligation is null", () => assert.equal(Debt.getObligation(stateWith(), "none"), null));

test("fixed schedule excludes paid before tracking", () => {
  assert.deepEqual(Debt.generateFixedSchedule(obligation()).map((row) => row.amount), [300, 300, 300, 100]);
});
test("fixed schedule starts at configured date", () => assert.equal(Debt.generateFixedSchedule(obligation())[0].dueDate, "2026-02-28"));
test("fixed monthly schedule advances", () => assert.equal(Debt.generateFixedSchedule(obligation())[2].dueDate, "2026-04-28"));
test("fixed weekly schedule advances seven days", () => {
  const rows = Debt.generateFixedSchedule(obligation({ frequency: "weekly", firstDueDate: "2026-02-26" }));
  assert.equal(rows[1].dueDate, "2026-03-05");
});
test("final fixed row is smaller", () => assert.equal(Debt.generateFixedSchedule(obligation()).at(-1).amount, 100));
test("equal division has no extra row", () => assert.equal(Debt.generateFixedSchedule(obligation({ totalAmount: 1100 })).length, 3));
test("fully paid before tracking has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ paidBeforeTracking: 1200 })), []));
test("paid before tracking above total has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ paidBeforeTracking: 1500 })), []));
test("zero installment has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ installmentAmount: 0 })), []));
test("invalid frequency has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ frequency: "yearly" })), []));
test("invalid first date has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ firstDueDate: "bad" })), []));
test("irregular has no derived schedule", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ scheduleMode: "irregular" })), []));
test("unsafe enormous row count has no rows", () => assert.deepEqual(Debt.generateFixedSchedule(obligation({ totalAmount: 20000, paidBeforeTracking: 0, installmentAmount: 1 })), []));

test("allocation consumes first row first", () => {
  const rows = Debt.allocatePaymentsToSchedule(Debt.generateFixedSchedule(obligation()), 350);
  assert.deepEqual(rows.map((row) => row.paidAmount), [300, 50, 0, 0]);
});
test("allocation reports partial outstanding", () => {
  const rows = Debt.allocatePaymentsToSchedule(Debt.generateFixedSchedule(obligation()), 350);
  assert.equal(rows[1].outstandingAmount, 250);
});
test("allocation ignores negative payment total", () => assert.equal(Debt.allocatePaymentsToSchedule([{ amount: 100 }], -5)[0].outstandingAmount, 100));
test("allocation handles extra total", () => assert.equal(Debt.allocatePaymentsToSchedule([{ amount: 100 }], 150)[0].outstandingAmount, 0));
test("allocation does not mutate schedule", () => {
  const rows = [{ amount: 100 }];
  Debt.allocatePaymentsToSchedule(rows, 50);
  assert.equal(Object.hasOwn(rows[0], "paidAmount"), false);
});

test("active expense link is valid", () => {
  const state = stateWith([obligation()], [tx("p1", 100)], { p1: "home" });
  assert.equal(Debt.isValidDebtPaymentLink(state, "p1"), true);
});
test("deleted expense link is invalid", () => {
  const state = stateWith([obligation()], [tx("p1", 100, "2026-02-10", { deletedAt: "x" })], { p1: "home" });
  assert.equal(Debt.isValidDebtPaymentLink(state, "p1"), false);
});
test("income link is invalid", () => {
  const state = stateWith([obligation()], [tx("p1", 100, "2026-02-10", { type: "income" })], { p1: "home" });
  assert.equal(Debt.isValidDebtPaymentLink(state, "p1"), false);
});
test("missing transaction link is invalid", () => assert.equal(Debt.isValidDebtPaymentLink(stateWith([obligation()], [], { p1: "home" }), "p1"), false));
test("missing target link is invalid", () => assert.equal(Debt.isValidDebtPaymentLink(stateWith([obligation()], [tx("p1", 100)], { p1: "ghost" }), "p1"), false));
test("linked payments sort by date", () => {
  const state = stateWith([obligation()], [tx("late", 1, "2026-03-01"), tx("early", 1, "2026-02-01")], { late: "home", early: "home" });
  assert.deepEqual(Debt.getLinkedPaymentTransactions(state, "home").map((item) => item.id), ["early", "late"]);
});

test("total paid combines opening amount and links", () => {
  const state = stateWith([obligation()], [tx("p1", 350)], { p1: "home" });
  assert.equal(Debt.calculateObligation(state, "home").totalPaid, 550);
});
test("remaining follows source transactions", () => {
  const state = stateWith([obligation()], [tx("p1", 350)], { p1: "home" });
  assert.equal(Debt.calculateObligation(state, "home").remaining, 650);
});
test("overpayment is separate", () => {
  const state = stateWith([obligation()], [tx("p1", 1100)], { p1: "home" });
  assert.equal(Debt.calculateObligation(state, "home").overpayment, 100);
});
test("remaining never negative", () => {
  const state = stateWith([obligation()], [tx("p1", 1100)], { p1: "home" });
  assert.equal(Debt.calculateObligation(state, "home").remaining, 0);
});
test("zero remaining completes effectively", () => {
  const state = stateWith([obligation()], [tx("p1", 1000)], { p1: "home" });
  assert.equal(Debt.calculateObligation(state, "home").effectiveStatus, "completed");
});
test("effective completion does not rewrite stored status", () => {
  const state = stateWith([obligation()], [tx("p1", 1000)], { p1: "home" });
  assert.equal(state.debtSettings.obligations.home.status, "active");
});
test("paused obligation retains remaining", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ status: "paused" })]), "home").remaining, 1000));
test("paused obligation has no next due", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ status: "paused" })]), "home").nextDue, null));
test("stored completed has no next due", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ status: "completed" })]), "home").nextDue, null));
test("first partial unpaid row is next due", () => {
  const state = stateWith([obligation()], [tx("p1", 350)], { p1: "home" });
  assert.deepEqual(Debt.calculateObligation(state, "home").nextDue, { date: "2026-03-28", amount: 250, source: "fixed" });
});
test("overdue is strict before reference day", () => assert.equal(Debt.calculateObligation(stateWith(), "home", "2026-02-28").overdueAmount, 0));
test("overdue appears after due day", () => assert.equal(Debt.calculateObligation(stateWith(), "home", "2026-03-01").overdueAmount, 300));
test("paused has no overdue warning", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ status: "paused" })]), "home", "2026-05-01").overdueAmount, 0));
test("completed has no overdue warning", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ status: "completed" })]), "home", "2026-05-01").overdueAmount, 0));

test("irregular manual next due is used", () => {
  const item = obligation({ scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 80 });
  assert.deepEqual(Debt.calculateObligation(stateWith([item]), "home").nextDue, { date: "2026-04-05", amount: 80, source: "manual" });
});
test("irregular without manual fields has no next due", () => assert.equal(Debt.calculateObligation(stateWith([obligation({ scheduleMode: "irregular" })]), "home").nextDue, null));
test("irregular amount is capped at remaining", () => {
  const item = obligation({ totalAmount: 250, scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 90 });
  assert.equal(Debt.calculateObligation(stateWith([item]), "home").nextDue.amount, 50);
});
test("past irregular manual due is overdue", () => {
  const item = obligation({ scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 80 });
  assert.equal(Debt.calculateObligation(stateWith([item]), "home", "2026-04-06").overdueAmount, 80);
});
test("payment on manual due consumes it", () => {
  const item = obligation({ totalAmount: 1000, paidBeforeTracking: 0, scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 100 });
  const source = stateWith([item], [tx("p1", 100, "2026-04-05")], { p1: "home" });
  assert.equal(Debt.calculateObligation(source, "home", "2026-04-06").nextDue, null);
  assert.equal(Debt.calculateObligation(source, "home", "2026-04-06").remaining, 900);
});
test("partial payment reduces manual due", () => {
  const item = obligation({ totalAmount: 1000, paidBeforeTracking: 0, scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 100 });
  const source = stateWith([item], [tx("p1", 40, "2026-04-06")], { p1: "home" });
  assert.equal(Debt.calculateObligation(source, "home", "2026-04-07").nextDue.amount, 60);
});
test("payment before manual due does not consume newly stated due", () => {
  const item = obligation({ totalAmount: 1000, paidBeforeTracking: 0, scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 100 });
  const source = stateWith([item], [tx("p1", 40, "2026-04-01")], { p1: "home" });
  assert.equal(Debt.calculateObligation(source, "home", "2026-04-07").nextDue.amount, 100);
});
test("future linked payment is not counted as of reference date", () => {
  const source = stateWith([obligation()], [tx("p1", 300, "2026-04-10")], { p1: "home" });
  const result = Debt.calculateObligation(source, "home", "2026-04-01");
  assert.equal(result.linkedPayments, 0);
  assert.equal(result.remaining, 1000);
  assert.deepEqual(result.futurePaymentTransactions.map((item) => item.id), ["p1"]);
});
test("future linked payment counts once reference reaches its date", () => {
  const source = stateWith([obligation()], [tx("p1", 300, "2026-04-10")], { p1: "home" });
  assert.equal(Debt.calculateObligation(source, "home", "2026-04-10").linkedPayments, 300);
});

test("selected month contains fixed outstanding", () => assert.equal(Debt.getPlannedPaymentsForMonth(stateWith(), "2026-02")[0].amount, 300));
test("selected month omits other months", () => assert.deepEqual(Debt.getPlannedPaymentsForMonth(stateWith(), "2027-02"), []));
test("selected month includes manual irregular due", () => {
  const item = obligation({ scheduleMode: "irregular", manualNextDueDate: "2026-04-05", manualNextDueAmount: 80 });
  assert.equal(Debt.getPlannedPaymentsForMonth(stateWith([item]), "2026-04")[0].source, "manual");
});
test("selected month omits paused fixed plan", () => assert.deepEqual(Debt.getPlannedPaymentsForMonth(stateWith([obligation({ status: "paused" })]), "2026-02"), []));
test("selected month rejects malformed month", () => assert.deepEqual(Debt.getPlannedPaymentsForMonth(stateWith(), "bad"), []));
test("three month forecast has three buckets", () => assert.equal(Debt.getForecast(stateWith(), "2026-02", 3).length, 3));
test("forecast begins at selected month", () => assert.equal(Debt.getForecast(stateWith(), "2026-02", 3)[0].month, "2026-02"));
test("forecast totals each month", () => assert.deepEqual(Debt.getForecast(stateWith(), "2026-02", 4).map((row) => row.amount), [300, 300, 300, 100]));
test("forecast rejects zero horizon", () => assert.deepEqual(Debt.getForecast(stateWith(), "2026-02", 0), []));

test("summary counts active obligations", () => assert.equal(Debt.calculateSummary(stateWith()).activeCount, 1));
test("summary excludes paused from active count", () => assert.equal(Debt.calculateSummary(stateWith([obligation({ status: "paused" })])).activeCount, 0));
test("summary totals original amounts", () => {
  const car = obligation({ id: "car", name: "سيارة", type: "car", totalAmount: 800 });
  assert.equal(Debt.calculateSummary(stateWith([obligation(), car])).totalOriginal, 2000);
});
test("summary totals remaining amounts", () => {
  const car = obligation({ id: "car", name: "سيارة", type: "car", totalAmount: 800, paidBeforeTracking: 0 });
  assert.equal(Debt.calculateSummary(stateWith([obligation(), car])).totalRemaining, 1800);
});
test("summary finds nearest due", () => {
  const car = obligation({ id: "car", name: "سيارة", type: "car", firstDueDate: "2026-01-15" });
  assert.equal(Debt.calculateSummary(stateWith([obligation(), car])).nearestDue.obligationId, "car");
});

test("with obligation creates lazy settings", () => {
  const source = { transactions: [], categories: [], budgets: {} };
  const next = Debt.withObligation(source, obligation());
  assert.equal(next.debtSettings.obligations.home.name, "دفعة المنزل");
  assert.equal(Object.hasOwn(source, "debtSettings"), false);
});
test("with obligation updates without mutating source", () => {
  const source = stateWith();
  const next = Debt.withObligation(source, { ...obligation(), name: "منزل" });
  assert.equal(next.debtSettings.obligations.home.name, "منزل");
  assert.equal(source.debtSettings.obligations.home.name, "دفعة المنزل");
});
test("status helper pauses", () => assert.equal(Debt.withObligationStatus(stateWith(), "home", "paused").debtSettings.obligations.home.status, "paused"));
test("status helper rejects invalid value", () => {
  const source = stateWith();
  assert.equal(Debt.withObligationStatus(source, "home", "deleted"), source);
});
test("link helper creates one mapping", () => {
  const next = Debt.withPaymentLink(stateWith([obligation()], [tx("p1", 100)]), "p1", "home");
  assert.deepEqual(next.debtSettings.paymentLinks, { p1: "home" });
});
test("link helper refuses silent reassignment", () => {
  const other = obligation({ id: "car", name: "سيارة", type: "car" });
  const source = stateWith([obligation(), other], [tx("p1", 100)], { p1: "home" });
  assert.equal(Debt.withPaymentLink(source, "p1", "car"), source);
});
test("link helper refuses income", () => {
  const source = stateWith([obligation()], [tx("p1", 100, "2026-02-10", { type: "income" })]);
  assert.equal(Debt.withPaymentLink(source, "p1", "home"), source);
});
test("unlink removes only mapping", () => {
  const source = stateWith([obligation()], [tx("p1", 100)], { p1: "home" });
  const next = Debt.withoutPaymentLink(source, "p1");
  assert.equal(next.transactions[0], source.transactions[0]);
  assert.equal(Object.hasOwn(next.debtSettings, "paymentLinks"), false);
});
test("unlink preserves explicit classification", () => {
  const source = { ...stateWith([obligation()], [tx("p1", 100)], { p1: "home" }), expenseSettings: { transactionClasses: { p1: "exceptional" } } };
  assert.equal(Debt.withoutPaymentLink(source, "p1").expenseSettings.transactionClasses.p1, "exceptional");
});

test("valid linked payment wins over explicit class", () => {
  const source = { ...stateWith([obligation()], [tx("p1", 100)], { p1: "home" }), expenseSettings: { transactionClasses: { p1: "exceptional" } } };
  assert.equal(Expense.resolveExpenseClass(source, source.transactions[0]), "debt_payment");
});
test("stale link does not force debt class", () => {
  const source = { ...stateWith([obligation()], [tx("p1", 100)], { p1: "ghost" }), expenseSettings: { transactionClasses: { p1: "exceptional" } } };
  assert.equal(Expense.resolveExpenseClass(source, source.transactions[0]), "exceptional");
});
test("invalid link falls back to debt category", () => {
  const source = stateWith([obligation()], [tx("p1", 100, "2026-02-10", { categoryId: "ex_debt" })], { p1: "ghost" });
  assert.equal(Expense.resolveExpenseClass(source, source.transactions[0]), "debt_payment");
});
test("deleted linked transaction has no expense class", () => {
  const source = stateWith([obligation()], [tx("p1", 100, "2026-02-10", { deletedAt: "x" })], { p1: "home" });
  assert.equal(Expense.resolveExpenseClass(source, source.transactions[0]), null);
});

test("valid obligation passes validation", () => assert.deepEqual(Debt.validateObligation(obligation()), []));
test("invalid fixed fields are reported", () => assert.deepEqual(Debt.validateObligation(obligation({ installmentAmount: 0, frequency: "x", firstDueDate: "x" })), ["installmentAmount", "frequency", "firstDueDate"]));
test("irregular next due fields must appear together", () => assert.deepEqual(Debt.validateObligation(obligation({ scheduleMode: "irregular", manualNextDueDate: "2026-02-01" })), ["manualNextDue"]));
test("negative paid before is rejected", () => assert.deepEqual(Debt.validateObligation(obligation({ paidBeforeTracking: -1 })), ["paidBeforeTracking"]));
test("unknown type is rejected", () => assert.deepEqual(Debt.validateObligation(obligation({ type: "unknown" })), ["type"]));

console.log(`${passed}/${passed} debt model tests passed`);
