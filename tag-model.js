(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMTagModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTIVE = "active";
  const ARCHIVED = "archived";

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeTagName(name) {
    return typeof name === "string" ? name.trim() : "";
  }

  function comparisonName(name) {
    return normalizeTagName(name).toLocaleLowerCase("ar");
  }

  function isValidDefinition(definition, key) {
    return isRecord(definition)
      && typeof definition.id === "string"
      && definition.id.length > 0
      && (!key || definition.id === key)
      && normalizeTagName(definition.name).length > 0
      && (definition.status === ACTIVE || definition.status === ARCHIVED);
  }

  function definitionMap(state) {
    const definitions = state?.tagSettings?.definitions;
    return isRecord(definitions) ? definitions : null;
  }

  function transactionMap(state) {
    const mappings = state?.tagSettings?.transactionTags;
    return isRecord(mappings) ? mappings : null;
  }

  function getTagDefinitions(state) {
    const definitions = definitionMap(state);
    if (!definitions) return [];
    return Object.entries(definitions)
      .filter(([id, definition]) => isValidDefinition(definition, id))
      .map(([, definition]) => definition)
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }

  function getTag(state, tagId) {
    if (typeof tagId !== "string" || tagId.length === 0) return null;
    const definition = definitionMap(state)?.[tagId];
    return isValidDefinition(definition, tagId) ? definition : null;
  }

  function getActiveTags(state) {
    return getTagDefinitions(state).filter((definition) => definition.status === ACTIVE);
  }

  function validateTagName(state, name, excludedTagId) {
    const normalizedName = normalizeTagName(name);
    if (!normalizedName) return { valid: false, name: "", error: "empty" };
    const comparable = comparisonName(normalizedName);
    const collision = getActiveTags(state).find((definition) =>
      definition.id !== excludedTagId && comparisonName(definition.name) === comparable
    );
    return collision
      ? { valid: false, name: normalizedName, error: "duplicate", collision }
      : { valid: true, name: normalizedName, error: null };
  }

  function generatedTagId() {
    const uuid = typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    return `tag_${uuid}`;
  }

  function settingsWith(state, definitions, transactionTags) {
    const currentSettings = isRecord(state?.tagSettings) ? state.tagSettings : {};
    const nextSettings = { ...currentSettings };
    if (definitions && Object.keys(definitions).length > 0) nextSettings.definitions = definitions;
    else delete nextSettings.definitions;
    if (transactionTags && Object.keys(transactionTags).length > 0) nextSettings.transactionTags = transactionTags;
    else delete nextSettings.transactionTags;
    const nextState = { ...state };
    if (Object.keys(nextSettings).length > 0) nextState.tagSettings = nextSettings;
    else delete nextState.tagSettings;
    return nextState;
  }

  function withTagDefinition(state, definition) {
    if (!isRecord(state) || !isValidDefinition(definition)) return state;
    const validation = validateTagName(state, definition.name, definition.id);
    if (!validation.valid) return state;
    const definitions = { ...(definitionMap(state) || {}) };
    definitions[definition.id] = { ...definition, name: validation.name };
    return settingsWith(state, definitions, { ...(transactionMap(state) || {}) });
  }

  function createTag(state, name, options) {
    if (!isRecord(state)) return { state, tag: null, error: "invalid-state" };
    const validation = validateTagName(state, name);
    if (!validation.valid) return { state, tag: null, error: validation.error };
    const opts = isRecord(options) ? options : {};
    let id = typeof opts.id === "string" && opts.id.length > 0 ? opts.id : generatedTagId();
    while (getTag(state, id)) id = generatedTagId();
    const tag = {
      id,
      name: validation.name,
      status: ACTIVE,
      createdAt: typeof opts.createdAt === "string" ? opts.createdAt : new Date().toISOString(),
    };
    return { state: withTagDefinition(state, tag), tag, error: null };
  }

  function renameTag(state, tagId, name) {
    const current = getTag(state, tagId);
    if (!current) return { state, tag: null, error: "missing" };
    const validation = validateTagName(state, name, tagId);
    if (!validation.valid) return { state, tag: current, error: validation.error };
    const tag = { ...current, name: validation.name };
    return { state: withTagDefinition(state, tag), tag, error: null };
  }

  function withStatus(state, tagId, status) {
    const current = getTag(state, tagId);
    if (!current || (status !== ACTIVE && status !== ARCHIVED)) return state;
    if (status === ACTIVE) {
      const validation = validateTagName(state, current.name, tagId);
      if (!validation.valid) return state;
    }
    return withTagDefinition(state, { ...current, status });
  }

  function archiveTag(state, tagId) {
    return withStatus(state, tagId, ARCHIVED);
  }

  function restoreTag(state, tagId) {
    return withStatus(state, tagId, ACTIVE);
  }

  function normalizeTagIds(state, tagIds, options) {
    if (!Array.isArray(tagIds)) return [];
    const activeOnly = !!options?.activeOnly;
    const normalized = [];
    tagIds.forEach((tagId) => {
      const definition = getTag(state, tagId);
      if (!definition || (activeOnly && definition.status !== ACTIVE) || normalized.includes(tagId)) return;
      normalized.push(tagId);
    });
    return normalized;
  }

  function getTransactionTags(state, transactionId) {
    if (typeof transactionId !== "string" || transactionId.length === 0) return [];
    return normalizeTagIds(state, transactionMap(state)?.[transactionId]);
  }

  function withTransactionTags(state, transactionId, tagIds) {
    if (!isRecord(state) || typeof transactionId !== "string" || transactionId.length === 0) return state;
    const previous = new Set(getTransactionTags(state, transactionId));
    const normalized = normalizeTagIds(state, tagIds).filter((tagId) => {
      const definition = getTag(state, tagId);
      return definition?.status === ACTIVE || previous.has(tagId);
    });
    const mappings = { ...(transactionMap(state) || {}) };
    if (normalized.length > 0) mappings[transactionId] = normalized;
    else delete mappings[transactionId];
    return settingsWith(state, { ...(definitionMap(state) || {}) }, mappings);
  }

  function calculateTagAnalytics(state, month) {
    const definitions = getTagDefinitions(state);
    const countByTag = Object.fromEntries(definitions.map((definition) => [definition.id, 0]));
    const transactions = Array.isArray(state?.transactions)
      ? state.transactions.filter((transaction) =>
          !transaction?.deletedAt && String(transaction?.date || "").slice(0, 7) === month
        )
      : [];
    let taggedTransactionCount = 0;
    transactions.forEach((transaction) => {
      const ids = getTransactionTags(state, transaction?.id);
      if (ids.length > 0) taggedTransactionCount += 1;
      ids.forEach((tagId) => { countByTag[tagId] += 1; });
    });
    return {
      month,
      transactionCount: transactions.length,
      taggedTransactionCount,
      untaggedTransactionCount: transactions.length - taggedTransactionCount,
      countByTag,
      transactions,
    };
  }

  return {
    ACTIVE,
    ARCHIVED,
    normalizeTagName,
    validateTagName,
    getTagDefinitions,
    getTag,
    getActiveTags,
    normalizeTagIds,
    getTransactionTags,
    withTransactionTags,
    withTagDefinition,
    createTag,
    renameTag,
    archiveTag,
    restoreTag,
    calculateTagAnalytics,
  };
});
