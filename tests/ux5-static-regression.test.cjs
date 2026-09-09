const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const css = read("dashboard-polish.css");
const sw = read("sw.js");
const count = (source, pattern) => (source.match(pattern) || []).length;

test("UX5 assets load once, in order, and are cached in PWA v19", () => {
  const styles = [
    "visual-polish.css?v=20260909-ux2",
    "mobile-enhancements.css?v=20260908-ux1",
    "interaction-polish.css?v=20260909-ux3",
    "budget-polish.css?v=20260909-ux4",
    "dashboard-polish.css?v=20260909-ux5",
  ];
  for (const style of styles) assert.equal(count(html, new RegExp(style.replace(/[.?]/g, "\\$&"), "g")), 1);
  for (let index = 1; index < styles.length; index += 1) assert.ok(html.indexOf(styles[index - 1]) < html.indexOf(styles[index]));
  assert.equal(count(html, /display-format\.js\?v=20260909-ux5/g), 1);
  assert.match(sw, /const CACHE_NAME = "pfm-pwa-v19"/);
  for (const asset of [...styles, "display-format.js?v=20260909-ux5"]) assert.equal(count(sw, new RegExp(asset.replace(/[.?]/g, "\\$&"), "g")), 1);
});

test("topbar preserves daily controls and moves secondary actions into one disclosure", () => {
  assert.doesNotMatch(html, /يعمل أونلاين \(GitHub Pages\).*Firebase/);
  assert.match(html, /نظرة واضحة على أموالك هذا الشهر\./);
  assert.match(html, /<details class="topbar-more" id="topbarMore">/);
  assert.match(html, /<summary class="btn"[^>]*>⋯ المزيد<\/summary>/);
  for (const id of ["monthPicker", "monthPickerDisplay", "btnAddTx", "cloudBadge", "btnExport", "btnImport", "btnCloud"]) {
    assert.equal(count(html, new RegExp(`id="${id}"`, "g")), 1, `${id} must remain unique`);
  }
  assert.match(html, /id="monthPicker" type="month"/);
});

test("default dashboard has four primary values and six accessible detail controls", () => {
  const primary = html.match(/<div class="kpis dashboard-primary-summary"[\s\S]*?<\/div>\s*<div class="dashboard-utility-row">/)?.[0] || "";
  for (const id of ["kpiClosing", "kpiExpense", "kpiIncome", "dashboardBudgetRemaining"]) assert.equal(count(primary, new RegExp(`id="${id}"`, "g")), 1);
  assert.equal(count(primary, /class="kpi"/g), 4);
  assert.equal(count(html, /data-dashboard-panel="[^"]+"/g), 6);
  assert.equal(count(html, /data-dashboard-panel-target="[^"]+"/g), 6);
  assert.equal(count(html, /aria-expanded="false"/g), 6);
  assert.equal(count(html, /aria-controls="dashboardPanel[A-Za-z]+"/g), 6);
  assert.equal(count(html, /id="pieExpense"/g), 1);
  assert.equal(count(html, /id="barIncomeExpense"/g), 1);
  assert.equal(count(html, /id="btnDashboardOpeningBalance"/g), 1);
});

test("UX5 state is ephemeral and budget remaining uses the existing model result", () => {
  assert.match(html, /dashboard\.budget\.remainingBudgetTotal/);
  assert.match(html, /dashboard\.budget\.plannedBudgetTotal > 0/);
  assert.match(html, /let activeDashboardPanel = null/);
  assert.doesNotMatch(html + css, /dashboardPanelState|dashboardView|dashboardLayout|topbarMenuState|monthDisplaySettings|numberFormatSettings|localeSettings|ux5Settings/);
  const panelFunction = html.slice(html.indexOf("function setDashboardPanel"), html.indexOf("function dashboardMetricText"));
  assert.doesNotMatch(panelFunction, /localStorage|save\s*\(|state\./);
});

test("frozen model files exactly match the verified baseline", () => {
  const expected = {
    "financial-model.js":"b1879b0202be66230cd0157bc2bf2e7f02addf17dc24c2d05dd279024937d120",
    "expense-model.js":"36f170a55b7677ef93c297d1031a47743216887c112e8abbda8b70f02fbfc384",
    "debt-model.js":"02cd6889a88a6cb0502adc24f3943e30f9364cb9e4f3e0c13c4759de98d0e293",
    "shopping-model.js":"8b2af8b6cb3b61574cb0f9ee34780bfd329b4e600089ef1922525901184ea871",
    "tag-model.js":"8a5d12a783d4101f5cc3c45a3928a45020ca99bb53a43b6f768f2bbdb37bd178",
    "budget-model.js":"08bea874208994075c082f87d976f574c7a3811f0d95fa09ff6b8f4395832643",
    "comparison-model.js":"69f163d2211236ac12e63fd7b18f342869a002c81c29e826c14bbb983065c818",
    "category-analytics-model.js":"55f9d532b211ecf0e0b677e6c156a8b0fd1f155f22be78c8f66d018e82be0cff",
    "dashboard-model.js":"e61c847f767f0008bbaa5a74df618c824296367f12e0f8ed0c160866e305d027",
  };
  for (const [file, hash] of Object.entries(expected)) {
    const normalized = read(file).replace(/\r\n/g, "\n");
    assert.equal(crypto.createHash("sha256").update(normalized).digest("hex"), hash, `${file} changed`);
  }
});
