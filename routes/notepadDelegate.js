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
const { resolveAccountOwner } = require('../services/accountScope');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { isFullAccess, getSectionAccess } = require('../services/notepadAccess');
const { requireNotepadMyTasks } = require('../services/featureFlags');
const { assignmentFields } = require('../services/notepadAssignee');
const notify = require('../services/notify');

const delegateSchema = Joi.object({
  // Required, always. A pad with a job pre-fills and LOCKS this client-side;
  // the server re-checks it regardless of what the client sent.
  job_id: Joi.number().integer().positive().required(),
  // REQUIRED, always (CCP §2). This was `.allow(null).optional()`, and that one
  // word is the whole defect: a request with no assignee created a real task,
  // wrote its id to delegated_task_id, left delegated_to NULL, and answered
  // 'delegated'. The row then rendered green and blank forever.
  //
  // Refused, NOT treated as an unassign. DELETE /items/:id/delegate already
  // means "unassign" and returns 'none'. Giving one route two opposite
  // meanings, chosen by whether a field is absent, is how this bug was born.
  assignee_id: Joi.number().integer().positive().required(),
  due_date: Joi.date().allow(null, '').optional(),
  // §11 "ADD: a Notes field for a note to the assignee." Lands as the first
  // message in the task's two-way thread.
  note: Joi.string().allow('', null).max(4000).optional(),
  priority_star: Joi.boolean().optional(),
  add_to_calendar: Joi.boolean().optional(),
  add_to_appointment: Joi.boolean().optional(),
  photo: Joi.string().allow('', null).max(255).optional(),
});

/**
 * A bare YYYY-MM-DD is parsed by new Date() as UTC midnight (ECMAScript
 * requires it). Reading LOCAL parts off that then gives the PREVIOUS day in
 * any negative-offset zone: 3 Oct becomes 2 Oct in California, so framing
 * booked for the 3rd read as the 2nd.
 *
 * So a date-only string is built as LOCAL midnight from its own parts. A
 * string that carries a time is untouched: V8 already parses that as local.
 *
 * This does NOT resolve the model question. due_date is a DATETIME and still
 * cannot distinguish "3 Oct, all day" from "3 Oct at midnight" — both are
 * stored as 00:00:00. That decision is still open; this only stops the day
 * from moving.
 */
function parseDateInput(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    const [y, m, d] = input.trim().split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  return new Date(input);
}

