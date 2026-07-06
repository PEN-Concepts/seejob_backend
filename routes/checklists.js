const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const Joi = require('joi');
const auth = require('../services/authentication');
const { getTimeStamp } = require('../common/timdate');
const multer = require('multer');
const path = require('path');
const admin = require('../config/firebase-admin');
const logger = require('../common/logger');
const { getAccessMode } = require('../utils/access');

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

  return { role, allowed: true, canWrite: mode !== 'expired_free' };
}

 const VALID_CHECKLIST_TYPES = new Set(['task', 'shopping']);

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
  notepadFlowEnsured = true;
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

 function normalizeChecklistType(type) {
   return String(type || '').toLowerCase() === 'shopping' ? 'shopping' : 'task';
 }

 function getDefaultSectionTitle(type) {
   return normalizeChecklistType(type) === 'shopping' ? 'Shopping List' : 'My Notepad';
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

 async function getAccessibleSection(connection, sectionId, userId) {
  const [[row]] = await connection.query(
    `SELECT id, owner_user_id, shared_with_user_id, type, title, sort_order, created_at, updated_at
     FROM checklist_sections
     WHERE id = ?
       AND (owner_user_id = ? OR shared_with_user_id = ? )`,
    [sectionId, userId, userId, userId],
  );
  return row || null;
}

async function getOwnedSection(connection, sectionId, userId) {
  const [[row]] = await connection.query(
    `SELECT id, owner_user_id, shared_with_user_id, type, title, sort_order, created_at, updated_at
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
      c.calendar_task_id,
      c.appointment_id,
      c.type,
      s.owner_user_id,
      s.shared_with_user_id
      ${selectFields}
    FROM check_list c
    LEFT JOIN checklist_sections s ON s.id = c.section_id
    WHERE c.id = ?
      AND (
        (c.section_id IS NOT NULL AND (s.owner_user_id = ? OR s.shared_with_user_id = ?))
        OR
        (c.section_id IS NULL AND (c.created_by = ? OR c.assign_to = ?))
        OR
        EXISTS (
          SELECT 1 FROM team_user tu
          WHERE tu.team_id = c.assign_to AND tu.user_id = ?
        )
      )
    LIMIT 1`,
    [id, userId, userId, userId, userId, userId, userId],
  );
  return row || null;
}

const createChecklistSchema = Joi.object({
  name: Joi.string().allow('', null).max(255).required(),
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
  type: Joi.string().valid('task', 'shopping').required(),
});

const updateChecklistSchema = Joi.object({
  name: Joi.string().allow('', null).max(255).optional(),
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
  type: Joi.string().valid('task', 'shopping').optional(),
  // Reference an existing photo (e.g. a linked See Job Run job photo) without
  // a file upload. Stored as a single reference string; handled at PUT /update/:id.
  photo: Joi.string().allow('', null).max(255).optional(),
});

const createChecklistSectionSchema = Joi.object({
  type: Joi.string().valid('task', 'shopping').required(),
  title: Joi.string().allow('', null).max(255).optional(),
  shared_with_user_id: Joi.number().allow(null).optional(),

  sort_order: Joi.number().integer().min(0).allow(null).optional(),
});

const updateChecklistSectionSchema = Joi.object({
  title: Joi.string().allow('', null).max(255).optional(),
  shared_with_user_id: Joi.number().allow(null).optional(),
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

const toMySQLDateTime = (date) => {
  const d = new Date(date);
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

      const payload = req.body || {};
      const { error } = createChecklistSectionSchema.validate(payload);
      if (error) {
        return res.status(400).json({ success: false, message: error.details[0].message });
      }

      const type = normalizeChecklistType(payload.type);
      const title = String(payload.title || '').trim() || getDefaultSectionTitle(type);
      const sharedWithUserId = payload.shared_with_user_id ? Number(payload.shared_with_user_id) || null : null;
      const sortOrder = payload.sort_order ?? await getNextSectionSortOrder(connection, signedin_user, type);

      const [result] = await connection.query(
        `INSERT INTO checklist_sections
          (owner_user_id, shared_with_user_id, type, title, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [signedin_user, sharedWithUserId, type, title, sortOrder],
      );

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

      if (!req.query.type || String(req.query.type) === 'task') {
        await ensureDefaultSection(connection, signedin_user, 'task');
      }
      if (!req.query.type || String(req.query.type) === 'shopping') {
        await ensureDefaultSection(connection, signedin_user, 'shopping');
      }

      const requestedType = req.query.type;
      const params = [signedin_user, signedin_user, signedin_user];
      let sql = `
        SELECT
          s.id,
          s.owner_user_id,
          s.shared_with_user_id,
          s.type,
          s.title,
          s.sort_order,
          owner.name AS owner_name,
          shared.name AS shared_with_name,
          assigned.name AS assign_to_name,
          COUNT(c.id) AS item_count
        FROM checklist_sections s
        LEFT JOIN user owner ON owner.id = s.owner_user_id
        LEFT JOIN user shared ON shared.id = s.shared_with_user_id
        LEFT JOIN user assigned ON assigned.id = s.shared_with_user_id
        LEFT JOIN check_list c ON c.section_id = s.id
        WHERE (s.owner_user_id = ? OR s.shared_with_user_id = ?)
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        sql += ' AND s.type = ?';
        params.push(String(requestedType));
      }

      sql += `
        GROUP BY s.id, s.owner_user_id, s.shared_with_user_id, s.type, s.title, s.sort_order, owner.name, shared.name, assigned.name
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

      if (!req.query.type || String(req.query.type) === 'task') {
        await ensureDefaultSection(connection, signedin_user, 'task');
      }
      if (!req.query.type || String(req.query.type) === 'shopping') {
        await ensureDefaultSection(connection, signedin_user, 'shopping');
      }

      const requestedType = req.query.type;
      // We also include sections that contain at least one item assigned to a
      // team this user belongs to. Without this clause a team member would
      // never see the GC's section (they don't own it / aren't shared with),
      // and the team-assigned items would be silently dropped at grouping.
      const sectionParams = [signedin_user, signedin_user, signedin_user];
      let sectionsSql = `
        SELECT
          s.id,
          s.owner_user_id,
          s.shared_with_user_id,
          s.type,
          s.title,
          s.sort_order,
          owner.name AS owner_name,
          shared.name AS shared_with_name
          , assigned.name AS assign_to_name
        FROM checklist_sections s
        LEFT JOIN user owner ON owner.id = s.owner_user_id
        LEFT JOIN user shared ON shared.id = s.shared_with_user_id
        LEFT JOIN user assigned ON assigned.id = s.shared_with_user_id
        WHERE (
          s.owner_user_id = ?
          OR s.shared_with_user_id = ?
          OR s.id IN (
            SELECT DISTINCT c.section_id
            FROM check_list c
            WHERE c.section_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM team_user tu
                WHERE tu.team_id = c.assign_to AND tu.user_id = ?
              )
          )
        )
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        sectionsSql += ' AND s.type = ?';
        sectionParams.push(String(requestedType));
      }

      sectionsSql += ' ORDER BY s.type ASC, s.sort_order ASC, s.id ASC';

      // 5 params for the 5 placeholders in the WHERE below (owner, shared,
      // created_by, assign_to, team-user). A 6th param here would be wrongly
      // consumed by the appended "AND c.type = ?" clause, making it compare
      // c.type to a user id and return zero items.
      const itemParams = [signedin_user, signedin_user, signedin_user, signedin_user, signedin_user];
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
        WHERE (
          (c.section_id IS NOT NULL AND (s.owner_user_id = ? OR s.shared_with_user_id = ?))
          OR
          (c.section_id IS NULL AND (c.created_by = ? OR c.assign_to = ?))
          OR
          EXISTS (
            SELECT 1 FROM team_user tu
            WHERE tu.team_id = c.assign_to AND tu.user_id = ?
          )
        )
      `;

      if (requestedType && VALID_CHECKLIST_TYPES.has(String(requestedType))) {
        itemsSql += ' AND c.type = ?';
        itemParams.push(String(requestedType));
      }

      // Auto-clear: hide items filed > grace minutes ago (unless Kept). The
      // "Recently filed" peek (?filed=1) shows ONLY those cleared items.
      await ensureNotepadFlowColumns(connection);
      const filedView = String(req.query.filed || '') === '1';
      if (filedView) {
        itemsSql += ` AND c.kept = 0 AND c.filed_at IS NOT NULL AND c.filed_at <= (NOW() - INTERVAL ${NOTEPAD_FILE_GRACE_MIN} MINUTE)`;
      } else {
        itemsSql += ` AND (c.kept = 1 OR c.filed_at IS NULL OR c.filed_at > (NOW() - INTERVAL ${NOTEPAD_FILE_GRACE_MIN} MINUTE))`;
      }

      itemsSql += ' ORDER BY c.id DESC';

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

      const section = await getOwnedSection(connection, id, signedin_user);
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
      if (payload.shared_with_user_id !== undefined) {
        fields.push('shared_with_user_id = ?');
        values.push(payload.shared_with_user_id ? Number(payload.shared_with_user_id) || null : null);
      }
  
      if (payload.sort_order !== undefined) {
        fields.push('sort_order = ?');
        values.push(payload.sort_order);
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

      const section = await getOwnedSection(connection, id, signedin_user);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Checklist section not found' });
      }

      await connection.beginTransaction();
      try {
        await connection.query('DELETE FROM check_list WHERE section_id = ?', [id]);
        await connection.query('DELETE FROM checklist_sections WHERE id = ? AND owner_user_id = ?', [id, signedin_user]);
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
      } else {
        section = await ensureDefaultSection(connection, signedin_user, normalizedType);
      }

      const finalPriority = priority ?? 'low';
      const finalStatus = status ?? 'new';
      const finalDueDate = due_date
        ? toMySQLDateTime(due_date)
        : normalizedType === 'task'
          ? toMySQLDateTime(new Date())
          : null;

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

// Send an immediate nudge to the assigned user of a checklist item
router.post('/nudge/:id', auth.authenticateToken, async (req, res) => {
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
    } finally {
      connection.release();
    }

    const [[row]] = await pool.query(
      `SELECT c.id, c.name, c.assign_to
       FROM check_list c
       LEFT JOIN checklist_sections s ON s.id = c.section_id
       WHERE c.id = ?
         AND (
           (c.section_id IS NOT NULL AND (s.owner_user_id = ? OR s.shared_with_user_id = ?))
           OR
           (c.section_id IS NULL AND (c.created_by = ? OR c.assign_to = ?))
           OR
           EXISTS (
             SELECT 1 FROM team_user tu
             WHERE tu.team_id = c.assign_to AND tu.user_id = ?
           )
         )`,
      [id, signedin_user, signedin_user, signedin_user, signedin_user, signedin_user]
    );

    if (!row) {
      return res.status(404).json({ success: false, message: 'Checklist item not found' });
    }
    if (!row.assign_to) {
      return res.status(400).json({ success: false, message: 'Checklist item has no assigned user' });
    }

    const actorId = req.user && req.user.id ? req.user.id : signedin_user;
    const [[actorRow]] = await pool.query('SELECT name FROM user WHERE id=?', [actorId]);
    const actorName = actorRow ? actorRow.name : 'Someone';

    const assignedUser = row.assign_to;
    const url = '/checklist3';
    const notifyMessage = `${actorName} nudged you on checklist: "${row.name}".`;

    await pool.query(
      `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [actorId, assignedUser, notifyMessage, url, actorId]
    );

    const [[recipient]] = await pool.query(
      'SELECT fcm_token FROM user_device_tokens WHERE user_id=?',
      [assignedUser]
    );

    if (recipient && recipient.fcm_token) {
      const message = {
        token: recipient.fcm_token,
        notification: { title: 'Checklist Nudge', body: notifyMessage },
        data: { type: 'checklist_nudge', checklist_id: String(id), url },
      };
      try {
        await admin.messaging().send(message);
      } catch (err) {
        logger.error('FCM Error:', err);
      }
    }

    res.status(200).json({ success: true, message: 'Nudge sent' });
  } catch (err) {
    logger.error("Checklist nudge error:", err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

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
    const allowedTypes = new Set(['task', 'shopping']);

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

    const params = [signedin_user, signedin_user, signedin_user, signedin_user, signedin_user];

    sql += ` WHERE (
      (c.section_id IS NOT NULL AND (s.owner_user_id = ? OR s.shared_with_user_id = ?))
      OR
      (c.section_id IS NULL AND (c.created_by = ? OR c.assign_to = ?))
      OR
      EXISTS (
        SELECT 1 FROM team_user tu
        WHERE tu.team_id = c.assign_to AND tu.user_id = ?
      )
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

      // Once the item has a home elsewhere (delegated / calendar / appointment /
      // completed), stamp filed_at so it auto-clears from the Notepad after the
      // grace period — unless the user tapped "Keep" (kept = 1).
      await ensureNotepadFlowColumns(connection);
      await connection.query(
        `UPDATE check_list SET filed_at = NOW()
         WHERE id = ? AND filed_at IS NULL AND kept = 0 AND ${FILED_ELIGIBLE_SQL}`,
        [id]
      );

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
      await ensureNotepadFlowColumns(connection);
      await connection.query(
        keep
          ? 'UPDATE check_list SET kept = 1, filed_at = NULL WHERE id = ?'
          : 'UPDATE check_list SET kept = 0, filed_at = NOW() WHERE id = ?',
        [id]
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
          (c.section_id IS NOT NULL AND (s.owner_user_id = ? OR s.shared_with_user_id = ?))
          OR
          (c.section_id IS NULL AND (c.created_by = ? OR c.assign_to = ?))
          OR
          EXISTS (
            SELECT 1 FROM team_user tu
            WHERE tu.team_id = c.assign_to AND tu.user_id = ?
          )
        )
    `;
    const [result] = await pool.query(sql, [status, ...ids, signedin_user, signedin_user, signedin_user, signedin_user, signedin_user]);

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
