/* Chat Files/Pictures — functional integration test (real local MySQL via
 * mysql-memory-server). Runs the ACTUAL boot migration (ensureChatFilesColumns)
 * and the ACTUAL chat.js service functions against a real DB. NO real data.
 *
 * Verifies the shared-record model end to end:
 *   - migration adds job_document_id + can_edit_photo and makes message_id nullable;
 *   - fresh upload posts a thread message (message_id set) + creates a shared job_documents row;
 *   - pull-from-job is Files-panel only (message_id NULL, NO new thread message);
 *   - rename from the chat side updates the shared job_documents row (shows everywhere);
 *   - rename from the job Documents side (the route's two statements) updates linked attachments;
 *   - detach removes only the attachment — the job_documents row survives;
 *   - avatar edit gate: creator allowed, granted member allowed, non-granted member blocked,
 *     and only the creator may grant;
 *   - settings update is creator-only.
 * Run: node test/chatFiles.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  → ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_chatfiles_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // Silence delivery side-effects (socket + FCM) so postMessage is DB-only.
    const realtime = require('../services/realtime');
    realtime.emitToUser = () => {};
    realtime.isUserOnline = () => true;   // "online" → never calls notify.sendPushToUser
    const notify = require('../services/notify');
    notify.sendPushToUser = () => Promise.resolve();

    // ---- Schema: PRE-migration shapes (deliberately missing the new columns) ----
    await conn.query(`CREATE TABLE \`user\` (id INT PRIMARY KEY, name VARCHAR(150), business VARCHAR(190) NULL)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), created_by INT NULL, color VARCHAR(20) NULL)`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(190) NULL)`);
    await conn.query(`CREATE TABLE chat_conversations (id INT PRIMARY KEY AUTO_INCREMENT, type VARCHAR(20), title VARCHAR(190) NULL, job_id INT NULL, lead_id INT NULL, created_by INT NULL, icon_url VARCHAR(255) NULL, last_message_at DATETIME NULL, last_message_preview VARCHAR(255) NULL)`);
    // chat_members WITHOUT can_edit_photo (migration must add it)
    await conn.query(`CREATE TABLE chat_members (id INT PRIMARY KEY AUTO_INCREMENT, conversation_id INT, user_id INT, role VARCHAR(20) DEFAULT 'member', joined_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE chat_messages (id INT PRIMARY KEY AUTO_INCREMENT, conversation_id INT, sender_id INT, body TEXT NULL, created_at DATETIME NULL, edited_at DATETIME NULL)`);
    // chat_message_attachments WITHOUT job_document_id and with message_id NOT NULL (migration must add + relax)
    await conn.query(`CREATE TABLE chat_message_attachments (id INT PRIMARY KEY AUTO_INCREMENT, message_id INT NOT NULL, conversation_id INT, type VARCHAR(20), file_path VARCHAR(255) NULL, file_name VARCHAR(255) NULL, mime_type VARCHAR(120) NULL, url VARCHAR(255) NULL, uploaded_by INT NULL, created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE chat_message_reactions (id INT PRIMARY KEY AUTO_INCREMENT, message_id INT, conversation_id INT, user_id INT, emoji VARCHAR(16), created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE job_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(255), job_id INT NULL, mime_type VARCHAR(120) NULL, created_by INT NULL, created_at DATETIME NULL, type VARCHAR(30) NULL, is_shared TINYINT(1) NOT NULL DEFAULT 0)`);

    // ---- Seed ----
    // 1 = owner/creator, 2 = member (will be granted photo edit), 3 = plain member, 9 = outsider (not a member)
    await conn.query(`INSERT INTO \`user\` (id,name,business) VALUES (1,'Owner','Oak Coast'),(2,'Foreman Fran',NULL),(3,'Laborer Lou',NULL),(9,'Outsider Odis',NULL)`);
    await conn.query(`INSERT INTO job (id,name,created_by,color) VALUES (10,'145 Office/Shop',1,'#d4a017')`);
    // A job chat created by user 1, attached to job 10.
    const [convRes] = await conn.query(`INSERT INTO chat_conversations (type,title,job_id,created_by) VALUES ('job','145 Office/Shop',10,1)`);
    const convId = convRes.insertId;
    await conn.query(`INSERT INTO chat_members (conversation_id,user_id,role,joined_at) VALUES (?,1,'owner',NOW()),(?,2,'member',NOW()),(?,3,'member',NOW())`, [convId, convId, convId]);
    // A pre-existing job document (not yet in the chat) — the pull-from-job target.
    const [docRes] = await conn.query(`INSERT INTO job_documents (path,name,job_id,mime_type,created_by,created_at,type,is_shared) VALUES ('/uploads/plan-A.pdf','Plan A',10,'application/pdf',1,NOW(),'document',0)`);
    const jobDocId = docRes.insertId;

    // ================= 1. Migration =================
    const { ensureChatFilesColumns } = require('../services/dbMigrations');
    await ensureChatFilesColumns(conn);
    const [[jd]] = await conn.query(`SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_message_attachments' AND COLUMN_NAME='job_document_id'`);
    ok(!!jd, 'migration added chat_message_attachments.job_document_id');
    const [[mid]] = await conn.query(`SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_message_attachments' AND COLUMN_NAME='message_id'`);
    ok(mid && mid.IS_NULLABLE === 'YES', 'migration relaxed message_id to NULLable', mid && mid.IS_NULLABLE);
    const [[cep]] = await conn.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_members' AND COLUMN_NAME='can_edit_photo'`);
    ok(!!cep, 'migration added chat_members.can_edit_photo');

    // Service loads AFTER the pool env is set.
    const chat = require('../services/chat');

    const msgCount = async () => { const [[r]] = await conn.query('SELECT COUNT(*) n FROM chat_messages WHERE conversation_id=?', [convId]); return r.n; };

    // ================= 2. Fresh upload → posts to thread =================
    const before = await msgCount();
    const up = await chat.addUploadedFilesToChat({
      conversationId: convId, senderId: 1,
      files: [{ file_path: '/uploads/fresh-photo.jpg', file_name: 'fresh-photo.jpg', mime_type: 'image/jpeg' }],
      titles: ['Site photo 1'],
    });
    const after = await msgCount();
    ok(after === before + 1, 'fresh upload POSTED a thread message', `before=${before} after=${after}`);
    ok(up && up.count === 1, 'fresh upload reported count=1');
    const [[freshAtt]] = await conn.query(`SELECT * FROM chat_message_attachments WHERE file_path='/uploads/fresh-photo.jpg' LIMIT 1`);
    ok(freshAtt && freshAtt.message_id != null, 'fresh upload attachment has message_id SET (in thread)');
    ok(freshAtt && freshAtt.job_document_id != null, 'fresh upload created a linked shared job_documents row');
    ok(freshAtt && freshAtt.file_name === 'Site photo 1', 'fresh upload used the supplied title', freshAtt && freshAtt.file_name);
    const [[freshDoc]] = await conn.query('SELECT * FROM job_documents WHERE id=?', [freshAtt.job_document_id]);
    ok(freshDoc && freshDoc.job_id === 10 && freshDoc.type === 'photo', 'shared job_documents row filed under the job as a photo', freshDoc && freshDoc.type);

    // ================= 3. Pull-from-job → Files-panel only (no thread message) =================
    const beforePull = await msgCount();
    const pull = await chat.attachJobDocsToChat({ conversationId: convId, userId: 2, items: [{ job_document_id: jobDocId, title: 'Plan A (rev)' }] });
    const afterPull = await msgCount();
    ok(afterPull === beforePull, 'pull-from-job did NOT post a thread message', `before=${beforePull} after=${afterPull}`);
    ok(pull && pull.count === 1, 'pull reported count=1');
    const [[pullAtt]] = await conn.query('SELECT * FROM chat_message_attachments WHERE job_document_id=? ORDER BY id DESC LIMIT 1', [jobDocId]);
    ok(pullAtt && pullAtt.message_id === null, 'pulled attachment has message_id NULL (panel-only)', pullAtt && String(pullAtt.message_id));
    ok(pullAtt && pullAtt.job_document_id === jobDocId, 'pulled attachment points at the existing job_documents row');
    const [[docAfterPull]] = await conn.query('SELECT name FROM job_documents WHERE id=?', [jobDocId]);
    ok(docAfterPull && docAfterPull.name === 'Plan A (rev)', 'pull applied the edited title to the shared record', docAfterPull && docAfterPull.name);

    // ================= 4. Rename from the CHAT side → updates shared job record =================
    await chat.renameChatFile({ conversationId: convId, attachmentId: pullAtt.id, name: 'Plan A FINAL' });
    const [[docAfterChatRename]] = await conn.query('SELECT name FROM job_documents WHERE id=?', [jobDocId]);
    const [[attAfterChatRename]] = await conn.query('SELECT file_name FROM chat_message_attachments WHERE id=?', [pullAtt.id]);
    ok(docAfterChatRename.name === 'Plan A FINAL', 'chat-side rename updated the shared job_documents.name', docAfterChatRename.name);
    ok(attAfterChatRename.file_name === 'Plan A FINAL', 'chat-side rename updated the attachment display name', attAfterChatRename.file_name);

    // ================= 5. Rename from the JOB Documents side → propagates to chat =================
    // These are the exact two statements routes/jobs.js PATCH /job-file/:id/rename runs after its owner check.
    await conn.query('UPDATE job_documents SET name = ? WHERE id = ?', ['Plan A v3', jobDocId]);
    await conn.query('UPDATE chat_message_attachments SET file_name = ? WHERE job_document_id = ?', ['Plan A v3', jobDocId]);
    const [[attAfterJobRename]] = await conn.query('SELECT file_name FROM chat_message_attachments WHERE id=?', [pullAtt.id]);
    ok(attAfterJobRename.file_name === 'Plan A v3', 'job-side rename propagated to the linked chat attachment', attAfterJobRename.file_name);
    // And listConversationFiles surfaces the shared name for linked rows.
    const listed = await chat.listConversationFiles(convId);
    const listedPull = listed.find((f) => f.id === pullAtt.id);
    ok(listedPull && listedPull.name === 'Plan A v3', 'listConversationFiles shows the shared (job) name for linked files', listedPull && listedPull.name);
    ok(listedPull && listedPull.kind === 'file', 'a PDF lists as kind=file');
    const listedFresh = listed.find((f) => f.id === freshAtt.id);
    ok(listedFresh && listedFresh.kind === 'image', 'a JPEG lists as kind=image');

    // ================= 6. Detach → attachment gone, job_documents row SURVIVES =================
    await chat.detachChatFile({ conversationId: convId, attachmentId: pullAtt.id });
    const [[goneAtt]] = await conn.query('SELECT id FROM chat_message_attachments WHERE id=?', [pullAtt.id]);
    ok(!goneAtt, 'detach removed the chat attachment');
    const [[survDoc]] = await conn.query('SELECT id, name FROM job_documents WHERE id=?', [jobDocId]);
    ok(survDoc && survDoc.name === 'Plan A v3', 'detach PRESERVED the underlying job_documents row (never deletes the job file)');

    // ================= 7. Avatar edit-permission gate =================
    const r1 = await chat.setConversationIcon({ conversationId: convId, userId: 1, iconPath: '/uploads/ic1.png' });
    ok(r1 && r1.icon_url === '/uploads/ic1.png' && !r1.error, 'creator CAN set the chat photo');
    const r3 = await chat.setConversationIcon({ conversationId: convId, userId: 3, iconPath: '/uploads/ic3.png' });
    ok(r3 && r3.error === 'forbidden', 'non-granted member is BLOCKED from setting the photo', r3 && JSON.stringify(r3));
    // A non-creator cannot grant.
    const gNon = await chat.setMemberPhotoGrant({ conversationId: convId, userId: 2, memberId: 3, canEdit: true });
    ok(gNon && gNon.error === 'forbidden', 'a non-creator CANNOT grant photo-edit');
    // Creator grants member 3.
    const gYes = await chat.setMemberPhotoGrant({ conversationId: convId, userId: 1, memberId: 3, canEdit: true });
    ok(gYes && gYes.ok, 'creator can grant photo-edit to a member');
    const r3b = await chat.setConversationIcon({ conversationId: convId, userId: 3, iconPath: '/uploads/ic3b.png' });
    ok(r3b && r3b.icon_url === '/uploads/ic3b.png' && !r3b.error, 'granted member CAN now set the photo');
    // Revoke → blocked again.
    await chat.setMemberPhotoGrant({ conversationId: convId, userId: 1, memberId: 3, canEdit: false });
    const r3c = await chat.setConversationIcon({ conversationId: convId, userId: 3, iconPath: '/uploads/ic3c.png' });
    ok(r3c && r3c.error === 'forbidden', 'revoked member is blocked again');

    // ================= 8. Settings update is creator-only =================
    const sOwner = await chat.updateConversationSettings({ conversationId: convId, userId: 1, name: 'Renamed Group' });
    ok(sOwner && sOwner.ok, 'creator can update settings (rename)');
    const [[cName]] = await conn.query('SELECT title FROM chat_conversations WHERE id=?', [convId]);
    ok(cName.title === 'Renamed Group', 'settings rename persisted', cName.title);
    const sMember = await chat.updateConversationSettings({ conversationId: convId, userId: 2, name: 'Hijacked' });
    ok(sMember && sMember.error === 'forbidden', 'a non-creator CANNOT update settings');

  } catch (e) {
    fail++; rec.push('  ✗ EXCEPTION: ' + (e && e.stack || e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }

  console.log('\n==== Chat Files/Pictures functional test ====');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
