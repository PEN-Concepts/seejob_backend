'use strict';

/**
 * Single source of truth for OUTBOUND TRANSACTIONAL EMAIL — OTP/login codes,
 * password recovery, quotes, change orders, invitations, bid invites, and
 * schedule notifications.
 *
 * Why this exists: every route used to build its own inline
 * `nodemailer.createTransport({ host: SMTP_HOST, ... })` pointed at the SHARED
 * Namecheap Private Email mailbox (mail.tocanx.com). That single mailbox is a
 * single point of failure — when Namecheap's Phoenix DC had a cooling outage on
 * 2026-08-13 it took down login (OTP) AND every other automated email at once.
 * Consolidating here lets us move the whole app onto a purpose-built
 * transactional provider (Amazon SES) by flipping ONE env var, and retire the
 * shared-mailbox credentials.
 *
 * Provider is chosen by MAIL_PROVIDER:
 *   'smtp' (default) — the legacy Namecheap SMTP transport. Behaviour is
 *                      IDENTICAL to before, so deploying this refactor changes
 *                      nothing until SES is provisioned.
 *   'ses'            — Amazon SES via the EC2 instance's IAM role (region from
 *                      AWS_REGION/SES_REGION). No SMTP username/password to store
 *                      or rotate — the box's role grants ses:SendRawEmail.
 *
 * Cutover once SES is verified + the IAM role is attached: set MAIL_PROVIDER=ses
 * (and AWS_REGION). No code change. Then the SMTP_* creds can be removed.
 */

const nodemailer = require('nodemailer');
const logger = require('../common/logger');

const PROVIDER = String(process.env.MAIL_PROVIDER || 'smtp').trim().toLowerCase();

// Default From address. Kept as the historical sender for continuity; override
// with MAIL_FROM (e.g. once a dedicated SES identity is set up). NOTE: on the
// 'ses' path this address MUST be a verified SES identity or sends will fail.
const FROM =
  process.env.MAIL_FROM ||
  `"SeeJobRun" <${process.env.SMTP_USER || 'no-reply@tocanx.com'}>`;

// Legacy Namecheap SMTP transport (same config the inline transports used, incl.
// the fail-fast timeouts so a dead SMTP host can't hang a request forever).
function buildSmtpTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: true, // 465
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

// Amazon SES transport (AWS SDK v3). Credentials come from the EC2 instance IAM
// role by default — nothing to store in .env. Lazily require the SDK so a missing
// dependency can never crash the app while we're still on the smtp path.
function buildSesTransport() {
  const aws = require('@aws-sdk/client-ses');
  const region = process.env.AWS_REGION || process.env.SES_REGION || 'us-west-1';
  const ses = new aws.SESClient({ region });
  return nodemailer.createTransport({ SES: { ses, aws } });
}

let transporter;
try {
  transporter = PROVIDER === 'ses' ? buildSesTransport() : buildSmtpTransport();
  logger.info(`[mailer] using ${PROVIDER} transport`);
} catch (err) {
  // Never let a mis-configured provider take the app down on boot — fall back to
  // SMTP and log loudly so it's caught.
  logger.error(`[mailer] failed to init ${PROVIDER} transport; falling back to smtp: ${err.message}`);
  transporter = buildSmtpTransport();
}

/**
 * Send an email with the shared From default. Accepts the same options object as
 * nodemailer's transporter.sendMail (to, subject, text, html, cc, attachments…).
 * A per-call `from` still overrides the default if a caller needs it.
 */
async function sendMail(options) {
  return transporter.sendMail({ from: FROM, ...options });
}

// ── THE SUPPRESSION CHOKEPOINT ───────────────────────────────────────────
//
// This wraps transporter.sendMail ITSELF, not the helper above, and that is the
// whole design. TEN of the thirteen files that send mail do
// `require('../services/mailer').transporter` and call `.sendMail` on it
// directly, bypassing the helper entirely. A check inside sendMail() would have
// covered three files and missed the rest — including the OTP path.
//
// Wrapping the transporter means EVERY consumer inherits the check whichever
// import style it uses, and a call site added next year inherits it without
// anyone remembering this file exists. That is the difference between a
// chokepoint and a patch.
//
// The suppression service is required lazily, inside the call, to avoid a
// circular import (emailSuppression -> dbMigrations) at module load.
const rawSendMail = transporter.sendMail.bind(transporter);

transporter.sendMail = async function suppressionAwareSendMail(options) {
  let suppression;
  try {
    suppression = require('./emailSuppression');
  } catch (err) {
    // If the module cannot load at all, SEND rather than block. Blocking every
    // outbound email — login codes included — is a worse failure than sending
    // one we should not have.
    logger.error('[mailer] suppression module unavailable, sending unchecked: ' + err.message);
    return rawSendMail(options);
  }

  const opts = options || {};
  const recipients = suppression.extractAddresses(opts.to);
  if (!recipients.length) return rawSendMail(opts);

  const allowed = [];
  const blocked = [];
  for (const addr of recipients) {
    // isSuppressed FAILS OPEN on a database error — see its comment.
    if (await suppression.isSuppressed(addr)) blocked.push(addr);
    else allowed.push(addr);
  }

  if (blocked.length) {
    for (const addr of blocked) await suppression.recordBlocked(addr, opts.subject, 'suppressed');
    logger.warn(
      `[mailer] blocked ${blocked.length} suppressed recipient(s) on "${String(opts.subject || '').slice(0, 60)}"`
    );
  }

  // EVERY recipient suppressed → do not send, and tell the caller rather than
  // returning a fake success. The OTP route now reports a failed send honestly,
  // so the user is told instead of being sent to watch an empty inbox.
  if (!allowed.length) {
    const err = new Error('All recipients are suppressed; message not sent.');
    err.code = 'EMAIL_SUPPRESSED';
    throw err;
  }

  // A partially suppressed send still goes to the rest — dropping the whole
  // message because one CC bounced last month would punish the wrong people.
  return rawSendMail({ ...opts, to: allowed.join(', ') });
};

// `verify` is re-exported because the consolidated routes hold the MODULE now,
// not the raw transport, and three of them call transporter.verify() at boot to
// log whether SMTP is reachable. Without this the consolidation would crash
// those files on require — which it did, and the OTP suites caught it.
// Bound to the transport so `this` is correct.
const verify = transporter.verify.bind(transporter);

module.exports = { transporter, sendMail, verify, FROM, PROVIDER, rawSendMail };
