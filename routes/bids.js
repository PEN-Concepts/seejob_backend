const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const logger = require("../common/logger");
const auth = require("../services/authentication");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getCurrentDateTime } = require("../common/timdate");

const APP_URL = "https://seejobrun.com/user-dashboard/bid-requests";

// ---- idempotent schema (safe to run repeatedly; mirrors other migrations) ----
let tablesEnsured = false;
async function ensureBidTables(conn) {
  if (tablesEnsured) return;
  await conn.query(`CREATE TABLE IF NOT EXISTS bid_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    gc_user_id INT NOT NULL,
    job_id INT NULL,
    title VARCHAR(255) NOT NULL,
    comments MEDIUMTEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL,
    INDEX idx_gc (gc_user_id)
  )`);
  await conn.query(`CREATE TABLE IF NOT EXISTS bid_invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bid_request_id INT NOT NULL,
    contractor_user_id INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'invited',
    invited_at DATETIME NOT NULL,
    UNIQUE KEY uq_invite (bid_request_id, contractor_user_id),
    INDEX idx_contractor (contractor_user_id)
  )`);
  await conn.query(`CREATE TABLE IF NOT EXISTS bid_shared_docs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bid_request_id INT NOT NULL,
    document_id INT NOT NULL,
    UNIQUE KEY uq_doc (bid_request_id, document_id)
  )`);
  await conn.query(`CREATE TABLE IF NOT EXISTS bid_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bid_request_id INT NOT NULL,
    contractor_user_id INT NOT NULL,
    bid_total DECIMAL(12,2) NULL,
    scope_notes MEDIUMTEXT NULL,
    valid_until DATE NULL,
    pdf_path VARCHAR(512) NULL,
    submitted_at DATETIME NOT NULL,
    UNIQUE KEY uq_sub (bid_request_id, contractor_user_id)
  )`);
  tablesEnsured = true;
}

// ---- bid PDF upload ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "..", "uploads", "bids");
    try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); }
    catch (e) { cb(e); }
  },
  filename: (req, file, cb) => cb(null, `bid_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ---- branded email (no-reply from See Job Run, reusing the SMTP system) ----
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});
async function sendBidInviteEmail(toEmail, company, title, comments) {
  if (!toEmail) return;
  try {
    await mailer.sendMail({
      from: `"See Job Run" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: `You have a bid request from ${company || "a contractor"}`,
      text: `${company || "A contractor"} sent you a bid request: "${title}". ${comments || ""}\n\nOpen it in See Job Run: ${APP_URL}`,
      html: `<p><strong>${company || "A contractor"}</strong> sent you a bid request:</p>
             <p style="font-size:16px"><strong>${title}</strong></p>
             ${comments ? `<p>${comments}</p>` : ""}
             <p><a href="${APP_URL}">Open the bid request in See Job Run →</a></p>`,
    });
  } catch (e) {
    logger.error("sendBidInviteEmail: " + e.message);
  }
}

async function companyOf(conn, userId) {
  const [r] = await conn.query(
    "SELECT COALESCE(business, name) AS company FROM user WHERE id = ? LIMIT 1",
    [userId]
  );
  return r.length ? r[0].company : null;
}

