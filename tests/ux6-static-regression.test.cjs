const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const css = read("theme-system.css");
const sw = read("sw.js");
const manifest = JSON.parse(read("manifest.json"));
const count = (source, pattern) => (source.match(pattern) || []).length;

test("UX6 theme is loaded once, last, and cached in PWA v21", () => {
  const assets = [
    "visual-polish.css?v=20260909-ux2",
    "mobile-enhancements.css?v=20260908-ux1",
    "interaction-polish.css?v=20260909-ux3",
    "budget-polish.css?v=20260909-ux4",
    "dashboard-polish.css?v=20260909-ux5",
    "theme-system.css?v=20260909-ux6",
  ];
  for (const asset of assets) {
    const escaped = asset.replace(/[.?]/g, "\\$&");
    assert.equal(count(html, new RegExp(escaped, "g")), 1, `${asset} should load once`);
    assert.equal(count(sw, new RegExp(escaped, "g")), 1, `${asset} should be cached once`);
  }
  for (let i = 1; i < assets.length; i += 1) assert.ok(html.indexOf(assets[i - 1]) < html.indexOf(assets[i]));
  const lastStylesheet = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].at(-1)?.[1];
  assert.equal(lastStylesheet, "./theme-system.css?v=20260909-ux6");
  assert.match(sw, /const CACHE_NAME = "pfm-pwa-v21"/);
});

test("semantic tokens and the quiet flat shell palette are frozen", () => {
  const tokens = {
    "theme-bg": "#f5f7fb", "theme-surface": "#ffffff", "theme-surface-soft": "#f8fafc",
    "theme-surface-raised": "#f3f6fa", "theme-text": "#172033", "theme-text-muted": "#667085",
    "theme-text-quiet": "#7b8495", "theme-border": "#e3e8ef", "theme-border-strong": "#d6dde7",
    "theme-primary": "#2f6bff", "theme-primary-hover": "#2459d3", "theme-primary-soft": "#eef4ff",
    "theme-secondary": "#0f9f8c", "theme-secondary-soft": "#eaf8f5", "theme-secondary-foreground": "#0b6f63", "theme-success": "#178a60",
    "theme-success-foreground": "#116b4a", "theme-warning": "#b7791f", "theme-warning-foreground": "#89580f",
    "theme-danger": "#c94b52", "theme-danger-foreground": "#a6373f",
  };
  for (const [name, value] of Object.entries(tokens)) assert.match(css, new RegExp(`--${name}:\\s*${value}`, "i"));
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--theme-bg\)/s);
  assert.match(css, /\.topbar[\s\S]*backdrop-filter:\s*none/);
  assert.match(css, /--theme-shadow-sm:\s*0 1px 2px rgba\(15, 23, 42, \.04\)/);
  assert.match(css, /--theme-shadow-md:\s*0 8px 24px rgba\(15, 23, 42, \.06\)/);
});

test("one reusable inline SVG sprite covers the required interface language", () => {
  assert.equal(count(html, /class="ui-icon-sprite"/g), 1);
  const ids = [...html.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "symbol IDs must be unique");
  for (const id of ["icon-dashboard", "icon-transactions", "icon-budget", "icon-debt", "icon-reports", "icon-settings", "icon-calendar", "icon-cloud", "icon-more", "icon-download", "icon-upload", "icon-wallet", "icon-income", "icon-expense", "icon-balance", "icon-details", "icon-comparison", "icon-analysis", "icon-charts", "icon-edit", "icon-delete", "icon-save", "icon-warning", "icon-success", "icon-info"]) {
    assert.ok(ids.includes(id), `${id} missing`);
  }
  assert.match(css, /stroke:\s*currentColor/);
  assert.doesNotMatch(html + css, /fontawesome|font-awesome|lucide|heroicons|material-icons|fonts\.googleapis|cdnjs|unpkg/i);
});

