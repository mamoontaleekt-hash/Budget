"use strict";

const assert = require("node:assert/strict");
const ExpenseModel = require("../expense-model.js");
const FinancialModel = require("../financial-model.js");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tx = (id, type, amount, date = "2026-08-01", extra = {}) => ({
  id,
  type,
  amount,
  date,
  categoryId: type === "expense" ? "ex_regular" : "in_salary",
  note: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const state = (transactions, options = {}) => ({
  version: 1,
  categories: [],
  transactions,
  budgets: {},
  ...options,
});
const classes = (transactionClasses) => ({ expenseSettings: { transactionClasses } });
const analytics = (source, month = "2026-08") => ExpenseModel.calculateExpenseAnalytics(source, month);
const assertInvariant = (result) => assert.equal(
  result.regularExpenses + result.exceptionalExpenses + result.debtPayments,
  result.totalExpenses
);

test("normal expense defaults to regular", () => {
  assert.equal(ExpenseModel.resolveExpenseClass(state([]), tx("normal", "expense", 100)), "regular");
});

test("ex_debt defaults analytically to debt payment", () => {
  assert.equal(ExpenseModel.resolveExpenseClass(state([]), tx("debt", "expense", 100, undefined, { categoryId: "ex_debt" })), "debt_payment");
});

test("explicit regular overrides ex_debt default", () => {
  const source = state([], classes({ debt: "regular" }));
  assert.equal(ExpenseModel.resolveExpenseClass(source, tx("debt", "expense", 100, undefined, { categoryId: "ex_debt" })), "regular");
});

test("explicit exceptional overrides ex_debt default", () => {
  const source = state([], classes({ debt: "exceptional" }));
  assert.equal(ExpenseModel.resolveExpenseClass(source, tx("debt", "expense", 100, undefined, { categoryId: "ex_debt" })), "exceptional");
});

test("explicit debt payment overrides a non-debt category", () => {
  const source = state([], classes({ fuel: "debt_payment" }));
  assert.equal(ExpenseModel.resolveExpenseClass(source, tx("fuel", "expense", 100)), "debt_payment");
});

test("explicit exceptional is excluded from cost of living", () => {
  const result = analytics(state([tx("repair", "expense", 400)], classes({ repair: "exceptional" })));
  assert.equal(result.exceptionalExpenses, 400);
  assert.equal(result.costOfLiving, 0);
});

test("explicit regular is included in cost of living", () => {
  const result = analytics(state([tx("rent", "expense", 503)], classes({ rent: "regular" })));
  assert.equal(result.regularExpenses, 503);
  assert.equal(result.costOfLiving, 503);
});

test("invalid explicit class falls back safely", () => {
  const regular = state([], classes({ normal: "surprise" }));
  const debt = state([], classes({ debt: "surprise" }));
  assert.equal(ExpenseModel.resolveExpenseClass(regular, tx("normal", "expense", 1)), "regular");
  assert.equal(ExpenseModel.resolveExpenseClass(debt, tx("debt", "expense", 1, undefined, { categoryId: "ex_debt" })), "debt_payment");
});

test("deleted expense is excluded completely", () => {
  const result = analytics(state([tx("deleted", "expense", 999, undefined, { deletedAt: "2026-08-02" })], classes({ deleted: "exceptional" })));
  assert.deepEqual([result.totalExpenses, result.regularExpenses, result.exceptionalExpenses, result.debtPayments], [0, 0, 0, 0]);
});

test("income never appears in expense analytics", () => {
  const result = analytics(state([tx("income", "income", 999)], classes({ income: "debt_payment" })));
  assert.equal(result.totalExpenses, 0);
  assert.equal(ExpenseModel.resolveExpenseClass(state([], classes({ income: "debt_payment" })), tx("income", "income", 999)), null);
});

test("stale classification id is ignored", () => {
  const result = analytics(state([tx("rent", "expense", 100)], classes({ missing: "exceptional" })));
  assert.deepEqual([result.regularExpenses, result.exceptionalExpenses], [100, 0]);
});

test("expense buckets always reconcile to total expenses", () => {
  const source = state([
    tx("regular", "expense", 100),
    tx("exceptional", "expense", 200),
    tx("debt", "expense", 300, undefined, { categoryId: "ex_debt" }),
  ], classes({ exceptional: "exceptional" }));
  const result = analytics(source);
  assertInvariant(result);
  assert.equal(result.totalExpenses, FinancialModel.calculateMonthFinancials(source, "2026-08").totalExpenses);
});

test("cost of living equals regular expenses only", () => {
  const result = analytics(state([tx("regular", "expense", 100), tx("exceptional", "expense", 200)], classes({ exceptional: "exceptional" })));
  assert.equal(result.costOfLiving, result.regularExpenses);
  assert.equal(result.costOfLiving, 100);
});

test("adding an exceptional expense does not change cost of living", () => {
  const before = analytics(state([tx("regular", "expense", 100)]));
  const after = analytics(state([tx("regular", "expense", 100), tx("exceptional", "expense", 800)], classes({ exceptional: "exceptional" })));
  assert.equal(after.costOfLiving, before.costOfLiving);
});

test("adding a debt payment does not change cost of living", () => {
  const before = analytics(state([tx("regular", "expense", 100)]));
  const after = analytics(state([tx("regular", "expense", 100), tx("debt", "expense", 800, undefined, { categoryId: "ex_debt" })]));
  assert.equal(after.costOfLiving, before.costOfLiving);
});

test("debt payment still reduces Phase 1 closing balance", () => {
  const source = state([tx("income", "income", 1000), tx("debt", "expense", 400, undefined, { categoryId: "ex_debt" })]);
  assert.equal(analytics(source).debtPayments, 400);
  assert.equal(FinancialModel.calculateMonthFinancials(source, "2026-08").closingBalance, 600);
});

test("exceptional expense still reduces Phase 1 closing balance", () => {
  const source = state([tx("income", "income", 1000), tx("repair", "expense", 400)], classes({ repair: "exceptional" }));
  assert.equal(analytics(source).exceptionalExpenses, 400);
  assert.equal(FinancialModel.calculateMonthFinancials(source, "2026-08").closingBalance, 600);
});

test("opening balance does not affect cost of living", () => {
  const transactions = [tx("income", "income", 1000), tx("rent", "expense", 500)];
  const withoutOpening = analytics(state(transactions));
  const withOpening = analytics(state(transactions, { financialSettings: { months: { "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 9000 } } } }));
  assert.equal(withOpening.costOfLiving, withoutOpening.costOfLiving);
});

test("legacy opening does not affect cost-of-living classification", () => {
  const source = state([
    tx("legacy", "income", 300),
    tx("income", "income", 1000),
    tx("rent", "expense", 500),
  ], { financialSettings: { months: { "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy"] } } } });
  assert.equal(analytics(source).costOfLiving, 500);
  assert.equal(FinancialModel.calculateMonthFinancials(source, "2026-08").trueIncome, 1000);
});

test("zero true income keeps cost of living and makes ratio unavailable", () => {
  const result = analytics(state([tx("rent", "expense", 500)]));
  assert.equal(result.costOfLiving, 500);
  assert.equal(result.costOfLivingRatio, null);
});

test("old state without either optional settings remains analyzable", () => {
  const source = state([tx("rent", "expense", 500)]);
  assert.equal(Object.hasOwn(source, "expenseSettings"), false);
  assert.equal(analytics(source).costOfLiving, 500);
  assert.equal(Object.hasOwn(source, "expenseSettings"), false);
});

test("Phase 1 state without expense settings remains analyzable", () => {
  const source = state([tx("rent", "expense", 500)], { financialSettings: { months: { "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 10 } } } });
  assert.equal(analytics(source).costOfLiving, 500);
  assert.equal(Object.hasOwn(source, "expenseSettings"), false);
});

test("Phase 2 export/import roundtrip preserves classifications", () => {
  const source = state([tx("repair", "expense", 500)], classes({ repair: "exceptional" }));
  const restored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(restored.expenseSettings, source.expenseSettings);
  assert.deepEqual(restored.transactions, source.transactions);
});

test("deleting and restoring a classified expense ignores then restores it", () => {
  const repair = tx("repair", "expense", 500);
  const source = state([repair], classes({ repair: "exceptional" }));
  assert.equal(analytics(source).exceptionalExpenses, 500);
  repair.deletedAt = "2026-08-02";
  assert.equal(analytics(source).exceptionalExpenses, 0);
  delete repair.deletedAt;
  assert.equal(analytics(source).exceptionalExpenses, 500);
});

test("classification is ignored as income and reactivates if changed back", () => {
  const payment = tx("payment", "expense", 500);
  const source = state([payment], classes({ payment: "debt_payment" }));
  payment.type = "income";
  assert.equal(analytics(source).debtPayments, 0);
  payment.type = "expense";
  assert.equal(analytics(source).debtPayments, 500);
});

test("moving a classified transaction moves its monthly contribution", () => {
  const repair = tx("repair", "expense", 500);
  const source = state([repair], classes({ repair: "exceptional" }));
  repair.date = "2026-09-01";
  assert.equal(analytics(source, "2026-08").exceptionalExpenses, 0);
  assert.equal(analytics(source, "2026-09").exceptionalExpenses, 500);
});

test("AUTO removes only the explicit override", () => {
  const source = state([tx("repair", "expense", 500)], classes({ repair: "exceptional", other: "debt_payment" }));
  const next = ExpenseModel.withExplicitExpenseClass(source, "repair", null);
  assert.equal(ExpenseModel.getExplicitExpenseClass(next, "repair"), null);
  assert.equal(ExpenseModel.resolveExpenseClass(next, source.transactions[0]), "regular");
  assert.equal(next.expenseSettings.transactionClasses.other, "debt_payment");
  assert.deepEqual(source.expenseSettings.transactionClasses, { repair: "exceptional", other: "debt_payment" });
});

test("first explicit override creates expense settings lazily", () => {
  const source = state([tx("repair", "expense", 500)]);
  const next = ExpenseModel.withExplicitExpenseClass(source, "repair", "exceptional");
  assert.equal(Object.hasOwn(source, "expenseSettings"), false);
  assert.deepEqual(next.expenseSettings, { transactionClasses: { repair: "exceptional" } });
});

test("last AUTO override removes empty optional expense settings", () => {
  const source = state([], classes({ repair: "exceptional" }));
  const next = ExpenseModel.withExplicitExpenseClass(source, "repair", "");
  assert.equal(Object.hasOwn(next, "expenseSettings"), false);
});

test("ex_debt analytical default is never persisted automatically", () => {
  const source = state([tx("debt", "expense", 500, undefined, { categoryId: "ex_debt" })]);
  const original = structuredClone(source);
  assert.equal(analytics(source).debtPayments, 500);
  assert.deepEqual(source, original);
  assert.equal(Object.hasOwn(source, "expenseSettings"), false);
});

test("debt-like note text never changes classification", () => {
  for (const note of ["قسط سيارة", "سداد دين", "installment payment"]) {
    const candidate = tx(`note-${note}`, "expense", 100, undefined, { note, categoryId: "ex_regular" });
    assert.equal(ExpenseModel.resolveExpenseClass(state([]), candidate), "regular");
  }
});

test("realistic three-month fixture reconciles classification and Phase 1 cash flow", () => {
  const transactions = [
    tx("june-opening", "income", 300000, "2026-06-01"),
    tx("june-income", "income", 3000000, "2026-06-02"),
    tx("rent", "expense", 503000, "2026-06-03"),
    tx("groceries", "expense", 900000, "2026-06-04"),
    tx("utilities", "expense", 200000, "2026-06-05"),
    tx("fuel", "expense", 150000, "2026-06-06"),
    tx("internet", "expense", 50000, "2026-06-07"),
    tx("car-repair", "expense", 400000, "2026-06-08"),
    tx("appliance", "expense", 250000, "2026-06-09"),
    tx("installment", "expense", 1000000, "2026-06-10", { categoryId: "ex_debt" }),
    tx("july-income", "income", 3200000, "2026-07-01"),
    tx("health", "expense", 300000, "2026-07-02"),
    tx("gift", "expense", 200000, "2026-07-03"),
    tx("explicit-debt", "expense", 350000, "2026-07-04"),
    tx("deleted", "expense", 999999, "2026-07-05", { deletedAt: "2026-07-06" }),
    tx("aug-income", "income", 3000000, "2026-08-01"),
    tx("aug-rent", "expense", 503000, "2026-08-02"),
  ];
  const source = state(transactions, {
    financialSettings: { months: {
      "2026-06": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["june-opening"] },
      "2026-07": { openingBalanceMode: "carry" },
      "2026-08": { openingBalanceMode: "carry" },
    } },
    expenseSettings: { transactionClasses: {
      "car-repair": "exceptional",
      appliance: "exceptional",
      gift: "exceptional",
      "explicit-debt": "debt_payment",
    } },
  });
  const originalTransactions = structuredClone(source.transactions);
  const june = analytics(source, "2026-06");
  assert.deepEqual(
    [june.costOfLiving, june.exceptionalExpenses, june.debtPayments, june.totalExpenses],
    [1803000, 650000, 1000000, 3453000]
  );
  assertInvariant(june);
  const juneFinancials = FinancialModel.calculateMonthFinancials(source, "2026-06");
  assert.deepEqual([juneFinancials.closingBalance, juneFinancials.netCashFlow], [-153000, -453000]);
  const july = analytics(source, "2026-07");
  assert.deepEqual([july.costOfLiving, july.exceptionalExpenses, july.debtPayments, july.totalExpenses], [300000, 200000, 350000, 850000]);
  assertInvariant(july);
  const julyFinancials = FinancialModel.calculateMonthFinancials(source, "2026-07");
  assert.deepEqual([julyFinancials.openingBalance, julyFinancials.closingBalance, julyFinancials.netCashFlow], [-153000, 2197000, 2350000]);
  const august = analytics(source, "2026-08");
  assert.deepEqual([august.costOfLiving, august.exceptionalExpenses, august.debtPayments, august.totalExpenses], [503000, 0, 0, 503000]);
  assertInvariant(august);
  const augustFinancials = FinancialModel.calculateMonthFinancials(source, "2026-08");
  assert.deepEqual([augustFinancials.openingBalance, augustFinancials.closingBalance, augustFinancials.netCashFlow], [2197000, 4694000, 2497000]);
  assert.deepEqual(source.transactions, originalTransactions);
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.run();
      passed += 1;
    } catch (error) {
      console.error(`FAIL ${current.name}`);
      throw error;
    }
  }
  console.log(`PASS ${passed}/${tests.length} expense model tests`);
})();
