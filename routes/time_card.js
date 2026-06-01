const express = require("express");
const router = express.Router();
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");


// get all employees of a user


router.get('/employees', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const userId = req.user.id;
    const userRole = req.user.role;

    let { startDate, endDate, jobSite, department } = req.query;

    // Normalize dates
    startDate = normalizeToYMD(startDate);
    endDate = normalizeToYMD(endDate);
    if (startDate && !endDate) {
      const [rows] = await connection.query(
        'SELECT DATE_ADD(?, INTERVAL 6 DAY) AS autoEnd',
        [startDate]
      );
      endDate = rows[0].autoEnd;
    }
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      const tmp = startDate; startDate = endDate; endDate = tmp;
    }

    // ---------------- ROLE CHECK ----------------
    // If employee login (roles 2,3,4,5), fetch only self data
    let targetUsers = [];
    if ([2, 3, 4, 5].includes(userRole)) {
      const [self] = await connection.execute(
        `SELECT id AS user_id, name, email, mobile, status AS user_status,rate
         FROM user
         WHERE id = ?`, [userId]
      );
      targetUsers = self;
    } else {
      // General contractor login (role = 1)
      const employeesSql = `
        SELECT 
          u.id AS user_id, 
          u.name, 
          u.email, 
          u.mobile, 
          u.status AS user_status,
          u.rate AS rate
        FROM user u
        WHERE u.created_by = ?
          AND u.role IN (2,3,4,5)
          AND (? IS NULL OR u.category = ?)
        ORDER BY u.created_at DESC
      `;
      const [employees] = await connection.execute(employeesSql, [userId, department || null, department || null]);
      targetUsers = employees;
    }

    // If no employees/self found
    if (!targetUsers.length) {
      return res.json([]);
    }

    const targetIds = targetUsers.map(u => u.user_id);

    // ---------------- Conditions for logs ----------------
    const onConds = [`cl.created_by IN (${targetIds.map(() => '?').join(',')})`];
    const onParams = [...targetIds];

    if (startDate && endDate) {
      onConds.push('cl.start_date BETWEEN ? AND ?');
      onParams.push(startDate, endDate);
    } else {
      onConds.push('YEARWEEK(cl.start_date, 1) = YEARWEEK(CURDATE(), 1)');
    }
    onConds.push('DAYOFWEEK(cl.start_date) BETWEEN 2 AND 6');
    onConds.push('(? IS NULL OR cl.job_id = ?)');
    onParams.push(jobSite || null, jobSite || null);

    // ---------------- Weekly logs ----------------
    const logsSql = `
      SELECT
        t.user_id,
        t.work_date,
        DAYOFWEEK(t.work_date) AS weekday,
        SEC_TO_TIME(SUM(t.sec)) AS total_duration,
        SUM(t.sec) AS total_sec,
        CASE 
          WHEN SUM(CASE WHEN t.status = 'paid' THEN 1 ELSE 0 END) = COUNT(*) 
            THEN 'paid'
          WHEN SUM(CASE WHEN t.status IN ('approved','paid') THEN 1 ELSE 0 END) = COUNT(*)
            THEN 'approved'
          ELSE 'pending'
        END AS status

      FROM (
        SELECT
          cl.created_by AS user_id,
          DATE(cl.start_date) AS work_date,
          COALESCE(TIME_TO_SEC(cl.task_duration), 0) AS sec,
          cl.status
        FROM clockin cl
        WHERE ${onConds.join(' AND ')}
      ) AS t
      WHERE t.work_date IS NOT NULL
      GROUP BY t.user_id, t.work_date
      ORDER BY t.user_id, t.work_date
    `;
    const [dailyLogs] = await connection.execute(logsSql, onParams);

    // ---------------- Current day status ----------------
    const statusSql = `
      SELECT 
        u.id AS user_id,
        cl.start_time, cl.stop_time,
        cl.start_break, cl.stop_break,
        cl.is_task_active, cl.is_break
      FROM user u
      LEFT JOIN clockin cl
        ON cl.id = (
          SELECT c.id
          FROM clockin c
          WHERE c.created_by = u.id
            AND DATE(c.start_date) = CURDATE()
          ORDER BY c.created_at DESC
          LIMIT 1
        )
      WHERE u.id IN (${targetIds.map(() => '?').join(',')})
    `;
    const [currentStatus] = await connection.execute(statusSql, targetIds);

    // ---------------- Monthly & Yearly totals ----------------
    const monthlyYearlySql = `
      SELECT 
        u.id AS user_id,
        ROUND(SUM(CASE WHEN YEAR(cl.start_date)=YEAR(CURDATE()) 
                        AND MONTH(cl.start_date)=MONTH(CURDATE()) 
                       THEN TIME_TO_SEC(cl.task_duration)/3600 ELSE 0 END),2) AS month_hours,
        ROUND(SUM(CASE WHEN YEAR(cl.start_date)=YEAR(CURDATE()) 
                       THEN TIME_TO_SEC(cl.task_duration)/3600 ELSE 0 END),2) AS year_hours
      FROM user u
      LEFT JOIN clockin cl
        ON cl.created_by = u.id
      WHERE u.id IN (${targetIds.map(() => '?').join(',')})
      GROUP BY u.id
    `;
    const [monthlyYearly] = await connection.execute(monthlyYearlySql, targetIds);

    // ---------------- Combine all data ----------------
    const result = targetUsers.map(emp => {
      const weekLogs = dailyLogs.filter(w => w.user_id === emp.user_id);
      let overallStatus = 'pending';
      if (weekLogs.length > 0) {
        const hasPending = weekLogs.some(l => (l.status || '').toLowerCase() === 'pending');
        const hasPaid = weekLogs.some(l => (l.status || '').toLowerCase() === 'paid');

        if (!hasPending && hasPaid) {
          overallStatus = 'paid';
        } else if (!hasPending) {
          overallStatus = 'approved';
        }
      }

      const totals = monthlyYearly.find(m => m.user_id === emp.user_id) || { month_hours: 0, year_hours: 0 };

      return {
        ...emp,
        weeklyLogs: weekLogs,
        currentStatus: currentStatus.find(cs => cs.user_id === emp.user_id) || null,
        overallStatus,
        monthlyHours: totals.month_hours,
        yearlyHours: totals.year_hours
      };
    });

    res.json(result);

  } catch (err) {
    logger.error('Error fetching employees:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// QuickBooks CSV export for GC: employees' paid/approved hours over a date range
router.get('/qb-export', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const managerId = req.user.id;
    let { startDate, endDate } = req.query;

    // Normalize dates
    startDate = normalizeToYMD(startDate);
    endDate = normalizeToYMD(endDate);

    if (startDate && !endDate) {
      const [rows] = await connection.query(
        'SELECT DATE_ADD(?, INTERVAL 6 DAY) AS autoEnd',
        [startDate]
      );
      endDate = rows[0].autoEnd;
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required' });
    }

    if (new Date(startDate) > new Date(endDate)) {
      const tmp = startDate; startDate = endDate; endDate = tmp;
    }

    const sql = `
      SELECT
        u.name AS employee_name,
        DATE(cl.start_date) AS work_date,
        ROUND(COALESCE(TIME_TO_SEC(cl.task_duration) / 3600, 0), 2) AS hours,
        COALESCE(u.rate, 0) AS rate,
        ROUND(COALESCE(TIME_TO_SEC(cl.task_duration) / 3600, 0) * COALESCE(u.rate, 0), 2) AS amount,
        cl.status
      FROM clockin cl
      INNER JOIN user u ON u.id = cl.created_by
      WHERE u.created_by = ?
        AND DATE(cl.start_date) BETWEEN ? AND ?
        AND DAYOFWEEK(cl.start_date) BETWEEN 2 AND 6
        AND cl.status IN ('approved', 'paid')
      ORDER BY u.name, work_date;
    `;

    const [rows] = await connection.execute(sql, [managerId, startDate, endDate]);

    // Build CSV
    const header = 'Employee,Date,Hours,Rate,Amount,Status';
    const csvLines = rows.map(r => {
      const employee = (r.employee_name || '').toString().replace(/"/g, '""');
      const date = r.work_date || '';
      const hours = Number(r.hours || 0).toFixed(2);
      const rate = Number(r.rate || 0).toFixed(2);
      const amount = Number(r.amount || 0).toFixed(2);
      const status = (r.status || '').toString();
      return `"${employee}",${date},${hours},${rate},${amount},${status}`;
    });

    const csv = [header, ...csvLines].join('\n');

    const filename = `quickbooks_payroll_${startDate}_to_${endDate}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error('Error generating QuickBooks CSV export:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// GC self summary: total clock-in hours for the logged-in GC over a date range
router.get('/gc-hours', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const gcId = req.user.id;
    let { startDate, endDate } = req.query;

    // Normalize dates similar to /employees
    startDate = normalizeToYMD(startDate);
    endDate = normalizeToYMD(endDate);

    if (startDate && !endDate) {
      const [rows] = await connection.query(
        'SELECT DATE_ADD(?, INTERVAL 6 DAY) AS autoEnd',
        [startDate]
      );
      endDate = rows[0].autoEnd;
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required' });
    }

    if (new Date(startDate) > new Date(endDate)) {
      const tmp = startDate; startDate = endDate; endDate = tmp;
    }

    const sql = `
      SELECT
        ROUND(COALESCE(SUM(TIME_TO_SEC(cl.task_duration)) / 3600, 0), 2) AS total_hours
      FROM clockin cl
      WHERE cl.created_by = ?
        AND DATE(cl.start_date) BETWEEN ? AND ?
        AND DAYOFWEEK(cl.start_date) BETWEEN 2 AND 6
    `;

    const [rows] = await connection.execute(sql, [gcId, startDate, endDate]);
    const totalHours = rows && rows.length ? Number(rows[0].total_hours) || 0 : 0;

    res.json({ totalHours });
  } catch (err) {
    logger.error('Error fetching GC hours summary:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Dashboard: Today's labor cost and active workers
router.get('/dashboard/today-labor', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const managerId = req.user.id;

    // Aggregate today's seconds per employee with their rate
    const sql = `
      SELECT 
        u.id AS user_id,
        COALESCE(u.rate, 0) AS rate,
        COALESCE(SUM(TIME_TO_SEC(c.task_duration)), 0) AS sec
      FROM user u
      LEFT JOIN clockin c 
        ON c.created_by = u.id 
       AND DATE(c.start_date) = CURDATE()
      WHERE u.created_by = ?
        AND u.role IN (2,3,4,5)
      GROUP BY u.id, u.rate
    `;

    const [rows] = await connection.execute(sql, [managerId]);

    let totalSec = 0;
    let laborCost = 0;
    let activeWorkers = 0;

    rows.forEach(r => {
      const sec = Number(r.sec) || 0;
      const rate = Number(r.rate) || 0;
      totalSec += sec;
      if (sec > 0) activeWorkers += 1;
      laborCost += (sec / 3600) * rate;
    });

    const totalHours = +(totalSec / 3600).toFixed(2);
    const totalCost = +laborCost.toFixed(2);

    res.json({
      date: new Date().toISOString().split('T')[0],
      totalHours,
      laborCost: totalCost,
      activeWorkers,
    });
  } catch (err) {
    logger.error('Error computing today labor cost:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});




// get each user time log
function getWeekRange(offset = 0) {
  const now = new Date();
  const day = now.getDay() || 7; // Sunday=0 â†’ 7
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  friday.setHours(23, 59, 59, 999);

  return { start: monday, end: friday };
}

router.get("/time-logs/:userId", async (req, res) => {
  const userId = req.params.userId;

  // Support explicit date range via startDate/endDate, falling back
  // to weekOffset-based current-week logic if dates are not provided.
  let { startDate, endDate } = req.query;
  const weekOffset = parseInt(req.query.weekOffset || "0", 10);

  if (startDate || endDate) {
    // Normalize incoming dates to YYYY-MM-DD
    startDate = normalizeToYMD(startDate) || normalizeToYMD(endDate);
    endDate = normalizeToYMD(endDate) || startDate;

    // If only one date was effectively provided, auto-end to +4 days (Monâ€“Fri)
    if (startDate && !endDate) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + 4);
      endDate = d.toISOString().slice(0, 10);
    }

    // Ensure startDate <= endDate
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
  } else {
    const { start, end } = getWeekRange(weekOffset);
    startDate = start.toISOString().slice(0, 10);
    endDate = end.toISOString().slice(0, 10);
  }

  try {
    const [rows] = await pool.execute(
      `SELECT 
          c.id,
          c.job_id,
          c.task_id,
          c.start_time,
          c.start_date,
          c.stop_time,
          c.stop_date,
          c.start_break,
          c.stop_break,
          c.break_duration,
          c.status,
          c.self_approve,
          c.additional_notes,
          j.name AS job_name,
          t.task_name AS task_name
       FROM clockin c
       LEFT JOIN job j ON j.id = c.job_id
       LEFT JOIN tasks t ON t.id = c.task_id
       WHERE c.created_by = ?
         AND c.start_date BETWEEN ? AND ?
         AND DAYOFWEEK(c.start_date) BETWEEN 2 AND 6  -- Mon=2â€¦Fri=6
       ORDER BY c.start_date, c.start_time`,
      [userId, startDate, endDate]
    );

    // --- group logs by date only ---
    const daysMap = {}; // { '2025-09-15': {date, day, logs[]} }

    rows.forEach(log => {
      const dateKey = log.start_date;
      if (!daysMap[dateKey]) {
        daysMap[dateKey] = {
          date: dateKey,
          day: new Date(dateKey).toLocaleDateString('en-US', { weekday: 'long' }),
          logs: []
        };
      }

      daysMap[dateKey].logs.push({
        id: log.id,
        jobId: log.job_id,
        taskId: log.task_id,
        clockIn: log.start_time || null,
        clockOut: log.stop_time || null,
        breakStart: log.start_break || null,
        breakEnd: log.stop_break || null,
        breakDuration: log.break_duration || null,
        status: log.status || null,
        selfApprove: log.self_approve || null,
        jobName: log.job_name || null,
        taskName: log.task_name || null,
        remarks: log.additional_notes || null,
      });
    });

    const days = Object.values(daysMap).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    res.json({
      userId,
      weekStart: startDate,
      weekEnd: endDate,
      days
    });
  } catch (err) {
    logger.error("Error fetching user logs:", err);
    res.status(500).json({
      message: 'Database error',
      error: err.message,
    });
  }
});

router.put('/time-logs/approve-job/:id(\\d+)', auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;

    if (!clockinId) {
      return res.status(400).json({ message: 'Missing time log id.' });
    }

    const sql = `
      UPDATE clockin
      SET status = 'approved'
      WHERE id = ?
    `;

    const [result] = await connection.execute(sql, [clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Time log approved successfully.',
      id: clockinId,
      updated: result.affectedRows,
    });

  } catch (err) {
    logger.error('Error approving job timecard:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/time-logs/:id(\\d+)', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;
    const { job_id, start_time, stop_time, break_duration, status } = req.body || {};

    if (!clockinId || !start_time || !stop_time) {
      return res.status(400).json({ message: 'Missing required fields (id, start_time, stop_time).' });
    }

    // Helper: HH:MM:SS -> seconds
    const toSec = (s) => {
      if (!s) return 0;
      const parts = String(s).split(':').map(Number);
      const [hh = 0, mm = 0, ss = 0] = parts;
      if ([hh, mm, ss].some(isNaN)) return 0;
      return hh * 3600 + mm * 60 + ss;
    };

    // Helper: seconds -> HH:MM:SS
    const secToHms = (t) => {
      const safe = Number.isFinite(t) ? t : 0;
      const hh = Math.floor(safe / 3600).toString().padStart(2, '0');
      const mm = Math.floor((safe % 3600) / 60).toString().padStart(2, '0');
      const ss = Math.floor(safe % 60).toString().padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    };

    const startSec = toSec(start_time);
    const stopSec = toSec(stop_time);
    const breakSec = toSec(break_duration || '00:00:00');

    if (stopSec <= startSec) {
      return res.status(400).json({ message: 'stop_time must be after start_time.' });
    }

    const workedSeconds = Math.max(0, stopSec - startSec - breakSec);
    const task_duration = secToHms(workedSeconds);
    const finalBreakHms = secToHms(breakSec);

    const sql = `
      UPDATE clockin
      SET job_id = COALESCE(?, job_id), start_time = ?, stop_time = ?, break_duration = ?, task_duration = ?, status = COALESCE(?, status)
      WHERE id = ?
    `;

    const [result] = await connection.execute(sql, [job_id || null, start_time, stop_time, finalBreakHms, task_duration, status || null, clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Time log updated successfully.',
      id: clockinId,
      task_duration,
      break_duration: finalBreakHms,
    });
  } catch (err) {
    logger.error('Error updating time log:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Delete a single time log (clockin) by its id
router.delete('/time-logs/:id(\\d+)', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;

    if (!clockinId) {
      return res.status(400).json({ message: 'Missing time log id.' });
    }

    const [result] = await connection.execute('DELETE FROM clockin WHERE id = ?', [clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Time log deleted successfully.',
      id: clockinId,
      deleted: result.affectedRows,
    });
  } catch (err) {
    logger.error('Error deleting time log:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Update remarks (additional_notes) for a single time log by its clockin id
router.put('/time-logs/:id/remarks', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;
    const { remarks } = req.body || {};

    if (!clockinId) {
      return res.status(400).json({ message: 'Missing time log id.' });
    }

    const sql = `
      UPDATE clockin
      SET additional_notes = ?
      WHERE id = ?
    `;

    const [result] = await connection.execute(sql, [remarks || null, clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Remarks updated successfully.',
      id: clockinId,
      updated: result.affectedRows,
    });
  } catch (err) {
    logger.error('Error updating time log remarks:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/time-logs/self-approve/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;

    if (!clockinId) {
      return res.status(400).json({ message: 'Missing time log id.' });
    }

    const sql = `
      UPDATE clockin
      SET self_approve = 'approved'
      WHERE id = ?
    `;

    const [result] = await connection.execute(sql, [clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Time log self-approved successfully.',
      id: clockinId,
      updated: result.affectedRows,
    });
  } catch (err) {
    logger.error('Error self-approving time log:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/time-logs/approve-job/:id', auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    const clockinId = req.params.id;

    if (!clockinId) {
      return res.status(400).json({ message: 'Missing time log id.' });
    }

    const sql = `
      UPDATE clockin
      SET status = 'approved'
      WHERE id = ?
    `;

    const [result] = await connection.execute(sql, [clockinId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time log not found.' });
    }

    res.json({
      message: 'Time log approved successfully.',
      id: clockinId,
      updated: result.affectedRows,
    });

  } catch (err) {
    logger.error('Error approving job timecard:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

function normalizeToYMD(s) {
  if (s == null) return undefined;
  if (typeof s !== 'string') s = String(s);
  s = s.trim();

  // Exact YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // ISO / datetime that starts with YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T].*$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // Fallback: Date.parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }

  return undefined;
}

// approve time card api
router.put('/time-logs/approve-week', auth.authenticateToken, async (req, res) => {

  const { employeeId, startDate, endDate } = req.body;
  const approvedBy = req.user.id;  // whoever is logged in

  if (!employeeId || !startDate || !endDate) {
    return res.status(400).json({ message: 'Missing required data' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const sql = `
      UPDATE clockin
      SET status = 'approved'

      WHERE created_by = ?
        AND DATE(start_date) BETWEEN ? AND ?;
    `;
    const [result] = await connection.execute(sql, [employeeId, startDate, endDate]);

    res.json({ message: 'Timecard approved', updated: result.affectedRows });
  } catch (err) {
    logger.error('Error approving timecard:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// mark approved time logs as paid (payroll process for a week range)
router.put('/time-logs/payroll-week', auth.authenticateToken, async (req, res) => {

  const { employeeId, startDate, endDate } = req.body;

  const missing = [];
  if (employeeId == null || employeeId === '') missing.push('employeeId');
  if (!startDate) missing.push('startDate');
  if (!endDate) missing.push('endDate');
  if (missing.length) {
    return res.status(400).json({
      message: `Missing required data: ${missing.join(', ')}`,
    });
  }

  const empId = Number(employeeId);
  if (!Number.isFinite(empId) || empId <= 0) {
    return res.status(400).json({ message: 'Invalid employeeId' });
  }

  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(String(startDate)) || !ymd.test(String(endDate))) {
    return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD.' });
  }

  if (String(startDate) > String(endDate)) {
    return res.status(400).json({ message: 'Invalid date range. startDate cannot be after endDate.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const sql = `
      UPDATE clockin
      SET status = 'paid'
      WHERE created_by = ?
        AND DATE(start_date) BETWEEN ? AND ?
        AND status = 'approved';
    `;
    const [result] = await connection.execute(sql, [empId, startDate, endDate]);

    res.json({ message: 'Timecard marked as paid for payroll', updated: result.affectedRows });
  } catch (err) {
    logger.error('Error processing payroll for timecard:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// 
router.get('/pending-logs/:userId', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const employeeId = req.params.userId;

    const query = `
      SELECT 
          DATE(c.start_date) AS work_date,
          c.id AS clockin_id,
          c.start_time,
          c.stop_time,
          TIME_TO_SEC(TIMEDIFF(c.stop_time, c.start_time))/3600 AS hours_worked,
          c.status AS clockin_status,
          j.address AS job_address,
          j.id AS job_id,
          t.task_name,
          t.id AS task_id
      FROM clockin c
      LEFT JOIN job j ON j.id = c.job_id
      LEFT JOIN tasks t ON t.id = c.task_id
      WHERE c.created_by = ?
        AND c.status = 'pending'
        AND c.start_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
        AND c.start_date <= CURDATE()
      ORDER BY work_date, c.start_time
    `;

    const [rows] = await connection.query(query, [employeeId]);

    const grouped = {};
    rows.forEach(r => {
      const date = r.work_date;
      if (!grouped[date]) {
        grouped[date] = { work_date: date, logs: [], total_hours: 0 };
      }

      const hrs = Number(r.hours_worked) || 0;

      grouped[date].logs.push({
        clockin_id: r.clockin_id,
        clock_in: r.start_time,
        clock_out: r.stop_time,
        hours: +hrs.toFixed(2), // âœ… numeric
        status: r.clockin_status,
        job_id: r.job_id,
        job_address: r.job_address || null,
        task_id: r.task_id,
        task_name: r.task_name || null
      });

      grouped[date].total_hours += hrs;
    });

    const result = Object.values(grouped).map(day => {
      const firstClockin = day.logs.length ? day.logs[0].clock_in : null;
      const lastClockout = day.logs.length ? day.logs[day.logs.length - 1].clock_out : null;
      const total = +Number(day.total_hours).toFixed(2);
      const overtime = total > 8 ? +(total - 8).toFixed(2) : 0;

      return {
        work_date: day.work_date,
        first_clockin: firstClockin,
        last_clockout: lastClockout,
        total_hours: total,
        overtime_hours: overtime,
        clockin_status: day.logs.some(l => l.status === 'pending') ? 'pending' : 'approved',
        job_address: day.logs.find(l => l.job_address)?.job_address || null,
        job_id: day.logs.find(l => l.job_id)?.job_id || null,
        task_name: day.logs.find(l => l.task_name)?.task_name || null,
        task_id: day.logs.find(l => l.task_id)?.task_id || null,
        logs: day.logs
      };
    });

    res.json(result);
  } catch (err) {
    logger.error("Error fetching pending logs:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/current-week', auth.authenticateToken,async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
     const createdBy = req.user.id; 
    // Calculate current week start and end
    const today = new Date();
    const first = today.getDate() - today.getDay() + 1; // Monday
    const last = first + 6; // Sunday

    const startOfWeek = new Date(today.setDate(first)).toISOString().split('T')[0];
    const endOfWeek = new Date(today.setDate(last)).toISOString().split('T')[0];

    // 1ï¸âƒ£ Fetch all employees (users)
    const [users] = await connection.query(`
      SELECT 
        u.id, u.name, u.email, u.role, r.name as role_name,u.image, u.mobile, u.business, u.trade, u.created_by, u.created_at
      FROM user u
      inner join role r on r.id= u.role
      WHERE u.role = 2 And u.created_by = ?
    `, [createdBy]);

    // 2ï¸âƒ£ Fetch timecard entries (clockin table)
    const [timecards] = await connection.query(`
      SELECT 
        c.id,
        c.job_id,
        c.task_id,
        c.start_time,
        c.start_date,
        c.stop_time,
        c.stop_date,
        c.task_duration,
        c.created_by,
        c.status,
        j.name AS job_name,
        t.task_name AS task_name
      FROM clockin c
      LEFT JOIN job j ON j.id = c.job_id
      LEFT JOIN tasks t ON t.id = c.task_id
      WHERE DATE(c.start_date) BETWEEN ? AND ?
    `, [startOfWeek, endOfWeek]);

    // 3ï¸âƒ£ Group timecards by user (created_by)
  // 3ï¸âƒ£ Group timecards by user (created_by)
const employees = users.map(user => {
  const empCards = timecards.filter(t => t.created_by === user.id);

  // âœ… Ensure task_duration is numeric
  const totalHours = empCards.reduce((acc, tc) => {
    const hours = Number(tc.task_duration) || 0;  // <-- convert to number safely
    return acc + hours;
  }, 0);

  const numericHours = Number(totalHours) || 0; // âœ… ensure totalHours is numeric

  return {
    name: user.name,
    initials: user.name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase(),
    position: user.trade || 'Unknown',
    employeeId: 'E' + String(user.id).padStart(3, '0'),
    hired: user.created_at,
    stats: [
      {
        label: 'CURRENT WEEK HOURS',
        value: numericHours.toFixed(1),
        sub: '',
        class: 'neutral',
      },
      {
        label: 'OVERTIME HOURS',
        value: (numericHours > 40 ? numericHours - 40 : 0).toFixed(1),
        sub: 'This pay period',
        class: 'neutral',
      },
      {
        label: 'CURRENT PAY RATE',
        value: '$45.00',
        sub: 'Standard rate',
        class: 'neutral',
      },
      {
        label: 'GROSS PAY (EST)',
        value: `$${(numericHours * 45).toFixed(2)}`,
        sub: 'This period',
        class: 'neutral',
      },
    ],
    timeCards: empCards.map(tc => ({
      date: tc.start_date,
      jobSite: tc.job_name || '-',
      task: tc.task_name || '-',
      clockIn: tc.start_time,
      clockOut: tc.stop_time,
      hours: Number(tc.task_duration) || 0, // âœ… ensure numeric
      status: tc.status || 'Pending',
    })),
  };
});


    res.json({ weekStart: startOfWeek, weekEnd: endOfWeek, employees });
  } catch (err) {
    logger.error('Error fetching employee data:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  } finally {
    if (connection) connection.release();
  }
});


// GET - All jobs sites 
router.get('/jobs', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
      SELECT 
        j.id,
        j.name AS job_name,
        j.city,
        j.state,
        j.zipcode,
        CONCAT(j.name, ' - (', j.city, ', ', j.state, ', ', j.zipcode, ')') AS label
      FROM job j
      ORDER BY j.created_at DESC
    `);

    const formatted = rows.map(row => ({
      id: row.id,
      label: row.label,
      value: row.id,
      city: row.city,
      state: row.state,
      zip_code: row.zip_code
    }));

    res.json({ data: formatted });
  } catch (err) {
    logger.error('Error fetching jobs:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
  });
  // GET - All employees of a user
router.get('/employees-by-user', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
  connection = await pool.getConnection();

    const userId = req.user.id; // from JWT token

    const [rows] = await connection.execute(
      `
      SELECT 
        u.*
      FROM user u
      WHERE u.created_by = ?
      ORDER BY u.created_at DESC
      `,
      [userId]
    );

    res.json({ data: rows });
  } catch (err) {
    logger.error('Error fetching employees:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

  router.post('/add-time-card-entry', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const isManual = 1
    const {
      job_id,
      employee_id,
      date,           // form date
      clock_in,       // "HH:mm"
      clock_out,      // "HH:mm"
      break_minutes,  // e.g. 45
      total_hours,    // e.g. 7.5
      notes,
      additional_notes
    } = req.body;

    // Validate required fields (job_id is optional for manual entries)
    if (!employee_id || !clock_in || !clock_out || !total_hours) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // ðŸ”¹ Convert break minutes (number) â†’ "HH:mm:ss" format
    let breakFormatted = '00:00:00';
    if (break_minutes && !isNaN(break_minutes)) {
      const hrs = Math.floor(break_minutes / 60);
      const mins = break_minutes % 60;
      breakFormatted = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
    }

    // ðŸ”¹ Convert total hours (float) â†’ "HH:mm:ss" (for task_duration)
    const totalSeconds = Math.round(total_hours * 3600);
    const thh = Math.floor(totalSeconds / 3600);
    const tmm = Math.floor((totalSeconds % 3600) / 60);
    const tss = totalSeconds % 60;
    const taskDurationFormatted = `${String(thh).padStart(2, '0')}:${String(tmm).padStart(2, '0')}:${String(tss).padStart(2, '0')}`;

    // âœ… Insert query
    const sql = `
      INSERT INTO clockin (
        job_id,
        created_by,
        start_time,
        stop_time,
        start_date,
        stop_date,
        break_duration,
        task_duration,
        break_start_date,
        break_stop_date,
        notes,
        additional_notes,
        status,
        isManual
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      job_id,
      employee_id,          // created_by
      clock_in,             // start_time
      clock_out,            // stop_time
      date,                 // start_date
      date,                 // stop_date
      breakFormatted,       // break_duration (00:45:00)
      taskDurationFormatted,// task_duration (07:30:00)
      date,                 // break_start_date
      date,                 // break_stop_date
      notes || null,
      additional_notes || null,
      'pending'  ,
      1          
    ];

    const [result] = await connection.execute(sql, values);

    res.status(201).json({
      message: 'Task created successfully',
      taskId: result.insertId,
      status: 'pending'
    });

  } catch (err) {
    logger.error('Error inserting task:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/manual-time-card-entries', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(`
     SELECT 
  c.id,
  c.job_id,
  c.created_by,
  u.name AS employee_name,
  j.name AS job_name,
  c.start_date,
  c.start_time,
  c.stop_time,
  c.break_duration,
  c.task_duration,
  c.notes,
  c.additional_notes
FROM clockin c
LEFT JOIN user u ON c.created_by = u.id
LEFT JOIN job j ON c.job_id = j.id
WHERE c.isManual = 1
ORDER BY c.start_date DESC;

    `);

    const data = rows.map(r => ({
      id: r.id,
      job_id: r.job_id,
      job_name: `${r.job_name} (${r.city}, ${r.state}, ${r.zip_code})`,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      start_date: r.start_date,
      stop_date: r.stop_date,
      start_time: r.start_time,
      stop_time: r.stop_time,
      break_duration: r.break_duration,
      task_duration: r.task_duration,
      notes: r.notes,
      additional_notes: r.additional_notes,
      status: r.status,
      isManual: r.isManual
    }));

    res.json({ data });
  } catch (err) {
    logger.error('Error fetching manual timecard entries:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/update-time-card-entry/:id', auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    const { id } = req.params;

    const {
      job_id,
      employee_id,
      date,           // form date (YYYY-MM-DD)
      clock_in,       // "HH:mm"
      clock_out,      // "HH:mm"
      break_minutes,  // number (e.g. 45)
      total_hours,    // number (e.g. 7.5)
      notes,
      additional_notes
    } = req.body;

    // Validation
    if (!id || !job_id || !employee_id || !clock_in || !clock_out || !total_hours) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // Format break minutes into HH:mm:ss
    let breakFormatted = '00:00:00';
    if (break_minutes && !isNaN(break_minutes)) {
      const hrs = Math.floor(break_minutes / 60);
      const mins = break_minutes % 60;
      breakFormatted = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
    }

    // Convert total hours (e.g. 7.5) â†’ "HH:mm:ss"
    const totalSeconds = Math.round(total_hours * 3600);
    const thh = Math.floor(totalSeconds / 3600);
    const tmm = Math.floor((totalSeconds % 3600) / 60);
    const tss = totalSeconds % 60;
    const taskDurationFormatted = `${String(thh).padStart(2, '0')}:${String(tmm).padStart(2, '0')}:${String(tss).padStart(2, '0')}`;


    const sql = `
      UPDATE clockin
      SET 
        job_id = ?,
        created_by = ?,
        start_time = ?,
        stop_time = ?,
        start_date = ?,
        stop_date = ?,
        break_duration = ?,
        task_duration = ?,
        break_start_date = ?,
        break_stop_date = ?,
        notes = ?,
        additional_notes = ?
      WHERE id = ? AND isManual = 1
    `;

    const values = [
      job_id,
      employee_id,
      clock_in,
      clock_out,
      date,
      date,
      breakFormatted,
      taskDurationFormatted,
      date,
      date,
      notes || null,
      additional_notes || null,
      id
    ];

    const [result] = await connection.execute(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Manual timecard entry not found or not manual.' });
    }

    res.status(200).json({
      message: 'Manual timecard entry updated successfully.',
      updatedId: id
    });

  } catch (err) {
    logger.error('Error updating manual timecard entry:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

//  Approve all timecard entries for a specific day of an employee
router.put('/time-logs/approve-day', auth.authenticateToken, async (req, res) => {
  let connection;
  
  try {
    connection = await pool.getConnection();

    const { employeeId, workDate } = req.body; // YYYY-MM-DD format
    const approvedBy = req.user.id;

    if (!employeeId || !workDate) {
      return res.status(400).json({ message: 'Missing required fields (employeeId, workDate).' });
    }

    const sql = `
      UPDATE clockin
      SET status = 'approved'
      WHERE created_by = ?
        AND DATE(start_date) = ?
    `;

    const [result] = await connection.execute(sql, [employeeId, workDate]);

    res.json({
      message: 'All timecard entries for the day approved successfully.',
      approvedCount: result.affectedRows,
      date: workDate,
    });

  } catch (err) {
    logger.error('Error approving day timecards:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/leave_request", auth.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const sql = `
      SELECT 
        lr.id,
        lr.emp_id,
        lr.leave_type_id,
        lr.from_date,
        lr.to_date,
        lr.created_by,
        lr.created_at,
        lr.approver,
        lr.manager_id,
        lr.status,
        el.leave_type,
        u.name AS employee_name
      FROM leave_request lr
      LEFT JOIN user u ON lr.emp_id = u.id
      LEFT JOIN employees_leaves el ON el.id = lr.leave_type_id
      WHERE lr.created_by = ?
      ORDER BY lr.created_at DESC
    `;

    const [rows] = await pool.query(sql, [userId]);

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error("Error fetching leave requests:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leave requests",
      error: err.message,
    });
  }
});

router.post("/leave_request", async (req, res) => {
  try {
    const {
      emp_id,
      leave_type_id,
      from_date,
      to_date,
      created_by,
      approver,
    } = req.body;

    // Basic validation
    if (!emp_id || !leave_type_id || !from_date || !to_date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

     const [managerRow] = await pool.query(
      `SELECT created_by FROM user WHERE id = ?`,
      [emp_id]
    );

    if (managerRow.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const manager_id = managerRow[0].created_by || null;

    const [result] = await pool.query(
      `INSERT INTO leave_request 
        (emp_id, leave_type_id, from_date, to_date, created_by, created_at, approver, manager_id)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [emp_id, leave_type_id, from_date, to_date, created_by || emp_id, approver || null, manager_id || null]
    );

    res.status(201).json({
      success: true,
      message: "Leave request created successfully",
      data: { id: result.insertId },
    });
  } catch (err) {
    logger.error("Error creating leave request:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create leave request",
      error: err.message,
    });
  }
});

