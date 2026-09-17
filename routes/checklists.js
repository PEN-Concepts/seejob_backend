const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const Joi = require('joi');
const auth = require('../services/authentication');
const { getTimeStamp, timeStampFor, getUserTz } = require('../common/timdate');
const multer = require('multer');
const path = require('path');
const logger = require('../common/logger');
const { getAccessMode, isSameAccount, resolveOwnerId } = require('../utils/access');
const { isFullAccess, isSubcontractor, isAccountOwner } = require('../services/notepadAccess');
const { notepadMyTasksEnabled } = require('../services/featureFlags');
const chat = require('../services/chat');
const mailer = require('../services/mailer');
const { replyToForUser } = require('../services/mailReplyTo');
const { getSectionAccess } = require('../services/notepadAccess');
const { ensureNotepadSchema } = require('../services/notepadSchema');

// Minimal HTML escaper for the shared-snapshot email body.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function resolveBillingUserId(connection, userId) {
  let billingUserId = userId;
  const [userRows] = await connection.query(
    'SELECT id, role, created_by FROM user WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!userRows.length) return billingUserId;

  const currentUser = userRows[0];
  const currentRole = Number(currentUser.role);

  if (currentRole === 14) {
    return currentUser.id;
  }

  // For non-subcontractors, inherit GC billing when created_by is a GC.
  if (currentRole !== 12 && currentUser.created_by) {
    const [managerRows] = await connection.query(
      'SELECT id, role FROM user WHERE id = ? LIMIT 1',
      [currentUser.created_by],
    );
    if (managerRows.length && Number(managerRows[0].role) === 14) {
      return managerRows[0].id;
    }
  }

  return billingUserId;
}

/**
 * C39 — does this SUBCONTRACTOR hold a plan of their own?
 *
 * Deliberately NOT getAccessMode(). Role 12 sits in NEVER_GATED_ROLES, which
 * is what makes receiving work free forever — a sub can always tick, note and
 * photograph the GC's tasks whatever their billing state, because the GC's
 * crew depends on them working. Asking getAccessMode here would always answer
 * "paid" and the gate would never close.
 *
 * So this asks the narrower question directly: an active subscription of
 * their own, or their own account still inside the trial window. It reads the
 * SUB's row, never the GC's — a sub must not inherit the GC's subscription.
 */
