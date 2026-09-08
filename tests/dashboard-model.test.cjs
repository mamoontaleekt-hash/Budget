"use strict";

const assert = require("node:assert/strict");
const Dashboard = require("../dashboard-model.js");
const Financial = require("../financial-model.js");
const Expense = require("../expense-model.js");
const Comparison = require("../comparison-model.js");
const CategoryAnalytics = require("../category-analytics-model.js");
const Budget = require("../budget-model.js");
const Debt = require("../debt-model.js");

let passed = 0;
function test(name, run) {
  try { run(); passed += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

const MONTH = "2026-09";
const PREVIOUS = "2026-08";
const TODAY = "2026-09-08";
const categories = [
  { id: "income", type: "income", name: "دخل" },
  { id: "grocery", type: "expense", name: "سوبرماركت" },
  { id: "rent", type: "expense", name: "إيجار" },
  { id: "fuel", type: "expense", name: "وقود" },
];
const tx = (id, month, type, amount, categoryId, extra = {}) => ({
  id, date: `${month}-05`, type, amount, categoryId, note: id, ...extra,
});
function state(transactions = [], extra = {}) {
  return { version: 1, categories: categories.map((row) => ({ ...row })), transactions, budgets: {}, ...extra };
}
function settings(opening) {
  return { months: { [MONTH]: { openingBalanceMode: "manual", openingBalanceAmount: opening } } };
}
function obligation(overrides = {}) {
  return {
    id: "loan", name: "قسط المنزل", type: "house", totalAmount: 300, paidBeforeTracking: 0,
    startDate: "2026-06-01", scheduleMode: "fixed", installmentAmount: 100,
    frequency: "monthly", firstDueDate: "2026-07-01", status: "active",
    createdAt: "2026-06-01T00:00:00.000Z", ...overrides,
  };
}
function withDebt(source, item = obligation()) {
  return { ...source, debtSettings: { obligations: { [item.id]: item }, paymentLinks: {} } };
}
const summary = (source, today = TODAY) => Dashboard.calculateDashboardSummary(source, MONTH, today);

test("empty state is safe", () => {
  const result = summary(state());
  assert.equal(result.financials.totalExpenses, 0);
  assert.equal(result.topCategory, null);
  assert.equal(result.attention[0].type, "quiet");
});

test("financial summary matches FinancialModel", () => {
  const source = state([tx("i", MONTH, "income", 3000000, "income"), tx("e", MONTH, "expense", 2000000, "grocery")], { financialSettings: settings(500000) });
  assert.deepEqual(summary(source).financials, Financial.calculateMonthFinancials(source, MONTH));
});

test("healthy scenario preserves available closing and net", () => {
  const source = state([tx("i", MONTH, "income", 3000000, "income"), tx("e", MONTH, "expense", 2000000, "grocery")], { financialSettings: settings(500000) });
  const result = summary(source).financials;
  assert.deepEqual([result.availableCash, result.closingBalance, result.netCashFlow], [3500000, 1500000, 1000000]);
});

test("expense summary matches ExpenseModel", () => {
  const source = state([tx("r", MONTH, "expense", 10, "rent"), tx("x", MONTH, "expense", 20, "fuel")], { expenseSettings: { transactionClasses: { x: "exceptional" } } });
  assert.deepEqual(summary(source).expenses, Expense.calculateExpenseAnalytics(source, MONTH));
});

test("comparison metrics match ComparisonModel", () => {
  const source = state([tx("old", PREVIOUS, "expense", 100, "grocery"), tx("new", MONTH, "expense", 130, "grocery")]);
  const compact = summary(source).comparison.metrics;
  const full = Comparison.calculateMonthlyComparison(source, MONTH, PREVIOUS).metrics;
  assert.deepEqual(compact.totalExpenses, full.totalExpenses);
  assert.deepEqual(compact.costOfLiving, full.costOfLiving);
  assert.deepEqual(compact.netCashFlow, full.netCashFlow);
});

test("top category matches CategoryAnalyticsModel", () => {
  const source = state([tx("g", MONTH, "expense", 1100, "grocery"), tx("r", MONTH, "expense", 500, "rent")]);
  assert.deepEqual(summary(source).topCategory, CategoryAnalytics.calculateCategoryRankings(source, MONTH, 1).current[0]);
});

test("budget summary matches BudgetModel", () => {
  const source = state([tx("g", MONTH, "expense", 90, "grocery")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 } } } } });
  assert.deepEqual(summary(source).budget, Budget.calculateBudgetAnalytics(source, MONTH));
});

test("debt summary matches DebtModel", () => {
  const source = withDebt(state());
  assert.deepEqual(summary(source).debt, Debt.calculateSummary(source, TODAY));
});

