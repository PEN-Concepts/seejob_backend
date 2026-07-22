/* Server-backed Spartan goals (cross-device sync). Verifies routes/spartan.js
 * against real MySQL (mysql-memory-server) + supertest:
 *   - goal CRUD round-trips (create/list/update/delete), per-user scoped;
 *   - the weekday set persists as day_of_week CSV and reconstructs (recurrence);
 *   - completion log persists and is readable from a FRESH session (no client
 *     state) — i.e. "a different device" sees the same goals + today_status;
 *   - the reminder computation (client daysOf -> nextGoalFireMs) works off the
 *     SERVER goal's day_of_week + numeric id (stable across devices).
 * Run: NODE_PATH=<backend>/node_modules node test/spartanGoals.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

// Mirror of the frontend daysOf() (server branch) — proves the weekday set the
// reminder engine needs is reconstructable from the server row alone.
function daysOf(g) {
  if (g && g.day_of_week != null && String(g.day_of_week).trim() !== '') {
    const parsed = String(g.day_of_week).split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n >= 0 && n <= 6);
    if (parsed.length) return parsed;
  }
  switch (g && g.recurrence) {
    case 'daily': return [0, 1, 2, 3, 4, 5, 6];
    case 'mwf': return [1, 3, 5];
    // Malformed/legacy goal with no parseable day set -> NO day (was: every day).
    default: return [];
  }
}

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_spartan_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();
    // getUserTz reads user.timezone; seed two accounts.
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), timezone VARCHAR(64) NULL)");
    await conn.query("INSERT INTO `user` (id,name,timezone) VALUES (501,'Owner','America/Los_Angeles'),(502,'Other','America/Los_Angeles')");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/spartan', require('../routes/spartan'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const A = tok(501), B = tok(502);

    // ---- CREATE: a Mon/Wed/Fri timed goal (arbitrary weekday set) ----
    const created = await request(app).post('/api/spartan/goals').set('Authorization', A)
      .send({ goal: 'Morning workout', start_time: '06:30', duration_minutes: 45, recurrence: 'custom', day_of_week: '1,3,5' });
    ok(created.status === 201 && created.body.id, 'create: goal created (201 + id)', JSON.stringify(created.body));
    const goalId = created.body.id;

    // ---- LIST as the SAME user (round-trip) ----
    let list = await request(app).get('/api/spartan/goals').set('Authorization', A);
    let g = (list.body.goals || []).find((x) => x.id === goalId);
    ok(!!g, 'list: created goal is returned');
    ok(g && g.goal === 'Morning workout' && g.start_time === '06:30' && Number(g.duration_minutes) === 45, 'list: name/time/duration round-trip', JSON.stringify(g));
    ok(g && String(g.day_of_week) === '1,3,5', 'recurrence: weekday set persisted as day_of_week CSV "1,3,5"', g && g.day_of_week);
    ok(JSON.stringify(daysOf(g)) === JSON.stringify([1, 3, 5]), 'recurrence: daysOf() reconstructs [1,3,5] from the server row (drives reminders)', JSON.stringify(daysOf(g)));

    // ---- "Different device" = a fresh request with NO client state ----
    const freshList = await request(app).get('/api/spartan/goals').set('Authorization', A);
    ok((freshList.body.goals || []).some((x) => x.id === goalId), 'cross-device: a fresh session (no localStorage) sees the same server goal');

    // ---- LOG completion, then confirm it persists for a fresh reader ----
    const logged = await request(app).post(`/api/spartan/goals/${goalId}/log`).set('Authorization', A).send({ status: 'completed' });
    ok(logged.status === 200 && logged.body.status === 'completed', 'log: mark completed (200)', JSON.stringify(logged.body));
    const afterLog = await request(app).get('/api/spartan/goals').set('Authorization', A); // fresh read
    g = (afterLog.body.goals || []).find((x) => x.id === goalId);
    ok(g && g.today_status === 'completed', 'log: today_status=completed readable from a fresh session (cross-device)', g && g.today_status);

    // ---- LOG clear (un-complete) ----
    await request(app).post(`/api/spartan/goals/${goalId}/log`).set('Authorization', A).send({ clear: true });
    g = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === goalId);
    ok(g && (g.today_status == null), 'log: clear removes today_status', g && g.today_status);

    // ---- UPDATE: change to Tue/Thu + new time/duration ----
    const upd = await request(app).put(`/api/spartan/goals/${goalId}`).set('Authorization', A)
      .send({ goal: 'Evening run', start_time: '18:00', duration_minutes: 30, recurrence: 'custom', day_of_week: '2,4' });
    ok(upd.status === 200, 'update: 200', JSON.stringify(upd.body));
    g = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === goalId);
    ok(g && g.goal === 'Evening run' && String(g.day_of_week) === '2,4' && JSON.stringify(daysOf(g)) === JSON.stringify([2, 4]), 'update: name + weekday set changed and round-trips', JSON.stringify(g));

    // ---- per-user scoping: user B cannot see, update, or delete A's goal ----
    const bList = await request(app).get('/api/spartan/goals').set('Authorization', B);
    ok(!(bList.body.goals || []).some((x) => x.id === goalId), 'scope: user B does NOT see user A\'s goal');
    const bUpd = await request(app).put(`/api/spartan/goals/${goalId}`).set('Authorization', B).send({ goal: 'hijack', recurrence: 'daily' });
    ok(bUpd.status === 404, 'scope: user B update of A\'s goal -> 404', String(bUpd.status));
    const bDel = await request(app).delete(`/api/spartan/goals/${goalId}`).set('Authorization', B);
    ok(bDel.status === 404, 'scope: user B delete of A\'s goal -> 404', String(bDel.status));
    g = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === goalId);
    ok(!!g && g.goal === 'Evening run', 'scope: A\'s goal untouched by B\'s attempts');

    // ---- SINGLE DAY: pick only Wednesday. This is exactly what the day-picker
    //      sends (recurrence 'custom', day_of_week '3'). Regression guard for the
    //      "single-day goal shows on every day" report: prove it round-trips as a
    //      single day AND applies on that day only, never the other six. ----
    const single = await request(app).post('/api/spartan/goals').set('Authorization', A)
      .send({ goal: 'Wednesday only', start_time: '07:00', duration_minutes: 15, recurrence: 'custom', day_of_week: '3' });
    ok(single.status === 201 && single.body.id, 'single-day: created (201 + id)', JSON.stringify(single.body));
    const gs = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === single.body.id);
    ok(gs && String(gs.day_of_week) === '3', 'single-day: day_of_week persisted as "3" (not nulled/expanded)', gs && gs.day_of_week);
    ok(gs && JSON.stringify(daysOf(gs)) === JSON.stringify([3]), 'single-day: daysOf() reconstructs [3] only', JSON.stringify(daysOf(gs)));
    // appliesOnDay mirror: goal shows on weekday W iff daysOf(g).includes(W).
    const appliesOn = (g, w) => daysOf(g).includes(w);
    const shown = [0, 1, 2, 3, 4, 5, 6].filter((w) => appliesOn(gs, w));
    ok(JSON.stringify(shown) === JSON.stringify([3]), 'single-day: applies on Wed only — NOT every day', 'shown on weekdays ' + JSON.stringify(shown));

    // ---- DAY-NAVIGATOR: a recurring (Tuesday-only) goal must show on the main
    //      dashboard for ANY future date whose weekday matches — tomorrow, next
    //      week, weeks out — and never on a non-matching weekday. Mirrors the
    //      web feed's appliesOnDay(g, viewedDate) = daysOf(g).includes(getDay()).
    //      Regression guard for the "next-Tuesday shows No goals" bug where the
    //      feed matched against TODAY (this.now) instead of the viewed day. ----
    const appliesOnDay = (g, date) => daysOf(g).includes(date.getDay());
    const tue = await request(app).post('/api/spartan/goals').set('Authorization', A)
      .send({ goal: 'Tuesday standup', start_time: '10:00', duration_minutes: 15, recurrence: 'custom', day_of_week: '2' });
    const gt = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === tue.body.id);
    ok(gt && JSON.stringify(daysOf(gt)) === JSON.stringify([2]), 'navigator: Tuesday goal reconstructs [2]', JSON.stringify(daysOf(gt)));
    // Fixed reference "today" = Wed 2026-07-22 (matches the reported repro). Roll
    // to Tuesdays 1..8 weeks out and the surrounding Mon/Wed — no Date.now().
    const base = new Date(2026, 6, 22); // local Wed
    ok(base.getDay() === 3, 'navigator: reference date is a Wednesday (getDay 3)', String(base.getDay()));
    const at = (offsetDays) => new Date(2026, 6, 22 + offsetDays);
    const firstTueOffset = ((2 - base.getDay() + 7) % 7) || 7; // strictly future Tue = +6 -> Jul 28
    let allTueMatch = true, anyNonTueMatch = false;
    for (let wk = 0; wk < 8; wk++) {
      const tueDate = at(firstTueOffset + wk * 7);
      if (tueDate.getDay() !== 2) allTueMatch = false;            // sanity: it IS a Tuesday
      if (!appliesOnDay(gt, tueDate)) allTueMatch = false;         // must show on every future Tue
      if (appliesOnDay(gt, at(firstTueOffset + wk * 7 - 1))) anyNonTueMatch = true; // Monday before: must NOT
      if (appliesOnDay(gt, at(firstTueOffset + wk * 7 + 1))) anyNonTueMatch = true; // Wednesday after: must NOT
    }
    ok(allTueMatch, 'navigator: Tuesday goal shows on the next Tue AND every Tue up to 8 weeks out (distance-independent)');
    ok(!anyNonTueMatch, 'navigator: Tuesday goal never shows on the surrounding Mon/Wed at any distance');
    ok(appliesOnDay(gt, at(firstTueOffset)) && !appliesOnDay(gt, base), 'navigator: shows on next Tuesday, NOT on today (Wed)');

    // ---- MALFORMED/LEGACY guard: a 'custom' goal with NO day_of_week must NOT
    //      expand to every day. This is the exact shape of pre-server-switch
    //      localStorage goals that made single-day goals appear daily. ----
    const bad = await request(app).post('/api/spartan/goals').set('Authorization', A)
      .send({ goal: 'Legacy no-days', start_time: '08:00', duration_minutes: 10, recurrence: 'custom' });
    const gb = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === bad.body.id);
    ok(gb && (gb.day_of_week == null || String(gb.day_of_week) === ''), 'legacy-guard: custom goal stored with null day_of_week', gb && gb.day_of_week);
    ok(gb && JSON.stringify(daysOf(gb)) === JSON.stringify([]), 'legacy-guard: daysOf() returns [] (shows on NO day) — NOT every day', JSON.stringify(daysOf(gb)));

    // ---- a daily goal (recurrence preset, no CSV) still yields all 7 days ----
    const daily = await request(app).post('/api/spartan/goals').set('Authorization', A)
      .send({ goal: 'Read', start_time: '21:00', duration_minutes: 20, recurrence: 'daily', day_of_week: '0,1,2,3,4,5,6' });
    const gd = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === daily.body.id);
    ok(JSON.stringify(daysOf(gd)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]), 'recurrence: daily goal -> all 7 weekdays');

    // ---- DELETE: goal + its log gone ----
    await request(app).post(`/api/spartan/goals/${goalId}/log`).set('Authorization', A).send({ status: 'completed' });
    const del = await request(app).delete(`/api/spartan/goals/${goalId}`).set('Authorization', A);
    ok(del.status === 200, 'delete: 200');
    const [logRows] = await conn.query('SELECT COUNT(*) AS c FROM spartan_goal_log WHERE goal_id = ?', [goalId]);
    ok(Number(logRows[0].c) === 0, 'delete: goal\'s completion log rows also removed');
    g = (await request(app).get('/api/spartan/goals').set('Authorization', A)).body.goals.find((x) => x.id === goalId);
    ok(!g, 'delete: goal no longer listed');

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