const SUB_TRIAL_DAYS = 60;
async function subHasOwnPlan(connection, userId) {
  const [subs] = await connection.query(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
    [Number(userId)],
  );
  if (subs.length) return true;

  const [[u]] = await connection.query(
    'SELECT created_at FROM `user` WHERE id = ? LIMIT 1',
    [Number(userId)],
  );
  if (!u || !u.created_at) return true;   // unknown age: fail OPEN, never lock out
  const age = Date.now() - new Date(u.created_at).getTime();
  return age <= SUB_TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

async function getChecklistAccess(connection, userId) {
  const [userRows] = await connection.query(
    'SELECT id, role FROM user WHERE id = ? LIMIT 1',
    [userId],
  );
  const role = userRows.length ? Number(userRows[0].role) : 0;

  // Align Clipboard with the app-wide access model (utils/access.js): owner-
  // exempt accounts, internal roles, paid subscribers and trial users get full
  // read+write; only expired-free users are limited to view-only. This is the
  // single source of truth — it correctly grants the owner (who has no
  // subscription row) instead of blocking them.
  let mode = 'paid';
  try {
    mode = await getAccessMode(userId);
  } catch (e) {
    mode = 'paid'; // fail open, like the rest of the app
  }

  return { role, allowed: true, canWrite: mode !== 'expired_free', expired: mode === 'expired_free' };
}

 // Notepad is a single list type now — the "shopping" variant was retired.
 const VALID_CHECKLIST_TYPES = new Set(['task']);

// Notepad "command center" auto-clear columns:
//   filed_at = when the item got a home elsewhere (delegated / calendar /
//              appointment / completed). 7 min later it drops off the Notepad.
//   kept     = user tapped "Keep" to pause the auto-clear.
let notepadFlowEnsured = false;
async function ensureNotepadFlowColumns(connection) {
  if (notepadFlowEnsured) return;
  const [f] = await connection.query("SHOW COLUMNS FROM check_list LIKE 'filed_at'");
  if (!f.length) {
    await connection.query("ALTER TABLE check_list ADD COLUMN filed_at DATETIME NULL DEFAULT NULL");
  }
  const [k] = await connection.query("SHOW COLUMNS FROM check_list LIKE 'kept'");
  if (!k.length) {
    await connection.query("ALTER TABLE check_list ADD COLUMN kept TINYINT(1) NOT NULL DEFAULT 0");
  }
  // Distinct lead association (mutually exclusive with job_id — a lead id must
  // NEVER be stored in job_id, which the rest of the system treats as a job).
  const [ld] = await connection.query("SHOW COLUMNS FROM check_list LIKE 'lead_id'");
  if (!ld.length) {
    await connection.query("ALTER TABLE check_list ADD COLUMN lead_id INT NULL DEFAULT NULL");
  }
  // Optional job attached to a whole Notepad section: tasks created inside it
  // already know their job (so pushing a task only needs an assignee). NULL = no
  // job attached. Stores a JOB id only (never a lead).
  const [sj] = await connection.query("SHOW COLUMNS FROM checklist_sections LIKE 'job_id'");
  if (!sj.length) {
    await connection.query("ALTER TABLE checklist_sections ADD COLUMN job_id INT NULL DEFAULT NULL");
  }
  notepadFlowEnsured = true;
}

// Resolve a job to attach to a notepad section. Must be a real JOB that belongs
// to the caller's ACCOUNT (never a foreign job — that would leak its name/colour
// onto the attacher's pad). null in → null out (detach / no job). Returns
// { ok, jobId } — ok:false means the supplied id is missing or cross-account.
async function resolveNotepadJob(connection, jobId, userId) {
  if (jobId == null || jobId === '') return { ok: true, jobId: null };
  const [[row]] = await connection.query('SELECT created_by FROM `job` WHERE id = ? LIMIT 1', [Number(jobId)]);
  if (!row) return { ok: false, jobId: null };
  if (!(await isSameAccount(userId, row.created_by, connection))) return { ok: false, jobId: null };
  return { ok: true, jobId: Number(jobId) };
}

// Minutes an item lingers on the Notepad after it's filed (grace to edit/Keep).
const NOTEPAD_FILE_GRACE_MIN = 7;

// An item is "filed-eligible" (has a home elsewhere) when it's completed,
// on the calendar, an appointment, delegated to someone else, or delegated to
// self WITH a date. Expressed as SQL against check_list columns.
const FILED_ELIGIBLE_SQL = `(
  status = 'completed'
  OR is_calendar = 1
  OR is_appointment = 1
  OR (assign_to IS NOT NULL AND (assign_to <> created_by OR due_date IS NOT NULL))
)`;

 // Only one type remains ('task' = a Notepad page). Any legacy 'shopping' input
 // is coerced to 'task' so old clients/rows can't create the retired variant.
 function normalizeChecklistType(type) {
   return 'task';
 }

 function getDefaultSectionTitle(type) {
   return 'My Notepad';
 }

 async function getNextSectionSortOrder(connection, userId, type) {
   const normalizedType = normalizeChecklistType(type);
   const [[row]] = await connection.query(
     `SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
      FROM checklist_sections
      WHERE owner_user_id = ? AND type = ?`,
     [userId, normalizedType],
   );
   return Number(row?.max_sort_order || 0) + 1;
 }

 // A section the caller may READ and ADD to. Three ways in (CCP §6/§7/§9):
 //   owner  — their own pad
 //   full   — on the global allowlist, and it's a COMPANY pad on their account
 //   share  — a live per-notepad share (they may check off and add, nothing more)
 // Anything else returns null, which every caller turns into a 403/404.
 async function getAccessibleSection(connection, sectionId, userId) {
  const access = await getSectionAccess(connection, sectionId, userId);
  if (!access) return null;
  return { ...access.section, _role: access.role };
}

 // Owner-or-full-access: the two roles that may RENAME, RE-JOB, REORDER or
 // DELETE a whole pad. A share recipient never can.
 async function getManageableSection(connection, sectionId, userId) {
  const access = await getSectionAccess(connection, sectionId, userId);
  if (!access || access.role === 'share') return null;
  return { ...access.section, _role: access.role };
}

async function getOwnedSection(connection, sectionId, userId) {
  await ensureNotepadSchema(connection);
  const [[row]] = await connection.query(
    `SELECT id, owner_user_id, shared_with_user_id, type, title, sort_order, origin, scope, created_at, updated_at
     FROM checklist_sections
     WHERE id = ? AND owner_user_id = ?
     LIMIT 1`,
    [sectionId, userId],
  );
  return row || null;
}

async function ensureDefaultSection(connection, userId, type) {
  const normalizedType = normalizeChecklistType(type);
  const defaultTitle = getDefaultSectionTitle(normalizedType);
  // Seed a default ONLY when the user has NO section of this type at all.
  // (Checking by exact default title would wrongly resurrect a default page
  // after the user deletes it, when their remaining pages are renamed/numbered.)
  const [[existing]] = await connection.query(
    `SELECT id, owner_user_id, shared_with_user_id, type, title, sort_order, created_at, updated_at
     FROM checklist_sections
     WHERE owner_user_id = ? AND type = ?
     ORDER BY id ASC
      LIMIT 1`,
    [userId, normalizedType],
  );

  if (existing) {
    return existing;
  }

  const sortOrder = await getNextSectionSortOrder(connection, userId, normalizedType);
  const [result] = await connection.query(
    `INSERT INTO checklist_sections
      (owner_user_id, shared_with_user_id, type, title, sort_order)
     VALUES (?, NULL, ?, ?, ?)`,
    [userId, normalizedType, defaultTitle, sortOrder],
  );

  return {
    id: result.insertId,
    owner_user_id: userId,
    shared_with_user_id: null,
    type: normalizedType,
    title: defaultTitle,
    sort_order: sortOrder,
  };
}

async function getAccessibleChecklistItem(connection, id, userId, extraFields = '') {
  const selectFields = extraFields ? `, ${extraFields}` : '';
  const [[row]] = await connection.query(
    `SELECT
      c.id,
      c.section_id,
      c.assign_to,
      c.name,
      c.created_by,
      c.calendar_task_id,
      c.appointment_id,
      c.type,
      s.owner_user_id,
      s.shared_with_user_id
      ${selectFields}
    FROM check_list c
    LEFT JOIN checklist_sections s ON s.id = c.section_id
    WHERE c.id = ?
    LIMIT 1`,
    [id],
  );
  if (!row) return null;

  // A row with no section is a legacy personal item: creator only.
  if (row.section_id == null) {
    return Number(row.created_by) === Number(userId) ? { ...row, _role: 'owner' } : null;
  }

  // Otherwise the SECTION decides who may touch the row (company pads and
  // live-shared pads both reach here).
  const access = await getSectionAccess(connection, row.section_id, userId);
  if (!access) return null;
  return { ...row, _role: access.role };
}

/**
 * The "editing your own typing" default rule, in one place:
 *   you MAY edit or delete an item YOU created;
 *   you may NEVER edit or delete one added by someone else.
 * Applies on My Tasks (the typo case) and in a shared notepad alike.
 */
function mayModifyItem(row, userId) {
  return Number(row.created_by) === Number(userId);
}

/**
 * Fields a NON-author may still write. Checking a box is a signal about the
 * work, not an edit of someone else's words — a share recipient and a
 * full-access colleague can both do it. Everything else is author-only.
 */
const NON_AUTHOR_WRITABLE = new Set(['status', 'assignee_completed']);

/**
 * 3i: a notepad task name is capped at 80 characters, server-side. The client
 * shows a live countdown and stops at 80; this is the enforcement that
 * matters, because a client cap is a courtesy and not a rule. Rows already in
 * the table that are longer than 80 are left alone — the cap applies to what
 * is written from here on, not retroactively.
 */
const NAME_MAX = 80;

const createChecklistSchema = Joi.object({
  name: Joi.string().allow('', null).max(NAME_MAX).required(),
  photo: Joi.string().allow('', null).max(255).optional(),
  // assign_to may hold either a user id or a team id (no separate column).
  assign_to: Joi.number().allow(null).optional(),
  job_id: Joi.number().allow(null).optional(),
  complete_percentage: Joi.number().min(0).max(100).allow(null).optional(),
  priority: Joi.string().valid('low', 'medium', 'high').optional(),
  due_date: Joi.date().allow(null).optional(),
  status: Joi.string().valid('new', 'completed').optional(),
  is_calendar: Joi.number().integer().valid(0, 1).allow(null).optional(),
  is_appointment: Joi.number().integer().valid(0, 1).allow(null).optional(),
  calendar_task_id: Joi.number().integer().positive().allow(null).optional(),
  appointment_id: Joi.number().integer().positive().allow(null).optional(),
  section_id: Joi.number().integer().positive().allow(null).optional(),
  type: Joi.string().valid('task').required(),
});

const updateChecklistSchema = Joi.object({
  name: Joi.string().allow('', null).max(NAME_MAX).optional(),
  // C9b: a note on the row itself. Not the two-way thread — that belongs to
  // the task a row becomes once delegated. 4000 matches the delegate note.
  note: Joi.string().allow('', null).max(4000).optional(),
  assign_to: Joi.number().allow(null).optional(),
  job_id: Joi.number().allow(null).optional(),
  lead_id: Joi.number().allow(null).optional(),
  complete_percentage: Joi.number().min(0).max(100).allow(null).optional(),
  priority: Joi.string().valid('low', 'medium', 'high').optional(),
  due_date: Joi.date().allow(null).optional(),
  status: Joi.string().valid('new', 'completed').optional(),
  assignee_completed: Joi.number().integer().valid(0, 1).allow(null).optional(),
  is_calendar: Joi.number().integer().valid(0, 1).allow(null).optional(),
  is_appointment: Joi.number().integer().valid(0, 1).allow(null).optional(),
  calendar_task_id: Joi.number().integer().positive().allow(null).optional(),
  appointment_id: Joi.number().integer().positive().allow(null).optional(),
  section_id: Joi.number().integer().positive().allow(null).optional(),
  type: Joi.string().valid('task').optional(),
  // Reference an existing photo (e.g. a linked See Job Run job photo) without
  // a file upload. Stored as a single reference string; handled at PUT /update/:id.
  photo: Joi.string().allow('', null).max(255).optional(),
});

const createChecklistSectionSchema = Joi.object({
  type: Joi.string().valid('task').required(),
  title: Joi.string().allow('', null).max(255).optional(),
  shared_with_user_id: Joi.number().allow(null).optional(),
  // Optional job attached to the whole notepad (null = none).
  job_id: Joi.number().integer().positive().allow(null).optional(),
  // A notepad can hang off a LEAD as well as a job. They are mutually
  // exclusive: attaching one detaches the other, below.
  lead_id: Joi.number().integer().positive().allow(null).optional(),
  sort_order: Joi.number().integer().min(0).allow(null).optional(),
});

const updateChecklistSectionSchema = Joi.object({
  title: Joi.string().allow('', null).max(255).optional(),
  shared_with_user_id: Joi.number().allow(null).optional(),
  // Attach / detach a job after the fact (null = detach).
  job_id: Joi.number().integer().positive().allow(null).optional(),
  sort_order: Joi.number().integer().min(0).allow(null).optional(),
});

const bulkStatusSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  status: Joi.string().valid('new', 'completed').required(),
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});

