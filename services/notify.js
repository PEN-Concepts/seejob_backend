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
// Shared, provider-switchable transport (SMTP today, SES via env flip). See
// services/mailer.js — replaces the per-file inline SMTP transport.
function getMailer() {
  return require('./mailer').transporter;
}

/**
 * REPLY-TO IS A PARAMETER HERE, NEVER A DEFAULT.
 *
 * This helper has two callers that want two different answers:
 *   dispatchScheduleNotification -> the GC whose schedule changed
 *   payments reverification      -> MAIL_REPLY_TO, because it is app mail
 *
 * A default would silently give one of them the other's answer, and the one it
 * would get wrong is the customer-facing one. So a caller that passes nothing
 * THROWS — loudly, at the call site, the first time it is exercised — rather
 * than sending a schedule notice that replies to the wrong company.
 *
 * That throw is a programming error, not a send failure: it fires before any
 * message is built. Genuine send failures still return false and never throw,
 * which is what the "sends are best-effort" contract at the top of this file
 * means and what schedule saves depend on.
 */
async function sendEmail(to, subject, text, html, replyTo) {
  if (!replyTo || !String(replyTo).trim()) {
    throw new Error(
      '[notify] sendEmail requires replyTo. Pass the owning GC for user-originated ' +
        'mail, or mailReplyTo.defaultReplyTo() for app mail. There is no default here ' +
        'because the two callers need different answers.',
    );
  }
  try {
    await getMailer().sendMail({
      from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html: html || undefined,
      replyTo,
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
// `asNotification` adds an FCM `notification` block so the OS DISPLAYS the push
// reliably (including on iOS/Safari PWAs). Without it the message is data-only and
// depends on the service worker's onBackgroundMessage running showNotification,
// which iOS PWAs do not do reliably. Default false keeps existing callers
// (schedule/reminder) unchanged.
async function sendPushToUser(conn, userId, { title, body, url, type, urgent, asNotification }) {
  const db = conn || pool;
  try {
    const [rows] = await db.query(
      // DISTINCT: a registration race can leave two rows with the SAME token for a
      // user → without this the recipient gets duplicate pushes for one event.
      'SELECT DISTINCT fcm_token FROM user_device_tokens WHERE user_id = ?',
      [userId]
    );
    const tokens = rows.map((r) => r.fcm_token).filter(Boolean);
    for (const tok of tokens) {
      try {
        const msg = {
          token: tok,
          data: {
            type: String(type || 'schedule'),
            title: String(title || 'Schedule update'),
            body: String(body || ''),
            url: String(url || 'calendar'),
            // '1' → the service worker renders a visually distinct RED urgent
            // notification (vs the normal gold). Data-only message, so the SW
            // owns the styling.
            urgent: urgent ? '1' : '0',
          },
          webpush: { headers: { Urgency: 'high' } },
        };
        if (asNotification) {
          // The SW doesn't run for a `notification`-block message, so fold the
          // urgent cue into the title (mirrors the SW's red prefix for data-only).
          msg.notification = {
            title: urgent ? '🔴 ' + String(title || '') : String(title || ''),
            body: String(body || ''),
          };
        }
        await admin.messaging().send(msg);
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
        // The GC WHO EDITED THE SCHEDULE owns this conversation — the reader is
        // a worker on that company's job, and a reply ("I can't make Tuesday")
        // has to reach the person who moved the date.
        const { replyToForUser } = require('./mailReplyTo');
        const replyTo = await replyToForUser(db, senderId);
        await sendEmail(user.email, 'Your job schedule was updated', summary, html, replyTo);
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
