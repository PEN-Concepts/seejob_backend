const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const logger = require('../common/logger');
const auth = require('../services/authentication');

// Local multer setup (do not use shared fileUpload.js)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '..', 'uploads');
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return cb(e);
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});

function fileFilter(req, file, cb) {
  const allowedExtensions = /jpeg|jpg|png|pdf|doc|docx|xls|xlsx/;
  const ext = path.extname(file.originalname).toLowerCase().substring(1);
  if (allowedExtensions.test(ext)) return cb(null, true);
  return cb(new Error('Only images and documents (pdf, doc, xls) are allowed'));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// POST /support_ticket - create a new ticket
// Accepts multipart/form-data. Optional file field name: attachment
router.post('/ticket', upload.single('attachment'), async (req, res) => {
  try {
    const { client_email, client_contact, subject, message, created_by, created_at } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: 'subject and message are required' });
    }

    // Enforce DB column limits to prevent ER_DATA_TOO_LONG
    const email = client_email ? String(client_email).slice(0, 45) : null;
    // Treat contact as string; if DB column is INT and value exceeds INT range, it will fail. Prefer VARCHAR.
    const contactStr = client_contact ? String(client_contact).slice(0, 45) : null;
    const createdBy = created_by !== undefined && created_by !== null && created_by !== ''
      ? parseInt(created_by, 10)
      : null;
    const safeSubject = String(subject).slice(0, 120);
    const safeMessage = String(message).slice(0, 500);

    // If a file was uploaded, keep it on disk and store its public path
    const attachmentPath = req.file ? `/uploads/${req.file.filename}` : null;

    // Use client-provided created_at (local time) if sent; otherwise default to NOW()
    let sql, params;
    if (created_at && String(created_at).trim() !== '') {
      sql = `INSERT INTO support_ticket (client_email, client_contact, subject, message, attachment, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`;
      params = [email, contactStr, safeSubject, safeMessage, attachmentPath, createdBy, String(created_at)];
    } else {
      sql = `INSERT INTO support_ticket (client_email, client_contact, subject, message, attachment, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`;
      params = [email, contactStr, safeSubject, safeMessage, attachmentPath, createdBy];
    }

    const [result] = await pool.query(sql, params);

    return res.status(201).json({
      id: (result && result.insertId) ? result.insertId : null,
      client_email: email,
      client_contact: contactStr,
      subject,
      message,
      has_attachment: !!attachmentPath,
      attachment: attachmentPath,
      created_by: createdBy,
      created_at: created_at && String(created_at).trim() !== '' ? String(created_at) : new Date().toISOString(),
    });
  } catch (err) {
    logger.error('POST /support_ticket error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /support_ticket - list the CALLING user's own tickets (most recent first).
// Previously this returned every ticket in the DB to any caller (no auth, no
// filter), so e.g. a brand-new subcontractor saw the owner's support tickets.
// Now scoped to created_by = the authenticated user.
const listTickets = async (req, res) => {
  try {
    const userId = Number(req.user && req.user.id) || 0;
    const [rows] = await pool.query(
      'SELECT id, client_email, client_contact, subject, status_id, message, attachment, created_at, created_by FROM support_ticket WHERE created_by = ? ORDER BY id DESC',
      [userId]
    );
    return res.status(200).json(rows);
  } catch (err) {
    logger.error('GET /support_ticket error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Support both / and /ticket paths for GET (authenticated: a caller only ever
// sees their own tickets).
router.get('/ticket', auth.authenticateToken, listTickets);
router.get('/', auth.authenticateToken, listTickets);

module.exports = router;
