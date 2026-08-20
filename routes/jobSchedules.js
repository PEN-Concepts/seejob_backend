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
const { requirePlan, denyRestrictedJobData, isSameAccount, requireLevel } = require('../utils/access');
const { ensureScheduleTemplateTables } = require('../services/dbMigrations');
const { getTimeStamp } = require('../common/timdate');

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

// PLATINUM-ONLY GATE: every job-schedule operation requires the Platinum plan (server-side
// 403). authenticateToken runs first so requirePlan can read req.user.
// Gantt Scheduler data is off-limits to Subcontractors/Clients on ANY job.
router.use(auth.authenticateToken, denyRestrictedJobData, requirePlan('platinum'));

// Gantt/schedule EDITING is a Level-4 action (decision #2). Foreman (L3) keeps
// view-only via the single GET route; every mutation (blank/validate/reorder/
// items/start/hold/delete/deps) requires L4+. Owner (role 14) bypasses; off-ladder
// subs/clients and anyone below L4 are denied. Fail closed.
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  return requireLevel(4)(req, res, next);
});

// ── Cross-account isolation for ALL Gantt/schedule data ────────────────────────
// A schedule hangs off a job (or lead). Previously any Platinum account could
// read/rewrite/wipe another company's Gantt by passing a foreign :sid / :jobId
// (and its nested :iid/:depId). These guards resolve each id to its parent
// job/lead FROM THE DB and require it to belong to the caller's account. Fail
// CLOSED (403). :iid/:depId are always nested under a verified :sid.
async function ownsScheduleOwner(userId, ownerId, ownerType) {
  if (ownerId == null || ownerId === '') return false;
  const isLead = String(ownerType || 'job').toLowerCase() === 'lead';
  const table = isLead ? 'leads' : 'job';
  const col = isLead ? 'user_id' : 'created_by';
  const [[row]] = await pool.query(
    `SELECT ${col} AS owner FROM ${table} WHERE id = ? LIMIT 1`,
    [Number(ownerId)]
  );
  if (!row) return false;
  return isSameAccount(userId, row.owner);
}
function scheduleForbidden(res, msg) {
  return res.status(403).json({ success: false, code: '403', message: msg });
}
router.param('sid', async (req, res, next, sid) => {
  try {
    const [[s]] = await pool.query(
      'SELECT job_id, owner_type FROM job_schedules WHERE id = ? LIMIT 1',
      [Number(sid)]
    );
    if (!s) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (!(await ownsScheduleOwner(req.user.id, s.job_id, s.owner_type)))
      return scheduleForbidden(res, 'This schedule does not belong to your account.');
    return next();
  } catch (e) {
    logger.error('jobSchedules sid guard: ' + e.message);
    return scheduleForbidden(res, 'Forbidden');
  }
});
router.param('jobId', async (req, res, next, jobId) => {
  try {
    const ownerType = (req.query && req.query.owner_type) || 'job';
    if (!(await ownsScheduleOwner(req.user.id, jobId, ownerType)))
      return scheduleForbidden(res, 'This job does not belong to your account.');
    return next();
  } catch (e) {
    logger.error('jobSchedules jobId guard: ' + e.message);
    return scheduleForbidden(res, 'Forbidden');
  }
});

function dispatchAll(payloads) {
  for (const p of payloads || []) {
    notify.dispatchScheduleNotification(pool, p).catch(() => {});
  }
}

// If an edit was rejected by the schedule engine (a dependency "bust" or a cycle),
// respond 409 with the specific, human-readable reason. Returns true when handled.
// The caller must have already rolled back the transaction. Everything else falls
// through to the generic 500.
function respondScheduleReject(res, err) {
  if (err && (err.bust || err.code === 'SCHEDULE_CONFLICT')) {
    res.status(409).json({ success: false, code: 'SCHEDULE_CONFLICT', message: err.message, conflicts: err.conflicts || [] });
    return true;
  }
  if (err && (err.cycle || err.code === 'CYCLE')) {
    res.status(409).json({ success: false, code: 'CYCLE', message: err.message, cycle: err.cycle || [] });
    return true;
  }
  return false;
}

