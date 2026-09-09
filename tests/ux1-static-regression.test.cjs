const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "mobile-enhancements.css"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

const tabs = [...html.matchAll(/<button type="button" class="tab(?: active)?" data-tab="([^"]+)"[^>]*>/g)];
assert.deepEqual(tabs.map((match) => match[1]), ["dash", "tx", "budgets", "debts", "reports", "settings"]);
assert.match(html, /<nav class="tabs" id="tabs" aria-label="[^"]+">/);
assert.match(html, /data-tab="dash" aria-current="page"/);
assert.match(html, /mobile-enhancements\.css\?v=20260908-ux1/);
assert.match(html, /function setTab\(tab\)[\s\S]*?setAttribute\("aria-current", "page"\)[\s\S]*?removeAttribute\("aria-current"\)/);

assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.topbar\s*{[\s\S]*?position:\s*static/);
assert.match(css, /\.tabs\s*{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*auto 0 0;[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
assert.match(css, /env\(safe-area-inset-bottom\)/);
assert.match(css, /padding:[^;]*88px[^;]*safe-area-inset-bottom/);
assert.match(css, /\.tab\.active::before/);
assert.match(css, /\.tab:focus-visible/);
assert.match(css, /#toast\s*{\s*pointer-events:\s*none/);
assert.match(css, /#toast\s*{\s*bottom:\s*calc\(81px \+ env\(safe-area-inset-bottom\)\) !important/);
assert.doesNotMatch(css, /top:\s*154px|top:\s*246px/);
assert.doesNotMatch(css, /@media \(max-width: 420px\)\s*{\s*\.controls\s*{\s*grid-template-columns:\s*1fr/);

assert.match(sw, /const CACHE_NAME = "pfm-pwa-v16"/);
assert.match(sw, /"\.\/mobile-enhancements\.css\?v=20260908-ux1"/);
assert.doesNotMatch(sw, /pfm-pwa-v14|"\.\/mobile-enhancements\.css"\s*,/);

const setTabBody = html.match(/function setTab\(tab\){([\s\S]*?)\n  }\n\n  \/\/ Month change/)?.[1] || "";
assert.doesNotMatch(setTabBody, /localStorage|\bsave\s*\(/);

console.log("PASS UX1 static navigation, responsive CSS, data-safety, and PWA regression checks");
