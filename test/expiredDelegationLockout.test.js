/* Round 3: a trial-EXPIRED, non-upgraded account (even a GC owner) loses contact
 * access + delegation. Tested at the shared getContactScope/visibleUserPredicate
 * layer (the get-task-users inline check is the identical rule). A recent
 * (trial_active) owner is UNAFFECTED. Real MySQL.
 * Run: NODE_PATH=<backend>/node_modules node test/expiredDelegationLockout.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_expired_deleg', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const { getContactScope, visibleUserPredicate } = require('../utils/contactVisibility');

    await conn.query(`CREATE TABLE user (id INT PRIMARY KEY, role INT, category INT, email VARCHAR(190),
      created_at DATETIME, created_by INT, can_view_all_contacts TINYINT DEFAULT 0)`);
    await conn.query(`CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(20),
      needs_reverification TINYINT DEFAULT 0, reverification_due_at DATETIME NULL)`);
    // Recent GC owner (trial_active) and an expired GC owner (created 100 days ago, no sub).
    await conn.query(`INSERT INTO user (id,role,category,email,created_at,created_by) VALUES
      (74,14,4,'recent@t.co',NOW(),NULL),
      (900,14,4,'expired@t.co',NOW() - INTERVAL 100 DAY,NULL)`);

    const scope = (u) => getContactScope(conn, { user: u });

    const recent = await scope({ id: 74, working_id: 74, email: 'recent@t.co' });
    ok(recent.expired === false && recent.canViewAll === true && recent.scope_id === 74,
      'RECENT (trial_active) owner: not expired, full visibility (scope=owner)', JSON.stringify(recent));

    const expired = await scope({ id: 900, working_id: 900, email: 'expired@t.co' });
    ok(expired.expired === true, 'EXPIRED owner: flagged expired', JSON.stringify(expired));
    ok(expired.canViewAll === false, 'EXPIRED owner: canViewAll forced FALSE (loses contact access)', JSON.stringify(expired));

    // The predicate an expired account gets = self only (no contact book).
    const vis = visibleUserPredicate('u', expired);
    ok(/u\.id = \?/.test(vis.sql) && !/contact/.test(vis.sql) && vis.params.length === 1 && vis.params[0] === 900,
      'EXPIRED owner: visibleUserPredicate collapses to SELF ONLY (no contacts, no delegation targets)', JSON.stringify(vis));

    // Owner-exempt platform account is NEVER expired-locked even if old + no sub.
    await conn.query(`INSERT INTO user (id,role,category,email,created_at,created_by) VALUES (5,14,4,'admin@oakcoast.net',NOW() - INTERVAL 200 DAY,NULL)`);
    const exempt = await scope({ id: 5, working_id: 5, email: 'admin@oakcoast.net' });
    ok(exempt.expired === false && exempt.canViewAll === true,
      'OWNER-EXEMPT account is never expired-locked', JSON.stringify(exempt));
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
