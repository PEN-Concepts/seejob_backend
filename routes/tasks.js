const express = require("express");
const router = express.Router();
const Joi = require('joi');
const pool = require("../config/connection");
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require("../services/authentication");
const { denyExpiredFreeWrites, isSameAccount, getAccessMode, resolveOwnerId, denyRestrictedJobData } = require("../utils/access");
const { requireOwnsRecord } = require("../utils/ownership");
const { attachAssignees } = require("../services/taskAssignees");
const { attachTaskImages } = require("../services/taskImages");

// For an expired_free user, keep ONLY tasks on FOREIGN (other-account) jobs/leads
// they collaborate on — hide everything on their own account's jobs/leads and
// their own no-job tasks. Preserves requirement #4 (collaborator tasks assigned by
// OTHER GCs stay visible) while fully locking their own data once the trial ends.
// No-op for paid/trial users (returns rows unchanged) and fails OPEN on error.
async function filterTasksForExpired(connection, userId, rows) {
  if (!rows || !rows.length || !userId) return rows;
  let mode = "paid";
  try {
    mode = await getAccessMode(userId, connection);
  } catch (e) {
    return rows; // fail open
  }
  if (mode !== "expired_free") return rows;
  try {
    const acct = await resolveOwnerId(userId, connection);
    const accountClause =
      "(SELECT id FROM `user` WHERE id = ? OR (created_by = ? AND category = 1))";
    let ownJobs = new Set();
    let ownLeads = new Set();
    try {
      const [j] = await connection.query(
        `SELECT id FROM job WHERE created_by IN ${accountClause}`,
        [acct, acct]
      );
      ownJobs = new Set(j.map((r) => Number(r.id)));
    } catch (e) { /* keep empty */ }
    try {
      const [l] = await connection.query(
        `SELECT id FROM leads WHERE user_id IN ${accountClause}`,
        [acct, acct]
      );
      ownLeads = new Set(l.map((r) => Number(r.id)));
    } catch (e) { /* keep empty */ }
    return rows.filter((r) => {
      const jid = Number(r.job_id);
      if (!r.job_id || jid === 0) return false; // own no-job/personal task
      const type = String(r.task_type || "job").toLowerCase();
      return type === "lead" ? !ownLeads.has(jid) : !ownJobs.has(jid);
    });
  } catch (e) {
    return rows; // fail open
  }
}
const { getTimeStamp } = require("../common/timdate");
const moment = require("moment-timezone");
const admin = require("../config/firebase-admin");
const logger = require("../common/logger");
const { recomputeSchedule } = require("../services/scheduleCascade");
const notify = require("../services/notify");

// Ensure the dedupe ledger for subcontractor seed-jobs exists (idempotent).
async function ensureSeedJobTable(connection) {
  try {
    await connection.query(
      `CREATE TABLE IF NOT EXISTS subcontractor_seed_jobs (
         id INT AUTO_INCREMENT PRIMARY KEY,
         source_job_id INT NOT NULL,
         sub_user_id INT NOT NULL,
         new_job_id INT NOT NULL,
         created_at DATETIME NOT NULL,
         UNIQUE KEY uq_seed (source_job_id, sub_user_id)
       )`
    );
  } catch (e) {
    logger.error("ensureSeedJobTable: " + e.message);
  }
}

/**
 * When a GC assigns a task to a subcontractor, give that sub their OWN
 * independent job to run — seeded with just the job name, address and
 * homeowner name. It is NOT linked to the GC's job (no sharing/sync); it's
 * only to "get the ball rolling". Deduped so re-assigning never makes copies.
 * The sub's job is owned by them (created_by = sub), so the existing access
 * rules keep it hidden until they're on a paid plan (Basic+).
 */
