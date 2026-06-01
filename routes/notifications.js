const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
var auth = require("../services/authentication");


// ✅ Get notifications for logged-in user (status = 1)
// router.get("/notifications", auth.authenticateToken, async (req, res) => {
//   const user_id = req.user.id;
//   let connection;

//   try {
//     connection = await pool.getConnection();

//     const [rows] = await connection.query(
//       `SELECT id, content, url, status, created_at
//        FROM notifications
//        WHERE receiver_id = ? AND status = 1
//        ORDER BY created_at DESC`,
//       [user_id]
//     );

//     const [countRows] = await connection.query(
//       `SELECT COUNT(*) AS total
//        FROM notifications
//        WHERE receiver_id = ? AND status = 1`,
//       [user_id]
//     );

//     res.status(200).json({
//       code: "200",
//       message: rows.length
//         ? "Notifications fetched successfully"
//         : "No notifications found",
//       count: countRows[0]?.total || 0,
//       notifications: rows || [],
//     });

//   } catch (error) {
//     console.error("❌ Notification fetch error:", error);

//     res.status(500).json({
//       code: "500",
//       message: "Database connection error",
//       notifications: [],
//       count: 0,
//     });

//   } finally {
//     if (connection) connection.release();
//   }
// });
router.get("/notifications", auth.authenticateToken, async (req, res) => {
  const user_id = req.user.id;

  try {

    const [rows] = await pool.query(
      `SELECT id, content, url, status, created_at
       FROM notifications
       WHERE receiver_id = ? AND status = 1
       ORDER BY created_at DESC`,
      [user_id]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM notifications
       WHERE receiver_id = ? AND status = 1`,
      [user_id]
    );

    return res.status(200).json({
      code: "200",
      message: rows.length
        ? "Notifications fetched successfully"
        : "No notifications found",
      count: countRows[0]?.total || 0,
      notifications: rows || [],
    });

  } catch (error) {
    const code = error && (error.code || error.errno);
    const isTransientDbError =
      code === 'ETIMEDOUT' ||
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE';

    // Don't spam logs / break UI for transient DB disconnects.
    if (isTransientDbError) {
      return res.status(200).json({
        code: "200",
        message: "No notifications found",
        notifications: [],
        count: 0,
      });
    }

    console.error("❌ Notification fetch error:", error);
    res.status(500).json({
      code: "500",
      message: "Database connection error",
      notifications: [],
      count: 0,
    });
  }
});


// PUT /notifications/mark-as-read/:id
router.put("/mark-as-read/:id", auth.authenticateToken, async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(
      "UPDATE notifications SET status = 0 WHERE id = ?",
      [id]
    );

    if (result.affectedRows > 0) {
      res.status(200).json({ code: "200", message: "Notification marked as read" });
    } else {
      res.status(404).json({ code: "404", message: "Notification not found" });
    }
  } catch (err) {
    console.error("❌ Error updating notification status:", err);
    res.status(500).json({ code: "500", message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});
router.post("/notifications/read-all", auth.authenticateToken, async (req, res) => {
  const user_id = req.user.id;

  try {
    await pool.query(
      "UPDATE notifications SET status = 0 WHERE receiver_id = ?",
      [user_id]
    );

    res.json({ message: "All notifications marked read" });
  } catch (err) {
    res.status(500).json({ message: "Error" });
  }
});

router.get(
  "/unread-task/:userId",
  auth.authenticateToken,
  async (req, res) => {
    const userId = Number(req.params.userId);

    if (!userId) {
      return res.status(400).json({ message: "Invalid userId" });
    }

    let connection;
    try {
      connection = await pool.getConnection();

      const [rows] = await connection.query(
        `
        SELECT id, content, url, created_at
        FROM notifications
        WHERE receiver_id = ?
          AND status = 1
          AND url = '/task'
        ORDER BY created_at DESC
        `,
        [userId]
      );

      res.status(200).json({
        code: "200",
        notifi: rows,
        count: rows.length,
      });
    } catch (err) {
      console.error("Task notification error:", err);
      res.status(500).json({ message: "Internal server error" });
    } finally {
      if (connection) connection.release();
    }
  }
);



module.exports = router;