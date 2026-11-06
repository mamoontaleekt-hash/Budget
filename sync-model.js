(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PFMSyncModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  // Firestore sorts map keys. Property insertion order is not a financial edit.
  const equal = (a, b) => equivalent(a, b);
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
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  const stable = value => JSON.stringify(canonical(value));
  const alternativeOrder = (x, y) => compare(x.stamp,y.stamp) || stable(x).localeCompare(stable(y),"en");
  function identicalAlternatives(conflict) {
    const items = conflict.alternatives || [];
    return items.length > 1 && items.every(item => !!item.deleted === !!items[0].deleted && equal(item.value,items[0].value));
  }
  function conflictSignature(conflict) {
    return stable([conflict.path,[...conflict.alternatives].sort(alternativeOrder)]);
  }
  function repairMetadata(meta) {
    const resolutions = new Map();
    for (const conflict of Object.values(meta.conflicts)) if (conflict.resolvedBy && conflict.resolvedVector) {
      const key = JSON.stringify(conflict.path), list = resolutions.get(key) || [];
      list.push(conflict); resolutions.set(key,list);
    }
    for (const conflict of Object.values(meta.conflicts)) {
      if (conflict.resolvedBy) continue;
      if (identicalAlternatives(conflict)) {
        // Keep the complete alternatives as recovery history; touch no ledger value.
        conflict.resolvedBy = {n:0,actor:"identical-values-v1"};
        conflict.resolution = "identical-values";
        continue;
      }
      const resolution = (resolutions.get(JSON.stringify(conflict.path)) || []).find(item =>
        conflict.alternatives.every(alt => alt.stamp.n === 0 || (item.resolvedVector[alt.stamp.actor] || 0) >= alt.stamp.n));
      if (resolution) {
        conflict.resolvedBy = clone(resolution.resolvedBy);
        conflict.resolvedVector = clone(resolution.resolvedVector);
      }
    }
    return meta;
  }
  function repairConflicts(data) {
    const out = clone(data);
    if (out?._sync?.version === 2) repairMetadata(out._sync);
    return out;
  }
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
    if (equivalent(leftData,rightData)) return repairConflicts(leftData);
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
      let useA = !bKnown || (aKnown && (order > 0 || (order === 0 && (!different || stable(av.get(key) ?? null) >= stable(bv.get(key) ?? null)))));
      const concurrent = (b.vector[as.actor] || 0) < as.n && (a.vector[bs.actor] || 0) < bs.n;
      const ambiguousLegacy = as.n === 0 && bs.n === 0;
      if (aKnown && bKnown && different && (concurrent || ambiguousLegacy || compare(as, bs) === 0)) {
        const alternatives = [
          { stamp: as, deleted: !av.has(key), ...(av.has(key) ? { value: av.get(key) } : {}) },
          { stamp: bs, deleted: !bv.has(key), ...(bv.has(key) ? { value: bv.get(key) } : {}) },
        ].sort(alternativeOrder);
        const id = conflictId(stable([key, alternatives]));
        if (!own(meta.conflicts, id)) meta.conflicts[id] = { path: JSON.parse(key), alternatives };
      }
      const source = useA ? av : bv, revision = useA ? as : bs;
      meta.revisions[key] = clone(revision);
      if (source.has(key) && !revision.deleted) values.set(key, source.get(key));
    }
    return rebuild(values, repairMetadata(meta));
  }
  function conflicts(data) {
    const seen = new Set();
    return Object.entries(data?._sync?.version === 2 ? data._sync.conflicts || {} : {}).filter(([, value]) => {
      if (value.resolvedBy || identicalAlternatives(value)) return false;
      const signature = conflictSignature(value);
      if (seen.has(signature)) return false;
      seen.add(signature); return true;
    });
  }
  function resolveChoices(data, choices, actor, preserveRecords = false) {
    const meta = repairMetadata(metadata(data)), values = flatten(data), selectedPaths = new Map();
    for (const [id, choice] of choices) {
      const conflict = meta.conflicts[id], selected = conflict?.alternatives?.[choice];
      if (!selected) throw new Error("Invalid conflict choice");
      const key = JSON.stringify(conflict.path);
      if (conflict.resolvedBy || selectedPaths.has(key)) continue;
      // Bulk adoption never deletes records, including soft deletions.
      if (preserveRecords && (selected.deleted || selected.value?.deletedAt)) continue;
      selectedPaths.set(key,selected);
    }
    if (!selectedPaths.size) return repairConflicts(data);
    // Include all observed alternative stamps, even in legacy malformed metadata.
    for (const conflict of Object.values(meta.conflicts)) for (const alt of conflict.alternatives || []) {
      meta.clock = Math.max(meta.clock,alt.stamp.n);
      meta.vector[alt.stamp.actor] = Math.max(meta.vector[alt.stamp.actor] || 0,alt.stamp.n);
    }
    const revision = next(meta,actor), observed = clone(meta.vector);
    for (const [key, selected] of selectedPaths) {
      if (selected.deleted) values.delete(key); else values.set(key,clone(selected.value));
      meta.revisions[key] = {...revision,...(selected.deleted ? {deleted:true} : {})};
    }
    for (const conflict of Object.values(meta.conflicts)) if (!conflict.resolvedBy && selectedPaths.has(JSON.stringify(conflict.path))) {
      conflict.resolvedBy = clone(revision);
      conflict.resolvedVector = clone(observed);
    }
    return rebuild(values,meta);
  }
  function resolveConflict(data, id, choice, actor) {
    return resolveChoices(data,[[id,choice]],actor);
  }
  function resolveAllFirst(data, actor) {
    return resolveChoices(data,conflicts(data).map(([id]) => [id,0]),actor,true);
  }
  return { valid, recordChanges, merge, conflicts, resolveConflict, resolveAllFirst, repairConflicts, equivalent };
});
