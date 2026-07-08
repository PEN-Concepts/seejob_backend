// routes/jobSchedules.js — a job's APPLIED schedule instance (the independent copy
// created by apply). Every edit here funnels through scheduleCascade.recomputeSchedule
// so dates, tasks, stages and notifications stay in sync — scoped to this one job.
// Mounted at `${API_URL}/job-schedules`.

'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const auth = require('../services/authentication');
const logger = require('../common/logger');
const engine = require('../services/scheduleEngine');
const cascade = require('../services/scheduleCascade');
const notify = require('../services/notify');
const { requirePlan } = require('../utils/access');
const { ensureScheduleTemplateTables } = require('../services/dbMigrations');

router.use(async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureScheduleTemplateTables(connection);
    next();
  } catch (err) {
    logger.error('[job-schedules] ensure tables: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// GOLD-ONLY GATE: every job-schedule operation requires the Gold plan (server-side
// 403). authenticateToken runs first so requirePlan can read req.user.
router.use(auth.authenticateToken, requirePlan('gold'));

function dispatchAll(payloads) {
  for (const p of payloads || []) {
    notify.dispatchScheduleNotification(pool, p).catch(() => {});
  }
}

async function loadScheduleRow(connection, sid) {
  const [[s]] = await connection.query('SELECT * FROM job_schedules WHERE id = ? LIMIT 1', [sid]);
  return s || null;
}

// GET /job-schedules/:jobId?owner_type= — the job's CURRENT active schedule.
router.get('/:jobId', async (req, res) => {
  const jobId = Number(req.params.jobId);
  const ownerType = req.query.owner_type === 'lead' ? 'lead' : 'job';
  let connection;
  try {
    connection = await pool.getConnection();
    const [[schedule]] = await connection.query(
      "SELECT * FROM job_schedules WHERE job_id = ? AND owner_type = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [jobId, ownerType]
    );
    if (!schedule) return res.json({ success: true, data: null });
    const graph = await cascade.loadScheduleGraph(connection, schedule.id);
    res.json({ success: true, data: graph });
  } catch (err) {
    logger.error('[job-schedules] get: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /job-schedules/:sid/validate — cycle/bust check without saving.
router.post('/:sid/validate', async (req, res) => {
  const sid = Number(req.params.sid);
  let connection;
  try {
    connection = await pool.getConnection();
    const { schedule, items, deps } = await cascade.loadScheduleGraph(connection, sid);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    const comp = engine.computeSchedule({
      items: items.map((it) => ({
        id: it.id, name: it.name, duration_days: it.duration_days,
        depends_on_all: !!it.depends_on_all, pinned_start_date: it.pinned_start_date,
      })),
      deps,
      startDate: schedule.start_date ? String(schedule.start_date).slice(0, 10) : null,
      skipSaturday: !!schedule.skip_saturday,
      skipSunday: !!schedule.skip_sunday,
    });
    res.json({
      success: true,
      ok: comp.ok,
      cycle: comp.cycle || [],
      conflicts: comp.conflicts || [],
      results: comp.results || {},
    });
  } catch (err) {
    logger.error('[job-schedules] validate: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /job-schedules/:sid/items/reorder — display order only (no recompute).
router.put('/:sid/items/reorder', async (req, res) => {
  const sid = Number(req.params.sid);
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array' });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    for (const row of order) {
      const iid = Number(row && row.id);
      const so = Number(row && row.sort_order);
      if (!iid || isNaN(so)) continue;
      await connection.query(
        'UPDATE job_schedule_items SET sort_order = ? WHERE id = ? AND schedule_id = ?',
        [so, iid, sid]
      );
    }
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] reorder: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /job-schedules/:sid/items/:iid — edit an applied item → cascade recompute.
router.put('/:sid/items/:iid', async (req, res) => {
  const sid = Number(req.params.sid);
  const iid = Number(req.params.iid);
  const b = req.body || {};
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[item]] = await connection.query(
      'SELECT * FROM job_schedule_items WHERE id = ? AND schedule_id = ? LIMIT 1',
      [iid, sid]
    );
    if (!item) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const sets = [];
    const vals = [];
    let nameChanged = false;
    let assigneeChanged = false;
    let newAssignee = item.assignee_user_id;

    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== item.name) {
      sets.push('name = ?'); vals.push(b.name.trim()); nameChanged = true;
    }
    if ('duration_days' in b) {
      sets.push('duration_days = ?'); vals.push(engine.normalizeDuration(b.duration_days));
    }
    if ('assignee_user_id' in b) {
      newAssignee = b.assignee_user_id != null && b.assignee_user_id !== '' ? Number(b.assignee_user_id) : null;
      sets.push('assignee_user_id = ?'); vals.push(newAssignee);
      assigneeChanged = Number(newAssignee || 0) !== Number(item.assignee_user_id || 0);
    }
    if ('pinned_start_date' in b) {
      const p = b.pinned_start_date;
      sets.push('pinned_start_date = ?'); vals.push(p ? String(p).slice(0, 10) : null);
    }

    if (sets.length) {
      vals.push(iid);
      await connection.query(`UPDATE job_schedule_items SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    // Sync the fields recompute won't touch onto the linked task/stage.
    if (item.task_id) {
      const tSets = [];
      const tVals = [];
      if (nameChanged) { tSets.push('task_name = ?'); tVals.push(b.name.trim()); }
      if (assigneeChanged) { tSets.push('user_id = ?'); tVals.push(newAssignee); }
      if (tSets.length) {
        tVals.push(item.task_id);
        await connection.query(`UPDATE tasks SET ${tSets.join(', ')} WHERE id = ?`, tVals);
      }
    }
    if (nameChanged && item.stage_id) {
      await connection.query('UPDATE stages SET name = ?, updated_at = NOW() WHERE id = ?', [b.name.trim(), item.stage_id]);
    }

    const payloads = await cascade.recomputeSchedule(connection, sid, { changedItemId: iid });
    await connection.commit();

    // Notify date-shift assignees (batched). A pure reassignment (no date shift)
    // still tells the NEW assignee about their item.
    let allPayloads = payloads;
    if (assigneeChanged && newAssignee && !payloads.some((p) => Number(p.userId) === Number(newAssignee))) {
      const [[fresh]] = await pool.query(
        'SELECT name, computed_start_date, duration_days FROM job_schedule_items WHERE id = ? LIMIT 1',
        [iid]
      );
      const sched = await loadScheduleRow(pool, sid);
      const jobName = sched ? await cascade.getJobName(pool, sched.job_id, sched.owner_type) : null;
      if (fresh) {
        allPayloads = payloads.concat([{
          userId: newAssignee,
          jobName,
          items: [{ tradeName: fresh.name, newStartDate: String(fresh.computed_start_date).slice(0, 10), durationDays: fresh.duration_days }],
          senderId: req.user.id,
        }]);
      }
    }
    dispatchAll(allPayloads);

    res.json({ success: true, notified: allPayloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] edit item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /job-schedules/:sid/items/:iid — remove item → archive task, soft-delete stage, recompute.
router.delete('/:sid/items/:iid', async (req, res) => {
  const sid = Number(req.params.sid);
  const iid = Number(req.params.iid);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[item]] = await connection.query(
      'SELECT * FROM job_schedule_items WHERE id = ? AND schedule_id = ? LIMIT 1',
      [iid, sid]
    );
    if (!item) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    if (item.task_id) {
      await connection.query(
        `UPDATE tasks SET archived_at = NOW(),
                status_note = COALESCE(NULLIF(status_note, ''), 'Archived: schedule item removed')
          WHERE id = ? AND archived_at IS NULL`,
        [item.task_id]
      );
    }
    if (item.stage_id) {
      await connection.query('UPDATE stages SET status = 0, updated_at = NOW() WHERE id = ?', [item.stage_id]);
    }
    // Deleting the item cascades its dep edges via FK.
    await connection.query('DELETE FROM job_schedule_items WHERE id = ?', [iid]);

    const payloads = await cascade.recomputeSchedule(connection, sid, {});
    await connection.commit();
    dispatchAll(payloads);
    res.json({ success: true, notified: payloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] delete item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /job-schedules/:sid/deps — add a dependency (cycle-checked) → recompute.
router.post('/:sid/deps', async (req, res) => {
  const sid = Number(req.params.sid);
  const itemId = Number(req.body && req.body.item_id);
  const dependsOn = Number(req.body && req.body.depends_on_item_id);
  let connection;
  try {
    connection = await pool.getConnection();
    if (!itemId || !dependsOn || itemId === dependsOn) {
      return res.status(400).json({ success: false, message: 'Invalid dependency' });
    }
    const [belong] = await connection.query(
      'SELECT id FROM job_schedule_items WHERE schedule_id = ? AND id IN (?, ?)',
      [sid, itemId, dependsOn]
    );
    if (belong.length < 2) return res.status(400).json({ success: false, message: 'Items not in this schedule' });

    const [items] = await connection.query(
      'SELECT id, depends_on_all FROM job_schedule_items WHERE schedule_id = ?',
      [sid]
    );
    const [deps] = await connection.query(
      'SELECT item_id, depends_on_item_id FROM job_schedule_deps WHERE schedule_id = ?',
      [sid]
    );
    deps.push({ item_id: itemId, depends_on_item_id: dependsOn });
    const cycle = engine.detectCycle(
      items.map((i) => ({ id: i.id, depends_on_all: !!i.depends_on_all })),
      deps
    );
    if (cycle.length) {
      return res.status(409).json({ success: false, code: 'CYCLE', message: 'That dependency would create a cycle', cycle });
    }

    await connection.beginTransaction();
    await connection.query(
      'INSERT IGNORE INTO job_schedule_deps (schedule_id, item_id, depends_on_item_id) VALUES (?, ?, ?)',
      [sid, itemId, dependsOn]
    );
    const payloads = await cascade.recomputeSchedule(connection, sid, { changedItemId: itemId });
    await connection.commit();
    dispatchAll(payloads);
    res.status(201).json({ success: true, notified: payloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] add dep: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /job-schedules/:sid/deps/:depId — remove a dependency → recompute.
router.delete('/:sid/deps/:depId', async (req, res) => {
  const sid = Number(req.params.sid);
  const depId = Number(req.params.depId);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query('DELETE FROM job_schedule_deps WHERE id = ? AND schedule_id = ?', [depId, sid]);
    const payloads = await cascade.recomputeSchedule(connection, sid, {});
    await connection.commit();
    dispatchAll(payloads);
    res.json({ success: true, notified: payloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] delete dep: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
