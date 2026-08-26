const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const chat = require("../services/chat");
const { upload } = require("../services/fileUpload");

// Every route requires a valid session.
router.use(auth.authenticateToken);

// My conversations (newest activity first) + total unread badge.
router.get("/conversations", async (req, res) => {
  try {
    res.json({ conversations: await chat.listMyConversations(req.user.id) });
  } catch (e) { res.status(500).json({ message: "Could not load conversations." }); }
});

router.get("/unread-count", async (req, res) => {
  try { res.json({ count: await chat.totalUnread(req.user.id) }); }
  catch (e) { res.json({ count: 0 }); }
});

// Resolve (creating on demand) a job's group chat, joining the requester.
router.post("/job/:jobId", async (req, res) => {
  try {
    const convId = await chat.getOrCreateJobConversation(pool, Number(req.params.jobId), req.user.id);
    if (!convId) return res.status(404).json({ message: "Job not found." });
    await chat.addMember(pool, convId, req.user.id, "member");
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ message: "Could not open the job chat." }); }
});

router.post("/lead/:leadId", async (req, res) => {
  try {
    const convId = await chat.getOrCreateLeadConversation(pool, Number(req.params.leadId));
    if (!convId) return res.status(404).json({ message: "Lead not found." });
    await chat.addMember(pool, convId, req.user.id, "member");
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ message: "Could not open the lead chat." }); }
});

// Resolve (or create) a 1:1 direct conversation with another user.
router.post("/direct", async (req, res) => {
  try {
    const otherId = Number(req.body && req.body.user_id);
    if (!otherId) return res.status(400).json({ message: "Missing user_id." });
    const convId = await chat.getOrCreateDirect(pool, req.user.id, otherId);
    if (!convId) return res.status(400).json({ message: "Invalid direct conversation." });
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ message: "Could not open the conversation." }); }
});

// Create a custom GROUP chat (2+ people, named). Creator is the owner.
router.post("/group", async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    const userIds = Array.isArray(req.body && req.body.user_ids)
      ? req.body.user_ids.map(Number).filter(Boolean)
      : [];
    if (!name) return res.status(400).json({ message: "Group name is required." });
    const convId = await chat.createGroup(pool, req.user.id, name, userIds);
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ message: "Could not create the group." }); }
});

// --- everything below operates on a conversation the caller must be a member of ---
async function requireMember(req, res, next) {
  try {
    if (!(await chat.isMember(pool, Number(req.params.id), req.user.id))) {
      return res.status(403).json({ message: "You are not a member of this conversation." });
    }
    next();
  } catch (e) { res.status(500).json({ message: "Server error." }); }
}

router.get("/conversations/:id/messages", requireMember, async (req, res) => {
  try {
    const msgs = await chat.getMessages(Number(req.params.id), { before: req.query.before, limit: req.query.limit });
    res.json({ messages: msgs });
  } catch (e) { res.status(500).json({ message: "Could not load messages." }); }
});

router.post("/conversations/:id/messages", requireMember, async (req, res) => {
  try {
    const message = await chat.postMessage({
      conversationId: Number(req.params.id),
      senderId: req.user.id,
      body: req.body && req.body.body,
      attachments: req.body && req.body.attachments,
    });
    if (!message) return res.status(400).json({ message: "Empty message." });
    res.json({ message });
  } catch (e) { res.status(500).json({ message: "Could not send the message." }); }
});

// Post 1–10 photos to a conversation (Part E "save & share to chat"): saves the
// files, creates a chat message with image attachments, and for a JOB chat ALSO
// files them into that job's photo library (job_documents type='photo') — one
// copy, appears in both the chat and Files.
router.post("/conversations/:id/photos", requireMember, upload.array("photos", 10), async (req, res) => {
  try {
    const convId = Number(req.params.id);
    if (!req.files || !req.files.length) return res.status(400).json({ message: "No photos." });
    const attachments = req.files.map((f) => ({
      type: "image", file_path: `/uploads/${f.filename}`, file_name: f.originalname, mime_type: f.mimetype,
    }));
    const [[conv]] = await pool.query("SELECT type, job_id FROM chat_conversations WHERE id=? LIMIT 1", [convId]);
    if (conv && conv.type === "job" && conv.job_id) {
      for (const f of req.files) {
        await pool.query(
          "INSERT INTO job_documents (path, name, job_id, mime_type, created_by, created_at, type) VALUES (?, ?, ?, ?, ?, NOW(), 'photo')",
          [`/uploads/${f.filename}`, f.originalname, conv.job_id, f.mimetype, req.user.id]
        ).catch(() => {});
      }
    }
    const message = await chat.postMessage({ conversationId: convId, senderId: req.user.id, body: (req.body && req.body.body) || "", attachments });
    res.json({ message });
  } catch (e) { res.status(500).json({ message: "Could not post photos." }); }
});

