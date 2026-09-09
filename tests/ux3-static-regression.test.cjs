const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "interaction-polish.css"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const count = (source, pattern) => (source.match(pattern) || []).length;

test("UX3 stylesheet order and PWA shell are exact", () => {
  const visual = '<link rel="stylesheet" href="./visual-polish.css?v=20260909-ux2">';
  const mobile = '<link rel="stylesheet" href="./mobile-enhancements.css?v=20260908-ux1">';
  const interaction = '<link rel="stylesheet" href="./interaction-polish.css?v=20260909-ux3">';
  assert.equal(count(html, /interaction-polish\.css\?v=20260909-ux3/g), 1);
  assert.ok(html.indexOf(visual) < html.indexOf(mobile));
  assert.ok(html.indexOf(mobile) < html.indexOf(interaction));
  assert.match(sw, /const CACHE_NAME = "pfm-pwa-v21"/);
  for (const asset of ["visual-polish.css?v=20260909-ux2", "mobile-enhancements.css?v=20260908-ux1", "interaction-polish.css?v=20260909-ux3"]) assert.ok(sw.includes(`"./${asset}"`));
  assert.doesNotMatch(sw, /pfm-pwa-v16/);
});

test("primary and advanced filters exist once with labels", () => {
  const primary = ["filterSearch", "filterType", "filterCategory"];
  const advanced = ["filterExpenseClass", "filterShoppingSubcategory", "filterTransactionTag", "filterFrom", "filterTo", "filterMin", "filterMax"];
  for (const id of [...primary, ...advanced]) {
    assert.equal(count(html, new RegExp(`id="${id}"`, "g")), 1, `${id} must be unique`);
    assert.equal(count(html, new RegExp(`for="${id}"`, "g")), 1, `${id} must have one label`);
  }
  assert.match(html, /<details[^>]+id="txAdvancedFilters"/);
  assert.match(html, /<summary>فلاتر متقدمة/);
  assert.match(html, /if\(advancedFilterCount > 0\) advancedDetails\.open = true/);
  assert.match(html, /فلاتر مفعلة/);
});

test("one filtered transaction source feeds table, cards, count, and empty states", () => {
  const render = html.slice(html.indexOf("function renderTransactions()"), html.indexOf("function debtTypeLabel"));
  assert.equal(count(render, /state\.transactions\.slice\(\)/g), 1);
  assert.match(render, /let txs = monthTxs/);
  assert.match(render, /const txViews = txs\.map/);
  assert.match(render, /tbody\.innerHTML = txViews\.map/);
  assert.match(render, /mobileList\.innerHTML = txViews\.map/);
  assert.match(render, /txs\.length.*عملية/);
  assert.match(render, /لا توجد عمليات في هذا الشهر/);
  assert.match(render, /لا توجد نتائج تطابق الفلاتر الحالية/);
  assert.match(render, /<article class="tx-mobile-card"/);
  assert.match(render, /data-tx-id/);
  assert.doesNotMatch(render, /addEventListener/);
});

test("actions are delegated once and deletion stays recoverable", () => {
  assert.equal(count(html, /#txTableBody"\)\.addEventListener\("click", handleTransactionAction\)/g), 1);
  assert.equal(count(html, /#txMobileList"\)\.addEventListener\("click", handleTransactionAction\)/g), 1);
  assert.match(html, /tx\.deletedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(html, /deletedReason = "user-delete"/);
  assert.match(html, /نقل العملية إلى سلة المحذوفات/);
});

test("transaction form is grouped, labelled, and keeps manual date behavior", () => {
  for (const id of ["txType", "txDate", "txCategory", "txAmount", "txNote", "txExpenseClass"]) assert.equal(count(html, new RegExp(`for="${id}"`, "g")), 1);
  for (const heading of ["المعلومات الأساسية", "تصنيف المصروف", "تفاصيل إضافية"]) assert.ok(html.includes(heading));
  assert.match(html, /#txDate"\)\.value = tx\?\.date \|\| ""/);
  assert.doesNotMatch(html, /#txDate"\)\.value = (?:todayISO|thisMonth)/);
  assert.match(html, /id="txAmount" type="number" inputmode="numeric"/);
  assert.match(html, /id="txEditingHint"/);
});

test("UX3 CSS is scoped and switches only the transaction list at 720px", () => {
  assert.match(css, /@media \(max-width:720px\)/);
  assert.match(css, /#view-tx \.tx-table-wrap \{ display:none; \}/);
  assert.match(css, /#view-tx \.tx-mobile-list \{ display:grid/);
  assert.match(css, /#modalTx \.ft \{ position:sticky/);
  assert.match(css, /#modalTx \.dialog \{ max-height:calc\(100vh - 36px\); display:flex/);
  assert.match(css, /#modalTx \.tx-form-body \{[^}]*overflow:auto;[^}]*min-height:0/);
  assert.doesNotMatch(css, /(^|\n)\s*\.tabs\b/);
  assert.doesNotMatch(css, /(^|\n)\s*\.topbar\b/);
  assert.doesNotMatch(css, /transactionViewMode|filterPanelState|advancedFiltersOpen|mobileCardPreference|interactionSettings|ux3Settings/);
});

test("frozen model files remain outside UX3 presentation code", () => {
  for (const model of ["financial-model.js", "expense-model.js", "debt-model.js", "shopping-model.js", "tag-model.js", "budget-model.js", "comparison-model.js", "category-analytics-model.js", "dashboard-model.js"]) {
    assert.ok(fs.existsSync(path.join(root, model)));
  }
});
