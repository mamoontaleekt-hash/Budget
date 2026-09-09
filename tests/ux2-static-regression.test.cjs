const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "visual-polish.css"), "utf8");
const mobile = fs.readFileSync(path.join(root, "mobile-enhancements.css"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

const visualLink = '<link rel="stylesheet" href="./visual-polish.css?v=20260909-ux2">';
const mobileLink = '<link rel="stylesheet" href="./mobile-enhancements.css?v=20260908-ux1">';
assert.equal((html.match(/visual-polish\.css\?v=20260909-ux2/g) || []).length, 1);
assert.ok(html.indexOf(visualLink) < html.indexOf(mobileLink));
assert.match(sw, /const CACHE_NAME = "pfm-pwa-v16"/);
assert.match(sw, /"\.\/visual-polish\.css\?v=20260909-ux2"/);
assert.match(sw, /"\.\/mobile-enhancements\.css\?v=20260908-ux1"/);
assert.doesNotMatch(sw, /pfm-pwa-v15/);

for (const token of ["--ui-space-1", "--ui-space-5", "--ui-text-xs", "--ui-text-xl", "--ui-surface", "--ui-surface-subtle", "--ui-border", "--ui-border-strong", "--ui-shadow-sm", "--ui-shadow-md"]) {
  assert.ok(css.includes(token), `missing UX2 token ${token}`);
}
assert.match(css, /\.phase1-primary \.kpi \.value[\s\S]*?font-size:\s*clamp\(21px/);
assert.match(css, /\.phase2-kpis \.kpi \.value[\s\S]*?font-size:\s*var\(--ui-text-lg\)/);
assert.match(css, /body \.card \.hd h2[\s\S]*?font-size:\s*clamp\(/);
assert.match(css, /\.dashboard-section-head h3[\s\S]*?font-size:\s*var\(--ui-text-lg\)/);
assert.match(css, /\.kpi \.value[\s\S]*?overflow-wrap:\s*anywhere/);
assert.match(css, /\.brand p,[\s\S]*?\.muted[\s\S]*?line-height:\s*1\.7/);
assert.match(css, /#btnAddTx,[\s\S]*?#btnDashboardAddTx[\s\S]*?box-shadow:/);
assert.match(css, /\.btn\.danger[\s\S]*?rgba\(229, 72, 77/);
assert.match(css, /\.card \.card,[\s\S]*?box-shadow:\s*none/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.phase1-primary \.kpi \.value/);
assert.match(mobile, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
assert.match(mobile, /#toast\s*{\s*bottom:\s*calc\(81px \+ env\(safe-area-inset-bottom\)\) !important/);
assert.match(mobile, /\.modal\s*{[\s\S]*?z-index:\s*30/);
assert.match(mobile, /\.btn:focus-visible/);

for (const model of ["financial-model.js", "expense-model.js", "debt-model.js", "budget-model.js", "comparison-model.js", "category-analytics-model.js", "dashboard-model.js", "shopping-model.js", "tag-model.js"]) {
  assert.ok(!css.includes(model));
}
assert.doesNotMatch(html + css, /fonts\.googleapis\.com|@import\s+url|themeSettings|uiSettings|typographySettings|visualSettings|layoutSettings/);

console.log("PASS UX2 static visual hierarchy, action semantics, data-safety, and PWA checks");
