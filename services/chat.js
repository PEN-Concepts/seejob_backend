// Chat business logic — conversations (job/lead group + 1:1 direct), messages,
// membership, and delivery (Socket.IO to online members + FCM to offline ones).
// Kept transport-agnostic: routes call these; realtime/notify handle delivery.
const pool = require("../config/connection");
const realtime = require("./realtime");
const notify = require("./notify");

const LEAD_GREY = "#6f7a86"; // leads render grey (no stored job.color)

const db = () => pool;

// ---- membership / auth ----
async function isMember(conn, conversationId, userId) {
  const [[row]] = await (conn || pool).query(
    "SELECT id FROM chat_members WHERE conversation_id = ? AND user_id = ? LIMIT 1",
    [conversationId, userId]
  );
  return !!row;
}

async function addMember(conn, conversationId, userId, role = "member") {
  await (conn || pool).query(
    "INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, NOW())",
    [conversationId, userId, role]
  );
}

async function removeMember(conn, conversationId, userId) {
  // Never remove the owner/creator.
  await (conn || pool).query(
    "DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ? AND role <> 'owner'",
    [conversationId, userId]
  );
}

// ---- conversation resolution / creation ----
async function getOrCreateJobConversation(conn, jobId, actorId) {
  const c = conn || pool;
  const [[job]] = await c.query("SELECT id, created_by FROM job WHERE id = ? LIMIT 1", [jobId]);
  if (!job) return null;
  const [[existing]] = await c.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id = ? LIMIT 1", [jobId]);
  if (existing) return existing.id;
  const [[owner]] = await c.query("SELECT created_by FROM `user` WHERE id = ? LIMIT 1", [job.created_by]);
  const ownerRoot = (owner && owner.created_by) || job.created_by;
  const [res] = await c.query(
    "INSERT INTO chat_conversations (type, job_id, owner_id, created_by, created_at) VALUES ('job', ?, ?, ?, NOW())",
    [jobId, ownerRoot, job.created_by]
  );
  const convId = res.insertId;
  await addMember(c, convId, job.created_by, "owner");
  // seed existing job contacts
  await c.query(
    `INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at)
       SELECT ?, contact_id, 'member', NOW() FROM job_contacts WHERE job_id = ? AND contact_id IS NOT NULL`,
    [convId, jobId]
  );
  return convId;
}

async function getOrCreateLeadConversation(conn, leadId) {
  const c = conn || pool;
  const [[lead]] = await c.query("SELECT id, user_id FROM leads WHERE id = ? LIMIT 1", [leadId]);
  if (!lead) return null;
  const [[existing]] = await c.query("SELECT id FROM chat_conversations WHERE type='lead' AND lead_id = ? LIMIT 1", [leadId]);
  if (existing) return existing.id;
  const [[owner]] = await c.query("SELECT created_by FROM `user` WHERE id = ? LIMIT 1", [lead.user_id]);
  const ownerRoot = (owner && owner.created_by) || lead.user_id;
  const [res] = await c.query(
    "INSERT INTO chat_conversations (type, lead_id, owner_id, created_by, created_at) VALUES ('lead', ?, ?, ?, NOW())",
    [leadId, ownerRoot, lead.user_id]
  );
  await addMember(c, res.insertId, lead.user_id, "owner");
  return res.insertId;
}

/** Resolve (or create) the single canonical 1:1 conversation between two users. */
async function getOrCreateDirect(conn, aId, bId) {
  const c = conn || pool;
  const lo = Math.min(Number(aId), Number(bId));
  const hi = Math.max(Number(aId), Number(bId));
  if (!lo || !hi || lo === hi) return null;
  const dmKey = `${lo}_${hi}`;
  const [[existing]] = await c.query("SELECT id FROM chat_conversations WHERE dm_key = ? LIMIT 1", [dmKey]);
  if (existing) return existing.id;
  const [res] = await c.query(
    "INSERT INTO chat_conversations (type, dm_key, created_by, created_at) VALUES ('direct', ?, ?, NOW())",
    [dmKey, aId]
  );
  await addMember(c, res.insertId, aId, "member");
  await addMember(c, res.insertId, bId, "member");
  return res.insertId;
}

/** Lead→job conversion: hand the lead's existing chat to the new job so there's
 *  ONE chat per project (no lead+job duplicate). Re-points the lead conversation
 *  to the job, or merges into the job's chat if one already exists. */
