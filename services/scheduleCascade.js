// scheduleCascade.js — the shared engine that all three edit entry points funnel
// through (schedule dialog, Task Manager edit, Master Calendar drag). It owns:
//   applyTemplateToJob() — copy a template onto a job (archiving any prior active
//                          schedule), compute dates, create tasks + stages.
//   recomputeSchedule()  — after any edit, recompute dates for one job's schedule,
//                          push the new dates onto the linked tasks/stages, and
//                          return the batched notification payloads.
// Everything is scoped to ONE job's applied instance (by schedule_id) — it never
// crosses into another job or back into the master template. DB writes use the
// caller's connection (inside their transaction); notifications are RETURNED so the
// caller can dispatch them AFTER commit (fire-and-forget), never blocking the save.

'use strict';

const engine = require('./scheduleEngine');
const { getTimeStamp } = require('../common/timdate');

function tsStart(ymd) {
  return ymd ? `${String(ymd).slice(0, 10)} 00:00:00` : null;
}
function toDateOnly(v) {
  return v ? String(v).slice(0, 10) : null;
}

async function getJobName(conn, jobId, ownerType) {
  try {
    if (ownerType === 'lead') {
      const [[r]] = await conn.query('SELECT lead_name AS name FROM leads WHERE id = ? LIMIT 1', [jobId]);
      return r ? r.name : null;
    }
    const [[r]] = await conn.query('SELECT name FROM job WHERE id = ? LIMIT 1', [jobId]);
    return r ? r.name : null;
  } catch (_) {
    return null;
  }
}

async function loadScheduleGraph(conn, scheduleId) {
  const [[schedule]] = await conn.query('SELECT * FROM job_schedules WHERE id = ? LIMIT 1', [scheduleId]);
  if (!schedule) return { schedule: null, items: [], deps: [] };
  const [items] = await conn.query(
    'SELECT * FROM job_schedule_items WHERE schedule_id = ? ORDER BY sort_order ASC, id ASC',
    [scheduleId]
  );
  const [deps] = await conn.query(
    // include the row `id` so the client can DELETE a specific applied dependency
    'SELECT id, item_id, depends_on_item_id FROM job_schedule_deps WHERE schedule_id = ?',
    [scheduleId]
  );
  return { schedule, items, deps };
}

// Group per-item changes into ONE payload per assignee (batching rule).
function groupByAssignee(itemRows, jobName, senderId) {
  const byUser = new Map();
  for (const r of itemRows) {
    if (!r.userId) continue;
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId).push({
      tradeName: r.tradeName,
      newStartDate: r.newStartDate,
      durationDays: r.durationDays,
    });
  }
  const payloads = [];
  for (const [userId, items] of byUser.entries()) {
    payloads.push({ userId, jobName, items, senderId: senderId || null });
  }
  return payloads;
}

// Archive a schedule's linked tasks (archived_at + status_note, the same convention
// job-deletion uses) and soft-delete its stages (status=0), then mark the schedule
// archived. Used by the re-apply flow.
async function archiveSchedule(conn, scheduleId) {
  const [items] = await conn.query(
    'SELECT task_id, stage_id FROM job_schedule_items WHERE schedule_id = ?',
    [scheduleId]
  );
  const taskIds = items.map((i) => i.task_id).filter(Boolean);
  const stageIds = items.map((i) => i.stage_id).filter(Boolean);
  if (taskIds.length) {
    await conn.query(
      `UPDATE tasks
          SET archived_at = NOW(),
              status_note = COALESCE(NULLIF(status_note, ''), 'Archived: schedule re-applied')
        WHERE id IN (?) AND archived_at IS NULL`,
      [taskIds]
    );
  }
  if (stageIds.length) {
    await conn.query('UPDATE stages SET status = 0, updated_at = NOW() WHERE id IN (?)', [stageIds]);
  }
  await conn.query("UPDATE job_schedules SET status = 'archived', updated_at = NOW() WHERE id = ?", [scheduleId]);
}

/**
 * Apply a template to a job: archive any prior active schedule, deep-copy the
 * template's items + deps into an independent instance, compute dates, and create
 * one task + one (name-only) stage per item. Returns { scheduleId, notifPayloads }.
 * Runs entirely on the caller's connection/transaction; the caller dispatches the
 * returned notifPayloads after commit.
 */
