const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const auth = require('../services/authentication');

// Allowed dashboard module keys
const ALLOWED = new Set(['calendar', 'appointments', 'leads', 'jobs', 'tasks', 'employees','change_orders']);

const DEFAULTS = ['calendar', 'appointments', 'leads', 'jobs', 'tasks', 'employees','change_orders'];

// GET /api/pins/:userId -> { pins: string[] }
router.get('/get_pins/:userId', auth.authenticateToken, async (req, res) => {
  const paramId = parseInt(req.params.userId, 10);
  const requesterId = res.locals.id || req.user?.id;

  if (!paramId || Number.isNaN(paramId)) {
    return res.status(400).json({ code: '400', message: 'Invalid userId', data: {} });
  }
  if (requesterId !== paramId && !res.locals.isAdmin) {
    return res.status(403).json({ code: '403', message: 'Forbidden', data: {} });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Try to fetch existing row
    const [rows] = await connection.query(
      'SELECT pins FROM users_pins WHERE user_id = ? LIMIT 1',
      [paramId]
    );

    const row = rows && rows[0];

    if (!row) {
    
      await connection.query(
        `INSERT INTO users_pins (user_id, pins) VALUES (?, JSON_ARRAY(${DEFAULTS.map(()=>'?').join(',')}))`,
        [paramId, ...DEFAULTS]
      );
      return res.status(200).json({ code: '200', message: 'OK', data: { pins: DEFAULTS } });
    }


    const parsed = Array.isArray(row.pins) ? row.pins : (row?.pins ? JSON.parse(row.pins) : []);

    const pins = parsed.filter((k) => ALLOWED.has(k));
    return res.status(200).json({ code: '200', message: 'OK', data: { pins } });
  } catch (err) {
    console.error('GET /pins error', err);
    return res.status(500).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /api/pins/:userId  body: { pins: string[] }
router.put('/add_pins/:userId', auth.authenticateToken, async (req, res) => {
  const paramId = parseInt(req.params.userId, 10);
  const requesterId = res.locals.id || req.user?.id;

  if (!paramId || Number.isNaN(paramId)) {
    return res.status(400).json({ code: '400', message: 'Invalid userId', data: {} });
  }
  if (requesterId !== paramId) {
    return res.status(403).json({ code: '403', message: 'Forbidden', data: {} });
  }

  const incoming = Array.isArray(req.body?.pins) ? req.body.pins : [];
  const unique = Array.from(new Set(incoming)).filter((k) => ALLOWED.has(k));

  let connection;
  try {
    connection = await pool.getConnection();

    // Upsert row
    await connection.query(
      `INSERT INTO users_pins (user_id, pins)
       VALUES (?, JSON_ARRAY(${unique.map(() => '?').join(',')}))
       ON DUPLICATE KEY UPDATE pins = VALUES(pins)`,
      [paramId, ...unique]
    );

    return res.status(200).json({ code: '200', message: 'Saved', data: { pins: unique } });
  } catch (err) {
    console.error('PUT /pins error', err);
    return res.status(500).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
