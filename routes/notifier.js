// notifier.js
const admin = require('./firebaseAdmin');
const pool = require("../config/connection");
const express = require("express");
const router = express.Router();
const path = require("path");
// async function sendPushToTokens(tokens, payload) {
//   if (!tokens || tokens.length === 0) return { successCount: 0 };

//   const message = {
//     tokens,
//     notification: {
//       title: payload.title,
//       body: payload.body,
//     },
//     data: payload.data || {}, // optional data payload
//     android: { priority: 'high' },
//     apns: { headers: { 'apns-priority': '10' } },
//   };

//   try {
//     const response = await admin.messaging().sendMulticast(message);
//     return response; // contains responses array per token
//   } catch (err) {
//     console.error('sendMulticast error', err);
//     throw err;
//   }
// }
async function sendPushToTokens(tokens, payload) {
  if (!tokens || tokens.length === 0) return { successCount: 0 };

  const message = {
    tokens,

    // ✅ REMOVE notification completely
    data: {
      title: payload.title || "New Notification",
      body: payload.body || "",
      ...(payload.data || {}) // merge extra data like taskId
    },

    android: { priority: 'high' },
    apns: { headers: { 'apns-priority': '10' } },
  };

  try {
    const response = await admin.messaging().sendMulticast(message);
    return response;
  } catch (err) {
    console.error('sendMulticast error', err);
    throw err;
  }
}
async function sendNotificationToUser(userId, payload) {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query('SELECT id, fcm_token FROM user_device_tokens WHERE user_id = ?', [userId]);
    const tokens = rows.map(r => r.fcm_token).filter(Boolean);
    if (tokens.length === 0) return { sent: 0 };

    const response = await sendPushToTokens(tokens, payload);

    // Remove invalid tokens
    const invalidTokens = [];
    response.responses.forEach((r, idx) => {
      if (!r.success) {
        // check error codes
        const err = r.error;
        if (err && (err.code === 'messaging/invalid-registration-token' ||
                    err.code === 'messaging/registration-token-not-registered')) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length > 0) {
      // delete from DB
      const placeholders = invalidTokens.map(() => '?').join(',');
      await conn.query(`DELETE FROM user_device_tokens WHERE fcm_token IN (${placeholders})`, invalidTokens);
    }

    return { sent: response.successCount || 0, invalidTokensCount: invalidTokens.length };
  } catch (err) {
    console.error('sendNotificationToUser error', err);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

module.exports = { sendNotificationToUser };
