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

module.exports = { transporter, sendMail, FROM, PROVIDER };
