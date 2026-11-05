(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMSyncModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const safe = key => !["__proto__", "prototype", "constructor"].includes(key);
  function equivalent(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) if (!own(b,key) || !equivalent(a[key],b[key])) return false;
    return true;
  }
  const entities = new Set(["transactions", "categories"]);
  function conflictId(value) {
    // Bounded Firestore map keys, including when transaction notes are long.
    const hashes = [2166136261, 2246822507, 3266489909, 668265263];
    for (let i = 0; i < value.length; i++) for (let j = 0; j < hashes.length; j++) hashes[j] = Math.imul(hashes[j] ^ value.charCodeAt(i), 16777619 + j * 2) >>> 0;
    return hashes.map(hash => hash.toString(16).padStart(8,"0")).join("");
  }
  function valid(data) {
    return !!data && Array.isArray(data.categories) && Array.isArray(data.transactions)
      && !!data.budgets && typeof data.budgets === "object" && !Array.isArray(data.budgets);
  }
  function flatten(data) {
    const result = new Map();
    function visit(value, path) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of Object.keys(value).sort()) if (safe(key)) visit(value[key], [...path, key]);
      } else result.set(JSON.stringify(path), clone(value));
    }
    for (const key of Object.keys(data || {}).sort()) {
      if (!safe(key) || key === "_sync") continue;
      if (entities.has(key)) {
        for (const item of data[key] || []) if (item && typeof item.id === "string" && safe(item.id)) {
          result.set(JSON.stringify([key, item.id]), clone(item));
        }
      } else if (key === "plannedPurchases") {
        for (const [id, item] of Object.entries(data[key] || {})) if (safe(id)) result.set(JSON.stringify([key, id]), clone(item));
      } else visit(data[key], [key]);
    }
    return result;
  }
  function metadata(data) {
    const source = data?._sync;
    if (source?.version !== 2) return { version: 2, clock: 0, vector: {}, revisions: {}, conflicts: {} };
    return { version: 2, clock: Number(source.clock) || 0, vector: clone(source.vector || {}), revisions: clone(source.revisions || {}), conflicts: clone(source.conflicts || {}) };
  }
  function next(meta, actor) {
    meta.clock += 1;
    meta.vector[actor] = meta.clock;
    return { n: meta.clock, actor };
  }
  function stamp(meta, key) { return meta.revisions[key] || { n: 0, actor: "legacy" }; }
  function compare(a, b) { return a.n - b.n || a.actor.localeCompare(b.actor, "en"); }
  function recordChanges(before, after, actor) {
    const out = clone(after), meta = metadata(after), previous = metadata(before);
    meta.clock = Math.max(meta.clock, previous.clock);
    for (const [key, n] of Object.entries(previous.vector)) meta.vector[key] = Math.max(meta.vector[key] || 0, n);
    // A caller may build a replacement state without copying metadata (e.g. import).
    meta.revisions = { ...previous.revisions, ...meta.revisions };
    meta.conflicts = { ...previous.conflicts, ...meta.conflicts };
    const left = flatten(before), right = flatten(after);
    const changed = [...new Set([...left.keys(), ...right.keys()])].filter(key => !equal(left.get(key), right.get(key)) || left.has(key) !== right.has(key));
    if (changed.length) {
      const revision = next(meta, actor);
      for (const key of changed) meta.revisions[key] = { ...revision, ...(right.has(key) ? {} : { deleted: true }) };
    }
    out._sync = meta;
    return out;
  }
  function rebuild(values, meta) {
    const out = { version: 1, categories: [], transactions: [], budgets: {} };
    for (const [encoded, value] of values) {
      const path = JSON.parse(encoded);
      if (!path.length || !path.every(safe)) continue;
      if (entities.has(path[0])) { out[path[0]].push(clone(value)); continue; }
      let target = out;
      for (const key of path.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
        target = target[key];
      }
      target[path.at(-1)] = clone(value);
    }
    out._sync = meta;
    return out;
  }
  function merge(leftData, rightData) {
    if (!valid(leftData) || !valid(rightData)) throw new Error("Invalid sync state");
    if (equivalent(leftData,rightData)) return clone(leftData);
    const a = metadata(leftData), b = metadata(rightData), meta = metadata(null);
    meta.clock = Math.max(a.clock, b.clock);
    for (const actor of new Set([...Object.keys(a.vector), ...Object.keys(b.vector)])) meta.vector[actor] = Math.max(a.vector[actor] || 0, b.vector[actor] || 0);
    for (const source of [a.conflicts, b.conflicts]) for (const [key, conflict] of Object.entries(source)) {
      if (!safe(key)) continue;
      const current = meta.conflicts[key];
      if (!current || compare(conflict.resolvedBy || {n:0,actor:""}, current.resolvedBy || {n:0,actor:""}) > 0) meta.conflicts[key] = clone(conflict);
    }
    const av = flatten(leftData), bv = flatten(rightData), values = new Map();
    const keys = [...new Set([...av.keys(), ...bv.keys(), ...Object.keys(a.revisions), ...Object.keys(b.revisions)])].sort();
    for (const key of keys) {
      const as = stamp(a, key), bs = stamp(b, key);
      const aKnown = av.has(key) || own(a.revisions, key), bKnown = bv.has(key) || own(b.revisions, key);
      const different = av.has(key) !== bv.has(key) || !equal(av.get(key), bv.get(key));
      const order = compare(as,bs);
      let useA = !bKnown || (aKnown && (order > 0 || (order === 0 && (!different || JSON.stringify(av.get(key) ?? null) >= JSON.stringify(bv.get(key) ?? null)))));
      const concurrent = (b.vector[as.actor] || 0) < as.n && (a.vector[bs.actor] || 0) < bs.n;
      const ambiguousLegacy = as.n === 0 && bs.n === 0;
      if (aKnown && bKnown && different && (concurrent || ambiguousLegacy || compare(as, bs) === 0)) {
        const alternatives = [
          { stamp: as, deleted: !av.has(key), ...(av.has(key) ? { value: av.get(key) } : {}) },
          { stamp: bs, deleted: !bv.has(key), ...(bv.has(key) ? { value: bv.get(key) } : {}) },
        ].sort((x, y) => compare(x.stamp, y.stamp) || JSON.stringify(x).localeCompare(JSON.stringify(y), "en"));
        const id = conflictId(JSON.stringify([key, alternatives]));
        if (!own(meta.conflicts, id)) meta.conflicts[id] = { path: JSON.parse(key), alternatives };
      }
      const source = useA ? av : bv, revision = useA ? as : bs;
      meta.revisions[key] = clone(revision);
      if (source.has(key) && !revision.deleted) values.set(key, source.get(key));
    }
    return rebuild(values, meta);
  }
  function conflicts(data) { return Object.entries(data?._sync?.version === 2 ? data._sync.conflicts || {} : {}).filter(([, value]) => !value.resolvedBy); }
  function resolveConflict(data, id, choice, actor) {
    const meta = metadata(data), conflict = meta.conflicts[id], selected = conflict?.alternatives?.[choice];
    if (!selected) throw new Error("Invalid conflict choice");
    const values = flatten(data), key = JSON.stringify(conflict.path), revision = next(meta, actor);
    if (selected.deleted) values.delete(key); else values.set(key, clone(selected.value));
    meta.revisions[key] = { ...revision, ...(selected.deleted ? { deleted: true } : {}) };
    meta.conflicts[id].resolvedBy = revision;
    return rebuild(values, meta);
  }
  return { valid, recordChanges, merge, conflicts, resolveConflict, equivalent };
});
