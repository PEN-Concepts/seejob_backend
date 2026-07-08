// Unit test for services/scheduleEngine.js — pure scheduling math, NO database.
// Validates the forward pass against the real "Standard New Home Build" graph plus
// cycle & bust detection, using invariants (not brittle absolute dates).
// Run: node test/scheduleEngine.test.js   (exit 0 = pass, 1 = fail)

'use strict';
const engine = require('../services/scheduleEngine');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL: ' + msg); } }

// the 42-item seed graph (ids = display numbers here for readability)
const SEED = [
  [1, []], [2, [1]], [3, [2]], [4, [3]], [5, [4]], [6, [4]], [7, [4, 5, 6]],
  [8, [7]], [9, [7]], [10, [7]], [11, [9]], [12, [10]], [13, [12]], [14, [12]],
  [15, [14]], [16, [15]], [17, [14]], [18, [14]], [19, [14]], [20, [17, 18, 19]],
  [21, [20]], [22, [21]], [23, [22]], [24, [23]], [25, [24]], [26, [9, 20]],
  [27, [25]], [28, [25]], [29, [27]], [30, [28]], [31, [25]], [32, [29]],
  [33, [29]], [34, [33]], [35, [33]], [36, [35]], [37, [34]], [38, [37]],
  [39, [30, 31]], [40, [31]], [41, [28]], [42, 'ALL'],
];

function buildItems(durationFn) {
  return SEED.map(([id]) => ({
    id,
    name: 'Item ' + id,
    duration_days: durationFn ? durationFn(id) : 2,
    depends_on_all: SEED.find(([i]) => i === id)[1] === 'ALL',
  }));
}
function buildDeps() {
  const deps = [];
  for (const [id, d] of SEED) {
    if (d === 'ALL' || !Array.isArray(d)) continue;
    for (const dep of d) deps.push({ item_id: id, depends_on_item_id: dep });
  }
  return deps;
}

const items = buildItems((id) => (id % 3) + 1); // durations 1..3, varied
const deps = buildDeps();

console.log('Test: full 42-item seed graph forward pass (skipSunday=true)');
const comp = engine.computeSchedule({
  items, deps, startDate: '2026-07-08', skipSaturday: false, skipSunday: true,
});
ok(comp.ok === true, 'compute ok (no cycle)');
ok(Object.keys(comp.results).length === 42, 'all 42 items have computed dates');
ok(comp.conflicts.length === 0, 'no conflicts on a clean forward pass');

function dow(ymd) { return engine.parseYMD(ymd).getDay(); } // 0=Sun 6=Sat
function workingDaysInclusive(start, end, skipSat, skipSun) {
  let d = engine.parseYMD(start); const e = engine.parseYMD(end); let n = 0;
  while (d <= e) {
    const w = d.getDay();
    if (!((w === 6 && skipSat) || (w === 0 && skipSun))) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

console.log('Test: dependency + weekend-skip + duration invariants');
let noSunday = true, durationOk = true, afterDeps = true;
for (const it of items) {
  const r = comp.results[it.id];
  if (dow(r.start) === 0 || dow(r.end) === 0) noSunday = false;
  if (workingDaysInclusive(r.start, r.end, false, true) !== r.duration) durationOk = false;
}
for (const e of deps) {
  const item = comp.results[e.item_id];
  const dep = comp.results[e.depends_on_item_id];
  if (!(item.start > dep.end)) afterDeps = false;
}
ok(noSunday, 'no computed start/end falls on a Sunday when skipSunday=true');
ok(durationOk, 'each item spans exactly its duration in working days');
ok(afterDeps, 'every item starts strictly after all its dependencies end');

const latest456 = [4, 5, 6].map((i) => comp.results[i].end).sort().pop();
const expected7 = engine.addWorkingDays(latest456, 1, false, true);
ok(comp.results[7].start === expected7,
  `item 7 starts the working day after latest of 4/5/6 (got ${comp.results[7].start}, expected ${expected7})`);

let maxOtherEnd = null;
for (const it of items) if (it.id !== 42) { const e = comp.results[it.id].end; if (!maxOtherEnd || e > maxOtherEnd) maxOtherEnd = e; }
ok(comp.results[42].start > maxOtherEnd, 'item 42 (Requires ALL) starts after every other item ends');

console.log('Test: addWorkingDays weekend handling');
ok(dow('2026-07-10') === 5, 'sanity: 2026-07-10 is Friday');
ok(engine.addWorkingDays('2026-07-10', 1, true, true) === '2026-07-13', 'Fri +1 wd (skip both) = Mon');
ok(engine.addWorkingDays('2026-07-10', 1, false, false) === '2026-07-11', 'Fri +1 day (skip none) = Sat');
ok(engine.fmtYMD(engine.snapForward(engine.parseYMD('2026-07-11'), true, true)) === '2026-07-13', 'Sat snaps forward to Mon');
ok(engine.addWorkingDays('2026-07-13', 0, true, true) === '2026-07-13', 'Mon +0 wd = Mon (1-day item)');

console.log('Test: skip-none behaves as plain calendar');
const plain = engine.computeSchedule({ items: [{ id: 1, duration_days: 5 }], deps: [], startDate: '2026-07-08', skipSaturday: false, skipSunday: false });
ok(plain.results[1].end === '2026-07-12', '5-day task from 07-08 (skip none) ends 07-12 (calendar)');

console.log('Test: dependency cycle rejected');
const cyItems = [{ id: 1 }, { id: 2 }, { id: 3 }].map((x) => ({ ...x, duration_days: 1 }));
const cyDeps = [
  { item_id: 2, depends_on_item_id: 1 },
  { item_id: 3, depends_on_item_id: 2 },
  { item_id: 1, depends_on_item_id: 3 },
];
const cyc = engine.detectCycle(cyItems, cyDeps);
ok(cyc.length > 0, 'detectCycle flags the cyclic items (got [' + cyc.join(',') + '])');
const cycComp = engine.computeSchedule({ items: cyItems, deps: cyDeps, startDate: '2026-07-08' });
ok(cycComp.ok === false && (cycComp.cycle || []).length > 0, 'computeSchedule returns ok=false + cycle, no dates');
ok(engine.detectCycle(cyItems, cyDeps.slice(0, 2)).length === 0, 'acyclic graph → no cycle');

console.log('Test: bust detection on a pinned date that violates a dependency');
const bItems = [
  { id: 1, name: 'Foundation', duration_days: 5 },
  { id: 2, name: 'Framing', duration_days: 3, pinned_start_date: '2026-07-09' },
];
const bDeps = [{ item_id: 2, depends_on_item_id: 1 }];
const bComp = engine.computeSchedule({ items: bItems, deps: bDeps, startDate: '2026-07-08', skipSaturday: false, skipSunday: true });
ok(bComp.ok === true, 'bust case still computes (flag-and-keep, not rejected)');
ok(bComp.results[2].start === '2026-07-09', 'pinned start is honored as-is (not auto-corrected)');
ok(bComp.conflicts.some((c) => c.itemId === 2), 'item 2 flagged as a conflict');
ok(/depends on/.test((bComp.conflicts.find((c) => c.itemId === 2) || {}).reason || ''), 'conflict has a human-readable reason');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