test("expense classes do not double count", () => {
  const source = state([tx("r", MONTH, "expense", 10, "rent"), tx("x", MONTH, "expense", 20, "fuel"), tx("d", MONTH, "expense", 30, "grocery")], { expenseSettings: { transactionClasses: { x: "exceptional", d: "debt_payment" } } });
  const result = summary(source);
  assert.equal(result.expenses.regularExpenses + result.expenses.exceptionalExpenses + result.expenses.debtPayments, result.financials.totalExpenses);
});

test("summary does not mutate state", () => {
  const source = withDebt(state([tx("g", MONTH, "expense", 10, "grocery")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 5 } } } } }));
  const before = JSON.stringify(source); summary(source); assert.equal(JSON.stringify(source), before);
});

test("no output number is NaN or Infinity", () => {
  const result = summary(state([tx("bad", MONTH, "expense", "not-a-number", "grocery")]));
  const numbers = [];
  (function visit(value) { if (typeof value === "number") numbers.push(value); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") Object.values(value).forEach(visit); })(result);
  assert.equal(numbers.every(Number.isFinite), true);
});

test("uncategorized expense is safe and can rank first", () => {
  const result = summary(state([tx("u", MONTH, "expense", 20, ""), tx("g", MONTH, "expense", 10, "grocery")]));
  assert.equal(result.topCategory.categoryId, Comparison.UNCATEGORIZED);
});

test("missing category definition is safe", () => {
  const result = summary(state([tx("m", MONTH, "expense", 20, "removed-category")]));
  assert.equal(result.topCategory.categoryId, "removed-category");
});

test("negative closing creates factual attention", () => {
  const source = state([tx("i", MONTH, "income", 500, "income"), tx("e", MONTH, "expense", 800, "grocery")], { financialSettings: settings(100) });
  assert.ok(summary(source).attention.some((item) => item.type === "negative_closing" && item.amount === 200));
});

test("negative net creates distinct attention", () => {
  const source = state([tx("i", MONTH, "income", 1000, "income"), tx("e", MONTH, "expense", 1500, "grocery")], { financialSettings: settings(2000) });
  assert.ok(summary(source).attention.some((item) => item.type === "negative_net" && item.amount === 500));
});

test("positive closing with negative net stays distinct", () => {
  const source = state([tx("i", MONTH, "income", 1000, "income"), tx("e", MONTH, "expense", 1500, "grocery")], { financialSettings: settings(2000) });
  const result = summary(source);
  assert.equal(result.financials.closingBalance, 1500);
  assert.equal(result.attention.some((item) => item.type === "negative_closing"), false);
  assert.equal(result.attention.some((item) => item.type === "negative_net"), true);
});

test("overdue debt has highest priority", () => {
  const source = withDebt(state([tx("g", MONTH, "expense", 120, "grocery")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 } } } } }));
  assert.equal(summary(source).attention[0].type, "overdue_debt");
});

test("exceeded budget follows overdue debt", () => {
  const source = withDebt(state([tx("g", MONTH, "expense", 120, "grocery")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 } } } } }));
  assert.deepEqual(summary(source).attention.slice(0, 2).map((item) => item.type), ["overdue_debt", "budget_alert"]);
});

test("at-limit sorts below exceeded", () => {
  const source = state([tx("g", MONTH, "expense", 120, "grocery"), tx("r", MONTH, "expense", 100, "rent")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 }, rent: { amount: 100 } } } } });
  assert.deepEqual(summary(source).attention.slice(0, 2).map((item) => item.status), [Budget.EXCEEDED, Budget.AT_LIMIT]);
});

test("warning sorts below at-limit", () => {
  const source = state([tx("r", MONTH, "expense", 100, "rent"), tx("f", MONTH, "expense", 80, "fuel")], { budgets: { [MONTH]: { plan: {}, items: { rent: { amount: 100 }, fuel: { amount: 100 } } } } });
  assert.deepEqual(summary(source).attention.slice(0, 2).map((item) => item.status), [Budget.AT_LIMIT, Budget.WARNING]);
});

test("monthly increase sorts below debt and budget", () => {
  const source = withDebt(state([
    tx("old-income", PREVIOUS, "income", 1000, "income"), tx("old", PREVIOUS, "expense", 50, "grocery"),
    tx("new-income", MONTH, "income", 1000, "income"), tx("new", MONTH, "expense", 120, "grocery"),
  ], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 } } } } }));
  assert.deepEqual(summary(source).attention.map((item) => item.type), ["overdue_debt", "budget_alert", "expense_increase"]);
});

