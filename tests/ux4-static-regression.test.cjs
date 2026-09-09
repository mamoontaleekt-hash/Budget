const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const css = read("budget-polish.css");
const sw = read("sw.js");
const count = (source, pattern) => (source.match(pattern) || []).length;

test("UX4 stylesheet order remains preserved in the PWA v21 shell", () => {
  const styles = [
    "visual-polish.css?v=20260909-ux2",
    "mobile-enhancements.css?v=20260908-ux1",
    "interaction-polish.css?v=20260909-ux3",
    "budget-polish.css?v=20260909-ux4",
  ];
  assert.equal(count(html, /budget-polish\.css\?v=20260909-ux4/g), 1);
  for (let i = 1; i < styles.length; i += 1) assert.ok(html.indexOf(styles[i - 1]) < html.indexOf(styles[i]));
  assert.match(sw, /const CACHE_NAME = "pfm-pwa-v21"/);
  for (const asset of styles) assert.equal(count(sw, new RegExp(asset.replace(/[.?]/g, "\\$&"), "g")), 1);
  assert.doesNotMatch(sw, /pfm-pwa-v17/);
});

test("BudgetModel and persisted budget contract remain frozen", () => {
  const model = read("budget-model.js").replace(/\r\n/g, "\n");
  assert.equal(crypto.createHash("sha256").update(model).digest("hex"), "08bea874208994075c082f87d976f574c7a3811f0d95fa09ff6b8f4395832643");
  assert.match(html, /state\.budgets\[activeMonth\] = \{ plan: \{ income1: planIncome1\|\|0, income2: planIncome2\|\|0, note: planNote \}, items \}/);
  assert.doesNotMatch(html + css, /mobileBudgetData|budgetCardData|budgetDraftState|budgetViewState|budgetUISettings|ux4Settings/);
});

test("one semantic category row owns one amount and one note control", () => {
  const render = html.slice(html.indexOf("function renderBudgets()"), html.indexOf("function renderReports()"));
  assert.equal(count(render, /class="budgetInput"/g), 1);
  assert.equal(count(render, /class="budgetNote"/g), 1);
  for (const cls of ["budget-category", "budget-planned", "budget-actual", "budget-remaining", "budget-percent", "budget-status", "budget-note-cell"]) assert.ok(render.includes(cls));
  for (const label of ["الميزانية المخططة", "المصروف الفعلي", "المتبقي", "المستخدم", "الحالة", "ملاحظة"]) assert.ok(render.includes(`data-label="${label}"`));
  assert.match(html, /<table class="budget-table">\s*<thead>/);
});

test("desktop and mobile saves share one explicit named handler", () => {
  assert.equal(count(html, /id="btnSaveBudgets"/g), 1);
  assert.equal(count(html, /id="btnSaveBudgetsMobile"/g), 1);
  assert.match(html, /function saveBudgets\(\)\{/);
  assert.match(html, /#btnSaveBudgets"\)\.onclick = saveBudgets/);
  assert.match(html, /#btnSaveBudgetsMobile"\)\.onclick = saveBudgets/);
  assert.equal(count(html, /state\.budgets\[activeMonth\] = \{ plan:/g), 1);
  assert.doesNotMatch(html, /budgetInput[^\n]*(?:change|blur)[^\n]*saveBudgets|budgetNote[^\n]*(?:change|blur)[^\n]*saveBudgets/);
});

test("planned income labels and opening balance controls are preserved", () => {
  for (const [id, label] of [["planIncome1", "الدخل المخطط الأول"], ["planIncome2", "الدخل المخطط الثاني"], ["planNote", "ملاحظة الخطة"]]) {
    assert.equal(count(html, new RegExp(`id="${id}"`, "g")), 1);
    assert.ok(html.includes(`<label for="${id}">${label}</label>`));
  }
  for (const id of ["openingBalanceMode", "openingBalanceAmount", "legacyOpeningList", "btnSaveFinancialSettings"]) assert.equal(count(html, new RegExp(`id="${id}"`, "g")), 1);
});

test("UX4 CSS is budget-scoped with a mobile card breakpoint", () => {
  assert.match(css, /@media \(max-width:720px\)/);
  assert.match(css, /#view-budgets \.budget-table thead \{\s*display: none/);
  assert.match(css, /#view-budgets \.budget-table tr\[data-cat\] \{\s*display: grid/);
  assert.match(css, /#view-budgets \.budget-mobile-save \{[\s\S]*?display: block/);
  assert.doesNotMatch(css, /(^|\n)\s*\.(?:tabs|topbar|tx-mobile-card|tx-table-wrap)\b/);
});
