const express = require("express");
const router = express.Router();
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");

const pad2 = (n) => String(n).padStart(2, '0');
const formatLocalDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const parseYmdParts = (val) => {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
    }
  } catch (_) {}
  const s = String(val);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
};

// get all jobs with its user login
router.get('/jobs/:userId', auth.authenticateToken, async (req, res) => {
  const userId = req.params.userId;
let connection;
    try {
      connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT j.*, u.name AS 'client_name', u2.name AS 'inspector_name',
              u2.mobile AS 'inspector_mobile', u2.email, u2.city 
       FROM job j 
      left JOIN user u ON u.id = j.client_id 
      left JOIN user u2 ON u2.id = j.inspector_id 
       WHERE j.status = 1 AND j.created_by = ?
       ORDER BY j.created_at DESC`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    logger.error("Error fetching jobs:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// GET tasks by job_id
router.get("/tasks/:jobId", auth.authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const [rows] = await pool.query(
      "SELECT * FROM tasks WHERE job_id = ?",
      [jobId]
    );
    res.status(200).json(rows);
  } catch (err) {
    logger.error("Error fetching tasks by job ID", err);
    res.status(500).json({ message: "Server error" });
  }
});


// POST route to start the clockin
router.post('/start', auth.authenticateToken, async (req, res) => {
  const { job_id, task_id } = req.body;
  const userId = req.user.id;

  const now = new Date();
  const start_time = now.toTimeString().split(' ')[0];
  const start_date = formatLocalDate(now);
  try {
    // Only ONE active timer per user. If one is already running, reject with 409
    // + the running timer's details so the UI can prompt the user to stop/resolve
    // it first — never silently allow two concurrent timers.
    const [activeRows] = await pool.query(
      `SELECT c.id, c.job_id, j.name AS job_name, c.start_time, c.start_date
         FROM clockin c LEFT JOIN job j ON j.id = c.job_id
        WHERE c.created_by = ? AND c.is_task_active = TRUE
        LIMIT 1`,
      [userId]
    );
    if (activeRows.length) {
      return res.status(409).json({
        message: "You already have a running timer. Stop it before starting a new one.",
        code: "ACTIVE_TIMER_EXISTS",
        active: activeRows[0],
      });
    }

    const [result] = await pool.query(
      `INSERT INTO clockin (job_id, task_id, start_time, start_date, created_by,is_task_active)
       VALUES (?, ?, ?, ?, ?, TRUE)`,
      [job_id, task_id, start_time, start_date, userId]
    );

    res.status(201).json({ message: "Clock-in started", clockin_id: result.insertId });
  } catch (err) {
    logger.error("Clock-in start error:", err);
    res.status(500).json({ message: "Server error" });
  }

});


router.put('/stop/:id', auth.authenticateToken, async (req, res) => {
  const clockinId = req.params.id;
  const { remarks } = req.body || {};
  const now = new Date();
  const stop_time = now.toTimeString().split(' ')[0]; // HH:MM:SS
  const stop_date = formatLocalDate(now);  // YYYY-MM-DD

  try {

    const [rows] = await pool.query(
      `SELECT start_time, start_date, break_duration, is_break, start_break, break_start_date 
       FROM clockin WHERE id = ?`,
      [clockinId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: 'Clock-in not found' });
    }

    const { start_time, start_date, break_duration, is_break, start_break, break_start_date } = rows[0];


    const startString = `${start_date}T${start_time}`;
    const start = new Date(startString);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ message: 'Invalid start date/time on record' });
    }

    const elapsedSeconds = Math.max(0, Math.floor((now - start) / 1000));


    const toSec = (s) => {
      if (!s) return 0;
      const [hh, mm, ss] = s.toString().split(':').map(Number);
      if ([hh, mm, ss].some(isNaN)) return 0;
      return hh * 3600 + mm * 60 + ss;
    };
    const secToHms = (t) => {
      const safe = Number.isFinite(t) ? t : 0;
      const hh = Math.floor(safe / 3600).toString().padStart(2, '0');
      const mm = Math.floor((safe % 3600) / 60).toString().padStart(2, '0');
      const ss = Math.floor(safe % 60).toString().padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    };

    const prevBreakSeconds = toSec(break_duration);
    let currentBreakSeconds = 0;
    if (is_break && start_break && break_start_date) {
      const bp = start_break.toString().split(':').map(Number);
      if (bp.length === 3 && !bp.some(isNaN)) {
        const [bh, bm, bs] = bp;
        const ymd2 = parseYmdParts(break_start_date);
        if (ymd2) {
          const [by, bmo, bd] = ymd2;
          const breakStart = new Date(by, bmo - 1, bd, bh, bm, bs);
          currentBreakSeconds = Math.max(0, Math.floor((now - breakStart) / 1000));
        }
      }
    }
    const totalBreakSeconds = prevBreakSeconds + currentBreakSeconds;


    const workedSeconds = Math.max(0, elapsedSeconds - totalBreakSeconds);
    const task_duration = secToHms(workedSeconds);
    const finalBreakHms = secToHms(totalBreakSeconds);

    if (is_break) {

      await pool.query(
        `UPDATE clockin 
         SET stop_time = ?, stop_date = ?, task_duration = ?, is_task_active = FALSE,
             is_break = FALSE, stop_break = ?, break_stop_date = ?, break_duration = ?,
             additional_notes = COALESCE(?, additional_notes)
         WHERE id = ?`,
        [stop_time, stop_date, task_duration, stop_time, stop_date, finalBreakHms, remarks || null, clockinId]
      );
    } else {
      await pool.query(
        `UPDATE clockin 
         SET stop_time = ?, stop_date = ?, task_duration = ?, is_task_active = FALSE,
             additional_notes = COALESCE(?, additional_notes)
         WHERE id = ?`,
        [stop_time, stop_date, task_duration, remarks || null, clockinId]
      );
    }

    res.status(200).json({ message: 'Clock-in stopped', task_duration, break_duration: finalBreakHms });
  } catch (err) {
    logger.error('Clock-in stop error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});


router.get('/active-start-time', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
  
const [rows] = await pool.query(
    `SELECT c.*, j.name AS job_name, t.taskName,
            DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_date
     FROM clockin c
     JOIN job j ON j.id = c.job_id
     LEFT JOIN job_task_assignment t ON t.id = c.task_id
     WHERE c.created_by = ? AND c.is_task_active = TRUE  AND c.is_break = FALSE
     LIMIT 1`,
    [userId]
  );
    if (rows.length === 0) {
      return res.status(404).json({ message: "No active clock-in found" });
    }

    res.json(rows[0]);
  } catch (err) {
    logger.error("Error fetching active start time:", err);
    res.status(500).json({ message: "Server error" });
  }

});


// Route to START break

router.post('/start-break', auth.authenticateToken, async (req, res) => {
  const clockinId = req.body.clockinId ?? req.body.clockin_id;
  const breakType = req.body.breakType ?? req.body.break_type; 

  if (!clockinId || !breakType) {
    return res.status(400).json({ message: 'clockinId and breakType are required' });
  }

  const now = new Date();
  const start_break = now.toTimeString().split(' ')[0]; // "HH:MM:SS"
  const break_start_date = formatLocalDate(now); // "YYYY-MM-DD"

  try {

    await pool.query(
      `UPDATE clockin
       SET start_break = ?, 
           break_start_date = ?, 
           stop_break = NULL, 
           break_stop_date = NULL, 
           break_type = ?,
           is_break = TRUE
       WHERE id = ?`,
      [start_break, break_start_date, breakType, Number(clockinId)]
    );

    res.status(200).json({
      message: "Break started",
      break_type: breakType,
      start_break,
      break_start_date,
      is_break: true
    });
  } catch (err) {
    logger.error("Error starting break:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// Route to STOP break and calculate break duration
router.put('/stop-break/:id', auth.authenticateToken, async (req, res) => {
  const clockinId = req.params.id;
  const now = new Date();

  const stop_break = now.toTimeString().split(' ')[0]; // "HH:MM:SS"
  const break_stop_date = formatLocalDate(now); // "YYYY-MM-DD"

  try {
    // Fetch start break data
    const [rows] = await pool.query(
      `SELECT start_break, break_start_date, break_type, break_duration FROM clockin WHERE id = ?`,
      [clockinId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "Clock-in not found" });
    }

    const { start_break, break_start_date, break_type } = rows[0];

 
    if (!start_break || !break_start_date) {
      logger.warn("Missing start_break or break_start_date for clockin: " + clockinId);
      return res.status(400).json({ 
        message: "Break start data missing. Please start a break before stopping it." 
      });
    }


    const breakStartString = `${break_start_date}T${start_break}`;
    const breakStart = new Date(breakStartString);
    if (isNaN(breakStart.getTime())) {
      logger.warn(`Invalid break_start_date or start_break for clockin: ${clockinId} ${break_start_date} ${start_break}`);
      return res.status(400).json({ message: "Invalid break start date/time on record. Please start a new break and try again." });
    }

    const durationMs = Math.max(0, now - breakStart);

    const hours = Math.floor(durationMs / 3600000).toString().padStart(2, '0');
    const minutes = Math.floor((durationMs % 3600000) / 60000).toString().padStart(2, '0');
    const seconds = Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0');
    const break_duration = `${hours}:${minutes}:${seconds}`; // current break duration

    const prevBreak = rows[0]?.break_duration;
    const toSec = (s) => {
      if (!s) return 0;
      const [hh, mm, ss] = s.toString().split(':').map(Number);
      if ([hh, mm, ss].some(isNaN)) return 0;
      return hh * 3600 + mm * 60 + ss;
    };
    const secToHms = (t) => {
      const hh = Math.floor(t / 3600).toString().padStart(2, '0');
      const mm = Math.floor((t % 3600) / 60).toString().padStart(2, '0');
      const ss = Math.floor(t % 60).toString().padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    };
    const totalBreakSeconds = toSec(prevBreak) + toSec(break_duration);
    const total_break_duration = secToHms(totalBreakSeconds);


    await pool.query(
      `UPDATE clockin 
       SET stop_break = ?, 
           break_stop_date = ?, 
           break_duration = ?, 
           is_break = FALSE
       WHERE id = ?`,
      [stop_break, break_stop_date, total_break_duration, clockinId]
    );

    res.status(200).json({
      message: "Break stopped",
      break_type,
      break_duration: total_break_duration,
      is_break: false
    });

  } catch (err) {
    logger.error("Error stopping break:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/clockin-user", auth.authenticateToken, async (req, res) => {
  let connection;
    try {
      connection = await pool.getConnection();
    const userId = req.user.id; // user ID from token

    const [rows] = await connection.query(
      `SELECT
         c.id, 
         c.job_id, j.name AS job_name,
         c.task_id, t.taskName,
         c.start_time, c.start_date,
         c.stop_time, c.stop_date,
         c.task_duration,
         c.start_break, c.stop_break,
         c.break_duration,
         c.break_start_date, c.break_stop_date,
         c.created_by, c.created_at
       FROM clockin c
       LEFT JOIN job j ON c.job_id = j.id
       LEFT JOIN job_task_assignment t ON c.task_id = t.id
       WHERE c.created_by = ?
       ORDER BY c.created_at DESC Limit 4`,
      [userId]
    );

    res.status(200).json({
      message: "Fetched clock-in entries for user",
      data: rows,
    });
  } catch (err) {
    logger.error("Error fetching user clock-in data:", err);
    res.status(500).json({ message: "Server error" });
  }
  finally {
    if (connection) connection.release();
  }
});

// Compute per-day regular and overtime hours from task_duration
router.get('/daily-hours', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
     const userId = req.user.id;

    const shouldRetryDbError = (err) => {
      const code = err && (err.code || err.errno);
      return (
        code === 'ETIMEDOUT' ||
        code === 'PROTOCOL_CONNECTION_LOST' ||
        code === 'ECONNRESET' ||
        code === 'EPIPE'
      );
    };

    const executeWithRetry = async (sql, params) => {
      try {
        return await connection.execute(sql, params);
      } catch (err) {
        if (!shouldRetryDbError(err)) throw err;
        try {
          if (connection) connection.release();
        } catch (_) {}
        connection = await pool.getConnection();
        return await connection.execute(sql, params);
      }
    };

    const toYmd = (d) => formatLocalDate(d);

    // Always use current week (Mon-Sun), ignore query params
    let startDate, endDate;
    const now = new Date();
    const d = new Date(now);
    const dow = d.getDay();
    const diff = d.getDate() - dow + (dow === 0 ? -6 : 1); // Monday
    d.setDate(diff);
    d.setHours(0,0,0,0);
    const start = d;
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23,59,59,999);
    startDate = toYmd(start);
    endDate = toYmd(end);

    const [rows] = await executeWithRetry(`
      SELECT DATE(COALESCE(c.stop_date, c.start_date)) AS work_date,
             SUM(COALESCE(TIME_TO_SEC(c.task_duration),0)) AS work_sec
      FROM clockin c
      WHERE c.created_by = ?
        AND DATE(COALESCE(c.stop_date, c.start_date)) BETWEEN ? AND ?
      GROUP BY DATE(COALESCE(c.stop_date, c.start_date))
      ORDER BY DATE(COALESCE(c.stop_date, c.start_date)) ASC
    `, [userId, startDate, endDate]);

    // Aggregate breaks by type per day
    const [breakRows] = await executeWithRetry(`
      SELECT DATE(COALESCE(c.break_stop_date, c.break_start_date)) AS break_date,
             COALESCE(c.break_type, '') AS break_type,
             SUM(COALESCE(TIME_TO_SEC(c.break_duration),0)) AS break_sec
      FROM clockin c
      WHERE c.created_by = ?
        AND DATE(COALESCE(c.break_stop_date, c.break_start_date)) BETWEEN ? AND ?
      GROUP BY DATE(COALESCE(c.break_stop_date, c.break_start_date)), COALESCE(c.break_type, '')
      ORDER BY DATE(COALESCE(c.break_stop_date, c.break_start_date)) ASC
    `, [userId, startDate, endDate]);

    const map = new Map(
      rows.map(r => {
        const key = (r.work_date instanceof Date)
          ? formatLocalDate(r.work_date)
          : (() => { const d = new Date(r.work_date); return isNaN(d.getTime()) ? String(r.work_date) : formatLocalDate(d); })();
        return [key, Number(r.work_sec) || 0];
      })
    );

    // Build break maps (paid and lunch) in seconds
    const breakPaidMap = new Map();
    const breakLunchMap = new Map();
    for (const br of breakRows) {
      const key = (br.break_date instanceof Date)
        ? formatLocalDate(br.break_date)
        : (() => { const d = new Date(br.break_date); return isNaN(d.getTime()) ? String(br.break_date) : formatLocalDate(d); })();
      const sec = Number(br.break_sec) || 0;
      const type = String(br.break_type || '').toLowerCase();
      // Treat any type containing 'lunch' as lunch break
      if (type.includes('lunch')) {
        breakLunchMap.set(key, (breakLunchMap.get(key) || 0) + sec);
      // Treat any type containing 'paid' OR exactly 'break' as paid break
      } else if (type.includes('paid') || type === 'break') {
        breakPaidMap.set(key, (breakPaidMap.get(key) || 0) + sec);
      }
    }

    const parseYmd = (s) => {
      const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };
    const startD = parseYmd(startDate);
    const endD = parseYmd(endDate);
    if (!startD || !endD) return res.status(400).json({ message: 'Invalid date range' });

    const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const fmt = (mins) => `${Math.floor(mins/60)}:${String(Math.round(mins%60)).padStart(2,'0')}`;

    const days = [];
    let totReg = 0, totOt = 0;
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate()+1)) {
      const key = toYmd(d);
      const sec = map.get(key) || 0;
      const paidBreakSec = breakPaidMap.get(key) || 0;
      const lunchBreakSec = breakLunchMap.get(key) || 0;
      const hrs = sec / 3600;
      const reg = Math.min(8, hrs);
      const ot = Math.max(0, hrs - 8);
      const regMin = reg * 60;
      const otMin = ot * 60;
      totReg += regMin; totOt += otMin;

      days.push({
        date: key,
        day: labels[d.getDay()],
        regular: fmt(regMin),
        paid_break: fmt(paidBreakSec / 60),
        lunch_break: fmt(lunchBreakSec / 60),
        overtime: fmt(otMin),
        total: fmt(regMin + otMin),
        total_hours: +(((regMin + otMin)/60).toFixed(2))
      });
    }

    const payload = {
      startDate,
      endDate,
      days,
      totals: {
        regular: fmt(totReg),
        overtime: fmt(totOt),
        all: fmt(totReg + totOt)
      },
      weeklyTotalHours: +(((totReg + totOt)/60).toFixed(2))
    };
    if (String(req.query?.debug) === '1') {
      payload.debug = {
        userId,
        rowsCount: Array.isArray(rows) ? rows.length : 0,
        sample: Array.isArray(rows) && rows.length ? rows.slice(0, 5) : [],
      };
    }
    return res.json(payload);
  } catch (err) {
    const code = err && (err.code || err.errno);
    const isTransientDbError =
      code === 'ETIMEDOUT' ||
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE';

    // Don't crash UI / server on intermittent DB disconnects; return safe response.
    if (isTransientDbError) {
      return res.status(200).json({
        startDate: null,
        endDate: null,
        days: [],
        totals: { regular: '0:00', overtime: '0:00', all: '0:00' },
        weeklyTotalHours: 0,
      });
    }

    logger.error('Error computing daily hours:', err);

    return res.status(500).json({ message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// status of is_task_active or not
router.get('/active-clockin/:userId', auth.authenticateToken, async (req, res) => {
  const userId = req.params.userId;
let connection;
    try {
      connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT 
         c.id, c.job_id, c.task_id,
         DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_date,
         c.start_time,
         DATE_FORMAT(c.break_start_date, '%Y-%m-%d') AS break_start_date,
         c.start_break,
         c.is_task_active, c.is_break,
         c.break_duration,
         j.name AS job_name, t.taskName
       FROM clockin c
       LEFT JOIN job j ON j.id = c.job_id
       LEFT JOIN job_task_assignment t ON t.id = c.task_id
       WHERE c.created_by = ? AND c.is_task_active = TRUE
       ORDER BY c.id DESC
       LIMIT 1`,
      [userId]
    );

    const r = rows[0] || null;
    if (!r) {
      return res.json(null);
    }

    // Compute robust restore helpers
    const toSec = (s) => {
      if (!s) return 0;
      const [hh, mm, ss] = s.toString().split(':').map(Number);
      if ([hh, mm, ss].some(isNaN)) return 0;
      return hh * 3600 + mm * 60 + ss;
    };

    const now = new Date();


    let startEpochMs = null;
    if (r.start_date && r.start_time) {
      const composed = `${r.start_date}T${r.start_time}`;
      const parsed = new Date(composed);
      startEpochMs = isNaN(parsed.getTime()) ? null : parsed.getTime();
    }

    let breakStartEpochMs = null;
    if (r.is_break && r.break_start_date && r.start_break) {
      const composedB = `${r.break_start_date}T${r.start_break}`;
      const parsedB = new Date(composedB);
      breakStartEpochMs = isNaN(parsedB.getTime()) ? null : parsedB.getTime();
    }

    const cumulativeBreakSec = toSec(r.break_duration);
    const runningBreakSec = breakStartEpochMs ? Math.max(0, Math.floor((now.getTime() - breakStartEpochMs) / 1000)) : 0;
    const totalBreakSec = cumulativeBreakSec + runningBreakSec;

    let elapsedWorkSec = 0;
    if (startEpochMs) {
      const elapsedSec = Math.max(0, Math.floor((now.getTime() - startEpochMs) / 1000));
      elapsedWorkSec = Math.max(0, elapsedSec - totalBreakSec);
    }

    r.start_epoch_ms = startEpochMs;
    r.break_start_epoch_ms = breakStartEpochMs;
    r.elapsed_work_seconds = elapsedWorkSec;
    r.running_break_seconds = runningBreakSec;
    r.total_break_seconds = totalBreakSec;

    res.json(r);
  } catch (err) {
    logger.error("MySQL query error:", err);
    res.status(500).json({ error: "Database error" });
  }
  finally {
    if (connection) connection.release();
  }
});