test("maximum attention items is enforced", () => {
  const source = withDebt(state([
    tx("old", PREVIOUS, "expense", 20, "grocery"),
    tx("g", MONTH, "expense", 120, "grocery"),
    tx("r", MONTH, "expense", 100, "rent"),
    tx("f", MONTH, "expense", 80, "fuel"),
  ], {
    budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 }, rent: { amount: 100 }, fuel: { amount: 100 } } } },
    financialSettings: settings(-500),
  }));
  assert.equal(summary(source).attention.length, Dashboard.MAX_ATTENTION_ITEMS);
});

test("healthy state is quiet", () => {
  const source = state([tx("i", MONTH, "income", 100, "income")], { budgets: { [MONTH]: { plan: {}, items: { grocery: { amount: 100 } } } } });
  assert.equal(summary(source).attention[0].type, "quiet");
});

test("current month is marked incomplete", () => assert.equal(summary(state(), TODAY).comparison.isIncompleteCurrentMonth, true));
test("historical month is not marked incomplete", () => assert.equal(summary(state(), "2026-10-01").comparison.isIncompleteCurrentMonth, false));
test("last calendar day remains incomplete", () => assert.equal(summary(state(), "2026-09-30").comparison.isIncompleteCurrentMonth, true));

test("zero comparison baseline has no fabricated percentage", () => {
  const result = summary(state([tx("new", MONTH, "expense", 30, "grocery")])).comparison.metrics.totalExpenses;
  assert.equal(result.state, "NEW"); assert.equal(result.percentChange, null);
});

test("top category share uses valid positive spending", () => {
  const result = summary(state([tx("g", MONTH, "expense", 1100, "grocery"), tx("r", MONTH, "expense", 500, "rent"), tx("f", MONTH, "expense", 300, "fuel")]));
  assert.equal(result.topCategory.categoryId, "grocery");
  assert.ok(Math.abs(result.topCategory.share - 1100 / 1900) < 1e-10);
});

test("driver selects one largest increase", () => {
  const source = state([tx("og", PREVIOUS, "expense", 100, "grocery"), tx("or", PREVIOUS, "expense", 100, "rent"), tx("ng", MONTH, "expense", 400, "grocery"), tx("nr", MONTH, "expense", 200, "rent")]);
  const highlight = summary(source).driverHighlight;
  assert.equal(highlight.kind, "increase"); assert.equal(highlight.driver.categoryId, "grocery"); assert.equal(highlight.driver.delta, 300);
});

test("total can rise while cost of living falls", () => {
  const source = state([
    tx("old-r", PREVIOUS, "expense", 800, "grocery"), tx("old-x", PREVIOUS, "expense", 100, "rent"), tx("old-d", PREVIOUS, "expense", 100, "fuel"),
    tx("new-r", MONTH, "expense", 600, "grocery"), tx("new-x", MONTH, "expense", 600, "rent"), tx("new-d", MONTH, "expense", 200, "fuel"),
  ], { expenseSettings: { transactionClasses: { "old-x": "exceptional", "old-d": "debt_payment", "new-x": "exceptional", "new-d": "debt_payment" } } });
  const metrics = summary(source).comparison.metrics;
  assert.equal(metrics.totalExpenses.delta, 400);
  assert.equal(metrics.costOfLiving.delta, -200);
});

test("unchanged total with changed composition is highlighted", () => {
  const source = state([tx("og", PREVIOUS, "expense", 100, "grocery"), tx("ng", MONTH, "expense", 50, "grocery"), tx("nr", MONTH, "expense", 50, "rent")]);
  assert.equal(summary(source).driverHighlight.kind, "composition_changed");
});

test("dashboard selection is never persisted", () => {
  const result = summary(state([tx("g", MONTH, "expense", 1, "grocery")]));
  assert.equal(Object.hasOwn(result, "settings"), false);
  assert.equal(Object.hasOwn(result, "selectedHighlight"), false);
});

test("legacy and optional Phase 1-8 metadata remain safe", () => {
  const source = state([tx("legacy", MONTH, "expense", 10, "", { shopping: { subcategories: ["mixed"] }, tagIds: ["old"] })], {
    financialSettings: { months: {} }, expenseSettings: {}, debtSettings: {}, shoppingSettings: {}, tagSettings: {},
  });
  assert.doesNotThrow(() => summary(source));
});

test("due today outranks ordinary upcoming debt interpretation", () => {
  const source = withDebt(state(), obligation({ totalAmount: 100, firstDueDate: TODAY }));
  assert.equal(summary(source).debtAttention.state, "due_today");
});

console.log(`Dashboard model tests: ${passed}/${passed} PASS`);
