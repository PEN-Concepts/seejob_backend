/* PHASE 2 BACKBONE — client_visible migration + the paid-or-trial access gate.
 *
 * The Schedule was Platinum-only; the ruling opens it to all PAID or IN-TRIAL
 * accounts (expired_free is blocked). And every schedule row gains a client_visible
 * flag (default 1 / visible) so the later Client View page is ready. This proves:
 *   - the migration adds client_visible with DEFAULT 1 (existing rows backfill visible),
 *   - a new row is visible without being told to be, and the flag toggles,
 *   - requireActiveAccess passes paid + trial and 403s an expired trial.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV; process.env.API_URL = '/api';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_sched_p2', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();

    // ── §1 client_visible migration ─────────────────────────────────────────────
    const mig = require('../services/dbMigrations');
    await mig.ensureScheduleTemplateTables(conn);
    const [cols] = await conn.query("SHOW COLUMNS FROM job_schedule_items LIKE 'client_visible'");
    ok(cols.length === 1, 'migration adds client_visible to job_schedule_items', JSON.stringify(cols));
    ok(cols.length === 1 && Number(cols[0].Default) === 1, 'client_visible DEFAULT is 1 (visible)', cols[0] && cols[0].Default);

    // A schedule + an item inserted WITHOUT client_visible must come back visible.
    const [sIns] = await conn.query(
      "INSERT INTO job_schedules (job_id, owner_type, name, start_date, status) VALUES (1,'job','S','2026-01-02','active')"
    );
    const sid = sIns.insertId;
    const [iIns] = await conn.query(
      "INSERT INTO job_schedule_items (schedule_id, name, duration_days, sort_order) VALUES (?,?,?,?)",
      [sid, 'Framing', 3, 0]
    );
    const iid = iIns.insertId;
    let [[row]] = await conn.query("SELECT client_visible FROM job_schedule_items WHERE id = ?", [iid]);
    ok(Number(row.client_visible) === 1, 'a new row defaults to client_visible = 1 without being set', JSON.stringify(row));
    await conn.query("UPDATE job_schedule_items SET client_visible = 0 WHERE id = ?", [iid]);
    [[row]] = await conn.query("SELECT client_visible FROM job_schedule_items WHERE id = ?", [iid]);
    ok(Number(row.client_visible) === 0, 'client_visible toggles to 0', JSON.stringify(row));
    await conn.query("UPDATE job_schedule_items SET client_visible = 1 WHERE id = ?", [iid]);
    [[row]] = await conn.query("SELECT client_visible FROM job_schedule_items WHERE id = ?", [iid]);
    ok(Number(row.client_visible) === 1, 'client_visible toggles back to 1', JSON.stringify(row));

    // ── §2 requireActiveAccess: paid + trial pass, expired_free 403 ─────────────
    const access = require('../utils/access');
    // getAccessInfo reads user (role, created_at, email) + subscriptions.
    await conn.query("CREATE TABLE IF NOT EXISTS `user` (id INT PRIMARY KEY, role INT NULL, created_at DATETIME NULL, email VARCHAR(190) NULL, created_by INT NULL, category INT NULL)");
    await conn.query("CREATE TABLE IF NOT EXISTS subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(20), past_due_since DATETIME NULL)");
    // 500: trial (recent signup, no subscription). 501: expired (old signup, no sub).
    // 502: paid (active subscription).
    await conn.query("INSERT INTO `user` (id, role, created_at, email, category) VALUES (500,14,NOW(),'trial@x.com',2),(501,14,'2000-01-01','exp@x.com',2),(502,14,NOW(),'paid@x.com',2)");
    await conn.query("INSERT INTO subscriptions (user_id, status) VALUES (502,'active')");

    ok((await access.getAccessMode(500, conn)) === 'trial_active', 'user 500 classifies trial_active');
    ok((await access.getAccessMode(501, conn)) === 'expired_free', 'user 501 classifies expired_free');
    ok((await access.getAccessMode(502, conn)) === 'paid', 'user 502 classifies paid');

    const runGate = (userId) => new Promise((resolve) => {
      let done = false;
      const res = { status: (code) => ({ json: () => { if (!done) { done = true; resolve({ blocked: true, code }); } } }) };
      const next = () => { if (!done) { done = true; resolve({ blocked: false }); } };
      access.requireActiveAccess({ user: { id: userId } }, res, next);
    });
    const trialR = await runGate(500);
    ok(trialR.blocked === false, 'requireActiveAccess: TRIAL passes (next called)', JSON.stringify(trialR));
    const paidR = await runGate(502);
    ok(paidR.blocked === false, 'requireActiveAccess: PAID passes (next called)', JSON.stringify(paidR));
    const expR = await runGate(501);
    ok(expR.blocked === true && expR.code === 403, 'requireActiveAccess: EXPIRED trial is 403', JSON.stringify(expR));

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    conn.release(); if (pool.end) await pool.end(); if (db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n')); console.error('HARNESS ERROR:', e && e.stack || e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