async function migrateLeadChatToJob(conn, leadId, jobId) {
  const c = conn || pool;
  const [[leadConv]] = await c.query("SELECT id FROM chat_conversations WHERE type='lead' AND lead_id=? LIMIT 1", [leadId]);
  if (!leadConv) return;
  const [[jobConv]] = await c.query("SELECT id FROM chat_conversations WHERE type='job' AND job_id=? LIMIT 1", [jobId]);
  if (!jobConv) {
    await c.query("UPDATE chat_conversations SET type='job', job_id=?, lead_id=NULL WHERE id=?", [jobId, leadConv.id]);
    return;
  }
  await c.query('UPDATE chat_messages SET conversation_id=? WHERE conversation_id=?', [jobConv.id, leadConv.id]);
  await c.query('UPDATE chat_message_attachments SET conversation_id=? WHERE conversation_id=?', [jobConv.id, leadConv.id]);
  await c.query("INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at) SELECT ?, user_id, 'member', NOW() FROM chat_members WHERE conversation_id=?", [jobConv.id, leadConv.id]);
  await c.query('DELETE FROM chat_members WHERE conversation_id=?', [leadConv.id]);
  await c.query('DELETE FROM chat_conversations WHERE id=?', [leadConv.id]);
}

// ---- reads ----
/** My conversations, newest activity first, with unread count + display + accent. */
async function listMyConversations(userId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.type, c.job_id, c.lead_id, c.title, c.last_message_at, c.last_message_preview,
            j.name AS job_name, j.color AS job_color, l.lead_name AS lead_name,
            (SELECT COUNT(*) FROM chat_messages msg
               WHERE msg.conversation_id = c.id
                 AND msg.id > COALESCE(m.last_read_message_id, 0)
                 AND msg.sender_id <> ?) AS unread
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
       LEFT JOIN job j   ON c.type='job'  AND j.id = c.job_id
       LEFT JOIN leads l ON c.type='lead' AND l.id = c.lead_id
      WHERE m.user_id = ?
      ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, c.id DESC`,
    [userId, userId]
  );
  const out = [];
  for (const r of rows) {
    let name = r.title || "";
    let accent = null;
    if (r.type === "job") { name = r.job_name || "Job"; accent = r.job_color || null; }
    else if (r.type === "lead") { name = r.lead_name || "Lead"; accent = LEAD_GREY; }
    else {
      // direct → the OTHER member's name
      const [[other]] = await pool.query(
        `SELECT u.name, u.business AS business_name FROM chat_members m JOIN \`user\` u ON u.id = m.user_id
          WHERE m.conversation_id = ? AND m.user_id <> ? LIMIT 1`,
        [r.id, userId]
      );
      name = (other && (other.business_name || other.name)) || "Direct message";
    }
    out.push({
      id: r.id, type: r.type, job_id: r.job_id, lead_id: r.lead_id,
      name, accent, last_message_at: r.last_message_at,
      last_message_preview: r.last_message_preview, unread: Number(r.unread) || 0,
    });
  }
  return out;
}