async function maybeCreateSeedJob(connection, sourceJobId, subUserId, gcUserId) {
  const src = Number(sourceJobId);
  const sub = Number(subUserId);
  if (!src || !sub || sub === Number(gcUserId)) return; // need a real job + a real (other) sub

  await ensureSeedJobTable(connection);

  const [exist] = await connection.query(
    "SELECT id FROM subcontractor_seed_jobs WHERE source_job_id = ? AND sub_user_id = ? LIMIT 1",
    [src, sub]
  );
  if (exist.length) return; // already seeded for this sub + job

  const [jobRows] = await connection.query(
    `SELECT j.type, j.name, j.address, j.city, j.state, j.zipcode,
            COALESCE(u.name, j.additional_client_name) AS homeowner
       FROM job j LEFT JOIN user u ON u.id = j.client_id
      WHERE j.id = ? LIMIT 1`,
    [src]
  );
  if (!jobRows.length) return;
  const j = jobRows[0];

  // Mirror the columns the normal job-create uses so no NOT-NULL column is
  // missed; everything except name/address/homeowner is left empty/default.
  const [ins] = await connection.query(
    `INSERT INTO job (
       type, name, permit_no, permit_type, gate_no, lock_box_code,
       inspector_id, client_id, additional_client_email, additional_client_mobile, additional_client_name,
       address, city, state, zipcode,
       job_address, job_city, job_state, job_zipcode,
       sameAsAddress, contract_status, status, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      j.type || "Residential",
      j.name || "Job",
      null, null, null, null,        // permit_no, permit_type, gate_no, lock_box_code
      null, null,                    // inspector_id, client_id (no link to GC's client)
      null, null,                    // additional_client_email, additional_client_mobile
      j.homeowner || null,           // additional_client_name = homeowner
      j.address || null,
      j.city || null,
      j.state || null,
      j.zipcode || null,
      null, null, null, null,        // job_address/city/state/zipcode
      0,                             // sameAsAddress
      "",                            // contract_status
      1,                             // status (active)
      sub,                           // created_by = the subcontractor owns it
    ]
  );

  await connection.query(
    "INSERT INTO subcontractor_seed_jobs (source_job_id, sub_user_id, new_job_id, created_at) VALUES (?, ?, ?, NOW())",
    [src, sub, ins.insertId]
  );
}

// attachTaskImages moved to services/taskImages.js so routes/jobs.js (/all-tasks,
// the mobile task list) can attach photos too. Imported at the top of this file.
// ----------job's task assignment----------------
const taskSchema = Joi.object({
  task_name: Joi.string().allow('', null).max(255).optional(),
  user_id: Joi.any().optional(),
  assignees: Joi.any().optional(),               // Multi-assignee: array of user ids (user_id stays = primary)
  team_id: Joi.any().optional(),
  duration_days: Joi.number().integer().min(1).optional(),
  nudge: Joi.date().optional(),
  start_date: Joi.date().optional(),
  end_date: Joi.date().optional(),
  time: Joi.date().optional(),
  complete_percentage: Joi.number().min(0).max(100).allow(null).optional(),
  priority: Joi.string().valid('low', 'medium', 'high').optional(),
  is_urgent: Joi.any().optional(),               // Phase-1 Urgent escalation flag
  completion_response: Joi.string().allow(null, '').optional(), // one-time written reply on complete
  description: Joi.string(),
  image: Joi.string().allow(null, "").max(255),
  assignee_completed: Joi.any().optional(),
  // job_id can be null for "No Job" tasks
  job_id: Joi.number().integer().allow(null).optional(),
  id: Joi.any().optional(),
  status: Joi.any().optional(),
  task_type: Joi.string().required(),
  is_calendar_task: Joi.any().optional(),
  is_appointment_task: Joi.any().optional(),
});

// Multi-assignee: normalize an incoming assignees payload (array of ids, or a
// single id) into a de-duped list of positive integers. Falls back to the legacy
// single `user_id` when no `assignees` is sent, so old clients keep working
// unchanged. The FIRST id is the primary (mirrored into tasks.user_id).
function normalizeAssignees(rawAssignees, legacyUserId) {
  let list = [];
  if (Array.isArray(rawAssignees)) list = rawAssignees;
  else if (rawAssignees !== undefined && rawAssignees !== null && rawAssignees !== '') list = [rawAssignees];
  else if (legacyUserId !== undefined && legacyUserId !== null && legacyUserId !== '') list = [legacyUserId];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Replace a task's assignee set in task_assignees. Preserves each KEPT person's
// per-person seen_at (INSERT IGNORE never touches an existing row); removes only
// those no longer assigned. Empty list clears all rows (e.g. reassigned to a team).
async function syncTaskAssignees(connection, taskId, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) {
    await connection.query('DELETE FROM task_assignees WHERE task_id=?', [taskId]);
    return;
  }
  const placeholders = userIds.map(() => '?').join(',');
  await connection.query(
    `DELETE FROM task_assignees WHERE task_id=? AND user_id NOT IN (${placeholders})`,
    [taskId, ...userIds]
  );
  const rows = userIds.map(() => '(?, ?)').join(',');
  const params = [];
  userIds.forEach((uid) => { params.push(taskId, uid); });
  await connection.query(
    `INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES ${rows}`,
    params
  );
}

// Normalize team_id from request body. Returns Number or null.
function normalizeTeamId(value) {
  if (value === undefined || value === null) return null;
  if (value === '' || value === 'null' || value === 'undefined') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function toMySQLDateTime(input) {
  // Accept Date or string; if string without time, default time to 00:00:00
  let date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'string') {
    // If only date part provided (YYYY-MM-DD), return literal date at 00:00:00 without timezone shifting
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input);
    if (dateOnly) {
      return `${input} 00:00:00`;
    }
    // If time provided, parse into Date
    // Always prefer system date semantics: if the string is ISO with timezone (e.g. ends with 'Z' or has +hh:mm),
    // construct the MySQL string using UTC components to avoid a calendar-day shift when storing as DATETIME.
    date = new Date(input);
    if (typeof input === 'string' && (/Z$/i.test(input) || /[+\-]\d{2}:?\d{2}$/.test(input))) {
      if (!isNaN(date.getTime())) {
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const mi = String(date.getUTCMinutes()).padStart(2, '0');
        const ss = String(date.getUTCSeconds()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
      }
    }
  } else {
    return null;
  }

  if (isNaN(date.getTime())) return null;

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function normalizeDurationDays(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

function parseDateInputToLocalDate(input) {
  if (!input) return null;
  if (input instanceof Date) return new Date(input);
  if (typeof input === 'string') {
    const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    }
  }
  const date = new Date(input);
  return isNaN(date.getTime()) ? null : date;
}

function calculateTaskEndDate(startInput, durationDays) {
  const start = parseDateInputToLocalDate(startInput);
  if (!start) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + normalizeDurationDays(durationDays) - 1);
  return toMySQLDateTime(end);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const taskId = req.params?.taskId || req.params?.id || 'misc';
    const absDir = path.join(__dirname, '..', 'uploads', 'tasks', String(taskId));
    try {
      fs.mkdirSync(absDir, { recursive: true });
    } catch (e) {
      return cb(e);
    }
    cb(null, absDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = String(file && file.mimetype ? file.mimetype : '').toLowerCase();
    if (type.startsWith('image/') || type.startsWith('video/')) {
      return cb(null, true);
    }
    req.fileValidationError = 'Only image/video files are allowed.';
    return cb(null, false);
  },
});

// Send an immediate nudge to the assigned user of a task
// Returns the task row if the caller may access it — its assignee, or a member of
// the account that owns it — else null. Central cross-account guard for the by-id
// task routes (was: any task reachable/mutable by id).
async function loadAccessibleTask(userId, taskId) {
  const [[t]] = await pool.query(
    "SELECT id, created_by, user_id, job_id FROM tasks WHERE id = ? LIMIT 1",
    [taskId]
  );
  if (!t) return null;
  if (Number(t.user_id) === Number(userId)) return t;
  if (await isSameAccount(userId, t.created_by)) return t;
  return null;
}

router.post('/nudge/:id', auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  try {
    const taskId = req.params.id;
    const actorId = req.user.id;

    const [[task]] = await pool.query(
      'SELECT user_id, task_name, created_by FROM tasks WHERE id=?',
      [taskId]
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    // SECURITY: only nudge a task in your own account (was IDOR nudge-spam).
    if (!(await isSameAccount(actorId, task.created_by))) {
      return res.status(403).json({ message: 'This task does not belong to your account.' });
    }
    if (!task.user_id) {
      return res.status(400).json({ message: 'Task has no assigned user' });
    }

    // Target a SPECIFIC assignee (multi-assignee Nudge from Viewing Task) or the
    // primary assignee (legacy empty-body nudge). A named target must actually be
    // assigned to this task.
    const { target_user_id, message } = req.body || {};
    let recipientId = task.user_id;
    if (target_user_id != null && Number(target_user_id) !== Number(task.user_id)) {
      const [[isAssignee]] = await pool.query(
        'SELECT 1 AS ok FROM task_assignees WHERE task_id=? AND user_id=? LIMIT 1',
        [taskId, target_user_id]
      );
      if (!isAssignee) {
        return res.status(400).json({ message: 'That person is not assigned to this task.' });
      }
      recipientId = Number(target_user_id);
    }

    const [[actorRow]] = await pool.query(
      'SELECT name FROM user WHERE id=?',
      [actorId]
    );
    const actorName = actorRow ? actorRow.name : 'Someone';

    const url = '/task';
    // Send the message as typed (from the Nudge composer); fall back to the default.
    // The ORIGINAL TASK is always shown so the recipient knows what's being nudged
    // (seen != done — a nudge can follow a "seen"): task name in the push title, and
    // appended to the in-app record when a custom message would otherwise omit it.
    const customText = (message == null ? '' : String(message)).trim();
    const bodyText = customText || `${actorName} nudged you on task: "${task.task_name}".`;
    const pushTitle = `Nudge: ${task.task_name}`;
    const contentText = customText ? `${customText} — "${task.task_name}"` : bodyText;

    // Insert notification record
    await pool.query(
      `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [actorId, recipientId, contentText, url, actorId]
    );

    // Send an FCM push to EVERY device the recipient has registered.
    const [tokens] = await pool.query(
      'SELECT fcm_token FROM user_device_tokens WHERE user_id=?',
      [recipientId]
    );
    for (const row of tokens) {
      if (!row || !row.fcm_token) continue;
      try {
        await admin.messaging().send({
          token: row.fcm_token,
          notification: { title: pushTitle, body: bodyText },
          data: { type: 'task_nudge', task_id: String(taskId), url },
        });
      } catch (err) {
        logger.error('FCM Error:', err);
      }
    }

    res.status(200).json({ message: 'Nudge sent' });
  } catch (err) {
    logger.error("Nudge error:", err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// CREATE task
router.post("/create", auth.authenticateToken, denyExpiredFreeWrites, upload.single('image'), async (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).json({ message: req.fileValidationError });
  }

  let connection;
  const signedin_user = res.locals.id;


  const currentTimestamp = getTimeStamp();

  try {
    
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Normalize to an array
    const tasks = Array.isArray(req.body) ? req.body : [req.body];

    const insertedTasks = [];

    for (const task of tasks) {
      // Normalize nullable fields that sometimes arrive as empty strings from the frontend
      if (task && (task.job_id === '' || task.job_id === 'null' || task.job_id === 'undefined')) {
        task.job_id = null;
      }
      // Treat job_id=0 as "No Job" (store as NULL)
      if (task && (task.job_id === 0 || task.job_id === '0')) {
        task.job_id = null;
      }

      const { error } = taskSchema.validate(task);
      if (error) {
        throw new Error(error.details[0].message);
      }

      const {
        task_name,
        user_id,
        duration_days,
        start_date,
        end_date,
        time,
        priority,
        description,
        image,
        audio_note,
        assignee_completed,
        job_id,
        task_type,
        is_calendar_task,
        is_appointment_task,
      } = task;
      const team_id = normalizeTeamId(task.team_id);
      const finalDurationDays = normalizeDurationDays(duration_days);
      // Multi-assignee: full set from `assignees` (or legacy single user_id).
      // tasks.user_id stays = the PRIMARY (first) so every single-assignee query,
      // notification, and seed-job path keeps working. Team tasks have no per-user
      // assignees (the team is the target), matching the existing finalUserId=null.
      const assigneeList = team_id ? [] : normalizeAssignees(task.assignees, user_id);
      const finalUserId = team_id ? null : (assigneeList.length ? assigneeList[0] : null);
      const effectiveStartInput = start_date || new Date();

      // Respect provided dates; default start_date to today if missing
      const formattedStartDate = toMySQLDateTime(effectiveStartInput);
      const formattedEndDate = calculateTaskEndDate(effectiveStartInput, finalDurationDays);
      const formattedTime = time ? toMySQLDateTime(time) : null;
      const finalPriority = priority ?? 'low';

      const urgentFlag = (req.body.is_urgent === 1 || req.body.is_urgent === true || req.body.is_urgent === '1') ? 1 : 0;
      const sql = `
        INSERT INTO tasks
        (task_name, user_id, team_id, duration_days, start_date, end_date, description, image, audio_note, assignee_completed, job_id, created_at, created_by, task_type, is_calendar_task, is_appointment_task, time, priority, is_urgent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        task_name,
        finalUserId,
        team_id,
        finalDurationDays,
        formattedStartDate,
        formattedEndDate,
        description,
        image,
        audio_note || null,
        assignee_completed ? 1 : 0,
        job_id,
        currentTimestamp,
        signedin_user,
        task_type,
        is_calendar_task ?? 0,
        is_appointment_task ?? 0,
        formattedTime,
        finalPriority,
        urgentFlag,
      ];

      const [result] = await connection.query(sql, values);

      // Seed the join table with the full assignee set (primary already mirrored
      // into tasks.user_id above). No-op for team tasks (empty list).
      if (assigneeList.length) {
        await syncTaskAssignees(connection, result.insertId, assigneeList);
      }

      insertedTasks.push({
        id: result.insertId,
        task_name,
        is_urgent: urgentFlag,
        user_id: finalUserId,
        assignees: assigneeList,
        team_id,
        duration_days: finalDurationDays,
        start_date: formattedStartDate,
        end_date: formattedEndDate,
        time: formattedTime,
        priority: finalPriority,
        description,
        image,
        assignee_completed: assignee_completed ? 1 : 0,
        job_id,
        created_by: signedin_user,
        task_type,
        is_calendar_task: is_calendar_task ?? 0,
        is_appointment_task: is_appointment_task ?? 0,
      });
    }

    await connection.commit();

    // Give each newly-assigned subcontractor their own seed job (independent,
    // name/address/homeowner only). Runs after commit so a hiccup here never
    // affects task creation; deduped per (job, sub).
    for (const t of insertedTasks) {
      if (!t.job_id) continue;
      const subs = (t.assignees && t.assignees.length) ? t.assignees : (t.user_id ? [t.user_id] : []);
      for (const sub of subs) {
        try {
          await maybeCreateSeedJob(connection, t.job_id, sub, signedin_user);
        } catch (e) {
          logger.error("maybeCreateSeedJob: " + e.message);
        }
      }
    }

    // Notify each newly-assigned user (real assignee, not the creator) with an
    // in-app notification + a real push, so the assignment reaches them even
    // with the app closed — batched per person so a multi-task assign isn't
    // spammy. Best-effort, after commit (never affects task creation). Team
    // assignments (finalUserId null) are skipped, matching the /nudge behavior.
    try {
      const [[actorRow]] = await connection.query("SELECT name FROM `user` WHERE id=?", [signedin_user]);
      const actorName = (actorRow && actorRow.name) ? actorRow.name : 'Someone';
      const byUser = new Map();
      for (const t of insertedTasks) {
        // Notify EVERY assignee (multi-assignee), not just the primary.
        const targets = (t.assignees && t.assignees.length) ? t.assignees : (t.user_id ? [t.user_id] : []);
        for (const uid of targets) {
          if (!uid || String(uid) === String(signedin_user)) continue;
          if (!byUser.has(uid)) byUser.set(uid, { names: [], urgent: false });
          const g = byUser.get(uid);
          g.names.push(t.task_name);
          if (Number(t.is_urgent) === 1) g.urgent = true; // any urgent task → red push
        }
      }
      for (const [uid, g] of byUser) {
        const names = g.names;
        const content = names.length === 1
          ? `${actorName} assigned you a task: "${names[0]}".`
          : `${actorName} assigned you ${names.length} tasks.`;
        try {
          await notify.insertNotification(connection, { senderId: signedin_user, receiverId: uid, content, url: '/task' });
          await notify.sendPushToUser(connection, uid, {
            title: g.urgent ? 'Urgent Task' : 'New Task Assigned',
            body: content, url: 'task', type: 'task', urgent: g.urgent,
          });
        } catch (e) { logger.error('task-assign notify (user ' + uid + '): ' + e.message); }
      }
    } catch (e) { logger.error('task-assign notify: ' + e.message); }

    // If a single task was created, return just its ID to match frontend expectations
    const responseData = insertedTasks.length === 1 ? insertedTasks[0].id : insertedTasks;
    res.status(201).json({
      success: true,
      message: "Task(s) assigned successfully!",
      data: responseData,
    });

  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error creating task(s):", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  } finally {
    if (connection) connection.release();
  }
});

// READ all job tasks
router.get("/all_job_task/:id", auth.authenticateToken, denyRestrictedJobData, async (req, res) => {
  // Support single or comma-separated list of job IDs, e.g. "10" or "10,9,8"
  const idsParam = req.params.id;
  const jobIds = (typeof idsParam === "string" && idsParam.trim() !== "")
    ? idsParam
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => !isNaN(id))
    : [];

  const loggedInUserId = req.user && req.user.id;
  const effectiveCreatorId =
    req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
      ? Number(req.user.working_id)
      : Number(loggedInUserId);

  let connection;

  try {
    connection = await pool.getConnection();

    const includeNoJob =
      String(req.query?.includeNoJob ?? '').trim() === '1' ||
      String(req.query?.includeNoJob ?? '').trim().toLowerCase() === 'true';
    const includeArchived =
      String(req.query?.includeArchived ?? '').trim() === '1' ||
      String(req.query?.includeArchived ?? '').trim().toLowerCase() === 'true';
    const archivedClause = includeArchived ? '' : 'AND jt.archived_at IS NULL';

    let whereJob;
    let params;
    if (jobIds.length) {
      whereJob = includeNoJob
        ? `(jt.job_id IN (?) OR (jt.job_id IS NULL OR jt.job_id = 0))`
        : `jt.job_id IN (?)`;
      params = [jobIds, loggedInUserId, effectiveCreatorId, effectiveCreatorId, loggedInUserId];
    } else {
      whereJob = includeNoJob
        ? `(jt.job_id IS NULL OR jt.job_id = 0)`
        : `(jt.job_id IS NOT NULL AND jt.job_id <> 0)`;
      params = [loggedInUserId, effectiveCreatorId, effectiveCreatorId, loggedInUserId];
    }

    const baseSql = `SELECT jt.*,
              u.name as assignto,
              jt.task_type,
              COALESCE(j.name, 'No Job') as job_name,
              t.team_name,
              t.team_color,
              t.team_leader,
              tl.name AS team_leader_name,
              uc.name as created_by_name,
              (SELECT jsi.id FROM job_schedule_items jsi WHERE jsi.task_id = jt.id LIMIT 1) AS schedule_item_id,
              (SELECT jsi.has_conflict FROM job_schedule_items jsi WHERE jsi.task_id = jt.id LIMIT 1) AS schedule_has_conflict
       FROM tasks jt
       LEFT JOIN user u ON u.id = jt.user_id
       LEFT JOIN job j ON j.id = jt.job_id
       LEFT JOIN teams t ON t.id = jt.team_id
       LEFT JOIN user tl ON tl.id = t.team_leader
       LEFT JOIN user uc ON uc.id = jt.created_by
       WHERE ${whereJob}
         AND jt.task_type = 'job'
         ${archivedClause}
         AND (
           jt.user_id = ?
           OR jt.created_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)
           OR (jt.team_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM team_user tu
                 WHERE tu.team_id = jt.team_id AND tu.user_id = ?
               ))
         )
       ORDER BY jt.status ASC, jt.created_at DESC;`;

    const [rows] = await connection.query(baseSql, params);
    await attachTaskImages(connection, rows);
    await attachAssignees(connection, rows);

    const visible = await filterTasksForExpired(connection, loggedInUserId, rows);
    res.status(200).json(visible);
  } catch (err) {
    logger.error("Error fetching tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// COMPANY-WIDE SCHEDULE feed: EVERY task that has a date, across the whole
// account — job tasks AND jobless personal tasks, assigned or unassigned, with
// a job or without, regardless of whether it was ever added to the Master
// Calendar. Excludes: lead tasks (they point at `leads`, not `job`), archived
// tasks, and — the PRIVACY RULE — another account member's JOBLESS task that
// they assigned ONLY to themselves (a personal My-Daily-Tasks-style list).
// A real JOB task stays company-visible even when self-assigned. Notepad
// (check_list), Spartan goals, and appointments live in other tables, so this
// tasks query excludes them by construction.
//
// PRIVACY IS ENFORCED HERE (server-side): identity (:me = req.user.id) and the
// account root (:owner) are only trustworthy on the server, so a private
// jobless task is never shipped to another member's client at all.
router.get("/company_calendar", auth.authenticateToken, denyRestrictedJobData, async (req, res) => {
  const loggedInUserId = req.user && req.user.id;                 // :me — authoritative identity
  const ownerId =
    req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
      ? Number(req.user.working_id)                               // delegated login → account root
      : Number(loggedInUserId);                                   // owner logs in directly
  let connection;
  try {
    connection = await pool.getConnection();
    const sql = `SELECT jt.*,
              u.name as assignto,
              jt.task_type,
              COALESCE(j.name, 'No Job') as job_name,
              t.team_name,
              t.team_color,
              t.team_leader,
              tl.name AS team_leader_name,
              uc.name as created_by_name,
              (SELECT jsi.id FROM job_schedule_items jsi WHERE jsi.task_id = jt.id LIMIT 1) AS schedule_item_id,
              (SELECT jsi.has_conflict FROM job_schedule_items jsi WHERE jsi.task_id = jt.id LIMIT 1) AS schedule_has_conflict
       FROM tasks jt
       LEFT JOIN user u ON u.id = jt.user_id
       LEFT JOIN job j ON j.id = jt.job_id
       LEFT JOIN teams t ON t.id = jt.team_id
       LEFT JOIN user tl ON tl.id = t.team_leader
       LEFT JOIN user uc ON uc.id = jt.created_by
       WHERE jt.start_date IS NOT NULL
         AND jt.task_type IN ('job', 'task')
         AND jt.archived_at IS NULL
         -- company-wide: every task authored within this account (owner + their members)
         AND jt.created_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)
         AND (
              (jt.job_id IS NOT NULL AND jt.job_id <> 0)   -- has a real job → company-visible
              OR jt.created_by = ?                          -- my OWN jobless task → visible to me
              OR NOT (                                       -- else: another member's PRIVATE jobless task → hide
                   jt.team_id IS NULL
                   AND jt.user_id IS NOT NULL
                   AND jt.user_id = jt.created_by
                   AND NOT EXISTS (SELECT 1 FROM task_assignees ta
                                    WHERE ta.task_id = jt.id AND ta.user_id <> jt.created_by)
              )
         )
       ORDER BY jt.start_date ASC;`;
    const [rows] = await connection.query(sql, [ownerId, ownerId, loggedInUserId]);
    await attachTaskImages(connection, rows);
    await attachAssignees(connection, rows);
    const visible = await filterTasksForExpired(connection, loggedInUserId, rows);
    res.status(200).json(visible);
  } catch (err) {
    logger.error("Error fetching company calendar tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// READ all lead tasks
router.get("/all_lead_task/:id", auth.authenticateToken, denyRestrictedJobData, async (req, res) => {
  const idsParam = req.params.id;
  const jobIds = (typeof idsParam === "string" && idsParam.trim() !== "")
    ? idsParam
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => !isNaN(id))
    : [];

  const loggedInUserId = req.user && req.user.id;

  try {
    const [rows] = await pool.query(
      `SELECT jt.*,
              u.name as assignto,
              jt.task_type,
              j.lead_name as job_name,
              t.team_name,
              t.team_color,
              t.team_leader,
              tl.name AS team_leader_name,
              uc.name as created_by_name
       FROM tasks jt
       LEFT JOIN user u ON u.id = jt.user_id
       LEFT JOIN leads j ON j.id = jt.job_id
       LEFT JOIN teams t ON t.id = jt.team_id
       LEFT JOIN user tl ON tl.id = t.team_leader
       LEFT JOIN user uc ON uc.id = jt.created_by
       WHERE jt.job_id IN (?)
         AND LOWER(jt.task_type) = 'lead'
         AND jt.archived_at IS NULL
         AND (
           jt.user_id = ?
           OR jt.created_by = ?
           OR (jt.team_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM team_user tu
                 WHERE tu.team_id = jt.team_id AND tu.user_id = ?
               ))
         )
       ORDER BY jt.status ASC, jt.created_at DESC;`,
      [jobIds, loggedInUserId, loggedInUserId, loggedInUserId]
    );
    await attachTaskImages(pool, rows);
    await attachAssignees(pool, rows);
    const visible = await filterTasksForExpired(pool, loggedInUserId, rows);
    res.status(200).json(visible);
  } catch (err) {
    logger.error("Error fetching lead tasks", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Dashboard: today's tasks for the logged-in user
router.get("/daily_tasks", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const assigneeId = req.user.id; // logged-in user 
    // SECURITY: only honor ?user_id= if it belongs to the caller's own account
    // (was IDOR — any user's daily tasks by passing their id).
    let managerId = assigneeId;
    if (req.query.user_id && /^\d+$/.test(String(req.query.user_id))) {
      const reqId = Number(req.query.user_id);
      if (reqId === Number(assigneeId) || (await isSameAccount(assigneeId, reqId))) {
        managerId = reqId;
      }
    }
    const targetDate = (req.query.date && typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : null;

    // "Today" is the REQUESTING user's LOCAL calendar day (their saved timezone),
    // not the DB server's CURDATE(). An explicit ?date= (already validated above)
    // always overrides. Falls back to the process default (Pacific) if the user's
    // timezone is unset/invalid.
    let effectiveDate = targetDate;
    if (!effectiveDate) {
      const DEFAULT_TZ = process.env.TZ || 'America/Los_Angeles';
      let userTz = DEFAULT_TZ;
      try {
        const [[tzRow]] = await connection.query(
          'SELECT timezone FROM `user` WHERE id = ? LIMIT 1',
          [assigneeId]
        );
        if (tzRow && tzRow.timezone && moment.tz.zone(tzRow.timezone)) userTz = tzRow.timezone;
      } catch (e) { /* keep default */ }
      effectiveDate = moment.tz(userTz).format('YYYY-MM-DD');
    }

    const sql = `
      SELECT 
        t.id, 
        t.task_name, 
        t.start_date, 
        t.time,
        t.priority,
        t.is_urgent,
        t.assignee_seen_at,
        u.name AS createdBy,
        t.status,
        t.job_id,
        t.task_type,
        COALESCE(j.name, 'No Job') AS jobName,
        t.user_id AS assignedTo,
        au.name AS assignedToName,
        tm.team_name AS assignedTeamName
      FROM tasks t
      INNER JOIN user u ON u.id = t.created_by
      LEFT JOIN job j ON j.id = t.job_id
      LEFT JOIN user au ON au.id = t.user_id
      LEFT JOIN teams tm ON tm.id = t.team_id
      WHERE
        (
          t.user_id = ?
          OR t.created_by = ?
          OR (t.team_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM team_user tu
                WHERE tu.team_id = t.team_id AND tu.user_id = ?
              ))
        )
        -- Not checked off yet
        AND (t.status IS NULL OR t.status <> 1)
        -- Not archived (e.g. its parent job was deleted)
        AND t.archived_at IS NULL
        -- Don't surface ORPHANED LEAD TASKS: a task_type='lead' row whose parent
        -- lead was deleted or closed (status=3). Task Manager/Spartan only list
        -- ACTIVE leads (status<>3), so such a task can't be opened there and
        -- clicking "View Details" dead-ends on the "not in Task Manager" toast.
        -- (Its job_id points at a LEAD id, so the job LEFT JOIN misses and it
        -- also gets mislabeled "No Job".) Keep it consistent with those views.
        AND NOT (
          LOWER(t.task_type) = 'lead'
          AND NOT EXISTS (
            SELECT 1 FROM leads l2
            WHERE l2.id = t.job_id AND (l2.status IS NULL OR l2.status <> 3)
              AND (l2.bid_status IS NULL OR l2.bid_status <> 'Archived')
          )
        )
        -- Effective date (due date, or created date if undated) today or earlier;
        -- keep every unchecked task carried forward (no age cap).
        AND COALESCE(t.start_date, t.created_at) < DATE_ADD(COALESCE(?, CURDATE()), INTERVAL 1 DAY)
      ORDER BY (t.start_date IS NULL), COALESCE(t.start_date, t.created_at) ASC
    `;

    const params = [managerId, managerId, managerId, effectiveDate];
    const [rows] = await connection.query(sql, params);
    await attachTaskImages(connection, rows);
    await attachAssignees(connection, rows);

    // Expired free trial: hide the user's OWN job/lead tasks (and own no-job
    // tasks); keep only tasks assigned to them on a FOREIGN GC's job (#4).
    const visible = await filterTasksForExpired(connection, assigneeId, rows);

    if (!visible || visible.length === 0) {
      return res.status(200).json([]);
    }

    res.status(200).json(visible);
  } catch (err) {
    logger.error("Error fetching daily tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// READ single task
router.get("/:id", auth.authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [
      req.params.id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ message: "Task not found" });

    const task = rows[0];
    const userId = req.user && req.user.id ? req.user.id : res.locals && res.locals.id;
    // SECURITY: only the assignee or a member of the owning account may read this
    // task (was IDOR — any task's full detail by id).
    if (Number(task.user_id) !== Number(userId) && !(await isSameAccount(userId, task.created_by))) {
      return res.status(403).json({ message: "This task does not belong to your account." });
    }
    // Expired free trial: a task on the user's OWN job/lead is locked; a task
    // assigned to them on a FOREIGN job stays readable (#4).
    const visible = await filterTasksForExpired(pool, userId, [task]);
    if (!visible.length) {
      return res.status(403).json({
        success: false,
        code: "TRIAL_EXPIRED",
        message: "Your free trial has ended. Your data is saved — upgrade to view or edit it again.",
      });
    }
    await attachTaskImages(pool, [task]);
    await attachAssignees(pool, [task]);

    res.status(200).json(task);
  } catch (err) {
    logger.error("Error fetching task", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update Images
router.put("/update/:id", upload.single("image"), auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  let connection;
  try {
    const signedin_user = res.locals.id;
    const {
      task_name,
      user_id,
      duration_days,
      start_date,
      end_date,
      time,
      priority,
      complete_percentage,
      description,
      image,
      audio_note,
      assignee_completed,
      job_id,
      nudge,
      status,
      status_note,
      task_type,
      is_calendar_task,
      is_appointment_task,
    } = req.body;

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Fetch OLD task before update — pull team_id too so we can enforce
    // team-leader-only completion and propagate team membership correctly.
    const [[oldTask]] = await connection.query(
      "SELECT id, user_id, team_id, created_by, duration_days, assignee_completed, status, task_name, description, job_id, start_date, end_date, time, is_appointment_task FROM tasks WHERE id=?",
      [req.params.id]
    );

    if (!oldTask) {
      await connection.rollback();
      return res.status(404).json({ message: "Task not found" });
    }

    const hasTeamIdInBody = Object.prototype.hasOwnProperty.call(req.body, 'team_id');
    const incomingTeamId = hasTeamIdInBody
      ? normalizeTeamId(req.body.team_id)
      : (oldTask.team_id ?? null);

    const oldUser = oldTask.user_id;            // Previous assigned user
    // Multi-assignee: full set from `assignees` (or legacy single user_id). The
    // PRIMARY (first) is mirrored into tasks.user_id so all single-assignee paths
    // keep working. Team tasks carry no per-user assignees.
    const assigneeList = incomingTeamId ? [] : normalizeAssignees(req.body.assignees, user_id);
    const newUser = incomingTeamId ? null : (assigneeList.length ? assigneeList[0] : null);

    const actorId = req.user.id;
    const actorRole = Number(req.user.role);
    const isGC = actorRole === 14;

    // Rule 2 (ownership): only the owning account may edit a task. The assignee
    // of a task assigned from ANOTHER account may not edit it freely — the one
    // thing they may do is re-assign it, and only to one of their OWN contacts.
    const ownsTask = await isSameAccount(actorId, oldTask.created_by, connection);
    const isAssignee = Number(oldTask.user_id || 0) === Number(actorId);
    if (!ownsTask && !isAssignee) {
      await connection.rollback();
      return res.status(403).json({
        code: "OWNERSHIP_DENIED",
        message: "You can only edit tasks that belong to your account.",
      });
    }
    if (
      !ownsTask &&
      isAssignee &&
      newUser &&
      Number(newUser) !== Number(oldUser)
    ) {
      const [contactRows] = await connection.query(
        "SELECT 1 FROM contact WHERE request_by = ? AND request_to = ? AND status = 'Accept' LIMIT 1",
        [actorId, newUser]
      );
      if (!contactRows.length) {
        await connection.rollback();
        return res.status(403).json({
          code: "NOT_YOUR_CONTACT",
          message:
            "You can only re-assign this task to someone in your own contacts.",
        });
      }
    }

    // Employees (foreman) may be allowed to complete tasks on behalf of their GC/creator.
    // Determine manager (creator) for this user.
    const [[creatorRow]] = await connection.query(
      'SELECT created_by FROM user WHERE id = ? LIMIT 1',
      [actorId],
    );
    const managerId = creatorRow && creatorRow.created_by ? Number(creatorRow.created_by) : null;
    let managerIsGC = false;
    if (managerId) {
      const [[mgrRow]] = await connection.query(
        'SELECT role FROM user WHERE id = ? LIMIT 1',
        [managerId],
      );
      managerIsGC = !!mgrRow && Number(mgrRow.role) === 14;
    }
    const hasDurationDays = Object.prototype.hasOwnProperty.call(req.body, 'duration_days');
    const parsedDurationDays = hasDurationDays
      ? normalizeDurationDays(duration_days)
      : null;

    const requestedStatus = (status === 1 || status === true || status === '1') ? 1 : 0;
    const requestedAssigneeCompleted =
      (assignee_completed === 1 || assignee_completed === true || assignee_completed === '1')
        ? 1
        : 0;

    // Only the assignee (or, for team-assigned tasks, the team leader) can
    // mark assignee completion.
    if (typeof assignee_completed !== 'undefined') {
      const canActAsGC =
        isGC ||
        (
          !!managerId &&
          managerIsGC &&
          ownsTask
        );

      if (canActAsGC) {
        // GC (or their foreman) can mark assignee completion for any task.
      } else {
      let canMarkAssigneeCompleted = false;
      if (incomingTeamId) {
        const [[teamRow]] = await connection.query(
          'SELECT team_leader FROM teams WHERE id = ? LIMIT 1',
          [incomingTeamId]
        );
        canMarkAssigneeCompleted = !!teamRow && Number(teamRow.team_leader || 0) === Number(actorId);
      } else {
        // Shared completion (multi-assignee): ANY assigned person can check the
        // task off — the primary (tasks.user_id) OR anyone in task_assignees.
        if (Number(oldTask.user_id || 0) === Number(actorId)) {
          canMarkAssigneeCompleted = true;
        } else {
          const [memRows] = await connection.query(
            'SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1',
            [oldTask.id, actorId]
          );
          canMarkAssigneeCompleted = memRows.length > 0;
        }
      }
      if (!canMarkAssigneeCompleted) {
        await connection.rollback();
        return res.status(403).json({
          message: incomingTeamId
            ? 'Only the team leader can mark assignee completion for a team task.'
            : 'Only the assignee can mark assignee completion.',
        });
      }
      }
    }

    // Only GC can set final completion status
    // SECURITY: final completion (status=1) requires OWNING the account — the GC
    // owner (isGC) or an employee acting for their GC — AND ownsTask. The old
    // `&& !isGC` exempted role-14 actors entirely, so a role-14 user who is merely
    // a delegated ASSIGNEE of another account's task (passed the top ownsTask||
    // isAssignee guard as the assignee) could finalize it here instead of only
    // raising the review signal. A delegated assignee must go through
    // /complete (assignee_completed) like anyone else; only the owning boss finalizes.
    if (typeof status !== 'undefined' && requestedStatus === 1) {
      const canCompleteAsGC =
        ownsTask && (isGC || (!!managerId && managerIsGC));

      if (!canCompleteAsGC) {
        await connection.rollback();
        return res.status(403).json({ message: 'Only the general contractor can complete the task.' });
      }
    }

    // GC can set final completion status independently of assignee_completed

    const oldIsAppointment = oldTask.is_appointment_task === 1 || oldTask.is_appointment_task === true;
    const nextIsAppointment = is_appointment_task === 1 || is_appointment_task === true || is_appointment_task === '1';

    // Image handling
    const imagePath = req.file ? req.file.filename : image;

    // Date formatting
    const startDateInput = req.body.start_date ?? req.body.startDate;
    const timeInput = req.body.time;
    const effectiveStartInput = startDateInput ?? oldTask.start_date;
    const effectiveDurationDays = hasDurationDays
      ? parsedDurationDays
      : normalizeDurationDays(oldTask.duration_days);
    const formattedStartDate = startDateInput ? toMySQLDateTime(startDateInput) : null;
    const formattedEndDate = calculateTaskEndDate(effectiveStartInput, effectiveDurationDays);
    const formattedTime = timeInput ? toMySQLDateTime(timeInput) : null;
    const finalPriority = (typeof priority === 'string' && ['low', 'medium', 'high'].includes(priority)) ? priority : null;
    const finalCompletePercentage = (complete_percentage === null || typeof complete_percentage === 'undefined')
      ? null
      : Math.max(0, Math.min(100, Number(complete_percentage)));

    // Sanitize job_id and only update it if explicitly present in the body
    const hasJobId = Object.prototype.hasOwnProperty.call(req.body, 'job_id');
    const parsedJobId = hasJobId
      ? ((job_id === '' || job_id === 'null' || job_id === 'undefined')
          ? null
          : (job_id !== undefined
              ? (Number(job_id) === 0 || isNaN(Number(job_id)) ? null : Number(job_id))
              : null))
      : null;

    // Build UPDATE dynamically to avoid unintentionally changing job_id
    const setClauses = [
      'task_name = COALESCE(?, task_name)',
      'user_id = ?',
      'team_id = ?',
      'duration_days = COALESCE(?, duration_days)',
      'nudge = COALESCE(?, nudge)',
      'start_date = COALESCE(?, start_date)',
      'end_date = COALESCE(?, end_date)',
      'time = COALESCE(?, time)',
      'priority = COALESCE(?, priority)',
      'complete_percentage = COALESCE(?, complete_percentage)',
      'description = COALESCE(?, description)',
      'image = COALESCE(?, image)',
      'audio_note = ?',
      'assignee_completed = COALESCE(?, assignee_completed)',
      'status = COALESCE(?, status)',
      'status_note = COALESCE(?, status_note)',
      'task_type = COALESCE(?, task_type)',
      'is_calendar_task = COALESCE(?, is_calendar_task)',
      'is_appointment_task = COALESCE(?, is_appointment_task)',
      'is_urgent = COALESCE(?, is_urgent)',
      'completion_response = COALESCE(?, completion_response)'
    ];
    const urgentUpdate = (typeof req.body.is_urgent === 'undefined')
      ? null
      : ((req.body.is_urgent === 1 || req.body.is_urgent === true || req.body.is_urgent === '1') ? 1 : 0);
    const params = [
      task_name,
      newUser,
      incomingTeamId,
      parsedDurationDays,
      nudge,
      formattedStartDate,
      formattedEndDate,
      formattedTime,
      finalPriority,
      finalCompletePercentage,
      description,
      imagePath,
      audio_note || null,
      typeof assignee_completed !== 'undefined' ? requestedAssigneeCompleted : null,
      typeof status !== 'undefined' ? requestedStatus : null,
      typeof status_note !== 'undefined' ? status_note : null,
      task_type,
      is_calendar_task,
      is_appointment_task,
      urgentUpdate,
      (typeof req.body.completion_response === 'undefined') ? null : (req.body.completion_response || ''),
    ];

    if (hasJobId) {
      setClauses.splice(2, 0, 'job_id = ?'); // insert after user_id
      params.splice(2, 0, parsedJobId);
      if (Number(oldTask.job_id || 0) !== Number(parsedJobId || 0)) {
        logger.warn(`Task job_id changing: id=${req.params.id} from=${oldTask.job_id} to=${parsedJobId}`);
      }
    }

    const updateSql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    params.push(req.params.id);

    await connection.query(updateSql, params);

    // Multi-assignee: re-sync the join table only when the caller actually sends
    // assignment info, so partial edits (status/date/percent) never wipe the set.
    //  • team task            → clear per-user assignees
    //  • `assignees` present   → authoritative full set (new multi-select client)
    //  • legacy single reassign (user_id present AND primary changed) → collapse to that one
    //  • otherwise             → leave the existing set untouched
    const hasAssigneesField = Object.prototype.hasOwnProperty.call(req.body, 'assignees');
    const hasUserIdField = Object.prototype.hasOwnProperty.call(req.body, 'user_id');
    if (incomingTeamId) {
      await syncTaskAssignees(connection, req.params.id, []);
    } else if (hasAssigneesField) {
      await syncTaskAssignees(connection, req.params.id, assigneeList);
    } else if (hasUserIdField && Number(newUser || 0) !== Number(oldUser || 0)) {
      await syncTaskAssignees(connection, req.params.id, newUser ? [newUser] : []);
    }

    // -------------------------------------------------
    // 📅 SCHEDULE CASCADE HOOK
    // -------------------------------------------------
    // If this task is part of an applied Schedule Template, a date/duration edit
    // here (a Task Manager edit OR a Master Calendar drag/resize — both go through
    // this endpoint) must cascade to every dependent item in the SAME job's
    // schedule. We record the drag as a pinned start on the schedule item, then
    // recompute. Wrapped in a SAVEPOINT so a schedule glitch can never break a
    // normal task edit; notifications are collected and dispatched after commit.
    let scheduleNotifPayloads = [];
    let scheduleReject = null;
    try {
      const [[schedItem]] = await connection.query(
        "SELECT id, schedule_id FROM job_schedule_items WHERE task_id = ? LIMIT 1",
        [req.params.id]
      );
      if (schedItem && (startDateInput || hasDurationDays)) {
        await connection.query("SAVEPOINT sched_cascade");
        try {
          const itemSets = [];
          const itemVals = [];
          if (startDateInput && formattedStartDate) {
            itemSets.push("pinned_start_date = ?");
            itemVals.push(String(formattedStartDate).slice(0, 10));
          }
          if (hasDurationDays && parsedDurationDays != null) {
            itemSets.push("duration_days = ?");
            itemVals.push(parsedDurationDays);
          }
          if (itemSets.length) {
            itemVals.push(schedItem.id);
            await connection.query(
              `UPDATE job_schedule_items SET ${itemSets.join(", ")} WHERE id = ?`,
              itemVals
            );
          }
          // A calendar drag pins this item — block the move (calendar snaps back) if
          // it would start before its own dependencies finish. rejectBustFor scopes the
          // reject to THIS dragged item; Gantt edits never pass it, so they never block.
          scheduleNotifPayloads =
            (await recomputeSchedule(connection, schedItem.schedule_id, { changedItemId: schedItem.id, rejectBustFor: schedItem.id })) || [];
        } catch (cascadeErr) {
          if (cascadeErr.bust || cascadeErr.code === "SCHEDULE_CONFLICT" || cascadeErr.cycle || cascadeErr.code === "CYCLE") {
            scheduleReject = cascadeErr; // reject the whole task edit (calendar snaps back)
          } else {
            await connection.query("ROLLBACK TO SAVEPOINT sched_cascade");
            scheduleNotifPayloads = [];
            logger.error("[schedule] cascade hook: " + cascadeErr.message);
          }
        }
      }
    } catch (hookErr) {
      logger.error("[schedule] cascade hook lookup: " + hookErr.message);
    }

    // A dependency bust / cycle from the cascade rejects the entire task edit:
    // roll everything back (task change included) and return 409 so the Master
    // Calendar reverts the drag and shows the specific reason.
    if (scheduleReject) {
      await connection.rollback();
      const isCycle = scheduleReject.cycle || scheduleReject.code === "CYCLE";
      return res.status(409).json({
        message: scheduleReject.message,
        code: isCycle ? "CYCLE" : "SCHEDULE_CONFLICT",
        conflicts: scheduleReject.conflicts || [],
        cycle: scheduleReject.cycle || [],
      });
    }

    // -------------------------------------------------
    // 🚨 NOTIFICATION LOGIC (ONLY ADD OR REMOVE)
    // -------------------------------------------------
    // Get actor name
    const [[actorRow]] = await pool.query(
      "SELECT name FROM user WHERE id=?", [actorId]
    );
    const actorName = actorRow ? actorRow.name : "Someone";

    //console.log(actorName);

    // Determine notification type
    let notifyUser = null;
    let notifyMessage = "";

    if (!oldUser && newUser) {
      // CASE 1 — user assigned
      notifyUser = newUser;
      notifyMessage = `${actorName} assigned you a new task: "${task_name}".`;

    } else if (oldUser && !newUser) {
      // CASE 2 — user removed
      notifyUser = oldUser;
      notifyMessage = `${actorName} removed you from task: "${task_name}".`;
    }

    if (notifyUser) {
      // Insert notification record
      const url = "/task";

      // DEDUPE: the assign picker can fire this update more than once in quick
      // succession (per-pick save + Done/onHide commit + client-side races), which
      // was double-sending the "assigned you a new task" push. Skip if an identical
      // notification to this receiver was recorded in the last 15s → exactly one push.
      const [[recentDup]] = await connection.query(
        `SELECT id FROM notifications
           WHERE receiver_id = ? AND sender_id = ? AND content = ? AND url = ?
             AND created_at > (NOW() - INTERVAL 15 SECOND)
           LIMIT 1`,
        [notifyUser, actorId, notifyMessage, url]
      );

      if (!recentDup) {
        await connection.query(
          `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [actorId, notifyUser, notifyMessage, url, actorId]
        );
      }
      // -------------------------------------------------
        // 📇 JOB CONTACTS LOGIC (ADD / REMOVE)
        // -------------------------------------------------

        if (!oldUser && newUser && job_id) {
          // ✅ CASE: User Assigned → ADD contact
          await connection.query(
            `INSERT IGNORE INTO job_contacts (user_id, job_id, contact_id)
            VALUES (?, ?, ?)`,
            [actorId, job_id, newUser]
          );

        }  else if (oldUser && !newUser && job_id) {
          //  CASE: User Removed → DELETE contact
          await connection.query(
            `DELETE FROM job_contacts
            WHERE user_id = ? AND job_id = ? AND contact_id = ?`,
            [actorId, job_id, oldUser]
          );
        }


      // Send FCM push (skipped when we just deduped the notification above, so the
      // racing duplicate save doesn't fire a second push).
      const [[recipient]] = recentDup
        ? [[null]]
        : await connection.query(
            "SELECT fcm_token FROM user_device_tokens WHERE user_id=?",
            [notifyUser]
          );

      if (!recentDup && recipient && recipient.fcm_token) {
        const fcmMessage = {
          token: recipient.fcm_token,
          notification: {
            title: "Task Update",
            body: notifyMessage,
          },
          data: {
            type: "task_assignment",
            task_id: String(req.params.id),
            url,
          },
        };

        try {
          await admin.messaging().send(fcmMessage);
          logger.info("Notification sent to user: " + notifyUser);
        } catch (err) {
          logger.error("FCM Error:", err);
        }
      }
    }

    // -------------------------------------------------

    await connection.commit();

    // Fire-and-forget the batched schedule-cascade notifications after commit.
    if (scheduleNotifPayloads.length) {
      for (const p of scheduleNotifPayloads) {
        notify.dispatchScheduleNotification(pool, p).catch(() => {});
      }
    }

    res.status(200).json({ message: "Task updated successfully" });

  } catch (err) {
    logger.error("Error updating task:", err);
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
    }
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});


