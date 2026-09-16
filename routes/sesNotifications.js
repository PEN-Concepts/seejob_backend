'use strict';

/**
 * SES BOUNCE / COMPLAINT NOTIFICATIONS, delivered by Amazon SNS.
 *
 * PUBLIC AND UNAUTHENTICATED, because SNS cannot present a credential. Its
 * effect is to suppress an email address permanently. So the SIGNATURE is the
 * only thing standing between this route and an anonymous caller cutting any
 * user off from their login codes — see services/snsVerify.js.
 *
 * BODY PARSING, AND WHY IT IS NOT THE GLOBAL PARSER. index.js mounts
 * express.json() with a `verify` hook that stashes req.rawBody, which is how the
 * Authorize.Net webhook gets its bytes. But express.json only engages for
 * Content-Type: application/json, and SNS POSTS text/plain. The global parser
 * therefore leaves the body unread and req.rawBody EMPTY. This router mounts its
 * own text parser accepting any content type, which works precisely because
 * nothing upstream consumed the stream.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const logger = require('../common/logger');
const { verifySnsMessage, confirmSubscription } = require('../services/snsVerify');
const { suppress } = require('../services/emailSuppression');
const { ensureSesEventsTable } = require('../services/dbMigrations');

// The topic we accept. Anything else is refused even with a perfect signature:
// a valid AWS signature only proves the message came from SNS, not that it came
// from OUR topic. Without this, anyone with an AWS account could publish to
// their own topic and have us act on it.
const EXPECTED_TOPIC_ARN = String(process.env.SES_SNS_TOPIC_ARN || '').trim();

// ── Rate limit ───────────────────────────────────────────────────────────
// In-process, no dependency. SNS for a platform this size sends a handful of
// notifications an hour; anything approaching this ceiling is either a retry
// storm or someone probing. Counters reset on restart, which is acceptable for
// a limiter whose job is to blunt a flood rather than to be an accounting
// record.
const RATE_MAX = 120;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 5000) hits.clear(); // crude ceiling; never unbounded
    return false;
  }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

/** Record the message id so redelivery is a no-op. Returns false if already seen. */
async function claimMessage(connection, messageId, type, bounceType, recipients) {
  try {
    const [res] = await connection.query(
      `INSERT IGNORE INTO ses_notification_events
         (message_id, notification_type, bounce_type, recipients, outcome)
       VALUES (?, ?, ?, ?, 'accepted')`,
      [String(messageId).slice(0, 190), type || null, bounceType || null,
       recipients ? JSON.stringify(recipients).slice(0, 4000) : null]
    );
    return res.affectedRows > 0;
  } catch (err) {
    logger.error('SES SNS: could not claim message: ' + err.message);
    return true; // never let bookkeeping stop us processing a real bounce
  }
}

async function noteFailure(connection, messageId, err) {
  try {
    await connection.query(
      'UPDATE ses_notification_events SET outcome = ?, error = ? WHERE message_id = ?',
      ['failed', String(err && err.message).slice(0, 2000), String(messageId).slice(0, 190)]
    );
  } catch (_) { /* nothing further to do */ }
}

