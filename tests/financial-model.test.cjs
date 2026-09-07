"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../financial-model.js");

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const categories = [
  { id: "income", type: "income", name: "Income" },
  { id: "expense", type: "expense", name: "Expense" },
];
const transaction = (id, type, amount, date, extra = {}) => ({
  id,
  type,
  amount,
  date,
  categoryId: type === "income" ? "income" : "expense",
  note: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const state = (transactions, financialSettings) => ({
  version: 1,
  categories,
  transactions,
  budgets: {},
  ...(financialSettings ? { financialSettings } : {}),
});
const settings = (months) => ({ months });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);

test("zero opening uses true income only", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 3000000, "2026-08-01"),
    transaction("expense", "expense", 2500000, "2026-08-02"),
  ]), "2026-08");
  assert.deepEqual(
    { opening: result.openingBalance, income: result.trueIncome, available: result.availableCash, expense: result.totalExpenses, closing: result.closingBalance, net: result.netCashFlow },
    { opening: 0, income: 3000000, available: 3000000, expense: 2500000, closing: 500000, net: 500000 }
  );
  closeTo(result.savingsRate, 16.666666666666664);
});

test("manual opening separates opening balance from income", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 3000000, "2026-08-01"),
    transaction("expense", "expense", 2500000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 300000 } })), "2026-08");
  assert.deepEqual(
    { opening: result.openingBalance, income: result.trueIncome, available: result.availableCash, closing: result.closingBalance, net: result.netCashFlow },
    { opening: 300000, income: 3000000, available: 3300000, closing: 800000, net: 500000 }
  );
  closeTo(result.savingsRate, 16.666666666666664);
});

test("large opening does not change savings rate", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 3000000, "2026-08-01"),
    transaction("expense", "expense", 2500000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 10000000 } })), "2026-08");
  closeTo(result.savingsRate, 16.666666666666664);
});

test("zero income makes savings rate unavailable", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("expense", "expense", 100000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 800000 } })), "2026-08");
  assert.deepEqual(
    { available: result.availableCash, closing: result.closingBalance, net: result.netCashFlow, rate: result.savingsRate },
    { available: 800000, closing: 700000, net: -100000, rate: null }
  );
});

test("cash can remain positive while income-based savings is negative", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 500000, "2026-08-01"),
    transaction("expense", "expense", 800000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 1000000 } })), "2026-08");
  assert.equal(result.closingBalance, 700000);
  assert.equal(result.netCashFlow, -300000);
  assert.equal(result.savingsRate, -60);
});

test("negative closing balance is preserved", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 500000, "2026-08-01"),
    transaction("expense", "expense", 800000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 100000 } })), "2026-08");
  assert.equal(result.closingBalance, -200000);
});

test("manual opening may be negative", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 1000000, "2026-08-01"),
    transaction("expense", "expense", 500000, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: -100000 } })), "2026-08");
  assert.equal(result.availableCash, 900000);
  assert.equal(result.closingBalance, 400000);
});

test("legacy opening excludes only the explicitly selected income", () => {
  const legacy = transaction("legacy", "income", 300000, "2026-08-01", { note: "رصيد سابق" });
  const original = structuredClone(legacy);
  const result = model.calculateMonthFinancials(state([
    legacy,
    transaction("income", "income", 3000000, "2026-08-02"),
    transaction("expense", "expense", 2500000, "2026-08-03"),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy"] } })), "2026-08");
  assert.deepEqual(
    { opening: result.openingBalance, income: result.trueIncome, available: result.availableCash, closing: result.closingBalance },
    { opening: 300000, income: 3000000, available: 3300000, closing: 800000 }
  );
  assert.deepEqual(legacy, original);
});

test("unconfigured legacy-looking transaction remains ordinary income", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "income", 300000, "2026-08-01", { note: "carry forward" }),
    transaction("income", "income", 3000000, "2026-08-02"),
  ]), "2026-08");
  assert.equal(result.openingBalance, 0);
  assert.equal(result.trueIncome, 3300000);
});

test("deleted legacy transaction does not contribute", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "income", 300000, "2026-08-01", { deletedAt: "2026-08-05T00:00:00.000Z" }),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy"] } })), "2026-08");
  assert.equal(result.openingBalance, 0);
});

test("legacy reference with the wrong type does not contribute", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "expense", 300000, "2026-08-01"),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy"] } })), "2026-08");
  assert.equal(result.openingBalance, 0);
});

test("legacy reference from another month does not contribute", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "income", 300000, "2026-07-31"),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy"] } })), "2026-08");
  assert.equal(result.openingBalance, 0);
});

test("duplicate legacy ids do not double count", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "income", 300000, "2026-08-01"),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["legacy", "legacy"] } })), "2026-08");
  assert.equal(result.openingBalance, 300000);
});

test("missing and malformed legacy references fail safely", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("empty", "income", "", "2026-08-01"),
    transaction("boolean", "income", true, "2026-08-02"),
  ], settings({ "2026-08": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["missing", "empty", "boolean"] } })), "2026-08");
  assert.equal(result.openingBalance, 0);
  assert.equal(result.trueIncome, 0);
});

test("the active mode is authoritative and modes are never added together", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("legacy", "income", 300000, "2026-08-01"),
  ], settings({ "2026-08": {
    openingBalanceMode: "manual",
    openingBalanceAmount: 300000,
    legacyOpeningTransactionIds: ["legacy"],
  } })), "2026-08");
  assert.equal(result.openingBalance, 300000);
  assert.equal(result.trueIncome, 300000);
  assert.equal(result.availableCash, 600000);
});

