const test = require("node:test");
const assert = require("node:assert/strict");
const Format = require("../display-format.js");

test("money uses Western digits, comma grouping, and stable IQD text", () => {
  assert.equal(Format.formatMoney(3235000), "3,235,000 د.ع");
  assert.equal(Format.formatMoney(0), "0 د.ع");
  assert.equal(Format.formatMoney(-100000), "-100,000 د.ع");
  assert.equal(Format.formatMoney(null), "0 د.ع");
  assert.equal(Format.formatMoney(Number.NaN), "0 د.ع");
  assert.equal(Format.formatMoney(Number.POSITIVE_INFINITY), "0 د.ع");
});

test("percentages retain requested precision without localized digits", () => {
  assert.equal(Format.formatPercent(64.7, 1), "64.7%");
  assert.equal(Format.formatPercent(85, 0), "85%");
  assert.equal(Format.formatPercent(undefined, 1), "—");
});

test("Iraqi month names keep YYYY-MM as input and Western year digits", () => {
  assert.equal(Format.formatMonthKey("2026-09"), "أيلول 2026");
  assert.equal(Format.formatMonthKey("2026-08"), "آب 2026");
  assert.equal(Format.formatMonthKey("2026-01"), "كانون الثاني 2026");
  assert.equal(Format.formatMonthKey("2026-13"), "—");
  assert.equal(Format.formatMonthKey("invalid"), "—");
});

test("digit conversion is pure and supports Arabic and Persian digits", () => {
  const source = "١٢٣ / ۴۵۶";
  assert.equal(Format.westernizeDigits(source), "123 / 456");
  assert.equal(source, "١٢٣ / ۴۵۶");
  assert.equal(Format.formatNumber("12345.6", { maximumFractionDigits: 1 }), "12,345.6");
});
