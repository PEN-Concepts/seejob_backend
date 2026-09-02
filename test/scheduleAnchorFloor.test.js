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

console.log(`\nScheduleEngine anchor-floor test\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