// DELETE task
router.delete("/delete/:id", auth.authenticateToken, requireOwnsRecord({ table: "tasks", ownerCol: "created_by" }), async (req, res) => {
  let connection;
  try {
    const taskId = Number(req.params.id);
    if (!taskId) return res.status(400).json({ message: "Invalid task id" });

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Detect whether appointments table has task_id column
    const [[taskIdCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'task_id'
       LIMIT 1;`,
    );
    const hasAppointmentTaskId = !!taskIdCol;

    // Find checklist rows linked to this task
    const [linkedChecklist] = await connection.query(
      `SELECT id, appointment_id FROM check_list WHERE calendar_task_id = ?`,
      [taskId],
    );

    // Delete appointment by appointments.task_id (new linkage)
    if (hasAppointmentTaskId) {
      await connection.query(`DELETE FROM appointments WHERE task_id = ?`, [taskId]);
    }

    // Delete appointments referenced by checklist.appointment_id (legacy linkage)
    if (Array.isArray(linkedChecklist) && linkedChecklist.length) {
      const apptIds = linkedChecklist
        .map((r) => Number(r.appointment_id || 0))
        .filter((x) => !!x);
      if (apptIds.length) {
        await connection.query(
          `DELETE FROM appointments WHERE id IN (${apptIds.map(() => '?').join(',')})`,
          apptIds,
        );
      }

      // Delete linked checklist rows
      const checklistIds = linkedChecklist.map((r) => Number(r.id)).filter((x) => !!x);
      if (checklistIds.length) {
        await connection.query(
          `DELETE FROM check_list WHERE id IN (${checklistIds.map(() => '?').join(',')})`,
          checklistIds,
        );
      }
    }

    // Finally delete the task
    const [result] = await connection.query("DELETE FROM tasks WHERE id = ?", [taskId]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Task not found" });
    }

    await connection.commit();
    res.status(200).json({ message: "Task deleted successfully!" });
  } catch (err) {
    try {
      if (connection) await connection.rollback();
    } catch (_) {}
    logger.error("Error deleting task", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});




// Single-photo upload (legacy — also inserts into task_images)
router.post('/upload-photo/:taskId', auth.authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    // SECURITY: only the assignee or owning account may attach a photo (matches
    // the /upload-photos sibling). Was unguarded — cross-account photo injection.
    if (!(await loadAccessibleTask(req.user.id, req.params.taskId))) {
      return res.status(403).json({ message: 'This task does not belong to your account.' });
    }
    if (req.fileValidationError) {
      return res.status(400).json({ message: req.fileValidationError });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const taskId = req.params.taskId;
    const filePath = path.posix.join('tasks', String(taskId)) + '/';
    const fileName = req.file.filename;
    const relPath = `${filePath}${fileName}`;
    await pool.query(`UPDATE tasks SET image = ? WHERE id = ?`, [relPath, taskId]);
    await pool.query(
      `INSERT INTO tasks_images (task_id, file_path, file_name) VALUES (?, ?, ?)`,
      [taskId, filePath, fileName]
    );
    res.status(200).json({ message: 'Photo uploaded', image: relPath });
  } catch (err) {
    logger.error("Error uploading photo:", err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Multi-photo upload
router.post('/upload-photos/:taskId', auth.authenticateToken, denyExpiredFreeWrites, upload.array('photos', 20), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ message: req.fileValidationError });
    }
    // SECURITY: only the assignee or owning account may attach photos to a task.
    if (!(await loadAccessibleTask(req.user.id, req.params.taskId))) {
      return res.status(403).json({ message: 'This task does not belong to your account.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }
    const taskId = req.params.taskId;
    // Default 'request' (photos added when creating/editing the task); the client
    // may pass kind='response' but completion photos normally use /assignee-photo.
    const kind = req.body && req.body.kind === 'response' ? 'response' : 'request';
    const uploader = (req.user && req.user.id) || null;
    const inserted = [];
    for (const file of req.files) {
      const filePath = path.posix.join('tasks', String(taskId)) + '/';
      const fileName = file.filename;
      const relPath = `${filePath}${fileName}`;
      const [result] = await pool.query(
        `INSERT INTO tasks_images (task_id, file_path, file_name, kind, uploaded_by) VALUES (?, ?, ?, ?, ?)`,
        [taskId, filePath, fileName, kind, uploader]
      );
      inserted.push({ id: result.insertId, filename: relPath });
    }
    // Keep tasks.image pointing to first image for legacy support
    if (inserted.length > 0) {
      await pool.query(
        `UPDATE tasks SET image = ? WHERE id = ? AND (image IS NULL OR image = '')`,
        [inserted[0].filename, taskId]
      );
    }
    res.status(200).json({ message: 'Photos uploaded', images: inserted });
  } catch (err) {
    logger.error("Error uploading photos:", err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Assignee completion photo — a narrow endpoint (no expired-write guard) that
// lets the person a task is ASSIGNED to add photos to it, even on the free
// plan, to show the work is done. Scoped: only the task's assignee may use it.
router.post('/assignee-photo/:taskId', auth.authenticateToken, upload.array('photos', 20), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ message: req.fileValidationError });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }
    const taskId = req.params.taskId;

    const [rows] = await pool.query("SELECT user_id FROM tasks WHERE id = ? LIMIT 1", [taskId]);
    if (!rows.length) return res.status(404).json({ message: 'Task not found' });
    if (Number(rows[0].user_id) !== Number(req.user.id)) {
      return res.status(403).json({ code: 'NOT_ASSIGNEE', message: 'You can only add photos to tasks assigned to you.' });
    }

    const inserted = [];
    for (const file of req.files) {
      const filePath = path.posix.join('tasks', String(taskId)) + '/';
      const fileName = file.filename;
      // Completion photos are RESPONSE photos (kind='response') so the gallery
      // can group them under "RESPONSE · [name], [time]".
      const [result] = await pool.query(
        `INSERT INTO tasks_images (task_id, file_path, file_name, kind, uploaded_by) VALUES (?, ?, ?, 'response', ?)`,
        [taskId, filePath, fileName, req.user.id]
      );
      inserted.push({ id: result.insertId, filename: `${filePath}${fileName}` });
    }
    // Response photos never touch the legacy tasks.image (the request thumbnail).
    res.status(200).json({ message: 'Photos uploaded', images: inserted });
  } catch (err) {
    logger.error("assignee-photo upload:", err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Get all images for a task. Returns kind ('request'|'response') + uploader name
// + time so the frontend gallery can group under REQUEST · [name], [time] and
// RESPONSE · [name], [time].
router.get('/images/:taskId', auth.authenticateToken, async (req, res) => {
  try {
    // SECURITY: only the assignee or the owning account may see a task's photos.
    if (!(await loadAccessibleTask(req.user.id, req.params.taskId))) {
      return res.status(403).json({ message: 'This task does not belong to your account.' });
    }
    const [rows] = await pool.query(
      `SELECT ti.id, CONCAT(ti.file_path, ti.file_name) AS filename, ti.created_at,
              COALESCE(ti.kind, 'request') AS kind, ti.uploaded_by, u.name AS uploaded_by_name
         FROM tasks_images ti
         LEFT JOIN user u ON u.id = ti.uploaded_by
        WHERE ti.task_id = ?
        ORDER BY ti.created_at ASC`,
      [req.params.taskId]
    );
    res.status(200).json(rows);
  } catch (err) {
    logger.error("Error fetching task images:", err);
    res.status(500).json({ message: 'Failed to fetch images', error: err.message });
  }
});

// Mark a task SEEN by its assignee — fires ONLY when the assignee genuinely opens
// the task detail (frontend calls this on detail-open, not on push delivery /
// dismissal / list visibility). Stamps assignee_seen_at once (first open wins);
// a no-op if already seen or if the caller isn't the task's assignee.
router.post('/:id/seen', auth.authenticateToken, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = Number(req.user && req.user.id);
  if (!taskId || !uid) return res.status(400).json({ message: 'Invalid request' });
  try {
    const [[t]] = await pool.query('SELECT id, user_id, assignee_seen_at FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (!t) return res.status(404).json({ message: 'Task not found' });

    // Multi-assignee "Seen" is PER-PERSON: stamp THIS caller's own task_assignees
    // row (first open wins). The caller must actually be an assignee — the primary
    // (tasks.user_id) or a member of task_assignees. A boss/other viewer never
    // stamps. Legacy per-task tasks.assignee_seen_at is still kept for the primary
    // so old single-assignee reads/clients keep working.
    const isPrimary = Number(t.user_id) === uid;
    let isMember = isPrimary;
    if (!isMember) {
      const [m] = await pool.query('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1', [taskId, uid]);
      isMember = m.length > 0;
    }
    if (isMember) {
      await pool.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', [taskId, uid]);
      await pool.query('UPDATE task_assignees SET seen_at = NOW() WHERE task_id = ? AND user_id = ? AND seen_at IS NULL', [taskId, uid]);
      if (isPrimary && !t.assignee_seen_at) {
        await pool.query('UPDATE tasks SET assignee_seen_at = NOW() WHERE id = ? AND assignee_seen_at IS NULL', [taskId]);
      }
    }
    const [[mine]] = await pool.query('SELECT seen_at FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1', [taskId, uid]);
    return res.json({ seen_at: mine ? mine.seen_at : null });
  } catch (err) {
    logger.error('mark seen error: ' + err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Submit THIS assignee's one-time written response to a task. Own row ONLY,
// write-once: responded_at locks it (no further edits, by them or anyone). A
// boss/non-assignee cannot respond, and no one can respond on another's behalf.
router.post('/:id/assignee-response', auth.authenticateToken, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = Number(req.user && req.user.id);
  const text = req.body && typeof req.body.response === 'string' ? req.body.response.trim() : '';
  if (!taskId || !uid) return res.status(400).json({ message: 'Invalid request' });
  if (!text) return res.status(400).json({ message: 'Response text is required' });
  try {
    const [[t]] = await pool.query('SELECT id, user_id FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (!t) return res.status(404).json({ message: 'Task not found' });
    // Caller must be an assignee (primary tasks.user_id or a task_assignees member).
    const isPrimary = Number(t.user_id) === uid;
    let isMember = isPrimary;
    if (!isMember) {
      const [m] = await pool.query('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1', [taskId, uid]);
      isMember = m.length > 0;
    }
    if (!isMember) return res.status(403).json({ message: 'Only an assignee can respond to this task.' });
    // Ensure the caller's own row exists (legacy primary may lack one), then write
    // ONLY if not already responded — the responded_at IS NULL guard is the lock.
    await pool.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', [taskId, uid]);
    const [upd] = await pool.query(
      'UPDATE task_assignees SET response = ?, responded_at = NOW() WHERE task_id = ? AND user_id = ? AND responded_at IS NULL',
      [text, taskId, uid]
    );
    const [[cur]] = await pool.query(
      'SELECT response, responded_at FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1',
      [taskId, uid]
    );
    if (upd.affectedRows === 0) {
      // Already locked — return the existing response unchanged (409, not overwritten).
      return res.status(409).json({ message: 'Response already submitted', response: cur ? cur.response : null, responded_at: cur ? cur.responded_at : null, locked: true });
    }
    return res.json({ response: cur.response, responded_at: cur.responded_at, locked: true });
  } catch (err) {
    logger.error('assignee-response error: ' + err.message);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete a specific task image
router.delete('/delete-image/:imageId', auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT task_id, file_path, file_name FROM tasks_images WHERE id = ?`,
      [req.params.imageId]
    );
    if (!row) return res.status(404).json({ message: 'Image not found' });
    // SECURITY: only the assignee or owning account may delete a task's image.
    if (!(await loadAccessibleTask(req.user.id, row.task_id))) {
      return res.status(403).json({ message: 'This task does not belong to your account.' });
    }

    const relFilename = `${row.file_path || ''}${row.file_name || ''}`;

    await pool.query(`DELETE FROM tasks_images WHERE id = ?`, [req.params.imageId]);

    // If tasks.image pointed to this file, update it to next remaining image (or null)
    const [[next]] = await pool.query(
      `SELECT CONCAT(file_path, file_name) AS filename FROM tasks_images WHERE task_id = ? ORDER BY created_at ASC LIMIT 1`,
      [row.task_id]
    );
    await pool.query(
      `UPDATE tasks SET image = ? WHERE id = ? AND image = ?`,
      [next ? next.filename : null, row.task_id, relFilename]
    );

    // Remove file from disk
    fs.unlink(path.join(__dirname, '..', 'uploads', relFilename), () => {});

    res.status(200).json({ message: 'Image deleted' });
  } catch (err) {
    logger.error("Error deleting task image:", err);
    res.status(500).json({ message: 'Delete failed', error: err.message });
  }
});


// Dedicated task check-off. This is the ONE write an expired free-trial user is
// allowed, so it intentionally does NOT use denyExpiredFreeWrites. Scope is
// strictly narrow: the assignee (or the leader of an assigned team) toggling
// their own assignee_completed flag — no other task field can change here. The
// assigner sees the result because the flag is stored on the task.
router.patch("/:id/complete", auth.authenticateToken, async (req, res) => {
  const taskId = req.params.id;
  const actorId = Number(req.user.id);
  const completed =
    req.body &&
    (req.body.assignee_completed === 0 ||
      req.body.assignee_completed === false ||
      req.body.assignee_completed === "0")
      ? 0
      : 1;

  const actorRole = Number(req.user.role);
  let connection;
  try {
    connection = await pool.getConnection();
    const [[task]] = await connection.query(
      "SELECT id, user_id, team_id, created_by FROM tasks WHERE id = ? LIMIT 1",
      [taskId]
    );
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // The individual assignee, or the leader of the assigned team. Multi-assignee:
    // the shared check-off can be done by ANY assigned person — the primary
    // (tasks.user_id) OR anyone in task_assignees. Whoever gets there first checks
    // it and it's done for everyone.
    let isAssignee = Number(task.user_id || 0) === actorId;
    if (!isAssignee) {
      const [memRows] = await connection.query(
        "SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1",
        [taskId, actorId]
      );
      isAssignee = memRows.length > 0;
    }
    let isTeamLeader = false;
    if (!isAssignee && task.team_id) {
      const [[teamRow]] = await connection.query(
        "SELECT team_leader FROM teams WHERE id = ? LIMIT 1",
        [task.team_id]
      );
      isTeamLeader = !!teamRow && Number(teamRow.team_leader || 0) === actorId;
    }
    // The account owner / GC / an employee acting for their GC may check off any
    // task in their account. When THEY check it (and they're not the assignee),
    // it completes the whole task (status) and cascades to the assignee's box —
    // mirroring the web boss/PM checkbox. Assignees still only set their own box.
    const ownsTask = await isSameAccount(actorId, task.created_by, connection);
    // SECURITY (cross-account): a GC (role 14) may act-as-boss ONLY on their own
    // account's tasks. role 14 is per-tenant (every account owner is role 14), so
    // WITHOUT this ownsTask requirement any GC could finalize/reopen another
    // account's task by guessing its id. Roles 2–5 already required ownsTask; role
    // 14 was exempt — that was the gap. A genuine assignee of a delegated task (any
    // account) is still handled by the isAssignee branch above and only raises the
    // review signal, never finalizes here.
    const canActAsGC =
      [2, 3, 4, 5, 14].includes(actorRole) && ownsTask;

    if (!isAssignee && !isTeamLeader && !canActAsGC) {
      return res.status(403).json({
        success: false,
        message: "You can't check off this task.",
      });
    }

    // A user completing their OWN task (assignee == creator, i.e. self-assigned)
    // has no separate assigner to report up to, so their check-off finalizes the
    // whole task (status) — otherwise it only sets assignee_completed and, since
    // Daily Tasks / Task Manager / Job views filter on status, the task reappears
    // on the next refresh. Genuinely DELEGATED tasks (assignee != creator) and
    // TEAM tasks still set only assignee_completed here, preserving the boss/team
    // review step: the assigner/GC finalizes status via PUT /update (or via the
    // GC branch below when they check off someone else's task).
    const isSelfAssigned = isAssignee && Number(task.created_by || 0) === actorId;
    const finalizesStatus =
      (canActAsGC && !isAssignee && !isTeamLeader) || isSelfAssigned;

    if (finalizesStatus) {
      await connection.query(
        "UPDATE tasks SET status = ?, assignee_completed = ? WHERE id = ?",
        [completed, completed, taskId]
      );
    } else {
      await connection.query(
        "UPDATE tasks SET assignee_completed = ? WHERE id = ?",
        [completed, taskId]
      );
    }
    return res.json({
      success: true,
      assignee_completed: completed,
      ...(finalizesStatus ? { status: completed } : {}),
    });
  } catch (err) {
    logger.error("task check-off error: " + err.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});


module.exports = router;
// Exposed for tests (expired-free own-vs-foreign task filtering).
module.exports.filterTasksForExpired = filterTasksForExpired;
