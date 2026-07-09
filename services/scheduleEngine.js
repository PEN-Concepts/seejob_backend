// scheduleEngine.js — pure scheduling math, NO database access.
//
// Given a set of items (each with a stable id, a duration in days, and an optional
// pinned start date) plus item-to-item dependency edges, compute each item's start
// and end date via a forward pass, skipping the chosen weekend days.
//
// - Dependencies are keyed by STABLE item id (never a display number).
// - An item flagged depends_on_all is treated as depending on EVERY other item, so
//   it always lands last (used for "Inspection Final — Requires ALL").
// - Topological order via Kahn's algorithm; any residual nodes = a dependency cycle
//   (direct or transitive) → we return the offending ids and DO NOT compute dates.
// - An item with a pinned_start_date uses that as its start (an explicit user
//   override, e.g. a calendar drag) but STILL cascades forward to its dependents.
// - Bust detection: after computing, every dependency edge must satisfy
//   item.start >= dependency.end + 1 working day; violations set has_conflict + a
//   human-readable reason. We flag, never auto-correct.

'use strict';

// ---- date helpers (operate on 'YYYY-MM-DD' strings, local calendar) ----

function parseYMD(input) {
  if (!input) return null;
  if (input instanceof Date) {
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  const s = String(input);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // tolerate 'YYYY-MM-DD HH:MM:SS'
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtYMD(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isSkipped(date, skipSaturday, skipSunday) {
  const dow = date.getDay(); // 0 = Sun, 6 = Sat
  return (dow === 6 && skipSaturday) || (dow === 0 && skipSunday);
}

// First working day on or after `date` (snaps a weekend start forward).
function snapForward(date, skipSaturday, skipSunday) {
  const d = new Date(date);
  while (isSkipped(d, skipSaturday, skipSunday)) d.setDate(d.getDate() + 1);
  return d;
}

// Add `n` working days to a start date. n = 0 returns the start (snapped to a
// working day). Used both for item end (start + duration-1) and for the "+1
// working day after a dependency ends" rule.
function addWorkingDays(startInput, n, skipSaturday, skipSunday) {
  let d = parseYMD(startInput);
  if (!d) return null;
  d = snapForward(d, skipSaturday, skipSunday);
  let remaining = Math.max(0, Math.trunc(n));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!isSkipped(d, skipSaturday, skipSunday)) remaining -= 1;
  }
  return fmtYMD(d);
}

function normalizeDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

// ---- graph helpers ----

// Build a predecessor map: itemId -> Set(dependency ids). depends_on_all items
// gain a synthesized edge to every other item.
function buildPredecessors(items, deps) {
  const ids = items.map((it) => it.id);
  const idSet = new Set(ids);
  const preds = new Map(ids.map((id) => [id, new Set()]));

  for (const e of deps || []) {
    const from = e.item_id;
    const to = e.depends_on_item_id;
    if (!idSet.has(from) || !idSet.has(to) || from === to) continue;
    preds.get(from).add(to);
  }
  for (const it of items) {
    if (it.depends_on_all) {
      for (const other of ids) {
        if (other !== it.id) preds.get(it.id).add(other);
      }
    }
  }
  return preds;
}

// Kahn's topological sort. Returns { order: [ids] } on success, or
// { order, cycle: [residual ids] } when a cycle prevents a full ordering.
function topoSort(items, preds) {
  const ids = items.map((it) => it.id);
  const inDegree = new Map(ids.map((id) => [id, preds.get(id).size]));
  // successors: dep -> [items depending on it]
  const successors = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of preds.get(id)) successors.get(dep).push(id);
  }
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const succ of successors.get(id)) {
      inDegree.set(succ, inDegree.get(succ) - 1);
      if (inDegree.get(succ) === 0) queue.push(succ);
    }
  }
  if (order.length < ids.length) {
    const cycle = ids.filter((id) => !order.includes(id));
    return { order, cycle };
  }
  return { order };
}

