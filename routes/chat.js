const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const chat = require("../services/chat");

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
