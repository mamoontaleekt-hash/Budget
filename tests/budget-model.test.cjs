const test = require("node:test");
const assert = require("node:assert/strict");
const Budget = require("../budget-model.js");
const Financial = require("../financial-model.js");
const Expense = require("../expense-model.js");
const Shopping = require("../shopping-model.js");
const Tags = require("../tag-model.js");

const month = "2026-09";
const tx = (overrides = {}) => ({
  id: "t1", type: "expense", categoryId: "ex_grocery", date: "2026-09-05", amount: 100,
  ...overrides,
});
const state = (transactions = [], budgets = {}) => ({
  version: 1,
  categories: [
    { id: "ex_grocery", name: "سوبرماركت", type: "expense" },
    { id: "ex_restaurant", name: "مطاعم", type: "expense" },
    { id: "ex_debt", name: "دين", type: "expense" },
    { id: "in_salary", name: "راتب", type: "income" },
  ],
  transactions,
  budgets,
});
const withBudget = (amount = 1000, transactions = [], extraItems = {}, plan = {}) => state(transactions, {
  [month]: { plan: { income1: 0, income2: 0, note: "", ...plan }, items: { ex_grocery: { amount, note: "خطة" }, ...extraItems } },
});

test("reads the existing monthly budget shape", () => {
  const source = withBudget(1200);
  assert.equal(Budget.getMonthBudget(source, month), source.budgets[month]);
  assert.deepEqual(Budget.getCategoryBudget(source, month, "ex_grocery"), { amount: 1200, note: "خطة" });
});
test("missing month and category return safe defaults", () => {
  assert.deepEqual(Budget.getMonthBudget(state(), month).items, {});
  assert.equal(Budget.getCategoryBudget(state(), month, "missing"), null);
});
test("positive planned budget with zero actual is OK", () => {
  assert.deepEqual(Budget.calculateCategoryBudgetStatus(1000, 0), { plannedAmount: 1000, actualAmount: 0, remainingAmount: 1000, percentUsed: 0, status: Budget.OK });
});
test("below 80 percent is OK", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 799).status, Budget.OK));
test("exactly 80 percent is WARNING", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 800).status, Budget.WARNING));
test("between 80 and 100 percent is WARNING", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 999).status, Budget.WARNING));
test("exactly 100 percent is AT_LIMIT", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 1000).status, Budget.AT_LIMIT));
test("above 100 percent is EXCEEDED", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 1001).status, Budget.EXCEEDED));
test("zero budget is NO_BUDGET", () => assert.equal(Budget.calculateCategoryBudgetStatus(0, 100).status, Budget.NO_BUDGET));
test("negative budget is NO_BUDGET", () => assert.equal(Budget.calculateCategoryBudgetStatus(-10, 100).status, Budget.NO_BUDGET));
test("note-only item is not a positive budget", () => {
  const analytics = Budget.calculateBudgetAnalytics(state([tx()], { [month]: { plan: {}, items: { ex_grocery: { note: "فقط" } } } }), month);
  assert.equal(analytics.budgetedCategoryCount, 0);
  assert.equal(analytics.unbudgetedActualTotal, 100);
});
test("remaining amount is planned minus actual", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 1150).remainingAmount, -150));
test("percent used is calculated correctly", () => assert.equal(Budget.calculateCategoryBudgetStatus(1000, 750).percentUsed, 75));
test("zero budget never returns Infinity or NaN", () => {
  const result = Budget.calculateCategoryBudgetStatus(0, 100);
  assert.equal(result.percentUsed, null);
  assert.equal(result.remainingAmount, null);
});
test("multiple budgeted categories aggregate correctly", () => {
  const source = withBudget(1000, [tx({ amount: 400 }), tx({ id: "t2", categoryId: "ex_restaurant", amount: 300 })], { ex_restaurant: { amount: 500 } });
  const a = Budget.calculateBudgetAnalytics(source, month);
  assert.equal(a.plannedBudgetTotal, 1500);
  assert.equal(a.budgetedCategoryCount, 2);
});
test("budgeted actual total is correct", () => assert.equal(Budget.calculateBudgetAnalytics(withBudget(1000, [tx({ amount: 450 })]), month).budgetedActualTotal, 450));
test("unbudgeted actual total is correct", () => {
  const source = withBudget(1000, [tx({ amount: 450 }), tx({ id: "t2", categoryId: "ex_restaurant", amount: 300 })]);
  assert.equal(Budget.calculateBudgetAnalytics(source, month).unbudgetedActualTotal, 300);
});
test("total expense invariant includes budgeted and unbudgeted spending", () => {
  const a = Budget.calculateBudgetAnalytics(withBudget(1000, [tx({ amount: 450 }), tx({ id: "t2", categoryId: "ex_restaurant", amount: 300 })]), month);
  assert.equal(a.totalExpenseActual, a.budgetedActualTotal + a.unbudgetedActualTotal);
  assert.equal(a.totalExpenseActual, 750);
});
test("deleted expense is ignored", () => assert.deepEqual(Budget.calculateCategoryActuals(state([tx({ deletedAt: "2026-09-06" })]), month), {}));
test("restored expense is counted", () => assert.equal(Budget.calculateCategoryActuals(state([tx({ deletedAt: null })]), month).ex_grocery, 100));
test("income is ignored", () => assert.deepEqual(Budget.calculateCategoryActuals(state([tx({ type: "income" })]), month), {}));
test("other month is ignored", () => assert.deepEqual(Budget.calculateCategoryActuals(state([tx({ date: "2026-08-31" })]), month), {}));
test("non-positive and malformed amounts are ignored", () => assert.deepEqual(Budget.calculateCategoryActuals(state([tx({ amount: 0 }), tx({ id: "t2", amount: -1 }), tx({ id: "t3", amount: "bad" })]), month), {}));
test("category change moves usage to the new category", () => {
  assert.deepEqual(Budget.calculateCategoryActuals(state([tx({ categoryId: "ex_restaurant" })]), month), { ex_restaurant: 100 });
});
test("month move moves usage to the new month", () => {
  const source = state([tx({ date: "2026-10-01" })]);
  assert.deepEqual(Budget.calculateCategoryActuals(source, month), {});
  assert.equal(Budget.calculateCategoryActuals(source, "2026-10").ex_grocery, 100);
});
test("category rename does not affect ID-based usage", () => {
  const source = withBudget(1000, [tx()]);
  source.categories[0].name = "اسم جديد";
  assert.equal(Budget.calculateBudgetAnalytics(source, month).budgetedActualTotal, 100);
});
test("exceptional expense still counts by category", () => {
  const source = withBudget(1000, [tx()]);
  source.expenseSettings = { transactionClasses: { t1: "exceptional" } };
  assert.equal(Budget.calculateBudgetAnalytics(source, month).budgetedActualTotal, 100);
});
test("regular expense still counts by category", () => {
  const source = withBudget(1000, [tx()]);
  source.expenseSettings = { transactionClasses: { t1: "regular" } };
  assert.equal(Budget.calculateBudgetAnalytics(source, month).budgetedActualTotal, 100);
});
test("debt payment counts against transaction categoryId", () => {
  const source = withBudget(1000, [tx({ categoryId: "ex_debt" })], { ex_debt: { amount: 500 } });
  assert.equal(Budget.calculateCategoryActuals(source, month).ex_debt, 100);
});
test("valid debt link does not remap category budget", () => {
  const source = withBudget(1000, [tx({ categoryId: "ex_grocery", debtObligationId: "d1" })]);
  source.debtSettings = { obligations: [{ id: "d1", name: "دين", originalAmount: 500, status: "active" }] };
  assert.deepEqual(Budget.calculateCategoryActuals(source, month), { ex_grocery: 100 });
});
test("shopping subcategories do not multiply budget actual", () => {
  const source = withBudget(1000, [tx({ amount: 180 })]);
  source.shoppingSettings = { transactionSubcategories: { t1: ["meat", "dairy", "cleaning"] } };
  assert.equal(Budget.calculateBudgetAnalytics(source, month).budgetedActualTotal, 180);
});
test("transaction tags do not multiply budget actual", () => {
  const source = withBudget(1000, [tx({ amount: 180 })]);
  source.tagSettings = { definitions: {}, transactionTags: { t1: ["family", "event"] } };
  assert.equal(Budget.calculateBudgetAnalytics(source, month).budgetedActualTotal, 180);
});
test("analytics do not mutate transactions", () => {
  const source = withBudget(1000, [tx()]);
  const before = JSON.stringify(source.transactions);
  Budget.calculateBudgetAnalytics(source, month);
  assert.equal(JSON.stringify(source.transactions), before);
});
test("analytics do not mutate budgets", () => {
  const source = withBudget(1000, [tx()]);
  const before = JSON.stringify(source.budgets);
  Budget.calculateBudgetAnalytics(source, month);
  assert.equal(JSON.stringify(source.budgets), before);
});
test("planned income does not change true income", () => {
  const source = withBudget(1000, [tx({ type: "income", categoryId: "in_salary", amount: 200 })], {}, { income1: 9000 });
  assert.equal(Financial.calculateMonthFinancials(source, month).trueIncome, 200);
});
test("planned income does not change closing balance", () => {
  const a = withBudget(1000, [tx({ type: "income", categoryId: "in_salary", amount: 200 })], {}, { income1: 9000 });
  const b = withBudget(1000, [tx({ type: "income", categoryId: "in_salary", amount: 200 })], {}, { income1: 0 });
  assert.equal(Financial.calculateMonthFinancials(a, month).closingBalance, Financial.calculateMonthFinancials(b, month).closingBalance);
});
test("allocation over planned income warning is correct", () => assert.equal(Budget.calculateBudgetAnalytics(withBudget(1000, [], {}, { income1: 900 }), month).allocationExceedsPlannedIncome, true));
test("zero planned income has no allocation warning", () => assert.equal(Budget.calculateBudgetAnalytics(withBudget(1000), month).allocationExceedsPlannedIncome, false));
test("alerts sort exceeded then at-limit then warning and by percentage", () => {
  const source = withBudget(100, [
    tx({ amount: 85 }),
    tx({ id: "t2", categoryId: "ex_restaurant", amount: 100 }),
    tx({ id: "t3", categoryId: "ex_debt", amount: 140 }),
  ], { ex_restaurant: { amount: 100 }, ex_debt: { amount: 100 } });
  assert.deepEqual(Budget.calculateBudgetAnalytics(source, month).alerts.map((a) => a.status), [Budget.EXCEEDED, Budget.AT_LIMIT, Budget.WARNING]);
  assert.equal(Budget.calculateBudgetAnalytics(source, month).overallStatus, Budget.EXCEEDED);
});
test("overall status is NO_BUDGET when no positive budgets exist", () => assert.equal(Budget.calculateBudgetAnalytics(state([tx()]), month).overallStatus, Budget.NO_BUDGET));
test("categories without budgets do not emit alerts", () => assert.equal(Budget.calculateBudgetAnalytics(state([tx()]), month).alerts.length, 0));
test("unbudgeted spending remains surfaced", () => assert.equal(Budget.calculateBudgetAnalytics(state([tx({ amount: 300 })]), month).unbudgetedActualTotal, 300));
test("Phase 1 optional state remains accepted by financial calculations", () => assert.equal(Financial.calculateMonthFinancials(withBudget(), month).trueIncome, 0));
test("Phase 2 classification remains independent", () => {
  const source = withBudget(1000, [tx()]); source.expenseSettings = { transactionClasses: { t1: "exceptional" } };
  assert.equal(Expense.calculateExpenseAnalytics(source, month).exceptionalExpenses, 100);
});
test("Phase 3 debt settings survive analytics unchanged", () => {
  const source = withBudget(); source.debtSettings = { obligations: [] }; const before = JSON.stringify(source.debtSettings);
  Budget.calculateBudgetAnalytics(source, month); assert.equal(JSON.stringify(source.debtSettings), before);
});
test("Phase 4 shopping analytics remain independent", () => {
  const source = withBudget(1000, [tx()]); source.shoppingSettings = { transactionSubcategories: { t1: ["meat", "dairy"] } };
  assert.equal(Shopping.calculateShoppingAnalytics(source, month).totalShoppingAmount, 100);
});
test("Phase 5 tag analytics remain independent", () => {
  const source = withBudget(1000, [tx()]); source.tagSettings = { definitions: { a: { id: "a", name: "عائلة", status: "active" } }, transactionTags: { t1: ["a"] } };
  assert.equal(Tags.calculateTagAnalytics(source, month).taggedTransactionCount, 1);
});
test("budget JSON roundtrip preserves plan, notes, and item shape", () => {
  const source = withBudget(1234, [], {}, { income1: 10, income2: 20, note: "دخل" });
  const restored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(restored.budgets, source.budgets);
});