router.get('/clockin-all',  async (req, res) => {
let connection;
    try {
      connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT
         c.id, c.job_id, j.name,
         c.task_id, t.taskName,
         c.start_time, c.start_date,
         c.stop_time, c.stop_date,
         c.task_duration,
         c.start_break, c.stop_break,
         c.break_duration,
         c.break_start_date, c.break_stop_date,
         c.created_by, c.created_at
       FROM clockin c
       LEFT JOIN job j ON c.job_id = j.id
       LEFT JOIN job_task_assignment t ON c.task_id = t.id
       ORDER BY c.created_at DESC`
    );
    res.status(200).json({ message: "All clock-in entries", data: rows });
  } catch (err) {
    logger.error("Error fetching clock-in data:", err);
    res.status(500).json({ message: "Server error" });
  }
  finally {
    if (connection) connection.release();
  }
});

// GET /clockin/report — job-based time report for the logged-in user.
// Filters (all optional): ?job_id= &from=YYYY-MM-DD &to=YYYY-MM-DD. Returns the
// completed time entries + totals per job and per day + grand total. Self-scoped
// (created_by = requester) so no cross-user leakage; owner/admin cross-user
// filtering ("filter by user") should layer on the existing timecard-approval
// account/role scoping as a follow-up.
router.get('/report', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { job_id, from, to } = req.query;
  const ymd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const fromYmd = ymd(from), toYmd = ymd(to);
  try {
    const where = ['c.created_by = ?', 'c.is_task_active = FALSE'];
    const params = [userId];
    if (job_id != null && /^\d+$/.test(String(job_id))) { where.push('c.job_id = ?'); params.push(Number(job_id)); }
    if (fromYmd) { where.push('DATE(COALESCE(c.stop_date, c.start_date)) >= ?'); params.push(fromYmd); }
    if (toYmd) { where.push('DATE(COALESCE(c.stop_date, c.start_date)) <= ?'); params.push(toYmd); }

    const [entries] = await pool.query(
      `SELECT c.id, c.job_id, j.name AS job_name, c.task_id,
              c.start_date, c.start_time, c.stop_date, c.stop_time,
              c.task_duration, c.additional_notes AS notes,
              DATE(COALESCE(c.stop_date, c.start_date)) AS work_date,
              COALESCE(TIME_TO_SEC(c.task_duration), 0) AS duration_sec
         FROM clockin c
         LEFT JOIN job j ON j.id = c.job_id
        WHERE ${where.join(' AND ')}
        ORDER BY work_date DESC, c.stop_time DESC`,
      params
    );

    const secToHms = (t) => {
      const s = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
      const p = (n) => String(n).padStart(2, '0');
      return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    };
    const dayKey = (v) => (v instanceof Date ? formatLocalDate(v) : String(v || ''));

    const jobMap = new Map(); const dayMap = new Map(); let totalSec = 0;
    for (const e of entries) {
      const sec = Number(e.duration_sec) || 0;
      totalSec += sec;
      const jk = e.job_id == null ? 'none' : String(e.job_id);
      const j = jobMap.get(jk) || { job_id: e.job_id ?? null, job_name: e.job_name || 'No Job', seconds: 0 };
      j.seconds += sec; jobMap.set(jk, j);
      const dk = dayKey(e.work_date);
      const d = dayMap.get(dk) || { date: dk, seconds: 0 };
      d.seconds += sec; dayMap.set(dk, d);
    }
    res.status(200).json({
      entries,
      totalsPerJob: [...jobMap.values()].map((x) => ({ ...x, hms: secToHms(x.seconds) })).sort((a, b) => b.seconds - a.seconds),
      totalsPerDay: [...dayMap.values()].map((x) => ({ ...x, hms: secToHms(x.seconds) })).sort((a, b) => (a.date < b.date ? 1 : -1)),
      totalSeconds: totalSec,
      totalHms: secToHms(totalSec),
    });
  } catch (err) {
    logger.error('Clock-in report error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

