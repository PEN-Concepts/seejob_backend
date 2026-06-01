const cron = require('node-cron');
const pool = require('../config/connection');
const logger = require('../common/logger');

const pad2 = (n) => String(n).padStart(2, '0');
const formatLocalDate = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const MAX_MYSQL_TIME_SEC = 838 * 3600 + 59 * 60 + 59; // 838:59:59

const secToHms = (t) => {
  const safe = Number.isFinite(t) ? Math.min(t, MAX_MYSQL_TIME_SEC) : 0;
  const hh = Math.floor(safe / 3600).toString().padStart(2, '0');
  const mm = Math.floor((safe % 3600) / 60).toString().padStart(2, '0');
  const ss = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const toSec = (s) => {
  if (!s) return 0;
  const parts = s.toString().split(':').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
};

const parseYmdParts = (val) => {
  if (!val) return null;
  const s = String(val);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
};

const MAX_SHIFT_SECONDS = 12 * 3600; // 12 hours

async function autoClockOutExpiredSessions() {
  let connection;
  try {
    connection = await pool.getConnection();

    // Find all active clock-in sessions
    const [rows] = await connection.query(
      `SELECT id, start_time, start_date, break_duration,
              is_break, start_break, break_start_date, created_by
       FROM clockin
       WHERE is_task_active = TRUE`
    );

    if (!rows || rows.length === 0) return;

    const now = new Date();
    const stopTime = now.toTimeString().split(' ')[0];
    const stopDate = formatLocalDate(now);

    for (const row of rows) {
      try {
        const startDate = String(row.start_date || '').slice(0, 10);
        const startTime = row.start_time;
        if (!startDate || !startTime) continue;

        const startStr = `${startDate}T${startTime}`;
        const start = new Date(startStr);
        if (isNaN(start.getTime())) continue;

        const elapsedSec = Math.max(0, Math.floor((now - start) / 1000));

        // Compute break time
        const prevBreakSec = toSec(row.break_duration);
        let currentBreakSec = 0;
        if (row.is_break && row.start_break && row.break_start_date) {
          const bp = row.start_break.toString().split(':').map(Number);
          if (bp.length === 3 && !bp.some(isNaN)) {
            const ymd = parseYmdParts(row.break_start_date);
            if (ymd) {
              const breakStart = new Date(ymd[0], ymd[1] - 1, ymd[2], bp[0], bp[1], bp[2]);
              currentBreakSec = Math.max(0, Math.floor((now - breakStart) / 1000));
            }
          }
        }
        const totalBreakSec = prevBreakSec + currentBreakSec;
        const workedSec = Math.max(0, elapsedSec - totalBreakSec);

        if (workedSec < MAX_SHIFT_SECONDS) continue;

        // Auto clock-out this session
        const taskDuration = secToHms(workedSec);
        const finalBreak = secToHms(totalBreakSec);

        if (row.is_break) {
          await connection.query(
            `UPDATE clockin
             SET stop_time = ?, stop_date = ?, task_duration = ?, is_task_active = FALSE,
                 is_break = FALSE, stop_break = ?, break_stop_date = ?, break_duration = ?,
                 additional_notes = COALESCE(CONCAT(IFNULL(additional_notes,''), ' | Auto clock-out: 12h limit'), additional_notes)
             WHERE id = ?`,
            [stopTime, stopDate, taskDuration, stopTime, stopDate, finalBreak, row.id]
          );
        } else {
          await connection.query(
            `UPDATE clockin
             SET stop_time = ?, stop_date = ?, task_duration = ?, is_task_active = FALSE,
                 additional_notes = COALESCE(CONCAT(IFNULL(additional_notes,''), ' | Auto clock-out: 12h limit'), additional_notes)
             WHERE id = ?`,
            [stopTime, stopDate, taskDuration, row.id]
          );
        }

        logger.info(
          `[AutoClockOut] Clocked out user=${row.created_by} clockin_id=${row.id} worked=${secToHms(workedSec)} elapsed=${secToHms(elapsedSec)}`
        );
      } catch (innerErr) {
        logger.error(`[AutoClockOut] Error processing clockin id=${row.id}:`, innerErr);
      }
    }
  } catch (err) {
    logger.error('[AutoClockOut] Cron error:', err);
  } finally {
    if (connection) connection.release();
  }
}

// Run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  logger.info('[AutoClockOut] Running check...');
  autoClockOutExpiredSessions();
});

logger.info('[AutoClockOut] Cron job registered – checks every 5 minutes for sessions > 12h');

module.exports = { autoClockOutExpiredSessions };