router.post(
  '/ses-notifications',
  express.text({ type: '*/*', limit: '512kb' }),
  async (req, res) => {
    const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');
    if (rateLimited(ip)) {
      logger.warn('SES SNS: rate limited');
      return res.status(429).send('Too many requests');
    }

    let msg;
    try {
      msg = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (_) {
      logger.warn('SES SNS: unparseable body');
      return res.status(400).send('Bad request');
    }

    // ── VERIFY FIRST. Nothing below this line runs on an unverified message,
    // and every failure REJECTS. There is no log-and-continue path.
    const verdict = await verifySnsMessage(msg);
    if (!verdict.ok) {
      logger.warn('SES SNS: REJECTED — ' + verdict.reason);
      return res.status(403).send('Invalid signature');
    }

    // A good signature proves it came from SNS. The topic proves it came from
    // OUR SNS.
    if (EXPECTED_TOPIC_ARN && String(msg.TopicArn || '') !== EXPECTED_TOPIC_ARN) {
      logger.warn('SES SNS: REJECTED — foreign TopicArn');
      return res.status(403).send('Unexpected topic');
    }
    if (!EXPECTED_TOPIC_ARN) {
      // Refuse rather than accept anything, otherwise a missing env var
      // silently turns the topic check off — the failure mode nobody notices.
      logger.error('SES SNS: REJECTED — SES_SNS_TOPIC_ARN is not configured');
      return res.status(503).send('Not configured');
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      try {
        await confirmSubscription(msg.SubscribeURL);
        logger.info('SES SNS: subscription confirmed for ' + msg.TopicArn);
      } catch (err) {
        logger.error('SES SNS: subscription confirmation failed: ' + err.message);
      }
      return res.status(200).send('OK');
    }

    if (msg.Type === 'UnsubscribeConfirmation') {
      // LOUDLY. Nothing in this system should ever unsubscribe this endpoint;
      // if it happens, bounce processing has silently stopped.
      logger.error('SES SNS: *** UNSUBSCRIBE CONFIRMATION RECEIVED *** — bounce '
        + 'processing may have been detached from the topic. Investigate.');
      return res.status(200).send('OK');
    }

    // ── Notification ──
    let connection;
    try {
      connection = await pool.getConnection();
      await ensureSesEventsTable(connection);

      let payload;
      try {
        payload = typeof msg.Message === 'string' ? JSON.parse(msg.Message) : msg.Message;
      } catch (_) {
        logger.warn('SES SNS: Message was not JSON, ignored');
        return res.status(200).send('OK');
      }

      const type = payload && payload.notificationType;
      const bounce = payload && payload.bounce;
      const complaint = payload && payload.complaint;
      const recipients =
        (bounce && bounce.bouncedRecipients) ||
        (complaint && complaint.complainedRecipients) || [];

      const fresh = await claimMessage(
        connection, msg.MessageId, type, bounce && bounce.bounceType,
        recipients.map((r) => r && r.emailAddress).filter(Boolean)
      );
      if (!fresh) {
        // AT-LEAST-ONCE DELIVERY. Already handled; say OK and do nothing again.
        logger.info('SES SNS: duplicate MessageId ignored');
        return res.status(200).send('OK');
      }

      try {
        if (type === 'Bounce' && bounce) {
          if (String(bounce.bounceType) === 'Permanent') {
            for (const r of recipients) {
              if (r && r.emailAddress) {
                await suppress(r.emailAddress, 'hard_bounce', r.diagnosticCode, 'ses_sns', connection);
              }
            }
          } else {
            // TRANSIENT IS NOT DEAD. A full mailbox or a server down for an hour
            // is not an address to stop writing to, and suppressing on transient
            // bounces is how you lose real customers.
            logger.warn(
              `SES SNS: transient bounce (${bounce.bounceType}/${bounce.bounceSubType}) `
              + `for ${recipients.length} recipient(s) — logged, NOT suppressed`
            );
          }
        } else if (type === 'Complaint' && complaint) {
          // They pressed "spam". Never mail them again.
          for (const r of recipients) {
            if (r && r.emailAddress) {
              await suppress(r.emailAddress, 'complaint', complaint.complaintFeedbackType, 'ses_sns', connection);
            }
          }
        } else if (type === 'Delivery') {
          logger.info('SES SNS: delivery confirmed');
        } else {
          logger.info('SES SNS: unhandled notificationType ' + String(type));
        }
      } catch (err) {
        // OUR failure, not theirs. Record it and still answer 200 — a non-200
        // makes SNS retry for hours and buries the actual problem.
        logger.error('SES SNS: processing failed: ' + err.message);
        await noteFailure(connection, msg.MessageId, err);
      }

      return res.status(200).send('OK');
    } catch (err) {
      logger.error('SES SNS: handler error: ' + err.message);
      return res.status(200).send('OK');
    } finally {
      if (connection) connection.release();
    }
  }
);

module.exports = router;