test("six navigation destinations and visible primary surfaces retain labels and use SVGs", () => {
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal(count(nav, /class="tab(?: active)?"/g), 6);
  assert.equal(count(nav, /data-tab="(?:dash|tx|budgets|debts|reports|settings)"/g), 6);
  assert.equal(count(nav, /<svg class="ui-icon"/g), 6);
  assert.equal(count(nav, /<use href="#icon-[^"]+"><\/use>/g), 6);
  assert.doesNotMatch(nav, /📊|🧾|🧩|📉|📈|⚙️/);

  const shell = html.slice(html.indexOf('<div class="topbar">'), html.indexOf("<!-- DASHBOARD -->"));
  assert.doesNotMatch(shell, /₠|➕|☁️|⬇️|⬆️|⋯/);
  for (const label of ["إدارة المصاريف الشخصية", "نظرة واضحة على أموالك هذا الشهر.", "إضافة عملية", "غير متصل", "المزيد"]) assert.match(shell, new RegExp(label));

  const primary = html.match(/<div class="kpis dashboard-primary-summary"[\s\S]*?<div class="dashboard-utility-row">/)?.[0] || "";
  assert.equal(count(primary, /class="kpi"/g), 4);
  assert.equal(count(primary, /class="kpi-icon"/g), 4);
  assert.doesNotMatch(primary, /🏁|🧾|💰|🧩/);
  const launcher = html.match(/<div class="dashboard-detail-launcher">[\s\S]*?<\/div>\s*<\/section>/)?.[0] || "";
  assert.equal(count(launcher, /data-dashboard-panel="[^"]+"/g), 6);
  assert.equal(count(launcher, /<svg class="ui-icon"/g), 6);
  assert.doesNotMatch(launcher, /💰|📊|🧾|💳|🧩|📈/);
});

test("final button, focus, motion, and status systems are explicit", () => {
  assert.match(css, /\.btn\.primary\s*\{[^}]*background:\s*var\(--theme-primary\)/s);
  assert.doesNotMatch(css.match(/\.btn\.primary\s*\{[^}]*\}/s)?.[0] || "", /gradient/i);
  assert.match(css, /\.btn\.danger\s*\{[^}]*background:\s*var\(--theme-danger-soft\)/s);
  assert.match(css, /\.tab\.active,[\s\S]*?color:\s*var\(--theme-primary-hover\)/);
  assert.match(css, /\.dashboard-detail-button\[aria-expanded="true"\]::after\s*\{\s*color:\s*var\(--theme-primary-hover\)/);
  assert.match(css, /\.transaction-tags\s*\{\s*color:\s*var\(--theme-secondary-foreground\)/);
  assert.match(html, /item\.overpayment > 0[^\n]*color:var\(--theme-warning-foreground\)/);
  assert.match(css, /\.money:not\(\.pos\):not\(\.neg\)/);
  assert.doesNotMatch(css, /\.money:not\(\.neg\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid rgba\(47, 107, 255, \.22\)/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /prefers-color-scheme|\.dark(?:\s|\{|,)|dark-mode|theme-toggle/i);
  assert.doesNotMatch(html + css, /themeSettings|appearanceSettings|colorSettings|iconSettings|ux6Settings/);
});

test("canvas charts use the restrained light-theme palette without changing chart inputs", () => {
  assert.match(html, /const palette = \["#2f6bff", "#0f9f8c", "#6c7aa1"/);
  assert.match(html, /label:"دخل حقيقي", value: income, col: "#0f9f8c"/);
  assert.match(html, /label:"مصروف", value: expense, col: "#c94b52"/);
  assert.match(html, /ctx\.strokeStyle = "#e3e8ef"/);
  assert.match(html, /const maxV = Math\.max\(\.\.\.series\.flatMap\(s=>\[s\.income,s\.expense,s\.costOfLiving\]\), 1\)/);
});

test("manifest identity is preserved while shell colors intentionally change", () => {
  assert.equal(manifest.name, "نظام إدارة المصاريف");
  assert.equal(manifest.short_name, "مصاريفي");
  assert.equal(manifest.start_url, "./?pwa=1");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#f5f7fb");
  assert.equal(manifest.background_color, "#f5f7fb");
  assert.match(html, /<meta name="theme-color" content="#F5F7FB">/);
  assert.equal(manifest.icons.length, 2);
});

test("frozen model files exactly match the verified UX5 baseline", () => {
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
