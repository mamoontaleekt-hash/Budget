const test = require("node:test");
const assert = require("node:assert/strict");
const Tag = require("../tag-model.js");
const Shopping = require("../shopping-model.js");
const Financial = require("../financial-model.js");
const Expense = require("../expense-model.js");
const Debt = require("../debt-model.js");

const tx = (id, type = "expense", amount = 100, date = "2026-08-01", extra = {}) => ({
  id, type, amount, date, categoryId: type === "expense" ? "ex_misc" : "in_other",
  note: "ملاحظة", createdAt: "2026-08-01T00:00:00.000Z", ...extra,
});
const base = (transactions = []) => ({ version: 1, categories: [], transactions, budgets: {} });
const create = (state, name, id) => Tag.createTag(state, name, { id, createdAt: "2026-08-01T00:00:00.000Z" });
const defined = () => create(create(base(), "سفر", "tag_travel").state, "عمل", "tag_work").state;

test("creates an active tag definition", () => {
  const result = create(base(), "سفر", "tag_travel");
  assert.equal(result.error, null);
  assert.deepEqual(result.tag, { id: "tag_travel", name: "سفر", status: "active", createdAt: "2026-08-01T00:00:00.000Z" });
});
test("rejects an empty tag name", () => assert.equal(create(base(), "   ", "tag_empty").error, "empty"));
test("trims surrounding whitespace", () => assert.equal(create(base(), " سفر ", "tag_travel").tag.name, "سفر"));
test("rejects duplicate active names", () => {
  const state = create(base(), "سفر", "tag_one").state;
  assert.equal(create(state, " سفر ", "tag_two").error, "duplicate");
});
test("renames a tag", () => {
  const state = create(base(), "عزيمة", "tag_event").state;
  assert.equal(Tag.renameTag(state, "tag_event", "عزائم").tag.name, "عزائم");
});
test("rejects rename collisions", () => assert.equal(Tag.renameTag(defined(), "tag_work", " سفر ").error, "duplicate"));
test("archives a tag", () => assert.equal(Tag.getTag(Tag.archiveTag(defined(), "tag_travel"), "tag_travel").status, "archived"));
test("restores an archived tag", () => {
  const archived = Tag.archiveTag(defined(), "tag_travel");
  assert.equal(Tag.getTag(Tag.restoreTag(archived, "tag_travel"), "tag_travel").status, "active");
});
test("stable tag ID survives rename", () => {
  const result = Tag.renameTag(defined(), "tag_travel", "رحلة");
  assert.equal(result.tag.id, "tag_travel");
  assert.equal(Tag.getTag(result.state, "tag_travel").name, "رحلة");
});
test("assigns one tag", () => assert.deepEqual(Tag.getTransactionTags(Tag.withTransactionTags(defined(), "a", ["tag_travel"]), "a"), ["tag_travel"]));
test("assigns multiple tags", () => assert.deepEqual(Tag.getTransactionTags(Tag.withTransactionTags(defined(), "a", ["tag_travel", "tag_work"]), "a"), ["tag_travel", "tag_work"]));
test("deduplicates tag IDs", () => assert.deepEqual(Tag.normalizeTagIds(defined(), ["tag_travel", "tag_travel"]), ["tag_travel"]));
test("ignores invalid and missing tag IDs", () => assert.deepEqual(Tag.normalizeTagIds(defined(), ["ghost", null, "tag_work"]), ["tag_work"]));
test("clears all assignments and tidies mappings", () => {
  const tagged = Tag.withTransactionTags(defined(), "a", ["tag_travel"]);
  const cleared = Tag.withTransactionTags(tagged, "a", []);
  assert.deepEqual(Tag.getTransactionTags(cleared, "a"), []);
  assert.equal(Object.hasOwn(cleared.tagSettings, "transactionTags"), false);
});
test("tagSettings is created lazily", () => assert.equal(Object.hasOwn(create(base(), "سفر", "tag_travel").state, "tagSettings"), true));
test("reading state does not create tagSettings", () => {
  const state = base();
  Tag.getTagDefinitions(state); Tag.getActiveTags(state); Tag.calculateTagAnalytics(state, "2026-08");
  assert.equal(Object.hasOwn(state, "tagSettings"), false);
});
test("tag assignment leaves the transaction object unchanged", () => {
  const transaction = tx("a"); const state = { ...defined(), transactions: [transaction] }; const before = structuredClone(transaction);
  const next = Tag.withTransactionTags(state, "a", ["tag_travel"]);
  assert.deepEqual(next.transactions[0], before); assert.equal(next.transactions[0], transaction);
});
test("expense may be tagged", () => {
  const state = Tag.withTransactionTags({ ...defined(), transactions: [tx("expense")] }, "expense", ["tag_travel"]);
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").taggedTransactionCount, 1);
});
test("income may be tagged", () => {
  const state = Tag.withTransactionTags({ ...defined(), transactions: [tx("income", "income")] }, "income", ["tag_work"]);
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").taggedTransactionCount, 1);
});
test("deleted transaction is ignored analytically", () => {
  const state = Tag.withTransactionTags({ ...defined(), transactions: [tx("a", "expense", 100, "2026-08-01", { deletedAt: "x" })] }, "a", ["tag_travel"]);
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").transactionCount, 0);
});
test("restored transaction reactivates tags", () => {
  const transaction = tx("a", "expense", 100, "2026-08-01", { deletedAt: "x" });
  let state = Tag.withTransactionTags({ ...defined(), transactions: [transaction] }, "a", ["tag_travel"]);
  delete transaction.deletedAt;
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").countByTag.tag_travel, 1);
});
test("month change updates analytics", () => {
  const transaction = tx("a"); let state = Tag.withTransactionTags({ ...defined(), transactions: [transaction] }, "a", ["tag_travel"]);
  transaction.date = "2026-09-01";
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").taggedTransactionCount, 0);
  assert.equal(Tag.calculateTagAnalytics(state, "2026-09").taggedTransactionCount, 1);
});
test("archived assigned tag is preserved historically", () => {
  let state = Tag.withTransactionTags(defined(), "a", ["tag_travel"]); state = Tag.archiveTag(state, "tag_travel");
  assert.deepEqual(Tag.getTransactionTags(state, "a"), ["tag_travel"]);
});
test("archived tag is unavailable for a new assignment by default", () => {
  const state = Tag.archiveTag(defined(), "tag_travel");
  assert.deepEqual(Tag.getTransactionTags(Tag.withTransactionTags(state, "new", ["tag_travel"]), "new"), []);
});
test("tag occurrence counts overlap correctly", () => {
  let state = { ...defined(), transactions: [tx("a", "expense", 200), tx("b", "expense", 100)] };
  state = Tag.withTransactionTags(state, "a", ["tag_travel", "tag_work"]); state = Tag.withTransactionTags(state, "b", ["tag_travel"]);
  const result = Tag.calculateTagAnalytics(state, "2026-08");
  assert.equal(result.transactionCount, 2); assert.equal(result.countByTag.tag_travel, 2); assert.equal(result.countByTag.tag_work, 1);
});
test("tag analytics does not multiply money", () => {
  let state = { ...defined(), transactions: [tx("a", "expense", 200), tx("b", "expense", 100)] };
  state = Tag.withTransactionTags(state, "a", ["tag_travel", "tag_work"]); state = Tag.withTransactionTags(state, "b", ["tag_travel"]);
  assert.equal(Financial.calculateMonthFinancials(state, "2026-08").totalExpenses, 300);
  assert.equal(Object.hasOwn(Tag.calculateTagAnalytics(state, "2026-08"), "amountByTag"), false);
});
test("does not infer tags from notes", () => assert.deepEqual(Tag.getTransactionTags({ ...defined(), transactions: [tx("a", "expense", 100, "2026-08-01", { note: "سفر للعمل" })] }, "a"), []));
test("does not infer tags from categories", () => assert.deepEqual(Tag.getTransactionTags({ ...defined(), transactions: [tx("a", "expense", 100, "2026-08-01", { categoryId: "سفر" })] }, "a"), []));
test("shopping metadata remains unchanged beside tags", () => {
  const transaction = tx("g", "expense", 180000, "2026-08-01", { categoryId: "ex_grocery" });
  let state = { ...defined(), transactions: [transaction] };
  state = Shopping.withShoppingSubcategories(state, "g", ["meat", "dairy", "cleaning"]);
  const shoppingBefore = structuredClone(state.shoppingSettings);
  state = Tag.withTransactionTags(state, "g", ["tag_travel", "tag_work"]);
  assert.deepEqual(state.shoppingSettings, shoppingBefore); assert.equal(Shopping.calculateShoppingAnalytics(state, "2026-08").totalShoppingAmount, 180000);
});
test("debt calculations remain unchanged beside tags", () => {
  const payment = tx("p", "expense", 500, "2026-08-01", { categoryId: "ex_debt" });
  const obligation = { id: "home", name: "منزل", type: "house", totalAmount: 1000, paidBeforeTracking: 0, scheduleMode: "irregular", status: "active", createdAt: "x" };
  let state = { ...defined(), transactions: [payment], debtSettings: { obligations: { home: obligation }, paymentLinks: { p: "home" } } };
  const before = Debt.calculateSummary(state, "2026-08-02"); state = Tag.withTransactionTags(state, "p", ["tag_work"]); const after = Debt.calculateSummary(state, "2026-08-02");
  assert.equal(after.totalRemaining, before.totalRemaining); assert.equal(Expense.calculateExpenseAnalytics(state, "2026-08").costOfLiving, 0);
});
test("Phase 1 financial calculations are unchanged", () => {
  let state = { ...defined(), categories: [], transactions: [tx("i", "income", 1000), tx("e", "expense", 300)] };
  const before = Financial.calculateMonthFinancials(state, "2026-08"); state = Tag.withTransactionTags(state, "i", ["tag_work"]); state = Tag.withTransactionTags(state, "e", ["tag_travel"]);
  assert.deepEqual(Financial.calculateMonthFinancials(state, "2026-08"), before);
});
test("Phase 2 expense calculations are unchanged", () => {
  let state = { ...defined(), categories: [], transactions: [tx("e", "expense", 300)], expenseSettings: { transactionClasses: { e: "exceptional" } } };
  const before = Expense.calculateExpenseAnalytics(state, "2026-08"); state = Tag.withTransactionTags(state, "e", ["tag_work", "tag_travel"]);
  assert.deepEqual(Expense.calculateExpenseAnalytics(state, "2026-08"), before);
});
test("Phase 4 shopping calculations are unchanged", () => {
  const transaction = tx("g", "expense", 180000, "2026-08-01", { categoryId: "ex_grocery" });
  let state = Shopping.withShoppingSubcategories({ ...defined(), transactions: [transaction] }, "g", ["meat", "dairy"]);
  const before = Shopping.calculateShoppingAnalytics(state, "2026-08"); state = Tag.withTransactionTags(state, "g", ["tag_work"]);
  assert.deepEqual(Shopping.calculateShoppingAnalytics(state, "2026-08"), before);
});
test("legacy state reads safely", () => assert.deepEqual(Tag.calculateTagAnalytics(base([tx("a")]), "2026-08").countByTag, {}));
test("Phase 4 state reads safely", () => {
  const state = Shopping.withShoppingSubcategories(base([tx("g", "expense", 10, "2026-08-01", { categoryId: "ex_grocery" })]), "g", ["meat"]);
  assert.equal(Tag.calculateTagAnalytics(state, "2026-08").untaggedTransactionCount, 1);
});
test("Phase 5 JSON roundtrip preserves definitions, status, names, mappings and transactions", () => {
  const transactions = [tx("a")]; let state = { ...defined(), transactions };
  state = Tag.withTransactionTags(state, "a", ["tag_travel", "tag_work"]); state = Tag.archiveTag(state, "tag_work");
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored.tagSettings, state.tagSettings); assert.deepEqual(restored.transactions, transactions);
});