async function totalUnread(userId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(x.unread),0) AS total FROM (
       SELECT (SELECT COUNT(*) FROM chat_messages msg
                 WHERE msg.conversation_id = m.conversation_id
                   AND msg.id > COALESCE(m.last_read_message_id,0)
                   AND msg.sender_id <> ?) AS unread
         FROM chat_members m WHERE m.user_id = ?
     ) x`,
    [userId, userId]
  );
  return Number(row.total) || 0;
}

async function getMessages(conversationId, { before, limit } = {}) {
  const lim = Math.min(Number(limit) || 50, 100);
  const params = [conversationId];
  let where = "msg.conversation_id = ?";
  if (before) { where += " AND msg.id < ?"; params.push(Number(before)); }
  const [rows] = await pool.query(
    `SELECT msg.id, msg.conversation_id, msg.sender_id, msg.body, msg.created_at,
            u.name AS sender_name, u.business AS sender_business
       FROM chat_messages msg JOIN \`user\` u ON u.id = msg.sender_id
      WHERE ${where}
      ORDER BY msg.id DESC LIMIT ${lim}`,
    params
  );
  const ids = rows.map((r) => r.id);
  let attByMsg = {};
  if (ids.length) {
    const [atts] = await pool.query(
      `SELECT id, message_id, type, file_path, file_name, url FROM chat_message_attachments
        WHERE message_id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    for (const a of atts) { (attByMsg[a.message_id] = attByMsg[a.message_id] || []).push(a); }
  }
  return rows.reverse().map((r) => ({
    id: r.id, conversation_id: r.conversation_id, sender_id: r.sender_id,
    sender_name: r.sender_business || r.sender_name, body: r.body,
    created_at: r.created_at, attachments: attByMsg[r.id] || [],
  }));
}

async function conversationDisplayName(conversationId, forUserId) {
  const [[c]] = await pool.query(
    `SELECT c.type, j.name AS job_name, l.lead_name FROM chat_conversations c
       LEFT JOIN job j ON c.type='job' AND j.id=c.job_id
       LEFT JOIN leads l ON c.type='lead' AND l.id=c.lead_id WHERE c.id=? LIMIT 1`,
    [conversationId]
  );
  if (!c) return "Chat";
  if (c.type === "job") return c.job_name || "Job";
  if (c.type === "lead") return c.lead_name || "Lead";
  const [[other]] = await pool.query(
    `SELECT u.name, u.business AS business_name FROM chat_members m JOIN \`user\` u ON u.id=m.user_id
      WHERE m.conversation_id=? AND m.user_id<>? LIMIT 1`,
    [conversationId, forUserId]
  );
  return (other && (other.business_name || other.name)) || "Direct message";
}

// ---- write + deliver ----
async function postMessage({ conversationId, senderId, body, attachments }) {
  const text = (body == null ? "" : String(body)).trim();
  const atts = Array.isArray(attachments) ? attachments : [];
  if (!text && !atts.length) return null;

  const [res] = await pool.query(
    "INSERT INTO chat_messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, NOW())",
    [conversationId, senderId, text || null]
  );
  const messageId = res.insertId;
  for (const a of atts) {
    await pool.query(
      `INSERT INTO chat_message_attachments (message_id, conversation_id, type, file_path, file_name, mime_type, url, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [messageId, conversationId, a.type || "file", a.file_path || null, a.file_name || null, a.mime_type || null, a.url || null, senderId]
    );
  }

  const preview = text ? text.slice(0, 180) : (atts.some((a) => a.type === "image") ? "📷 Photo" : "📎 Attachment");
  await pool.query(
    "UPDATE chat_conversations SET last_message_at = NOW(), last_message_preview = ? WHERE id = ?",
    [preview, conversationId]
  );

  // Build the full message payload (sender name + attachments).
  const [full] = await getMessages(conversationId, { before: messageId + 1, limit: 1 });
  const message = full || { id: messageId, conversation_id: conversationId, sender_id: senderId, body: text, attachments: atts };

  // Deliver: socket to online members, FCM to offline members (both except sender).
  const [members] = await pool.query("SELECT user_id FROM chat_members WHERE conversation_id = ?", [conversationId]);
  const senderName = message.sender_name || "";
  const convName = await conversationDisplayName(conversationId, senderId);
  for (const m of members) {
    const uid = Number(m.user_id);
    if (uid === Number(senderId)) { realtime.emitToUser(uid, "chat:message", message); continue; } // multi-device echo
    realtime.emitToUser(uid, "chat:message", message);
    if (!realtime.isUserOnline(uid)) {
      const pushBody = text ? `${senderName}: ${preview}` : `${senderName} sent a photo`;
      notify.sendPushToUser(pool, uid, {
        title: convName, body: pushBody, url: `chat/${conversationId}`, type: "chat", asNotification: true,
      }).catch(() => {});
    }
  }
  return message;
}

async function markRead(conversationId, userId, lastMessageId) {
  await pool.query(
    "UPDATE chat_members SET last_read_message_id = GREATEST(COALESCE(last_read_message_id,0), ?) WHERE conversation_id = ? AND user_id = ?",
    [Number(lastMessageId) || 0, conversationId, userId]
  );
}

module.exports = {
  db, isMember, addMember, removeMember,
  getOrCreateJobConversation, getOrCreateLeadConversation, getOrCreateDirect, migrateLeadChatToJob,
  listMyConversations, totalUnread, getMessages, postMessage, markRead,
};
