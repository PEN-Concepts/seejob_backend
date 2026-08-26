/* Chat core — schema migrations + REST end-to-end on in-memory MySQL.
 * Proves: backfill creates a chat per existing job/lead (owner + job_contacts
 * seeded), listing/sending/reading messages, per-member unread, DM idempotency,
 * member add/remove (owner protected), and non-member 403.
 * Run: node test/verify-chat.js   (exit 0 = pass)
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
    db = await createDB({ dbName: 'seejob_chat', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    // Minimal real-ish schema the chat code touches.
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, image VARCHAR(255) NULL, status TINYINT DEFAULT 1, created_by INT NULL, token_version INT DEFAULT 0)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), created_by INT, status TINYINT DEFAULT 1, color VARCHAR(9) NULL)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(120), user_id INT, status VARCHAR(4) NULL, bid_status VARCHAR(20) NULL)');
    await conn.query('CREATE TABLE job_contacts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, job_id INT, contact_id INT)');
    await conn.query('CREATE TABLE user_device_tokens (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, fcm_token VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE job_documents (id INT AUTO_INCREMENT PRIMARY KEY, path VARCHAR(255), name VARCHAR(255), job_id INT, type VARCHAR(20))');
    await conn.query(`INSERT INTO \`user\`(id,name,business,created_by) VALUES
      (74,'Owner Poul',NULL,NULL),(372,'Rolando','C & R TILE',74),(360,'John','John Painting',74)`);
    await conn.query("INSERT INTO job (id,name,created_by,status,color) VALUES (100,'Lynes ADU',74,1,'#3b82f6')");
    await conn.query("INSERT INTO leads (id,lead_name,user_id) VALUES (200,'Mann ADU',74)");
    await conn.query('INSERT INTO job_contacts (user_id,job_id,contact_id) VALUES (74,100,372)');

    const mig = require('../services/dbMigrations');
    await mig.ensureChatTables(conn);
    await mig.ensureChatMessageEditColumn(conn);
    ok(!!(await conn.query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_conversations'"))[0].length, 'ensureChatTables: chat_conversations exists');
    await mig.ensureChatBackfill(conn);
    const convCount = (await conn.query("SELECT COUNT(*) n FROM chat_conversations"))[0][0].n;
    ok(convCount === 2, 'backfill: one conversation for the job + one for the lead');
    const jobConv = (await conn.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=100"))[0][0].id;
    const jobMembers = (await conn.query('SELECT user_id, role FROM chat_members WHERE conversation_id=? ORDER BY user_id', [jobConv]))[0];
    ok(jobMembers.length === 2 && jobMembers.some(m => m.user_id === 74 && m.role === 'owner') && jobMembers.some(m => m.user_id === 372),
       'backfill: job chat seeded owner (74) + job_contact (372)');

    // REST
    let ACTOR = { id: 74 };
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/chat', require('../routes/chat'));
    server = app.listen(0);
    const as = (id) => { ACTOR = { id }; return request(server); };

    // 1) owner lists their chats
    let r = await as(74).get('/chat/conversations');
    ok(r.status === 200 && r.body.conversations.length === 2, 'GET /conversations: owner sees job + lead chats');
    const jobRow = r.body.conversations.find(c => c.type === 'job');
    ok(jobRow && jobRow.name === 'Lynes ADU' && jobRow.accent === '#3b82f6', 'job chat has job name + job.color accent');
    const leadRow = r.body.conversations.find(c => c.type === 'lead');
    ok(leadRow && leadRow.accent === '#6f7a86', 'lead chat renders grey accent');

    // 2) send a message
    r = await as(74).post(`/chat/conversations/${jobConv}/messages`).send({ body: 'Hello team' });
    ok(r.status === 200 && r.body.message.body === 'Hello team' && r.body.message.sender_name, 'POST message: created with sender name');
    const msgId = r.body.message.id;

    r = await as(372).get(`/chat/conversations/${jobConv}/messages`);
    ok(r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].body === 'Hello team', 'member 372 GET messages: sees it');

    // 3) unread for 372 (message from 74), then mark read → 0
    r = await as(372).get('/chat/conversations');
    ok(r.body.conversations.find(c => c.id === jobConv).unread === 1, 'unread: 372 shows 1 (unseen message from 74)');
    await as(372).post(`/chat/conversations/${jobConv}/read`).send({ last_message_id: msgId });
    r = await as(372).get('/chat/conversations');
    ok(r.body.conversations.find(c => c.id === jobConv).unread === 0, 'after read: 372 unread back to 0');
    r = await as(74).get('/chat/conversations');
    ok(r.body.conversations.find(c => c.id === jobConv).unread === 0, 'sender never counts their own message as unread');

    // 4) non-member 403
    r = await as(360).get(`/chat/conversations/${jobConv}/messages`);
    ok(r.status === 403, 'non-member 360 is refused (403)');

    // 5) direct message idempotency
    r = await as(74).post('/chat/direct').send({ user_id: 360 });
    const dm1 = r.body.conversation_id;
    r = await as(360).post('/chat/direct').send({ user_id: 74 });
    ok(dm1 && dm1 === r.body.conversation_id, 'DM: A→B and B→A resolve to the SAME conversation (canonical key)');

    // 6) members add/remove; owner protected
    await as(74).post(`/chat/conversations/${jobConv}/members`).send({ user_id: 360 });
    r = await as(74).get(`/chat/conversations/${jobConv}/members`);
    ok(r.body.members.some(m => m.user_id === 360), 'add member: 360 added to job chat');
    await as(74).delete(`/chat/conversations/${jobConv}/members/360`);
    r = await as(74).get(`/chat/conversations/${jobConv}/members`);
    ok(!r.body.members.some(m => m.user_id === 360), 'remove member: 360 removed');
    await as(74).delete(`/chat/conversations/${jobConv}/members/74`);
    r = await as(74).get(`/chat/conversations/${jobConv}/members`);
    ok(r.body.members.some(m => m.user_id === 74 && m.role === 'owner'), 'owner cannot be removed');

    // 7) custom GROUP chat (Pass 3 / Part 2): create, membership, accent, messaging
    await mig.ensureChatGroupType(conn); // enum must include 'group'
    r = await as(74).post('/chat/group').send({ name: 'Weekend Crew', user_ids: [372, 360] });
    ok(r.status === 200 && r.body.conversation_id, 'POST /group: creates a custom group');
    const grpConv = r.body.conversation_id;
    r = await as(74).get(`/chat/conversations/${grpConv}/members`);
    ok(r.body.members.length === 3 && r.body.members.some(m => m.user_id === 74 && m.role === 'owner')
       && r.body.members.some(m => m.user_id === 372) && r.body.members.some(m => m.user_id === 360),
       'group: creator is owner + both invitees are members');
    r = await as(74).get('/chat/conversations');
    const grpRow = r.body.conversations.find(c => c.id === grpConv);
    ok(grpRow && grpRow.name === 'Weekend Crew' && grpRow.accent === '#5c6570' && grpRow.type === 'group',
       'group: lists with title, neutral accent, type=group');
    // messaging in the group actually works (post + a different member reads it)
    r = await as(360).post(`/chat/conversations/${grpConv}/messages`).send({ body: 'On my way' });
    ok(r.status === 200 && r.body.message.body === 'On my way', 'group: member can post a message');
    r = await as(372).get(`/chat/conversations/${grpConv}/messages`);
    ok(r.status === 200 && r.body.messages.some(m => m.body === 'On my way'), 'group: another member reads it');
    r = await as(372).get('/chat/conversations');
    ok(r.body.conversations.find(c => c.id === grpConv).unread === 1, 'group: unread counts for the other member');
    // a non-member cannot post/read the group
    r = await as(999).get(`/chat/conversations/${grpConv}/messages`);
    ok(r.status === 403, 'group: non-member is refused (403)');

    // 8) message with image ATTACHMENTS (E.5 "share to chat" path): sendMessage with
    //    attachments referencing existing files → read back with file_path + preview.
    r = await as(74).post(`/chat/conversations/${jobConv}/messages`).send({
      body: '', attachments: [
        { type: 'image', file_path: '/uploads/site-a.jpg', file_name: 'site-a.jpg' },
        { type: 'image', file_path: '/uploads/site-b.jpg', file_name: 'site-b.jpg' },
      ],
    });
    ok(r.status === 200 && r.body.message.id, 'attachments: photo-only message accepted (no body)');
    r = await as(372).get(`/chat/conversations/${jobConv}/messages`);
    const withAtt = r.body.messages.find(m => (m.attachments || []).length === 2);
    ok(withAtt && withAtt.attachments.every(a => a.type === 'image' && a.file_path && /uploads/.test(a.file_path)),
       'attachments: read back with type=image + file_path');
    r = await as(74).get('/chat/conversations');
    ok(r.body.conversations.find(c => c.id === jobConv).last_message_preview === '📷 Photo',
       'attachments: list preview shows "📷 Photo" for a photo-only message');

    // 9) message reactions (tapbacks) — toggle semantics + validation + read-back
    await mig.ensureChatReactionsTable(conn);
    // 74 reacts 👍 on the job message
    r = await as(74).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '👍' });
    ok(r.status === 200 && r.body.reactions.length === 1 && r.body.reactions[0].emoji === '👍', 'react: 👍 added');
    // 372 reacts ❤️ on the same message → two reactions
    r = await as(372).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '❤️' });
    ok(r.status === 200 && r.body.reactions.length === 2, 'react: a second member adds a different emoji');
    // 74 taps 👍 again → removed (toggle off) → back to one
    r = await as(74).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '👍' });
    ok(r.body.reactions.length === 1 && r.body.reactions[0].user_id === 372, 'react: same emoji toggles off');
    // 372 switches ❤️ → 🔥 (replace, still one per user)
    r = await as(372).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '🔥' });
    ok(r.body.reactions.length === 1 && r.body.reactions[0].emoji === '🔥', 'react: different emoji replaces (one per user)');
    // invalid emoji rejected
    r = await as(74).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '💩' });
    ok(r.status === 400, 'react: emoji outside the allow-list is refused (400)');
    // reactions come back on message read
    r = await as(372).get(`/chat/conversations/${jobConv}/messages`);
    const reactedMsg = r.body.messages.find((m) => m.id === msgId);
    ok(reactedMsg && (reactedMsg.reactions || []).some((x) => x.emoji === '🔥'), 'react: reactions included in getMessages');
    // non-member cannot react
    r = await as(360).post(`/chat/conversations/${jobConv}/messages/${msgId}/react`).send({ emoji: '👍' });
    ok(r.status === 403, 'react: non-member refused (403)');

    // 10) 2-minute message editing
    r = await as(74).post(`/chat/conversations/${grpConv}/messages`).send({ body: 'ontheway' });
    const editId = r.body.message.id;
    r = await as(74).patch(`/chat/conversations/${grpConv}/messages/${editId}`).send({ body: 'On the way — 10 min' });
    ok(r.status === 200 && r.body.message.body === 'On the way — 10 min' && r.body.message.edited_at, 'edit: own message updated within window (edited_at set)');
    r = await as(372).get(`/chat/conversations/${grpConv}/messages`);
    const em = r.body.messages.find((m) => m.id === editId);
    ok(em && em.body === 'On the way — 10 min' && em.edited_at, 'edit: read-back shows new body + edited_at');
    r = await as(372).patch(`/chat/conversations/${grpConv}/messages/${editId}`).send({ body: 'hijack' });
    ok(r.status === 403, "edit: another member can't edit someone else's message (403)");
    r = await as(74).patch(`/chat/conversations/${grpConv}/messages/${editId}`).send({ body: '   ' });
    ok(r.status === 400, 'edit: empty body rejected (400)');

    // 11) owner-only permanent chat deletion (+ list is_owner flag)
    r = await as(74).get('/chat/conversations');
    ok(r.body.conversations.find((c) => c.id === grpConv).is_owner === true, 'delete: creator sees is_owner=true on their group');
    ok(r.body.conversations.find((c) => c.id === jobConv).is_owner === true, 'delete: owner sees is_owner=true on the job chat');
    r = await as(372).get('/chat/conversations');
    ok(r.body.conversations.find((c) => c.id === grpConv).is_owner === false, 'delete: a non-owner member sees is_owner=false');
    // non-owner cannot delete
    r = await as(372).delete(`/chat/conversations/${grpConv}`);
    ok(r.status === 403, 'delete: non-owner is refused (403)');
    // a referenced upload file (in job_documents) must survive the delete
    await conn.query("INSERT INTO job_documents (path, name, job_id, type) VALUES ('/uploads/site-a.jpg','site-a.jpg',100,'photo')");
    // owner deletes the group → gone for everyone
    r = await as(74).delete(`/chat/conversations/${grpConv}`);
    ok(r.status === 200, 'delete: owner deletes the custom group (200)');
    const gone = (await conn.query('SELECT COUNT(*) n FROM chat_conversations WHERE id=?', [grpConv]))[0][0].n;
    const msgsGone = (await conn.query('SELECT COUNT(*) n FROM chat_messages WHERE conversation_id=?', [grpConv]))[0][0].n;
    const memGone = (await conn.query('SELECT COUNT(*) n FROM chat_members WHERE conversation_id=?', [grpConv]))[0][0].n;
    ok(gone === 0 && msgsGone === 0 && memGone === 0, 'delete: conversation + messages + members all removed');
    r = await as(372).get('/chat/conversations');
    ok(!r.body.conversations.some((c) => c.id === grpConv), 'delete: the deleted group no longer lists for other members');
    // owner deletes the JOB chat (which had photo attachments) — file shared with job_documents is kept
    r = await as(74).delete(`/chat/conversations/${jobConv}`);
    ok(r.status === 200, 'delete: owner can also delete a job chat (200)');
    const attGone = (await conn.query('SELECT COUNT(*) n FROM chat_message_attachments WHERE conversation_id=?', [jobConv]))[0][0].n;
    const jdKept = (await conn.query("SELECT COUNT(*) n FROM job_documents WHERE path='/uploads/site-a.jpg'"))[0][0].n;
    ok(attGone === 0 && jdKept === 1, 'delete: chat attachments removed but the job-library file row is preserved');

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
