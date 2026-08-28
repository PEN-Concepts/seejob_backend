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
            c.owner_id, c.icon_url,
            (CASE WHEN ow.category = 1 AND ow.created_by IS NOT NULL THEN ow.created_by ELSE c.owner_id END) AS acct_owner,
            j.name AS job_name, j.color AS job_color, j.status AS job_status, j.created_by AS job_created_by,
            l.lead_name AS lead_name, l.bid_status AS lead_bid_status,
            (SELECT COUNT(*) FROM chat_messages msg
               WHERE msg.conversation_id = c.id
                 AND msg.id > COALESCE(m.last_read_message_id, 0)
                 AND msg.sender_id <> ?) AS unread
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
       LEFT JOIN job j   ON c.type='job'  AND j.id = c.job_id
       LEFT JOIN leads l ON c.type='lead' AND l.id = c.lead_id
       LEFT JOIN \`user\` ow ON ow.id = c.owner_id
      WHERE m.user_id = ?
      ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, c.id DESC`,
    [userId, userId]
  );
  // GC-assigned override (Part C): a JOB chat whose job was created OUTSIDE the viewer's
  // account (a GC assigned it to this sub) shows the reserved orange accent instead of
  // the job's palette colour. Employees fold into the owner's account so they're not
  // flagged. Leads unaffected.
  const access = require("../utils/access");
  const { RESERVED_GC_COLOR } = require("./jobColorPalette");
  const viewerOwner = Number(await access.resolveOwnerId(Number(userId))) || Number(userId);
  const out = [];
  for (const r of rows) {
    let name = r.title || "";
    let accent = null;
    // Normalized status (matches the Jobs page rowStatus rule) for the list filter.
    let status = "direct";
    if (r.type === "job") {
      name = r.job_name || "Job";
      const cb = Number(r.job_created_by || 0);
      const gcAssigned = cb && cb !== Number(userId) && cb !== viewerOwner;
      accent = gcAssigned ? RESERVED_GC_COLOR : (r.job_color || null);
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
      // is_owner = the ACCOUNT owner (the boss) of this chat's account → gates
      // deletion for ALL chat types (an employee who starts a group is NOT the boss).
      is_owner: Number(r.acct_owner) === Number(userId),
      icon_url: r.icon_url || null,
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
    `SELECT msg.id, msg.conversation_id, msg.sender_id, msg.body, msg.created_at, msg.edited_at,
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
    created_at: r.created_at, edited_at: r.edited_at || null,
    attachments: attByMsg[r.id] || [], reactions: rxByMsg[r.id] || [],
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
      `INSERT INTO chat_message_attachments (message_id, conversation_id, type, file_path, file_name, mime_type, url, job_document_id, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [messageId, conversationId, a.type || "file", a.file_path || null, a.file_name || null, a.mime_type || null, a.url || null, a.job_document_id || null, senderId]
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
      // DATA-ONLY (no asNotification): a hybrid notification+data payload made the
      // browser auto-display the notification block AND the SW's onBackgroundMessage
      // display the data → TWO notifications per message. Data-only shows exactly one
      // (via the SW), matching the non-duplicating schedule/reminder path. `url` is
      // the real thread route so the SW can deep-link into THIS conversation.
      notify.sendPushToUser(pool, uid, {
        title: convName, body: pushBody, url: `m/chat/${conversationId}`, type: "chat",
      }).catch(() => {});
    }
  }
  return message;
}

// Edit your own message within a 2-minute window (age computed in SQL to avoid
// any app/DB timezone skew). Returns {error} or the edited payload; live-emits
// `chat:message-edit` to all members.
const EDIT_WINDOW_SECONDS = 120;
async function editMessage({ conversationId, messageId, userId, body }) {
  const text = (body == null ? "" : String(body)).trim();
  if (!text) return { error: "empty" };
  const [[msg]] = await pool.query(
    "SELECT sender_id, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM chat_messages WHERE id = ? AND conversation_id = ? LIMIT 1",
    [messageId, conversationId]
  );
  if (!msg) return { error: "notfound" };
  if (Number(msg.sender_id) !== Number(userId)) return { error: "forbidden" };
  if (Number(msg.age) > EDIT_WINDOW_SECONDS) return { error: "expired" };
  await pool.query("UPDATE chat_messages SET body = ?, edited_at = NOW() WHERE id = ?", [text, messageId]);
  const [[row]] = await pool.query("SELECT edited_at FROM chat_messages WHERE id = ?", [messageId]);
  const payload = { conversation_id: Number(conversationId), message_id: Number(messageId), body: text, edited_at: row ? row.edited_at : null };
  const [members] = await pool.query("SELECT user_id FROM chat_members WHERE conversation_id = ?", [conversationId]);
  for (const m of members) realtime.emitToUser(Number(m.user_id), "chat:message-edit", payload);
  return payload;
}