router.get('/leave-types', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(`
      SELECT id, leave_type  FROM employees_leaves ORDER BY id ASC`
    );

    res.status(200).json({
      success: true,
      message: 'Leave types fetched successfully',
      data: rows,
    });
  } catch (err) {
    logger.error('Error fetching leave types:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave types',
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// NEW GC API: get applied leaves for employees managed by this GC (manager_id = logged-in user)
router.get('/leave_request/gc', auth.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id; // GC / manager id

    const sql = `
      SELECT 
        lr.id,
        lr.emp_id,
        lr.leave_type_id,
        lr.from_date,
        lr.to_date,
        lr.created_by,
        lr.created_at,
        lr.approver,
        lr.manager_id,
        lr.status,
        el.leave_type,
        u.name AS employee_name
      FROM leave_request lr
      LEFT JOIN user u ON lr.emp_id = u.id
      LEFT JOIN employees_leaves el ON el.id = lr.leave_type_id
      WHERE lr.manager_id = ?
      ORDER BY lr.created_at DESC
    `;

    const [rows] = await pool.query(sql, [userId]);

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error('Error fetching GC leave requests:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch GC leave requests',
      error: err.message,
    });
  }
});

// Approve leave from time_card context
router.put('/approve-leave/:leaveId', auth.authenticateToken, async (req, res) => {
  try {
    const { leaveId } = req.params;
    const approverId = req.user.id;

    const [result] = await pool.query(
      `UPDATE leave_request
       SET status = 'approved', approver = ? 
       WHERE id = ?`,
      [approverId, leaveId]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: 'Leave not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Leave approved successfully',
    });
  } catch (err) {
    logger.error('Error approving leave (time_card):', err);
    res.status(500).json({
      success: false,
      message: 'Failed to approve leave',
      error: err.message,
    });
  }
});