// ===== Create a bid request + invite contractors (batch) =====
router.post("/", auth.authenticateToken, async (req, res) => {
  const gcId = req.user.id;
  const { job_id, title, comments, contractor_ids, document_ids } = req.body || {};
  if (!title || !Array.isArray(contractor_ids) || contractor_ids.length === 0) {
    return res.status(400).json({ message: "title and at least one contractor are required" });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const now = getCurrentDateTime();
    const [ins] = await conn.query(
      "INSERT INTO bid_requests (gc_user_id, job_id, title, comments, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
      [gcId, job_id || null, String(title).trim(), comments || null, now]
    );
    const bidId = ins.insertId;

    for (const cid of contractor_ids) {
      const id = Number(cid);
      if (!id) continue;
      await conn.query(
        "INSERT IGNORE INTO bid_invites (bid_request_id, contractor_user_id, status, invited_at) VALUES (?, ?, 'invited', ?)",
        [bidId, id, now]
      );
    }
    for (const docId of document_ids || []) {
      const id = Number(docId);
      if (!id) continue;
      await conn.query(
        "INSERT IGNORE INTO bid_shared_docs (bid_request_id, document_id) VALUES (?, ?)",
        [bidId, id]
      );
    }

    // email each invited contractor (branded as the GC's company)
    const company = await companyOf(conn, gcId);
    const [emails] = await conn.query(
      `SELECT email FROM user WHERE id IN (${contractor_ids.map(() => "?").join(",")})`,
      contractor_ids.map((c) => Number(c))
    );
    for (const row of emails) await sendBidInviteEmail(row.email, company, title, comments);

    res.status(201).json({ success: true, bid_request_id: bidId });
  } catch (err) {
    logger.error("create bid request: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ===== Sent: bid requests this GC sent, with invite/bid counts =====
router.get("/sent", auth.authenticateToken, async (req, res) => {
  const gcId = req.user.id;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const [rows] = await conn.query(
      `SELECT br.*, j.name AS job_name,
              (SELECT COUNT(*) FROM bid_invites bi WHERE bi.bid_request_id = br.id) AS invited_count,
              (SELECT COUNT(*) FROM bid_invites bi WHERE bi.bid_request_id = br.id AND bi.status = 'bid_sent') AS bids_count
         FROM bid_requests br
         LEFT JOIN job j ON j.id = br.job_id
        WHERE br.gc_user_id = ?
        ORDER BY br.created_at DESC`,
      [gcId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error("bids/sent: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ===== Received: bid requests sent TO this contractor =====
router.get("/received", auth.authenticateToken, async (req, res) => {
  const me = req.user.id;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const [rows] = await conn.query(
      `SELECT br.id, br.title, br.comments, br.created_at, br.job_id,
              bi.status AS my_status,
              COALESCE(u.business, u.name) AS from_company
         FROM bid_invites bi
         JOIN bid_requests br ON br.id = bi.bid_request_id
         JOIN user u ON u.id = br.gc_user_id
        WHERE bi.contractor_user_id = ?
        ORDER BY br.created_at DESC`,
      [me]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error("bids/received: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ===== Detail: a bid request + its shared docs + invites/submissions =====
router.get("/:id", auth.authenticateToken, async (req, res) => {
  const bidId = Number(req.params.id);
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const [reqRows] = await conn.query("SELECT * FROM bid_requests WHERE id = ? LIMIT 1", [bidId]);
    if (!reqRows.length) return res.status(404).json({ message: "Bid request not found" });

    const [docs] = await conn.query(
      `SELECT d.id, d.name, d.path, d.type FROM bid_shared_docs s
         JOIN job_documents d ON d.id = s.document_id WHERE s.bid_request_id = ?`,
      [bidId]
    );
    const [invites] = await conn.query(
      `SELECT bi.contractor_user_id, bi.status, COALESCE(u.business, u.name) AS company,
              s.bid_total, s.scope_notes, s.valid_until, s.pdf_path
         FROM bid_invites bi
         JOIN user u ON u.id = bi.contractor_user_id
         LEFT JOIN bid_submissions s ON s.bid_request_id = bi.bid_request_id AND s.contractor_user_id = bi.contractor_user_id
        WHERE bi.bid_request_id = ?`,
      [bidId]
    );
    res.json({ success: true, data: { request: reqRows[0], shared_docs: docs, invites } });
  } catch (err) {
    logger.error("bids/:id: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ===== Contractor submits a bid (PDF + total/scope/valid-until) =====
router.post("/:id/submit", auth.authenticateToken, upload.single("pdf"), async (req, res) => {
  const bidId = Number(req.params.id);
  const me = req.user.id;
  const { bid_total, scope_notes, valid_until } = req.body || {};
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const [inv] = await conn.query(
      "SELECT id FROM bid_invites WHERE bid_request_id = ? AND contractor_user_id = ? LIMIT 1",
      [bidId, me]
    );
    if (!inv.length) return res.status(403).json({ message: "You were not invited to this bid." });

    const pdfPath = req.file ? `bids/${req.file.filename}` : null;
    const now = getCurrentDateTime();
    await conn.query(
      `INSERT INTO bid_submissions (bid_request_id, contractor_user_id, bid_total, scope_notes, valid_until, pdf_path, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE bid_total=VALUES(bid_total), scope_notes=VALUES(scope_notes), valid_until=VALUES(valid_until), pdf_path=COALESCE(VALUES(pdf_path), pdf_path), submitted_at=VALUES(submitted_at)`,
      [bidId, me, bid_total || null, scope_notes || null, valid_until || null, pdfPath, now]
    );
    await conn.query(
      "UPDATE bid_invites SET status = 'bid_sent' WHERE bid_request_id = ? AND contractor_user_id = ?",
      [bidId, me]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error("bids/submit: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ===== Contractor declines to bid =====
router.post("/:id/decline", auth.authenticateToken, async (req, res) => {
  const bidId = Number(req.params.id);
  const me = req.user.id;
  let conn;
  try {
    conn = await pool.getConnection();
    await ensureBidTables(conn);
    const [r] = await conn.query(
      "UPDATE bid_invites SET status = 'declined' WHERE bid_request_id = ? AND contractor_user_id = ?",
      [bidId, me]
    );
    if (!r.affectedRows) return res.status(403).json({ message: "You were not invited to this bid." });
    res.json({ success: true });
  } catch (err) {
    logger.error("bids/decline: " + err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
