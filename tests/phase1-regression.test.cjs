"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const index = read("index.html");
const report = read("report-enhancements.js");
const comparison = read("comparison-model.js");
const categoryAnalytics = read("category-analytics-model.js");
const sw = read("sw.js");
const model = read("financial-model.js");
const expenseModel = read("expense-model.js");
const debtModel = read("debt-model.js");
const shoppingModel = read("shopping-model.js");
const tagModel = read("tag-model.js");
const budgetModel = read("budget-model.js");
const count = (text, pattern) => [...text.matchAll(pattern)].length;

const inlineScripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.ok(inlineScripts.length >= 3);
inlineScripts.forEach((source, index) => new vm.Script(source, { filename: `inline-${index + 1}.js` }));
new vm.Script(report, { filename: "report-enhancements.js" });
new vm.Script(comparison, { filename: "comparison-model.js" });
new vm.Script(categoryAnalytics, { filename: "category-analytics-model.js" });
new vm.Script(sw, { filename: "sw.js" });
new vm.Script(model, { filename: "financial-model.js" });
new vm.Script(expenseModel, { filename: "expense-model.js" });
new vm.Script(debtModel, { filename: "debt-model.js" });
new vm.Script(shoppingModel, { filename: "shopping-model.js" });
new vm.Script(tagModel, { filename: "tag-model.js" });
new vm.Script(budgetModel, { filename: "budget-model.js" });

