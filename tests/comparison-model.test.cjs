const test = require("node:test");
const assert = require("node:assert/strict");
const Comparison = require("../comparison-model.js");
const Financial = require("../financial-model.js");
const Expense = require("../expense-model.js");

const CURRENT = "2026-09";
const PREVIOUS = "2026-08";
const tx = (id, month, type, amount, categoryId, extra = {}) => ({ id, date: `${month}-10`, type, amount, categoryId, ...extra });
const state = (transactions = [], extra = {}) => ({
  transactions,
  categories: [
    { id: "grocery", name: "السوبرماركت", type: "expense" },
    { id: "restaurants", name: "المطاعم", type: "expense" },
    { id: "fuel", name: "الوقود", type: "expense" },
    { id: "health", name: "الصحة", type: "expense" },
  ],
  budgets: {},
  ...extra,
});
const compare = (source) => Comparison.calculateMonthlyComparison(source, CURRENT, PREVIOUS);
const driverScenario = () => state([
  tx("pg", PREVIOUS, "expense", 500000, "grocery"),
  tx("pr", PREVIOUS, "expense", 300000, "restaurants"),
  tx("pf", PREVIOUS, "expense", 200000, "fuel"),
  tx("cg", CURRENT, "expense", 800000, "grocery"),
  tx("cr", CURRENT, "expense", 100000, "restaurants"),
  tx("cf", CURRENT, "expense", 250000, "fuel"),
  tx("ch", CURRENT, "expense", 150000, "health"),
]);

