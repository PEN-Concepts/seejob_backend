'use strict';

/**
 * My Tasks — the ASSIGNEE's page (CCP §10).
 *
 * Mounted at the same base as routes/tasks.js and BEFORE it, so /my-tasks and
 * /:id/notes win over that file's /:id wildcard.
 *
 * This page is deliberately narrow:
 *   - every task assigned to the caller, grouped by job
 *   - job address read LIVE from the job record, for the maps tap
 *   - two indicators only, and only when content exists: a note (paperclip)
 *     and a photo (camera)
 *   - a star with an ORDER, so the newest star floats to the very top
 *   - NO percentage. Checkbox only. This is the deliberate exception to the
 *     app-wide percent model.
 *   - NO delegation. Delegation lives in Notepads.
 *
 * Write rules, enforced here rather than by hiding controls:
 *   - an assignee may post a note and a photo, and check their own box
 *   - an assignee may NOT change an assigned task's title, assignee, job or date
 *   - a user MAY edit and delete a task they created themselves
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const Joi = require('joi');
const auth = require('../services/authentication');
const logger = require('../common/logger');
const { isSameAccount, getAccessMode } = require('../utils/access');
const { ensureNotepadSchema } = require('../services/notepadSchema');

async function withConn(fn) {
  const connection = await pool.getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
}

/**
 * How this caller relates to a task.
 *   assignee — primary (tasks.user_id) or a task_assignees member
 *   author   — they created it (they may edit and delete it)
 *   owner    — the task belongs to their account (boss view)
 */
async function relationTo(connection, taskId, uid) {
  const [[t]] = await connection.query(
    'SELECT id, user_id, created_by, job_id FROM tasks WHERE id = ? LIMIT 1',
    [taskId],
  );
  if (!t) return null;
  let assignee = Number(t.user_id || 0) === uid;
  if (!assignee) {
    const [m] = await connection.query(
      'SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1',
      [taskId, uid],
    );
    assignee = m.length > 0;
  }
  const author = Number(t.created_by || 0) === uid;
  const owner = await isSameAccount(uid, t.created_by, connection);
  return { task: t, assignee, author, owner };
}

