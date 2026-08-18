/* Assign-notification dedupe — drives the REAL PUT /tasks/update/:id against real
 * MySQL. Proves the backend defense-in-depth for the double-push bug: two racing
 * "new assignment" notifications (same receiver+content within 15s) collapse to one.
 * Run: node test/verify-assign-dedupe.js
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_dedupe', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, role INT NULL, category INT NULL, created_by INT NULL)');
    await conn.query(`CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, team_id INT NULL,
      created_by INT NULL, status TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, assignee_seen_at DATETIME NULL,
      task_name VARCHAR(255) NULL, description TEXT NULL, job_id INT NULL, duration_days INT NULL,
      start_date DATETIME NULL, end_date DATETIME NULL, time DATETIME NULL, priority VARCHAR(10) NULL,
      complete_percentage INT NULL, image VARCHAR(255) NULL, audio_note VARCHAR(255) NULL, nudge INT NULL,
      status_note TEXT NULL, task_type VARCHAR(20) NULL, is_calendar_task TINYINT NULL,
      is_appointment_task TINYINT NULL, schedule_item_id INT NULL, is_urgent TINYINT NULL, completion_response TEXT NULL)`);
    await conn.query('CREATE TABLE task_assignees (id INT AUTO_INCREMENT PRIMARY KEY, task_id INT, user_id INT, seen_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY u (task_id,user_id))');
    await conn.query('CREATE TABLE teams (id INT PRIMARY KEY, team_leader INT NULL)');
    await conn.query('CREATE TABLE notifications (id INT AUTO_INCREMENT PRIMARY KEY, sender_id INT NULL, receiver_id INT NULL, content TEXT NULL, status INT NULL, url VARCHAR(80) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE user_device_tokens (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, fcm_token VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE job_contacts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, job_id INT, contact_id INT)');

    await conn.query(`INSERT INTO \`user\`(id,name,role,category,created_by) VALUES
      (74,'Owner Poul',14,2,NULL),(372,'Rolando',12,2,74),(360,'John',12,2,74)`);

    let ACTOR = { id: 74, role: 14 };
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const accessMod = require('../utils/access');
    accessMod.denyExpiredFreeWrites = (_req, _res, next) => next();
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/tasks', require('../routes/tasks'));
    server = app.listen(0);
    const nCount = async (uid) => (await conn.query('SELECT COUNT(*) n FROM notifications WHERE receiver_id=?', [uid]))[0][0].n;

    // Case A — genuine new assign (no recent notification) → exactly 1 inserted.
    const [ta] = await conn.query("INSERT INTO tasks (user_id, created_by, task_name) VALUES (NULL, 74, 'Paint the deck')");
    await request(server).put(`/tasks/update/${ta.insertId}`).send({ user_id: 372, task_name: 'Paint the deck' });
    ok((await nCount(372)) === 1, 'genuine assign → 1 notification');

    // Case B — a duplicate racing save: pre-insert the SAME notification moments ago,
    // then a CASE-1 assign for the same receiver+content → dedupe skips the 2nd insert.
    const [tb] = await conn.query("INSERT INTO tasks (user_id, created_by, task_name) VALUES (NULL, 74, 'Frame the wall')");
    const content = 'Owner Poul assigned you a new task: "Frame the wall".';
    await conn.query("INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by) VALUES (74, 360, ?, 1, '/task', 74)", [content]);
    await request(server).put(`/tasks/update/${tb.insertId}`).send({ user_id: 360, task_name: 'Frame the wall' });
    ok((await nCount(360)) === 1, 'racing duplicate assign (same content <15s) → still 1 notification (deduped)');

    // Control — a DIFFERENT task/content to 360 is NOT deduped (real distinct assign).
    const [tc] = await conn.query("INSERT INTO tasks (user_id, created_by, task_name) VALUES (NULL, 74, 'Pour footings')");
    await request(server).put(`/tasks/update/${tc.insertId}`).send({ user_id: 360, task_name: 'Pour footings' });
    ok((await nCount(360)) === 2, 'different task → new notification (dedupe is content-specific, not a blanket mute)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