async function applyTemplateToJob(conn, opts) {
  const {
    templateId,
    jobId,
    ownerType = 'job',
    startDate,
    skipSaturday = false,
    skipSunday = false,
    assignments = [],
    actorId = null,
  } = opts;
  const ot = ownerType === 'lead' ? 'lead' : 'job';
  const now = getTimeStamp();

  // 1. Archive any existing ACTIVE schedule for this job (re-apply rule).
  const [activeRows] = await conn.query(
    "SELECT id FROM job_schedules WHERE job_id = ? AND owner_type = ? AND status = 'active'",
    [jobId, ot]
  );
  for (const a of activeRows) await archiveSchedule(conn, a.id);

  // 2. Load the template.
  const [tItems] = await conn.query(
    `SELECT id, name, default_duration_days, depends_on_all, is_inspection, sort_order
       FROM schedule_template_items WHERE template_id = ? ORDER BY sort_order ASC, id ASC`,
    [templateId]
  );
  if (!tItems.length) throw new Error('Template has no items');
  const tItemIds = tItems.map((i) => i.id);
  const [tDeps] = await conn.query(
    'SELECT item_id, depends_on_item_id FROM schedule_template_deps WHERE item_id IN (?)',
    [tItemIds]
  );
  const [[tpl]] = await conn.query('SELECT name FROM schedule_templates WHERE id = ? LIMIT 1', [templateId]);
  const tplName = tpl ? tpl.name : 'Schedule';

  // 3. Create the job_schedules row.
  const startYMD = engine.fmtYMD(engine.parseYMD(startDate) || new Date());
  const [js] = await conn.query(
    `INSERT INTO job_schedules
       (job_id, owner_type, source_template_id, name, start_date, skip_saturday, skip_sunday, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [jobId, ot, templateId, tplName, startYMD, skipSaturday ? 1 : 0, skipSunday ? 1 : 0, actorId]
  );
  const scheduleId = js.insertId;

  // 4. Deep-copy items (blank duration → 1 day for the applied copy).
  const assignMap = new Map();
  for (const a of assignments || []) {
    if (a && a.template_item_id != null) {
      assignMap.set(Number(a.template_item_id), a.assignee_user_id != null ? Number(a.assignee_user_id) : null);
    }
  }
  const newIdByTemplateItem = new Map();
  for (const ti of tItems) {
    const dur = (ti.default_duration_days == null || ti.default_duration_days === '')
      ? 1
      : engine.normalizeDuration(ti.default_duration_days);
    const assignee = assignMap.has(ti.id) ? assignMap.get(ti.id) : null;
    const [r] = await conn.query(
      `INSERT INTO job_schedule_items
         (schedule_id, name, duration_days, sort_order, assignee_user_id, template_item_id, depends_on_all, is_inspection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scheduleId, ti.name, dur, ti.sort_order, assignee, ti.id, ti.depends_on_all ? 1 : 0, ti.is_inspection ? 1 : 0]
    );
    newIdByTemplateItem.set(ti.id, r.insertId);
  }

  // 5. Copy deps, remapped to the new stable ids.
  for (const d of tDeps) {
    const ni = newIdByTemplateItem.get(d.item_id);
    const nd = newIdByTemplateItem.get(d.depends_on_item_id);
    if (ni && nd) {
      await conn.query(
        'INSERT IGNORE INTO job_schedule_deps (schedule_id, item_id, depends_on_item_id) VALUES (?, ?, ?)',
        [scheduleId, ni, nd]
      );
    }
  }

  // 6. Compute dates.
  const graph = await loadScheduleGraph(conn, scheduleId);
  const comp = engine.computeSchedule({
    items: graph.items.map((it) => ({
      id: it.id, name: it.name, duration_days: it.duration_days,
      depends_on_all: !!it.depends_on_all, pinned_start_date: it.pinned_start_date,
    })),
    deps: graph.deps,
    startDate: startYMD,
    skipSaturday,
    skipSunday,
  });
  if (!comp.ok) {
    const err = new Error('Template contains a dependency cycle');
    err.cycle = comp.cycle;
    throw err;
  }
  const conflictSet = new Map(comp.conflicts.map((c) => [c.itemId, c.reason]));

  // 7. Per item: create task + stage, store the computed dates + linkage.
  const jobName = await getJobName(conn, jobId, ot);
  for (const it of graph.items) {
    const r = comp.results[it.id];
    if (!r) continue;
    const conflictReason = conflictSet.get(it.id) || null;

    const [taskR] = await conn.query(
      `INSERT INTO tasks
         (task_name, user_id, team_id, duration_days, start_date, end_date, description,
          job_id, created_at, created_by, task_type, is_calendar_task, is_appointment_task, priority)
       VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 0, 'low')`,
      [it.name, it.assignee_user_id || null, r.duration, tsStart(r.start), tsStart(r.end), jobId, now, actorId, ot]
    );
    const taskId = taskR.insertId;

    const [stageR] = await conn.query(
      `INSERT INTO stages (user_id, name, csi_code, job_id, owner_type, status, progress_status, created_at)
       VALUES (?, ?, '', ?, ?, 1, 0, ?)`,
      [actorId || null, it.name, jobId, ot, now]
    );
    const stageId = stageR.insertId;

    await conn.query(
      `UPDATE job_schedule_items
          SET computed_start_date = ?, computed_end_date = ?, has_conflict = ?, conflict_reason = ?,
              task_id = ?, stage_id = ?
        WHERE id = ?`,
      [r.start, r.end, conflictReason ? 1 : 0, conflictReason, taskId, stageId, it.id]
    );
  }

  // 8. Batch the apply notification: one payload per assignee with all their trades.
  const assignedItems = graph.items
    .filter((it) => it.assignee_user_id)
    .map((it) => ({
      userId: it.assignee_user_id,
      tradeName: it.name,
      newStartDate: comp.results[it.id].start,
      durationDays: comp.results[it.id].duration,
    }));
  const notifPayloads = groupByAssignee(assignedItems, jobName, actorId);

  return { scheduleId, notifPayloads };
}

