const express = require("express");
const router = express.Router();
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const { upload } = require("../services/fileUpload");
const path = require("path");
const fs = require("fs");

// ------------------ leads Section ------------------

const leadsSchema = Joi.object({
  user_id: Joi.number().integer().allow(null),
  lead_name: Joi.string().required(),
  lead_type: Joi.string().required(),
   lead_category: Joi.string().allow(null),
  budget: Joi.number().precision(2).allow(null),
  bid_status: Joi.string().allow('', null),
  client_id: Joi.number().optional().allow(null),
  project_street_address: Joi.string().allow('', null),
  project_town: Joi.string().allow('', null),
  project_state: Joi.string().allow('', null),
  project_description: Joi.string().allow('', null),
  project_start_date: Joi.date().allow(null),
  leads_street_address: Joi.string().allow('', null),
  leads_town_city: Joi.string().allow('', null),
  leads_state: Joi.string().allow('', null),
  leads_zipcode: Joi.string().allow('', null),
  next_phase: Joi.string().allow('', null),
  finance_method: Joi.string().allow('', null),

client_name: Joi.string().allow('', null).optional(),
client_email: Joi.string().allow('', null).optional(),
client_phone: Joi.string().allow('', null).optional(),
});

router.post("/leads/create", auth.authenticateToken, async (req, res) => {
  try {
    const { error } = leadsSchema.validate(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const {
      user_id,
      lead_name,
      lead_type,
      lead_category,
      budget,
      bid_status,
      client_id,
      client_name,
      client_email,
      client_phone,
      project_street_address,
      project_town,
      project_state,
      project_description,
      project_start_date,
      leads_street_address,
      leads_town_city,
      leads_state,
      leads_zipcode,
      next_phase,
      finance_method
    } = req.body;

    const created_at = getCurrentDateTime();

    // âœ… CONDITION LOGIC
    const isManualClient = !client_id; // null or undefined

    const finalClientId = isManualClient ? null : client_id;
    const finalClientName = isManualClient ? client_name : null;
    const finalClientEmail = isManualClient ? client_email : null;
    const finalClientPhone = isManualClient ? client_phone : null;

    const sql = `
      INSERT INTO leads (
        lead_name, lead_type, lead_category, budget, bid_status,
        client_id, client_name, client_email, client_phone,
        project_street_address, project_town, project_state,
        project_description, project_start_date, leads_street_address,
        leads_town_city, leads_state, leads_zipcode, next_phase,
        finance_method, created_at, user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      lead_name,
      lead_type,
      lead_category,
      budget,
      bid_status,
      finalClientId,
      finalClientName,
      finalClientEmail,
      finalClientPhone,
      project_street_address,
      project_town,
      project_state,
      project_description,
      project_start_date,
      leads_street_address,
      leads_town_city,
      leads_state,
      leads_zipcode,
      next_phase,
      finance_method,
      created_at,
      user_id
    ];

    // Safety net: mysql2 throws on undefined bind params. Any field the client
    // omits (e.g. lead_category/next_phase) would otherwise crash the INSERT.
    const safeValues = values.map((v) => (v === undefined ? null : v));
    const [result] = await pool.query(sql, safeValues);

    res.status(201).json({
      message: "Lead created successfully!",
      lead_id: result?.insertId ?? null,
    });

  } catch (err) {
    logger.error("Error creating lead:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET all leads with  user_id filter
router.get("/leads/all/:id", auth.authenticateToken, async (req, res) => {
  const user_id = req.params.id;
  // ?archived=1 returns ONLY archived leads (for the Archive tab); default
  // returns active leads and EXCLUDES bid_status='Archived'.
  const onlyArchived =
    String(req.query?.archived ?? '').trim() === '1' ||
    String(req.query?.archived ?? '').trim().toLowerCase() === 'true';
  const archiveClause = onlyArchived
    ? "AND l.bid_status = 'Archived'"
    : "AND (l.bid_status IS NULL OR l.bid_status <> 'Archived')";
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
      SELECT
        l.*,
        COALESCE(u.name, l.client_name)   AS client_name,
        COALESCE(u.email, l.client_email) AS client_email,
        COALESCE(u.mobile, l.client_phone) AS client_phone
      FROM leads l
      LEFT JOIN user u ON u.id = l.client_id
      WHERE l.user_id = ?
        AND (l.status IS NULL OR l.status <> '3')
        ${archiveClause}
      ORDER BY l.created_at DESC
    `, [ user_id]);

    res.status(200).json(rows);
  } catch (err) {
    logger.error("Error fetching leads for user", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});


// READ single lead
router.get("/leads/:id",auth.authenticateToken, async (req, res) => {
  try {
    // const sql = `
    //   SELECT 
    //     l.*, u.name AS client_name
    //   FROM leads l
    //   LEFT JOIN user u ON l.client_id = u.id
    //   WHERE l.id = ?
    // `;
     const sql = `
      SELECT 
          l.*, 
          u.name AS client_name,
          u.email AS client_email,
          u.mobile AS client_phone
        FROM leads l
        LEFT JOIN user u ON l.client_id = u.id
        WHERE l.id = ?

      `;
    const [rows] = await pool.query(sql, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: "Lead not found" });
    res.status(200).json(rows[0]);
  } catch (err) {
    logger.error("Error fetching lead by id:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/leads/update/:id", auth.authenticateToken, async (req, res) => {
  const leadId = req.params.id;
  const updates = req.body;

  if (!leadId || Object.keys(updates).length === 0) {
    return res.status(400).json({ message: "Invalid request" });
  }

  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?`);
    values.push(value);
  }

  const sql = `
    UPDATE leads
    SET ${setClauses.join(", ")}
    WHERE id = ?
  `;

  values.push(leadId); 

  try {
    const [result] = await pool.query(sql, values);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Lead not found" });
    }
    res.status(200).json({ message: "Lead updated successfully" });
  } catch (err) {
    logger.error("Error updating lead", err);
    res.status(500).json({ message: "Server error" });
  }
});

//update only bid status
router.patch("/leads/update-status/:id", auth.authenticateToken, async (req, res) => {
  const { bid_status } = req.body;

  if (!bid_status) return res.status(400).json({ message: "Bid status is required" });

  try {
    // When archiving, remember the pre-archive status so Unarchive can restore it.
    // Only capture when the lead isn't already archived (so re-archiving keeps the
    // real prior value, not 'Archived').
    const isArchiving = bid_status === 'Archived';
    const sql = isArchiving
      ? `UPDATE leads
           SET prior_bid_status = CASE WHEN (bid_status IS NULL OR bid_status <> 'Archived')
                                       THEN bid_status ELSE prior_bid_status END,
               bid_status = 'Archived'
         WHERE id = ?`
      : `UPDATE leads SET bid_status = ? WHERE id = ?`;
    const values = isArchiving ? [req.params.id] : [bid_status, req.params.id];

    const [result] = await pool.query(sql, values);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Lead not found" });

    res.status(200).json({ message: "Bid status updated successfully" });
  } catch (err) {
    logger.error("Error updating bid status", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Unarchive: restore the pre-archive bid_status (fallback 'Waiting') and clear it.
router.patch("/leads/unarchive/:id", auth.authenticateToken, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT prior_bid_status FROM leads WHERE id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ message: "Lead not found" });
    const prior = row.prior_bid_status && String(row.prior_bid_status).trim();
    const restored = prior && prior !== 'Archived' ? prior : 'Waiting';
    await pool.query(
      `UPDATE leads SET bid_status = ?, prior_bid_status = NULL WHERE id = ?`,
      [restored, req.params.id]
    );
    res.status(200).json({ message: "Lead unarchived", bid_status: restored });
  } catch (err) {
    logger.error("Error unarchiving lead", err);
    res.status(500).json({ message: "Server error" });
  }
});

// update only next phase
router.patch("/leads/update-phase/:id", auth.authenticateToken, async (req, res) => {
  const { next_phase } = req.body;
  if (!next_phase) return res.status(400).json({ message: "Next phase is required" });

  try {
    const sql = `UPDATE leads SET next_phase = ? WHERE id = ?`;
    const values = [next_phase, req.params.id];

    const [result] = await pool.query(sql, values);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Lead not found" });

    res.status(200).json({ message: "Next phase updated successfully" });
  } catch (err) {
    logger.error("Error updating next phase", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE lead
router.delete("/leads/delete/:id", auth.authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM leads WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Lead not found" });

    res.status(200).json({ message: "Lead deleted successfully!" });
  } catch (err) {
    logger.error("Error deleting lead", err);
    res.status(500).json({ message: "Server error" });
  }
});

// leads_comments get
router.get('/leads/:id/comments', auth.authenticateToken, async (req, res) => {
  try {
    const sql = `
      SELECT * FROM lead_comments
      WHERE lead_id = ?
      ORDER BY created_at ASC
    `;
    const [rows] = await pool.query(sql, [req.params.id]);
    res.status(200).json(rows);
  } catch (err) {
    logger.error('Error fetching comments:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// leads_comments post
router.post('/leads/:id/comments', auth.authenticateToken, async (req, res) => {
  const { comment } = req.body;
  const lead_id = req.params.id;

  if (!comment) {
    return res.status(400).json({ message: 'Comment is required' });
  }

  try {
    const sql = `
      INSERT INTO lead_comments (lead_id, comment)
      VALUES (?, ?)
    `;
    await pool.query(sql, [lead_id, comment]);
    res.status(201).json({ message: 'Comment added successfully' });
  } catch (err) {
    logger.error('Error adding comment:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// leads_notes create
// Idempotent: add a meeting_date column to lead_notes if missing.
let leadNoteDateEnsured = false;
async function ensureLeadNoteDateColumn() {
  if (leadNoteDateEnsured) return;
  try {
    await pool.query('ALTER TABLE lead_notes ADD COLUMN meeting_date DATE NULL DEFAULT NULL');
  } catch (e) { /* already exists */ }
  leadNoteDateEnsured = true;
}

router.post('/leads/:id/notes/create', async (req, res) => {
  const { title, description, meeting_date } = req.body;
  const lead_id = req.params.id;

  if (!title) {
    return res.status(400).json({ message: 'Title is required' });
  }

  try {
    await ensureLeadNoteDateColumn();
    const sql = `
      INSERT INTO lead_notes (lead_id, title, description, meeting_date)
      VALUES (?, ?, ?, ?)
    `;
    await pool.query(sql, [lead_id, title, description, meeting_date || null]);
    res.status(201).json({ message: 'Note added successfully' });
  } catch (err) {
    logger.error('Error adding note:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get notes for a specific lead
router.get('/leads/:id/notes',  async (req, res) => {
  const lead_id = req.params.id;

  try {
    await ensureLeadNoteDateColumn();
    const sql = `
      SELECT id, lead_id, title, description, meeting_date, created_at
      FROM lead_notes
      WHERE lead_id = ?
      ORDER BY COALESCE(meeting_date, created_at) DESC
    `;
    const [rows] = await pool.query(sql, [lead_id]);
    res.status(200).json(rows);
  } catch (err) {
    logger.error('Error fetching notes:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// leads_notes post
router.put('/leads/notes/update/:noteId', auth.authenticateToken, async (req, res) => {
  const { title, description } = req.body;
  const noteId = req.params.noteId;

  try {
    const sql = `
      UPDATE lead_notes
      SET title = ?, description = ?
      WHERE id = ?
    `;
    await pool.query(sql, [title, description, noteId]);
    res.status(200).json({ message: 'Note updated successfully' });
  } catch (err) {
    logger.error('Error updating note:', err);
    res.status(500).json({ message: 'Server error' });
  }
});


// leads_notes delete
router.delete('/leads/notes/delete/:noteId', auth.authenticateToken, async (req, res) => {
  const noteId = req.params.noteId;

  try {
    const sql = `
      DELETE FROM lead_notes
      WHERE id = ?
    `;
    await pool.query(sql, [noteId]);
    res.status(200).json({ message: 'Note deleted successfully' });
  } catch (err) {
    logger.error('Error deleting note:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ------------------ leads_to_do Section starts------------------

const leadsToDoSchema = Joi.object({
    lead_id: Joi.number().integer().required(),
    task_name: Joi.string().required(),
    start_date: Joi.date().required(),
    end_date: Joi.date().required(),
    description: Joi.string().allow('').optional()
});

// CREATE a leads_to_do item
router.post("/leads-to-do/create", auth.authenticateToken, async (req, res) => {
    try {
        const { error } = leadsToDoSchema.validate(req.body);
        if (error) return res.status(400).json({ message: error.details[0].message });

        const { lead_id,task_name,  start_date, end_date, description } = req.body;
        const created_at = getCurrentDateTime();

        const sql = `
            INSERT INTO leads_to_do (lead_id, task_name,  start_date, end_date, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        await pool.query(sql, [lead_id,task_name, start_date, end_date, description, created_at]);
        res.status(201).json({ message: "Leads To-Do created successfully!" });
    } catch (err) {
        logger.error("Error creating leads_to_do", err);
        res.status(500).json({ message: "Server error" });
    }
});

// READ all leads_to_do
router.get("/leads-to-do/all", auth.authenticateToken, async (req, res) => {
    try {
        const sql = `
            SELECT 
                t.id,
                t.lead_id,
                t.task_name,
                l.description AS lead_description,
                t.start_date,
                t.end_date,
                t.description,
                t.created_at
            FROM leads_to_do t
            LEFT JOIN leads l ON t.lead_id = l.id
            ORDER BY t.created_at DESC
        `;
        const [rows] = await pool.query(sql);
        res.status(200).json(rows);
    } catch (err) {
        logger.error("Error fetching leads_to_do", err);
        res.status(500).json({ message: "Server error" });
    }
});

// READ single leads_to_do
router.get("/leads-to-do/:id", auth.authenticateToken, async (req, res) => {
    try {
        const sql = `
            SELECT 
                t.id,
                t.lead_id,
                t.task_name,
                l.description AS lead_description,
                t.start_date,
                t.end_date,
                t.description,
                t.created_at
            FROM leads_to_do t
            LEFT JOIN leads l ON t.lead_id = l.id
            WHERE t.id = ?
        `;
        const [rows] = await pool.query(sql, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: "Leads To-Do not found" });
        res.status(200).json(rows[0]);
    } catch (err) {
        logger.error("Error fetching leads_to_do", err);
        res.status(500).json({ message: "Server error" });
    }
});

// UPDATE leads_to_do
router.put("/leads-to-do/update/:id", auth.authenticateToken, async (req, res) => {
    try {
        const { error } = leadsToDoSchema.validate(req.body);
        if (error) return res.status(400).json({ message: error.details[0].message });

        const { lead_id, task_name, start_date, end_date, description } = req.body;

        const sql = `
            UPDATE leads_to_do
            SET lead_id = ?, task_name = ?, start_date = ?, end_date = ?, description = ?
            WHERE id = ?
        `;

        const [result] = await pool.query(sql, [lead_id, task_name, start_date, end_date, description, req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: "Leads To-Do not found" });

        res.status(200).json({ message: "Leads To-Do updated successfully!" });
    } catch (err) {
        logger.error("Error updating leads_to_do", err);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE leads_to_do
router.delete("/leads-to-do/delete/:id", auth.authenticateToken, async (req, res) => {
    try {
        const [result] = await pool.query("DELETE FROM leads_to_do WHERE id = ?", [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: "Leads To-Do not found" });

        res.status(200).json({ message: "Leads To-Do deleted successfully!" });
    } catch (err) {
        logger.error("Error deleting leads_to_do", err);
        res.status(500).json({ message: "Server error" });
    }
});
// ------------------ leads_to_do Section ends------------------

// PUT /api/leads/update-budget
router.put('/update-budget', auth.authenticateToken, async (req, res) => {
  const { id, budget, job_budget, finance_method } = req.body;

  if (!id) {
    return res.status(400).json({ code: '400', message: 'Lead ID is required' });
  }

  try {
    await pool.query(
      `UPDATE leads 
       SET budget = ?, lead_budget = ?, finance_method = ? 
       WHERE id = ?`,
      [budget, job_budget, finance_method, id]
    );

    res.json({ code: '200', message: 'Budgets updated successfully' });
  } catch (error) {
    logger.error('Error updating budget:', error);
    res.status(500).json({ code: '500', message: 'Internal Server Error' });
  }
});

router.post("/convert-to-job/:leadId", auth.authenticateToken, async (req, res) => {
  const leadId = req.params.leadId;
  const userId = req.user.id; // assuming JWT contains user id

  let connection;
  try {
    connection = await pool.getConnection();

    // Ensure the is_shared column on BOTH tables BEFORE the transaction — ALTER
    // is DDL and auto-commits in MySQL, so it must not run inside a transaction.
    await ensureLeadDocShareColumn(connection);
    try {
      await connection.query(
        "ALTER TABLE job_documents ADD COLUMN is_shared TINYINT(1) NOT NULL DEFAULT 0"
      );
    } catch (e) { /* already exists */ }

    // Fetch lead info
    const [leadRows] = await connection.query(
      `SELECT * FROM leads WHERE id = ?`,
      [leadId]
    );
    if (leadRows.length === 0) {
      return res.status(404).json({ message: "Lead not found" });
    }
    const lead = leadRows[0];

    // Atomic: create the job, carry the lead's documents/photos over, and close
    // the lead — so a converted lead KEEPS ALL ITS DATA (or nothing changes).
    await connection.beginTransaction();

    // Insert into Job table (mapping fields + from_leads = 1)
    const [result] = await connection.query(
      `INSERT INTO job 
        (type, name, client_id, address, city, state, zipcode, contract_status, created_by, job_address, job_city, job_state, job_zipcode, from_leads,lead_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)`,
      [
        lead.lead_type || "Residential",  // default if null
        lead.lead_name,
        lead.client_id,
        lead.project_street_address || "",
        lead.project_town || "",
        lead.project_state || "",
        lead.leads_zipcode || "",
        "Not Signed",
        userId,
        lead.leads_street_address || "",
        lead.leads_town_city || "",
        lead.leads_state || "",
        lead.leads_zipcode || "",
        1,  // âœ… Mark as coming from leads
        leadId
      ]
    );

    const newJobId = result.insertId;

    // Carry the lead's documents/photos over to the new job (same file paths,
    // preserving type + the shared-with-subs flag) so plans/photos aren't
    // stranded on the closed lead.
    await connection.query(
      `INSERT INTO job_documents (path, name, job_id, mime_type, created_by, created_at, type, is_shared)
       SELECT path, name, ?, mime_type, created_by, NOW(), type, is_shared
       FROM lead_documents WHERE lead_id = ?`,
      [newJobId, leadId]
    );

    // Update lead status = 3 (closed/converted)
    await connection.query(
      `UPDATE leads SET status = '3', user_id = ? WHERE id = ?`,
      [userId, leadId]
    );

    await connection.commit();
    res.json({ message: "Lead converted to Job successfully", jobId: newJobId });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    logger.error("Error converting lead to job:", error);
    res.status(500).json({ message: "Error converting lead to job", error });
  } finally {
    if (connection) connection.release();
  }
});


// routes/leads.js
router.put("/leads/:id", auth.authenticateToken, async (req, res) => {
  const id = req.params.id;

  const {
    client_id,
    leads_street_address,
    leads_town_city,
    leads_state,
    leads_zipcode,
    project_street_address,
    project_town,
    project_state,
  } = req.body;

  try {
    await pool.query(
      `UPDATE leads SET
        client_id = ?,
        leads_street_address = ?,
        leads_town_city = ?,
        leads_state = ?,
        leads_zipcode = ?,
        project_street_address = ?,
        project_town = ?,
        project_state = ?
      WHERE id = ?`,
      [
        client_id,
        leads_street_address,
        leads_town_city,
        leads_state,
        leads_zipcode,
        project_street_address,
        project_town,
        project_state,
        id,
      ]
    );

    res.json({ message: "Lead updated successfully" });
  } catch (err) {
    logger.error("Failed to update lead:", err);
    res.status(500).json({ error: "Failed to update lead" });
  }
});

// Delete a lead by ID
router.delete("/Delete/:id", auth.authenticateToken, async (req, res) => {
  const leadId = req.params.id;
  const userId = req.user.id; // Get user ID from the authenticated token

  if (!leadId) {
    return res.status(400).json({ message: "Lead ID is required" });
  }
  

  try {
    // First, check if the lead exists and belongs to the user
    const [existingLead] = await pool.query(
      "SELECT id FROM leads WHERE id = ? AND user_id = ?",
      [leadId, userId]
    );

    if (existingLead.length === 0) {
      return res.status(404).json({ message: "Lead not found or access denied" });
    }

    // Delete the lead
    await pool.query("DELETE FROM leads WHERE id = ?", [leadId]);

    // Log the deletion
    logger.info(`Lead ${leadId} deleted by user ${userId}`);
    
    res.json({ message: "Lead deleted successfully" });
  } catch (err) {
    logger.error("Error deleting lead:", err);
    res.status(500).json({ error: "Failed to delete lead" });
  }
});

async function enforcePlanFeatureForJobFileType(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : res.locals.id;
  if (!userId) {
    return res.status(401).json({ code: "UNAUTHORIZED", message: "Unauthorized" });
  }

  const rawType = (req.body && req.body.type) || (req.query && req.query.type) || "";
  const allowedKeys = requiredKeysForJobFileType(rawType);

  let connection;
  try {
    connection = await pool.getConnection();
    const features = await getActivePlanFeatures(connection, userId);

    if (!features.length) {
      return res.status(403).json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Your plan does not include this feature.",
      });
    }

    if (!isAllowedFeature(features, allowedKeys)) {
      return res.status(403).json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Your plan does not include this feature.",
      });
    }

    return next();
  } catch (err) {
    return res.status(500).json({
      code: "BILLING_FEATURES_ERROR",
      message: "Unable to verify plan features.",
    });
  } finally {
    if (connection) connection.release();
  }
}
router.post(
  "/upload-files",
  auth.authenticateToken,
  upload.array("files", 10),
  async (req, res) => {
    const { job_id, file_name, type } = req.body;
    const userId = req.user.id;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      const saved = [];

      for (let file of req.files) {
        const [result] = await connection.query(
          `INSERT INTO lead_documents
            (path, name, lead_id, mime_type, created_by, created_at, type)
           VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
          [
            file.path.split(path.sep).join("/"),
            file_name || file.originalname,
            job_id,
            file.mimetype,
            userId,
            type,
          ]
        );

        saved.push({
          id: result.insertId,
          name: file_name || file.originalname,
          path: file.path,
          type,
        });
      }
      res.status(200).json({
        message: "Files uploaded successfully",
        files: saved,
      });
    } catch (err) {
      logger.error("Error saving file metadata:", err);
      res.status(500).json({ message: "Error saving file metadata" });
    } finally {
      if (connection) connection.release();
    }
  }
);

// Idempotent: add the "shared with subs" flag to lead_documents if missing
// (mirrors ensureDocShareColumn on job_documents). Safe to call per request.
async function ensureLeadDocShareColumn(connection) {
  try {
    await connection.query(
      "ALTER TABLE lead_documents ADD COLUMN is_shared TINYINT(1) NOT NULL DEFAULT 0"
    );
  } catch (e) {
    // Already exists — ignore.
  }
}

router.get("/get-files", auth.authenticateToken, async (req, res) => {
  const { job_id } = req.query;
  let connection;

  try {
    connection = await pool.getConnection();
    await ensureLeadDocShareColumn(connection);

    const [rows] = await connection.execute(
      "SELECT id, path, name, lead_id, type, is_shared FROM lead_documents WHERE lead_id = ?",
      [job_id]
    );

    // ðŸ”´ No filtering by allowDocs / allowPhotos
    // Return all files for this job
    res.json(rows || []);

  } catch (err) {
    logger.error("Error fetching documents:", err);
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// Toggle a lead document's "shared with subs" flag (mirrors the job-file share
// endpoint). Gated by id only, matching the existing lead file endpoints.
router.patch("/lead-file/:id/share", auth.authenticateToken, async (req, res) => {
  const fileId = req.params.id;
  const shared = req.body?.shared ? 1 : 0;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureLeadDocShareColumn(connection);

    const [rows] = await connection.query(
      "SELECT id FROM lead_documents WHERE id = ? LIMIT 1",
      [fileId]
    );
    if (!rows.length) return res.status(404).json({ message: "File not found" });

    await connection.execute("UPDATE lead_documents SET is_shared = ? WHERE id = ?", [shared, fileId]);
    res.json({ success: true, is_shared: shared });
  } catch (err) {
    logger.error("Share lead file error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/delete-file", auth.authenticateToken, async (req, res) => {
  const { job_id, name, type } = req.body;
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      "SELECT id, path FROM lead_documents WHERE lead_id = ? AND name = ? AND type = ?",
      [job_id, name, type]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "File not found" });
    }

    const filePath = rows[0].path;

    // ðŸ”¥ Delete file from uploads folder
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // ðŸ§¹ Delete from DB
    await connection.execute(
      "DELETE FROM lead_documents WHERE id = ?",
      [rows[0].id]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Delete file error:", err);
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;

