const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const { ensureRemindersTable } = require("../services/dbMigrations");

// Convert epoch milliseconds -> a UTC 'YYYY-MM-DD HH:MM:SS' string. Storing/
// comparing in UTC (vs the DB server's local NOW()) keeps firing timezone-safe.
function toUtcDatetime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

// Upsert a reminder for the logged-in user. Re-arming the same source replaces
// any still-pending reminder for it.
router.post("/", auth.authenticateToken, async (req, res) => {
  const userId = Number(req.user.id);
  const b = req.body || {};
  const fireAt = toUtcDatetime(b.fire_at_ms);
  if (!b.title || !fireAt) {
    return res.status(400).json({ message: "title and a valid fire_at_ms are required" });
  }
  const type = String(b.source_type || "task").slice(0, 20);
  const srcId = b.source_id != null ? String(b.source_id).slice(0, 64) : null;
  const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureRemindersTable(connection);
    if (srcId != null) {
      await connection.query(
        `DELETE FROM reminders
         WHERE user_id = ? AND source_type = ? AND source_id = ? AND sent_at IS NULL`,
        [userId, type, srcId]
      );
    }
    const [result] = await connection.query(
      `INSERT INTO reminders
        (user_id, source_type, source_id, title, body, job_name, appt_time, appt_address, url, fire_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId, type, srcId,
        String(b.title).slice(0, 255),
        clip(b.body, 255),
        clip(b.jobName, 255),
        clip(b.apptTime, 40),
        clip(b.apptAddress, 255),
        clip(b.url, 80),
        fireAt,
        userId,
      ]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    logger.error("reminders POST error: " + err.message);
    res.status(500).json({ message: "Failed to save reminder", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Remove still-pending reminder(s) for a source (reminder turned off / item deleted).
router.delete("/", auth.authenticateToken, async (req, res) => {
  const userId = Number(req.user.id);
  const { source_type, source_id } = req.query;
  if (!source_type || source_id == null) {
    return res.status(400).json({ message: "source_type and source_id are required" });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureRemindersTable(connection);
    await connection.query(
      `DELETE FROM reminders
       WHERE user_id = ? AND source_type = ? AND source_id = ? AND sent_at IS NULL`,
      [userId, String(source_type), String(source_id)]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error("reminders DELETE error: " + err.message);
    res.status(500).json({ message: "Failed to remove reminder", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
