// Regression test for the "floor at schedule start" fix in scheduleEngine.js —
// a STALE/early pinned_start_date must not drag an item (and its Depends-on chain)
// in front of the schedule's start date; a legit FORWARD pin still holds.
// Reproduces the real Samuel-Deck (job 224) bug: Demolition Stucco pinned 2026-08-31
// while the schedule starts 2026-09-17, Color Stucco legitimately pinned 2026-09-28.
// Run: node test/scheduleAnchorFloor.test.js   (exit 0 = pass)
'use strict';
const engine = require('../services/scheduleEngine');

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? pass++ : fail++; if (!c) console.log('  ✗ FAIL: ' + m + (x ? '  ' + x : '')); };

const START = '2026-09-17';
const items = [
  { id: 213, name: 'Demolition Stucco', duration_days: 2, pinned_start_date: '2026-08-31' }, // STALE early pin
  { id: 214, name: 'Demo Framing & plywood', duration_days: 3 },                              // depends on 213
  { id: 216, name: 'Color Stucco', duration_days: 1, pinned_start_date: '2026-09-28' },       // legit forward pin
];
const deps = [{ item_id: 214, depends_on_item_id: 213 }];

const r = engine.computeSchedule({ items, deps, startDate: START, skipSaturday: true, skipSunday: true });
const S = (id) => r.results[id] && r.results[id].start;
const E = (id) => r.results[id] && r.results[id].end;

// 1) The stale early pin is clamped UP to the schedule start (was 2026-08-31).
ok(S(213) === '2026-09-17', 'Demolition Stucco starts on the schedule start date (clamped from 08-31)', 'got ' + S(213));

// 2) Its dependent chains FORWARD off the corrected start — not off 08-31.
//    Demolition Stucco: 09-17 (Thu) + 2d → end 09-18 (Fri). Demo Framing = next working day = Mon 09-21.
ok(E(213) === '2026-09-18', 'Demolition Stucco end 09-18', 'got ' + E(213));
ok(S(214) === '2026-09-21', 'Demo Framing chains to Mon 09-21 (skips the weekend), not off 08-31', 'got ' + S(214));

// 3) A pin that is ON/AFTER the start date is UNTOUCHED (forward pins still hold).
ok(S(216) === '2026-09-28', 'Color Stucco keeps its legit forward pin (09-28)', 'got ' + S(216));

// 4) Global invariant: NOTHING starts before the schedule start date.
const early = Object.entries(r.results).filter(([, v]) => v.start < START);
ok(early.length === 0, 'no item starts before the schedule start date', JSON.stringify(early));

// 5) Sanity: no cycle, results present for all.
ok(r.ok !== false, 'schedule computed (no cycle)');
ok(Object.keys(r.results).length === 3, 'all items computed');

// ---- pin also floors after DEPENDENCIES (real Color Stucco / Railings case) ----
// Color Stucco pinned 09-28 but its scratch-coat dependency now ends 09-29 → it must
// FLOOR to 09-30 (no bust), and dragging the last item LATER must be accepted.
{
  const it2 = [
    { id: 1, name: 'Stucco lath', duration_days: 2 },                                  // start 09-28 → end 09-29
    { id: 2, name: 'Color Stucco', duration_days: 1, pinned_start_date: '2026-09-28' }, // pinned before its dep finishes
    { id: 3, name: 'Railings', duration_days: 1 },                                       // depends on both
  ];
  const dp2 = [
    { item_id: 2, depends_on_item_id: 1 },
    { item_id: 3, depends_on_item_id: 1 }, { item_id: 3, depends_on_item_id: 2 },
  ];
  const r2 = engine.computeSchedule({ items: it2, deps: dp2, startDate: '2026-09-28', skipSaturday: true, skipSunday: true });
  ok(r2.conflicts.length === 0, 'no bust: Color Stucco pin earlier than its dependency floors instead of blocking', JSON.stringify(r2.conflicts));
  ok(r2.results[2].start === '2026-09-30', 'Color Stucco floors to 09-30 (working day after Stucco lath ends 09-29)', 'got ' + r2.results[2].start);

  // Drag Railings (the last item) to a far LATER date — must be accepted, no conflict.
  it2[2].pinned_start_date = '2026-10-15';
  const r3 = engine.computeSchedule({ items: it2, deps: dp2, startDate: '2026-09-28', skipSaturday: true, skipSunday: true });
  ok(r3.conflicts.length === 0, 'dragging the last item LATER is accepted (a later move can never bust)', JSON.stringify(r3.conflicts));
  ok(r3.results[3].start === '2026-10-15', 'Railings honors its later pin (10-15)', 'got ' + r3.results[3].start);
}

console.log(`\nScheduleEngine anchor-floor test\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