// Edit your own message (within a 2-minute window). Live-syncs to members.
router.patch("/conversations/:id/messages/:msgId", requireMember, async (req, res) => {
  try {
    const r = await chat.editMessage({
      conversationId: Number(req.params.id),
      messageId: Number(req.params.msgId),
      userId: req.user.id,
      body: req.body && req.body.body,
    });
    if (r && r.error === "forbidden") return res.status(403).json({ message: "You can only edit your own message." });
    if (r && r.error === "expired") return res.status(409).json({ message: "The edit window has passed." });
    if (r && (r.error === "empty" || r.error === "notfound")) return res.status(400).json({ message: "Could not edit the message." });
    res.json({ message: r });
  } catch (e) { res.status(500).json({ message: "Could not edit the message." }); }
});

// Delete a single message (its own sender only).
router.delete("/conversations/:id/messages/:msgId", requireMember, async (req, res) => {
  try {
    const r = await chat.deleteMessage({ conversationId: Number(req.params.id), messageId: Number(req.params.msgId), userId: req.user.id });
    if (r && r.error === "forbidden") return res.status(403).json({ message: "You can only delete your own message." });
    if (r && r.error === "notfound") return res.status(404).json({ message: "Message not found." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: "Could not delete the message." }); }
});

// PERMANENT owner-only deletion of a whole conversation (chat + messages + files).
router.delete("/conversations/:id", requireMember, async (req, res) => {
  try {
    const r = await chat.deleteConversation({ conversationId: Number(req.params.id), userId: req.user.id });
    if (r && r.error === "forbidden") return res.status(403).json({ message: "Only the chat owner can delete this chat." });
    if (r && r.error === "notfound") return res.status(404).json({ message: "Chat not found." });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: "Could not delete the chat." }); }
});

// Toggle an emoji reaction on a message (one per user). Live-syncs to members.
router.post("/conversations/:id/messages/:msgId/react", requireMember, async (req, res) => {
  try {
    const emoji = String((req.body && req.body.emoji) || "");
    const reactions = await chat.reactToMessage({
      conversationId: Number(req.params.id),
      messageId: Number(req.params.msgId),
      userId: req.user.id,
      emoji,
    });
    if (reactions === null) return res.status(400).json({ message: "Invalid reaction." });
    res.json({ reactions });
  } catch (e) { res.status(500).json({ message: "Could not react." }); }
});

router.post("/conversations/:id/read", requireMember, async (req, res) => {
  try {
    await chat.markRead(Number(req.params.id), req.user.id, req.body && req.body.last_message_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: "Server error." }); }
});

router.get("/conversations/:id/members", requireMember, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.user_id, m.role, u.name, u.business AS business_name, u.image
         FROM chat_members m JOIN \`user\` u ON u.id = m.user_id
        WHERE m.conversation_id = ?
        ORDER BY (m.role='owner') DESC, COALESCE(NULLIF(u.business,''), u.name)`,
      [Number(req.params.id)]
    );
    res.json({ members: rows });
  } catch (e) { res.status(500).json({ message: "Could not load members." }); }
});

router.post("/conversations/:id/members", requireMember, async (req, res) => {
  try {
    const userId = Number(req.body && req.body.user_id);
    if (!userId) return res.status(400).json({ message: "Missing user_id." });
    await chat.addMember(pool, Number(req.params.id), userId, "member");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: "Could not add the member." }); }
});

router.delete("/conversations/:id/members/:userId", requireMember, async (req, res) => {
  try {
    await chat.removeMember(pool, Number(req.params.id), Number(req.params.userId));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: "Could not remove the member." }); }
});

module.exports = router;