/**
 * Recompute one job's schedule after an edit. Re-runs the forward pass scoped to
 * this schedule_id, pushes changed dates onto the linked tasks (start/end/duration)
 * and keeps the linked stage names in sync, flags busts, and returns the batched
 * notification payloads for only the assignees whose dates actually moved. On a
 * cycle it flags the offending items and changes no dates. DB writes on `conn`;
 * caller dispatches the returned payloads after commit.
 */
async function recomputeSchedule(conn, scheduleId, { changedItemId } = {}) {
  const { schedule, items, deps } = await loadScheduleGraph(conn, scheduleId);
  if (!schedule) return [];

  const comp = engine.computeSchedule({
    items: items.map((it) => ({
      id: it.id, name: it.name, duration_days: it.duration_days,
      depends_on_all: !!it.depends_on_all, pinned_start_date: it.pinned_start_date,
    })),
    deps,
    startDate: toDateOnly(schedule.start_date),
    skipSaturday: !!schedule.skip_saturday,
    skipSunday: !!schedule.skip_sunday,
  });

  // REJECT-AT-WRITE-TIME: a cycle or a dependency "bust" (an item starting before
  // a dependency finishes — anywhere in the resulting graph, including downstream)
  // aborts the whole edit. We throw BEFORE writing anything, so the caller rolls
  // back the transaction and nothing is partially applied — the same treatment
  // cycles already got at the door. No has_conflict flag is ever persisted now.
  if (!comp.ok) {
    const err = new Error('This change would create a scheduling loop (an item would end up depending on itself).');
    err.code = 'CYCLE';
    err.cycle = comp.cycle;
    throw err;
  }
  if (comp.conflicts.length) {
    const err = new Error(comp.conflicts[0].reason);
    err.code = 'SCHEDULE_CONFLICT';
    err.bust = true;
    err.conflicts = comp.conflicts;
    throw err;
  }

  const jobName = await getJobName(conn, schedule.job_id, schedule.owner_type);
  const moved = [];

  for (const it of items) {
    const r = comp.results[it.id];
    if (!r) continue;
    const oldStart = toDateOnly(it.computed_start_date);
    const oldEnd = toDateOnly(it.computed_end_date);
    const dateChanged = oldStart !== r.start || oldEnd !== r.end;

    // Conflict-free by the time we reach here, so has_conflict is always cleared.
    await conn.query(
      `UPDATE job_schedule_items
          SET computed_start_date = ?, computed_end_date = ?, has_conflict = 0, conflict_reason = NULL
        WHERE id = ?`,
      [r.start, r.end, it.id]
    );

    if (dateChanged && it.task_id) {
      // Push new dates onto the linked task. end_date is the working-day-aware
      // computed end (kept in sync with the schedule so the calendar bar matches),
      // set directly rather than via the tasks route's calendar-day formula.
      await conn.query(
        'UPDATE tasks SET start_date = ?, end_date = ?, duration_days = ? WHERE id = ?',
        [tsStart(r.start), tsStart(r.end), r.duration, it.task_id]
      );
    }

    if (dateChanged && it.assignee_user_id) {
      moved.push({
        userId: it.assignee_user_id,
        tradeName: it.name,
        newStartDate: r.start,
        durationDays: r.duration,
      });
    }
  }

  return groupByAssignee(moved, jobName, schedule.created_by);
}

module.exports = {
  applyTemplateToJob,
  recomputeSchedule,
  loadScheduleGraph,
  archiveSchedule,
  getJobName,
};