// ───────────────────────────────────────────────────────────────────────────
// GET /my-tasks — the whole page in one read.
// ───────────────────────────────────────────────────────────────────────────
router.get('/my-tasks', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);

      const [rows] = await connection.query(
        `SELECT
            t.id, t.task_name, t.status, t.assignee_completed, t.start_date, t.end_date,
            t.priority, t.starred_at, t.created_by, t.user_id, t.job_id, t.task_type,
            creator.name AS created_by_name,
            j.name  AS job_name,
            j.color AS job_color,
            TRIM(CONCAT_WS(', ',
                 NULLIF(j.job_address, ''),
                 NULLIF(j.job_city, ''),
                 TRIM(CONCAT_WS(' ', NULLIF(j.job_state, ''), NULLIF(j.job_zipcode, '')))
            )) AS job_address,
            (SELECT COUNT(*) FROM task_notes n WHERE n.task_id = t.id)     AS note_count,
            (SELECT COUNT(*) FROM tasks_images i WHERE i.task_id = t.id)   AS photo_count
          FROM tasks t
          LEFT JOIN \`user\` creator ON creator.id = t.created_by
          LEFT JOIN \`job\` j ON j.id = t.job_id AND (t.task_type IS NULL OR t.task_type <> 'lead')
         WHERE t.user_id = ?
            OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)
         ORDER BY
            (t.starred_at IS NULL) ASC,   -- starred block first
            t.starred_at DESC,            -- newest star at the very top
            t.start_date ASC, t.id DESC`,
        [uid, uid],
      );

      // Group: one "MY TASKS" bucket for tasks with no job, then one per job.
      // (Nothing NEW can land in the no-job bucket — a job is mandatory. It
      // exists so legacy job-less rows stay visible. See QUESTIONS #8/#17.)
      const groups = [];
      const byJob = new Map();
      const noJob = { job_id: null, job_name: 'MY TASKS', address: '', color: null, tasks: [] };

      for (const r of rows) {
        const t = {
          id: Number(r.id),
          name: r.task_name,
          done: Number(r.status) === 1,
          assignee_completed: Number(r.assignee_completed) === 1,
          date: r.start_date,
          starred: r.starred_at != null,
          starred_at: r.starred_at,
          // §10 indicators — present ONLY when there is content behind them.
          has_note: Number(r.note_count) > 0,
          has_photo: Number(r.photo_count) > 0,
          created_by: Number(r.created_by),
          created_by_name: r.created_by_name,
          // Own task -> edit + delete. Assigned task -> photo and notes only.
          is_mine: Number(r.created_by) === uid,
          job_id: r.job_id,
          job_name: r.job_name,
        };
        if (!r.job_id || !r.job_name) {
          noJob.tasks.push(t);
          continue;
        }
        const key = Number(r.job_id);
        if (!byJob.has(key)) {
          byJob.set(key, {
            job_id: key,
            job_name: r.job_name,
            address: r.job_address || '',
            color: r.job_color || null,
            tasks: [],
          });
        }
        byJob.get(key).tasks.push(t);
      }

      if (noJob.tasks.length) groups.push(noJob);
      for (const g of byJob.values()) groups.push(g);

      res.json({ success: true, data: groups });
    });
  } catch (err) {
    logger.error('my-tasks read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §10 the notes thread. Two-way: the sender writes when delegating, the
// assignee replies. Author and date per note.
// ───────────────────────────────────────────────────────────────────────────
router.get('/:id/notes', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const taskId = Number(req.params.id);
  if (!taskId) return res.status(400).json({ success: false, message: 'Invalid task id' });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const rel = await relationTo(connection, taskId, uid);
      if (!rel) return res.status(404).json({ success: false, message: 'Task not found' });
      if (!rel.assignee && !rel.owner) {
        return res.status(403).json({ success: false, message: 'This task is not yours.' });
      }
      const [rows] = await connection.query(
        `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
           FROM task_notes n LEFT JOIN \`user\` u ON u.id = n.user_id
          WHERE n.task_id = ? ORDER BY n.id ASC`,
        [taskId],
      );
      res.json({ success: true, data: rows });
    });
  } catch (err) {
    logger.error('task notes read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const noteSchema = Joi.object({ body: Joi.string().trim().min(1).max(4000).required() });

router.post('/:id/notes', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const taskId = Number(req.params.id);
  const { error, value } = noteSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const rel = await relationTo(connection, taskId, uid);
      if (!rel) return res.status(404).json({ success: false, message: 'Task not found' });
      // Posting a note is explicitly allowed to an assignee — it is one of the
      // two things they CAN do on a task that isn't theirs.
      if (!rel.assignee && !rel.owner) {
        return res.status(403).json({ success: false, message: 'This task is not yours.' });
      }
      const [r] = await connection.query('INSERT INTO task_notes (task_id, user_id, body) VALUES (?, ?, ?)', [
        taskId,
        uid,
        value.body.trim(),
      ]);
      const [[row]] = await connection.query(
        `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
           FROM task_notes n LEFT JOIN \`user\` u ON u.id = n.user_id WHERE n.id = ?`,
        [r.insertId],
      );
      res.status(201).json({ success: true, data: row });
    });
  } catch (err) {
    logger.error('task note create error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** Default rule: you may delete YOUR OWN note, never someone else's. */
router.delete('/notes/:noteId', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const noteId = Number(req.params.noteId);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const [[n]] = await connection.query('SELECT id, user_id FROM task_notes WHERE id = ? LIMIT 1', [noteId]);
      if (!n) return res.status(404).json({ success: false, message: 'Note not found' });
      if (Number(n.user_id) !== uid) {
        return res.status(403).json({
          success: false,
          code: 'NOTE_AUTHOR_ONLY',
          message: 'You can only delete a note you wrote.',
        });
      }
      await connection.query('DELETE FROM task_notes WHERE id = ?', [noteId]);
      res.json({ success: true });
    });
  } catch (err) {
    logger.error('task note delete error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §10 the star. Solid orange when set, and the ASSIGNEE sees it — so an
// assignee may star their own view's task. Starring writes only starred_at
// (and the matching priority label); it never touches status or percent.
// ───────────────────────────────────────────────────────────────────────────
router.put('/:id/star', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const taskId = Number(req.params.id);
  const on = !(req.body && (req.body.starred === false || req.body.starred === 0 || req.body.starred === '0'));
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if ((await getAccessMode(uid, connection)) === 'expired_free') {
        return res.status(403).json({ success: false, message: 'Your plan does not allow this.' });
      }
      const rel = await relationTo(connection, taskId, uid);
      if (!rel) return res.status(404).json({ success: false, message: 'Task not found' });
      if (!rel.assignee && !rel.owner) {
        return res.status(403).json({ success: false, message: 'This task is not yours.' });
      }
      // A fresh timestamp on every star is what makes "tapping a star lower in
      // the list moves that task to the top" work.
      await connection.query('UPDATE tasks SET starred_at = ?, priority = ? WHERE id = ?', [
        on ? new Date() : null,
        on ? 'high' : 'low',
        taskId,
      ]);
      res.json({ success: true, starred: on });
    });
  } catch (err) {
    logger.error('task star error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
module.exports.relationTo = relationTo;