// Delete a single message — its OWN sender only. Removes the message + its
// attachments (unlinking upload files not shared with the job library or another
// chat) + reactions. Emits `chat:message-deleted` to members.
async function deleteMessage({ conversationId, messageId, userId }) {
  const [[msg]] = await pool.query(
    "SELECT sender_id FROM chat_messages WHERE id = ? AND conversation_id = ? LIMIT 1",
    [messageId, conversationId]
  );
  if (!msg) return { error: "notfound" };
  if (Number(msg.sender_id) !== Number(userId)) return { error: "forbidden" };
  const [atts] = await pool.query("SELECT file_path FROM chat_message_attachments WHERE message_id = ?", [messageId]);
  await pool.query("DELETE FROM chat_message_reactions WHERE message_id = ?", [messageId]).catch(() => {});
  await pool.query("DELETE FROM chat_message_attachments WHERE message_id = ?", [messageId]);
  await pool.query("DELETE FROM chat_messages WHERE id = ?", [messageId]);
  const fs = require("fs");
  const path = require("path");
  for (const a of atts) {
    const fp = String(a.file_path || "");
    if (!/\/?uploads\//i.test(fp)) continue;
    const [[jd]] = await pool.query("SELECT id FROM job_documents WHERE path = ? LIMIT 1", [fp]).catch(() => [[null]]);
    const [[oc]] = await pool.query("SELECT id FROM chat_message_attachments WHERE file_path = ? LIMIT 1", [fp]);
    if (jd || oc) continue;
    fs.unlink(path.join(__dirname, "..", "uploads", path.basename(fp)), () => {});
  }
  const [members] = await pool.query("SELECT user_id FROM chat_members WHERE conversation_id = ?", [conversationId]);
  const payload = { conversation_id: Number(conversationId), message_id: Number(messageId) };
  for (const m of members) realtime.emitToUser(Number(m.user_id), "chat:message-deleted", payload);
  return { ok: true };
}

// PERMANENT owner-only deletion of a whole conversation: removes reactions,
// attachments, messages, members and the conversation itself for everyone, and
// unlinks orphaned upload files. Files still referenced by the job's photo
// library (job_documents) or another chat are KEPT so nothing shared breaks.
async function deleteConversation({ conversationId, userId }) {
  const [[conv]] = await pool.query("SELECT id, owner_id FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  // ACCOUNT-owner only ("only the boss") — for ALL chat types incl. custom groups.
  // resolveOwnerId maps an employee creator up to their account owner, so a group
  // an employee started can still only be deleted by the boss, never the employee.
  const access = require("../utils/access");
  const acctOwner = await access.resolveOwnerId(Number(conv.owner_id));
  if (Number(userId) !== Number(acctOwner)) return { error: "forbidden" };

  const [atts] = await pool.query("SELECT file_path FROM chat_message_attachments WHERE conversation_id = ?", [conversationId]);
  const [members] = await pool.query("SELECT user_id FROM chat_members WHERE conversation_id = ?", [conversationId]);

  await pool.query("DELETE FROM chat_message_reactions WHERE conversation_id = ?", [conversationId]).catch(() => {});
  await pool.query("DELETE FROM chat_message_attachments WHERE conversation_id = ?", [conversationId]);
  await pool.query("DELETE FROM chat_messages WHERE conversation_id = ?", [conversationId]);
  await pool.query("DELETE FROM chat_members WHERE conversation_id = ?", [conversationId]);
  await pool.query("DELETE FROM chat_conversations WHERE id = ?", [conversationId]);

  // Unlink each upload file only if nothing else still points at it.
  const fs = require("fs");
  const path = require("path");
  for (const a of atts) {
    const fp = String(a.file_path || "");
    if (!/\/?uploads\//i.test(fp)) continue;
    const [[jd]] = await pool.query("SELECT id FROM job_documents WHERE path = ? LIMIT 1", [fp]).catch(() => [[null]]);
    const [[oc]] = await pool.query("SELECT id FROM chat_message_attachments WHERE file_path = ? LIMIT 1", [fp]);
    if (jd || oc) continue; // still referenced elsewhere → keep the file
    fs.unlink(path.join(__dirname, "..", "uploads", path.basename(fp)), () => {});
  }
  for (const m of members) realtime.emitToUser(Number(m.user_id), "chat:conversation-deleted", { conversation_id: Number(conversationId) });
  return { ok: true };
}

// May this user edit THIS chat's group photo? Gate = the chat's CREATOR (per-chat, not
// the account owner), plus any member the creator granted via can_edit_photo. (2026-08-28)
async function canEditChatPhoto(conversationId, userId) {
  const [[conv]] = await pool.query("SELECT created_by FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return false;
  if (Number(conv.created_by) === Number(userId)) return true;
  const [[g]] = await pool.query("SELECT can_edit_photo FROM chat_members WHERE conversation_id = ? AND user_id = ? LIMIT 1", [conversationId, userId]);
  return !!(g && Number(g.can_edit_photo) === 1);
}

// Set a conversation's custom icon photo — chat creator or a granted member.
async function setConversationIcon({ conversationId, userId, iconPath }) {
  const [[conv]] = await pool.query("SELECT id FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  if (!(await canEditChatPhoto(conversationId, userId))) return { error: "forbidden" };
  await pool.query("UPDATE chat_conversations SET icon_url = ? WHERE id = ?", [iconPath, conversationId]);
  return { icon_url: iconPath };
}

async function markRead(conversationId, userId, lastMessageId) {
  await pool.query(
    "UPDATE chat_members SET last_read_message_id = GREATEST(COALESCE(last_read_message_id,0), ?) WHERE conversation_id = ? AND user_id = ?",
    [Number(lastMessageId) || 0, conversationId, userId]
  );
}

// ---- Chat Files panel (2026-08-28) ----
function mimeIsImage(mime, name) {
  if (mime && /^image\//i.test(String(mime))) return true;
  return /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(String(name || ""));
}

/** All files/pictures attached to a conversation (message-borne AND panel-only). For a
 *  job-linked attachment the SHARED job_documents row is the source of the name/path, so
 *  a rename on either side shows here. */
async function listConversationFiles(conversationId) {
  const [rows] = await pool.query(
    `SELECT a.id, a.type, a.file_path, a.file_name, a.mime_type, a.job_document_id, a.uploaded_by, a.created_at,
            d.name AS doc_name, d.path AS doc_path, d.type AS doc_type
       FROM chat_message_attachments a
       LEFT JOIN job_documents d ON d.id = a.job_document_id
      WHERE a.conversation_id = ?
      ORDER BY a.id DESC`,
    [conversationId]
  );
  return rows.map((r) => {
    const name = r.job_document_id ? (r.doc_name || r.file_name) : r.file_name;
    const file_path = r.job_document_id ? (r.doc_path || r.file_path) : r.file_path;
    const isImg = r.type === "image" || r.doc_type === "photo" || r.doc_type === "image" || mimeIsImage(r.mime_type, name || file_path);
    return {
      id: r.id, name, file_path, kind: isImg ? "image" : "file",
      mime_type: r.mime_type, job_document_id: r.job_document_id,
      uploaded_by: r.uploaded_by, created_at: r.created_at,
    };
  });
}

/** Freshly-uploaded files → for a job-linked chat, ONE shared job_documents row per file
 *  + a linking attachment; posts a thread message (decision: fresh upload posts to thread). */
async function addUploadedFilesToChat({ conversationId, senderId, files, titles }) {
  const [[conv]] = await pool.query("SELECT job_id FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  const jobId = conv.job_id ? Number(conv.job_id) : null;
  const atts = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const title = (String((titles && titles[i]) || f.file_name || "File").trim()) || (f.file_name || "File");
    const isImg = mimeIsImage(f.mime_type, f.file_name);
    let jobDocId = null;
    if (jobId) {
      const [r] = await pool.query(
        "INSERT INTO job_documents (path, name, job_id, mime_type, created_by, created_at, type) VALUES (?, ?, ?, ?, ?, NOW(), ?)",
        [f.file_path, title, jobId, f.mime_type || null, senderId, isImg ? "photo" : "document"]
      );
      jobDocId = r.insertId;
    }
    atts.push({ type: isImg ? "image" : "file", file_path: f.file_path, file_name: title, mime_type: f.mime_type || null, job_document_id: jobDocId });
  }
  const message = await postMessage({ conversationId, senderId, body: "", attachments: atts });
  return { message, count: atts.length };
}

/** Pull existing job documents into the chat's Files panel ONLY (no thread message). Each
 *  is a pointer to the shared job_documents row (no re-upload, no copy). Job-chats only. */
async function attachJobDocsToChat({ conversationId, userId, items }) {
  const [[conv]] = await pool.query("SELECT job_id FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  if (!conv.job_id) return { error: "nojob" };
  let count = 0;
  for (const it of (items || [])) {
    const docId = Number(it.job_document_id);
    if (!docId) continue;
    const [[doc]] = await pool.query("SELECT id, path, name, mime_type, type FROM job_documents WHERE id = ? AND job_id = ? LIMIT 1", [docId, Number(conv.job_id)]);
    if (!doc) continue;
    const title = String((it.title != null ? it.title : doc.name) || "").trim() || doc.name;
    if (title && title !== doc.name) await pool.query("UPDATE job_documents SET name = ? WHERE id = ?", [title, docId]);
    const isImg = doc.type === "photo" || doc.type === "image" || mimeIsImage(doc.mime_type, doc.name);
    await pool.query(
      `INSERT INTO chat_message_attachments (message_id, conversation_id, type, file_path, file_name, mime_type, job_document_id, uploaded_by, created_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [conversationId, isImg ? "image" : "file", doc.path, title, doc.mime_type || null, docId, userId]
    );
    count++;
  }
  return { count };
}

/** Rename a chat file. If it's a shared (job-linked) record, updates the job_documents
 *  name (shows everywhere); always updates the attachment's own display name too. */
async function renameChatFile({ conversationId, attachmentId, name }) {
  const nm = String(name || "").trim();
  if (!nm) return { error: "empty" };
  const [[a]] = await pool.query("SELECT id, job_document_id FROM chat_message_attachments WHERE id = ? AND conversation_id = ? LIMIT 1", [attachmentId, conversationId]);
  if (!a) return { error: "notfound" };
  if (a.job_document_id) await pool.query("UPDATE job_documents SET name = ? WHERE id = ?", [nm, a.job_document_id]);
  await pool.query("UPDATE chat_message_attachments SET file_name = ? WHERE id = ?", [nm, attachmentId]);
  return { id: attachmentId, name: nm };
}

/** Detach a file from the chat — DETACH ONLY: never deletes the underlying job_documents
 *  record. A chat-only upload (no job link) with no remaining references gets its file
 *  unlinked to avoid orphans. */
async function detachChatFile({ conversationId, attachmentId }) {
  const [[a]] = await pool.query("SELECT id, job_document_id, file_path FROM chat_message_attachments WHERE id = ? AND conversation_id = ? LIMIT 1", [attachmentId, conversationId]);
  if (!a) return { error: "notfound" };
  await pool.query("DELETE FROM chat_message_attachments WHERE id = ?", [attachmentId]);
  if (!a.job_document_id && a.file_path) {
    const [[other]] = await pool.query("SELECT id FROM chat_message_attachments WHERE file_path = ? LIMIT 1", [a.file_path]);
    if (!other) { try { const fs = require("fs"); const path = require("path"); fs.unlinkSync(path.join(__dirname, "..", String(a.file_path).replace(/^\/+/, ""))); } catch (e) { /* ignore */ } }
  }
  return { ok: true };
}

/** Chat settings (creator-only): rename the group + set/clear the attached job. */
async function updateConversationSettings({ conversationId, userId, name, jobId }) {
  const [[conv]] = await pool.query("SELECT id, created_by FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  if (Number(conv.created_by) !== Number(userId)) return { error: "forbidden" };
  const sets = [], params = [];
  if (name != null) { const nm = String(name).trim(); if (nm) { sets.push("title = ?"); params.push(nm); } }
  if (jobId !== undefined) { sets.push("job_id = ?"); params.push(jobId ? Number(jobId) : null); }
  if (!sets.length) return { ok: true };
  params.push(conversationId);
  await pool.query(`UPDATE chat_conversations SET ${sets.join(", ")} WHERE id = ?`, params);
  return { ok: true };
}

/** Grant/revoke a member's "can edit the group photo" (creator-only). */
async function setMemberPhotoGrant({ conversationId, userId, memberId, canEdit }) {
  const [[conv]] = await pool.query("SELECT created_by FROM chat_conversations WHERE id = ? LIMIT 1", [conversationId]);
  if (!conv) return { error: "notfound" };
  if (Number(conv.created_by) !== Number(userId)) return { error: "forbidden" };
  await pool.query("UPDATE chat_members SET can_edit_photo = ? WHERE conversation_id = ? AND user_id = ?", [canEdit ? 1 : 0, conversationId, Number(memberId)]);
  return { ok: true };
}

module.exports = {
  db, isMember, addMember, removeMember,
  getOrCreateJobConversation, getOrCreateLeadConversation, getOrCreateDirect, createGroup, migrateLeadChatToJob,
  listMyConversations, totalUnread, getMessages, postMessage, markRead, reactToMessage,
  editMessage, deleteMessage, deleteConversation, setConversationIcon, canEditChatPhoto,
  listConversationFiles, addUploadedFilesToChat, attachJobDocsToChat, renameChatFile, detachChatFile,
  updateConversationSettings, setMemberPhotoGrant,
};
