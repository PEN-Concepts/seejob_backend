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
    "INSERT INTO chat_conversations (type, dm_key, created_by, last_message_at, created_at) VALUES ('direct', ?, ?, NOW(), NOW())",
    [dmKey, aId]
  );
  await addMember(c, res.insertId, aId, "member");
  await addMember(c, res.insertId, bId, "member");
  return res.insertId;
}

/** Create a custom group chat (2+ people) with a name. Creator = owner. Sorts to
 *  the top of the list (last_message_at = now). */
async function createGroup(conn, creatorId, name, userIds) {
  const c = conn || pool;
  const [res] = await c.query(
    "INSERT INTO chat_conversations (type, title, created_by, owner_id, last_message_at, created_at) VALUES ('group', ?, ?, ?, NOW(), NOW())",
    [String(name).slice(0, 160), creatorId, creatorId]
  );
  const convId = res.insertId;
  await addMember(c, convId, creatorId, "owner");
  for (const uid of Array.isArray(userIds) ? userIds : []) {
    if (Number(uid) && Number(uid) !== Number(creatorId)) await addMember(c, convId, uid, "member");
  }
  return convId;
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
            j.name AS job_name, j.color AS job_color, j.status AS job_status,
            l.lead_name AS lead_name, l.bid_status AS lead_bid_status,
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
    // Normalized status (matches the Jobs page rowStatus rule) for the list filter.
    let status = "direct";
    if (r.type === "job") {
      name = r.job_name || "Job"; accent = r.job_color || null;
      status = Number(r.job_status) === 1 ? "active" : "completed";
    } else if (r.type === "lead") {
      name = r.lead_name || "Lead"; accent = LEAD_GREY;
      status = String(r.lead_bid_status || "").toLowerCase() === "archived" ? "archived" : "lead";
    } else if (r.type === "group") {
      name = r.title || "Group"; accent = "#5c6570"; status = "group";
    } else {
      // direct → the OTHER member's name
      const [[other]] = await pool.query(
        `SELECT u.name, u.business AS business_name FROM chat_members m JOIN \`user\` u ON u.id = m.user_id
          WHERE m.conversation_id = ? AND m.user_id <> ? LIMIT 1`,
        [r.id, userId]
      );
      name = (other && (other.business_name || other.name)) || "Direct message";
    }
    out.push({
      id: r.id, type: r.type, job_id: r.job_id, lead_id: r.lead_id, status,
      name, accent, last_message_at: r.last_message_at,
      last_message_preview: r.last_message_preview, unread: Number(r.unread) || 0,
      members: [], member_count: 0,
    });
  }
  // Attach member avatars (id + name for initials) — up to 3 shown + a total count.
  const ids = out.map((o) => o.id);
  if (ids.length) {
    const [mem] = await pool.query(
      `SELECT m.conversation_id, m.user_id, u.name, u.business AS business_name
         FROM chat_members m JOIN \`user\` u ON u.id = m.user_id
        WHERE m.conversation_id IN (${ids.map(() => "?").join(",")})
        ORDER BY m.conversation_id, (m.role='owner') DESC, m.id`,
      ids
    );
    const byConv = {};
    for (const r of mem) {
      (byConv[r.conversation_id] = byConv[r.conversation_id] || []).push({ user_id: r.user_id, name: r.business_name || r.name });
    }
    for (const o of out) {
      const list = byConv[o.id] || [];
      o.member_count = list.length;
      o.members = list.slice(0, 3);
    }
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
  let rxByMsg = {};
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const [atts] = await pool.query(
      `SELECT id, message_id, type, file_path, file_name, url FROM chat_message_attachments
        WHERE message_id IN (${ph})`,
      ids
    );
    for (const a of atts) { (attByMsg[a.message_id] = attByMsg[a.message_id] || []).push(a); }
    const [rx] = await pool.query(
      `SELECT message_id, user_id, emoji FROM chat_message_reactions WHERE message_id IN (${ph})`,
      ids
    ).catch(() => [[]]); // table may not exist yet on a very old DB → no reactions
    for (const r of (rx || [])) { (rxByMsg[r.message_id] = rxByMsg[r.message_id] || []).push({ user_id: r.user_id, emoji: r.emoji }); }
  }
  return rows.reverse().map((r) => ({
    id: r.id, conversation_id: r.conversation_id, sender_id: r.sender_id,
    sender_name: r.sender_business || r.sender_name, body: r.body,
    created_at: r.created_at, attachments: attByMsg[r.id] || [], reactions: rxByMsg[r.id] || [],
  }));
}

// Allowed quick-react emoji (validated server-side so only these are stored).
const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "👏", "🔥", "👎"];

/** Toggle a user's reaction on a message (one per user): same emoji removes it,
 *  a different emoji replaces it, none adds it. Returns the message's full
 *  reaction list and live-emits `chat:reaction` to every member. */
async function reactToMessage({ conversationId, messageId, userId, emoji }) {
  if (!REACTION_EMOJI.includes(String(emoji))) return null;
  const [[msg]] = await pool.query(
    "SELECT id FROM chat_messages WHERE id = ? AND conversation_id = ? LIMIT 1",
    [messageId, conversationId]
  );
  if (!msg) return null;
  const [[existing]] = await pool.query(
    "SELECT id, emoji FROM chat_message_reactions WHERE message_id = ? AND user_id = ? LIMIT 1",
    [messageId, userId]
  );
  if (existing) {
    if (existing.emoji === emoji) {
      await pool.query("DELETE FROM chat_message_reactions WHERE id = ?", [existing.id]);
    } else {
      await pool.query("UPDATE chat_message_reactions SET emoji = ?, created_at = NOW() WHERE id = ?", [emoji, existing.id]);
    }
  } else {
    await pool.query(
      "INSERT INTO chat_message_reactions (message_id, conversation_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, NOW())",
      [messageId, conversationId, userId, emoji]
    );
  }
  const [reactions] = await pool.query(
    "SELECT user_id, emoji FROM chat_message_reactions WHERE message_id = ?",
    [messageId]
  );
  const payload = { conversation_id: Number(conversationId), message_id: Number(messageId), reactions };
  const [members] = await pool.query("SELECT user_id FROM chat_members WHERE conversation_id = ?", [conversationId]);
  for (const m of members) realtime.emitToUser(Number(m.user_id), "chat:reaction", payload);
  return reactions;
}

async function conversationDisplayName(conversationId, forUserId) {
  const [[c]] = await pool.query(
    `SELECT c.type, c.title, j.name AS job_name, l.lead_name FROM chat_conversations c
       LEFT JOIN job j ON c.type='job' AND j.id=c.job_id
       LEFT JOIN leads l ON c.type='lead' AND l.id=c.lead_id WHERE c.id=? LIMIT 1`,
    [conversationId]
  );
  if (!c) return "Chat";
  if (c.type === "job") return c.job_name || "Job";
  if (c.type === "lead") return c.lead_name || "Lead";
  if (c.type === "group") return c.title || "Group";
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
  getOrCreateJobConversation, getOrCreateLeadConversation, getOrCreateDirect, createGroup, migrateLeadChatToJob,
  listMyConversations, totalUnread, getMessages, postMessage, markRead, reactToMessage,
};
