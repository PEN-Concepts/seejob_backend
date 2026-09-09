'use strict';

/**
 * Delegate a notepad row (CCP §3 §11).
 *
 * "Delegate" is what the row control used to call "Move". It turns a notepad
 * item into a real task on a job and records the link, so the row's pill can
 * show the assignee's own signal without the two check-offs ever touching.
 *
 * Mounted at the same base path as routes/checklists.js.
 *
 * Hard rules enforced here, server-side:
 *   - A JOB IS ALWAYS REQUIRED. There is no job_id-null destination (the 2026-09-02
 *     decision stands; see CCP §0c). The guard is unconditional.
 *   - Only a full-access user may delegate (§6: "NOT ON THE LIST … Cannot
 *     delegate"). Checked on the request, not by hiding the button.
 *   - The delegation does NOT complete the notepad row and never writes
 *     complete_percentage or gantt_stage_progress.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const Joi = require('joi');
const auth = require('../services/authentication');
const logger = require('../common/logger');
const { getTimeStamp } = require('../common/timdate');
const { getAccessMode, isSameAccount } = require('../utils/access');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { isFullAccess, getSectionAccess } = require('../services/notepadAccess');
const notify = require('../services/notify');

const delegateSchema = Joi.object({
  // Required, always. A pad with a job pre-fills and LOCKS this client-side;
  // the server re-checks it regardless of what the client sent.
  job_id: Joi.number().integer().positive().required(),
  assignee_id: Joi.number().integer().positive().allow(null).optional(),
  due_date: Joi.date().allow(null, '').optional(),
  // §11 "ADD: a Notes field for a note to the assignee." Lands as the first
  // message in the task's two-way thread.
  note: Joi.string().allow('', null).max(4000).optional(),
  priority_star: Joi.boolean().optional(),
  add_to_calendar: Joi.boolean().optional(),
  add_to_appointment: Joi.boolean().optional(),
  photo: Joi.string().allow('', null).max(255).optional(),
});

function toMySQLDateTime(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

router.post('/items/:id/delegate', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const itemId = Number(req.params.id);
  if (!itemId) return res.status(400).json({ success: false, message: 'Invalid item id' });

  const { error, value } = delegateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureNotepadSchema(connection);

    if ((await getAccessMode(uid, connection)) === 'expired_free') {
      return res.status(403).json({ success: false, message: 'Your plan does not allow delegating.' });
    }

    const [[item]] = await connection.query(
      'SELECT id, section_id, name, priority, delegated_task_id FROM check_list WHERE id = ? LIMIT 1',
      [itemId],
    );
    if (!item) return res.status(404).json({ success: false, message: 'Notepad item not found' });

    const access = await getSectionAccess(connection, item.section_id, uid);
    if (!access) return res.status(403).json({ success: false, message: 'You cannot see that notepad.' });

    // §6 — delegation is the full-access permission. A share recipient can check
    // off and add, nothing else; an off-list user cannot delegate at all.
    if (access.role === 'share' || !(await isFullAccess(connection, uid))) {
      return res.status(403).json({
        success: false,
        code: 'NOTEPAD_DELEGATE_FORBIDDEN',
        message: 'You do not have permission to delegate.',
      });
    }

    // The job must be real and in the caller's account. A pad with a job attached
    // pins it: the client cannot delegate a job-pad row onto a different job.
    const padJobId = access.section.job_id != null ? Number(access.section.job_id) : null;
    const jobId = padJobId != null ? padJobId : Number(value.job_id);
    const [[job]] = await connection.query('SELECT id, name, created_by FROM `job` WHERE id = ? LIMIT 1', [jobId]);
    if (!job) return res.status(404).json({ success: false, message: 'That job was not found.' });
    if (!(await isSameAccount(uid, job.created_by, connection))) {
      return res.status(403).json({ success: false, message: 'That job is not in your account.' });
    }

    const assigneeId = value.assignee_id ? Number(value.assignee_id) : null;
    const start = value.due_date ? toMySQLDateTime(value.due_date) : toMySQLDateTime(new Date());
    const starred = value.priority_star ? 1 : 0;

    await connection.beginTransaction();
    let taskId;
    try {
      const [r] = await connection.query(
        `INSERT INTO tasks
           (task_name, user_id, team_id, duration_days, start_date, end_date, description,
            assignee_completed, job_id, created_at, created_by, task_type,
            is_calendar_task, is_appointment_task, priority, is_urgent, starred_at)
         VALUES (?, ?, NULL, 1, ?, ?, ?, 0, ?, ?, ?, 'job', ?, ?, ?, 0, ?)`,
        [
          item.name,
          assigneeId,
          start,
          start,
          null,
          jobId,
          getTimeStamp(),
          uid,
          value.add_to_calendar ? 1 : 0,
          value.add_to_appointment ? 1 : 0,
          starred ? 'high' : 'low',
          starred ? new Date() : null,
        ],
      );
      taskId = Number(r.insertId);

      if (assigneeId) {
        await connection.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', [
          taskId,
          assigneeId,
        ]);
      }

      // §11 the note to the assignee opens the two-way thread.
      const note = String(value.note || '').trim();
      if (note) {
        await connection.query('INSERT INTO task_notes (task_id, user_id, body) VALUES (?, ?, ?)', [
          taskId,
          uid,
          note,
        ]);
      }

      if (value.photo) {
        await connection.query('UPDATE tasks SET image = ? WHERE id = ?', [value.photo, taskId]);
      }

      // The notepad row STAYS. Delegating is not completing: the boss ticks his
      // own box when he agrees (§3). We only record the link so the pill can
      // read the assignee's separate signal.
      await connection.query(
        'UPDATE check_list SET delegated_task_id = ?, delegated_to = ? WHERE id = ?',
        [taskId, assigneeId, itemId],
      );

      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    }

    if (assigneeId && assigneeId !== uid) {
      try {
        const [[actor]] = await connection.query('SELECT name FROM `user` WHERE id = ?', [uid]);
        await notify.insertNotification(connection, {
          senderId: uid,
          receiverId: assigneeId,
          content: `${(actor && actor.name) || 'Someone'} assigned you "${item.name}" on ${job.name}.`,
          url: '/m/tasks',
        });
        await notify.sendPushToUser(connection, assigneeId, {
          title: job.name,
          body: item.name,
          url: '/m/tasks',
          type: 'task',
        });
      } catch (e) {
        logger.error('delegate notify failed: ' + e.message);
      }
    }

    res.status(201).json({
      success: true,
      task_id: taskId,
      delegated_to: assigneeId,
      // 'delegated' = green pill. It only becomes '✓ <first name>' once the
      // assignee checks it off themselves.
      delegate_state: 'delegated',
    });
  } catch (err) {
    logger.error('notepad delegate error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

/** Undo a delegation link (the task itself is left alone). */
router.delete('/items/:id/delegate', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const itemId = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureNotepadSchema(connection);
    const [[item]] = await connection.query('SELECT id, section_id FROM check_list WHERE id = ? LIMIT 1', [itemId]);
    if (!item) return res.status(404).json({ success: false, message: 'Notepad item not found' });
    const access = await getSectionAccess(connection, item.section_id, uid);
    if (!access || access.role === 'share' || !(await isFullAccess(connection, uid))) {
      return res.status(403).json({ success: false, code: 'NOTEPAD_DELEGATE_FORBIDDEN', message: 'Not allowed.' });
    }
    await connection.query('UPDATE check_list SET delegated_task_id = NULL, delegated_to = NULL WHERE id = ?', [itemId]);
    res.json({ success: true, delegate_state: 'none' });
  } catch (err) {
    logger.error('notepad undelegate error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
