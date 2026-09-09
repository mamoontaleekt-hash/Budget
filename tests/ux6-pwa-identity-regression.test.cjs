"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readBinary = (file) => fs.readFileSync(path.join(root, file));
const html = read("index.html");
const manifest = JSON.parse(read("manifest.json"));
const sw = read("sw.js");
const svg = read("icons/app-icon.svg");

function pngDimensions(file) {
  const png = readBinary(file);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.subarray(0, 8).equals(signature), `${file} must be a PNG`);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR", `${file} must start with IHDR`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
}

test("browser identity uses the clean Arabic title and new icon filenames", () => {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.equal(title, "إدارة المصاريف الشخصية");
  assert.doesNotMatch(title, /Firebase/i);
  assert.doesNotMatch(title, /أونلاين/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="إدارة المصاريف">/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="icons\/app-icon\.svg">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="icons\/app-icon-192\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/app-icon-192\.png">/);
  assert.doesNotMatch(html, /href="icons\/icon-(?:192|512)\.png"/);
});

test("manifest preserves the installed-app contract with non-technical copy", () => {
  assert.equal(manifest.name, "نظام إدارة المصاريف");
  assert.equal(manifest.short_name, "مصاريفي");
  assert.equal(manifest.description, "نظرة واضحة على أموالك ومصاريفك وميزانيتك.");
  assert.doesNotMatch(manifest.description, /Firebase|GitHub Pages/i);
  assert.equal(manifest.lang, "ar");
  assert.equal(manifest.dir, "rtl");
  assert.equal(manifest.start_url, "./?pwa=1");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons, [
    { src: "icons/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "icons/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ]);
  assert.equal(manifest.icons.some(({ src }) => /icons\/icon-(?:192|512)\.png$/.test(src)), false);
});

test("new local icon assets are valid, exact-size, and distinct from the legacy icons", () => {
  for (const file of ["icons/app-icon.svg", "icons/app-icon-192.png", "icons/app-icon-512.png"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
    assert.ok(fs.statSync(path.join(root, file)).size > 0, `${file} must be non-empty`);
  }
  assert.deepEqual(pngDimensions("icons/app-icon-192.png"), { width: 192, height: 192, bytes: readBinary("icons/app-icon-192.png").length });
  assert.deepEqual(pngDimensions("icons/app-icon-512.png"), { width: 512, height: 512, bytes: readBinary("icons/app-icon-512.png").length });
  assert.equal(readBinary("icons/app-icon-192.png").equals(readBinary("icons/icon-192.png")), false);
  assert.equal(readBinary("icons/app-icon-512.png").equals(readBinary("icons/icon-512.png")), false);
});

test("source icon reuses the UX6 wallet mark inside a maskable-safe full-bleed field", () => {
  const walletSymbol = html.match(/<symbol id="icon-wallet"[\s\S]*?<\/symbol>/)?.[0] || "";
  for (const geometry of [
    "M4 7V5a2 2 0 0 1 2-2h12v4",
    "M16 12h5v5h-5a2.5 2.5 0 0 1 0-5Z",
  ]) {
    assert.ok(walletSymbol.includes(geometry), `inline UX6 wallet geometry missing: ${geometry}`);
    assert.ok(svg.includes(geometry), `source icon must reuse UX6 wallet geometry: ${geometry}`);
  }
  assert.match(svg, /<rect width="24" height="24" fill="#2F6BFF"\/>/);
  assert.match(svg, /stroke="#FFFFFF"/);
  assert.match(svg, /stroke-width="1\.8"/);
  assert.match(svg, /transform="translate\(4\.2 4\.2\) scale\(\.65\)"/);
  assert.doesNotMatch(svg, /<text\b|<image\b|gradient|filter|shadow/i);
});

test("PWA v21 pre-caches only the authoritative identity assets", () => {
  assert.match(sw, /const CACHE_NAME = "pfm-pwa-v21";/);
  const appShell = sw.match(/const APP_SHELL = \[([\s\S]*?)\n\];/)?.[1] || "";
  for (const asset of [
    "./icons/app-icon.svg",
    "./icons/app-icon-192.png",
    "./icons/app-icon-512.png",
  ]) {
    assert.ok(appShell.includes(`"${asset}"`), `${asset} must be in APP_SHELL`);
  }
  assert.doesNotMatch(appShell, /\.\/icons\/icon-(?:192|512)\.png/);
  assert.match(sw, /key\.startsWith\("pfm-pwa-"\) && key !== CACHE_NAME/);
});
