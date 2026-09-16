'use strict';

/**
 * ADMIN: see who is suppressed, and let them back in.
 *
 * RELEASE IS THE POINT OF THIS FILE. A contractor whose mailbox was full on the
 * wrong day, or who mis-clicked "spam" once, is otherwise permanently cut off
 * from their own login codes with no way back except a database query. A
 * suppression list without a release control is a lockout we cannot undo.
 *
 * BOSS ONLY, ENFORCED ON THE REQUEST. Checked against OWNER_EXEMPT_EMAILS on
 * every call, so a direct API call with any other token is refused whatever the
 * UI shows. Hiding a button is not a permission.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const logger = require('../common/logger');
const { authenticateToken } = require('../services/authentication');
const { OWNER_EXEMPT_EMAILS } = require('../utils/access');
const { listActive, release } = require('../services/emailSuppression');

function isBackendOwner(req) {
  const email = String((req.user && req.user.email) || '').trim().toLowerCase();
  return OWNER_EXEMPT_EMAILS.has(email);
}

/** The active suppression list. */
router.get('/suppressions', authenticateToken, async (req, res) => {
  if (!isBackendOwner(req)) return res.status(403).json({ success: false, message: 'Not allowed.' });
  let connection;
  try {
    connection = await pool.getConnection();
    const rows = await listActive(Number(req.query.limit) || 500, connection);
    return res.json({ success: true, suppressions: rows });
  } catch (err) {
    logger.error('suppression list error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

/** Release an address. A WRITE — the row stays, with who released it and when. */
router.post('/suppressions/release', authenticateToken, async (req, res) => {
  if (!isBackendOwner(req)) return res.status(403).json({ success: false, message: 'Not allowed.' });
  const email = String((req.body && req.body.email) || '').trim();
  if (!email) return res.status(400).json({ success: false, message: 'An email is required.' });

  let connection;
  try {
    connection = await pool.getConnection();
    const done = await release(email, Number(res.locals.id), connection);
    if (!done) {
      return res.status(404).json({ success: false, message: 'That address is not currently suppressed.' });
    }
    logger.info(`suppression released by user ${Number(res.locals.id)}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('suppression release error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