const upload = multer({ storage });

const toMySQLDate = (date) => {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

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

const toMySQLDateTime = (date) => {
  const d = parseDateInput(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

router.post('/sections', auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;

  try {
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }

      // ── C39: A SUBCONTRACTOR NEEDS THEIR OWN PLAN TO START A NOTEPAD ─────
      //
      // A sub reaches this app through somebody else's job. Receiving work
      // costs them nothing and always will — check off, note and photo stay
      // free forever, because the GC's crew depends on them working.
      //
      // Starting their OWN notepad is a different thing: that is using the
      // product for their own business, and it needs their own paid plan or
      // an active trial. Note this reads the SUB's access mode, never the
      // GC's — resolveOwnerId deliberately leaves a category-2 user pointing
      // at themselves so they cannot inherit the GC's subscription.
      try {
        // Gated with the rebuild: this is NEW policy on the OLD page, so
        // shipping it ungated would change what a sub can do while the
        // feature is supposedly off — and the flag could not take it back.
        if (notepadMyTasksEnabled() &&
            await isSubcontractor(connection, signedin_user) &&
            !(await subHasOwnPlan(connection, signedin_user))) {
          return res.status(403).json({
            success: false,
            code: 'SUB_NEEDS_PLAN',
            message: 'Start your own plan or trial to create your own notepads. Work sent to you stays free.',
          });
        }
      } catch (e) {
        // Fail OPEN, like the rest of the access model: a lookup that errors
        // must not stop somebody working.
        logger.error('subcontractor notepad-create check failed: ' + e.message);
      }

      const payload = req.body || {};
      const { error } = createChecklistSectionSchema.validate(payload);
      if (error) {
        return res.status(400).json({ success: false, message: error.details[0].message });
      }

      const type = normalizeChecklistType(payload.type);
      const title = String(payload.title || '').trim() || getDefaultSectionTitle(type);
      const sharedWithUserId = null; // share removed — Notepad sections are single-owner
      const sortOrder = payload.sort_order ?? await getNextSectionSortOrder(connection, signedin_user, type);

      await ensureNotepadFlowColumns(connection);
      const jobRes = await resolveNotepadJob(connection, payload.job_id, signedin_user);
      if (!jobRes.ok) {
        return res.status(403).json({ success: false, message: 'That job is not in your account.' });
      }
      const jobId = jobRes.jobId;

      // A notepad can hang off a LEAD as well as a job (§5). The Joi schema
      // above has always accepted lead_id, but the INSERT below never wrote
      // it — so creating a pad against a bid silently produced an unattached
      // pad. Ownership is checked the same way the UPDATE path checks it.
      let leadId = null;
      if (payload.lead_id != null) {
        const owner = Number(await resolveOwnerId(signedin_user, connection));
        const [[lead]] = await connection.query(
          'SELECT id, user_id FROM leads WHERE id = ? LIMIT 1',
          [Number(payload.lead_id)],
        );
        const leadOwner = lead ? Number(await resolveOwnerId(Number(lead.user_id), connection)) : null;
        if (!lead || leadOwner !== owner) {
          return res.status(403).json({ success: false, message: 'That lead is not in your account.' });
        }
        leadId = Number(payload.lead_id);
      }
      // Mutually exclusive, exactly as on update: a pad belongs to one or the
      // other, never both.
      const finalJobId = leadId != null ? null : jobId;

      // checklist_sections.lead_id is created by ensureNotepadSchema, which this
      // route does not run. So only mention the column when a lead is actually
      // being attached: the no-lead path keeps exactly the INSERT it always had
      // and gains no dependency on migration ordering.
      let result;
      if (leadId != null) {
        await ensureNotepadSchema(connection);
        [result] = await connection.query(
          `INSERT INTO checklist_sections
            (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [signedin_user, sharedWithUserId, type, title, sortOrder, null, leadId],
        );
      } else {
        [result] = await connection.query(
          `INSERT INTO checklist_sections
            (owner_user_id, shared_with_user_id, type, title, sort_order, job_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [signedin_user, sharedWithUserId, type, title, sortOrder, jobId],
        );
      }

      res.status(201).json({
        success: true,
        message: 'Checklist section created successfully',
        data: {
          id: result.insertId,
          owner_user_id: signedin_user,
          shared_with_user_id: sharedWithUserId,
          type,
          title,
          sort_order: sortOrder,
          job_id: finalJobId,
          lead_id: leadId,
        },
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error creating checklist section:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/sections', auth.authenticateToken, async (req, res) => {
  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }

      // Seed a single default "My Notepad" page for a brand-new user. The
      // "shopping" default was retired (single list type now).
      await ensureDefaultSection(connection, signedin_user, 'task');
      await ensureNotepadFlowColumns(connection); // so s.job_id is selectable

      const requestedType = req.query.type;
      const params = [signedin_user];
      let sql = `
        SELECT
          s.id,
          s.owner_user_id,
          s.shared_with_user_id,
          s.type,
          s.title,
          s.sort_order,
          s.job_id,
          j.name AS job_name,
          j.color AS job_color,
          owner.name AS owner_name,
          NULL AS shared_with_name,
          NULL AS assign_to_name,
          COUNT(c.id) AS item_count
        FROM checklist_sections s
        LEFT JOIN user owner ON owner.id = s.owner_user_id
        LEFT JOIN \`job\` j ON j.id = s.job_id
        LEFT JOIN check_list c ON c.section_id = s.id
        WHERE s.owner_user_id = ?
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        sql += ' AND s.type = ?';
        params.push(String(requestedType));
      }

      sql += `
        GROUP BY s.id, s.owner_user_id, s.shared_with_user_id, s.type, s.title, s.sort_order, s.job_id, j.name, j.color, owner.name
        ORDER BY s.type ASC, s.sort_order ASC, s.id ASC
      `;

      const [rows] = await connection.query(sql, params);
      res.status(200).json({ success: true, message: 'Checklist sections fetched successfully', data: rows });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error fetching checklist sections:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/sections-with-items', auth.authenticateToken, async (req, res) => {
  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }

      // Seed a single default "My Notepad" page for a brand-new user. The
      // "shopping" default was retired (single list type now).
      await ensureDefaultSection(connection, signedin_user, 'task');
      await ensureNotepadFlowColumns(connection); // so s.job_id is selectable

      const requestedType = req.query.type;
      // We also include sections that contain at least one item assigned to a
      // team this user belongs to. Without this clause a team member would
      // never see the GC's section (they don't own it / aren't shared with),
      // and the team-assigned items would be silently dropped at grouping.
      // Expired free trial: the user's OWN sections are locked. Only sections
      // SHARED with them by another account, or containing an item assigned to a
      // team they're on, stay visible (collaborator content — requirement #4).
      // The owner-branch is dropped for expired users; paid/trial are unchanged.
      // Single-owner Notepad: a user only ever sees their OWN sections + items.
      // (Section share, item delegation, and team visibility were all removed —
      // there is no cross-user access path anymore, so the expired-collaborator
      // branch is gone too; an expired user simply sees their own pages read-only.)
      const sectionParams = [signedin_user];
      const sectionsWhere = `s.owner_user_id = ?`;
      let sectionsSql = `
        SELECT
          s.id,
          s.owner_user_id,
          s.shared_with_user_id,
          s.type,
          s.title,
          s.sort_order,
          s.job_id,
          j.name AS job_name,
          j.color AS job_color,
          owner.name AS owner_name,
          NULL AS shared_with_name,
          NULL AS assign_to_name
        FROM checklist_sections s
        LEFT JOIN user owner ON owner.id = s.owner_user_id
        LEFT JOIN \`job\` j ON j.id = s.job_id
        WHERE ${sectionsWhere}
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        sectionsSql += ' AND s.type = ?';
        sectionParams.push(String(requestedType));
      }

      sectionsSql += ' ORDER BY s.type ASC, s.sort_order ASC, s.id ASC';

      // Owner-only items: a section item the caller owns, or a no-section item
      // they created. No shared/delegated/team access remains.
      const itemParams = [signedin_user, signedin_user];
      const itemsWhere = `(
            (c.section_id IS NOT NULL AND s.owner_user_id = ?)
            OR
            (c.section_id IS NULL AND c.created_by = ?)
          )`;
      // tm.* is populated only when assign_to matches a teams.id, giving the
      // frontend a way to render the team chip without a dedicated column.
      let itemsSql = `
        SELECT
          c.id,
          c.name,
          c.photo,
          c.assign_to,
          tm.id AS team_id,
          tm.team_name,
          tm.team_color,
          c.job_id,
          c.lead_id,
          c.complete_percentage,
          c.priority,
          c.due_date,
          c.status,
          c.assignee_completed,
          c.is_calendar,
          c.is_appointment,
          c.calendar_task_id,
          c.appointment_id,
          c.filed_at,
          c.kept,
          c.created_by,
          u.name AS created_by_name,
          c.type,
          c.section_id
        FROM check_list c
        LEFT JOIN user u ON u.id = c.created_by
        LEFT JOIN checklist_sections s ON s.id = c.section_id
        LEFT JOIN teams tm ON tm.id = c.assign_to
        WHERE ${itemsWhere}
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        itemsSql += ' AND c.type = ?';
        itemParams.push(String(requestedType));
      }

      // (Auto-clear/"Keep" removed) — every owned item stays on the Notepad; the
      // deprecated "Recently filed" peek (?filed=1) now returns nothing.
      await ensureNotepadFlowColumns(connection);
      const filedView = String(req.query.filed || '') === '1';
      if (filedView) {
        itemsSql += ' AND 1 = 0';
      }

      // Ordering (Notepad): completed items sink to the bottom (keeping their
      // normal row); starred items pin to the top of the active section; newest
      // first otherwise.
      itemsSql += " ORDER BY (c.status = 'completed') ASC, (c.priority = 'high') DESC, c.id DESC";

      const [sections, items] = await Promise.all([
        connection.query(sectionsSql, sectionParams).then(([rows]) => rows),
        connection.query(itemsSql, itemParams).then(([rows]) => rows),
      ]);

      const grouped = (Array.isArray(sections) ? sections : []).map((section) => ({
        ...section,
        items: (Array.isArray(items) ? items : []).filter((item) => Number(item.section_id || 0) === Number(section.id)),
      }));

      res.status(200).json({ success: true, message: 'Checklist sections fetched successfully', data: grouped });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error fetching checklist sections with items:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/sections/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist section id' });

  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }

      const section = await getManageableSection(connection, id, signedin_user);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Checklist section not found' });
      }

      const payload = req.body || {};
      const { error } = updateChecklistSectionSchema.validate(payload);
      if (error) {
        return res.status(400).json({ success: false, message: error.details[0].message });
      }

      const fields = [];
      const values = [];
      if (payload.title !== undefined) {
        fields.push('title = ?');
        values.push(String(payload.title || '').trim() || getDefaultSectionTitle(section.type));
      }
      // shared_with_user_id is intentionally ignored — Notepad sections are
      // single-owner now (the "Share With" grant was removed).
      if (payload.sort_order !== undefined) {
        fields.push('sort_order = ?');
        values.push(payload.sort_order);
      }
      // Attach / detach a job (null = detach). Validate it's a job in the account.
      if (payload.job_id !== undefined) {
        await ensureNotepadFlowColumns(connection);
        const jobRes = await resolveNotepadJob(connection, payload.job_id, signedin_user);
        if (!jobRes.ok) {
          return res.status(403).json({ success: false, message: 'That job is not in your account.' });
        }
        fields.push('job_id = ?');
        values.push(jobRes.jobId);
      }

      // Attach / detach a LEAD (null = detach). A notepad belongs to a job or
      // a lead, never both — a bid that becomes a job is repointed, not
      // duplicated (§5) — so setting one clears the other.
      if (payload.lead_id !== undefined) {
        await ensureNotepadFlowColumns(connection);
        if (payload.lead_id === null) {
          fields.push('lead_id = ?');
          values.push(null);
        } else {
          const owner = Number(await resolveOwnerId(signedin_user, connection));
          const [[lead]] = await connection.query(
            'SELECT id, user_id FROM leads WHERE id = ? LIMIT 1',
            [Number(payload.lead_id)],
          );
          const leadOwner = lead ? Number(await resolveOwnerId(Number(lead.user_id), connection)) : null;
          if (!lead || leadOwner !== owner) {
            return res.status(403).json({ success: false, message: 'That lead is not in your account.' });
          }
          fields.push('lead_id = ?');
          values.push(Number(payload.lead_id));
          fields.push('job_id = ?');
          values.push(null);
        }
      }

      if (!fields.length) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      values.push(id, signedin_user);
      await connection.query(
        `UPDATE checklist_sections SET ${fields.join(', ')} WHERE id = ? AND owner_user_id = ?`,
        values,
      );

      res.status(200).json({ success: true, message: 'Checklist section updated successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error updating checklist section:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/sections/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist section id' });

  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }

      const section = await getManageableSection(connection, id, signedin_user);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Checklist section not found' });
      }

      // DELETING A PAD IS NOT THE SAME RIGHT AS EDITING ONE.
      //
      // getManageableSection admits anyone whose role is not 'share', and
      // getSectionAccess hands role 'full' to every allowlisted user on a
      // COMPANY pad — which is correct for editing items and wrong for
      // destroying the pad. Without this check the two statements below
      // disagreed: `check_list` was deleted unscoped while
      // `checklist_sections` was scoped to owner_user_id, so a non-owner
      // admin wiped every item and left the empty pad standing, and the
      // endpoint answered 200 success. Items destroyed, nothing to show for
      // it, no error. (Reproduced in test/notepadDeleteAuthority.test.js.)
      //
      // The pad's owner may delete it. The account owner (the Boss) may
      // delete a COMPANY pad, because that pad is the company's. Nobody else
      // may, whatever their edit rights.
      const iAmTheOwner = Number(section.owner_user_id) === Number(signedin_user);
      const iAmTheBoss = await isAccountOwner(connection, signedin_user);
      const bossDeletingCompanyPad = iAmTheBoss && String(section.scope) === 'company';
      if (!iAmTheOwner && !bossDeletingCompanyPad) {
        return res.status(403).json({
          success: false,
          message: 'Only the notepad owner or the account owner can delete this notepad.',
        });
      }

      await connection.beginTransaction();
      try {
        // Both statements key off the section id now that authority is
        // settled above. Scoping one and not the other is what caused the
        // half-delete.
        await connection.query('DELETE FROM check_list WHERE section_id = ?', [id]);
        await connection.query('DELETE FROM checklist_sections WHERE id = ?', [id]);
        await connection.commit();
      } catch (e) {
        await connection.rollback();
        throw e;
      }

      res.status(200).json({ success: true, message: 'Checklist section deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error deleting checklist section:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /sections/:id/share  — send a one-way, point-in-time snapshot of an
// owned Notepad. This grants NO access: it renders the section's current items
// into a checklist and delivers it over Email (branded HTML) or in-house Chat
// (a direct message). SMS is handled client-side (plain text), so it never
// reaches this endpoint. Owner-only, like every other Notepad read.
const shareChecklistSchema = Joi.object({
  channel: Joi.string().valid('email', 'chat').required(),
  to_email: Joi.string().email().when('channel', { is: 'email', then: Joi.required(), otherwise: Joi.optional() }),
  to_user_id: Joi.number().integer().positive().when('channel', { is: 'chat', then: Joi.required(), otherwise: Joi.optional() }),
}).unknown(true);

router.post('/sections/:id/share', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist section id' });

  const { error, value } = shareChecklistSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  const channel = value.channel;

  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }

      // Owner-only: you can only share a Notepad you own.
      const section = await getOwnedSection(connection, id, signedin_user);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Checklist section not found' });
      }
      // CCP §9: the share affordance exists ONLY on hand-made notepads, NEVER on
      // an auto-created job or lead pad. That is enforced here as well as in the
      // UI, so a crafted request can't email a client a job's private list.
      if (String(section.origin || 'manual') !== 'manual') {
        return res.status(403).json({
          success: false,
          code: 'NOTEPAD_AUTO_NOT_SHAREABLE',
          message: 'Job and lead notepads cannot be shared.',
        });
      }

      // Point-in-time item list. Live items only (a snapshot of the current pad).
      const [items] = await connection.query(
        `SELECT name, status FROM check_list WHERE section_id = ? ORDER BY id ASC`,
        [id],
      );

      const title = (section.title && String(section.title).trim()) || 'My Notepad';
      const isDone = (it) => String(it.status || '').toLowerCase() === 'completed';

      // Plain-text snapshot — used for chat, and as the email text/alt part.
      const textLines = items.map((it) => `${isDone(it) ? '[x]' : '[ ]'} ${it.name || ''}`);
      const textBody =
        `${title}\n\n` + (textLines.length ? textLines.join('\n') : '(empty)') +
        `\n\n— Shared from See Job Run`;

      if (channel === 'email') {
        const to = String(value.to_email).trim();
        const rows = items
          .map((it) => {
            const done = isDone(it);
            const box = done ? '&#9745;' : '&#9744;'; // ☑ / ☐
            const color = done ? '#8a8a8a' : '#222222';
            const deco = done ? 'text-decoration:line-through;' : '';
            return `<tr><td style="padding:6px 8px;font-size:16px;color:${color};${deco}"><span style="font-size:18px;margin-right:8px">${box}</span>${escapeHtml(it.name || '')}</td></tr>`;
          })
          .join('');
        const html =
          `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:8px">` +
          `<h2 style="color:#c42034;margin:0 0 12px">${escapeHtml(title)}</h2>` +
          `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:8px;overflow:hidden">` +
          (rows || `<tr><td style="padding:10px 8px;color:#999;font-style:italic">(empty)</td></tr>`) +
          `</table>` +
          `<p style="color:#999;font-size:12px;margin-top:16px">This is a read-only snapshot shared from See Job Run. It won't update if the notepad changes.</p>` +
          `</div>`;
        // USER-ORIGINATED: a notepad snapshot is sent by one person to another
        // on the company's behalf, and the reader will reply to whoever sent
        // it — not to a no-reply address.
        const replyTo = await replyToForUser(connection, signedin_user);
        await mailer.sendMail({ to, replyTo, subject: `Notepad: ${title}`, html, text: textBody });
        return res.status(200).json({ success: true, message: 'Notepad sent by email.' });
      }

      // channel === 'chat' — open (or reuse) the direct conversation and post
      // the snapshot as a normal message from the sender.
      const toUser = Number(value.to_user_id);
      if (toUser === Number(signedin_user)) {
        return res.status(400).json({ success: false, message: 'Pick someone else to share with.' });
      }
      const conversationId = await chat.getOrCreateDirect(connection, signedin_user, toUser);
      if (!conversationId) {
        return res.status(400).json({ success: false, message: 'Could not open a chat with that person.' });
      }
      await chat.postMessage({ conversationId, senderId: signedin_user, body: textBody });
      return res.status(200).json({ success: true, message: 'Notepad sent to chat.', conversation_id: conversationId });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error sharing checklist section:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create', auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;

  try {
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }
      const payload = req.body || {};
      const { error } = createChecklistSchema.validate(payload);
      if (error) {
        return res.status(400).json({ success: false, message: error.details[0].message });
      }

      const {
        name,
        photo = null,
        assign_to = null,
        job_id = null,
        complete_percentage = null,
        priority,
        due_date,
        status,
        is_calendar = null,
        is_appointment = null,
        calendar_task_id = null,
        appointment_id = null,
        section_id = null,
        type,
      } = payload;

      const normalizedType = normalizeChecklistType(type);
      let section = null;
      if (section_id) {
        section = await getAccessibleSection(connection, Number(section_id), signedin_user);
        if (!section) {
          return res.status(404).json({ success: false, message: 'Checklist section not found' });
        }
        if (normalizeChecklistType(section.type) !== normalizedType) {
          return res.status(400).json({ success: false, message: 'Checklist section type does not match item type' });
        }

        // ── C26: A RECEIVED NOTEPAD IS READ-ONLY FOR NEW TASKS ───────────
        //
        // A subcontractor (or any off-list worker) sees a pad that carries
        // work the company delegated to them. They may tick it off, add a
        // note and add a photo — that is the whole of 3b — but the list is
        // the company's, and a task they invented on it would be invisible
        // to the person who owns the work.
        //
        // Enforced HERE and not by hiding the entry bar: the bar is a
        // courtesy, this is the rule.
        try {
          // SUBCONTRACTORS only. An off-list EMPLOYEE keeps their private
          // notes on a job pad — that is what the §8 merge exists to fold
          // into the company pad later, and blocking it would delete a
          // whole feature to enforce a rule about a different audience.
          const full = await isFullAccess(connection, signedin_user);
          const sub = await isSubcontractor(connection, signedin_user);
          // Gated with the rebuild — new policy on the OLD page, see above.
          if (notepadMyTasksEnabled() && !full && sub) {
            const [[hasDelegated]] = await connection.query(
              `SELECT 1 AS x
                 FROM check_list c
                 JOIN checklist_sections s2 ON s2.id = c.section_id
                WHERE c.delegated_to = ?
                  AND s2.job_id IS NOT NULL
                  AND s2.job_id = (SELECT job_id FROM checklist_sections WHERE id = ?)
                LIMIT 1`,
              [signedin_user, Number(section_id)],
            );
            if (hasDelegated) {
              return res.status(403).json({
                success: false,
                code: 'NOTEPAD_RECEIVED_READ_ONLY',
                message: 'This list was sent to you. You can check items off, add a note or add a photo.',
              });
            }
          }
        } catch (e) {
          // Never fail a create because this check could not run — the worst
          // case is the pre-existing behaviour, not a broken notepad.
          logger.error('received-pad create check failed: ' + e.message);
        }
      } else {
        section = await ensureDefaultSection(connection, signedin_user, normalizedType);
      }

      const finalPriority = priority ?? 'low';
      const finalStatus = status ?? 'new';
      // NO DATE MEANS NO DATE.
      //
      // This used to fall through to toMySQLDateTime(new Date()) for task-type
      // items, so EVERY notepad line added without a date was stamped with the
      // moment it was typed. Not a display default — written straight into
      // check_list.due_date on INSERT, which is why it survived a refresh, drove
      // the "late" calculation, and re-sorted the list around values nobody
      // had entered.
      //
      // Undated is a valid, common and intended state. If the user gave no
      // date, store null.
      const finalDueDate = due_date ? toMySQLDateTime(due_date) : null;

      const sql = `
        INSERT INTO check_list
          (section_id, name, photo, assign_to, job_id, complete_percentage, priority, due_date, status, created_by, type, is_calendar, is_appointment, calendar_task_id, appointment_id)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        section.id,
        name,
        photo,
        assign_to,
        job_id,
        complete_percentage,
        finalPriority,
        finalDueDate,
        finalStatus,
        signedin_user,
        normalizedType,
        is_calendar,
        is_appointment,
        calendar_task_id,
        appointment_id,
      ];

      const [result] = await connection.query(sql, values);

      res.status(201).json({
        success: true,
        message: 'Checklist item created successfully',
        data: {
          id: result.insertId,
          section_id: section.id,
          section_title: section.title,
          section_owner_user_id: section.owner_user_id,
          section_shared_with_user_id: section.shared_with_user_id,
          name,
          photo,
          assign_to,
          job_id,
          complete_percentage,
          priority: finalPriority,
          due_date: finalDueDate,
          status: finalStatus,
          assignee_completed: 0,
          created_by: signedin_user,
          type: normalizedType,
          is_calendar,
          is_appointment,
          calendar_task_id,
          appointment_id,
        },
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error creating checklist item:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// NOTE: POST /nudge/:id was removed — item-level delegation (notify an assigned
// person on a Notepad item) is gone. Collaboration lives in Task Manager now;
// a Notepad item that needs another person is "promoted to a Task" instead.

router.get('/list', auth.authenticateToken, async (req, res) => {
  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
    } finally {
      connection.release();
    }
    const type = req.query.type;
    const allowedTypes = new Set(['task']);

    let sql = `
      SELECT
        c.id,
        c.name,
        c.photo,
        c.assign_to,
        tm.id AS team_id,
        tm.team_name,
        tm.team_color,
        c.job_id,
        c.lead_id,
        c.complete_percentage,
        c.priority,
        c.due_date,
        c.status,
        c.assignee_completed,
        c.is_calendar,
        c.is_appointment,
        c.calendar_task_id,
        c.appointment_id,
        c.created_by,
        u.name AS created_by_name,
        c.type,
        c.section_id,
        s.title AS section_title,
        s.owner_user_id AS section_owner_user_id,
        s.shared_with_user_id AS section_shared_with_user_id,
        s.sort_order AS section_sort_order
      FROM check_list c
      LEFT JOIN user u ON u.id = c.created_by
      LEFT JOIN checklist_sections s ON s.id = c.section_id
      LEFT JOIN teams tm ON tm.id = c.assign_to
    `;

    const params = [signedin_user, signedin_user];

    // Single-owner: only the caller's own section items + own no-section items.
    sql += ` WHERE (
      (c.section_id IS NOT NULL AND s.owner_user_id = ?)
      OR
      (c.section_id IS NULL AND c.created_by = ?)
    )`;

    if (type && allowedTypes.has(String(type))) {
      sql += ' AND c.type = ?';
      params.push(String(type));
    }

    sql += ' ORDER BY c.id DESC';

    const [rows] = await pool.query(sql, params);

    res.status(200).json({
      success: true,
      message: 'Checklist items fetched successfully',
      data: rows,
    });
  } catch (err) {
    logger.error('Error fetching checklist items:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/update/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist id' });

  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }
      const payload = req.body || {};
      const { error } = updateChecklistSchema.validate(payload);
      if (error) {
        return res.status(400).json({ success: false, message: error.details[0].message });
      }

      const existingRow = await getAccessibleChecklistItem(connection, id, signedin_user);
      if (!existingRow) {
        return res.status(404).json({ success: false, message: 'Checklist item not found' });
      }

      // Default rule (CCP): you may edit an item YOU created; never one added by
      // someone else. Checking it off is the exception — that is a signal about
      // the work, not an edit of another person's words. Enforced on the request
      // so a shared-notepad recipient can't rewrite the owner's rows by hand.
      if (!mayModifyItem(existingRow, signedin_user)) {
        const touched = Object.keys(payload).filter((k) => !NON_AUTHOR_WRITABLE.has(k));
        if (touched.length) {
          return res.status(403).json({
            success: false,
            code: 'ITEM_AUTHOR_ONLY',
            message: "You can only edit an item you added yourself.",
            fields: touched,
          });
        }
      }

      const fields = [];
      const values = [];

      if (payload.name !== undefined) {
        fields.push('name = ?');
        values.push(payload.name);
      }
      if (payload.assign_to !== undefined) {
        fields.push('assign_to = ?');
        values.push(payload.assign_to);
      }
      if (payload.priority !== undefined) {
        fields.push('priority = ?');
        values.push(payload.priority);
      }
      // job_id and lead_id are mutually exclusive. Enforce it server-side too:
      // setting one to a real value clears the other, so a lead id can never
      // coexist with (or leak into) job_id.
      if (payload.job_id !== undefined) {
        fields.push('job_id = ?');
        values.push(payload.job_id);
        if (payload.job_id != null && payload.lead_id === undefined) {
          fields.push('lead_id = ?');
          values.push(null);
        }
      }
      if (payload.lead_id !== undefined) {
        fields.push('lead_id = ?');
        values.push(payload.lead_id);
        if (payload.lead_id != null && payload.job_id === undefined) {
          fields.push('job_id = ?');
          values.push(null);
        }
      }
      if (payload.complete_percentage !== undefined) {
        fields.push('complete_percentage = ?');
        values.push(payload.complete_percentage);
      }
      if (payload.due_date !== undefined) {
        fields.push('due_date = ?');
        values.push(payload.due_date ? toMySQLDateTime(payload.due_date) : null);
      }
      if (payload.status !== undefined) {
        fields.push('status = ?');
        values.push(payload.status);
      }
      if (payload.assignee_completed !== undefined) {
        fields.push('assignee_completed = ?');
        values.push(payload.assignee_completed);
      }
      if (payload.is_calendar !== undefined) {
        fields.push('is_calendar = ?');
        values.push(payload.is_calendar);
      }
      if (payload.is_appointment !== undefined) {
        fields.push('is_appointment = ?');
        values.push(payload.is_appointment);
      }
      if (payload.calendar_task_id !== undefined) {
        fields.push('calendar_task_id = ?');
        values.push(payload.calendar_task_id);
      }
      if (payload.appointment_id !== undefined) {
        fields.push('appointment_id = ?');
        values.push(payload.appointment_id);
      }
      // Allow setting the photo reference here (e.g. linking an existing See Job
      // Run job photo) without a file upload. Stored as a single reference string.
      if (payload.photo !== undefined) {
        fields.push('photo = ?');
        values.push(payload.photo);
      }
      if (payload.section_id !== undefined) {
        if (payload.section_id === null) {
          return res.status(400).json({ success: false, message: 'section_id cannot be null' });
        }
        const targetSection = await getAccessibleSection(connection, Number(payload.section_id), signedin_user);
        if (!targetSection) {
          return res.status(404).json({ success: false, message: 'Checklist section not found' });
        }
        const nextType = normalizeChecklistType(payload.type ?? existingRow.type);
        if (normalizeChecklistType(targetSection.type) !== nextType) {
          return res.status(400).json({ success: false, message: 'Checklist section type does not match item type' });
        }
        fields.push('section_id = ?');
        values.push(Number(payload.section_id));
      }
      if (payload.type !== undefined) {
        fields.push('type = ?');
        values.push(payload.type);
      }

      if (!fields.length) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      const sql = `UPDATE check_list SET ${fields.join(', ')} WHERE id = ?`;
      values.push(id);

      const [result] = await connection.query(sql, values);
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Checklist item not found' });
      }

      // Starring a DELEGATED notepad row must move that task to the top of the
      // assignee's My Tasks list (owner's rule). The two stars are stored in
      // different places — the notepad row uses check_list.priority, My Tasks
      // uses tasks.starred_at for its ORDER — so the link has to be made
      // explicitly. It previously only happened at delegate time, via the
      // Delegate sheet's priority checkbox; starring the row afterwards changed
      // nothing on the assignee's side. Propagate here so both platforms and
      // both entry points behave the same.
      if (payload.priority !== undefined) {
        try {
          await ensureNotepadSchema(connection);
          const [[link]] = await connection.query(
            'SELECT delegated_task_id FROM check_list WHERE id = ? LIMIT 1',
            [id],
          );
          if (link && link.delegated_task_id) {
            const starred = String(payload.priority).toLowerCase() === 'high';
            // A FRESH timestamp on every star is what puts it at the top of its
            // group; NULL on un-star drops it back into date order.
            await connection.query(
              'UPDATE tasks SET starred_at = ?, priority = ? WHERE id = ?',
              [starred ? new Date() : null, starred ? 'high' : 'low', link.delegated_task_id],
            );
          }
        } catch (e) {
          // Never fail the notepad edit over the mirror; log and move on.
          logger.error('star propagation to delegated task failed: ' + e.message);
        }
      }

      // (Auto-clear/"Keep" removed) — completed items now just sink to the bottom
      // of the Notepad and stay put; nothing gets filed away on a countdown.

      res.status(200).json({ success: true, message: 'Checklist item updated successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error updating checklist item:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// "Keep" pauses the Notepad auto-clear (kept=1, clears filed_at). Sending
// keep=0 un-keeps and restarts the grace countdown (filed_at=NOW()).
router.post('/:id/keep', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist id' });
  const keep = String((req.body && req.body.keep) ?? '1') !== '0';
  let connection;
  try {
    connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, res.locals.id);
      if (!access.allowed) return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      if (!access.canWrite) return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      // SECURITY: the plan gate above is NOT an ownership check — verify the caller
      // can actually access THIS item before toggling its kept/filed_at state
      // (was: UPDATE by id with no ownership → cross-account write).
      const keepItem = await getAccessibleChecklistItem(connection, id, res.locals.id);
      if (!keepItem) {
        return res.status(404).json({ success: false, message: 'Checklist item not found' });
      }
      await ensureNotepadFlowColumns(connection);
      const keepTz = await getUserTz(connection, res.locals.id);
      await connection.query(
        keep
          ? 'UPDATE check_list SET kept = 1, filed_at = NULL WHERE id = ?'
          : 'UPDATE check_list SET kept = 0, filed_at = ? WHERE id = ?',
        keep ? [id] : [timeStampFor(keepTz), id]
      );
      res.status(200).json({ success: true });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error keep/unkeep checklist item:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/status-update', auth.authenticateToken, async (req, res) => {
  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }
    } finally {
      connection.release();
    }

    const payload = req.body || {};
    const { error } = bulkStatusSchema.validate(payload);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { ids, status } = payload;
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      UPDATE check_list c
      LEFT JOIN checklist_sections s ON s.id = c.section_id
      SET c.status = ?
      WHERE c.id IN (${placeholders})
        AND (
          (c.section_id IS NOT NULL AND s.owner_user_id = ?)
          OR
          (c.section_id IS NULL AND c.created_by = ?)
        )
    `;
    const [result] = await pool.query(sql, [status, ...ids, signedin_user, signedin_user]);

    res.status(200).json({
      success: true,
      message: 'Checklist items updated successfully',
      data: { affectedRows: result.affectedRows },
    });
  } catch (err) {
    logger.error('Error bulk updating checklist status:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post(
  '/upload-photo/:id',
  auth.authenticateToken,
  upload.single('photo'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist id' });

    try {
      const signedin_user = res.locals.id;
      const connection = await pool.getConnection();
      try {
        const access = await getChecklistAccess(connection, signedin_user);
        if (!access.allowed) {
          return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
        }
        if (!access.canWrite) {
          return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
        }
        if (!req.file) {
          return res.status(400).json({ success: false, message: 'No photo uploaded' });
        }

        const filename = req.file.filename;
        const row = await getAccessibleChecklistItem(connection, id, signedin_user);
        if (!row) {
          return res.status(404).json({ success: false, message: 'Checklist item not found' });
        }

        const [result] = await connection.query(
          'UPDATE check_list SET photo = ? WHERE id = ?',
          [filename, id],
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ success: false, message: 'Checklist item not found' });
        }

        res.status(200).json({
          success: true,
          message: 'Photo uploaded successfully',
          data: { photo: filename },
        });
      } finally {
        connection.release();
      }
    } catch (err) {
      logger.error('Error uploading checklist photo:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

router.delete('/delete/:id', auth.authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid checklist id' });

  try {
    const signedin_user = res.locals.id;
    const connection = await pool.getConnection();
    try {
      const access = await getChecklistAccess(connection, signedin_user);
      if (!access.allowed) {
        return res.status(403).json({ success: false, message: 'Clipboard requires an active plan.' });
      }
      if (!access.canWrite) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Clipboard.' });
      }

      await connection.beginTransaction();

      const row = await getAccessibleChecklistItem(connection, id, signedin_user);
      if (!row) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Checklist item not found' });
      }

      // Same default rule as the update path: delete your own typing only.
      if (!mayModifyItem(row, signedin_user)) {
        await connection.rollback();
        return res.status(403).json({
          success: false,
          code: 'ITEM_AUTHOR_ONLY',
          message: 'You can only delete an item you added yourself.',
        });
      }

      const linkedTaskId = Number(row.calendar_task_id || 0) || null;
      const linkedAppointmentId = Number(row.appointment_id || 0) || null;

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

      // Delete appointment referenced by checklist row
      if (linkedAppointmentId) {
        await connection.query('DELETE FROM appointments WHERE id = ?', [linkedAppointmentId]);
      }
      // Delete appointment linked by task_id
      if (hasAppointmentTaskId && linkedTaskId) {
        await connection.query('DELETE FROM appointments WHERE task_id = ?', [linkedTaskId]);
      }

      // Delete linked task row
      if (linkedTaskId) {
        await connection.query('DELETE FROM tasks WHERE id = ?', [linkedTaskId]);
      }

      // Delete checklist row
      const [result] = await connection.query('DELETE FROM check_list WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Checklist item not found' });
      }

      await connection.commit();
      res.status(200).json({ success: true, message: 'Checklist item deleted successfully' });
    } catch (err) {
      try {
        await connection.rollback();
      } catch (_) {}
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('Error deleting checklist item:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
