"use strict";

const assert = require("node:assert/strict");
const Shopping = require("../shopping-model.js");
const Financial = require("../financial-model.js");
const Expense = require("../expense-model.js");
const Debt = require("../debt-model.js");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tx = (id, extra = {}) => ({
  id, type: "expense", amount: 180000, date: "2026-08-10", categoryId: "ex_grocery",
  note: "فاتورة اختبار", createdAt: "2026-08-10T00:00:00.000Z", ...extra,
});
const state = (transactions = [], extra = {}) => ({ version: 1, categories: [], transactions, budgets: {}, ...extra });
const tagged = (source, transactionId, ids) => Shopping.withShoppingSubcategories(source, transactionId, ids);

test("one selection is stored separately", () => {
  const source = state([tx("a")]);
  assert.deepEqual(Shopping.getShoppingSubcategories(tagged(source, "a", ["meat"]), "a"), ["meat"]);
});
test("multiple simultaneous selections are supported", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["meat", "dairy", "cleaning"]), ["meat", "dairy", "cleaning"]));
test("duplicate ids are deduplicated", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["meat", "meat"]), ["meat"]));
test("invalid ids are ignored", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["meat", "unknown", null]), ["meat"]));
test("mixed can be selected alone", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["mixed"]), ["mixed"]));
test("selecting mixed clears detailed values", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["meat", "dairy", "mixed"]), ["mixed"]));
test("selecting a detail after mixed clears mixed", () => assert.deepEqual(Shopping.normalizeShoppingSubcategories(["mixed", "cleaning"]), ["cleaning"]));
test("empty selection removes the transaction mapping", () => {
  const next = tagged(tagged(state([tx("a")]), "a", ["meat"]), "a", []);
  assert.equal(Object.hasOwn(next, "shoppingSettings"), false);
});
test("shopping settings are created lazily", () => {
  const source = state([tx("a")]);
  assert.equal(Object.hasOwn(source, "shoppingSettings"), false);
  assert.deepEqual(tagged(source, "a", ["dairy"]).shoppingSettings, { transactionSubcategories: { a: ["dairy"] } });
});
test("reading and analytics do not create shopping settings", () => {
  const source = state([tx("a")]);
  Shopping.getShoppingSubcategories(source, "a");
  Shopping.calculateShoppingAnalytics(source, "2026-08");
  assert.equal(Object.hasOwn(source, "shoppingSettings"), false);
});
test("non-grocery expense metadata is ignored", () => {
  const source = tagged(state([tx("a", { categoryId: "ex_food" })]), "a", ["meat"]);
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").shoppingTransactionCount, 0);
});
test("income metadata is ignored", () => {
  const source = tagged(state([tx("a", { type: "income" })]), "a", ["meat"]);
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").shoppingTransactionCount, 0);
});
test("deleted grocery transaction is ignored and restoration reactivates metadata", () => {
  const receipt = tx("a");
  const source = tagged(state([receipt]), "a", ["meat"]);
  receipt.deletedAt = "2026-08-11";
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").shoppingTransactionCount, 0);
  delete receipt.deletedAt;
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").countBySubcategory.meat, 1);
});
test("category changes away and back reactivate retained metadata", () => {
  const receipt = tx("a");
  const source = tagged(state([receipt]), "a", ["dairy"]);
  receipt.categoryId = "ex_misc";
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").taggedShoppingTransactionCount, 0);
  receipt.categoryId = "ex_grocery";
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").taggedShoppingTransactionCount, 1);
});
test("month move updates analytics", () => {
  const receipt = tx("a");
  const source = tagged(state([receipt]), "a", ["produce"]);
  receipt.date = "2026-09-01";
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-08").shoppingTransactionCount, 0);
  assert.equal(Shopping.calculateShoppingAnalytics(source, "2026-09").shoppingTransactionCount, 1);
});
test("classification leaves transaction object and array unchanged", () => {
  const receipt = tx("a");
  const source = state([receipt]);
  const before = structuredClone(receipt);
  const next = tagged(source, "a", ["meat", "dairy"]);
  assert.deepEqual(receipt, before);
  assert.equal(next.transactions, source.transactions);
  assert.equal(next.transactions[0], receipt);
});
test("total amount counts each multi-tag receipt once", () => {
  let source = state([tx("a", { amount: 180000 }), tx("b", { amount: 100000 })]);
  source = tagged(source, "a", ["meat", "dairy", "cleaning"]);
  source = tagged(source, "b", ["dairy", "beverages"]);
  const result = Shopping.calculateShoppingAnalytics(source, "2026-08");
  assert.equal(result.totalShoppingAmount, 280000);
  assert.equal(result.shoppingTransactionCount, 2);
  assert.equal(result.taggedShoppingTransactionCount, 2);
  assert.equal(result.untaggedShoppingTransactionCount, 0);
  assert.deepEqual({ meat: result.countBySubcategory.meat, dairy: result.countBySubcategory.dairy, cleaning: result.countBySubcategory.cleaning, beverages: result.countBySubcategory.beverages }, { meat: 1, dairy: 2, cleaning: 1, beverages: 1 });
  assert.equal(Object.keys(result).some((key) => /spend|amountBy|money/i.test(key)), false);
});
test("untagged receipt is counted without inferred note tags", () => {
  const result = Shopping.calculateShoppingAnalytics(state([tx("a", { note: "لحم حليب منظفات" })]), "2026-08");
  assert.equal(result.totalShoppingAmount, 180000);
  assert.equal(result.untaggedShoppingTransactionCount, 1);
  assert.equal(result.countBySubcategory.meat, 0);
});
test("old and Phase 3 states remain valid and analyzable", () => {
  const old = state([tx("a")]);
  const phase3 = state([tx("a")], { debtSettings: { obligations: {}, paymentLinks: {} } });
  assert.equal(Shopping.calculateShoppingAnalytics(old, "2026-08").shoppingTransactionCount, 1);
  assert.equal(Shopping.calculateShoppingAnalytics(phase3, "2026-08").shoppingTransactionCount, 1);
});
test("Phase 4 JSON roundtrip preserves exact metadata", () => {
  const source = tagged(state([tx("a")]), "a", ["meat", "dairy"]);
  const restored = JSON.parse(JSON.stringify(source));
  assert.deepEqual(restored.shoppingSettings, source.shoppingSettings);
  assert.deepEqual(restored.transactions, source.transactions);
});
test("shopping metadata changes no financial, expense, or debt totals", () => {
  const receipt = tx("a");
  const obligation = { id: "loan", name: "قرض", type: "personal", totalAmount: 1000, paidBeforeTracking: 0, startDate: "", scheduleMode: "irregular", status: "active", note: "", createdAt: "2026-01-01" };
  const source = state([tx("income", { type: "income", categoryId: "in_salary", amount: 500000 }), receipt], { debtSettings: { obligations: { loan: obligation } }, expenseSettings: { transactionClasses: { a: "exceptional" } } });
  const before = { financial: Financial.calculateMonthFinancials(source, "2026-08"), expense: Expense.calculateExpenseAnalytics(source, "2026-08"), debt: Debt.calculateSummary(source, "2026-08-31") };
  const next = tagged(source, "a", ["meat", "dairy", "cleaning"]);
  const after = { financial: Financial.calculateMonthFinancials(next, "2026-08"), expense: Expense.calculateExpenseAnalytics(next, "2026-08"), debt: Debt.calculateSummary(next, "2026-08-31") };
  assert.deepEqual(after.financial, before.financial);
  assert.deepEqual(after.expense, before.expense);
  assert.deepEqual(after.debt, before.debt);
  assert.equal(Expense.resolveExpenseClass(next, receipt), "exceptional");
});

let passed = 0;
for (const item of tests) {
  try { item.run(); passed += 1; }
  catch (error) { console.error(`FAIL: ${item.name}`); throw error; }
}
console.log(`${passed}/${tests.length} shopping model tests passed`);
