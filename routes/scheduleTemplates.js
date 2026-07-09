// routes/scheduleTemplates.js — the master template LIBRARY (job-independent) plus
// the "apply to job" action. Templates are account-scoped; the shared seed
// (account_owner_id IS NULL) is visible to everyone but can only be CLONED, never
// edited in place, so one account can't mutate another's starting point.
// Mounted at `${API_URL}/schedule-templates`.

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

function accountOf(req) {
  return Number(req.user && req.user.working_id) || Number(req.user && req.user.id);
}

// Ensure the tables exist (idempotent, no-op after the first call / boot).
router.use(async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureScheduleTemplateTables(connection);
    next();
  } catch (err) {
    logger.error('[schedule-templates] ensure tables: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// GOLD-ONLY GATE: the entire Schedule Template feature (browse/edit/apply) requires
// the Gold plan. Server-side 403 — not just a hidden UI button. authenticateToken
// runs first so requirePlan can read req.user; it replaces the per-route auth.
router.use(auth.authenticateToken, requirePlan('gold'));

// Load a template the caller is allowed to EDIT (must own it — not the shared seed).
async function loadOwnedTemplate(connection, id, accountId) {
  const [[t]] = await connection.query('SELECT * FROM schedule_templates WHERE id = ? LIMIT 1', [id]);
  if (!t || t.status !== 'active') return { error: 404 };
  if (t.account_owner_id == null || Number(t.account_owner_id) !== Number(accountId)) {
    return { error: 403 };
  }
  return { template: t };
}

async function loadTemplateFull(connection, id) {
  const [[template]] = await connection.query('SELECT * FROM schedule_templates WHERE id = ? LIMIT 1', [id]);
  if (!template) return null;
  const [items] = await connection.query(
    'SELECT * FROM schedule_template_items WHERE template_id = ? ORDER BY sort_order ASC, id ASC',
    [id]
  );
  const itemIds = items.map((i) => i.id);
  let deps = [];
  if (itemIds.length) {
    [deps] = await connection.query(
      'SELECT id, item_id, depends_on_item_id FROM schedule_template_deps WHERE item_id IN (?)',
      [itemIds]
    );
  }
  return { template, items, deps };
}

// Deep-copy a source template's items + dependency edges into an existing
// destination template (preserving durations, depends_on_all, is_inspection, order,
// and remapping dep edges to the new stable ids). Used by clone / adopt / reset.
async function copyItemsAndDeps(connection, srcTemplateId, destTemplateId) {
  const [items] = await connection.query(
    'SELECT * FROM schedule_template_items WHERE template_id = ? ORDER BY sort_order ASC, id ASC',
    [srcTemplateId]
  );
  const idMap = new Map();
  for (const it of items) {
    const [ir] = await connection.query(
      `INSERT INTO schedule_template_items
         (template_id, name, default_duration_days, depends_on_all, is_inspection, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [destTemplateId, it.name, it.default_duration_days, it.depends_on_all ? 1 : 0, it.is_inspection ? 1 : 0, it.sort_order]
    );
    idMap.set(it.id, ir.insertId);
  }
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    const [deps] = await connection.query(
      'SELECT item_id, depends_on_item_id FROM schedule_template_deps WHERE item_id IN (?)',
      [itemIds]
    );
    for (const d of deps) {
      const ni = idMap.get(d.item_id);
      const nd = idMap.get(d.depends_on_item_id);
      if (ni && nd) {
        await connection.query(
          'INSERT IGNORE INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)',
          [ni, nd]
        );
      }
    }
  }
}

// GET /schedule-templates — list account's templates + the shared seed.
router.get('/', async (req, res) => {
  const accountId = accountOf(req);
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT t.id, t.name, t.is_seed, t.status, t.account_owner_id, t.cloned_from_template_id,
              t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM schedule_template_items i WHERE i.template_id = t.id) AS item_count
         FROM schedule_templates t
        WHERE t.status = 'active' AND (t.account_owner_id = ? OR t.account_owner_id IS NULL)
        ORDER BY t.is_seed DESC, t.name ASC`,
      [accountId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('[schedule-templates] list: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /schedule-templates — create a blank named template.
router.post('/', async (req, res) => {
  const accountId = accountOf(req);
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
  let connection;
  try {
    connection = await pool.getConnection();
    const [r] = await connection.query(
      `INSERT INTO schedule_templates (name, account_owner_id, created_by, is_seed, status)
       VALUES (?, ?, ?, 0, 'active')`,
      [name, accountId, req.user.id]
    );
    const full = await loadTemplateFull(connection, r.insertId);
    res.status(201).json({ success: true, data: full });
  } catch (err) {
    logger.error('[schedule-templates] create: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// GET /schedule-templates/:id — full template with items + deps.
router.get('/:id', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    const full = await loadTemplateFull(connection, id);
    if (!full || full.template.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const owner = full.template.account_owner_id;
    if (owner != null && Number(owner) !== Number(accountId)) {
      return res.status(403).json({ success: false, message: 'Not your template' });
    }
    res.json({ success: true, data: full });
  } catch (err) {
    logger.error('[schedule-templates] get: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /schedule-templates/:id — rename / update in place ("Update" button).
router.put('/:id', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error === 404) return res.status(404).json({ success: false, message: 'Template not found' });
    if (owned.error === 403) {
      return res.status(403).json({ success: false, message: 'The shared template cannot be edited — clone it first.' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
    await connection.query('UPDATE schedule_templates SET name = ? WHERE id = ?', [name, id]);
    const full = await loadTemplateFull(connection, id);
    res.json({ success: true, data: full });
  } catch (err) {
    logger.error('[schedule-templates] update: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /schedule-templates/:id/clone — deep-copy any VISIBLE template into a new
// account-owned one, recording provenance (cloned_from_template_id).
router.post('/:id/clone', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
  let connection;
  try {
    connection = await pool.getConnection();
    const [[src]] = await connection.query('SELECT id, account_owner_id, status FROM schedule_templates WHERE id = ? LIMIT 1', [id]);
    if (!src || src.status !== 'active') return res.status(404).json({ success: false, message: 'Template not found' });
    if (src.account_owner_id != null && Number(src.account_owner_id) !== Number(accountId)) {
      return res.status(403).json({ success: false, message: 'Not your template' });
    }
    await connection.beginTransaction();
    const [r] = await connection.query(
      `INSERT INTO schedule_templates (name, account_owner_id, created_by, is_seed, status, cloned_from_template_id)
       VALUES (?, ?, ?, 0, 'active', ?)`,
      [name, accountId, req.user.id, id]
    );
    await copyItemsAndDeps(connection, id, r.insertId);
    await connection.commit();
    const full = await loadTemplateFull(connection, r.insertId);
    res.status(201).json({ success: true, data: full });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[schedule-templates] clone: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /schedule-templates/:id/adopt — "Use See Job Run's template". Returns the
// account's EXISTING personal copy of this source if one exists (no duplicate),
// otherwise auto-clones it now. `data.adopted` = true when a new copy was created.
router.post('/:id/adopt', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    const [[src]] = await connection.query('SELECT id, name, account_owner_id, status FROM schedule_templates WHERE id = ? LIMIT 1', [id]);
    if (!src || src.status !== 'active') return res.status(404).json({ success: false, message: 'Template not found' });
    if (src.account_owner_id != null && Number(src.account_owner_id) !== Number(accountId)) {
      return res.status(403).json({ success: false, message: 'Not your template' });
    }
    // Reopen an existing personal copy of this source, if any.
    const [[existing]] = await connection.query(
      "SELECT id FROM schedule_templates WHERE account_owner_id = ? AND cloned_from_template_id = ? AND status = 'active' ORDER BY id ASC LIMIT 1",
      [accountId, id]
    );
    if (existing) {
      const full = await loadTemplateFull(connection, existing.id);
      return res.json({ success: true, data: full, adopted: false });
    }
    // Otherwise auto-clone silently (no user-facing "save as new" step).
    await connection.beginTransaction();
    const [r] = await connection.query(
      `INSERT INTO schedule_templates (name, account_owner_id, created_by, is_seed, status, cloned_from_template_id)
       VALUES (?, ?, ?, 0, 'active', ?)`,
      [src.name, accountId, req.user.id, id]
    );
    await copyItemsAndDeps(connection, id, r.insertId);
    await connection.commit();
    const full = await loadTemplateFull(connection, r.insertId);
    res.status(201).json({ success: true, data: full, adopted: true });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[schedule-templates] adopt: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /schedule-templates/:id/reset — "Reset to starter": wipe an owned template's
// items/deps and re-copy them from whatever it was cloned from. 400 if it has no
// clone source (a blank-started template is cleared by the client instead).
router.post('/:id/reset', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Not your template' : 'Template not found' });
    const srcId = owned.template.cloned_from_template_id;
    if (!srcId) return res.status(400).json({ success: false, code: 'NO_SOURCE', message: 'This template has no starter to reset to.' });

    await connection.beginTransaction();
    // Deleting items cascades their dep edges (FK ON DELETE CASCADE).
    await connection.query('DELETE FROM schedule_template_items WHERE template_id = ?', [id]);
    await copyItemsAndDeps(connection, srcId, id);
    await connection.commit();
    const full = await loadTemplateFull(connection, id);
    res.json({ success: true, data: full });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[schedule-templates] reset: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /schedule-templates/:id — soft-delete (owned only).
router.delete('/:id', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error === 404) return res.status(404).json({ success: false, message: 'Template not found' });
    if (owned.error === 403) return res.status(403).json({ success: false, message: 'Cannot delete the shared template.' });
    await connection.query("UPDATE schedule_templates SET status = 'deleted' WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('[schedule-templates] delete: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// ---- line items ----

// POST /schedule-templates/:id/items — add a line item.
router.post('/:id/items', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
    const dur = req.body.default_duration_days;
    const dependsOnAll = req.body.depends_on_all ? 1 : 0;
    const isInspection = req.body.is_inspection ? 1 : 0;
    const [[maxRow]] = await connection.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM schedule_template_items WHERE template_id = ?',
      [id]
    );
    const [r] = await connection.query(
      `INSERT INTO schedule_template_items (template_id, name, default_duration_days, depends_on_all, is_inspection, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, (dur === '' || dur == null) ? null : Number(dur), dependsOnAll, isInspection, Number(maxRow.m) + 1]
    );
    const [[item]] = await connection.query('SELECT * FROM schedule_template_items WHERE id = ? LIMIT 1', [r.insertId]);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    logger.error('[schedule-templates] add item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /schedule-templates/:id/items/reorder — bulk sort_order (mirror master-tasks
// reorder). MUST be declared before the '/:id/items/:itemId' route so the literal
// 'reorder' segment isn't captured as an :itemId.
router.put('/:id/items/reorder', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array' });
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });
    await connection.beginTransaction();
    for (const row of order) {
      const iid = Number(row && row.id);
      const so = Number(row && row.sort_order);
      if (!iid || isNaN(so)) continue;
      await connection.query(
        'UPDATE schedule_template_items SET sort_order = ? WHERE id = ? AND template_id = ?',
        [so, iid, id]
      );
    }
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    if (connection) { try { await connection.rollback(); } catch (_) {} }
    logger.error('[schedule-templates] reorder items: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /schedule-templates/:id/items/:itemId — edit a line item.
router.put('/:id/items/:itemId', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });

    const sets = [];
    const vals = [];
    if (typeof req.body.name === 'string') { sets.push('name = ?'); vals.push(req.body.name.trim()); }
    if ('default_duration_days' in req.body) {
      const d = req.body.default_duration_days;
      sets.push('default_duration_days = ?');
      vals.push((d === '' || d == null) ? null : Number(d));
    }
    if ('depends_on_all' in req.body) { sets.push('depends_on_all = ?'); vals.push(req.body.depends_on_all ? 1 : 0); }
    if ('is_inspection' in req.body) { sets.push('is_inspection = ?'); vals.push(req.body.is_inspection ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    vals.push(itemId, id);
    await connection.query(
      `UPDATE schedule_template_items SET ${sets.join(', ')} WHERE id = ? AND template_id = ?`,
      vals
    );
    const [[item]] = await connection.query('SELECT * FROM schedule_template_items WHERE id = ? LIMIT 1', [itemId]);
    res.json({ success: true, data: item });
  } catch (err) {
    logger.error('[schedule-templates] edit item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /schedule-templates/:id/items/:itemId — remove item (+ its dep edges via FK cascade).
router.delete('/:id/items/:itemId', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });
    await connection.query('DELETE FROM schedule_template_items WHERE id = ? AND template_id = ?', [itemId, id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('[schedule-templates] delete item: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// ---- dependencies ----

// POST /schedule-templates/:id/items/:itemId/deps — add a dependency (by stable id).
router.post('/:id/items/:itemId/deps', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const dependsOn = Number(req.body && req.body.depends_on_item_id);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });
    if (!dependsOn || dependsOn === itemId) {
      return res.status(400).json({ success: false, message: 'Invalid dependency' });
    }
    // Both items must belong to this template.
    const [belong] = await connection.query(
      'SELECT id FROM schedule_template_items WHERE template_id = ? AND id IN (?, ?)',
      [id, itemId, dependsOn]
    );
    if (belong.length < 2) return res.status(400).json({ success: false, message: 'Items not in this template' });

    // Cycle check on the resulting graph BEFORE saving.
    const [items] = await connection.query(
      'SELECT id, depends_on_all FROM schedule_template_items WHERE template_id = ?',
      [id]
    );
    const itemIds = items.map((i) => i.id);
    const [deps] = await connection.query(
      'SELECT item_id, depends_on_item_id FROM schedule_template_deps WHERE item_id IN (?)',
      [itemIds]
    );
    deps.push({ item_id: itemId, depends_on_item_id: dependsOn });
    const cycle = engine.detectCycle(
      items.map((i) => ({ id: i.id, depends_on_all: !!i.depends_on_all })),
      deps
    );
    if (cycle.length) {
      return res.status(409).json({ success: false, code: 'CYCLE', message: 'That dependency would create a cycle', cycle });
    }

    await connection.query(
      'INSERT IGNORE INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)',
      [itemId, dependsOn]
    );
    const [[dep]] = await connection.query(
      'SELECT id, item_id, depends_on_item_id FROM schedule_template_deps WHERE item_id = ? AND depends_on_item_id = ? LIMIT 1',
      [itemId, dependsOn]
    );
    res.status(201).json({ success: true, data: dep });
  } catch (err) {
    logger.error('[schedule-templates] add dep: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /schedule-templates/:id/deps/:depId — remove a dependency edge.
router.delete('/:id/deps/:depId', async (req, res) => {
  const accountId = accountOf(req);
  const id = Number(req.params.id);
  const depId = Number(req.params.depId);
  let connection;
  try {
    connection = await pool.getConnection();
    const owned = await loadOwnedTemplate(connection, id, accountId);
    if (owned.error) return res.status(owned.error).json({ success: false, message: owned.error === 403 ? 'Clone the shared template to edit.' : 'Template not found' });
    // Only delete if the edge belongs to an item in this template.
    await connection.query(
      `DELETE d FROM schedule_template_deps d
         JOIN schedule_template_items i ON i.id = d.item_id
        WHERE d.id = ? AND i.template_id = ?`,
      [depId, id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('[schedule-templates] delete dep: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

// ---- apply to job ----

// POST /schedule-templates/:id/apply — generate a job's schedule from this template.
router.post('/:id/apply', async (req, res) => {
  const templateId = Number(req.params.id);
  const b = req.body || {};
  const jobId = Number(b.job_id);
  const ownerType = b.owner_type === 'lead' ? 'lead' : 'job';
  const startDate = b.start_date;
  if (!jobId) return res.status(400).json({ success: false, message: 'job_id is required' });
  if (!startDate) return res.status(400).json({ success: false, message: 'start_date is required' });

  let connection;
  try {
    connection = await pool.getConnection();

    // Template must be visible to the caller.
    const accountId = accountOf(req);
    const [[tpl]] = await connection.query('SELECT id, account_owner_id, status FROM schedule_templates WHERE id = ? LIMIT 1', [templateId]);
    if (!tpl || tpl.status !== 'active') return res.status(404).json({ success: false, message: 'Template not found' });
    if (tpl.account_owner_id != null && Number(tpl.account_owner_id) !== Number(accountId)) {
      return res.status(403).json({ success: false, message: 'Not your template' });
    }

    await connection.beginTransaction();
    let result;
    try {
      result = await cascade.applyTemplateToJob(connection, {
        templateId,
        jobId,
        ownerType,
        startDate,
        skipSaturday: !!b.skip_saturday,
        skipSunday: !!b.skip_sunday,
        assignments: Array.isArray(b.assignments) ? b.assignments : [],
        actorId: req.user.id,
      });
      await connection.commit();
    } catch (applyErr) {
      await connection.rollback();
      if (applyErr.cycle) {
        return res.status(409).json({ success: false, code: 'CYCLE', message: applyErr.message, cycle: applyErr.cycle });
      }
      throw applyErr;
    }

    // Dispatch batched notifications AFTER commit (fire-and-forget).
    for (const p of result.notifPayloads) {
      notify.dispatchScheduleNotification(pool, p).catch(() => {});
    }

    res.status(201).json({ success: true, schedule_id: result.scheduleId, notified: result.notifPayloads.length });
  } catch (err) {
    logger.error('[schedule-templates] apply: ' + err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