assert.equal(count(index, /<link rel="stylesheet" href="\.\/mobile-enhancements\.css">/g), 1);
assert.equal(count(index, /<script src="\.\/financial-model\.js\?v=20260907-phase3"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/expense-model\.js\?v=20260907-phase3"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/debt-model\.js\?v=20260908-phase3-corrective"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/shopping-model\.js\?v=20260908-phase4"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/tag-model\.js\?v=20260908-phase5"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/budget-model\.js\?v=20260908-phase6"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/comparison-model\.js\?v=20260908-phase7"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/category-analytics-model\.js\?v=20260908-phase8"><\/script>/g), 1);
assert.equal(count(index, /<script src="\.\/report-enhancements\.js\?v=20260908-phase8"><\/script>/g), 1);
assert.ok(index.indexOf('<script src="./financial-model.js?v=20260907-phase3"></script>') < index.indexOf('<script src="./expense-model.js?v=20260907-phase3"></script>'));
assert.ok(index.indexOf('<script src="./expense-model.js?v=20260907-phase3"></script>') < index.indexOf('<script src="./debt-model.js?v=20260908-phase3-corrective"></script>'));
assert.ok(index.indexOf('<script src="./debt-model.js?v=20260908-phase3-corrective"></script>') < index.indexOf("Personal Finance Manager"));
assert.ok(index.indexOf('<script src="./shopping-model.js?v=20260908-phase4"></script>') < index.indexOf("Personal Finance Manager"));
assert.ok(index.indexOf('<script src="./tag-model.js?v=20260908-phase5"></script>') < index.indexOf("Personal Finance Manager"));
assert.ok(index.indexOf('<script src="./budget-model.js?v=20260908-phase6"></script>') < index.indexOf("Personal Finance Manager"));
assert.ok(index.indexOf('<script src="./comparison-model.js?v=20260908-phase7"></script>') < index.indexOf("Personal Finance Manager"));
assert.ok(index.indexOf('<script src="./comparison-model.js?v=20260908-phase7"></script>') < index.indexOf('<script src="./category-analytics-model.js?v=20260908-phase8"></script>'));
assert.ok(index.indexOf('<script src="./category-analytics-model.js?v=20260908-phase8"></script>') < index.indexOf('<script src="./report-enhancements.js?v=20260908-phase8"></script>'));

assert.equal(index.includes("function maybeSeed("), false);
assert.equal(index.includes('note:"مثال: راتب ثابت"'), false);
assert.equal(index.includes('<link rel="icon" href="data:;base64,=">'), false);
assert.match(index, /const STORAGE_KEY = "pfm_data_v1";/);
assert.match(index, /return FinancialModel\.calculateMonthFinancials\(state, month\);/);
assert.match(index, /FinancialModel\.isLegacyOpeningTransaction\(state, activeMonth, t\.id\)/);
assert.match(index, /openingBalanceMode: mode/);
assert.match(index, /legacyOpeningTransactionIds/);
assert.match(index, /delete state\.financialSettings/);
assert.match(index, /isValidAppState\(ev\.detail\)/);
assert.match(index, /rejectInvalidRemote\("manual fetch"\)/);
assert.match(index, /rejectInvalidRemote\("realtime update"\)/);
assert.match(index, /if\(!isValidAppState\(data\)\)/);
assert.match(index, /if\(typeof window\.firebase === "undefined"\)/);
assert.equal(model.includes(".note"), false);
assert.equal(model.includes("carry forward"), false);
assert.equal(model.includes("رصيد مرحل"), false);
assert.equal(expenseModel.includes(".note"), false);
assert.equal(expenseModel.includes("قسط"), false);
assert.equal(expenseModel.includes("دين"), false);

const defaultStart = index.indexOf("const defaultData = () => ({");
const defaultEnd = index.indexOf("function isValidAppState", defaultStart);
assert.ok(defaultStart >= 0 && defaultEnd > defaultStart);
assert.equal(index.slice(defaultStart, defaultEnd).includes("financialSettings"), false);
assert.equal(index.slice(defaultStart, defaultEnd).includes("expenseSettings"), false);
assert.equal(index.slice(defaultStart, defaultEnd).includes("debtSettings"), false);
assert.equal(index.slice(defaultStart, defaultEnd).includes("tagSettings"), false);

for (const id of [
  "kpiAvailable",
  "kpiClosing",
  "kpiExpense",
  "kpiOpening",
  "kpiIncome",
  "kpiNet",
  "kpiSavingRate",
  "openingBalanceMode",
  "openingBalanceAmount",
  "legacyOpeningList",
  "btnSaveFinancialSettings",
  "kpiCostOfLiving",
  "kpiExceptionalExpenses",
  "kpiDebtPayments",
  "txExpenseClassField",
  "txExpenseClass",
  "filterExpenseClass",
  "view-debts",
  "debtList",
  "debtForecastBody",
  "modalDebt",
  "modalDebtDetails",
  "modalDebtPayment",
  "modalDebtLink",
  "txDebtLinkInfo",
  "txTagOptions",
  "filterTransactionTag",
  "modalTags",
  "tagAnalyticsSummary",
  "dashboardComparisonRows",
  "dashboardAttentionList",
  "dashboardTopCategory",
  "dashboardDriverHighlight",
  "dashboardQuickActionsHeading",
]) {
  assert.ok(index.includes(`id="${id}"`), `missing UI control ${id}`);
}

assert.match(report, /FinancialModel\.calculateMonthFinancials\(state, month\)/);
assert.match(report, /closingBalance: financials\.closingBalance/);
assert.match(report, /parsed\.financialSettings/);
assert.match(report, /parsed\.expenseSettings/);
assert.match(report, /parsed\.debtSettings/);
assert.match(report, /ExpenseModel\.calculateExpenseAnalytics\(state, month\)/);
assert.match(sw, /const CACHE_NAME = "pfm-pwa-v14";/);
assert.match(sw, /\.\/tag-model\.js\?v=20260908-phase5/);
assert.match(sw, /\.\/budget-model\.js\?v=20260908-phase6/);
assert.ok(sw.includes('"./financial-model.js?v=20260907-phase3"'));
assert.ok(sw.includes('"./expense-model.js?v=20260907-phase3"'));
assert.ok(sw.includes('"./debt-model.js?v=20260908-phase3-corrective"'));
assert.ok(sw.includes('"./shopping-model.js?v=20260908-phase4"'));
assert.match(sw, /const STALE_SHELL_ASSETS = \[[\s\S]*\.\/debt-model\.js\?v=20260907-phase3[\s\S]*\.\/tag-model\.js[\s\S]*\.\/budget-model\.js[\s\S]*\.\/report-enhancements\.js\?v=20260907-phase3[\s\S]*\];/);
assert.ok(sw.includes("STALE_SHELL_ASSETS.map((asset) => cache.delete(asset))"));
assert.ok(sw.includes('"./comparison-model.js?v=20260908-phase7"'));
assert.ok(sw.includes('"./category-analytics-model.js?v=20260908-phase8"'));
assert.ok(sw.includes('"./dashboard-model.js?v=20260908-phase9"'));
assert.ok(index.includes('<script src="./dashboard-model.js?v=20260908-phase9"></script>'));
assert.ok(sw.includes('"./report-enhancements.js?v=20260908-phase8"'));
assert.ok(sw.includes('"./report-enhancements.js?v=20260908-phase7"'));
assert.ok(sw.includes('"./report-enhancements.js?v=20260908-phase6"'));
assert.equal(sw.includes("enhanceHtml"), false);
assert.equal(sw.includes("REPORT_ENHANCEMENT_SCRIPT"), false);
assert.equal(sw.includes("MOBILE_ENHANCEMENT_STYLE"), false);

console.log("PASS Phase 1–9 syntax, loading, cloud-safety, optional-metadata, and PWA regression checks");
