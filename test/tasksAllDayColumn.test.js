/* tasks.all_day — the migration, and the backfill that must NOT happen.
 *
 * THE COLUMN IS THE TRUTH, NEVER THE ABSENCE OF A TIME. A DATETIME cannot tell
 * "3 Oct, all day" from "3 Oct at midnight" — both store 00:00:00 — which is
 * the ambiguity this column exists to remove.
 *
 * THE ASSERTION THAT MATTERS IS THE NO-BACKFILL ONE. An additive column is
 * trivially reversible; a backfill is not. Inferring all-day from a midnight
 * start_date would write a GUESS into the data permanently, indistinguishable
 * from a real answer, and would silently convert a task genuinely scheduled for
 * midnight into an all-day task. Item 6 is that exact row.
 *
 * ROLLBACK:  ALTER TABLE tasks DROP COLUMN all_day;
 *
 * Run: node test/tasksAllDayColumn.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_tasks_allday', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    /* The table as it is BEFORE the migration — no all_day. tasks_images is
     * here because ensureTaskManagerColumns touches it too and would throw
     * without it; nothing in this file asserts on it. */
    await conn.query(`CREATE TABLE tasks (
      id INT PRIMARY KEY AUTO_INCREMENT, task_name VARCHAR(200), job_id INT NULL,
      start_date DATETIME NULL, status INT DEFAULT 0, created_by INT NULL)`);
    await conn.query('CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL)');

    /* THE FIXTURE THE NO-BACKFILL RULE EXISTS FOR.
     *   1 — genuinely scheduled for MIDNIGHT. A backfill inferring all-day from
     *       00:00:00 would corrupt exactly this row, and nobody could ever tell
     *       it from a real all-day answer afterwards.
     *   2 — a normal timed task.
     *   3 — no date at all. */
    await conn.query(`INSERT INTO tasks (id,task_name,start_date) VALUES
      (1,'Midnight pour','2026-10-03 00:00:00'),
      (2,'Morning framing','2026-10-03 08:30:00'),
      (3,'Undated',NULL)`);

    const [[before]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');

    // ── run the migration exactly as the app does ────────────────────────────
    const { ensureTaskManagerColumns } = require('../services/dbMigrations');
    await ensureTaskManagerColumns(conn);

    // ── 1. additive only ────────────────────────────────────────────────────
    const [[col]] = await conn.query(
      `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'all_day'`);
    ok(!!col, 'the column exists after the migration', JSON.stringify(col));
    note(`DDL: ALTER TABLE tasks ADD COLUMN all_day TINYINT(1) NOT NULL DEFAULT 0`);
    note(`stored as: ${col && col.COLUMN_TYPE} NULLABLE=${col && col.IS_NULLABLE} DEFAULT=${col && col.COLUMN_DEFAULT}`);
    ok(col && /tinyint/i.test(col.COLUMN_TYPE), 'TINYINT', col && col.COLUMN_TYPE);
    ok(col && col.IS_NULLABLE === 'NO', 'NOT NULL', col && col.IS_NULLABLE);
    ok(col && String(col.COLUMN_DEFAULT) === '0', 'DEFAULT 0', col && String(col.COLUMN_DEFAULT));

    // The pre-existing columns are untouched — no ALTER changed a type or default.
    const [pre] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks'
          AND COLUMN_NAME IN ('id','task_name','job_id','start_date','status','created_by')`);
    ok(pre.length === 6, 'all six original columns still present', JSON.stringify(pre.map((c) => c.COLUMN_NAME)));
    const startCol = pre.find((c) => c.COLUMN_NAME === 'start_date');
    ok(startCol && /datetime/i.test(startCol.COLUMN_TYPE) && startCol.IS_NULLABLE === 'YES',
      'start_date is unchanged — no existing column was altered', JSON.stringify(startCol));

    // ── 2. row count unchanged, every row reads 0 ───────────────────────────
    const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');
    ok(Number(before.n) === Number(after.n), 'row count unchanged', `${before.n} -> ${after.n}`);
    const [[zeros]] = await conn.query('SELECT COUNT(*) AS n FROM tasks WHERE all_day = 0');
    ok(Number(zeros.n) === Number(after.n), 'EVERY existing row reads 0', `${zeros.n} of ${after.n}`);

    // ── 6. the row the no-backfill rule protects ────────────────────────────
    const [[midnight]] = await conn.query('SELECT start_date, all_day FROM tasks WHERE id = 1');
    ok(Number(midnight.all_day) === 0,
      'a MIDNIGHT task is still all_day = 0 — not silently converted to all-day',
      JSON.stringify(midnight));

    // ── 3. THE ONE THAT MATTERS: the migration contains no backfill ─────────
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'dbMigrations.js'), 'utf8');
    // Just the function this column was added to — a repo-wide grep would trip
    // on every other migration's legitimate UPDATE.
    const fn = src.slice(src.indexOf('async function ensureTaskManagerColumns'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    /* COMMENTS STRIPPED FIRST, for every one of the three checks.
     *
     * The first version stripped them for the start_date check only, and the
     * time-comparison check then failed on "00:00:00" inside the comment
     * EXPLAINING why there is no backfill. A grep that reads prose is not
     * reading the migration — and a test that fails on its own documentation
     * would get "fixed" by deleting the documentation. */
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok(!/UPDATE/i.test(code), 'no UPDATE in the migration', code.match(/UPDATE[^\n]*/i));
    ok(!/start_date/.test(code), 'no reference to start_date in the migration',
      code.match(/start_date[^\n]*/));
    ok(!/\d{2}:\d{2}|HOUR\(|TIME\(|DATE\(/i.test(code), 'no time comparison in the migration',
      code.match(/\d{2}:\d{2}|HOUR\(|TIME\(|DATE\([^\n]*/i));
    note('the three no-backfill greps run against the migration with comments stripped');

    // ── idempotent: running it twice changes nothing ────────────────────────
    await ensureTaskManagerColumns(conn);
    const [[twice]] = await conn.query('SELECT COUNT(*) AS n FROM tasks WHERE all_day = 0');
    ok(Number(twice.n) === Number(after.n), 'running the migration twice is a no-op', `${twice.n}`);

    // ── 8. the rollback, executed rather than merely quoted ─────────────────
    await conn.query('ALTER TABLE tasks DROP COLUMN all_day');
    const [[gone]] = await conn.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'all_day'`);
    const [[stillThere]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');
    ok(Number(gone.n) === 0, 'ROLLBACK works: ALTER TABLE tasks DROP COLUMN all_day');
    ok(Number(stillThere.n) === Number(before.n), 'and the rollback loses no rows', `${stillThere.n}`);
    note('rollback statement: ALTER TABLE tasks DROP COLUMN all_day;');
  } catch (e) {
    ok(false, 'HARNESS ERROR: ' + (e && e.message));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db) await db.stop(); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
