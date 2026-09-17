'use strict';

/**
 * THE SUPPRESSION LIST — addresses the platform must never mail again.
 *
 * An address is suppressed when a row exists AND released_at IS NULL.
 * NOTHING IS EVER DELETED HERE. Releasing is a write, so the record of why
 * somebody was suppressed survives being let back in.
 */

const pool = require('../config/connection');
const logger = require('../common/logger');
const {
  ensureEmailSuppressionsTable,
  ensureBlockedSendsTable,
} = require('./dbMigrations');

const norm = (e) => String(e || '').trim().toLowerCase();

async function withConn(connection, fn) {
  if (connection) return fn(connection);
  const c = await pool.getConnection();
  try { return await fn(c); } finally { c.release(); }
}

/**
 * Suppress an address. Idempotent: SNS delivers at-least-once, so the same
 * bounce arrives more than once and must not create a second row or throw.
 *
 * A re-bounce after a release RE-SUPPRESSES (released_at back to NULL) — the
 * address died again, and the previous release does not grant immunity.
 */
async function suppress(email, reason, detail, source, connection) {
  const addr = norm(email);
  if (!addr) return false;
  return withConn(connection, async (c) => {
    await ensureEmailSuppressionsTable(c);
    await c.query(
      `INSERT INTO email_suppressions (email, reason, detail, source)
            VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
            reason = VALUES(reason),
            detail = VALUES(detail),
            source = VALUES(source),
            released_at = NULL,
            released_by = NULL`,
      [addr, reason, detail == null ? null : String(detail).slice(0, 4000), source || 'ses_sns']
    );
    logger.warn(`email suppressed (${reason}) via ${source || 'ses_sns'}`);
    return true;
  });
}

/** Is this address suppressed right now? Never throws — see the comment. */
async function isSuppressed(email, connection) {
  const addr = norm(email);
  if (!addr) return false;
  try {
    return await withConn(connection, async (c) => {
      const [[row]] = await c.query(
        'SELECT id FROM email_suppressions WHERE email = ? AND released_at IS NULL LIMIT 1',
        [addr]
      );
      return !!row;
    });
  } catch (err) {
    // FAILS OPEN, DELIBERATELY, and consistently with the rest of this
    // codebase's access checks. Failing closed would stop every login code in
    // the product over a transient blip. The first is recoverable; the second
    // is an outage.
    //
    // BUT IT SAYS SO, LOUDLY. A guard that silently stops guarding is worse
    // than no guard, because it is trusted. Every one of these lines means mail
    // went to an address we may know is dead, and the bounce rate that SES
    // suspends accounts over is climbing while this is happening. The marker is
    // deliberately greppable.
    logger.error(
      '*** EMAIL SUPPRESSION GUARD FAILED OPEN *** mail was allowed WITHOUT a '
      + 'suppression check — bounces and complaints are accumulating unchecked. '
      + 'Cause: ' + (err && err.message)
    );
    return false;
  }
}

/** Release an address. A WRITE, never a delete. */
async function release(email, releasedByUserId, connection) {
  const addr = norm(email);
  if (!addr) return false;
  return withConn(connection, async (c) => {
    await ensureEmailSuppressionsTable(c);
    const [res] = await c.query(
      `UPDATE email_suppressions
          SET released_at = NOW(), released_by = ?
        WHERE email = ? AND released_at IS NULL`,
      [releasedByUserId == null ? null : Number(releasedByUserId), addr]
    );
    return res.affectedRows > 0;
  });
}

/** Mail we did not send. Recorded so a suppressed address is not indistinguishable
 *  from a send that silently vanished. */
async function recordBlocked(email, subject, reason, connection) {
  try {
    await withConn(connection, async (c) => {
      await ensureBlockedSendsTable(c);
      await c.query(
        'INSERT INTO email_blocked_sends (email, subject, reason) VALUES (?, ?, ?)',
        [norm(email), subject == null ? null : String(subject).slice(0, 255), reason || null]
      );
    });
  } catch (err) {
    logger.error('could not record blocked send: ' + (err && err.message));
  }
}

/** Active suppressions, newest first, for the admin list. */
async function listActive(limit, connection) {
  return withConn(connection, async (c) => {
    await ensureEmailSuppressionsTable(c);
    const [rows] = await c.query(
      `SELECT id, email, reason, detail, source, created_at, updated_at
         FROM email_suppressions
        WHERE released_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ?`,
      [Number(limit) > 0 ? Number(limit) : 500]
    );
    return rows;
  });
}

/**
 * Split a nodemailer recipient field into plain addresses. Handles a string, a
 * comma-joined string, "Name <addr>" form, and an array.
 */
function extractAddresses(field) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    const m = s.match(/<([^>]+)>/);
    out.push(norm(m ? m[1] : s));
  };
  if (Array.isArray(field)) field.forEach((f) => (typeof f === 'object' && f ? push(f.address) : push(f)));
  else if (field && typeof field === 'object') push(field.address);
  else String(field || '').split(',').forEach(push);
  return out.filter(Boolean);
}

module.exports = { suppress, isSuppressed, release, recordBlocked, listActive, extractAddresses, norm };