test("empty state is safe", () => assert.equal(compare(state()).hasAnyActivity, false));
test("same month values are unchanged", () => assert.equal(Comparison.calculateMonthlyComparison(driverScenario(), CURRENT, CURRENT).metrics.totalExpenses.state, "UNCHANGED"));
test("current greater than previous", () => assert.equal(Comparison.compareMetric(150, 100).state, "INCREASED"));
test("current less than previous", () => assert.equal(Comparison.compareMetric(50, 100).state, "DECREASED"));
test("both zero unchanged", () => assert.equal(Comparison.compareMetric(0, 0).state, "UNCHANGED"));
test("zero baseline positive current is new", () => assert.equal(Comparison.compareMetric(100, 0).state, "NEW"));
test("positive baseline zero current is stopped", () => assert.equal(Comparison.compareMetric(0, 100).state, "STOPPED"));
test("percent change is valid with positive baseline", () => assert.equal(Comparison.compareMetric(130, 100).percentChange, 30));
test("zero baseline never returns Infinity", () => assert.equal(Comparison.compareMetric(100, 0).percentChange, null));
test("malformed metric never returns NaN", () => Object.values(Comparison.compareMetric("bad", undefined)).filter(Number.isNaN).forEach(() => assert.fail()));
test("net cash flow sign change has absolute delta and no percent", () => {
  const source = state([tx("pi", PREVIOUS, "income", 100, "income"), tx("pe", PREVIOUS, "expense", 150, "grocery"), tx("ci", CURRENT, "income", 200, "income"), tx("ce", CURRENT, "expense", 100, "grocery")]);
  assert.deepEqual([compare(source).metrics.netCashFlow.delta, compare(source).metrics.netCashFlow.percentChange], [150, null]);
});
test("current category total is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.currentCategoryTotal, 1300000));
test("category rows expose explicit current and previous amounts", () => {
  const grocery = compare(driverScenario()).spendingDrivers.categories.find((row) => row.categoryId === "grocery");
  assert.deepEqual([grocery.currentAmount, grocery.previousAmount], [800000, 500000]);
});
test("previous category total is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.comparisonCategoryTotal, 1000000));
test("uncategorized expense is retained", () => assert.equal(Comparison.getMonthCategoryExpenses(state([tx("u", CURRENT, "expense", 75)]), CURRENT).uncat, 75));
test("deleted expense is ignored", () => assert.deepEqual(Object.keys(Comparison.getMonthCategoryExpenses(state([tx("d", CURRENT, "expense", 75, "grocery", { deletedAt: "x" })]), CURRENT)), []));
test("restored expense is included", () => assert.equal(Comparison.getMonthCategoryExpenses(state([tx("r", CURRENT, "expense", 75, "grocery")]), CURRENT).grocery, 75));
test("income is excluded from drivers", () => assert.deepEqual(Object.keys(Comparison.getMonthCategoryExpenses(state([tx("i", CURRENT, "income", 75, "grocery")]), CURRENT)), []));
test("other months are excluded", () => assert.deepEqual(Object.keys(Comparison.getMonthCategoryExpenses(state([tx("o", "2026-07", "expense", 75, "grocery")]), CURRENT)), []));
test("non-positive and malformed expenses are ignored", () => assert.deepEqual(Object.keys(Comparison.getMonthCategoryExpenses(state([tx("z", CURRENT, "expense", 0, "grocery"), tx("n", CURRENT, "expense", -1, "fuel"), tx("x", CURRENT, "expense", "bad", "health")]), CURRENT)), []));
test("category union includes current-only category", () => assert.ok(Comparison.compareExpenseCategories(driverScenario(), CURRENT, PREVIOUS).some((row) => row.categoryId === "health")));
test("category union includes previous-only category", () => {
  const rows = Comparison.compareExpenseCategories(state([tx("p", PREVIOUS, "expense", 1, "restaurants")]), CURRENT, PREVIOUS);
  assert.ok(rows.some((row) => row.categoryId === "restaurants"));
});
test("increased category state is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.categories.find((x) => x.categoryId === "grocery").state, "INCREASED"));
test("decreased category state is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.categories.find((x) => x.categoryId === "restaurants").state, "DECREASED"));
test("new category state is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.categories.find((x) => x.categoryId === "health").state, "NEW"));
test("stopped category state is correct", () => {
  const row = Comparison.compareExpenseCategories(state([tx("p", PREVIOUS, "expense", 1, "grocery")]), CURRENT, PREVIOUS)[0];
  assert.equal(row.state, "STOPPED");
});
test("unchanged category state is correct", () => {
  const row = Comparison.compareExpenseCategories(state([tx("p", PREVIOUS, "expense", 1, "grocery"), tx("c", CURRENT, "expense", 1, "grocery")]), CURRENT, PREVIOUS)[0];
  assert.equal(row.state, "UNCHANGED");
});
test("increase drivers sorted descending", () => assert.deepEqual(compare(driverScenario()).spendingDrivers.increaseDrivers.map((x) => x.categoryId), ["grocery", "health", "fuel"]));
test("decrease drivers sorted by absolute reduction", () => {
  const source = state([tx("p1", PREVIOUS, "expense", 500, "grocery"), tx("p2", PREVIOUS, "expense", 300, "restaurants"), tx("c1", CURRENT, "expense", 100, "grocery"), tx("c2", CURRENT, "expense", 200, "restaurants")]);
  assert.deepEqual(compare(source).spendingDrivers.decreaseDrivers.map((x) => x.categoryId), ["grocery", "restaurants"]);
});
test("gross increase is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.grossIncreaseAmount, 500000));
test("gross decrease is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.grossDecreaseAmount, 200000));
test("net delta is correct", () => assert.equal(compare(driverScenario()).spendingDrivers.netExpenseDelta, 300000));
test("driver invariant equals expense delta", () => assert.equal(compare(driverScenario()).invariants.categoryDeltaMatchesExpenseDelta, true));
test("positive shares sum to one", () => assert.ok(Math.abs(compare(driverScenario()).spendingDrivers.increaseDrivers.reduce((sum, x) => sum + x.shareOfGrossIncrease, 0) - 1) < 1e-9));
test("decrease shares sum to one", () => assert.ok(Math.abs(compare(driverScenario()).spendingDrivers.decreaseDrivers.reduce((sum, x) => sum + x.shareOfGrossDecrease, 0) - 1) < 1e-9));
test("no driver share division by zero", () => assert.equal(compare(state()).spendingDrivers.increaseDrivers.length, 0));
test("unchanged total with changed mix remains visible", () => {
  const source = state([tx("pg", PREVIOUS, "expense", 500, "grocery"), tx("pr", PREVIOUS, "expense", 500, "restaurants"), tx("cg", CURRENT, "expense", 800, "grocery"), tx("cr", CURRENT, "expense", 200, "restaurants")]);
  const result = compare(source); assert.equal(result.metrics.totalExpenses.delta, 0); assert.equal(result.spendingDrivers.compositionChanged, true);
});
test("shopping subcategories do not multiply amount", () => assert.equal(Comparison.getMonthCategoryExpenses(state([tx("x", CURRENT, "expense", 180000, "grocery", { shopping: { subcategories: ["meat", "dairy", "cleaning"] } })]), CURRENT).grocery, 180000));
test("transaction tags do not multiply amount", () => assert.equal(Comparison.getMonthCategoryExpenses(state([tx("x", CURRENT, "expense", 180000, "grocery", { tagIds: ["family", "event"] })]), CURRENT).grocery, 180000));
test("exceptional expense counted once by category", () => {
  const source = state([tx("x", CURRENT, "expense", 180000, "grocery")], { expenseSettings: { transactionClasses: { x: "exceptional" } } });
  assert.equal(compare(source).spendingDrivers.currentCategoryTotal, 180000);
});
test("debt payment counted once by transaction category", () => assert.equal(compare(state([tx("x", CURRENT, "expense", 180000, "fuel", { categoryId: "fuel" })], { expenseSettings: { transactionClasses: { x: "debt_payment" } } })).spendingDrivers.currentCategoryTotal, 180000));
test("cost of living uses ExpenseModel", () => {
  const source = state([tx("r", CURRENT, "expense", 100, "grocery"), tx("e", CURRENT, "expense", 200, "health")], { expenseSettings: { transactionClasses: { e: "exceptional" } } });
  assert.equal(compare(source).metrics.costOfLiving.current, Expense.calculateExpenseAnalytics(source, CURRENT).costOfLiving);
});
test("exceptional comparison uses ExpenseModel", () => {
  const source = state([tx("e", CURRENT, "expense", 200, "health")], { expenseSettings: { transactionClasses: { e: "exceptional" } } });
  assert.equal(compare(source).metrics.exceptionalExpenses.current, Expense.calculateExpenseAnalytics(source, CURRENT).exceptionalExpenses);
});
test("debt comparison uses ExpenseModel", () => {
  const source = state([tx("d", CURRENT, "expense", 200, "health")], { expenseSettings: { transactionClasses: { d: "debt_payment" } } });
  assert.equal(compare(source).metrics.debtPayments.current, Expense.calculateExpenseAnalytics(source, CURRENT).debtPayments);
});
test("current class invariant holds", () => assert.equal(compare(driverScenario()).invariants.currentClassesMatchExpenses, true));
test("comparison class invariant holds", () => assert.equal(compare(driverScenario()).invariants.comparisonClassesMatchExpenses, true));
test("true income uses FinancialModel", () => {
  const source = state([tx("i", CURRENT, "income", 999, "income")]);
  assert.equal(compare(source).metrics.trueIncome.current, Financial.calculateMonthFinancials(source, CURRENT).trueIncome);
});
test("opening balance does not contaminate true income", () => {
  const source = state([tx("i", CURRENT, "income", 100, "income")], { financialSettings: { months: { [CURRENT]: { openingBalanceMode: "manual", openingBalanceAmount: 500 } } } });
  assert.equal(compare(source).metrics.trueIncome.current, 100);
});
test("net cash flow comparison is correct", () => {
  const source = state([tx("i", CURRENT, "income", 500, "income"), tx("e", CURRENT, "expense", 200, "grocery")]);
  assert.equal(compare(source).metrics.netCashFlow.current, 300);
});
test("closing balance remains separate from net cash flow", () => {
  const source = state([tx("i", CURRENT, "income", 500, "income"), tx("e", CURRENT, "expense", 200, "grocery")], { financialSettings: { months: { [CURRENT]: { openingBalanceMode: "manual", openingBalanceAmount: 700 } } } });
  assert.deepEqual([compare(source).metrics.netCashFlow.current, compare(source).metrics.closingBalance.current], [300, 1000]);
});
test("model does not mutate transactions", () => { const source = driverScenario(); const before = JSON.stringify(source.transactions); compare(source); assert.equal(JSON.stringify(source.transactions), before); });
test("model does not mutate categories", () => { const source = driverScenario(); const before = JSON.stringify(source.categories); compare(source); assert.equal(JSON.stringify(source.categories), before); });
test("model does not mutate budgets", () => { const source = driverScenario(); source.budgets = { [CURRENT]: { plan: { income1: 1 }, items: [] } }; const before = JSON.stringify(source.budgets); compare(source); assert.equal(JSON.stringify(source.budgets), before); });
test("model does not mutate optional metadata", () => { const source = driverScenario(); source.shoppingSettings = { x: [1] }; source.tagSettings = { x: [2] }; source.debtSettings = { obligations: [] }; const before = JSON.stringify(source); compare(source); assert.equal(JSON.stringify(source), before); });
test("category rename with stable ID preserves grouping", () => { const source = driverScenario(); source.categories[0].name = "اسم جديد"; assert.equal(compare(source).spendingDrivers.categories.find((x) => x.categoryId === "grocery").delta, 300000); });
test("missing category definition preserves amount", () => assert.equal(compare(state([tx("x", CURRENT, "expense", 10, "missing")])).spendingDrivers.currentCategoryTotal, 10));
test("JSON roundtrip leaves financial state unchanged", () => { const source = driverScenario(); const before = JSON.stringify(source); compare(JSON.parse(before)); assert.equal(JSON.stringify(source), before); });
test("default comparison is previous calendar month", () => assert.equal(Comparison.calculateMonthlyComparison(state(), CURRENT).comparisonMonth, PREVIOUS));
test("month arithmetic crosses year boundary", () => assert.equal(Comparison.addMonths("2026-01", -1), "2025-12"));
test("incomplete current month warning can use injected date", () => assert.equal(Comparison.isIncompleteCurrentMonth("2026-09", new Date(2026, 8, 8)), true));
test("historical month has no incomplete warning", () => assert.equal(Comparison.isIncompleteCurrentMonth("2026-08", new Date(2026, 8, 8)), false));
test("last day retains incomplete warning", () => assert.equal(Comparison.isIncompleteCurrentMonth("2026-09", new Date(2026, 8, 30)), true));
test("historical average includes empty months in the six-month denominator", () => {
  const source = state([tx("past", "2026-08", "expense", 600, "grocery")]);
  const result = Comparison.calculateMonthlyComparison(source, CURRENT, PREVIOUS).historicalContext;
  assert.deepEqual([result.monthsConsidered, result.averageExpense], [6, 100]);
});
test("balance-only months count as comparison activity", () => {
  const source = state([], { financialSettings: { months: {
    [CURRENT]: { openingBalanceMode: "manual", openingBalanceAmount: 500 },
    [PREVIOUS]: { openingBalanceMode: "manual", openingBalanceAmount: 300 },
  } } });
  const result = compare(source);
  assert.equal(result.hasAnyActivity, true);
  assert.equal(result.metrics.closingBalance.delta, 200);
});
test("zero net mix insight reports composition change", () => {
  const source = state([tx("pg", PREVIOUS, "expense", 500, "grocery"), tx("pr", PREVIOUS, "expense", 500, "restaurants"), tx("cg", CURRENT, "expense", 800, "grocery"), tx("cr", CURRENT, "expense", 200, "restaurants")]);
  assert.match(Comparison.generateInsights(compare(source))[0], /توزيع الإنفاق/);
});
test("insights name largest increase contributor without unsupported cause", () => {
  const text = Comparison.generateInsights(compare(driverScenario()), { getCategoryName: (id) => id }).join(" ");
  assert.match(text, /grocery هو أكبر مساهم/); assert.doesNotMatch(text, /غلاء|سفر|مناسبة|بسبب/);
});
test("insights are capped at six", () => assert.ok(Comparison.generateInsights(compare(driverScenario())).length <= 6));
test("empty comparison has quiet insights", () => assert.deepEqual(Comparison.generateInsights(compare(state())), []));
