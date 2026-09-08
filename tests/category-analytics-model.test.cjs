const test = require("node:test");
const assert = require("node:assert/strict");
const Category = require("../category-analytics-model.js");
const Comparison = require("../comparison-model.js");
const Financial = require("../financial-model.js");

const ACTIVE = "2026-09";
const tx = (id, month, amount, categoryId = "grocery", extra = {}) => ({ id, date: `${month}-10`, type: "expense", amount, categoryId, ...extra });
const makeState = (transactions = [], extra = {}) => ({
  transactions,
  categories: [
    { id: "grocery", name: "السوبرماركت", type: "expense" },
    { id: "rent", name: "الإيجار", type: "expense" },
    { id: "fuel", name: "الوقود", type: "expense" },
    { id: "income", name: "الراتب", type: "income" },
  ],
  budgets: {},
  financialSettings: {},
  expenseSettings: {},
  debtSettings: {},
  shoppingSettings: {},
  tagSettings: {},
  ...extra,
});
const analytics = (state, category = "grocery") => Category.calculateCategoryAnalytics(state, category, ACTIVE);

test("empty state is safe", () => assert.equal(Category.calculateCategoryOverview(makeState(), ACTIVE).hasData, false));
test("12 calendar months are generated", () => assert.equal(Category.getAnalyticsMonths(ACTIVE, 12).length, 12));
test("window begins at the correct calendar month", () => assert.equal(Category.getAnalyticsMonths(ACTIVE, 12)[0], "2025-10"));
test("window ends in active month", () => assert.equal(Category.getAnalyticsMonths(ACTIVE, 12).at(-1), ACTIVE));
test("year boundary arithmetic is correct", () => assert.deepEqual(Category.getAnalyticsMonths("2026-02", 4), ["2025-11", "2025-12", "2026-01", "2026-02"]));
test("invalid active month returns an empty window", () => assert.deepEqual(Category.getAnalyticsMonths("bad", 12), []));
test("zero months remain in series", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100)])).series.filter((row) => row.amount === 0).length, 11));
test("one expense is counted once", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 180000)])).twelveMonthTotal, 180000));
test("income is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100, "grocery", { type: "income" })])).twelveMonthTotal, 0));
test("deleted transaction is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100, "grocery", { deletedAt: "x" })])).twelveMonthTotal, 0));
test("restored transaction is included", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100, "grocery", { deletedAt: null })])).twelveMonthTotal, 100));
test("transaction before window is ignored", () => assert.equal(analytics(makeState([tx("a", "2025-09", 100)])).twelveMonthTotal, 0));
test("transaction after active month is ignored", () => assert.equal(analytics(makeState([tx("a", "2026-10", 100)])).twelveMonthTotal, 0));
test("zero amount is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 0)])).transactionCount12m, 0));
test("negative amount is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, -1)])).transactionCount12m, 0));
test("non-finite amount is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, Infinity)])).transactionCount12m, 0));
test("malformed amount is ignored", () => assert.equal(analytics(makeState([tx("a", ACTIVE, "no")])).transactionCount12m, 0));
test("positive numeric string is accepted", () => assert.equal(analytics(makeState([tx("a", ACTIVE, "25")])).twelveMonthTotal, 25));
test("uncategorized empty ID is retained", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 30, "")]), "uncat").twelveMonthTotal, 30));
test("uncategorized missing ID is retained", () => { const transaction = tx("a", ACTIVE, 30); delete transaction.categoryId; assert.equal(analytics(makeState([transaction]), "uncat").twelveMonthTotal, 30); });
test("missing category definition is retained", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 30, "removed")]), "removed").twelveMonthTotal, 30));
test("one-category monthly series amounts are correct", () => {
  const result = analytics(makeState([tx("a", "2025-10", 100), tx("b", "2026-01", 200), tx("c", ACTIVE, 300)]));
  assert.deepEqual(result.series.filter((row) => row.amount).map((row) => [row.month, row.amount]), [["2025-10", 100], ["2026-01", 200], [ACTIVE, 300]]);
});
test("transaction count per month is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 1), tx("b", ACTIVE, 2)])).series.at(-1).transactionCount, 2));
test("monthly share is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 25), tx("b", ACTIVE, 75, "rent")])).series.at(-1).shareOfMonthExpenses, 0.25));
test("monthly share is null with zero expenses", () => assert.equal(analytics(makeState()).series.at(-1).shareOfMonthExpenses, null));
test("monthly share denominator ignores malformed negative expenses", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100), tx("bad", ACTIVE, -50, "rent")])).series.at(-1).shareOfMonthExpenses, 1));
test("current month amount is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 40), tx("b", "2026-08", 60)])).currentMonthAmount, 40));
test("previous month amount is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 40), tx("b", "2026-08", 60)])).previousMonthAmount, 60));
test("current previous delta uses comparison semantics", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 40), tx("b", "2026-08", 20)])).currentVsPreviousDelta, Comparison.compareMetric(40, 20).delta));
test("current previous percent uses comparison semantics", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 40), tx("b", "2026-08", 20)])).currentVsPreviousPercent, Comparison.compareMetric(40, 20).percentChange));
test("new category uses NEW semantics", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 40)])).currentVsPrevious.state, "NEW"));
test("stopped category uses STOPPED semantics", () => assert.equal(analytics(makeState([tx("a", "2026-08", 40)])).currentVsPrevious.state, "STOPPED"));
test("12-month total is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100), tx("b", "2026-08", 200)])).twelveMonthTotal, 300));
test("calendar average divides by 12", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 1200)])).twelveMonthCalendarAverage, 100));
test("calendar average includes zero months", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 300), tx("b", "2026-08", 600), tx("c", "2026-07", 900)])).twelveMonthCalendarAverage, 150));
test("active month count is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 300), tx("b", "2026-08", 600), tx("c", "2026-07", 900)])).activeMonthCount, 3));
test("active-month average is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 300), tx("b", "2026-08", 600), tx("c", "2026-07", 900)])).activeMonthAverage, 600));
test("active-month average is null when inactive", () => assert.equal(analytics(makeState()).activeMonthAverage, null));
test("12-month transaction count is correct", () => assert.equal(analytics(makeState(Array.from({ length: 6 }, (_, index) => tx(String(index), ACTIVE, 100000)))).transactionCount12m, 6));
test("current-month transaction count is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 1), tx("b", "2026-08", 1)])).currentMonthTransactionCount, 1));
test("average transactions per active month is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 1), tx("b", ACTIVE, 1), tx("c", "2026-08", 1)])).averageTransactionsPerActiveMonth, 1.5));
test("average transaction amount is correct", () => assert.equal(analytics(makeState(Array.from({ length: 6 }, (_, index) => tx(String(index), ACTIVE, 100000)))).averageTransactionAmount12m, 100000));
test("average transaction is null with zero count", () => assert.equal(analytics(makeState()).averageTransactionAmount12m, null));
test("largest transaction is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100), tx("b", ACTIVE, 400), tx("c", ACTIVE, 200)])).largestTransaction.id, "b"));
test("largest transaction exposes only stored facts", () => assert.deepEqual(Object.keys(analytics(makeState([tx("a", ACTIVE, 100, "grocery", { note: "n", merchant: "x" })])).largestTransaction), ["id", "date", "amount", "note"]));
test("largest tie chooses latest date", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 100, "grocery", { date: `${ACTIVE}-01` }), tx("b", ACTIVE, 100, "grocery", { date: `${ACTIVE}-20` })])).largestTransaction.id, "b"));
test("largest date tie chooses stable ID ascending", () => assert.equal(analytics(makeState([tx("z", ACTIVE, 100), tx("a", ACTIVE, 100)])).largestTransaction.id, "a"));
test("highest month is correct", () => assert.equal(analytics(makeState([tx("a", "2026-07", 100), tx("b", "2026-08", 300), tx("c", ACTIVE, 200)])).highestMonth.amount, 300));
test("highest month tie chooses latest month", () => assert.equal(analytics(makeState([tx("a", "2026-07", 300), tx("b", ACTIVE, 300)])).highestMonth.month, ACTIVE));
test("lowest active month excludes zero months", () => assert.equal(analytics(makeState([tx("a", "2026-07", 100), tx("b", "2026-08", 300), tx("c", ACTIVE, 200)])).lowestActiveMonth.amount, 100));
test("lowest active month tie chooses latest month", () => assert.equal(analytics(makeState([tx("a", "2026-07", 100), tx("b", ACTIVE, 100)])).lowestActiveMonth.month, ACTIVE));
test("highest month is null without activity", () => assert.equal(analytics(makeState()).highestMonth, null));
test("lowest active month is null without activity", () => assert.equal(analytics(makeState()).lowestActiveMonth, null));
test("current month expense share is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 30), tx("b", ACTIVE, 70, "rent")])).currentMonthExpenseShare, 0.3));
test("current share is null with zero total", () => assert.equal(analytics(makeState()).currentMonthExpenseShare, null));
test("12-month expense share is correct", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 30), tx("b", "2026-08", 70, "rent")])).twelveMonthExpenseShare, 0.3));
test("12-month share is null with zero total", () => assert.equal(analytics(makeState()).twelveMonthExpenseShare, null));
test("current ranking sorts by amount", () => assert.deepEqual(Category.calculateCategoryRankings(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 2, "rent"), tx("f", ACTIVE, 1, "fuel")]), ACTIVE).current.map((row) => row.categoryId), ["grocery", "rent", "fuel"]));
test("current ranking tie uses category ID", () => assert.deepEqual(Category.calculateCategoryRankings(makeState([tx("r", ACTIVE, 1, "rent"), tx("g", ACTIVE, 1)]), ACTIVE).current.map((row) => row.categoryId), ["grocery", "rent"]));
test("zero-current category currentRank is null", () => assert.equal(analytics(makeState([tx("a", "2026-08", 1)])).currentRank, null));
test("12-month ranking is correct", () => assert.equal(analytics(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 4, "rent")])).twelveMonthRank, 2));
test("12-month ranking tie is stable", () => assert.deepEqual(Category.calculateCategoryRankings(makeState([tx("r", ACTIVE, 1, "rent"), tx("g", ACTIVE, 1)]), ACTIVE).twelveMonth.map((row) => row.categoryId), ["grocery", "rent"]));
test("ranking includes uncategorized", () => assert.ok(Category.calculateCategoryRankings(makeState([tx("u", ACTIVE, 1, "")]), ACTIVE).twelveMonth.some((row) => row.categoryId === "uncat")));
test("ranking includes missing category IDs", () => assert.ok(Category.calculateCategoryRankings(makeState([tx("u", ACTIVE, 1, "removed")]), ACTIVE).twelveMonth.some((row) => row.categoryId === "removed")));
test("overview 12-month totals reconcile", () => { const result = Category.calculateCategoryOverview(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 2, "rent")]), ACTIVE); assert.equal(result.rows.reduce((sum, row) => sum + row.twelveMonthTotal, 0), result.twelveMonthTotalExpenses); });
test("overview current totals reconcile", () => { const result = Category.calculateCategoryOverview(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 2, "rent")]), ACTIVE); assert.equal(result.rows.reduce((sum, row) => sum + row.currentMonthAmount, 0), result.currentTotalExpenses); });
test("top-3 amount is correct", () => assert.equal(Category.calculateCategoryRankings(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 2, "rent"), tx("f", ACTIVE, 1, "fuel"), tx("o", ACTIVE, 4, "other")]), ACTIVE).top3Amount, 9));
test("top-3 share is correct", () => assert.equal(Category.calculateCategoryRankings(makeState([tx("g", ACTIVE, 3), tx("r", ACTIVE, 2, "rent"), tx("f", ACTIVE, 1, "fuel"), tx("o", ACTIVE, 4, "other")]), ACTIVE).top3Share, 0.9));
test("top-3 share is null with no denominator", () => assert.equal(Category.calculateCategoryRankings(makeState(), ACTIVE).top3Share, null));
test("shopping subcategories do not multiply amount", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 180000, "grocery", { shopping: { subcategories: ["meat", "dairy", "cleaning"] } })])).twelveMonthTotal, 180000));
test("tags do not multiply amount", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 180000, "grocery", { tagIds: ["family", "event"] })])).twelveMonthTotal, 180000));
test("exceptional grocery remains counted once", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 180000)], { expenseSettings: { transactionClasses: { a: "exceptional" } } })).twelveMonthTotal, 180000));
test("debt-linked payment uses transaction category once", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 200000, "grocery", { debtObligationId: "rent" })])).twelveMonthTotal, 200000));
test("debt obligation ID is not a category grouping", () => assert.equal(analytics(makeState([tx("a", ACTIVE, 200000, "grocery", { debtObligationId: "rent" })]), "rent").twelveMonthTotal, 0));
test("category rename preserves stable grouping", () => { const source = makeState([tx("a", ACTIVE, 1)]); source.categories[0].name = "renamed"; assert.equal(analytics(source).twelveMonthTotal, 1); });
test("category change moves analytics", () => { const source = makeState([tx("a", ACTIVE, 1)]); source.transactions[0].categoryId = "rent"; assert.deepEqual([analytics(source).twelveMonthTotal, analytics(source, "rent").twelveMonthTotal], [0, 1]); });
test("month move updates series", () => { const source = makeState([tx("a", ACTIVE, 1)]); source.transactions[0].date = "2026-08-10"; assert.deepEqual([analytics(source).series.at(-1).amount, analytics(source).series.at(-2).amount], [0, 1]); });
test("delete lowers stats", () => { const source = makeState([tx("a", ACTIVE, 1), tx("b", ACTIVE, 2)]); source.transactions[1].deletedAt = "x"; assert.deepEqual([analytics(source).twelveMonthTotal, analytics(source).transactionCount12m], [1, 1]); });
test("restore returns stats", () => { const source = makeState([tx("a", ACTIVE, 1, "grocery", { deletedAt: null })]); assert.equal(analytics(source).twelveMonthTotal, 1); });
test("top five explorer ordering and filters are correct", () => {
  const source = makeState([1, 6, 3, 8, 2, 7, 4].map((amount) => tx(`e${amount}`, ACTIVE, amount)).concat([
    tx("deleted", ACTIVE, 99, "grocery", { deletedAt: "x" }), tx("income", ACTIVE, 98, "grocery", { type: "income" }), tx("rent", ACTIVE, 97, "rent"), tx("old", "2026-08", 96),
  ]));
  assert.deepEqual(analytics(source).currentMonthTopTransactions.map((row) => row.amount), [8, 7, 6, 4, 3]);
});
test("default category prefers current-month leader", () => assert.equal(Category.getDefaultCategoryId(makeState([tx("g", ACTIVE, 5), tx("r", "2026-08", 100, "rent")]), ACTIVE), "grocery"));
test("default category falls back to 12-month leader", () => assert.equal(Category.getDefaultCategoryId(makeState([tx("r", "2026-08", 100, "rent")]), ACTIVE), "rent"));
test("default category falls back to first expense definition", () => assert.equal(Category.getDefaultCategoryId(makeState(), ACTIVE), "grocery"));
test("legacy state is safe", () => assert.doesNotThrow(() => Category.calculateCategoryOverview({}, ACTIVE)));
test("overview aggregates the 12-month window once regardless of category count", () => {
  const original = Financial.calculateMonthFinancials;
  let calls = 0;
  Financial.calculateMonthFinancials = (...args) => { calls += 1; return original(...args); };
  try {
    const transactions = Array.from({ length: 20 }, (_, index) => tx(`t${index}`, ACTIVE, index + 1, `category-${index}`));
    Category.calculateCategoryOverview(makeState(transactions), ACTIVE);
    assert.equal(calls, 12);
  } finally { Financial.calculateMonthFinancials = original; }
});

for (const key of ["transactions", "categories", "budgets", "financialSettings", "expenseSettings", "debtSettings", "shoppingSettings", "tagSettings"]) {
  test(`model does not mutate ${key}`, () => {
    const source = makeState([tx("a", ACTIVE, 10)], { budgets: { x: 1 }, financialSettings: { x: 1 }, expenseSettings: { x: 1 }, debtSettings: { x: 1 }, shoppingSettings: { x: 1 }, tagSettings: { x: 1 } });
    const before = JSON.stringify(source[key]);
    Category.calculateCategoryOverview(source, ACTIVE);
    analytics(source);
    assert.equal(JSON.stringify(source[key]), before);
  });
}

test("JSON roundtrip is unchanged by analytics", () => { const source = makeState([tx("a", ACTIVE, 10)]); const before = JSON.stringify(source); analytics(JSON.parse(before)); assert.equal(JSON.stringify(source), before); });
test("all empty numeric outputs avoid NaN and Infinity", () => {
  const result = analytics(makeState());
  const visit = (value) => { if (typeof value === "number") assert.equal(Number.isFinite(value), true); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") Object.values(value).forEach(visit); };
  visit(result);
});
