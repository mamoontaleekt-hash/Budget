(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMShoppingModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SHOPPING_CATEGORY_ID = "ex_grocery";
  const MIXED_ID = "mixed";
  const SUBCATEGORIES = Object.freeze([
    { id: "meat", label: "لحوم ودواجن وأسماك" },
    { id: "dairy", label: "ألبان وأجبان وبيض" },
    { id: "produce", label: "خضروات وفواكه" },
    { id: "pantry", label: "مواد غذائية جافة ومعلبات" },
    { id: "bakery", label: "خبز ومخبوزات" },
    { id: "beverages", label: "مياه ومشروبات" },
    { id: "frozen", label: "مجمدات" },
    { id: "cleaning", label: "منظفات ومستلزمات تنظيف" },
    { id: "personal_care", label: "عناية شخصية" },
    { id: "baby", label: "مستلزمات أطفال" },
    { id: "household", label: "مستلزمات منزلية" },
    { id: "snacks", label: "حلويات وسناكات" },
    { id: "other", label: "أخرى" },
    { id: MIXED_ID, label: "فاتورة متنوعة" },
  ]);
  const VALID_IDS = new Set(SUBCATEGORIES.map((item) => item.id));

  function numericAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string" || value.trim() === "") return 0;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
  }

  function isShoppingTransaction(transaction) {
    return !!transaction
      && typeof transaction === "object"
      && transaction.type === "expense"
      && transaction.categoryId === SHOPPING_CATEGORY_ID
      && !transaction.deletedAt;
  }

  function normalizeShoppingSubcategories(ids) {
    if (!Array.isArray(ids)) return [];
    const selected = [];
    ids.forEach((id) => {
      if (!VALID_IDS.has(id)) return;
      if (id === MIXED_ID) {
        selected.length = 0;
        selected.push(MIXED_ID);
        return;
      }
      const mixedIndex = selected.indexOf(MIXED_ID);
      if (mixedIndex >= 0) selected.splice(mixedIndex, 1);
      if (!selected.includes(id)) selected.push(id);
    });
    return selected;
  }

  function getMappings(state) {
    const mappings = state?.shoppingSettings?.transactionSubcategories;
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return null;
    return mappings;
  }

  function getShoppingSubcategories(state, transactionId) {
    if (typeof transactionId !== "string" || transactionId.length === 0) return [];
    return normalizeShoppingSubcategories(getMappings(state)?.[transactionId]);
  }

  function withShoppingSubcategories(state, transactionId, ids) {
    if (!state || typeof state !== "object" || typeof transactionId !== "string" || transactionId.length === 0) {
      return state;
    }
    const normalized = normalizeShoppingSubcategories(ids);
    const currentSettings = state.shoppingSettings
      && typeof state.shoppingSettings === "object"
      && !Array.isArray(state.shoppingSettings)
      ? state.shoppingSettings
      : {};
    const mappings = { ...(getMappings(state) || {}) };
    if (normalized.length > 0) mappings[transactionId] = normalized;
    else delete mappings[transactionId];

    const nextSettings = { ...currentSettings };
    if (Object.keys(mappings).length > 0) nextSettings.transactionSubcategories = mappings;
    else delete nextSettings.transactionSubcategories;

    const nextState = { ...state };
    if (Object.keys(nextSettings).length > 0) nextState.shoppingSettings = nextSettings;
    else delete nextState.shoppingSettings;
    return nextState;
  }

  function calculateShoppingAnalytics(state, month) {
    const countBySubcategory = Object.fromEntries(SUBCATEGORIES.map((item) => [item.id, 0]));
    const transactions = Array.isArray(state?.transactions)
      ? state.transactions.filter((transaction) =>
          isShoppingTransaction(transaction) && String(transaction.date || "").slice(0, 7) === month
        )
      : [];
    let totalShoppingAmount = 0;
    let taggedShoppingTransactionCount = 0;

    transactions.forEach((transaction) => {
      totalShoppingAmount += numericAmount(transaction.amount);
      const selected = getShoppingSubcategories(state, transaction.id);
      if (selected.length > 0) taggedShoppingTransactionCount += 1;
      selected.forEach((id) => { countBySubcategory[id] += 1; });
    });

    return {
      month,
      totalShoppingAmount,
      shoppingTransactionCount: transactions.length,
      taggedShoppingTransactionCount,
      untaggedShoppingTransactionCount: transactions.length - taggedShoppingTransactionCount,
      countBySubcategory,
      transactions,
    };
  }

  function getSubcategory(id) {
    return SUBCATEGORIES.find((item) => item.id === id) || null;
  }

  return {
    SHOPPING_CATEGORY_ID,
    MIXED_ID,
    SUBCATEGORIES,
    getSubcategory,
    isShoppingTransaction,
    normalizeShoppingSubcategories,
    getShoppingSubcategories,
    withShoppingSubcategories,
    calculateShoppingAnalytics,
  };
});
