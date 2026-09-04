/* PUT /jobtask/:id/percent — owner-gated task percent setter (Job Schedule).
 *
 * Proves against real MySQL (mysql-memory-server) + supertest:
 *  - OWNER can set a task percent → 200, complete_percentage persists.
 *  - 100% marks the task done (status 1); < 100% re-opens it (status 0).
 *  - It touches ONLY complete_percentage + status — the assignee (user_id) is
 *    left intact (no /update footgun of nulling user_id).
 *  - A cross-account SUB (a plain assignee) is refused (403 PERCENT_OWNER_ONLY).
 *  - Missing/invalid percent → 400.
 *
 *   G(900) owner GC (created the task)   S(910) cross-company sub (primary assignee)
 *
 * Run: NODE_PATH=<backend>/node_modules node test/taskPercentEndpoint.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_taskpercent_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, created_by INT NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30))");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20), task_name VARCHAR(150), status INT NULL, complete_percentage INT NULL, assignee_completed INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT)");

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (900,'Owner','g@x.com',14,2,NULL),(910,'Sub','s@x.com',14,2,NULL)");
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (900,'active'),(910,'active')");
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,complete_percentage,assignee_completed,created_at) VALUES (2900,1900,910,900,'job','Framing',0,0,0, NOW())");

    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/jobtask', require('../routes/tasks'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id, role: 14, category: 2, email: id + '@x.com', working_id: id }, process.env.ACCESS_TOKEN);
    const put = (id, body) => request(app).put('/api/jobtask/2900/percent').set('Authorization', tok(id)).send(body);
    const row = async () => { const [[r]] = await conn.query('SELECT * FROM tasks WHERE id=2900'); return r; };

    // owner sets 40% → 200, persists, still open, assignee intact
    const r40 = await put(900, { percent: 40 });
    ok(r40.status === 200, 'owner set 40% -> 200', r40.status + ' ' + JSON.stringify(r40.body));
    {
      const t = await row();
      ok(Number(t.complete_percentage) === 40, 'complete_percentage persisted 40', t.complete_percentage);
      ok(Number(t.status) === 0, '40% keeps task open (status 0)', t.status);
      ok(Number(t.user_id) === 910, 'assignee (user_id) untouched by percent set', t.user_id);
    }

    // owner sets 100% → done (status 1)
    const r100 = await put(900, { percent: 100 });
    ok(r100.status === 200 && r100.body.status === 1, 'owner set 100% -> 200, status 1 (done)', r100.status + ' ' + JSON.stringify(r100.body));
    ok(Number((await row()).status) === 1, '100% marks task done (status 1)', (await row()).status);

    // owner lowers back to 60% → re-opens (status 0)
    await put(900, { percent: 60 });
    ok(Number((await row()).status) === 0, 'lowering to 60% re-opens (status 0)', (await row()).status);

    // clamp: 150 → 100
    await put(900, { percent: 150 });
    ok(Number((await row()).complete_percentage) === 100, 'percent clamps to 100', (await row()).complete_percentage);

    // cross-account sub (plain assignee) refused
    const rSub = await put(910, { percent: 25 });
    ok(rSub.status === 403 && rSub.body.code === 'PERCENT_OWNER_ONLY', 'sub CANNOT set percent -> 403 PERCENT_OWNER_ONLY', rSub.status + ' ' + JSON.stringify(rSub.body));
    ok(Number((await row()).complete_percentage) === 100, 'sub refusal left percent unchanged (100)', (await row()).complete_percentage);

    // invalid body → 400
    const rBad = await put(900, {});
    ok(rBad.status === 400, 'missing percent -> 400', rBad.status + ' ' + JSON.stringify(rBad.body));

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