// Detect a cycle without computing dates. Returns [] when acyclic, else the
// residual (offending) item ids. Used by dependency-edit endpoints to reject a
// change before saving.
function detectCycle(items, deps) {
  const preds = buildPredecessors(items, deps);
  const { cycle } = topoSort(items, preds);
  return cycle || [];
}

/**
 * Forward-pass schedule.
 * @param {Object} args
 * @param {Array}  args.items  [{ id, name?, duration_days, depends_on_all?, pinned_start_date? }]
 * @param {Array}  args.deps   [{ item_id, depends_on_item_id }]
 * @param {string} args.startDate 'YYYY-MM-DD' schedule anchor (items with no deps start here)
 * @param {boolean} args.skipSaturday
 * @param {boolean} args.skipSunday
 * @returns {Object} { ok, cycle?, results: {id -> {start,end,duration}}, conflicts: [{itemId,reason}] }
 */
function computeSchedule({ items, deps, startDate, skipSaturday, skipSunday }) {
  items = items || [];
  const skipSat = !!skipSaturday;
  const skipSun = !!skipSunday;
  const anchor = snapForward(parseYMD(startDate) || new Date(), skipSat, skipSun);
  const anchorStr = fmtYMD(anchor);

  const preds = buildPredecessors(items, deps);
  const { order, cycle } = topoSort(items, preds);
  if (cycle && cycle.length) {
    return { ok: false, cycle, results: {}, conflicts: [] };
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const results = {}; // id -> { start, end, duration }

  for (const id of order) {
    const it = byId.get(id);
    const duration = normalizeDuration(it.duration_days);
    const depIds = Array.from(preds.get(id));

    let start;
    if (it.pinned_start_date) {
      // Explicit user override (e.g. calendar drag) — honored as-is, not snapped.
      start = fmtYMD(parseYMD(it.pinned_start_date));
    } else if (!depIds.length) {
      start = anchorStr;
    } else {
      // Start the working day AFTER the LATEST-finishing dependency.
      let latestEnd = null;
      for (const d of depIds) {
        const de = results[d] && results[d].end;
        if (de && (latestEnd === null || de > latestEnd)) latestEnd = de;
      }
      start = latestEnd
        ? addWorkingDays(latestEnd, 1, skipSat, skipSun)
        : anchorStr;
    }

    const end = addWorkingDays(start, duration - 1, skipSat, skipSun);
    results[id] = { start, end, duration };
  }

  // ---- bust detection: item.start must be >= dependency.end + 1 working day ----
  const conflicts = [];
  for (const id of order) {
    const it = byId.get(id);
    const r = results[id];
    if (!r) continue;
    let worst = null; // the violated dependency that ends latest
    for (const depId of preds.get(id)) {
      const dep = results[depId];
      if (!dep) continue;
      const earliestLegal = addWorkingDays(dep.end, 1, skipSat, skipSun);
      if (r.start < earliestLegal) {
        if (!worst || dep.end > worst.end) {
          worst = { id: depId, end: dep.end, name: (byId.get(depId) || {}).name };
        }
      }
    }
    if (worst) {
      const itemName = (it && it.name) || `item #${id}`;
      const depName = worst.name || `item #${worst.id}`;
      const reason =
        `${itemName} can't start ${fmtHuman(r.start)} — it depends on "${depName}", ` +
        `which doesn't finish until ${fmtHuman(worst.end)}.`;
      conflicts.push({
        itemId: id,
        itemName,
        dependencyId: worst.id,
        dependencyName: depName,
        dependencyEnd: worst.end,
        attemptedStart: r.start,
        reason,
      });
    }
  }

  return { ok: true, results, conflicts };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'YYYY-MM-DD' -> 'Jul 8, 2026' for human-readable rejection messages.
function fmtHuman(ymd) {
  const d = parseYMD(ymd);
  if (!d) return String(ymd || '');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

module.exports = {
  computeSchedule,
  detectCycle,
  addWorkingDays,
  snapForward,
  parseYMD,
  fmtYMD,
  normalizeDuration,
};
