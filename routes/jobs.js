const express = require("express");
const router = express.Router();
const auth = require("../services/authentication");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");

const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const { upload } = require("../services/fileUpload");
const { cloneRightsFromInviter } = require("../utils/rights");
const jobSchema = Joi.object({
  type: Joi.string().valid("Residential", "Commercial").required(),
  name: Joi.string().max(100).required(),
  permit_no: Joi.string().allow("", null),
  permit_type: Joi.string().allow("", null),
  gate_no: Joi.string().allow("", null),
  lock_box_code: Joi.string().allow("", null),
  inspector_id: Joi.number().allow(null),
  client_id: Joi.number().allow(null),
  client_email: Joi.string().allow("", null),
  client_mobile: Joi.string().allow('', null),

    client_name: Joi.string().allow("", null),
  address: Joi.string().max(500).allow("", null).optional(),
  city: Joi.string().max(45).allow(null),
  state: Joi.string().allow("", null),
  zipcode: Joi.string().allow("", null),
  contract_status: Joi.string().allow("", null),
  copy: Joi.allow("", null),
  job_address: Joi.string().allow(null, ''),
  job_city: Joi.string().allow(null, ''),
  job_state: Joi.string().allow(null, ''),
  job_zipcode: Joi.string().allow(null, ''),
  sameAsAddress: Joi.optional(),
  created_by: Joi.number().allow(null),
  updated_by: Joi.number().allow(null),
});

const stageSchema = Joi.object({
  name: Joi.string().max(255).allow(null, ""),
  csi_code: Joi.string().max(150).allow(null, ""),
  status: Joi.number().valid(0, 1).default(1),
  progress_status: Joi.number().min(0).default(0),
  job_id: Joi.number().integer().required(),
});

const inviteSchema = Joi.object({
  client_name: Joi.string().required(),
  client_email: Joi.string().email().required(),
  user_type: Joi.string().valid("client", "subcontractor").required(),
  client_mobile: Joi.string().allow(null, ""),
  client_phone: Joi.string().allow(null, ""),
  business_name: Joi.string().allow(null, ""),
  trade: Joi.string().allow(null, ""),
  subcategory: Joi.number().integer().allow(null),
  job_id: Joi.number().integer().allow(null),
}).custom((obj, helpers) => {
  if (obj.user_type === 'subcontractor') {
    if (!obj.subcategory) {
      return helpers.message('subcategory is required for subcontractor');
    }
  }
  return obj;
});

function generateOTP() {
  const digits = "0123456789";
  let OTP = "";
  for (let i = 0; i < 4; i++) {
    OTP += digits[Math.floor(Math.random() * 10)];
  }
  return OTP;
}

const materialSchema = Joi.object({
  job_id: Joi.number().integer().required(),
  item_type: Joi.string().max(45).allow(null, ""),
  room: Joi.string().max(45).allow(null, ""),
  material: Joi.string().max(45).allow(null, ""),
  manufacturer: Joi.string().max(45).allow(null, ""),
  size: Joi.string().max(45).allow(null, ""),
  color: Joi.string().max(45).allow(null, ""),
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true, // true if using port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // allow self-signed certs if needed
  },
});

// Optional: verify transporter
transporter.verify((err, success) => {
  if (err) {
    logger.error("SMTP connection failed:", err);
  } else {
    logger.info("SMTP server is ready to send emails");
  }
});

// ---- /send-invite helpers ----------------------------------------------

async function assertUniqueEmail(connection, email) {
  const [rows] = await connection.query(
    "SELECT id FROM user WHERE email = ? LIMIT 1",
    [email],
  );
  if (rows.length > 0) {
    const err = new Error("Email already exists");
    err.status = 400;
    throw err;
  }
}

async function assertUniqueMobile(connection, mobile) {
  if (!mobile) return;
  const [rows] = await connection.query(
    "SELECT id FROM user WHERE mobile = ? LIMIT 1",
    [mobile],
  );
  if (rows.length > 0) {
    const err = new Error("Phone number already exists");
    err.status = 400;
    throw err;
  }
}

