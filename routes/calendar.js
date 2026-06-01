const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const auth = require('../services/authentication');
const gcal = require('../services/googleCalendar');
const logger = require('../common/logger');

// GET /calendar/master-tasks
router.get('/master-tasks', auth.authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT id, title, COALESCE(sort_order, 0) AS sort_order, created_by, created_at, updated_at
       FROM master_calendar_tasks
       ORDER BY sort_order ASC, id ASC`
    );
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    logger.error('GET /calendar/master-tasks error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    connection.release();
  }
});

// POST /calendar/master-tasks
router.post('/master-tasks', auth.authenticateToken, async (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'Title is required' });
  }
  const userId = res.locals.id;
  const connection = await pool.getConnection();
  try {
    const [[maxRow]] = await connection.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM master_calendar_tasks'
    );
    const nextOrder = Number((maxRow && maxRow.max_order) || 0) + 1;
    const [result] = await connection.query(
      `INSERT INTO master_calendar_tasks (title, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [String(title).trim(), nextOrder, userId]
    );
    const insertedId = result.insertId;
    const [[row]] = await connection.query(
      'SELECT id, title, sort_order, created_by, created_at, updated_at FROM master_calendar_tasks WHERE id = ? LIMIT 1',
      [insertedId]
    );
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    logger.error('POST /calendar/master-tasks error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    connection.release();
  }
});

// PUT /calendar/master-tasks/:id
router.put('/master-tasks/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const { title, sort_order } = req.body || {};
  if (!id || isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid id' });

  const fields = [];
  const params = [];
  if (typeof title === 'string') {
    fields.push('title = ?');
    params.push(String(title).trim());
  }
  if (typeof sort_order === 'number') {
    fields.push('sort_order = ?');
    params.push(Number(sort_order));
  }
  if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });

  const connection = await pool.getConnection();
  try {
    const sql = `UPDATE master_calendar_tasks SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`;
    params.push(id);
    await connection.query(sql, params);

    const [[row]] = await connection.query(
      'SELECT id, title, sort_order, created_by, created_at, updated_at FROM master_calendar_tasks WHERE id = ? LIMIT 1',
      [id]
    );
    res.status(200).json({ success: true, data: row });
  } catch (err) {
    logger.error('PUT /calendar/master-tasks/:id error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    connection.release();
  }
});

// PUT /calendar/master-tasks/reorder
router.put('/master-tasks/reorder', auth.authenticateToken, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const item of order) {
      const id = Number(item && item.id);
      const sortOrder = Number(item && item.sort_order);
      if (!id || isNaN(id) || isNaN(sortOrder)) continue;
      await connection.query(
        'UPDATE master_calendar_tasks SET sort_order = ?, updated_at = NOW() WHERE id = ? LIMIT 1',
        [sortOrder, id]
      );
    }
    await connection.commit();
    res.status(200).json({ success: true });
  } catch (err) {
    await connection.rollback();
    logger.error('PUT /calendar/master-tasks/reorder error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    connection.release();
  }
});

// DELETE /calendar/master-tasks/:id
router.delete('/master-tasks/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  const connection = await pool.getConnection();
  try {
    await connection.query('DELETE FROM master_calendar_tasks WHERE id = ? LIMIT 1', [id]);
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('DELETE /calendar/master-tasks/:id error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    connection.release();
  }
});

// ─── Google Calendar Integration ─────────────────────────────────────

// GET /calendar/google/auth-url — returns the Google OAuth consent URL
router.get('/google/auth-url', auth.authenticateToken, async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || res.locals.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const url = gcal.getAuthUrl(userId);
    res.json({ success: true, url });
  } catch (err) {
    logger.error('GET /calendar/google/auth-url error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /calendar/google/callback — Google redirects here after user consent
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing code or state parameter.');
    }

    const userId = Number(state);
    if (!userId) return res.status(400).send('Invalid user.');

    await gcal.handleCallback(code, userId);

    // Redirect user back to the Angular frontend calendar page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    res.redirect(`${frontendUrl}/user-dashboard/calendar?google_connected=true`);
  } catch (err) {
    logger.error('GET /calendar/google/callback error:', err);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    res.redirect(`${frontendUrl}/user-dashboard/calendar?google_connected=false&error=${encodeURIComponent(err.message)}`);
  }
});

// GET /calendar/google/status — check if user has connected Google Calendar
router.get('/google/status', auth.authenticateToken, async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || res.locals.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const connected = await gcal.isConnected(userId);
    res.json({ success: true, connected });
  } catch (err) {
    logger.error('GET /calendar/google/status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /calendar/google/sync — bulk sync all appointments to Google Calendar
router.post('/google/sync', auth.authenticateToken, async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || res.locals.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await gcal.syncAllAppointments(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('POST /calendar/google/sync error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// DELETE /calendar/google/disconnect — remove Google Calendar connection
router.delete('/google/disconnect', auth.authenticateToken, async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || res.locals.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    await gcal.disconnect(userId);
    res.json({ success: true, message: 'Google Calendar disconnected' });
  } catch (err) {
    logger.error('DELETE /calendar/google/disconnect error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
