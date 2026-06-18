"use strict";

// Spartan daily-routine engine: personal recurring goals + per-day complete/skip
// log. Personal to each user (gated to paid/trial users via the UI/sidebar).

const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const logger = require("../common/logger");
const auth = require("../services/authentication");

let tablesReady = false;
async function ensureTables(conn) {
  if (tablesReady) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS spartan_goals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      goal VARCHAR(255) NOT NULL,
      start_time VARCHAR(8) DEFAULT NULL,
      duration_minutes INT DEFAULT NULL,
      recurrence VARCHAR(32) NOT NULL DEFAULT 'daily',
      day_of_week VARCHAR(64) DEFAULT NULL,
      is_special TINYINT DEFAULT 0,
      sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_spartan_goals_user (user_id)
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS spartan_goal_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      goal_id INT NOT NULL,
      user_id INT NOT NULL,
      log_date DATE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_goal_date (goal_id, log_date),
      INDEX idx_spartan_log_user (user_id)
    )
  `);
  tablesReady = true;
}

const ALLOWED_RECURRENCE = new Set([
  "daily", "weekly", "monthly", "yearly", "mwf", "tth", "sat", "custom",
]);

// GET / — all of the user's goals, each with today's complete/skip status.
router.get("/goals", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTables(connection);
    const [rows] = await connection.query(
      `SELECT g.*, l.status AS today_status
         FROM spartan_goals g
         LEFT JOIN spartan_goal_log l
           ON l.goal_id = g.id AND l.log_date = CURDATE()
        WHERE g.user_id = ?
        ORDER BY (g.start_time IS NULL), g.start_time ASC, g.sort_order ASC, g.id ASC`,
      [userId]
    );
    return res.json({ success: true, goals: rows });
  } catch (err) {
    logger.error("spartan get goals error: " + err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /goals — create a goal.
router.post("/goals", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const {
    goal, start_time, duration_minutes, recurrence, day_of_week,
    is_special, sort_order,
  } = req.body || {};

  if (!goal || !String(goal).trim()) {
    return res.status(400).json({ success: false, message: "Goal is required" });
  }
  const rec = ALLOWED_RECURRENCE.has(recurrence) ? recurrence : "daily";

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTables(connection);
    const [result] = await connection.query(
      `INSERT INTO spartan_goals
        (user_id, goal, start_time, duration_minutes, recurrence, day_of_week, is_special, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, String(goal).trim(), start_time || null,
        duration_minutes != null ? Number(duration_minutes) : null,
        rec, day_of_week || null, is_special ? 1 : 0, Number(sort_order) || 0,
      ]
    );
    return res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    logger.error("spartan create goal error: " + err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /goals/:id — update a goal (only the owner's).
router.put("/goals/:id", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  const {
    goal, start_time, duration_minutes, recurrence, day_of_week,
    is_special, sort_order,
  } = req.body || {};
  const rec = ALLOWED_RECURRENCE.has(recurrence) ? recurrence : "daily";

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTables(connection);
    const [result] = await connection.query(
      `UPDATE spartan_goals SET
        goal = ?, start_time = ?, duration_minutes = ?, recurrence = ?,
        day_of_week = ?, is_special = ?, sort_order = ?
       WHERE id = ? AND user_id = ?`,
      [
        String(goal || "").trim(), start_time || null,
        duration_minutes != null ? Number(duration_minutes) : null,
        rec, day_of_week || null, is_special ? 1 : 0, Number(sort_order) || 0,
        id, userId,
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Goal not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error("spartan update goal error: " + err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /goals/:id — delete a goal (and its logs).
router.delete("/goals/:id", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTables(connection);
    const [result] = await connection.query(
      "DELETE FROM spartan_goals WHERE id = ? AND user_id = ?",
      [id, userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Goal not found" });
    }
    await connection.query("DELETE FROM spartan_goal_log WHERE goal_id = ?", [id]);
    return res.json({ success: true });
  } catch (err) {
    logger.error("spartan delete goal error: " + err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /goals/:id/log — mark a goal complete/skipped for a date (default today).
router.post("/goals/:id/log", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  const status = req.body?.status === "skipped" ? "skipped" : "completed";
  const clear = req.body?.clear === true; // un-mark
  const date = req.body?.date || null; // 'YYYY-MM-DD' or null=today

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureTables(connection);

    // Confirm ownership.
    const [[g]] = await connection.query(
      "SELECT id FROM spartan_goals WHERE id = ? AND user_id = ? LIMIT 1",
      [id, userId]
    );
    if (!g) return res.status(404).json({ success: false, message: "Goal not found" });

    if (clear) {
      await connection.query(
        `DELETE FROM spartan_goal_log
          WHERE goal_id = ? AND log_date = ${date ? "?" : "CURDATE()"}`,
        date ? [id, date] : [id]
      );
      return res.json({ success: true, status: null });
    }

    await connection.query(
      `INSERT INTO spartan_goal_log (goal_id, user_id, log_date, status)
       VALUES (?, ?, ${date ? "?" : "CURDATE()"}, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status)`,
      date ? [id, userId, date, status] : [id, userId, status]
    );
    return res.json({ success: true, status });
  } catch (err) {
    logger.error("spartan log goal error: " + err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
