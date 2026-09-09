(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMDisplayFormat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MONTH_NAMES = Object.freeze([
    "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
    "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
  ]);
  const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

  function finiteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function westernizeDigits(value) {
    return String(value ?? "")
      .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)));
  }

  function formatNumber(value, options) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    const formatted = new Intl.NumberFormat("en-US", options || {}).format(number);
    return westernizeDigits(formatted);
  }

  function formatMoney(value) {
    const number = finiteNumber(value);
    return `${formatNumber(number === null ? 0 : Math.round(number), { maximumFractionDigits: 0 })} د.ع`;
  }

  function formatPercent(value, digits) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    const precision = Number.isInteger(digits) && digits >= 0 ? digits : 0;
    return `${formatNumber(number, { minimumFractionDigits: precision, maximumFractionDigits: precision })}%`;
  }

  function formatMonthKey(monthKey) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthKey || ""));
    if (!match) return "—";
    return `${MONTH_NAMES[Number(match[2]) - 1]} ${westernizeDigits(match[1])}`;
  }

  return { formatNumber, formatMoney, formatPercent, formatMonthKey, westernizeDigits };
});
