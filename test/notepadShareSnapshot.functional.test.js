/* Notepad Share snapshot — synthetic-data functional test (real local MySQL via
 * mysql-memory-server + supertest). Proves POST /sections/:id/share:
 *   - EMAIL: owner sends a point-in-time HTML checklist snapshot (sendMail called
 *     with the section title + every item name; completed items marked done);
 *   - CHAT: owner sends a plain-text snapshot into a direct conversation
 *     (getOrCreateDirect + postMessage called; body carries the checklist);
 *   - the share grants NO access and is OWNER-ONLY: a second account cannot share
 *     someone else's section (404);
 *   - validation: bad channel (400), email w/o recipient (400), chat w/o
 *     recipient (400), chat to self (400).
 * mailer.sendMail and chat.getOrCreateDirect/postMessage are stubbed so the test
 * targets THIS endpoint's rendering + access logic, not real email/socket delivery.
 * getAccessMode is stubbed to 'paid' so billing doesn't gate the endpoint.
 * Run: node test/notepadShareSnapshot.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_share_test', logLevel: 'ERROR' });
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

    // Stub outbound delivery. The router accesses mailer.sendMail /
    // chat.getOrCreateDirect / chat.postMessage as PROPERTIES at call time, so
    // replacing them on the module objects intercepts the real calls.
    const mailer = require('../services/mailer');
    const chat = require('../services/chat');
    let lastMail = null;
    mailer.sendMail = async (opts) => { lastMail = opts; return { messageId: 'stub' }; };
    let lastConv = null, lastMsg = null;
    chat.getOrCreateDirect = async (c, a, b) => { lastConv = { a, b }; return 9999; };
    chat.postMessage = async (m) => { lastMsg = m; return 1; };

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
    await conn.query("INSERT INTO `user` (id,name,email,role) VALUES (700,'Owner Olly','olly@x.com',14),(701,'Other Ollie','ollie@x.com',14)");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/checklists'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(700), OTHER = tok(701);

    // Owner sets up a page with one open + one completed item.
    const mk = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Bid Lynes' });
    const secId = mk.body.data.id;
    await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'Order HVAC unit', section_id: secId });
    const it2 = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'Pull permit', section_id: secId });
    await request(app).put('/api/checklists/status-update').set('Authorization', OWNER).send({ ids: [it2.body.data.id], status: 'completed' });

    // ===== EMAIL snapshot =====
    lastMail = null;
    const em = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'email', to_email: 'client@example.com' });
    ok(em.status === 200, 'email: share returns 200', JSON.stringify(em.body));
    ok(lastMail && lastMail.to === 'client@example.com', 'email: sendMail addressed to recipient', JSON.stringify(lastMail && lastMail.to));
    ok(lastMail && /Bid Lynes/.test(lastMail.subject || '') , 'email: subject carries the notepad title', lastMail && lastMail.subject);
    ok(lastMail && /Order HVAC unit/.test(lastMail.html || '') && /Pull permit/.test(lastMail.html || ''), 'email: HTML body lists every item');
    ok(lastMail && /line-through/.test(lastMail.html || ''), 'email: completed item rendered struck-through (snapshot state)');
    ok(lastMail && /Order HVAC unit/.test(lastMail.text || ''), 'email: has a plain-text alt part too');

    // ===== CHAT snapshot =====
    lastConv = null; lastMsg = null;
    const ch = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'chat', to_user_id: 701 });
    ok(ch.status === 200 && ch.body?.conversation_id === 9999, 'chat: share returns 200 + conversation id', JSON.stringify(ch.body));
    ok(lastConv && Number(lastConv.a) === 700 && Number(lastConv.b) === 701, 'chat: opened direct convo between sender + recipient', JSON.stringify(lastConv));
    ok(lastMsg && Number(lastMsg.senderId) === 700 && Number(lastMsg.conversationId) === 9999, 'chat: posted message as sender into the convo', JSON.stringify(lastMsg && { s: lastMsg.senderId, c: lastMsg.conversationId }));
    ok(lastMsg && /Order HVAC unit/.test(lastMsg.body || '') && /\[x\] Pull permit/.test(lastMsg.body || ''), 'chat: message body carries the checklist snapshot', lastMsg && lastMsg.body);

    // ===== OWNER-ONLY: other account cannot share owner's section =====
    lastMail = null;
    const foreign = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OTHER).send({ channel: 'email', to_email: 'x@x.com' });
    ok(foreign.status === 404, 'other: cannot share someone else\'s notepad (404)', String(foreign.status));
    ok(lastMail === null, 'other: no email dispatched for a foreign section');

    // ===== VALIDATION =====
    const badCh = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'carrier-pigeon', to_email: 'x@x.com' });
    ok(badCh.status === 400, 'validation: unknown channel rejected (400)', String(badCh.status));
    const noEmail = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'email' });
    ok(noEmail.status === 400, 'validation: email channel requires to_email (400)', String(noEmail.status));
    const noUser = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'chat' });
    ok(noUser.status === 400, 'validation: chat channel requires to_user_id (400)', String(noUser.status));
    const toSelf = await request(app).post(`/api/checklists/sections/${secId}/share`).set('Authorization', OWNER).send({ channel: 'chat', to_user_id: 700 });
    ok(toSelf.status === 400, 'validation: cannot share to yourself over chat (400)', String(toSelf.status));

  } catch (e) {
    fail++; rec.push('  ✗ THREW: ' + e.message + '\n' + (e.stack || ''));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
    console.log('\nNotepad Share snapshot functional test');
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