async function loadScheduleRow(connection, sid) {
  const [[s]] = await connection.query('SELECT * FROM job_schedules WHERE id = ? LIMIT 1', [sid]);
  return s || null;
}

// POST /job-schedules/blank — "Start blank": create an EMPTY on_hold schedule for
// a job, with NO template involved (nothing is saved to "Your templates"). The user
// then adds trades on the combined page.
router.post('/blank', async (req, res) => {
  const jobId = Number(req.body && req.body.job_id);
  const ownerType = req.body && req.body.owner_type === 'lead' ? 'lead' : 'job';
  if (!jobId) return res.status(400).json({ success: false, message: 'job_id is required' });
  // SECURITY: only create a schedule on a job/lead in the caller's own account.
  if (!(await ownsScheduleOwner(req.user.id, jobId, ownerType)))
    return scheduleForbidden(res, 'This job does not belong to your account.');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let result;
    try {
      result = await cascade.applyTemplateToJob(connection, {
        templateId: null, jobId, ownerType,
        startDate: null, onHold: true,
        skipSaturday: false, skipSunday: false, assignments: [],
        actorId: req.user.id,
      });
      await connection.commit();
    } catch (e) { await connection.rollback(); throw e; }
    res.status(201).json({ success: true, schedule_id: result.scheduleId });
  } catch (err) {
    logger.error('[job-schedules] blank: ' + err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// GET /job-schedules/:jobId?owner_type= — the job's CURRENT active schedule.
router.get('/:jobId', async (req, res) => {
  const jobId = Number(req.params.jobId);
  const ownerType = req.query.owner_type === 'lead' ? 'lead' : 'job';
  let connection;
  try {
    connection = await pool.getConnection();
    const [[schedule]] = await connection.query(
      "SELECT * FROM job_schedules WHERE job_id = ? AND owner_type = ? AND status IN ('active', 'on_hold') ORDER BY id DESC LIMIT 1",
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
    // "Start with this item": exactly ONE start per schedule. Marking this item
    // clears the flag from every other item AND drops this item's own deps (a
    // start depends on nothing). Clearing (is_start:0) just unsets it.
    if ('is_start' in b) {
      if (b.is_start ? 1 : 0) {
        await connection.query('UPDATE job_schedule_items SET is_start = 0 WHERE schedule_id = ? AND id <> ?', [sid, iid]);
        await connection.query('DELETE FROM job_schedule_deps WHERE schedule_id = ? AND item_id = ?', [sid, iid]);
        sets.push('is_start = 1');
      } else {
        sets.push('is_start = 0');
      }
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
      // NEVER notify subs for a non-active (on_hold/archived) schedule — the rule
      // that recomputeSchedule/pushScheduleToCalendar already enforce. This
      // reassignment payload is built independently of recompute, so it needs its
      // own status gate (a held item also has computed_start_date = NULL).
      if (fresh && sched && sched.status === 'active') {
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
    if (respondScheduleReject(res, err)) return;
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
    if (respondScheduleReject(res, err)) return;
    logger.error('[job-schedules] delete item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /job-schedules/:sid/items — add a NEW trade to a job's applied schedule.
// Inserts the item, recomputes dates, then materializes one task + one stage for
// it (recompute only updates linked tasks — it doesn't create them), mirroring the
// per-item creation done at apply time. Job is untouched.
router.post('/:sid/items', async (req, res) => {
  const sid = Number(req.params.sid);
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[sched]] = await connection.query('SELECT * FROM job_schedules WHERE id = ? LIMIT 1', [sid]);
    if (!sched) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Schedule not found' }); }

    const [[mx]] = await connection.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS so FROM job_schedule_items WHERE schedule_id = ?',
      [sid]
    );
    const dur = engine.normalizeDuration(b.duration_days != null && b.duration_days !== '' ? b.duration_days : 1);
    const isInsp = b.is_inspection ? 1 : 0;
    const assignee = b.assignee_user_id != null && b.assignee_user_id !== '' ? Number(b.assignee_user_id) : null;

    const [ins] = await connection.query(
      `INSERT INTO job_schedule_items
         (schedule_id, name, duration_days, sort_order, assignee_user_id, template_item_id, depends_on_all, is_inspection)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
      [sid, name, dur, mx.so, assignee, isInsp]
    );
    const iid = ins.insertId;

    // "Depends on" from the add-trade row: only accept ids that belong to THIS
    // schedule and aren't the new item itself; insert before recompute so the
    // new item's dates reflect its dependencies. A cycle/conflict is caught by
    // recomputeSchedule and rolls the whole transaction back.
    const [validRows] = await connection.query('SELECT id FROM job_schedule_items WHERE schedule_id = ?', [sid]);
    const valid = new Set(validRows.map((r) => Number(r.id)));
    const deps = Array.isArray(b.deps) ? b.deps.map(Number).filter((x) => valid.has(x) && x !== iid) : [];
    for (const d of deps) {
      await connection.query(
        'INSERT IGNORE INTO job_schedule_deps (schedule_id, item_id, depends_on_item_id) VALUES (?, ?, ?)',
        [sid, iid, d]
      );
    }

    // Recompute so the new item gets computed dates from its deps (or appends
    // cleanly when it has none).
    const payloads = await cascade.recomputeSchedule(connection, sid, { changedItemId: iid });

    // Materialize the task + stage for the new item (recompute won't create them).
    const [[item]] = await connection.query('SELECT * FROM job_schedule_items WHERE id = ? LIMIT 1', [iid]);
    const now = getTimeStamp();
    const startTs = item.computed_start_date ? `${String(item.computed_start_date).slice(0, 10)} 00:00:00` : null;
    const endTs = item.computed_end_date ? `${String(item.computed_end_date).slice(0, 10)} 00:00:00` : null;

    const [taskR] = await connection.query(
      `INSERT INTO tasks
         (task_name, user_id, team_id, duration_days, start_date, end_date, description,
          job_id, created_at, created_by, task_type, is_calendar_task, is_appointment_task, priority)
       VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 0, 'low')`,
      [item.name, item.assignee_user_id || null, item.duration_days, startTs, endTs, sched.job_id, now, req.user.id, sched.owner_type]
    );
    const [stageR] = await connection.query(
      `INSERT INTO stages (user_id, name, csi_code, job_id, owner_type, status, progress_status, created_at)
       VALUES (?, ?, '', ?, ?, 1, 0, ?)`,
      [req.user.id || null, item.name, sched.job_id, sched.owner_type, now]
    );
    await connection.query(
      'UPDATE job_schedule_items SET task_id = ?, stage_id = ? WHERE id = ?',
      [taskR.insertId, stageR.insertId, iid]
    );

    await connection.commit();
    dispatchAll(payloads);
    res.status(201).json({ success: true, id: iid });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    if (respondScheduleReject(res, err)) return;
    logger.error('[job-schedules] add item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /job-schedules/:sid/start — take a HELD schedule off hold: set its start
// date, cascade dates through the dependency chain, and push tasks to the Master
// Calendar (the same result as applying with a date up front).
router.post('/:sid/start', async (req, res) => {
  const sid = Number(req.params.sid);
  const b = req.body || {};
  if (!b.start_date) return res.status(400).json({ success: false, message: 'start_date is required' });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let payloads;
    try {
      payloads = await cascade.startHeldSchedule(connection, sid, {
        startDate: b.start_date,
        skipSaturday: b.skip_saturday,
        skipSunday: b.skip_sunday,
        actorId: req.user.id,
      });
      await connection.commit();
    } catch (e) {
      try { await connection.rollback(); } catch (_) {}
      if (e && e.notFound) return res.status(404).json({ success: false, message: 'Schedule not found' });
      if (respondScheduleReject(res, e)) return;
      throw e;
    }
    dispatchAll(payloads);
    const graph = await cascade.loadScheduleGraph(connection, sid);
    res.json({ success: true, data: graph });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] start held: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /job-schedules/:sid/hold — put an ACTIVE schedule back ON HOLD: pull its
// tasks off the Master Calendar and clear its dates, keeping the plan intact so a
// start date can re-schedule it later.
router.post('/:sid/hold', async (req, res) => {
  const sid = Number(req.params.sid);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      await cascade.holdSchedule(connection, sid);
      await connection.commit();
    } catch (e) {
      try { await connection.rollback(); } catch (_) {}
      if (e && e.notFound) return res.status(404).json({ success: false, message: 'Schedule not found' });
      throw e;
    }
    const graph = await cascade.loadScheduleGraph(connection, sid);
    res.json({ success: true, data: graph });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] hold: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /job-schedules/:sid — delete an ENTIRE applied schedule. Archives its
// tasks (archived_at + status_note — the job-deletion convention) and soft-deletes
// its stages (status=0), then hard-deletes the schedule + items + deps. The job
// itself is untouched and a schedule can be re-applied afterwards.
router.delete('/:sid', async (req, res) => {
  const sid = Number(req.params.sid);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[sched]] = await connection.query('SELECT * FROM job_schedules WHERE id = ? LIMIT 1', [sid]);
    if (!sched) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Schedule not found' }); }

    const [items] = await connection.query(
      'SELECT task_id, stage_id FROM job_schedule_items WHERE schedule_id = ?',
      [sid]
    );
    const taskIds = items.map((i) => i.task_id).filter(Boolean);
    const stageIds = items.map((i) => i.stage_id).filter(Boolean);
    if (taskIds.length) {
      await connection.query(
        `UPDATE tasks
            SET archived_at = NOW(),
                status_note = COALESCE(NULLIF(status_note, ''), 'Archived: schedule deleted')
          WHERE id IN (?) AND archived_at IS NULL`,
        [taskIds]
      );
    }
    if (stageIds.length) {
      await connection.query('UPDATE stages SET status = 0, updated_at = NOW() WHERE id IN (?)', [stageIds]);
    }
    await connection.query('DELETE FROM job_schedule_deps WHERE schedule_id = ?', [sid]);
    await connection.query('DELETE FROM job_schedule_items WHERE schedule_id = ?', [sid]);
    await connection.query('DELETE FROM job_schedules WHERE id = ?', [sid]);

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[job-schedules] delete schedule: ' + err.message);
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
    // An item that now depends on something is no longer the schedule's "Start"
    // item — clear its start flag so the two states stay mutually exclusive.
    // Also clear any pinned_start_date: editing an item's dependencies makes it
    // dependency-DRIVEN, so a stale pin (e.g. from an earlier calendar drag) must
    // not linger and fight the deps (which would wrongly flag a plain cascade).
    await connection.query(
      'UPDATE job_schedule_items SET is_start = 0, pinned_start_date = NULL WHERE schedule_id = ? AND id = ?',
      [sid, itemId]
    );
    const payloads = await cascade.recomputeSchedule(connection, sid, { changedItemId: itemId });
    await connection.commit();
    dispatchAll(payloads);
    res.status(201).json({ success: true, notified: payloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    if (respondScheduleReject(res, err)) return;
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
    // Which item's deps are changing — clear its pin so it becomes dependency-driven
    // (editing an item's dependencies drops any stale pin, e.g. from a calendar drag,
    // so a plain cascade isn't wrongly flagged as a conflict).
    const [[depRow]] = await connection.query('SELECT item_id FROM job_schedule_deps WHERE id = ? AND schedule_id = ? LIMIT 1', [depId, sid]);
    await connection.query('DELETE FROM job_schedule_deps WHERE id = ? AND schedule_id = ?', [depId, sid]);
    if (depRow && depRow.item_id) {
      await connection.query('UPDATE job_schedule_items SET pinned_start_date = NULL WHERE schedule_id = ? AND id = ?', [sid, depRow.item_id]);
    }
    const payloads = await cascade.recomputeSchedule(connection, sid, {});
    await connection.commit();
    dispatchAll(payloads);
    res.json({ success: true, notified: payloads.length });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    if (respondScheduleReject(res, err)) return;
    logger.error('[job-schedules] delete dep: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