function toMySQLDateTime(date) {
  const d = parseDateInput(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

router.post('/items/:id/delegate', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const itemId = Number(req.params.id);
  if (!itemId) return res.status(400).json({ success: false, message: 'Invalid item id' });

  // §2 — ONE answer for "no assignee", whatever shape it arrives in.
  //
  // Joi alone would refuse all of these, but with three different messages:
  // absent is '"assignee_id" is required', null is '"assignee_id" must be a
  // number', 0 is '...must be a positive number'. The checklist asks for
  // IDENTICAL behaviour, and a caller cannot act on a message that changes
  // depending on how they failed to send a person. So this normalises first
  // and Joi's `.required()` below stays as defence in depth.
  const rawAssignee = (req.body || {}).assignee_id;
  if (rawAssignee === undefined || rawAssignee === null || rawAssignee === '' || !(Number(rawAssignee) > 0)) {
    return res.status(400).json({
      success: false,
      code: 'ASSIGNEE_REQUIRED',
      message: 'Pick who this is for. A task with nobody on it is not an assignment.',
    });
  }

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

    // §2 — THREE OUTCOMES, THREE DIFFERENT ANSWERS.
    //
    // These were two, and the two that remain are not interchangeable. This
    // lookup is deliberately UNSCOPED (`WHERE id = ?`, nothing else), so a
    // 404 here means the row is genuinely absent from the table — not that
    // the caller cannot see it. Out-of-scope is the branch below, and it is
    // a different status, a different message and a different log line.
    // Collapsing them is how "no such job" and "not yours" became
    // indistinguishable in the first place.
    //
    // The third outcome — no job sent at all — never reaches here: Joi
    // rejects it at the schema, and the client blocks before the request
    // with "Pick a job before assigning."
    if (!job) {
      return res.status(404).json({
        success: false,
        code: 'JOB_GONE',
        message: 'That job no longer exists. Pick another job and try again.',
      });
    }

    if (!(await isSameAccount(uid, job.created_by, connection))) {
      // THE SCOPE TRIPWIRE.
      //
      // Deliberately findable without knowing what you are looking for:
      // grep the word DELEGATE_JOB_OUT_OF_SCOPE and you have every instance.
      // If the account rules are ever over-narrowed, this is the line that
      // shows it — a legitimate owner denied their own job — and it carries
      // BOTH owner ids so the two can be compared rather than guessed at.
      //
      // It is logged at WARN, not INFO: a user hitting this is either
      // probing or being wrongly refused, and both are worth seeing.
      let callerOwner = null;
      let jobOwner = null;
      try {
        callerOwner = await resolveAccountOwner(connection, uid);
        jobOwner = await resolveAccountOwner(connection, job.created_by);
      } catch (e) {
        // The log must never be the reason the request fails.
        logger.warn(`DELEGATE_JOB_OUT_OF_SCOPE owner-resolve failed: ${e && e.message}`);
      }
      logger.warn(
        `DELEGATE_JOB_OUT_OF_SCOPE route=POST /api/v1/checklists/items/:id/delegate ` +
        `caller=${uid} caller_account_owner=${callerOwner} ` +
        `job_id=${jobId} job_created_by=${job.created_by} job_account_owner=${jobOwner} ` +
        `pad_section=${access.section.id} pad_job_id=${padJobId}`,
      );
      // The message stays vague on purpose. It is the only one of the three
      // that must not tell the caller whether the job exists.
      return res.status(403).json({ success: false, message: 'That job is not in your account.' });
    }

    // §2 — THE PERSON IS RESOLVED BEFORE ANYTHING IS WRITTEN.
    //
    // "If the person cannot be resolved, no task is created and no column is
    // written." Resolving first is what makes that true by construction: we
    // are outside the transaction here, so a failure costs nothing to undo.
    //
    // Resolvable means the same thing here as it does on the read side — a
    // `user` row that exists AND has a name to print. services/notepadAssignee
    // holds that definition; it is not restated here, because two copies of a
    // rule is how the three-checks problem started.
    const assigneeId = Number(value.assignee_id);
    const [[assigneeRow]] = await connection.query(
      'SELECT id, name FROM `user` WHERE id = ? LIMIT 1',
      [assigneeId],
    );
    if (!assigneeRow || !String(assigneeRow.name || '').trim()) {
      return res.status(404).json({
        success: false,
        code: 'ASSIGNEE_NOT_FOUND',
        message: 'That person could not be found.',
      });
    }

    // NO DATE MEANS NO DATE — the same defect as the notepad item create, in a
    // second place. This used to fall back to new Date(), so delegating without
    // picking a date scheduled the task for the moment you pressed the button,
    // and the assignee saw a deadline nobody had set.
    const start = value.due_date ? toMySQLDateTime(value.due_date) : null;
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

      // Unconditional now. assigneeId is a resolved person by this point, so
      // the old `if (assigneeId)` could only ever have been false on the path
      // this CCP closes — the one that produced a task with nobody on it.
      await connection.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', [
        taskId,
        assigneeId,
      ]);

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
      //
      // THE INVARIANT, and it is this CCP's deliverable:
      //   delegated_task_id and delegated_to are set together or cleared
      //   together. Neither is ever written without the other.
      // One statement, inside the transaction that also created the task, so
      // there is no interleaving in which one lands and the other does not.
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

    // §2 — delegate_state STOPS BEING ASSERTED.
    //
    // This used to return the literal 'delegated' whatever had happened, which
    // is how a row with a NULL delegated_to still reported itself green. The
    // response now describes the STORED ROW: we read it back and run it through
    // the same resolver the hub read uses, so the answer the client gets after
    // writing and the answer it gets on the next refresh cannot disagree.
    const [[stored]] = await connection.query(
      `SELECT c.delegated_task_id, c.delegated_to,
              du.name AS delegated_to_name,
              t.assignee_completed AS task_assignee_completed
         FROM check_list c
         LEFT JOIN \`user\` du ON du.id = c.delegated_to
         LEFT JOIN tasks t     ON t.id  = c.delegated_task_id
        WHERE c.id = ? LIMIT 1`,
      [itemId],
    );

    res.status(201).json({
      success: true,
      task_id: taskId,
      delegated_to: stored ? stored.delegated_to : null,
      // 'delegated' = green pill. It only becomes '<first name> ✓' once the
      // assignee checks it off themselves. Both this and the name come out of
      // one resolved value (§3) rather than three independent checks.
      ...assignmentFields(stored, uid),
    });
  } catch (err) {
    logger.error('notepad delegate error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

/** Undo a delegation link (the task itself is left alone). */
router.delete('/items/:id/delegate', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
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
