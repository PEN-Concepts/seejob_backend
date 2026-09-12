'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const auth = require('../services/authentication');
const logger = require('../common/logger');
const { ensurePreferencesSchema } = require('../services/preferencesSchema');

/**
 * Per-login preferences.
 *
 * GET  /preferences        -> { success, data: { "key": <value>, ... } }
 * PUT  /preferences        -> { key, value }  upsert, returns the stored value
 *
 * TWO GUARDS, and they are the point rather than decoration. Without them this
 * is an open key-value store with a user's name on it, writable from any
 * browser with a session, growing in ways nobody watches.
 *
 *   1. The KEY must be on the allowlist below. An unknown key is REFUSED, not
 *      stored. Adding a preference is a deliberate act with a code change.
 *   2. The VALUE is capped. Anything larger is refused, never truncated —
 *      silently storing half a value is worse than saying no.
 */

/**
 * Every preference the client may write, with a validator.
 *
 * Deliberately short. `notepad.showCompleted` is the show/hide-completed view
 * filter, shared by Notepads and My Tasks — a VIEW filter, so nothing is moved,
 * archived or deleted by it.
 *
 * The notepad card ORDER is NOT here: an ordered list of section ids is a
 * relational shape and belongs in checklist_section_order.
 */
const ALLOWED = {
  'notepad.showCompleted': (v) => typeof v === 'boolean',
};

/** A few KB is generous for a boolean. Refuse, never truncate. */
const MAX_VALUE_BYTES = 4096;

router.get('/', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePreferencesSchema(connection);
    const [rows] = await connection.query(
      'SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?',
      [uid],
    );
    const data = {};
    for (const r of rows) {
      // Only hand back keys we still recognise: a key removed from the
      // allowlist should stop being served, not linger in every response.
      if (!Object.prototype.hasOwnProperty.call(ALLOWED, r.pref_key)) continue;
      try {
        data[r.pref_key] = JSON.parse(r.pref_value);
      } catch (e) {
        // A row we cannot parse is a row we ignore. Never 500 a whole
        // preferences read because one value is malformed.
      }
    }
    res.json({ success: true, data });
  } catch (err) {
    logger.error('preferences read: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const key = String(req.body?.key || '');
  const value = req.body?.value;

  const validate = Object.prototype.hasOwnProperty.call(ALLOWED, key) ? ALLOWED[key] : null;
  if (!validate) {
    return res.status(400).json({
      success: false,
      code: 'PREF_KEY_NOT_ALLOWED',
      message: 'That is not a preference this app stores.',
    });
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (e) {
    return res.status(400).json({ success: false, code: 'PREF_VALUE_INVALID', message: 'Value could not be stored.' });
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
    return res.status(413).json({
      success: false,
      code: 'PREF_VALUE_TOO_LARGE',
      message: 'That preference value is too large.',
    });
  }

  // Shape LAST, deliberately. Checking size first means an oversized payload is
  // refused as too large whatever its shape — otherwise a type check would
  // reject it first and the cap would never actually be reached, which is a cap
  // that exists only in the code review.
  if (!validate(value)) {
    return res.status(400).json({
      success: false,
      code: 'PREF_VALUE_INVALID',
      message: 'That value is not the right shape for this preference.',
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePreferencesSchema(connection);
    await connection.query(
      `INSERT INTO user_preferences (user_id, pref_key, pref_value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE pref_value = VALUES(pref_value)`,
      [uid, key, encoded],
    );
    res.json({ success: true, data: { key, value } });
  } catch (err) {
    logger.error('preferences write: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