// Reject leave from time_card context
router.put('/reject-leave/:leaveId', auth.authenticateToken, async (req, res) => {
  try {
    const { leaveId } = req.params;
    const approverId = req.user.id;

    const [result] = await pool.query(
      `UPDATE leave_request
       SET status = 'rejected', approver = ? 
       WHERE id = ?`,
      [approverId, leaveId]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: 'Leave not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Leave rejected successfully',
    });
  } catch (err) {
    logger.error('Error rejecting leave (time_card):', err);
    res.status(500).json({
      success: false,
      message: 'Failed to reject leave',
      error: err.message,
    });
  }
});

// Employee weekly self-approve: update self_approve column for own timecard
router.put('/time-logs/self-approve-week', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const employeeId = req.user.id;
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields (startDate, endDate).',
      });
    }

    const sql = `
      UPDATE clockin
      SET self_approve = 'approved'
      WHERE created_by = ?
        AND DATE(start_date) BETWEEN ? AND ?
    `;

    const [result] = await connection.execute(sql, [employeeId, startDate, endDate]);

    return res.json({
      success: true,
      message: 'Weekly timecard self-approved successfully.',
      updated: result.affectedRows,
    });
  } catch (err) {
    logger.error('Error self-approving weekly timecard:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to self-approve weekly timecard',
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
