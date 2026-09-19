/* §F.2 — A ROLLED-UP PAST DUE ROW CARRIES ITS CHILDREN.
 *
 * "Lynes · 2" expands inside the dashboard so Poul sees which two items are
 * past due before deciding whether to leave the screen. That is only
 * possible if the row already knows them: a second request on tap would put
 * a spinner in front of the answer.
 *
 * The shape matters as much as the presence. Each child must carry the same
 * three fields a singly-named row carries — item_id, section_id, job_id —
 * because the client opens a child by exactly the same path it opens a named
 * row. A child that arrived as a bare string would render and then go
 * nowhere when tapped.
 *
 * Run: node test/dashboardRollupChildren.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_rollup_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, created_at DATETIME NULL)");
    // scope / account_owner_id / checklist_section_shares are all referenced
    // by the PAST DUE query, which runs inside a try/catch that swallows the
    // error. Without them the band comes back EMPTY and every assertion
    // below fails for the wrong reason — the same trap that once let a
    // subcontractor-scope test pass against a dead query.
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_section_shares (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, user_id INT)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), created_at DATETIME NULL)");

    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (700,'Poul','poul@x.com',14,4,NULL,NOW())");
    // Job 7 gets TWO past-due items (the rollup). Job 4 gets ONE (the named
    // row) — both shapes in one response, so they can be compared directly.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,color,created_at) VALUES
      (7,'Lynes',700,'#777', NOW() - INTERVAL 2 DAY),
      (4,'Mann Bid',700,'#888', NOW() - INTERVAL 2 DAY)`);
    await conn.query(`INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id) VALUES
      (22,700,'task','Lynes pad',7),
      (11,700,'task','Mann pad',4)`);
    await conn.query(`INSERT INTO check_list (id,section_id,name,due_date,status,created_by) VALUES
      (501,22,'Call the inspector', NOW() - INTERVAL 3 DAY, 'new', 700),
      (502,22,'Send the change order', NOW() - INTERVAL 4 DAY, 'new', 700),
      (909,11,'Order the tile', NOW() - INTERVAL 3 DAY, 'new', 700)`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = 'Bearer ' + jwt.sign(
      { id: 700, role: 14, category: 4, email: 'poul@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const res = await request(app).get('/api/dashboard/exceptions').set('Authorization', tok);
    const rows = (res.body && res.body.bands && res.body.bands.past_due) || [];
    const rollup = rows.find((r) => r.kind === 'rollup');
    const named = rows.find((r) => r.kind === 'item');

    ok(res.status === 200, 'the endpoint answers', String(res.status));
    ok(!!rollup, 'two past-due items on one job roll up', JSON.stringify(rows));
    ok(!!named, 'one past-due item on another job is named directly', JSON.stringify(rows));

    // ── the change itself ───────────────────────────────────────────────
    ok(Array.isArray(rollup && rollup.items) && rollup.items.length === 2,
      'the rollup carries BOTH children, in one response',
      JSON.stringify(rollup && rollup.items));

    ok(rollup && rollup.count === (rollup.items || []).length,
      'the count and the children agree — a count of 2 with 1 child is a bug the UI cannot see',
      JSON.stringify({ count: rollup && rollup.count, kids: (rollup && rollup.items || []).length }));

    const labels = ((rollup && rollup.items) || []).map((k) => k.label).sort();
    ok(JSON.stringify(labels) === JSON.stringify(['Call the inspector', 'Send the change order']),
      'the children are the real items, by name', JSON.stringify(labels));

    // ── the shape, which is what makes them openable ───────────────────
    const kid = ((rollup && rollup.items) || [])[0] || {};
    ok(Number.isFinite(kid.item_id) && kid.item_id > 0,
      'a child carries its own item_id — without it, tapping it goes nowhere', JSON.stringify(kid));
    ok(Number(kid.section_id) === 22, 'and the pad it lives on', JSON.stringify(kid));
    ok(Number(kid.job_id) === 7, 'and its job', JSON.stringify(kid));

    const kidKeys = Object.keys(kid).sort();
    const namedHas = ['item_id', 'section_id', 'job_id'].every((k) => k in (named || {}));
    ok(namedHas && ['item_id', 'section_id', 'job_id'].every((k) => kidKeys.includes(k)),
      'a child and a named row carry the same three fields, so one code path opens both',
      JSON.stringify({ kid: kidKeys, named: Object.keys(named || {}).sort() }));

    // ── what did NOT change ─────────────────────────────────────────────
    ok(named && named.item_id === 909,
      'the singly-named row still names its item — §F.2 did not disturb §F.1',
      JSON.stringify(named));
    ok(!named || named.items === undefined,
      'and a single-item row carries NO children array: nothing for the UI to expand into',
      JSON.stringify(named));

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
