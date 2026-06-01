const express = require("express");
const router = express.Router();
const Joi = require('joi');
const pool = require("../config/connection");
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require("../services/authentication");
const { getTimeStamp } = require("../common/timdate");
const admin = require("../config/firebase-admin");

async function attachTaskImages(connectionOrPool, tasks) {
  if (!tasks || tasks.length === 0) return tasks;

  const ids = tasks
    .map((t) => t && t.id)
    .filter((id) => Number.isFinite(Number(id)));

  if (ids.length === 0) {
    tasks.forEach((t) => {
      if (t) t.images = [];
    });
    return tasks;
  }

  const [rows] = await connectionOrPool.query(
    `SELECT id, task_id, CONCAT(file_path, file_name) AS filename, created_at
     FROM tasks_images
     WHERE task_id IN (?)
     ORDER BY created_at ASC`,
    [ids]
  );

  const byTaskId = new Map();
  for (const r of rows || []) {
    const key = Number(r.task_id);
    if (!byTaskId.has(key)) byTaskId.set(key, []);
    byTaskId.get(key).push({ id: r.id, filename: r.filename, created_at: r.created_at });
  }

  tasks.forEach((t) => {
    if (!t) return;
    const key = Number(t.id);
    t.images = byTaskId.get(key) || [];
  });

  return tasks;
}
// ----------job's task assignment----------------
const taskSchema = Joi.object({
  task_name: Joi.string().allow('', null).max(255).optional(),
  user_id: Joi.any().optional(),
  team_id: Joi.any().optional(),
  duration_days: Joi.number().integer().min(1).optional(),
  nudge: Joi.date().optional(),
  start_date: Joi.date().optional(),
  end_date: Joi.date().optional(),
  time: Joi.date().optional(),
  complete_percentage: Joi.number().min(0).max(100).allow(null).optional(),
  priority: Joi.string().valid('low', 'medium', 'high').optional(),
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
router.post('/nudge/:id', auth.authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.id;
    const actorId = req.user.id;

    const [[task]] = await pool.query(
      'SELECT user_id, task_name FROM tasks WHERE id=?',
      [taskId]
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (!task.user_id) {
      return res.status(400).json({ message: 'Task has no assigned user' });
    }

    const assignedUser = task.user_id;

    const [[actorRow]] = await pool.query(
      'SELECT name FROM user WHERE id=?',
      [actorId]
    );
    const actorName = actorRow ? actorRow.name : 'Someone';

    const url = '/task';
    const notifyMessage = `${actorName} nudged you on task: "${task.task_name}".`;

    // Insert notification record
    await pool.query(
      `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [actorId, assignedUser, notifyMessage, url, actorId]
    );

    // Send FCM notification if token exists
    const [[recipient]] = await pool.query(
      'SELECT fcm_token FROM user_device_tokens WHERE user_id=?',
      [assignedUser]
    );

    if (recipient && recipient.fcm_token) {
      const message = {
        token: recipient.fcm_token,
        notification: { title: 'Task Nudge', body: notifyMessage },
        data: { type: 'task_nudge', task_id: String(taskId), url },
      };
      try {
        await admin.messaging().send(message);
      } catch (err) {
        console.error('FCM Error:', err);
      }
    }

    res.status(200).json({ message: 'Nudge sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// CREATE task
router.post("/create", auth.authenticateToken, upload.single('image'), async (req, res) => {
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
      const finalUserId = team_id ? null : (user_id ?? null);
      const effectiveStartInput = start_date || new Date();

      // Respect provided dates; default start_date to today if missing
      const formattedStartDate = toMySQLDateTime(effectiveStartInput);
      const formattedEndDate = calculateTaskEndDate(effectiveStartInput, finalDurationDays);
      const formattedTime = time ? toMySQLDateTime(time) : null;
      const finalPriority = priority ?? 'low';

      const sql = `
        INSERT INTO tasks 
        (task_name, user_id, team_id, duration_days, start_date, end_date, description, image, audio_note, assignee_completed, job_id, created_at, created_by, task_type, is_calendar_task, is_appointment_task, time, priority) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ];

      const [result] = await connection.query(sql, values);


      insertedTasks.push({
        id: result.insertId,
        task_name,
        user_id: finalUserId,
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

    // If a single task was created, return just its ID to match frontend expectations
    const responseData = insertedTasks.length === 1 ? insertedTasks[0].id : insertedTasks;
    res.status(201).json({
      success: true,
      message: "Task(s) assigned successfully!",
      data: responseData,
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error creating task(s):", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  } finally {
    if (connection) connection.release();
  }
});

// READ all job tasks
router.get("/all_job_task/:id", auth.authenticateToken, async (req, res) => {
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

    let whereJob;
    let params;
    if (jobIds.length) {
      whereJob = includeNoJob
        ? `(jt.job_id IN (?) OR (jt.job_id IS NULL OR jt.job_id = 0))`
        : `jt.job_id IN (?)`;
      params = [jobIds, loggedInUserId, effectiveCreatorId, loggedInUserId];
    } else {
      whereJob = includeNoJob
        ? `(jt.job_id IS NULL OR jt.job_id = 0)`
        : `(jt.job_id IS NOT NULL AND jt.job_id <> 0)`;
      params = [loggedInUserId, effectiveCreatorId, loggedInUserId];
    }

    const baseSql = `SELECT jt.*,
              u.name as assignto,
              jt.task_type,
              COALESCE(j.name, 'No Job') as job_name,
              t.team_name,
              t.team_color,
              t.team_leader,
              tl.name AS team_leader_name,
              uc.name as created_by_name
       FROM tasks jt
       LEFT JOIN user u ON u.id = jt.user_id
       LEFT JOIN job j ON j.id = jt.job_id
       LEFT JOIN teams t ON t.id = jt.team_id
       LEFT JOIN user tl ON tl.id = t.team_leader
       LEFT JOIN user uc ON uc.id = jt.created_by
       WHERE ${whereJob}
         AND jt.task_type = 'job'
         AND (
           jt.user_id = ?
           OR jt.created_by = ?
           OR (jt.team_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM team_user tu
                 WHERE tu.team_id = jt.team_id AND tu.user_id = ?
               ))
         )
       ORDER BY jt.status ASC, jt.created_at DESC;`;

    const [rows] = await connection.query(baseSql, params);
    await attachTaskImages(connection, rows);

    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// READ all lead tasks
router.get("/all_lead_task/:id", auth.authenticateToken, async (req, res) => {
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
    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching lead tasks", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Dashboard: today's tasks for the logged-in user 
router.get("/daily_tasks", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const assigneeId = req.user.id; // logged-in user 
    const managerId = (req.query.user_id && /^\d+$/.test(String(req.query.user_id)))
      ? Number(req.query.user_id)
      : assigneeId;
    const targetDate = (req.query.date && typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : null;

    const sql = `
      SELECT 
        t.id, 
        t.task_name, 
        t.start_date, 
        t.time,
        t.priority,
        u.name AS createdBy, 
        t.status,
        t.job_id,
        COALESCE(j.name, 'No Job') AS jobName,
        t.user_id AS assignedTo
      FROM tasks t
      INNER JOIN user u ON u.id = t.created_by
      LEFT JOIN job j ON j.id = t.job_id
      WHERE 
        (
          (
            (
              t.user_id = ?
              OR t.created_by = ?
              OR (t.team_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM team_user tu
                    WHERE tu.team_id = t.team_id AND tu.user_id = ?
                  ))
            )
            AND t.start_date >= COALESCE(?, CURDATE())
            AND t.start_date < DATE_ADD(COALESCE(?, CURDATE()), INTERVAL 1 DAY)
          )
          OR (
            t.created_by = ?
            AND DATE(t.created_at) = COALESCE(?, CURDATE())
          )
        )
      ORDER BY COALESCE(t.end_date, t.start_date, t.created_at) DESC
    `;

    const params = [managerId, managerId, managerId, targetDate, targetDate, managerId, targetDate];
    const [rows] = await connection.query(sql, params);
    await attachTaskImages(connection, rows);

    if (!rows || rows.length === 0) {
      return res.status(200).json([]);
    }

    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// READ single task
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [
      req.params.id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ message: "Task not found" });

    const task = rows[0];
    await attachTaskImages(pool, [task]);

    res.status(200).json(task);
  } catch (err) {
    console.error("Error fetching task", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update Images
router.put("/update/:id", upload.single("image"), auth.authenticateToken, async (req, res) => {
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
    const newUser = incomingTeamId ? null : (user_id || null);

    const actorId = req.user.id;
    const actorRole = Number(req.user.role);
    const isGC = actorRole === 14;

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
          Number(oldTask.created_by || 0) === Number(managerId)
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
        canMarkAssigneeCompleted = Number(oldTask.user_id || 0) === Number(actorId);
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
    if (typeof status !== 'undefined' && requestedStatus === 1 && !isGC) {
      const canCompleteAsGC =
        !!managerId &&
        managerIsGC &&
        Number(oldTask.created_by || 0) === Number(managerId);

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
      'task_type = COALESCE(?, task_type)',
      'is_calendar_task = COALESCE(?, is_calendar_task)',
      'is_appointment_task = COALESCE(?, is_appointment_task)'
    ];
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
      task_type,
      is_calendar_task,
      is_appointment_task,
    ];

    if (hasJobId) {
      setClauses.splice(2, 0, 'job_id = ?'); // insert after user_id
      params.splice(2, 0, parsedJobId);
      if (Number(oldTask.job_id || 0) !== Number(parsedJobId || 0)) {
        console.warn('Task job_id changing:', { id: req.params.id, from: oldTask.job_id, to: parsedJobId });
      }
    }

    const updateSql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    params.push(req.params.id);

    await connection.query(updateSql, params);

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

      await connection.query(
        `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [actorId, notifyUser, notifyMessage, url, actorId]
      );
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


      // Send FCM push
      const [[recipient]] = await connection.query(
        "SELECT fcm_token FROM user_device_tokens WHERE user_id=?",
        [notifyUser]
      );

      if (recipient && recipient.fcm_token) {
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
          console.log("🔔 Notification sent to user:", notifyUser);
        } catch (err) {
          console.log("FCM Error:", err);
        }
      }
    }

    // -------------------------------------------------

    await connection.commit();

    res.status(200).json({ message: "Task updated successfully" });

  } catch (err) {
    console.error(err);
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
router.delete("/delete/:id", async (req, res) => {
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
    console.error("Error deleting task", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});




// Single-photo upload (legacy — also inserts into task_images)
router.post('/upload-photo/:taskId', upload.single('photo'), async (req, res) => {
  try {
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
    console.error(err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Multi-photo upload
router.post('/upload-photos/:taskId', auth.authenticateToken, upload.array('photos', 20), async (req, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ message: req.fileValidationError });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }
    const taskId = req.params.taskId;
    const inserted = [];
    for (const file of req.files) {
      const filePath = path.posix.join('tasks', String(taskId)) + '/';
      const fileName = file.filename;
      const relPath = `${filePath}${fileName}`;
      const [result] = await pool.query(
        `INSERT INTO tasks_images (task_id, file_path, file_name) VALUES (?, ?, ?)`,
        [taskId, filePath, fileName]
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
    console.error(err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

// Get all images for a task
router.get('/images/:taskId', auth.authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, CONCAT(file_path, file_name) AS filename, created_at FROM tasks_images WHERE task_id = ? ORDER BY created_at ASC`,
      [req.params.taskId]
    );
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch images', error: err.message });
  }
});

// Delete a specific task image
router.delete('/delete-image/:imageId', auth.authenticateToken, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT task_id, file_path, file_name FROM tasks_images WHERE id = ?`,
      [req.params.imageId]
    );
    if (!row) return res.status(404).json({ message: 'Image not found' });

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
    console.error(err);
    res.status(500).json({ message: 'Delete failed', error: err.message });
  }
});


module.exports = router;
