/* Assign-notification SET-DIFF — drives the REAL PUT /tasks/update/:id against
 * real MySQL (mysql-memory-server). Proves the edit-path gap is closed:
 *   - notify everyone NEWLY ADDED to the assignee set (reassignment A→B AND
 *     adding a 2nd assignee to an already-assigned task),
 *   - notify everyone REMOVED,
 *   - do NOT re-notify people already on the task,
 *   - never notify the ACTOR about their own change (self-skip),
 *   - a partial edit (no assignee field) notifies NO ONE,
 *   - the FCM push is a `notification` block with title "See Job Run" + the
 *     task's own text as the body.
 * Run: node test/verify-assign-notify.js   (exit 0 = pass)
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
    db = await createDB({ dbName: 'seejob_assign_notify', logLevel: 'ERROR' });
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
      (74,'Owner Poul',14,2,NULL),(372,'Rolando',12,2,74),(360,'John',12,2,74),(90,'Bill',5,1,74)`);
    // One device token per person so the push path runs (recipient token → capture).
    await conn.query(`INSERT INTO user_device_tokens (user_id, fcm_token) VALUES
      (74,'tok-74'),(372,'tok-372'),(360,'tok-360'),(90,'tok-90')`);

    let ACTOR = { id: 74, role: 14 };
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    require('../utils/access').denyExpiredFreeWrites = (_req, _res, next) => next();

    // Inject a mock firebase-admin into the require cache BEFORE the router loads,
    // so admin.messaging().send is captured. (The real module's `messaging` is a
    // getter-only prop and is disabled without a service account key, so it can't
    // be monkey-patched in place.)
    let sent = [];
    const fbPath = require.resolve('../config/firebase-admin');
    delete require.cache[fbPath];
    require.cache[fbPath] = {
      id: fbPath, filename: fbPath, loaded: true,
      exports: { messaging: () => ({ send: async (m) => { sent.push(m); return 'mock-id'; } }) },
    };

    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/tasks', require('../routes/tasks'));
    server = app.listen(0);

    const mkTask = async (name, primary, roster) => {
      const [r] = await conn.query('INSERT INTO tasks (user_id, created_by, task_name) VALUES (?, 74, ?)', [primary, name]);
      if (roster && roster.length) {
        const vals = roster.map(() => '(?, ?)').join(',');
        const params = [];
        roster.forEach((u) => params.push(r.insertId, u));
        await conn.query(`INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES ${vals}`, params);
      }
      return r.insertId;
    };
    const notifs = async (uid) => (await conn.query('SELECT content FROM notifications WHERE receiver_id=? ORDER BY id', [uid]))[0].map((r) => r.content);
    const sentTo = (tok) => sent.filter((m) => m.token === tok);

    // Case 1 — REASSIGN 372 → 360 (single). 360 newly added, 372 removed.
    sent = [];
    const t1 = await mkTask('Paint the deck', 372, [372]);
    await request(server).put(`/tasks/update/${t1}`).send({ assignees: [360], task_name: 'Paint the deck' });
    ok((await notifs(360)).some((c) => c.includes('assigned you a new task')), 'reassign: newly-added 360 gets an "assigned" notification');
    ok((await notifs(372)).some((c) => c.includes('removed you from task')), 'reassign: removed 372 gets a "removed" notification');
    ok(sentTo('tok-360').length === 1 && sentTo('tok-372').length === 1, 'reassign: exactly one push to each of 360 (added) and 372 (removed)');
    const p360 = sentTo('tok-360')[0];
    ok(p360.notification && p360.notification.title === 'See Job Run', 'push: title is "See Job Run" (notification block, not data-only)');
    ok(p360.notification && p360.notification.body === 'Paint the deck', 'push: body is the task\'s own text (no framing sentence)');

    // Case 2 — ADD a 2nd assignee to an already-assigned task. 360 added; 372 NOT re-notified.
    sent = [];
    const t2 = await mkTask('Frame the wall', 372, [372]);
    await request(server).put(`/tasks/update/${t2}`).send({ assignees: [372, 360], task_name: 'Frame the wall' });
    ok((await notifs(360)).some((c) => c.includes('Frame the wall')), 'add-2nd: newly-added 360 notified');
    ok(sentTo('tok-372').length === 0, 'add-2nd: existing assignee 372 is NOT re-notified (no push)');
    ok(sentTo('tok-360').length === 1, 'add-2nd: exactly one push to the added person 360');

    // Case 3 — SELF-ADD by the actor. Actor 74 adds themselves to an unassigned task → no notify.
    sent = [];
    const t3 = await mkTask('Owner does it', null, []);
    await request(server).put(`/tasks/update/${t3}`).send({ assignees: [74], task_name: 'Owner does it' });
    ok((await notifs(74)).length === 0, 'self-add: actor (74) is NOT notified about assigning themselves');
    ok(sentTo('tok-74').length === 0, 'self-add: no push to the actor');

    // Case 4 — PARTIAL EDIT (no assignee field). Assignee set untouched → notify no one.
    sent = [];
    const t4 = await mkTask('Just a date change', 372, [372]);
    const before = (await notifs(372)).length;
    await request(server).put(`/tasks/update/${t4}`).send({ status: 1 });
    ok((await notifs(372)).length === before, 'partial edit: existing assignee 372 is NOT spuriously "removed"/notified');
    ok(sent.length === 0, 'partial edit: no pushes at all');

    // Case 5 — someone ELSE assigns 360 to a fresh unassigned task (the real retest path).
    sent = [];
    const t5 = await mkTask('Contact Katlyn', null, []);
    await request(server).put(`/tasks/update/${t5}`).send({ assignees: [360], task_name: 'Contact Katlyn' });
    ok(sentTo('tok-360').length === 1 && sentTo('tok-360')[0].notification.body === 'Contact Katlyn',
       'someone-else-assigns: 360 gets a "See Job Run" push with body = the task text');

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
