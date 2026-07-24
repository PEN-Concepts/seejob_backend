/* Owner-exempt plan gating — getActivePlanLevel returns the TOP tier for
 * OWNER_EXEMPT_EMAILS (poul@/admin@oakcoast.net) regardless of subscription, so
 * the platform owner always passes requirePlan('gold') + shows the Gold UI. Every
 * other account is still governed purely by its plan.
 * Real MySQL (mysql-memory-server). Run: NODE_PATH=<backend>/node_modules node test/accessOwnerExempt.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_ownerexempt_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { getActivePlanLevel, PLAN_LEVELS } = require('../utils/access');
    conn = await pool.getConnection();
    await conn.query(`CREATE TABLE user (id INT PRIMARY KEY, email VARCHAR(190), role INT, created_by INT NULL, category INT NULL) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), level INT NULL) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE subscriptions (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, plan_id INT, status VARCHAR(20) DEFAULT 'active') ENGINE=InnoDB`);
    await conn.query("INSERT INTO plans (id, name, level) VALUES (1,'Basic',1),(4,'Gold Monthly',4)");
    await conn.query(`INSERT INTO user (id, email, role, created_by, category) VALUES
      (100,'poul@oakcoast.net',1,NULL,NULL),
      (101,'admin@oakcoast.net',1,NULL,NULL),
      (102,'someone@example.com',1,NULL,NULL),
      (103,'gold@example.com',1,NULL,NULL),
      (104,'emp@oakcoast.net',2,100,1)`);       // employee of owner 100 (poul)
    await conn.query("INSERT INTO subscriptions (user_id, plan_id, status) VALUES (103,4,'active')"); // gold@ has a real Gold sub

    const lvl = (id) => getActivePlanLevel(id, conn);

    ok((await lvl(100)) === PLAN_LEVELS.platinum, 'poul@ (no sub) → top tier (platinum)', String(await lvl(100)));
    ok((await lvl(101)) === PLAN_LEVELS.platinum, 'admin@ (no sub) → top tier (platinum)', String(await lvl(101)));
    ok((await lvl(101)) >= PLAN_LEVELS.gold, 'admin@ passes the Gold gate (level >= 4)', String(await lvl(101)));
    ok((await lvl(102)) === 0, 'non-exempt, no sub → level 0 (still gated)', String(await lvl(102)));
    ok((await lvl(103)) === 4, 'non-exempt with a real Gold sub → level 4 (plan-driven, unchanged)', String(await lvl(103)));
    ok((await lvl(104)) === PLAN_LEVELS.platinum, 'employee of an exempt owner inherits the exemption', String(await lvl(104)));

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
