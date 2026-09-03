/* Notepad "attach a job" — functional test (real local MySQL via
 * mysql-memory-server + supertest). Proves:
 *   - a section can be created with an own-account job attached (job_id stored);
 *   - reads return the job's name + EXACT color (same job.color source);
 *   - a job can be attached after the fact, and detached (job_id = null);
 *   - a FOREIGN job (another account's) is rejected 403 on create AND update
 *     (no cross-account name/color leak onto the pad).
 * getAccessMode is stubbed to 'paid' so this targets the attach logic, not billing.
 * Run: node test/notepadJobAttach.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_notepad_jobattach_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    const accessMod = require('../utils/access');
    accessMod.getAccessMode = async () => 'paid';

    conn = await pool.getConnection();
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, timezone VARCHAR(64) NULL)");
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, shared_with_user_id INT NULL,
      type VARCHAR(20), title VARCHAR(255), sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, lead_id INT NULL, complete_percentage INT NULL,
      priority VARCHAR(10) DEFAULT 'low', due_date DATETIME NULL, status VARCHAR(20) DEFAULT 'new',
      assignee_completed TINYINT DEFAULT 0, created_by INT NULL, type VARCHAR(20) DEFAULT 'task',
      is_calendar TINYINT NULL, is_appointment TINYINT NULL, calendar_task_id INT NULL,
      appointment_id INT NULL, filed_at DATETIME NULL, kept TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), color VARCHAR(30) NULL, status INT DEFAULT 1)");
    // 700 = owner; 800 = a DIFFERENT account (created_by NULL → own account root).
    await conn.query("INSERT INTO `user` (id,name,email,role,category) VALUES (700,'Owner Olly','olly@x.com',14,2),(800,'Foreign Fran','fran@x.com',14,2)");
    // Job 10 belongs to 700; job 20 belongs to the foreign account 800.
    await conn.query("INSERT INTO `job` (id,created_by,name,color) VALUES (10,700,'Lynes - ADU','#a83279'),(20,800,'Foreign Job','#123456')");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/checklists'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(700);

    const readSection = async (secId) => {
      const v = await request(app).get('/api/checklists/sections-with-items').set('Authorization', OWNER);
      return (v.body?.data || []).find((s) => s.id === secId) || null;
    };

    // A) Create a section WITH an own-account job attached.
    const mk = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Lynes pad', job_id: 10 });
    ok(mk.status === 201 && Number(mk.body?.data?.job_id) === 10, 'A: create section with own job → 201, job_id stored', JSON.stringify(mk.body));
    const secId = mk.body.data.id;

    // B) Read returns the job's exact name + color.
    const s1 = await readSection(secId);
    ok(!!s1 && Number(s1.job_id) === 10, 'B: read carries job_id', JSON.stringify(s1));
    ok(!!s1 && s1.job_color === '#a83279' && s1.job_name === 'Lynes - ADU', 'B: read returns exact job.color + job name', JSON.stringify(s1));

    // C) Create with a FOREIGN job → 403 (no cross-account leak).
    const foreign = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Sneaky', job_id: 20 });
    ok(foreign.status === 403, 'C: create with foreign job → 403', foreign.status + ' ' + JSON.stringify(foreign.body));

    // D) Attach after the fact, then detach.
    const plain = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Later pad' });
    const plainId = plain.body.data.id;
    ok(plain.status === 201 && plain.body.data.job_id === null, 'D: plain section starts with no job', JSON.stringify(plain.body.data));
    const attach = await request(app).put('/api/checklists/sections/' + plainId).set('Authorization', OWNER).send({ job_id: 10 });
    ok(attach.status === 200, 'D: attach own job after the fact → 200', attach.status);
    const s2 = await readSection(plainId);
    ok(!!s2 && s2.job_color === '#a83279', 'D: read now shows the job color band source', JSON.stringify(s2));
    const detach = await request(app).put('/api/checklists/sections/' + plainId).set('Authorization', OWNER).send({ job_id: null });
    ok(detach.status === 200, 'D: detach (job_id null) → 200', detach.status);
    const s3 = await readSection(plainId);
    ok(!!s3 && s3.job_id === null && (s3.job_color === null || s3.job_color === undefined), 'D: detached section = no band (job_id + color null)', JSON.stringify(s3));

    // E) Update to a FOREIGN job → 403.
    const upForeign = await request(app).put('/api/checklists/sections/' + secId).set('Authorization', OWNER).send({ job_id: 20 });
    ok(upForeign.status === 403, 'E: attach foreign job via update → 403', upForeign.status);

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
