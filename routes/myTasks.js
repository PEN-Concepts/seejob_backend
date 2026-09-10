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
const { isFullAccess, resolveThreadAnchor, absorbTaskNotes } = require('../services/notepadAccess');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { requireNotepadMyTasks } = require('../services/featureFlags');

/**
 * 3a — MY TASKS IS A FULL-ACCESS PAGE.
 *
 * Off-list users do not get it: they see the work delegated to them inline in
 * their own job notepad (3b), which is one place instead of two. So this is a
 * 403 and not an empty list — an empty list would look like a bug to someone
 * who has nine tasks waiting for them somewhere else.
 *
 * ROLE gate, never a plan gate. Nothing here consults the subscription.
 */
async function requireFullAccess(connection, uid, res) {
  if (await isFullAccess(connection, uid)) return true;
  res.status(403).json({
    success: false,
    code: 'MY_TASKS_NOT_AVAILABLE',
    message: 'My Tasks is not part of your access. Your assigned work is in your job notepad.',
  });
  return false;
}

/** Initials for the chat avatar, matching the notepad thread exactly. */
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((x) => x[0].toUpperCase()).join("");
}

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
router.get('/my-tasks', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await requireFullAccess(connection, uid, res))) return;

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
            ld.lead_name AS lead_name,
            ld.project_street_address AS lead_address,
            (SELECT COUNT(*) FROM task_notes n WHERE n.task_id = t.id)     AS note_count,
            (SELECT COUNT(*) FROM tasks_images i WHERE i.task_id = t.id)   AS photo_count
          FROM tasks t
          LEFT JOIN \`user\` creator ON creator.id = t.created_by
          LEFT JOIN \`job\` j ON j.id = t.job_id AND (t.task_type IS NULL OR t.task_type <> 'lead')
          -- 4c: a task on a BID uses the same job_id column with task_type
          -- 'lead'. Without this join it fell into the no-job bucket and the
          -- assignee could not tell a bid from a signed job at all.
          LEFT JOIN leads ld ON ld.id = t.job_id AND t.task_type = 'lead'
         WHERE t.user_id = ?
            OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)
         ORDER BY
            -- Starring sorts a task to the top of ITS OWN GROUP, never to the
            -- top of the page: the row order below is applied WITHIN each job
            -- bucket, and the buckets themselves are ordered separately (see
            -- the grouping step). A starred Lynes task rises above the other
            -- Lynes tasks; it does not jump above another job's header.
            (t.starred_at IS NULL) ASC,   -- starred block first, within the group
            t.starred_at DESC,            -- newest star at the top of that block
            t.start_date ASC, t.id DESC`,
        [uid, uid],
      );

      // Groups: one per JOB. There is deliberately no personal bucket here —
      // PERSONAL on the page is the existing daily-tasks feature, which has its
      // own table and its own entry bar, and this endpoint never touches it.
      // Keeping them separate is what lets §0c hold untouched: no job-less
      // `tasks` row is ever created.
      //
      // 3c/3d: the bucket is now called NO JOB ASSIGNED, matching the notepad
      // card of the same name. 'Personal' is retired: two names for the same
      // idea was the confusion, and one of them implied a separate feature.
      //
      // It still renders ONLY when job-less rows exist, and has no entry bar
      // (3f). It should empty out over time and then disappear.
      const groups = [];
      const byJob = new Map();
      const noJob = { job_id: null, job_name: 'NO JOB ASSIGNED', address: '', color: null, legacy: true, tasks: [] };

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
          job_name: r.job_name || r.lead_name,
        };
        // 4c: a bid groups by its LEAD, flagged so the heading can carry the
        // LEAD pill. Same shape as a job group in every other respect.
        const isLead = String(r.task_type || '') === 'lead' && !!r.lead_name;
        const groupName = isLead ? r.lead_name : r.job_name;
        if (!r.job_id || !groupName) {
          noJob.tasks.push(t);
          continue;
        }
        const key = `${isLead ? 'L' : 'J'}${Number(r.job_id)}`;
        if (!byJob.has(key)) {
          byJob.set(key, {
            job_id: Number(r.job_id),
            job_name: groupName,
            address: (isLead ? r.lead_address : r.job_address) || '',
            color: isLead ? null : r.job_color || null,
            is_lead: isLead,
            tasks: [],
          });
        }
        byJob.get(key).tasks.push(t);
      }

      // ── 3e — ONE SHARED PER-USER ORDER DRIVES BOTH PAGES ──────────────────
      //
      // Dragging a card on Notepads writes checklist_section_order. My Tasks
      // reads the SAME table, so the two pages present the same jobs in the
      // same sequence and the user only has to arrange their work once.
      //
      // Alphabetical stays as the tie-breaker for anything the user has never
      // dragged, so a new job still lands somewhere predictable instead of at
      // an arbitrary position.
      const rankByJob = new Map();
      const rankByLead = new Map();
      try {
        const [orderRows] = await connection.query(
          `SELECT s.job_id, s.lead_id, COALESCE(o.sort_order, s.sort_order, 0) AS sort_order
             FROM checklist_sections s
             LEFT JOIN checklist_section_order o ON o.section_id = s.id AND o.user_id = ?
            WHERE s.job_id IS NOT NULL OR s.lead_id IS NOT NULL`,
          [uid],
        );
        for (const r of orderRows) {
          // A user can see more than one pad for the same job (their private
          // one and the company one). Lowest wins, so the card they actually
          // dragged decides.
          const target = r.job_id != null ? rankByJob : rankByLead;
          const key = Number(r.job_id != null ? r.job_id : r.lead_id);
          const val = Number(r.sort_order || 0);
          if (!target.has(key) || val < target.get(key)) target.set(key, val);
        }
      } catch (e) {
        // No order table yet, or a read failure. Fall through to alphabetical
        // rather than failing the page: a list in the wrong order still works.
        logger.error('my-tasks shared-order read failed, using alphabetical: ' + e.message);
      }

      // The NO JOB ASSIGNED bucket is first by default (3d) and only renders
      // when it has something in it.
      if (noJob.tasks.length) groups.push(noJob);

      const UNRANKED = Number.MAX_SAFE_INTEGER;
      const rankOf = (g) => {
        const m = g.is_lead ? rankByLead : rankByJob;
        const r = m.get(Number(g.job_id));
        return r == null ? UNRANKED : r;
      };
      const jobGroups = [...byJob.values()].sort((a, b) => {
        const ra = rankOf(a), rb = rankOf(b);
        if (ra !== rb) return ra - rb;
        return String(a.job_name || '').localeCompare(String(b.job_name || ''), undefined, { sensitivity: 'base' });
      });
      for (const g of jobGroups) groups.push(g);

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
router.get('/:id/notes', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
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
      // C43: ONE conversation per piece of work. If this task came from a
      // notepad row, that row is the anchor and BOTH pages read the same
      // thread. Before this the sender on Notepads and the assignee on My
      // Tasks wrote to two different tables about the same job.
      const anchor = await resolveThreadAnchor(connection, { taskId });
      let rows;
      if (anchor.kind === 'item') {
        await absorbTaskNotes(connection, anchor.id);
        [rows] = await connection.query(
          `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
             FROM checklist_item_notes n LEFT JOIN \`user\` u ON u.id = n.user_id
            WHERE n.item_id = ? ORDER BY n.id ASC`,
          [anchor.id],
        );
      } else {
        [rows] = await connection.query(
          `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
             FROM task_notes n LEFT JOIN \`user\` u ON u.id = n.user_id
            WHERE n.task_id = ? ORDER BY n.id ASC`,
          [taskId],
        );
      }
      res.json({
        success: true,
        data: rows.map((r) => ({
          ...r,
          author_name: r.author_name || 'Someone',
          initials: initialsOf(r.author_name),
          is_mine: Number(r.user_id) === uid,
        })),
      });
    });
  } catch (err) {
    logger.error('task notes read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const noteSchema = Joi.object({ body: Joi.string().trim().min(1).max(4000).required() });

router.post('/:id/notes', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
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
      // C43: write into the SAME thread the notepad row reads.
      const anchor = await resolveThreadAnchor(connection, { taskId });
      let row;
      if (anchor.kind === 'item') {
        await absorbTaskNotes(connection, anchor.id);
        const [ins] = await connection.query(
          'INSERT INTO checklist_item_notes (item_id, user_id, body) VALUES (?, ?, ?)',
          [anchor.id, uid, value.body.trim()],
        );
        [[row]] = await connection.query(
          `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
             FROM checklist_item_notes n LEFT JOIN \`user\` u ON u.id = n.user_id WHERE n.id = ?`,
          [ins.insertId],
        );
      } else {
        const [ins] = await connection.query(
          'INSERT INTO task_notes (task_id, user_id, body) VALUES (?, ?, ?)',
          [taskId, uid, value.body.trim()],
        );
        [[row]] = await connection.query(
          `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
             FROM task_notes n LEFT JOIN \`user\` u ON u.id = n.user_id WHERE n.id = ?`,
          [ins.insertId],
        );
      }
      res.status(201).json({
        success: true,
        data: {
          ...row,
          author_name: row.author_name || 'You',
          initials: initialsOf(row.author_name),
          is_mine: true,
        },
      });
    });
  } catch (err) {
    logger.error('task note create error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** Default rule: you may delete YOUR OWN note, never someone else's. */
router.delete('/notes/:noteId', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
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
router.put('/:id/star', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
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