test("one-month carry uses previous closing balance", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("aug-income", "income", 3000000, "2026-08-01"),
    transaction("aug-expense", "expense", 2500000, "2026-08-02"),
    transaction("sep-income", "income", 100000, "2026-09-01"),
  ], settings({
    "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: 300000 },
    "2026-09": { openingBalanceMode: "carry" },
  })), "2026-09");
  assert.equal(result.openingBalance, 800000);
  assert.equal(result.closingBalance, 900000);
});

test("consecutive carry months form a dynamic chain", () => {
  const synthetic = state([
    transaction("june-income", "income", 1000, "2026-06-01"),
    transaction("june-expense", "expense", 400, "2026-06-02"),
    transaction("july-income", "income", 500, "2026-07-01"),
    transaction("july-expense", "expense", 100, "2026-07-02"),
    transaction("aug-expense", "expense", 200, "2026-08-02"),
  ], settings({
    "2026-06": { openingBalanceMode: "manual", openingBalanceAmount: 100 },
    "2026-07": { openingBalanceMode: "carry" },
    "2026-08": { openingBalanceMode: "carry" },
  }));
  const july = model.calculateMonthFinancials(synthetic, "2026-07");
  const august = model.calculateMonthFinancials(synthetic, "2026-08");
  assert.equal(july.openingBalance, 700);
  assert.equal(july.closingBalance, 1100);
  assert.equal(august.openingBalance, 1100);
  assert.equal(august.closingBalance, 900);
});

test("carry recalculates after previous-month changes", () => {
  const synthetic = state([
    transaction("aug-income", "income", 1000, "2026-08-01"),
    transaction("aug-expense", "expense", 200, "2026-08-02"),
  ], settings({ "2026-09": { openingBalanceMode: "carry" } }));
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-09").openingBalance, 800);
  synthetic.transactions[1].amount = 500;
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-09").openingBalance, 500);
});

test("January carry crosses the year boundary", () => {
  const synthetic = state([
    transaction("dec-income", "income", 1000, "2025-12-01"),
    transaction("dec-expense", "expense", 250, "2025-12-02"),
  ], settings({ "2026-01": { openingBalanceMode: "carry" } }));
  assert.equal(model.getPreviousMonth("2026-01"), "2025-12");
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-01").openingBalance, 750);
});

test("deleted ordinary transactions remain excluded", () => {
  const result = model.calculateMonthFinancials(state([
    transaction("income", "income", 1000, "2026-08-01"),
    transaction("deleted-income", "income", 9000, "2026-08-02", { deletedAt: "2026-08-03" }),
    transaction("deleted-expense", "expense", 8000, "2026-08-03", { deletedAt: "2026-08-04" }),
  ]), "2026-08");
  assert.equal(result.trueIncome, 1000);
  assert.equal(result.totalExpenses, 0);
});

test("legacy backup without financial settings defaults opening to zero", () => {
  const legacyBackup = JSON.parse(JSON.stringify(state([
    transaction("income", "income", 3300000, "2026-08-01"),
  ])));
  const result = model.calculateMonthFinancials(legacyBackup, "2026-08");
  assert.equal(result.openingBalance, 0);
  assert.equal(result.trueIncome, 3300000);
});

test("new backup roundtrip preserves financial settings exactly", () => {
  const source = state([], settings({
    "2026-08": { openingBalanceMode: "manual", openingBalanceAmount: -25, legacyOpeningTransactionIds: ["old"] },
    "2026-09": { openingBalanceMode: "carry" },
  }));
  const restored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(restored.financialSettings, source.financialSettings);
});

test("cloud validation accepts legacy state and rejects malformed state", () => {
  const index = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  const start = index.indexOf("function isValidAppState(value)");
  const end = index.indexOf("function load()", start);
  assert.ok(start >= 0 && end > start);
  const source = index.slice(start, end);
  const context = vm.createContext({});
  vm.runInContext(`${source}; this.validate = isValidAppState;`, context);
  assert.equal(context.validate(state([])), true);
  assert.equal(context.validate({}), false);
  assert.equal(context.validate({ categories, transactions: [], budgets: {}, financialSettings: { months: {} } }), true);
});

test("realistic three-month fixture remains unchanged until explicitly configured", () => {
  const transactions = [
    transaction("june-income", "income", 3000, "2026-06-01"),
    transaction("june-expense", "expense", 2100, "2026-06-02"),
    transaction("july-legacy", "income", 900, "2026-07-01", { note: "رصيد مرحل" }),
    transaction("july-income", "income", 3000, "2026-07-02"),
    transaction("july-expense", "expense", 2500, "2026-07-03"),
    transaction("aug-income", "income", 3200, "2026-08-01"),
    transaction("aug-expense", "expense", 2700, "2026-08-02"),
    transaction("deleted", "expense", 999, "2026-08-03", { deletedAt: "2026-08-04" }),
  ];
  const synthetic = { version: 1, categories, transactions, budgets: { "2026-07": { plan: {}, items: { expense: { amount: 2600 } } } } };
  const before = structuredClone(synthetic.transactions);
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-07").trueIncome, 3900);
  synthetic.financialSettings = settings({ "2026-07": { openingBalanceMode: "legacy", legacyOpeningTransactionIds: ["july-legacy"] }, "2026-08": { openingBalanceMode: "carry" } });
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-07").trueIncome, 3000);
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-07").openingBalance, 900);
  assert.equal(model.calculateMonthFinancials(synthetic, "2026-08").openingBalance, 1400);
  assert.deepEqual(synthetic.transactions, before);
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
  console.log(`PASS ${passed}/${tests.length} financial model tests`);
})();

