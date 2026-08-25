/* Chat duplicate fix (lead→job) — on in-memory MySQL. Proves:
 *  - backfill does NOT create a chat for a CONVERTED lead (status=3),
 *  - the merge migration collapses an existing lead+job chat pair to ONE (the job
 *    chat), MOVING the lead chat's messages (nothing lost) + deleting the lead chat,
 *  - migrateLeadChatToJob re-points a lone lead chat to the job.
 * Run: node test/verify-chat-dedupe.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.NODE_ENV = 'test';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_chat_dedupe', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), created_by INT, status TINYINT DEFAULT 1, color VARCHAR(9) NULL, lead_id INT NULL, from_leads TINYINT DEFAULT 0)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(120), user_id INT, status VARCHAR(4) NULL)');
    await conn.query('CREATE TABLE job_contacts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, job_id INT, contact_id INT)');
    await conn.query("INSERT INTO `user`(id,name) VALUES (74,'Owner')");

    const mig = require('../services/dbMigrations');
    const chat = require('../services/chat');
    await mig.ensureChatTables(conn);

    // --- backfill skips converted leads ---
    await conn.query("INSERT INTO leads (id,lead_name,user_id,status) VALUES (500,'Mann ADU',74,'3'),(501,'Active Lead',74,'1')");
    await conn.query("INSERT INTO job (id,name,created_by,status,lead_id,from_leads) VALUES (600,'Mann ADU',74,1,500,1)");
    await mig.ensureChatBackfill(conn);
    const leadConvs = (await conn.query("SELECT lead_id FROM chat_conversations WHERE type='lead'"))[0].map(r => r.lead_id);
    ok(!leadConvs.includes(500), 'backfill: NO chat for the converted lead 500 (status 3)');
    ok(leadConvs.includes(501), 'backfill: active lead 501 still gets a chat');
    ok((await conn.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=600"))[0].length === 1, 'backfill: the converted job 600 has exactly one chat');

    // --- merge: simulate a pre-fix duplicate (a lead chat exists for 500 too) with a message ---
    const [lc] = await conn.query("INSERT INTO chat_conversations (type, lead_id, created_by) VALUES ('lead', 500, 74)");
    const leadConvId = lc.insertId;
    await conn.query('INSERT IGNORE INTO chat_members (conversation_id,user_id,role) VALUES (?,74,?)', [leadConvId, 'owner']);
    await conn.query("INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES (?,74,'msg on the old lead chat')", [leadConvId]);
    // now there are TWO chats for Mann ADU (lead 500 + job 600)
    ok((await conn.query("SELECT id FROM chat_conversations WHERE lead_id=500 OR job_id=600"))[0].length === 2, 'setup: duplicate lead+job chats exist for Mann ADU');

    await mig.ensureChatMergeConvertedLeadChats(conn);
    const jobConvId = (await conn.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=600"))[0][0].id;
    ok((await conn.query("SELECT id FROM chat_conversations WHERE lead_id=500"))[0].length === 0, 'merge: the redundant lead chat is gone');
    ok((await conn.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=600"))[0].length === 1, 'merge: exactly one chat remains for the job');
    const moved = (await conn.query("SELECT body FROM chat_messages WHERE conversation_id=?", [jobConvId]))[0];
    ok(moved.some(m => m.body === 'msg on the old lead chat'), 'merge: the old lead-chat message was PRESERVED (moved to the job chat)');

    // --- migrateLeadChatToJob re-points a lone lead chat (future conversion path) ---
    await conn.query("INSERT INTO leads (id,lead_name,user_id,status) VALUES (700,'Fresh Lead',74,'1')");
    await conn.query("INSERT INTO chat_conversations (type, lead_id, created_by) VALUES ('lead', 700, 74)");
    await conn.query("INSERT INTO job (id,name,created_by,status,lead_id,from_leads) VALUES (800,'Fresh Lead',74,1,700,1)");
    await chat.migrateLeadChatToJob(conn, 700, 800);
    ok((await conn.query("SELECT id FROM chat_conversations WHERE type='lead' AND lead_id=700"))[0].length === 0, 're-point: lead 700 chat no longer typed as lead');
    ok((await conn.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=800"))[0].length === 1, 're-point: it now belongs to job 800 (no duplicate created)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
