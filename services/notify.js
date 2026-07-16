// notify.js — reusable notification helpers, promoted from the working patterns
// scattered across the codebase (cron/sendReminders.js FCM sender, the inline
// nodemailer transport in routes/invitations.js, the notifications INSERT used by
// tasks/invitations/checklists). Use these instead of re-implementing.
//
// NONE of these are tier-gated: the notifications path never checks the recipient's
// access tier (denyExpiredFreeWrites only guards the ACTOR on write routes), so
// schedule alerts reach free-tier recipients too. Sends are best-effort and never
// throw to the caller — a slow/failed SMTP or FCM call must not block a schedule save.

'use strict';

const nodemailer = require('nodemailer');
const pool = require('../config/connection');
const admin = require('../config/firebase-admin');
const logger = require('../common/logger');

// Lazily build a single SMTP transport (same config as routes/invitations.js).
let mailer = null;
function getMailer() {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });
  }
  return mailer;
}

async function sendEmail(to, subject, text, html) {
  try {
    await getMailer().sendMail({
      from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html: html || undefined,
    });
    return true;
  } catch (e) {
    logger.error('[notify] sendEmail failed: ' + e.message);
    return false;
  }
}

// Data-only FCM push to every device token a user has; prune tokens FCM reports as
// dead. Adapted from cron/sendReminders.js sendToUser. `conn` may be a pool or a
// transaction connection; defaults to the shared pool.
async function sendPushToUser(conn, userId, { title, body, url }) {
  const db = conn || pool;
  try {
    const [rows] = await db.query(
      'SELECT fcm_token FROM user_device_tokens WHERE user_id = ?',
      [userId]
    );
    const tokens = rows.map((r) => r.fcm_token).filter(Boolean);
    for (const tok of tokens) {
      try {
        await admin.messaging().send({
          token: tok,
          data: {
            type: 'schedule',
            title: String(title || 'Schedule update'),
            body: String(body || ''),
            url: String(url || 'calendar'),
          },
          webpush: { headers: { Urgency: 'high' } },
        });
      } catch (e) {
        const code = e && e.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          try {
            await db.query('DELETE FROM user_device_tokens WHERE fcm_token = ?', [tok]);
          } catch (_) { /* ignore */ }
        } else {
          logger.error(`[notify] push (user ${userId}): ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.error(`[notify] sendPushToUser (user ${userId}): ${e.message}`);
  }
}

// Insert one in-app notification row (real columns: sender_id, receiver_id,
// content, status=1 [unread], url, created_by).
async function insertNotification(conn, { senderId, receiverId, content, url }) {
  const db = conn || pool;
  await db.query(
    `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [senderId || null, receiverId, content, url || '/calendar', senderId || null]
  );
}

function isRealEmail(email) {
  return !!email && !String(email).endsWith('@no-email.invalid');
}

function plural(n) { return Number(n) === 1 ? '' : 's'; }

// Build the self-contained message body for a batched set of a person's items.
function buildSummary(jobName, items) {
  const jobLabel = jobName ? ` on ${jobName}` : '';
  if (items.length === 1) {
    const it = items[0];
    return `${it.tradeName}${jobLabel} is scheduled to start ${it.newStartDate} ` +
      `(${it.durationDays} day${plural(it.durationDays)}).`;
  }
  const lines = items
    .map((it) => `• ${it.tradeName}: start ${it.newStartDate} (${it.durationDays} day${plural(it.durationDays)})`)
    .join('\n');
  return `Your schedule${jobLabel} was updated:\n${lines}`;
}

/**
 * Dispatch ONE batched notification for ONE person for ONE apply/cascade event.
 * `items` is that person's full list of changed/assigned items — never call this
 * per-item. Branches by account type:
 *   - no real account (user.password empty/null) → email fallback (if a real email)
 *   - otherwise → in-app notification row + FCM push (same summary)
 * Best-effort: swallows all errors so it can be fire-and-forget after commit.
 * @param {Object} conn  pool or connection (defaults to pool)
 * @param {Object} p     { userId, jobName, items:[{tradeName,newStartDate,durationDays}], senderId }
 */
async function dispatchScheduleNotification(conn, { userId, jobName, items, senderId }) {
  const db = conn || pool;
  try {
    if (!userId || !Array.isArray(items) || !items.length) return;

    const [[user]] = await db.query(
      'SELECT id, name, email, password FROM user WHERE id = ? LIMIT 1',
      [userId]
    );
    if (!user) return;

    const summary = buildSummary(jobName, items);
    const hasAccount = !!(user.password && String(user.password).trim() !== '');

    if (!hasAccount) {
      if (isRealEmail(user.email)) {
        const html = `<p>Hello${user.name ? ' ' + user.name : ''},</p>` +
          `<p>${summary.replace(/\n/g, '<br/>')}</p>` +
          `<p>— SeeJobRun</p>`;
        await sendEmail(user.email, 'Your job schedule was updated', summary, html);
      }
      return;
    }

    await insertNotification(db, {
      senderId,
      receiverId: userId,
      content: summary,
      url: '/calendar',
    });
    await sendPushToUser(db, userId, {
      title: 'Schedule update',
      body: summary,
      url: 'calendar',
    });
  } catch (e) {
    logger.error(`[notify] dispatchScheduleNotification (user ${userId}): ${e.message}`);
  }
}

module.exports = {
  sendEmail,
  isRealEmail,
  sendPushToUser,
  insertNotification,
  dispatchScheduleNotification,
};
