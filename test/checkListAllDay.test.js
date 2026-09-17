/* check_list.all_day — the migration, and the rule it exists to protect.
 *
 * ALL-DAY IS NEVER INFERRED FROM THE ABSENCE OF A TIME. A task with a date
 * and no time already means something: due that day, reminder cannot fire
 * precisely. An all-day task is a different thing. If the two were ever
 * conflated, every existing no-time task would change meaning silently.
 *
 * These drive the migration against LEGACY ROWS WRITTEN BEFORE THE COLUMN
 * EXISTED — which is the only interesting case. A column added to an empty
 * table proves nothing.
 *
 * Run: node test/checkListAllDay.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_allday_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // The table AS IT EXISTED BEFORE this migration — deliberately without
    // all_day, so the ALTER runs against real legacy rows.
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, complete_percentage INT NULL, priority VARCHAR(10) NULL,
      due_date DATETIME NULL, status VARCHAR(20) NULL, created_by INT NULL, type VARCHAR(20) NULL,
      is_calendar TINYINT DEFAULT 0, is_appointment TINYINT DEFAULT 0,
      calendar_task_id INT NULL, appointment_id INT NULL, assignee_completed TINYINT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");

    // Legacy rows. The three no-time shapes are the ones inference would have
    // wrongly flipped to all-day.
    await conn.query(`INSERT INTO check_list (id, section_id, name, due_date, status, created_by) VALUES
      (1, 1, 'Timed task — 2pm',            '2026-09-10 14:00:00', 'new', 700),
      (2, 1, 'Timed task — 9:30am',         '2026-09-11 09:30:00', 'new', 700),
      (3, 1, 'Dated, NO time (midnight)',   '2026-09-12 00:00:00', 'new', 700),
      (4, 1, 'Dated, NO time (midnight) 2', '2026-09-13 00:00:00', 'new', 700),
      (5, 1, 'No date at all',              NULL,                  'new', 700),
      (6, 1, 'Genuine midnight task',       '2026-09-14 00:00:00', 'new', 700)`);

    const [[before]] = await conn.query('SELECT COUNT(*) AS n FROM check_list');
    ok(Number(before.n) === 6, 'six legacy rows exist before the migration', JSON.stringify(before));

    // ── RUN THE MIGRATION ────────────────────────────────────────────────
    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);

    // 1. Every existing row is 0, including every no-time row.
    const [rows] = await conn.query('SELECT id, name, due_date, all_day FROM check_list ORDER BY id');
    const nonZero = rows.filter((r) => Number(r.all_day) !== 0);
    ok(nonZero.length === 0,
      'every existing row has all_day = 0 after the migration',
      JSON.stringify(nonZero));

    const noTime = rows.filter((r) => r.due_date == null || String(r.due_date).slice(11, 19) === '00:00:00');
    note(`no-time rows (date missing, or midnight): ${noTime.length} of ${rows.length} — ` +
         'these are exactly the rows inference would have wrongly flipped to all-day');
    ok(noTime.length === 4, 'the fixture really does contain no-time rows to protect', String(noTime.length));
    ok(noTime.every((r) => Number(r.all_day) === 0),
      'every NO-TIME row is still all_day = 0 — not inferred',
      JSON.stringify(noTime.map((r) => [r.id, r.all_day])));

    // 2. Column shape: NOT NULL, DEFAULT 0.
    const [[col]] = await conn.query(
      `SELECT IS_NULLABLE, COLUMN_DEFAULT, DATA_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'check_list' AND COLUMN_NAME = 'all_day'`);
    ok(!!col, 'the all_day column exists', JSON.stringify(col));
    ok(col && col.IS_NULLABLE === 'NO', 'all_day is NOT NULL', col && col.IS_NULLABLE);
    ok(col && String(col.COLUMN_DEFAULT) === '0', 'all_day defaults to 0', col && String(col.COLUMN_DEFAULT));

    // A new row written without mentioning all_day lands at 0, not null.
    await conn.query("INSERT INTO check_list (section_id, name, due_date, status, created_by) VALUES (1,'New row, no time',NULL,'new',700)");
    const [[fresh]] = await conn.query('SELECT all_day FROM check_list ORDER BY id DESC LIMIT 1');
    ok(Number(fresh.all_day) === 0, 'a NEW no-time row also lands at all_day = 0', JSON.stringify(fresh));

    // 3. Idempotent — running the migration twice changes nothing.
    const { _resetForTests } = require('../services/dashboardSchema');
    await ensureNotepadSchema(conn);
    const [[again]] = await conn.query('SELECT COUNT(*) AS n FROM check_list WHERE all_day <> 0');
    ok(Number(again.n) === 0, 'running the migration a second time flips nothing', JSON.stringify(again));

    // 4. STATIC: no code path derives all_day from the absence of a time.
    //    Scan every route/service for an assignment of all_day whose value
    //    mentions a time field. This is the rule the column exists for, so it
    //    is asserted in the suite rather than left to review.
    const roots = ['routes', 'services', 'scripts'];
    const files = [];
    for (const r of roots) {
      const dir = path.join(__dirname, '..', r);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
    const suspicious = [];
    const TIMEY = /(due_time|start_time|\btime\b|hour|minute|HH:?MM)/i;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      src.split(/\r?\n/).forEach((ln, i) => {
        if (!/all_day/.test(ln)) return;
        // An assignment or ternary that decides all_day from something timey.
        const assigns = /all_day\s*[:=]/.test(ln) || /all_day['"]?\s*,/.test(ln);
        if (assigns && TIMEY.test(ln) && !/^\s*(\/\/|\*)/.test(ln)) {
          suspicious.push(path.relative(path.join(__dirname, '..'), f) + ':' + (i + 1) + '  ' + ln.trim().slice(0, 110));
        }
      });
    }
    ok(suspicious.length === 0,
      'no code path sets all_day from the presence or absence of a time',
      JSON.stringify(suspicious, null, 1));
    note(`scanned ${files.length} route/service/script files for all_day inference`);

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