async function createInvitedUser(connection, params) {
  const {
    client_name,
    client_email,
    clientMobile,
    user_type,
    business_name,
    trade,
    subcategory,
    createdBy,
    currentTimestamp,
  } = params;
  const isClient = user_type === "client";
  const role = isClient ? 3 : Number(subcategory);
  const category = isClient ? 3 : 2;
  const sub = isClient ? 11 : 12;
  const business = isClient ? "" : (business_name || "");
  const tradeVal = isClient ? "" : (trade || "");
  const mobileVal = clientMobile && String(clientMobile).trim() !== "" ? clientMobile : null;

  const [insertResult] = await connection.query(
    `
    INSERT INTO user
    (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      client_name,
      client_email,
      "",
      role,
      mobileVal,
      category,
      sub,
      business,
      tradeVal,
      generateOTP(),
      1,
      currentTimestamp,
      "",
      0,
      "",
      createdBy,
      0,
    ],
  );
  const newUserId = insertResult?.insertId ?? null;

  // Inherit rights from the inviter so the new client/subcontractor can
  // immediately use the same parts of the app the inviter has access to.
  // Subcontractors who later subscribe to a plan will have these wiped and
  // replaced by `syncSubcontractorRole12Rights`.
  if (newUserId && createdBy) {
    try {
      await cloneRightsFromInviter(connection, {
        inviterId: createdBy,
        newUserId,
        newUserRoleId: role,
      });
    } catch (cloneErr) {
      // Don't fail the invite if rights cloning hits an issue — just log.
      logger.error("cloneRightsFromInviter failed:", cloneErr);
    }
  }

  return newUserId;
}

async function recordInvitedContact(connection, { client_name, client_email, currentTimestamp, createdBy }) {
  const [existing] = await connection.query(
    "SELECT id FROM invited_contacts WHERE email = ? LIMIT 1",
    [client_email],
  );
  if (existing.length > 0) return true; // already recorded

  await connection.query(
    `
    INSERT INTO invited_contacts (name, email, status, created_at, created_by)
    VALUES (?, ?, 1, ?, ?)
    `,
    [client_name, client_email, currentTimestamp, createdBy],
  );
  return false;
}

// Mirror what /invitations/sync-invites does: insert an accepted contact
// link between the inviter and the newly created user so the invited user
// immediately shows up in endpoints that require an accepted contact
// relationship (e.g. /get_client).
async function linkContact(connection, requestBy, requestTo) {
  if (!requestBy || !requestTo) return;
  await connection.query(
    `
    INSERT IGNORE INTO contact (request_by, request_to, status, created_at, updated_at)
    VALUES (?, ?, 'Accept', NOW(), NOW())
    `,
    [requestBy, requestTo],
  );
}

// Ensure a typed-in job client exists as a user and shows in the creator's
// contacts as 'Saved' (not invited). Dedupes by email when present, else by
// name among this creator's email-less clients.
// Returns { id, linkedNow } or null.
async function ensureClientContact(connection, { createdBy, name, email, mobile }) {
  const cleanEmail = String(email || "").trim();
  const cleanName = String(name || "").trim();
  if (!createdBy || (!cleanEmail && !cleanName)) return null;

  let clientUserId = null;
  if (cleanEmail) {
    const [[existing]] = await connection.query(
      "SELECT id FROM user WHERE email = ? LIMIT 1",
      [cleanEmail]
    );
    clientUserId = existing ? existing.id : null;
  } else {
    const [[existing]] = await connection.query(
      `SELECT id FROM user
       WHERE name = ? AND created_by = ? AND (email IS NULL OR email = '')
       LIMIT 1`,
      [cleanName, createdBy]
    );
    clientUserId = existing ? existing.id : null;
  }

  if (!clientUserId) {
    const [ins] = await connection.query(
      `INSERT INTO user
       (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
       VALUES (?, ?, '', 3, ?, 3, 11, '', '', '', 1, ?, '', 0, '', ?, 0)`,
      [cleanName || cleanEmail, cleanEmail || null, mobile || null, getTimeStamp(), createdBy]
    );
    clientUserId = ins.insertId;
  } else if (mobile) {
    await connection.query(
      `UPDATE user SET mobile = IF(mobile IS NULL OR mobile = '', ?, mobile) WHERE id = ?`,
      [mobile, clientUserId]
    );
  }
  if (!clientUserId || Number(clientUserId) === Number(createdBy)) {
    return clientUserId ? { id: clientUserId, linkedNow: false } : null;
  }

  const [[link]] = await connection.query(
    `SELECT id FROM contact
     WHERE (request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?)
     LIMIT 1`,
    [createdBy, clientUserId, clientUserId, createdBy]
  );
  let linkedNow = false;
  if (!link) {
    await connection.query(
      `INSERT INTO contact (request_by, request_to, status, created_at, updated_at)
       VALUES (?, ?, 'Saved', NOW(), NOW())`,
      [createdBy, clientUserId]
    );
    linkedNow = true;
  }
  return { id: clientUserId, linkedNow };
}

// ---- /send-invite route ------------------------------------------------

router.post("/send-invite", auth.authenticateToken, async (req, res) => {
  const { error, value } = inviteSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const role = Number(req.user?.role);
  if (role === 12) {
    return res.status(403).json({ message: "You are not allowed to create invitations." });
  }

  const {
    client_name,
    client_email,
    client_mobile,
    client_phone,
    user_type,
    business_name,
    trade,
    subcategory,
  } = value;
  const clientMobile = (client_mobile || client_phone || "").toString().trim();
  const maybeJobId = Number(req.body?.job_id) || null;
  const createdBy = req.user.id;

  let connection;
  try {
    connection = await pool.getConnection();
    const currentTimestamp = getTimeStamp();

    // Duplicate checks (throw tagged errors handled below)
    await assertUniqueEmail(connection, client_email);
    await assertUniqueMobile(connection, clientMobile);

    // Create user
    const invitedUserId = await createInvitedUser(connection, {
      client_name,
      client_email,
      clientMobile,
      user_type,
      business_name,
      trade,
      subcategory,
      createdBy,
      currentTimestamp,
    });

    // Link to job (if applicable)
    if (invitedUserId && maybeJobId) {
      await connection.query("UPDATE job SET client_id = ? WHERE id = ?", [
        invitedUserId,
        maybeJobId,
      ]);
    }

    // Create accepted contact relationship so the invited user shows up in

    await linkContact(connection, createdBy, invitedUserId);

    // Record invite + send email
    const alreadyExists = await recordInvitedContact(connection, {
      client_name,
      client_email,
      currentTimestamp,
      createdBy,
    });
    await sendInviteEmail(client_email, client_name);

    return res.json({
      message: alreadyExists
        ? "Invite email sent again. Record already exists."
        : "Invite email sent and record saved successfully!",
      alreadyExists,
      client_id: invitedUserId,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    logger.error("Failed to send invite:", err);
    return res.status(500).json({
      message: "Failed to send invite",
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
    });
  } finally {
    if (connection) connection.release();
  }
});

async function sendInviteEmail(toEmail, inviterName) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`, // Sender name + email
    to: toEmail,
    subject: "Invitation to Join SeeJobRun",
    text: `Mr. ${inviterName} You are invited to join SeeJobRun. Please sign up and accept the invitation at: https://seejobrun.com/signup`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Invitation to Join SeeJobRun</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .logo-container { text-align: center; padding: 20px 0; }
            .logo { max-width: 150px; height: auto; }
            .header { background-color: #2196F3; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; }
            .invite-box { background-color: #e3f2fd; padding: 15px; text-align: center; font-size: 18px; font-weight: bold; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #777; font-size: 14px; }
            .signup-link { display: inline-block; padding: 10px 20px; background-color: #2196F3; color: white!important; text-decoration: none; border-radius: 4px; margin: 15px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo-container">
              <img src="http://seejobrun.com/user-dashboard/assets/seeJobRun.png" alt="SeeJobRun Logo" class="logo">
            </div>
            <div class="header">
              <h1>You're Invited!</h1>
            </div>
            <div class="content">
              <h2>Join SeeJobRun</h2>
              <p>Hello,</p>
              <p><strong>Mr. ${inviterName}</strong> You are invited to join <strong>SeeJobRun</strong>.</p>
              <div class="invite-box">Accept the invitation and sign up today!</div>
              <a href="http://seejobrun.com/user-dashboard/signup" class="signup-link">Accept Invitation</a>
              <p>If you weren’t expecting this invitation, you may ignore this email.</p>
            </div>
            <div class="footer">
              <p>&copy; 2025 SeeJobRun. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info("Invitation email sent successfully!");
  } catch (error) {
    logger.error("Error sending invitation email:", error);
  }
}

// update jon order for drag and drops
router.put("/update-job-order", async (req, res) => {
  const order = req.body.order;
  if (!order || !Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  let caseSql = "CASE id ";
  const ids = [];

  for (const o of order) {
    const jobId = parseInt(o.job_id, 10);
    const sortOrder = parseInt(o.order, 10);
    if (isNaN(jobId) || isNaN(sortOrder)) {
      return res.status(400).json({ success: false, message: "Invalid job_id or order value" });
    }
    caseSql += `WHEN ${jobId} THEN ${sortOrder} `;
    ids.push(jobId);
  }

  caseSql += "END";

  const query = `
    UPDATE job
    SET sort_order = ${caseSql}
    WHERE id IN (${ids.join(",")})
  `;

  try {
    await pool.query(query);
    res.json({ success: true, message: "Job order updated successfully" });
  } catch (err) {
    logger.error("Error updating job order:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET - Unified list of Jobs + Leads for Schedule Work dropdown
router.get("/job-lead-options", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const loggedInUserId = req.user.id;

    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : null;

    // Determine manager for this user (mirror /all-tasks behavior)
    const [userRows] = await connection.query(
      "SELECT created_by FROM user WHERE id = ?",
      [loggedInUserId]
    );

    const managerId = effectiveCreatorId
      ? effectiveCreatorId
      : userRows.length && userRows[0].created_by
        ? userRows[0].created_by
        : loggedInUserId;

    // Jobs accessible by this user (same rule as /jobs)
    const [jobs] = await connection.execute(
      `
        SELECT
          j.id,
          j.name,
          j.address,
          j.city,
          j.state,
          j.zipcode,
          j.contract_status,
          j.type,
          j.status
        FROM job j
        WHERE
          (
            j.created_by = ?
            OR j.id IN (
              SELECT job_id
              FROM job_contacts
              WHERE contact_id IN (?, ?)
            )
            OR j.id IN (
              SELECT DISTINCT job_id
              FROM tasks
              WHERE user_id = ? OR created_by = ?
            )
          )
        ORDER BY j.sort_order ASC, j.id ASC
      `,
      [managerId, loggedInUserId, managerId, loggedInUserId, managerId]
    );

    // Leads for this manager
    const [leads] = await connection.query(
      `
        SELECT
          l.id,
          l.lead_name,
          l.lead_type,
          l.status,
          l.project_street_address,
          l.project_town,
          l.project_state,
          l.leads_zipcode
        FROM leads l
        WHERE l.user_id = ?
          AND (l.status IS NULL OR l.status <> '3')
        ORDER BY l.created_at DESC
      `,
      [managerId]
    );

    const normalize = (v) => (v == null ? "" : String(v)).trim();

    const out = [];

    for (const j of jobs || []) {
      out.push({
        kind: "job",
        id: Number(j.id),
        name: normalize(j.name),
        type: normalize(j.type),
        status: j.status,
        contract_status: normalize(j.contract_status),
        address: normalize(j.address),
        city: normalize(j.city),
        state: normalize(j.state),
        zipcode: normalize(j.zipcode),
      });
    }

    for (const l of leads || []) {
      out.push({
        kind: "lead",
        id: Number(l.id),
        name: normalize(l.lead_name),
        type: normalize(l.lead_type),
        status: l.status,
        contract_status: "Lead",
        address: normalize(l.project_street_address),
        city: normalize(l.project_town),
        state: normalize(l.project_state),
        zipcode: normalize(l.leads_zipcode),
      });
    }

    out.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/jobs", auth.authenticateToken, async (req, res) => {
 
  const { error, value } = jobSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: error.details[0].message,
    });
  }
  //const { error, value } = req.body;
  let connection;
  const {
  type,
  name,
  permit_no,
  permit_type,
  gate_no,
  lock_box_code,
  inspector_id,
  client_id,
  client_email,
  client_mobile,
  client_name,
  address,
  city,
  state,
  zipcode,
  job_address,
  job_city,
  job_state,
  job_zipcode,
  sameAsAddress,
  contract_status,
  created_by,
} = value;

 const safeValues = [
  type,
  name,
  permit_no ?? null,
  permit_type ?? null,
  gate_no ?? null,
  lock_box_code ?? null,
  inspector_id ?? null,
  client_id ?? null,
  client_email ?? null,
  client_mobile ?? null, // FIX
  client_name ?? null,
  address ?? null,
  city,
  state ?? null,
  zipcode ?? null,
  job_address ?? null,
  job_city ?? null,
  job_state ?? null,
  job_zipcode ?? null,
  sameAsAddress ? 1 : 0,
  contract_status,
  1, // status
  created_by,
];

  try {
    connection = await pool.getConnection();

const [result] = await connection.execute(
  `INSERT INTO job (
    type, name, permit_no, permit_type, gate_no, lock_box_code,
    inspector_id, client_id, additional_client_email, additional_client_mobile, additional_client_name,
    address, city, state, zipcode,

    job_address, job_city, job_state, job_zipcode,

    -- ✅ NEW COLUMN
    sameAsAddress,

    contract_status, status, created_by
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  safeValues
);

    // Typed-in client info becomes a Saved contact automatically
    try {
      const clientContact = await ensureClientContact(connection, {
        createdBy: created_by,
        name: client_name,
        email: client_email,
        mobile: client_mobile,
      });
      if (clientContact && !client_id) {
        await connection.query("UPDATE job SET client_id = ? WHERE id = ?", [
          clientContact.id,
          result.insertId,
        ]);
      }
    } catch (contactErr) {
      logger.error("Auto client contact failed on job create:", contactErr);
    }

    res.status(201).json({
      // ✅ use 201 here
      code: "JOB_CREATED",
      message: "Job created successfully!",
      job_id: result.insertId,
    });
  } catch (err) {
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// Deploy marker: lets tooling confirm which sweep version is live
router.get("/client-sync-version", (req, res) => res.json({ v: 5 }));

// One-time/idempotent sweep: pull clients typed into existing jobs into the
// creator's contacts as 'Saved'. Safe to call repeatedly.
router.post("/sync-job-clients", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  let connection;
  try {
    connection = await pool.getConnection();

    // Same visibility rule as GET /jobs: employees inherit their creator's jobs
    const [userRows] = await connection.query(
      "SELECT created_by FROM user WHERE id = ?",
      [userId]
    );
    const managerId =
      userRows.length && userRows[0].created_by ? userRows[0].created_by : userId;

    const [jobs] = await connection.query(
      `SELECT id, client_id,
              additional_client_name AS name,
              additional_client_email AS email,
              additional_client_mobile AS mobile
       FROM job
       WHERE created_by IN (?, ?)
         AND additional_client_email IS NOT NULL
         AND additional_client_email != ''`,
      [userId, managerId]
    );

    let linked = 0;
    for (const j of jobs) {
      const clientContact = await ensureClientContact(connection, {
        createdBy: userId,
        name: j.name,
        email: j.email,
        mobile: j.mobile,
      });
      if (clientContact) {
        if (clientContact.linkedNow) linked++;
        if (!j.client_id) {
          await connection.query("UPDATE job SET client_id = ? WHERE id = ?", [
            clientContact.id,
            j.id,
          ]);
        }
      }
    }

    // Jobs whose client is a picked user (client_id) with no contact link yet
    const [idJobs] = await connection.query(
      `SELECT DISTINCT j.client_id
       FROM job j
       JOIN user u ON u.id = j.client_id
       WHERE j.created_by IN (?, ?)
         AND j.client_id IS NOT NULL AND j.client_id != 0 AND j.client_id != ?`,
      [userId, managerId, userId]
    );
    for (const row of idJobs) {
      const [[link]] = await connection.query(
        `SELECT id FROM contact
         WHERE (request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?)
         LIMIT 1`,
        [userId, row.client_id, row.client_id, userId]
      );
      if (!link) {
        await connection.query(
          `INSERT INTO contact (request_by, request_to, status, created_at, updated_at)
           VALUES (?, ?, 'Saved', NOW(), NOW())`,
          [userId, row.client_id]
        );
        linked++;
      }
    }

    // Jobs with only a client name — import as email-less Saved contacts
    // and link each job to its client (job.client_id)
    const [nameOnlyJobs] = await connection.query(
      `SELECT id, additional_client_name AS name,
              additional_client_mobile AS mobile
       FROM job
       WHERE created_by IN (?, ?)
         AND (additional_client_email IS NULL OR additional_client_email = '')
         AND (client_id IS NULL OR client_id = 0)
         AND additional_client_name IS NOT NULL AND additional_client_name != ''`,
      [userId, managerId]
    );

    const failed = [];
    let firstError = null;
    for (const j of nameOnlyJobs) {
      try {
        const clientContact = await ensureClientContact(connection, {
          createdBy: userId,
          name: j.name,
          email: null,
          mobile: j.mobile,
        });
        if (clientContact) {
          if (clientContact.linkedNow) linked++;
          await connection.query("UPDATE job SET client_id = ? WHERE id = ?", [
            clientContact.id,
            j.id,
          ]);
        } else {
          failed.push(j.name);
        }
      } catch (rowErr) {
        logger.error(`sync-job-clients failed for "${j.name}":`, rowErr);
        if (!firstError) firstError = rowErr.message;
        failed.push(j.name);
      }
    }
    const nameOnly = nameOnlyJobs;

    const [[jobCount]] = await connection.query(
      `SELECT COUNT(*) AS total FROM job WHERE created_by IN (?, ?)`,
      [userId, managerId]
    );

    res.json({
      total_jobs: jobCount.total,
      with_client_email: jobs.length,
      with_picked_client: idJobs.length,
      name_only: nameOnly.length,
      linked,
      skipped: failed,
      first_error: firstError,
    });
  } catch (err) {
    logger.error("sync-job-clients error:", err);
    res.status(500).json({ message: "Failed to sync job clients", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// GET - All jobs
router.get("/jobs", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const userId = req.user.id; // from JWT token

    // Employees should inherit visibility of their GC/creator.
    const [userRows] = await connection.query(
      "SELECT created_by FROM user WHERE id = ?",
      [userId],
    );
    const managerId =
      userRows.length && userRows[0].created_by
        ? userRows[0].created_by
        : userId;

    const [rows] = await connection.execute(
      `
        SELECT 
          j.*,
          -- Prefer real client details from user table
          u.name  AS client_name,
          u.email AS client_email,
          u.mobile AS client_mobile,
          u.street AS client_street,
          u.city   AS client_city,
          u.state  AS client_state,
          u.zipcode AS client_zipcode,

          -- Fallback display values when no linked client exists
          COALESCE(u.name, j.additional_client_name)   AS client_name_display,
          COALESCE(u.email, j.additional_client_email) AS client_email_display,
          COALESCE(u.mobile, j.additional_client_mobile) AS client_mobile_display,

          -- Inspector details
          u2.name  AS inspector_name,
          u2.mobile AS inspector_mobile,
          u2.email AS inspector_email,
          u2.city  AS inspector_city,
          u2.website_link AS inspector_website,

          -- Who added the contact to the job (if any)
          jc.user_id AS added_by_user_id,
          u3.name   AS added_by_user_name

        FROM job j
        LEFT JOIN user u  ON u.id = j.client_id
        LEFT JOIN user u2 ON u2.id = j.inspector_id

        -- Join job_contacts to find who added contact
        LEFT JOIN job_contacts jc ON jc.job_id = j.id AND jc.contact_id IN (?, ?) 

        -- Join user table again to get added user's name
        LEFT JOIN user u3 ON u3.id = jc.user_id

        WHERE 
          (
            j.created_by = ? 
            OR j.id IN (
              SELECT job_id 
              FROM job_contacts 
              WHERE contact_id IN (?, ?)
            )
            OR j.id IN (
              SELECT DISTINCT job_id
              FROM tasks
              WHERE user_id = ? OR created_by = ?
            )
          )
        ORDER BY j.id ASC;
      `,
      [
        userId,
        managerId,
        managerId,
        userId,
        managerId,
        userId,
        managerId,
      ],
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.get("/get_client", auth.authenticateToken, async (req, res) => {
  const loggedInUserId = req.user.id;
  //console.log(loggedInUserId);
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
    u.id,
    u.name,
    u.mobile,
    u.email
FROM contact c
JOIN user u 
    ON u.id = (
        CASE 
            WHEN c.request_by = ? THEN c.request_to
            ELSE c.request_by
        END
    )
WHERE 
    (c.request_by = ? OR c.request_to = ?)
    AND c.status = 'Accept' AND u.category = 3;
      `,
      [loggedInUserId, loggedInUserId, loggedInUserId]
    );

    res.json(rows);

  } catch (error) {
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get(
  "/get_clients_with_job/:job_id",
  auth.authenticateToken,
  async (req, res) => {
    const loggedInUserId = req.user.id;
    const { job_id } = req.params;
    let connection;

    try {
      connection = await pool.getConnection();

      const query = `
        (
          -- 1️⃣ All registered clients (category = 3)
          SELECT 
            u.id,
            u.name,
            u.email,
            u.mobile,
            'registered' AS source
          FROM user u
          WHERE u.category = 3
        )

        UNION ALL

        (
          -- 2️⃣ Additional client from job table
          SELECT
            j.id AS id,
            j.additional_client_name AS name,
            j.additional_client_email AS email,
            j.additional_client_mobile AS mobile,
            'job' AS source
          FROM job j
          WHERE j.id = ?
            AND j.additional_client_name IS NOT NULL
        )
      `;

      const [rows] = await connection.query(query, [
        job_id,
      ]);

      res.status(200).json({
        code: "200",
        message: "Clients fetched successfully",
        data: rows,
      });
    } catch (error) {
      logger.error("Get clients with job error:", error);
      res.status(500).json({
        code: "500",
        message: "Internal server error",
        data: [],
      });
    } finally {
      if (connection) connection.release();
    }
  }
);


//get inspectors
router.get("/get_inspectors", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT * FROM user where subcategory = 13 ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Get single client by ID
router.get("/get_client/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  const clientId = req.params.id;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT * FROM user WHERE category = 3 AND id = ?`,
      [clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Client not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Get single inspector by ID
router.get("/get_inspector/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  const inspectorId = req.params.id;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT * FROM user WHERE subcategory = 13 AND id = ?`,
      [inspectorId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Inspector not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Add Job Stage API
router.post(
  "/add_job_stage",
  auth.authenticateToken,
  auth.authenticateToken,
  async (req, res) => {
    const { name, job_id, csi_code, template_id } = req.body;
    const user_id = req.user.id; // this comes from the JWT middleware
    //console.log(user);
    if (!name || !job_id || !csi_code) {
      return res
        .status(400)
        .json({ message: "name, job_id, and csi_code are required." });
    }

    let connection;

    try {
      connection = await pool.getConnection();

      await connection.beginTransaction();

      // Insert into stages table
      const [stageResult] = await connection.execute(
        `INSERT INTO stages (user_id, name, csi_code, status) VALUES (?, ?, ?, ?)`,
        [user_id, name, csi_code, 1]
      );

      const stage_id = stageResult.insertId;

      // Insert into jobstages table
      const [jobStageResult] = await connection.execute(
        `INSERT INTO jobstages (user_id, job_id, stage_id, template_id) VALUES (?, ?, ?, ?)`,
        [user_id, job_id, stage_id, template_id || 0]
      );

      await connection.commit();

      res.json({
        success: true,
        message: "Your job Stage has been Saved Successfully.",
        stage_id: stage_id,
        jobstage_id: jobStageResult.insertId,
      });
    } catch (err) {
      if (connection) {
        try { await connection.rollback(); } catch (_) {}
      }
      res.status(500).json({ success: false, message: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.put("/jobs/:id", auth.authenticateToken, async (req, res) => {
  const jobId = req.params.id;

  const { error, value } = jobSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: error.details[0].message,
    });
  }

  const {
    type,
    name,
    permit_no,
    gate_no,
    lock_box_code,
    inspector_id,
    client_id,
    client_email,
    client_mobile,
    client_name,
    address,
    city,
    state,
    zipcode,
    contract_status,
    updated_by,
  } = value;

  const safeValues = [
    type,
    name,
    permit_no ?? null,
    gate_no ?? null,
    lock_box_code ?? null,
    inspector_id ?? null,
    client_id ?? null,
    client_email ?? null,
    client_mobile ?? null,
    client_name ?? null,
    address ?? null,
    city ?? null,
    state ?? null,
    zipcode ?? null,
    contract_status,
    updated_by,
    jobId,
  ];

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `UPDATE job SET
        type = ?, name = ?, permit_no = ?, gate_no = ?, lock_box_code = ?, 
        inspector_id = ?, client_id = ?, additional_client_email = ?,
        additional_client_mobile = ?, additional_client_name = ?, address = ?, city = ?, state = ?, 
        zipcode = ?, contract_status = ?, updated_by = ?
      WHERE id = ?`,
      safeValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: "NOT_FOUND",
        message: "Job not found",
      });
    }

    res.status(201).json({
      code: "JOB_UPDATED",
      message: "Job updated successfully!",
    });
  } catch (err) {
    logger.error("Error updating job:", err);
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.patch("/jobs/:id/status", auth.authenticateToken, async (req, res) => {
  const jobId = req.params.id;

  const { status } = req.body; // expecting status = 0 (completed) or 2 (archived)
  const updatedBy = req.user.id;

  if (![0, 2, 1].includes(status)) {
    return res.status(400).json({ message: "Invalid status value" });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `UPDATE job SET status = ?, updated_by = ? WHERE id = ?`,
      [status, updatedBy, jobId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.json({ message: "Job status updated successfully" });
  } catch (err) {
    logger.error("Error updating job status:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/stages", auth.authenticateToken, async (req, res) => {
 
  const signedin_user = res.locals.id;
  const currentTimestamp = getTimeStamp();

  const { error, value } = stageSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { name, csi_code, status, progress_status, job_id } = value;

  let connection;

  try {
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `INSERT INTO stages (user_id, name, csi_code, job_id, status, progress_status, created_at)
       VALUES (?, ?, ?,?, ?, ?, ?)`,
      [signedin_user, name || null, csi_code || null, job_id, status, 0, currentTimestamp]
    );

    res.json({
      message: "Stage inserted successfully",
      stage_id: result.insertId,
    });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});
router.get("/stages/:job_id", auth.authenticateToken, async (req, res) => {
  const job_id = req.params.job_id;

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      "SELECT * FROM stages WHERE status = 1 AND job_id In (?)",
      [job_id]
    );

    res.json(rows);
  } catch (err) {
    logger.error("Error fetching submitted stages:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put("/stages/:id", auth.authenticateToken, async (req, res) => {
  const stageId = req.params.id;


  const { error, value } = stageSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { user_id, name, csi_code, status, progress_status } = value;

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `UPDATE stages SET user_id = ?, name = ?, csi_code = ?, status = ?, progress_status = ?, updated_at = NOW()
       WHERE id = ?`,
      [1, name, csi_code, status, progress_status, stageId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Stage not found" });
    }

    res.json({ message: "Stage updated successfully" });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.post("/send-invite/:jobId", auth.authenticateToken, async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) {
    return res.status(400).json({ message: "jobId is required" });
  }

  const { error, value } = inviteSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { client_name, client_email, user_type, business_name, trade, subcategory } = value;
  const userId = req.user.id;
  const role = Number(req.user?.role);

  if (role === 12) {
    return res.status(403).json({
      message: "You are not allowed to create invitations.",
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    const currentTimestamp = getTimeStamp();

    // Find existing user (or create a new one)
    const [existingUser] = await connection.query(
      "SELECT id FROM user WHERE email = ? LIMIT 1",
      [client_email],
    );

    let invitedUserId = existingUser.length ? existingUser[0].id : null;
    const newUserRole = user_type === "client" ? 3 : Number(subcategory);
    const newUserCategory = user_type === "client" ? 3 : 2;
    const newUserSubcategory = user_type === "client" ? 11 : 12;

    if (!invitedUserId) {
      try {
        const otp = generateOTP();
        const [insertResult] = await connection.query(
          `
          INSERT INTO user 
          (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            client_name,
            client_email,
            "",
            newUserRole,
            null,
            newUserCategory,
            newUserSubcategory,
            user_type === "client" ? "" : (business_name || ""),
            user_type === "client" ? "" : (trade || ""),
            otp,
            1,
            currentTimestamp,
            "",
            0,
            "",
            userId,
            0,
          ],
        );
        invitedUserId = insertResult?.insertId;
      } catch (createUserErr) {
        if (createUserErr.code !== "ER_DUP_ENTRY") {
          logger.error("Failed to create user during invite:", createUserErr);
          return res.status(500).json({
            message: "Failed to register invited user",
            error: createUserErr.message,
          });
        }

        const [raceUser] = await connection.query(
          "SELECT id FROM user WHERE email = ? LIMIT 1",
          [client_email],
        );
        invitedUserId = raceUser.length ? raceUser[0].id : null;
      }

      // Inherit rights from the inviter for newly created users only.
   
      if (invitedUserId) {
        try {
          await cloneRightsFromInviter(connection, {
            inviterId: userId,
            newUserId: invitedUserId,
            newUserRoleId: newUserRole,
          });
        } catch (cloneErr) {
          logger.error("cloneRightsFromInviter failed:", cloneErr);
        }
      }
    }

    if (invitedUserId) {
      await connection.query("UPDATE job SET client_id = ? WHERE id = ?", [
        invitedUserId,
        jobId,
      ]);
    }

    // 🔍 Existing check in invited_contacts
    const [existingInvite] = await connection.query(
      `SELECT id FROM invited_contacts WHERE email = ? LIMIT 1`,
      [client_email]
    );

    // 📧 Always send email (even if already invited)
    await sendInviteEmail(client_email, client_name);

    // 🟡 If already invited → do NOT insert again
    if (existingInvite.length > 0) {
      return res.json({
        message: "Invite email sent again. Record already exists.",
        alreadyExists: true,
        client_id: invitedUserId,
      });
    }

    // ✅ Insert new invite
    await connection.query(
      `
      INSERT INTO invited_contacts (name, email, status, created_at, created_by)
      VALUES (?, ?, 0, ?, ?)
      `,
      [client_name, client_email, currentTimestamp, userId]
    );

    res.json({
      message: "Invite email sent and record saved successfully!",
      alreadyExists: false,
      client_id: invitedUserId,
    });

  } catch (err) {
    // 🛡️ Race-condition protection
    if (err.code === "ER_DUP_ENTRY") {
      await sendInviteEmail(client_email, client_name);
      return res.json({
        message: "Invite email sent again. Record already exists.",
        alreadyExists: true,
      });
    }

    logger.error("Failed to send invite:", err);
    res.status(500).json({
      message: "Failed to send invite",
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/jobs_general/:id", auth.authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  let connection;

  try {
    connection = await pool.getConnection();
    const query = `
      SELECT 
        j.*, 
        u.name AS client_name, u.email AS client_email, u.mobile AS client_mobile, u.street AS client_address,
        ins.name AS inspector_name, ins.email AS inspector_email, ins.mobile AS inspector_mobile
      FROM job j
      LEFT JOIN user u ON j.client_id = u.id
      LEFT JOIN user ins ON j.inspector_id = ins.id
      WHERE j.id = ?
    `;
    const [rows] = await connection.query(query, [jobId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    res
      .status(200)
      .json({ message: "Job fetched successfully", data: rows[0] });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ message: "Database error", error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/add-job-address/:id",
  auth.authenticateToken,
  async (req, res) => {
    const {
      client_id,
      client_address,
      client_city,
      client_state,
      client_zipcode,
      job_address,
      job_city,
      job_state,
      job_zipcode,
      gate_code,
      lock_box_code,
      contract_status,
      additional_client_name,
      additional_client_email,
      additional_client_mobile,
      updated_by,
    } = req.body;

    const jobId = req.params.id;

    let connection;
    try {
      connection = await pool.getConnection();
      const query = `
            UPDATE job
            SET client_id = ?, 
                address = ?, city = ?, state = ?, zipcode = ?,
                job_address = ?, job_city = ?, job_state = ?, job_zipcode = ?,
                gate_no = ?,lock_box_code =?, contract_status = ?,
                additional_client_name =?, additional_client_email =?, additional_client_mobile =?,
                updated_by = ?
            WHERE id = ?
        `;
      await connection.query(query, [
        client_id,
        client_address,
        client_city,
        client_state,
        client_zipcode,
        job_address,
        job_city,
        job_state,
        job_zipcode,
        gate_code,
        lock_box_code,
        contract_status,
        additional_client_name,
      additional_client_email,
      additional_client_mobile,
        updated_by,
        jobId,
      ]);
      res.status(200).json({ message: "Job address added successfully" });
    } catch (err) {
      logger.error("Error adding job address:", err);
      res.status(500).json({ message: "Error adding job address" });
    } finally {
      if (connection) connection.release();
    }
  }
);

// Bulk fetch for Task Manager: jobs, leads, and their tasks for the authenticated user
router.get("/all-tasks", auth.authenticateToken, async (req, res) => {
  const loggedInUserId = req.user.id;
  let connection;

  try {
    connection = await pool.getConnection();

    // Determine manager for this user 
    const [userRows] = await connection.query(
      "SELECT created_by FROM user WHERE id = ?",
      [loggedInUserId]
    );

    const managerId =
      userRows.length && userRows[0].created_by
        ? userRows[0].created_by
        : loggedInUserId;


    const [jobs] = await connection.query(
      `SELECT
         j.id,
         j.name,
         j.job_address AS address,
         j.status,
         j.created_by,
         uj.name AS created_by_name
       FROM job j
       LEFT JOIN user uj ON uj.id = j.created_by
       LEFT JOIN job_contacts jc ON jc.job_id = j.id AND jc.contact_id = ?
       WHERE
         (
           j.created_by = ?
           OR j.created_by = ?
           OR j.id IN (
             SELECT job_id
             FROM job_contacts
             WHERE contact_id = ?
           )
           OR j.id IN (
             SELECT DISTINCT job_id
             FROM tasks
             WHERE user_id = ? OR created_by = ?
           )
           OR j.id IN (
             -- Jobs that have any task assigned to a team the user belongs to
             SELECT DISTINCT t.job_id
             FROM tasks t
             JOIN team_user tu ON tu.team_id = t.team_id
             WHERE t.team_id IS NOT NULL AND tu.user_id = ?
           )
         )
         AND j.status = 1
       ORDER BY j.sort_order ASC, j.id ASC`,
      [loggedInUserId, managerId, loggedInUserId, loggedInUserId, loggedInUserId, loggedInUserId, loggedInUserId]
    );

    const [leads] = await connection.query(
      `SELECT l.id, l.lead_name, l.project_street_address, l.status, l.user_id AS created_by, u.name AS created_by_name
       FROM leads l
       LEFT JOIN user u ON u.id = l.user_id
       WHERE (
           l.user_id = ?
           OR l.id IN (
             SELECT DISTINCT t.job_id
             FROM tasks t
             JOIN team_user tu ON tu.team_id = t.team_id
             WHERE LOWER(t.task_type) = 'lead'
               AND t.team_id IS NOT NULL
               AND tu.user_id = ?
           )
         )
         AND (l.status IS NULL OR l.status <> 3)
       ORDER BY l.created_at DESC`,
      [managerId, loggedInUserId]
    );

    const jobIds = jobs.map((j) => j.id);
    const leadIds = leads.map((l) => l.id);

    const jobTasksByJobId = {};
    const leadTasksByLeadId = {};
    const checklistTasksByJobId = {};

    if (jobIds.length) {
      const [jobTasks] = await connection.query(
        `SELECT t.*, u.name AS created_by_name FROM tasks t
         LEFT JOIN user u ON u.id = t.created_by
         WHERE LOWER(t.task_type) = 'job'
           AND t.job_id IN (?)
           AND (
             t.user_id = ?
             OR t.created_by = ?
             OR (t.team_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM team_user tu
                   WHERE tu.team_id = t.team_id AND tu.user_id = ?
                 ))
           )
         ORDER BY t.status ASC, t.created_at DESC`,
        [jobIds, loggedInUserId, managerId, loggedInUserId]
      );

      for (const t of jobTasks) {
        const key = String(t.job_id);
        if (!jobTasksByJobId[key]) jobTasksByJobId[key] = [];
        jobTasksByJobId[key].push(t);
      }
    }

    if (leadIds.length) {
      const [leadTasks] = await connection.query(
        `SELECT t.*, u.name AS created_by_name FROM tasks t
         LEFT JOIN user u ON u.id = t.created_by
         WHERE LOWER(t.task_type) = 'lead'
           AND t.job_id IN (?)
           AND (
             t.user_id = ?
             OR t.created_by = ?
             OR (t.team_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM team_user tu
                   WHERE tu.team_id = t.team_id AND tu.user_id = ?
                 ))
           )
         ORDER BY t.status ASC, t.created_at DESC`,
        [leadIds, loggedInUserId, managerId, loggedInUserId]
      );

      for (const t of leadTasks) {
        const key = String(t.job_id);
        if (!leadTasksByLeadId[key]) leadTasksByLeadId[key] = [];
        leadTasksByLeadId[key].push(t);
      }
    }

    if (jobIds.length) {
      const [checklistTasks] = await connection.query(
        `SELECT
           c.id,
           c.name,
           c.photo,
           c.assign_to,
           tm.id AS team_id,
           tm.team_name,
           tm.team_color,
           c.job_id,
           c.priority,
           c.due_date,
           c.status,
           c.is_calendar,
           c.is_appointment,
           c.calendar_task_id,
           c.appointment_id,
           c.created_by,
           u.name AS created_by_name,
           c.type
         FROM check_list c
         LEFT JOIN teams tm ON tm.id = c.assign_to
         LEFT JOIN user u ON u.id = c.created_by
         WHERE c.job_id IN (?)
           AND c.type = 'task'
           AND (
             c.created_by = ?
             OR c.assign_to = ?
             OR EXISTS (
                   SELECT 1 FROM team_user tu
                   WHERE tu.team_id = c.assign_to AND tu.user_id = ?
                 )
           )
         ORDER BY c.status ASC, c.id DESC`,
        [jobIds, loggedInUserId, loggedInUserId, loggedInUserId]
      );

      for (const c of checklistTasks) {
        const key = String(c.job_id);
        if (!checklistTasksByJobId[key]) checklistTasksByJobId[key] = [];
        checklistTasksByJobId[key].push(c);
      }
    }

    res.status(200).json({
      jobs,
      leads,
      jobTasksByJobId,
      leadTasksByLeadId,
      checklistTasksByJobId,
    });
  } catch (err) {
    logger.error("Error in /jobs/with-tasks:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/get-job-address/:id", auth.authenticateToken, async (req, res) => {
  const jobId = req.params.id;
  let connection;

  try {
    connection = await pool.getConnection();
    const query = `
            SELECT id, job_address, job_city, job_state, job_zipcode
            FROM job
            WHERE id = ?
        `;
    const [rows] = await connection.query(query, [jobId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.status(200).json({
      message: "Job address fetched successfully",
      data: rows[0],
    });
  } catch (err) {
    logger.error("Error fetching job address:", err);
    res.status(500).json({ message: "Error fetching job address" });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/upload-files",
  auth.authenticateToken,
  enforcePlanFeatureForJobFileType,
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
        // Store only the public path served by express.static('/uploads')
        // so the frontend can build a working URL regardless of where the
        // server lives on disk.
        const publicPath = `/uploads/${file.filename}`;

        const [result] = await connection.query(
          `INSERT INTO job_documents
            (path, name, job_id, mime_type, created_by, created_at, type)
           VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
          [
            publicPath,
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
          path: publicPath,
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

router.get("/get-files", auth.authenticateToken, async (req, res) => {
  const { job_id } = req.query;
  let connection;

  try {
    connection = await pool.getConnection();

    const userId = req.user && req.user.id ? req.user.id : res.locals.id;
    const features = await getActivePlanFeatures(connection, userId);

    if (!features.length) {
      return res.json([]);
    }

    const allowDocs = isAllowedFeature(features, ["job_documents", "documents"]);
    const allowPhotos = isAllowedFeature(features, ["job_photos", "photos", "pictures"]);

    if (!allowDocs && !allowPhotos) {
      return res.json([]);
    }

    const [rows] = await connection.execute(
      "SELECT id, path, name, job_id,type FROM job_documents WHERE job_id = ?",
      [job_id]
    );

    const filtered = (rows || []).filter((r) => {
      const t = String(r.type || "").toLowerCase();
      if (t === "document" || t === "documents") return allowDocs;
      if (t === "image" || t === "photo" || t === "photos" || t === "picture" || t === "pictures") {
        return allowPhotos;
      }
      // Unknown type -> only include if user has either permission
      return allowDocs || allowPhotos;
    });

    res.json(filtered);
  } catch (err) {
    logger.error("Error fetching documents:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Convert Job back to Lead
router.post(
  "/convert-to-lead/:jobId",
  auth.authenticateToken,
  async (req, res) => {
    const jobId = req.params.jobId;
    const userId = req.user.id;

    let connection;
    try {
      connection = await pool.getConnection();

      // 1. Fetch the job
      const [jobRows] = await connection.query(
        `SELECT * FROM job WHERE id = ?`,
        [jobId]
      );
      if (jobRows.length === 0) {
        return res.status(404).json({ message: "Job not found" });
      }
      const job = jobRows[0];

      if (!job.lead_id) {
        return res
          .status(400)
          .json({ message: "This job has no linked lead_id" });
      }

      // 2. Update lead status = 1
      await connection.query(`UPDATE leads SET status = 1 WHERE id = ?`, [
        job.lead_id,
      ]);

      // 3. Delete the job
      await connection.query(`DELETE FROM job WHERE id = ?`, [jobId]);

      res.json({
        message: "Job converted back to Lead successfully",
        leadId: job.lead_id,
      });
    } catch (error) {
      logger.error("Error converting job back to lead:", error);
      res
        .status(500)
        .json({ message: "Error converting job back to lead", error });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.get("/jobs/all/:id", auth.authenticateToken, async (req, res) => {
  const user_id = req.params.id;
  let connection;
  try {
    
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
        j.*
      FROM job j
      WHERE j.created_by = ? AND j.status = 1
      ORDER BY j.created_at DESC
    `,
      [user_id]
    );

    res.status(200).json(rows);
  } catch (err) {
    logger.error("Error fetching jobs for user", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE - Job by ID
router.delete("/delete/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await pool.getConnection();

    // Optional: check if job exists first
    const [existing] = await connection.execute(
      "SELECT id FROM job WHERE id = ?",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    await connection.execute("DELETE FROM job WHERE id = ?", [id]);

    res.status(200).json({ message: "Job deleted successfully" });
  } catch (err) {
    logger.error("Error deleting job:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/materials", auth.authenticateToken, async (req, res) => {
  let connection;
  const { job_id } = req.query;
  try {
    connection = await pool.getConnection();

    const userId = req.user && req.user.id ? req.user.id : res.locals.id;
    const features = await getActivePlanFeatures(connection, userId);
    const allowMaterials =
      features.length > 0 && isAllowedFeature(features, ["job_materials", "materials"]);

    if (!allowMaterials) {
      return res.status(200).json([]);
    }

    let query = "SELECT * FROM materials";
    const params = [];

    if (job_id) {
      query += " WHERE job_id = ?";
      params.push(job_id);
    }

    query += " ORDER BY id DESC";

    const [materials] = await connection.execute(query, params);

    res.status(200).json(materials);
  } catch (err) {
    logger.error("Error fetching materials:", err);
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/materials", auth.authenticateToken, enforcePlanFeatureForMaterials, async (req, res) => {
  const { error, value } = materialSchema.validate(req.body);

  if (error) {
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: error.details[0].message,
    });
  }

  const { job_id, item_type, room, material, manufacturer, size, color } = value;

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `INSERT INTO materials (job_id, item_type, room, material, manufacturer, size, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [job_id, item_type ?? null, room ?? null, material ?? null, manufacturer ?? null, size ?? null, color ?? null]
    );

    res.status(201).json({
      code: "MATERIAL_CREATED",
      message: "Material saved successfully",
      material_id: result.insertId,
    });
  } catch (err) {
    logger.error("Error creating material:", err);
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/materials/:id", auth.authenticateToken, enforcePlanFeatureForMaterials, async (req, res) => {
  let connection;
  const { id } = req.params;

  try {
    connection = await pool.getConnection();

    const [existing] = await connection.execute(
      "SELECT id FROM materials WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        code: "NOT_FOUND",
        message: "Material not found",
      });
    }

    await connection.execute("DELETE FROM materials WHERE id = ?", [id]);

    res.status(200).json({
      code: "MATERIAL_DELETED",
      message: "Material deleted successfully",
    });
  } catch (err) {
    logger.error("Error deleting material:", err);
    res.status(500).json({
      code: "DB_ERROR",
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});
async function resolveBillingUserId(connection, userId) {
  let billingUserId = userId;
  const [userRows] = await connection.query(
    "SELECT id, role, created_by FROM user WHERE id = ? LIMIT 1",
    [userId]
  );

  if (!userRows.length) return billingUserId;

  const currentUser = userRows[0];
  const currentRole = Number(currentUser.role);

  if (currentRole === 14) {
    return currentUser.id;
  }

  if (currentRole !== 12 && currentUser.created_by) {
    const [managerRows] = await connection.query(
      "SELECT id, role FROM user WHERE id = ? LIMIT 1",
      [currentUser.created_by]
    );
    if (managerRows.length && Number(managerRows[0].role) === 14) {
      return managerRows[0].id;
    }
  }

  return billingUserId;
}

async function getActivePlanFeatures(connection, userId) {
  const billingUserId = await resolveBillingUserId(connection, userId);

  const [subRows] = await connection.query(
    `SELECT plan_id
     FROM subscriptions
     WHERE user_id = ? AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [billingUserId]
  );

  if (!subRows.length) return [];

  const planId = subRows[0].plan_id;
  const [featureRows] = await connection.query(
    "SELECT feature_key FROM plan_features WHERE plan_id = ?",
    [planId]
  );

  return featureRows.map((r) => String(r.feature_key).toLowerCase());
}

function isAllowedFeature(features, allowedKeys) {
  const normalizedAllowed = allowedKeys.map((k) => String(k).toLowerCase());
  return normalizedAllowed.some((k) => features.includes(k));
}

function requiredKeysForJobFileType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "document" || t === "documents") {
    return ["job_documents", "documents"];
  }
  if (t === "image" || t === "photo" || t === "photos" || t === "picture" || t === "pictures") {
    return ["job_photos", "job_photos", "photos", "pictures"];
  }
  // Unknown type: require either documents or photos
  return ["job_documents", "documents", "job_photos", "photos", "pictures"];
}

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

async function enforcePlanFeatureForMaterials(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : res.locals.id;
  if (!userId) {
    return res.status(401).json({ code: "UNAUTHORIZED", message: "Unauthorized" });
  }

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

    if (!isAllowedFeature(features, ["job_materials", "materials"])) {
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
module.exports = router;
