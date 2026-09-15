'use strict';

/**
 * One-day Spartan Dashboard — stall snooze and the STALLED band.
 *
 * Everything here is PER USER. One person snoozing a stalled job must never
 * silence it for anybody else, so every read and write is scoped by the
 * caller's own id and there is no account-wide variant of either.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const logger = require('../common/logger');
const auth = require('../services/authentication');
const { ensureDashboardSchema, stallDays, SNOOZE_TARGETS } = require('../services/dashboardSchema');
const {
  lastActivityForJobs, lastActivityForLeads, daysSince, isStalled, activeSnoozes,
} = require('../services/dashboardStalled');
const { accountOwnerOf } = require('../services/notepadAccess');

/** 'YYYY-MM-DD' only. Anything else is not a date we will store. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight for a YMD string, so comparisons are calendar-day based. */
function ymdToLocalDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function todayLocal() {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return n;
}

/**
 * POST /stall-snooze — "check back on this date".
 *
 * THERE IS NO INDEFINITE OPTION AND NO WAY TO CONSTRUCT ONE.
 * `check_back_on` is required, must parse as a real calendar date, and must
 * not be in the past. There is no sentinel value, no null, no "never", and
 * the column is NOT NULL so none could be stored even if this route were
 * bypassed. A job silenced for good is a hole in the list meant to catch it.
 */
router.post('/stall-snooze', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const body = req.body || {};
  const type = String(body.target_type || '').trim();
  const targetId = Number(body.target_id);
  const ymd = String(body.check_back_on || '').trim();

  if (!SNOOZE_TARGETS.has(type)) {
    return res.status(400).json({ success: false, message: 'target_type must be job or lead.' });
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ success: false, message: 'target_id must be a positive id.' });
  }
  if (!YMD.test(ymd)) {
    return res.status(400).json({ success: false, message: 'check_back_on must be a YYYY-MM-DD date.' });
  }

  const picked = ymdToLocalDate(ymd);
  if (isNaN(picked.getTime())) {
    return res.status(400).json({ success: false, message: 'check_back_on is not a real date.' });
  }
  // Round-trip guard: '2026-02-31' parses to 2 March, which is not the date
  // anyone picked. Reject rather than silently storing a different day.
  const back = `${picked.getFullYear()}-${String(picked.getMonth() + 1).padStart(2, '0')}-${String(picked.getDate()).padStart(2, '0')}`;
  if (back !== ymd) {
    return res.status(400).json({ success: false, message: 'check_back_on is not a real date.' });
  }

  // PAST DAYS ARE UNSELECTABLE — enforced here, not only greyed in the UI.
  // A hidden control is not a rule; a direct POST walks straight past it.
  if (picked < todayLocal()) {
    return res.status(400).json({ success: false, message: 'Pick a date in the future — a job cannot be hidden for good.' });
  }

  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);

      // The target must be real and on the caller's own account. This does not
      // widen anything — the snooze only ever affects the caller's own view —
      // but it stops rows accruing for ids the caller has no business naming.
      const owner = await accountOwnerOf(connection, uid);
      const table = type === 'job' ? '`job`' : 'leads';
      const ownerCol = type === 'job' ? 'created_by' : 'user_id';
      const [[found]] = await connection.query(
        `SELECT ${ownerCol} AS owner_id FROM ${table} WHERE id = ? LIMIT 1`, [targetId],
      );
      if (!found) {
        return res.status(404).json({ success: false, message: 'That job or lead does not exist.' });
      }
      const targetOwner = await accountOwnerOf(connection, Number(found.owner_id));
      if (Number(targetOwner) !== Number(owner)) {
        return res.status(403).json({ success: false, message: 'Not your account.' });
      }

      // Upsert: picking a new date REPLACES the old one, so "when does this
      // come back" always has exactly one answer.
      await connection.query(
        `INSERT INTO dashboard_stall_snooze (user_id, target_type, target_id, check_back_on)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE check_back_on = VALUES(check_back_on)`,
        [uid, type, targetId, ymd],
      );

      const [[stored]] = await connection.query(
        `SELECT id, user_id, target_type, target_id, DATE_FORMAT(check_back_on, '%Y-%m-%d') AS check_back_on
           FROM dashboard_stall_snooze
          WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1`,
        [uid, type, targetId],
      );
      return res.status(200).json({ success: true, snooze: stored });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard stall-snooze error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /stalled — jobs and leads with no change for the threshold, minus the
 * caller's own active snoozes.
 */
router.get('/stalled', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await accountOwnerOf(connection, uid);
      const now = new Date();
      const threshold = stallDays();

      const [jobs] = await connection.query(
        'SELECT id, name, color FROM `job` WHERE created_by = ?', [owner],
      );
      let leads = [];
      try {
        const [l] = await connection.query('SELECT id, lead_name AS name FROM leads WHERE user_id = ?', [owner]);
        leads = l;
      } catch (e) { leads = []; }

      const jobAct = await lastActivityForJobs(connection, jobs.map((j) => j.id));
      const leadAct = await lastActivityForLeads(connection, leads.map((l) => l.id));
      const snoozed = await activeSnoozes(connection, uid, now);

      const out = [];
      for (const j of jobs) {
        const ts = jobAct.get(Number(j.id)) || null;
        if (!isStalled(ts, now, threshold)) continue;
        if (snoozed.has(`job:${Number(j.id)}`)) continue;
        out.push({ target_type: 'job', id: Number(j.id), name: j.name, color: j.color || null, days: daysSince(ts, now) });
      }
      for (const l of leads) {
        const ts = leadAct.get(Number(l.id)) || null;
        if (!isStalled(ts, now, threshold)) continue;
        if (snoozed.has(`lead:${Number(l.id)}`)) continue;
        out.push({ target_type: 'lead', id: Number(l.id), name: l.name, color: null, days: daysSince(ts, now) });
      }

      out.sort((a, b) => (b.days || 0) - (a.days || 0));
      return res.status(200).json({ success: true, threshold_days: threshold, stalled: out });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard stalled error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
