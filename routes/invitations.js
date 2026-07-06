const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require('nodemailer');
var auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const { Console } = require("console");
const admin = require("../config/firebase-admin");
const gcal = require("../services/googleCalendar");
const { checkLicense, checkAllLicenses, ensureCslbColumns } = require("../services/cslbChecker");
const { ensureContactStatusColumn } = require("../services/dbMigrations");

//get contacts
router.get('/get_contacts',auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`SELECT * FROM user where status = 1 ORDER BY created_at DESC`);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Fallback: delete appointment(s) by linked task_id (idempotent)
router.delete('/appointments/by-task/:taskId', async (req, res) => {
  const taskIdRaw = req.params.taskId;
  let connection;
  try {
    const taskId = Number(taskIdRaw);
    if (!taskId) return res.status(400).json({ message: 'Invalid task id' });

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify schema has task_id
    const [[taskIdCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'task_id'
       LIMIT 1;`,
    );
    const hasAppointmentTaskId = !!taskIdCol;
    if (!hasAppointmentTaskId) {
      await connection.rollback();
      return res.status(400).json({ message: 'appointments.task_id column not found' });
    }

    // Find all appointment ids for this task
    const [rows] = await connection.query(
      `SELECT id FROM appointments WHERE task_id = ?`,
      [taskId],
    );
    const ids = rows.map((r) => Number(r.id)).filter((n) => !!n);

    // Delete and clear links if any
    if (ids.length) {
      await connection.query(`DELETE FROM appointments WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      await connection.query(
        `UPDATE check_list SET is_appointment = 0, appointment_id = NULL WHERE appointment_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
    }

    // Clear task flag
    await connection.query(
      `UPDATE tasks SET is_appointment_task = 0 WHERE id = ?`,
      [taskId],
    );

    await connection.commit();
    res.json({ message: 'Appointment(s) deleted for task', deleted_ids: ids });
  } catch (err) {
    try { if (connection) await connection.rollback(); } catch (_) {}
    console.error('Error deleting appointment by task:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
});



// router.post("/send-invite", auth.authenticateToken, async (req, res) => {
//   let connection;
//   //const signedin_user = res.locals.working_id;
 

//   try {
//     connection = await pool.getConnection();
//     const { request_by, client_id: request_to } = req.body;

//     if (!request_by || !request_to) {
//       return res.status(400).json({ message: "Missing request_by or client_id." });
//     }

//     // Normalize the pair: smallest goes first
//     const user1 = Math.min(request_by, request_to);
//     const user2 = Math.max(request_by, request_to);

//     // Check for existing contact (regardless of direction)
//     const [existing] = await connection.query(
//       `SELECT id FROM contact WHERE request_user1 = ? AND request_user2 = ?`,
//       [user1, user2]
//     );

//     if (existing.length > 0) {
//       return res.status(409).json({ message: "Contact already exists between these users." });
//     }

//     // Insert new contact (original request_by/request_to preserved)
//     await connection.query(
//       `INSERT INTO contact (request_by, request_to) VALUES (?, ?)`,
//       [request_by, request_to]
//     );

//     res.status(200).json({ message: "Invite sent successfully." });

//   } catch (err) {
//     console.error("Error sending invite:", err);
//     res.status(500).json({ message: "Internal Server Error" });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post("/send-invite", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    const role = Number(req.user && req.user.role);
    if (role === 12) {
      return res.status(403).json({ message: "You are not allowed to create invitations." });
    }
    // Contacts belong to the COMPANY, not the individual. For employees,
    // working_id resolves to the account owner, so a contact an employee adds
    // is owned by the owner's account (and visible to the whole team) — same
    // as the /contacts/create flow. Falls back to the user's own id (owners).
    const request_by = res.locals.working_id || (req.user && req.user.id);
    const { client_id: request_to } = req.body;

    if (!request_by || !request_to) {
      return res.status(400).json({ message: "Missing request_by or client_id." });
    }

    // Normalize the pair
    const user1 = Math.min(request_by, request_to);
    const user2 = Math.max(request_by, request_to);

    // Check if already exists
    const [existing] = await connection.query(
      `SELECT id FROM contact WHERE request_user1 = ? AND request_user2 = ?`,
      [user1, user2]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: "Contact already exists between these users." });
    }

    // Insert new contact request
    await connection.query(
      `INSERT INTO contact (request_by, request_to) VALUES (?, ?)`,
      [request_by, request_to]
    );

    // ---------------------------------------------------
    // Fetch sender name (just like jobAddContact)
    // ---------------------------------------------------
    const [[senderRow]] = await connection.query(
      "SELECT name FROM user WHERE id = ?",
      [request_by]
    );
    const senderName = senderRow ? senderRow.name : "Someone";

    // ---------------------------------------------------
    // Fetch receiver FCM token
    // ---------------------------------------------------
    const [[recipient]] = await connection.query(
      "SELECT fcm_token FROM user_device_tokens WHERE user_id = ?",
      [request_to]
    );

    // ---------------------------------------------------
    // Create notification message
    // ---------------------------------------------------
    const title = "New Contact Invitation";
    const body = `${senderName} sent you a contact request.`;

    // Contact requests now live on the Contacts page
    const url = `/contact`;

    // ---------------------------------------------------
    // Insert notification record in DB
    // ---------------------------------------------------
    await connection.query(
      `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [request_by, request_to, body, url, request_by]
    );

    // ---------------------------------------------------
    // Send FCM notification (same logic as jobAddContact)
    // ---------------------------------------------------
    if (recipient && recipient.fcm_token) {
      const fcmToken = recipient.fcm_token;

      const message = {
        token: fcmToken,
        notification: { title, body },
        data: {
          type: "contact_invite",
          from_user_id: String(request_by),
          to_user_id: String(request_to),
          url
        }
      };

      try {
        await admin.messaging().send(message);
        console.log("✅ Contact invite notification sent to:", request_to);
      } catch (err) {
        console.error("❌ FCM Error:", err);
      }
    } else {
      console.warn(`⚠️ No FCM token found for user ${request_to}`);
    }

    // Success response
    res.status(200).json({ message: "Invite sent successfully." });

  } catch (err) {
    console.error("Error sending invite:", err);
    res.status(500).json({ message: "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
});



// router.get('/get_sent_contacts', auth.authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id; // from decoded JWT
    
//  connection = await pool.getConnection();
//     const sql = `
//       SELECT 
//         c.id,
//         c.request_by,
//         u1.name AS request_by_name,
//         u1.email AS request_by_email,
//         c.request_to,
//         u2.name AS request_to_name,
//         u2.email AS request_to_email,
//         c.status,
//         c.created_at,
//         c.updated_at
//       FROM contact c
//       JOIN user u1 ON c.request_by = u1.id
//       JOIN user u2 ON c.request_to = u2.id
//       WHERE c.request_by = ? and c.status != 'Accept'
//       ORDER BY c.created_at DESC
//     `;

//     const [rows] = await connection.query(sql, [userId]);

//     res.status(200).json(rows);
//   } catch (error) {
//     console.error('Error fetching contacts:', error);
//     res.status(500).json({ message: 'Internal server error' });
//   }finally {
//     if (connection) connection.release();
//   }
// });


router.get('/get_sent_contacts', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = req.user.id;

    connection = await pool.getConnection();

    const sql = `
      (
  SELECT 
    c.id,
    c.request_by,
    u1.name AS request_by_name,
    u1.email AS request_by_email,
    c.request_to,
    u2.name AS request_to_name,
    u2.email AS request_to_email,
    c.status,
    c.created_at,
    c.updated_at,
    'user' AS contact_type
  FROM contact c
  JOIN user u1 ON c.request_by = u1.id
  JOIN user u2 ON c.request_to = u2.id
  WHERE c.request_by = ?
    AND c.status != 'Accept'
)

UNION ALL

(
  SELECT
    ic.id,
    ic.created_by AS request_by,
    u.name AS request_by_name,
    u.email AS request_by_email,
    NULL AS request_to,
    ic.name AS request_to_name,
    ic.email AS request_to_email,

    CASE
      WHEN ic.status = 0 THEN 'Pending'
    END AS status,

    ic.created_at,
    NULL AS updated_at,
    'invited' AS contact_type
  FROM invited_contacts ic
  JOIN user u ON ic.created_by = u.id
  WHERE ic.created_by = ?
    AND ic.status = 0
)

ORDER BY created_at DESC;

    `;

    const [rows] = await connection.query(sql, [userId, userId]);

    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.delete(
  "/delete-sent-contact/:id/:type",
  auth.authenticateToken,
  async (req, res) => {
    const { id, type } = req.params;
    const userId = req.user.id;
    let connection;

    try {
      connection = await pool.getConnection();

      if (type === "user") {
        // 🔹 From `contact` table
        await connection.execute(
          `DELETE FROM contact 
           WHERE id = ? AND request_by = ? AND status != 'Accept'`,
          [id, userId]
        );
      } 
      else if (type === "invited") {
        // 🔹 From `invited_contacts` table
        await connection.execute(
          `DELETE FROM invited_contacts 
           WHERE id = ? AND created_by = ? AND status = 0`,
          [id, userId]
        );
      } 
      else {
        return res.status(400).json({ message: "Invalid contact type" });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Delete sent contact error:", err);
      res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);


router.get('/get_requested_contacts', auth.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id; // from decoded JWT
    
 connection = await pool.getConnection();
    const sql = `
      SELECT 
        c.id,
        c.request_by,
        u1.name AS request_by_name,
        u1.email AS request_by_email,
        c.request_to,
        u2.name AS request_to_name,
        u2.email AS request_to_email,
        c.status,
        c.created_at,
        c.updated_at
      FROM contact c
      JOIN user u1 ON c.request_by = u1.id
      JOIN user u2 ON c.request_to = u2.id
      WHERE c.request_to = ? AND c.status = 'Pending'
      ORDER BY c.created_at DESC
    `;

    const [rows] = await connection.query(sql, [userId]);

    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ message: 'Internal server error' });
  }finally {
    if (connection) connection.release();
  }
});

router.put('/update_contact_status/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const contactId = Number(req.params.id);
    const { status } = req.body;

    const userId = (req.user && req.user.id) ? req.user.id : res.locals.id;
    const roleId = Number(req.user && req.user.role ? req.user.role : null);

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!contactId || Number.isNaN(contactId)) {
      return res.status(400).json({ message: 'Invalid contact id' });
    }

    if (!['Accept', 'Reject'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    connection = await pool.getConnection();

    // Prefer user-specific permission, fall back to role default (user_id IS NULL)
    const [permissionRows] = await connection.query(
      `SELECT COALESCE(rrp.\`update\`, 'no') AS can_update
       FROM \`right\` r
       LEFT JOIN role_right_permission rrp
         ON rrp.right_id = r.id
        AND rrp.role_id = ?
        AND (rrp.user_id = ? OR rrp.user_id IS NULL)
       WHERE LOWER(r.name) = ?
         AND r.sub_heading = 0
       ORDER BY (rrp.user_id IS NOT NULL) DESC
       LIMIT 1`,
      [roleId, userId, 'invitation']
    );

    let canUpdate = permissionRows && permissionRows[0] && permissionRows[0].can_update === 'yes';

    // For subcontractor (role 12), apply safe default allowing update on invitation
    if (!canUpdate && Number(roleId) === 12) {
      canUpdate = true;
    }

    if (!canUpdate) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const [contactRows] = await connection.query(
      "SELECT id, request_to FROM contact WHERE id = ? LIMIT 1",
      [contactId]
    );

    if (!contactRows.length) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    if (Number(contactRows[0].request_to) !== Number(userId)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const [result] = await connection.query(
      `UPDATE contact SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, contactId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Contact not found' });
    }

    res.status(200).json({ message: 'Status updated successfully' });
  } catch (error) {
    console.error('Error updating contact status:', error);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/sync-invites', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Get all invited contacts where status = 0
    const [pendingInvites] = await connection.query(`
      SELECT id, email, name, created_by FROM invited_contacts WHERE status = 0
    `);

    let insertedCount = 0;

    for (const invite of pendingInvites) {
      const [users] = await connection.query(`SELECT id FROM user WHERE email = ?`, [invite.email]);

      if (users.length > 0) {
        const receiverId = users[0].id;

        // 2. Insert into contact table
        const insertContactQuery = `
          INSERT IGNORE INTO contact (request_by, request_to, status, created_at, updated_at)
          VALUES (?, ?, 'Pending', NOW(), NOW())
        `;
        await connection.query(insertContactQuery, [invite.created_by, receiverId]);

        // 3. Update status in invited_contacts to 1
        await connection.query(`UPDATE invited_contacts SET status = 1 WHERE id = ?`, [invite.id]);

        insertedCount++;
      }
    }

    res.status(200).json({
      message: `Synced ${insertedCount} invites to contact table.`,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ message: 'Failed to sync invites', error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/accepted-contacts', auth.authenticateToken, async (req, res) => {
  // Account-wide: contacts belong to the company. Resolve the account owner
  // (working_id) and include every contact added by anyone on the account
  // (owner + employees), so the whole team sees the same contact list.
  const ownerId = res.locals.working_id || req.user.id;
  let connection;

  try {
    connection = await pool.getConnection();
    await ensureCslbColumns(connection);

    // The displayed person is the party that is NOT an account member.
    const ACCOUNT = '(SELECT id FROM `user` WHERE id = ? OR created_by = ?)';
    const sql = `
      SELECT
        u.id,
        u.name,
        u.first_name,
        u.last_name,
        u.spouse_last_name,
        u.email,
        u.image,
        u.mobile,
        u.created_at AS joined_at,
        sub.name AS subcategory_name,
        cat.name AS position,
        COALESCE(u.business, u.organization_name, '') AS business_name,
        u.license_number,
        u.license_state,
        u.address,
        u.cslb_status,
        u.cslb_checked_at,
        u.cslb_classification,
        u.cslb_address,
        u.cslb_phone,
        u.spouse_name,
        u.spouse_email,
        u.spouse_phone,
        (
          SELECT COUNT(*) FROM contact
          WHERE status = 'Accept' AND (request_by = u.id OR request_to = u.id)
        ) AS total_connections,
        c.updated_at AS connected_at,
        c.status AS connection_status
      FROM contact c
      JOIN user u ON (u.id = IF(c.request_by IN ${ACCOUNT}, c.request_to, c.request_by))
      LEFT JOIN subcategory sub ON u.subcategory = sub.id
      LEFT JOIN category cat ON cat.id = u.category
      WHERE (c.status = 'Accept' AND (c.request_by IN ${ACCOUNT} OR c.request_to IN ${ACCOUNT}))
         OR (c.status IN ('Pending','Saved') AND c.request_by IN ${ACCOUNT})
      ORDER BY c.updated_at DESC
    `;

    // 4 ACCOUNT subqueries, each takes (ownerId, ownerId).
    const [rows] = await connection.query(sql, [
      ownerId, ownerId,  // IF(...)
      ownerId, ownerId,  // Accept request_by
      ownerId, ownerId,  // Accept request_to
      ownerId, ownerId,  // Pending/Saved request_by
    ]);

    // A single person can have more than one `contact` row linking them to the
    // account — e.g. a mutual/bidirectional connection (one row each direction)
    // or an old Saved/Pending row alongside the Accept row. This JOIN emits one
    // output row per contact row, which surfaced as DUPLICATE contact cards.
    // (Deleting one then removed both, because the DELETE clears every contact
    // row for that user id.) Collapse to one row per person here, preferring an
    // accepted connection and otherwise the most recently updated link.
    const statusRank = (s) => (s === 'Accept' ? 2 : 1);
    const byId = new Map();
    for (const row of rows) {
      const prev = byId.get(row.id);
      if (!prev) { byId.set(row.id, row); continue; }
      const betterStatus = statusRank(row.connection_status) - statusRank(prev.connection_status);
      const newer = new Date(row.connected_at || 0) > new Date(prev.connected_at || 0);
      if (betterStatus > 0 || (betterStatus === 0 && newer)) byId.set(row.id, row);
    }

    res.json([...byId.values()]);
  } catch (err) {
    console.error('Error fetching accepted contacts:', err);
    res.status(500).json({ message: 'Failed to fetch accepted contacts' });
  } finally {
    if (connection) connection.release();
  }
});


router.get("/getuserbycategory/:id", auth.authenticateToken, async (req, res) => {
    const id = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        query = "SELECT u.id, u.name, u.email, u.mobile FROM user u where u.category = ? order by u.id asc";
        const [rows] = await connection.query(query, [id]);
        res.status(200).json({ code: "200", message: "getuserbycategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});


router.get("/getuserbysubcategory/:id", auth.authenticateToken, async (req, res) => {
    const id = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        query = "SELECT u.id, u.name, u.email, u.mobile FROM user u where u.subcategory = ? order by u.id asc";
        const [rows] = await connection.query(query, [id]);
        res.status(200).json({ code: "200", message: "getuserbysubcategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});
// routes/right.js or your main routes file

router.get('/rights', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    // Ensure the "Project Manager" permission exists (idempotent). Wrapped so a
    // seed hiccup can never break the rights grid load.
    try {
      const [pm] = await connection.query(
        "SELECT id FROM `right` WHERE name = 'project_manager' LIMIT 1"
      );
      if (!pm.length) {
        await connection.query(
          "INSERT INTO `right` (name, display_name, sub_heading, admin_module) VALUES ('project_manager', 'Project Manager', 0, 0)"
        );
      }
    } catch (seedErr) {
      console.error('Project Manager right seed skipped:', seedErr.message);
    }
    const [rows] = await connection.query("SELECT * FROM `right` where admin_module = 0 ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error('Error fetching rights:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});
// GET /getsubcategory/:categoryId
router.get('/getsubcategory/:categoryId', auth.authenticateToken, async (req, res) => {
  const categoryId = parseInt(req.params.categoryId);
  let connection;

  if (!categoryId) {
    return res.status(400).json({ message: 'Invalid category ID' });
  }

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      'SELECT id, name FROM subcategory WHERE category_id = ? ORDER BY name ASC',
      [categoryId]
    );

    res.status(200).json({
      status: 200,
      data: rows,
    });
  } catch (error) {
    console.error('Error fetching subcategories:', error);
    res.status(500).json({ message: 'Failed to load subcategories' });
  } finally {
    if (connection) connection.release();
  }
});



// router.post('/assign-rights', async (req, res) => {
//   const { role_id, user_id, right_ids } = req.body;
//   if (!role_id || !user_id || !Array.isArray(right_ids)) {
//     return res.status(400).json({ message: 'Missing or invalid data' });
//   }

//   let connection;
//   try {
//     connection = await pool.getConnection();

//     for (const rightId of right_ids) {
//       const query = `
//         INSERT INTO role_right_permission (\`role_id\`, \`user_id\`, \`right_id\`, \`read\`, \`create\`, \`update\`, \`delete\`)
//         VALUES (?, ?, ?, 'yes', 'yes', 'yes', 'yes')
//         ON DUPLICATE KEY UPDATE 
//           \`read\` = 'yes', 
//           \`create\` = 'yes', 
//           \`update\` = 'yes', 
//           \`delete\` = 'yes'
//       `;
//       await connection.query(query, [role_id, user_id, rightId]);
//     }

//     res.status(200).json({ message: 'Rights assigned successfully' });
//   } catch (err) {
//     console.error('Error assigning rights:', err);
//     res.status(500).json({ message: 'Internal server error' });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post('/assign-rights', async (req, res) => {  
  const { role_id, user_id, right_ids } = req.body;

  if (!role_id || !user_id || !Array.isArray(right_ids)) {
    return res.status(400).json({ message: 'Missing or invalid data' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 🔥 1. DELETE old rights for this user + role
    await connection.query(
      `DELETE FROM role_right_permission 
       WHERE user_id = ? AND role_id = ?`,
      [user_id, role_id]
    );

    // 🔥 2. INSERT new rights
    for (const rightId of right_ids) {
      await connection.query(
        `INSERT INTO role_right_permission
         (role_id, user_id, right_id, \`read\`, \`create\`, \`update\`, \`delete\`)
         VALUES (?, ?, ?, 'yes', 'yes', 'yes', 'yes')`,
        [role_id, user_id, rightId]
      );
    }

    await connection.commit();
    res.status(200).json({ message: 'Rights updated successfully' });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error assigning rights:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/get-employees-by-user', auth.authenticateToken, async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ code: '400', message: 'Missing user_id' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const query = 'SELECT u.id,u.name,u.email,u.mobile,u.employment_type,u.rate,u.resignation_date,u.resignation_reason,u.exit_type,sub.name AS subcategory_name,cat.name AS position,MAX(tu.team_id) AS current_team_id,GROUP_CONCAT(DISTINCT t.team_name SEPARATOR ", ") AS current_team_name,u.created_at AS hiringDate,GROUP_CONCAT(DISTINCT el.leave_type SEPARATOR " , ") AS leave_types,GROUP_CONCAT(DISTINCT el.quota SEPARATOR ", ") AS leave_quotas,GROUP_CONCAT(DISTINCT r.display_name SEPARATOR ", ") AS rights FROM user u LEFT JOIN subcategory sub ON u.subcategory=sub.id LEFT JOIN category cat ON cat.id=u.category LEFT JOIN employee_leaves_quota elq ON elq.emp_id=u.id LEFT JOIN employees_leaves el ON el.id=elq.leave_id LEFT JOIN role_right_permission rrp ON rrp.user_id=u.id AND rrp.role_id=u.subcategory LEFT JOIN `right` r ON r.id=rrp.right_id LEFT JOIN team_user tu ON tu.user_id=u.id LEFT JOIN teams t ON t.id=tu.team_id WHERE u.created_by=? AND u.category=1 GROUP BY u.id,u.name,u.email,u.mobile,u.employment_type,u.rate,u.resignation_date,u.resignation_reason,u.exit_type,sub.name,cat.name,u.created_at ORDER BY u.created_at DESC;'


;
    const [rows] = await connection.query(query, [user_id]);

    res.status(200).json({ code: '200', message: 'Employees fetched successfully', data: rows });
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ code: '500', message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/appointments
router.post('/appointments', auth.authenticateToken, async (req, res) => {
  const {
    task_id,
    job_id,
    user_id,
    description,
    subject,
    doa,
    time_of_appointment,
    end_date,
    end_time,
    created_by,
    appointment_type,
    zoom_link,
    job_address,
    meeting_location
  } = req.body;

  let connection;
  try {
    connection = await pool.getConnection();

    // Detect whether appointments table has task_id column (for backwards compatibility)
    const [[taskIdCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'task_id'
       LIMIT 1;`,
    );
    const hasTaskIdColumn = !!taskIdCol;

    const [[endDateCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'end_date'
       LIMIT 1;`,
    );
    const [[endTimeCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'end_time'
       LIMIT 1;`,
    );
    const hasEndDateColumn = !!endDateCol;
    const hasEndTimeColumn = !!endTimeCol;

    const normalizedTaskId = Number(task_id || 0) || null;

    // Prevent duplicates: one appointment per task
    if (hasTaskIdColumn && normalizedTaskId) {
      const [[existing]] = await connection.query(
        `SELECT id FROM appointments WHERE task_id = ? LIMIT 1`,
        [normalizedTaskId],
      );
      if (existing && existing.id) {
        // Ensure the task flag reflects the existing link
        await connection.query(
          `UPDATE tasks SET is_appointment_task = 1 WHERE id = ?`,
          [normalizedTaskId],
        );
        return res.status(200).json({
          message: 'Appointment already exists for this task',
          data: { id: existing.id },
        });
      }
    }

   
    let doaFormatted = null;
    if (doa) {
      if (typeof doa === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doa)) {
        doaFormatted = doa; 
      } else {
        const d = new Date(doa);
        if (!isNaN(d.getTime())) {
          // format as local date yyyy-mm-dd
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          doaFormatted = `${yyyy}-${mm}-${dd}`;
        }
      }
    }

    let timeFormatted = null;
    if (time_of_appointment) {
      if (typeof time_of_appointment === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(time_of_appointment)) {
        timeFormatted = time_of_appointment.length === 5 ? `${time_of_appointment}:00` : time_of_appointment;
      } else {
        const t = new Date(time_of_appointment);
        if (!isNaN(t.getTime())) {
          const hh = String(t.getHours()).padStart(2, '0');
          const mi = String(t.getMinutes()).padStart(2, '0');
          const ss = String(t.getSeconds()).padStart(2, '0');
          timeFormatted = `${hh}:${mi}:${ss}`;
        }
      }
    }

    // Format end_date / end_time the same way
    let endDateFormatted = null;
    if (end_date) {
      if (typeof end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
        endDateFormatted = end_date;
      } else {
        const d = new Date(end_date);
        if (!isNaN(d.getTime())) {
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          endDateFormatted = `${yyyy}-${mm}-${dd}`;
        }
      }
    }

    let endTimeFormatted = null;
    if (end_time) {
      if (typeof end_time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(end_time)) {
        endTimeFormatted = end_time.length === 5 ? `${end_time}:00` : end_time;
      } else {
        const t = new Date(end_time);
        if (!isNaN(t.getTime())) {
          const hh = String(t.getHours()).padStart(2, '0');
          const mi = String(t.getMinutes()).padStart(2, '0');
          const ss = String(t.getSeconds()).padStart(2, '0');
          endTimeFormatted = `${hh}:${mi}:${ss}`;
        }
      }
    }

    // Basic validation
    if (!subject) {
      return res.status(400).json({ message: 'Subject is required' });
    }
    if (!doaFormatted) {
      return res.status(400).json({ message: 'Valid date of appointment (doa) is required' });
    }
    if (!timeFormatted) {
      return res.status(400).json({ message: 'Valid time_of_appointment is required' });
    }

    const createdBy = (req.user && req.user.id) ? req.user.id : created_by;

    let query;
    let values;
    if (hasTaskIdColumn) {
      query = `
        INSERT INTO appointments 
        (task_id, job_id, user_id, description, subject, doa, time_of_appointment${hasEndDateColumn ? ', end_date' : ''}${hasEndTimeColumn ? ', end_time' : ''}, appointment_type, zoom_link, created_by, created_at, address, meeting_location)
        VALUES (?, ?, ?, ?, ?, ?, ?${hasEndDateColumn ? ', ?' : ''}${hasEndTimeColumn ? ', ?' : ''}, ?, ?, ?, NOW(), ?, ?)
      `;
      values = [
        normalizedTaskId,
        job_id || null,
        user_id || null,
        description || '',
        subject || '',
        doaFormatted,
        timeFormatted,
        ...(hasEndDateColumn ? [endDateFormatted || doaFormatted] : []),
        ...(hasEndTimeColumn ? [endTimeFormatted || timeFormatted] : []),
        appointment_type || null,
        zoom_link || null,
        createdBy,
        job_address,
        meeting_location || null,
      ];
    } else {
      query = `
        INSERT INTO appointments 
        (job_id, user_id, description, subject, doa, time_of_appointment${hasEndDateColumn ? ', end_date' : ''}${hasEndTimeColumn ? ', end_time' : ''}, appointment_type, zoom_link, created_by, created_at, address, meeting_location)
        VALUES (?, ?, ?, ?, ?, ?${hasEndDateColumn ? ', ?' : ''}${hasEndTimeColumn ? ', ?' : ''}, ?, ?, ?, NOW(), ?, ?)
      `;
      values = [
        job_id || null,
        user_id || null,
        description || '',
        subject || '',
        doaFormatted,
        timeFormatted,
        ...(hasEndDateColumn ? [endDateFormatted || doaFormatted] : []),
        ...(hasEndTimeColumn ? [endTimeFormatted || timeFormatted] : []),
        appointment_type || null,
        zoom_link || null,
        createdBy,
        job_address,
        meeting_location || null,
      ];
    }

    const [result] = await connection.query(query, values);

    // Reflect linkage on tasks table when we know the task id
    if (hasTaskIdColumn && normalizedTaskId) {
      await connection.query(
        `UPDATE tasks SET is_appointment_task = 1 WHERE id = ?`,
        [normalizedTaskId],
      );
    }

    // Push to Google Calendar (non-blocking — don't fail the request if this errors)
    const appointmentCreatorId = createdBy;
    try {
      const connected = await gcal.isConnected(appointmentCreatorId);
      if (connected) {
        const googleEventId = await gcal.createEvent(appointmentCreatorId, {
          subject: subject || '',
          description: description || '',
          doa: doaFormatted,
          time_of_appointment: timeFormatted,
          end_date: endDateFormatted || doaFormatted,
          end_time: endTimeFormatted || timeFormatted,
          appointment_type: appointment_type || null,
          zoom_link: zoom_link || null,
          meeting_location: meeting_location || null,
          job_address: job_address || null,
        });
        if (googleEventId) {
          await connection.query(
            'UPDATE appointments SET google_event_id = ? WHERE id = ?',
            [googleEventId, result.insertId],
          );
        }
      }
    } catch (gcalErr) {
      console.error('Google Calendar sync (create) error:', gcalErr.message);
    }

    res.status(201).json({
      message: 'Appointment created successfully',
      data: {
        id: result.insertId,
      },
    });
  } catch (err) {
    console.error('Error creating appointment:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});


// GET /api/tasks/by-job/:job_id
router.get('/by-job/:job_id', auth.authenticateToken, async (req, res) => {
  const { job_id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM tasks WHERE job_id = ? AND remove_by IS NULL`,
      [job_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/job-contacts/:job_id
router.get('/job-contacts/:job_id',auth.authenticateToken, async (req, res) => {
  const job_id = req.params.job_id;

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT u.id as user_id, u.name
       FROM job_contacts jc
       JOIN user u ON jc.contact_id  = u.id
       WHERE jc.job_id = ?`,
      [job_id]
    );

    res.json(rows);
  } catch (err) {
    console.error('Error fetching job contacts:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});
// GET /api/appointments?job_ids=1,2,3
// router.get('/appointments', async (req, res) => {
//   const jobIds = req.query.job_ids;
//   let query = `SELECT a.id as task_id, a.subject as title, a.doa as start, a.time_of_appointment, j.name as Job_name, u.name as user_name, a.user_id, a.job_id FROM appointments a JOIN job j on a.job_id = j.id JOIN user u ON a.user_id = u.id;`;

//   let connection;

//   try {
//     connection = await pool.getConnection();

router.get('/appointments', auth.authenticateToken, async (req, res) => {
  //const jobIds = req.query.job_ids;
  const requestedUserId = req.query.user_id; // optional
  const authUserId = (req.user && req.user.id) || null;
  const workingId = (req.user && req.user.working_id) || null;

  let connection;

  try {
    connection = await pool.getConnection();

    const [[taskIdCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'task_id'
       LIMIT 1;`,
    );
    const hasTaskIdColumn = !!taskIdCol;

    const [[endDateCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'end_date'
       LIMIT 1;`,
    );
    const [[endTimeCol]] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'end_time'
       LIMIT 1;`,
    );
    const hasEndDateColumn = !!endDateCol;
    const hasEndTimeColumn = !!endTimeCol;

    // Backwards compatible fields:
    // - keep returning `task_id` as the appointment id (older UI relies on this)
    // - also return `linked_task_id` as the linked task id when available
    let query = `
      SELECT 
        a.id,
        a.id AS task_id,
        ${hasTaskIdColumn ? 'a.task_id AS linked_task_id' : 'NULL AS linked_task_id'},
        a.subject AS title,
        a.doa AS start,
        a.time_of_appointment,
        j.name AS job_name,
        j.address,
        u.name AS user_name,
        u.mobile,
        a.user_id,
        a.job_id,
        a.description,
        a.created_by,
        a.appointment_type,
        a.zoom_link,
        a.meeting_location,
        ${hasEndDateColumn ? 'a.end_date AS end_date' : 'NULL AS end_date'},
        ${hasEndTimeColumn ? 'a.end_time AS end_time' : 'NULL AS end_time'}

      FROM appointments a
      left JOIN job j ON a.job_id = j.id
      left JOIN user u ON a.user_id = u.id
      WHERE (
        a.created_by = ?
        OR a.user_id = ?
        OR a.created_by = ?
        OR a.user_id = ?
      )
    `;

    const normalizedAuthUserId = Number(authUserId || 0) || null;
    const normalizedWorkingId = Number(workingId || 0) || null;

    // If caller didn't pass user_id, default to GC/working_id for employees.
    const fallbackRequested = normalizedWorkingId || normalizedAuthUserId;
    const normalizedRequestedUserId = Number(requestedUserId || 0) || fallbackRequested;
    const params = [
      normalizedRequestedUserId,
      normalizedRequestedUserId,
      normalizedAuthUserId,
      normalizedAuthUserId,
    ];

    const [rows] = await connection.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching appointments:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
});
router.delete('/appointments/:id', async (req, res) => {
  const id = req.params.id;

  let connection;
  try {
    const apptId = Number(id);
    if (!apptId) return res.status(400).json({ message: 'Invalid appointment id' });

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

    let linkedTaskId = null;
    let googleEventId = null;
    let appointmentCreatedBy = null;

    // Fetch linked ids before deleting
    const selectCols = hasAppointmentTaskId ? 'task_id, created_by, google_event_id' : 'created_by, google_event_id';
    try {
      const [[row]] = await connection.query(
        `SELECT ${selectCols} FROM appointments WHERE id = ? LIMIT 1`,
        [apptId],
      );
      if (row) {
        linkedTaskId = hasAppointmentTaskId ? (Number(row.task_id || 0) || null) : null;
        googleEventId = row.google_event_id || null;
        appointmentCreatedBy = Number(row.created_by || 0) || null;
      }
    } catch (selErr) {
      // google_event_id column might not exist yet — ignore
      if (hasAppointmentTaskId) {
        const [[row]] = await connection.query(
          `SELECT task_id, created_by FROM appointments WHERE id = ? LIMIT 1`,
          [apptId],
        );
        linkedTaskId = Number((row && row.task_id) || 0) || null;
        appointmentCreatedBy = Number((row && row.created_by) || 0) || null;
      }
    }

    // Delete the appointment
    const [result] = await connection.query(
      `DELETE FROM appointments WHERE id = ?`,
      [apptId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Clear checklist linkage (legacy linkage)
    await connection.query(
      `UPDATE check_list
       SET is_appointment = 0, appointment_id = NULL
       WHERE appointment_id = ?`,
      [apptId],
    );

    // Clear task flag if we can identify linked task
    if (linkedTaskId) {
      await connection.query(
        `UPDATE tasks SET is_appointment_task = 0 WHERE id = ?`,
        [linkedTaskId],
      );
    }

    await connection.commit();

    // Remove from Google Calendar (non-blocking)
    if (googleEventId && appointmentCreatedBy) {
      try {
        await gcal.deleteEvent(appointmentCreatedBy, googleEventId);
      } catch (gcalErr) {
        console.error('Google Calendar sync (delete) error:', gcalErr.message);
      }
    }

    res.json({ message: 'Appointment deleted successfully' });

  } catch (err) {
    try {
      if (connection) await connection.rollback();
    } catch (_) {}
    console.error('Error deleting appointment:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/update_appointments/:id', async (req, res) => {
  const { id } = req.params;

  const {
    subject,
    description,
    doa,
    time_of_appointment,
    end_date,
    end_time,
    job_id,
    user_id,
    appointment_type,
    zoom_link,
    meeting_location,
  } = req.body;

  if (!id) {
    return res.status(400).json({
      code: "400",
      message: "Appointment ID is required",
      data: {},
    });
  }

  // Format date and time safely without timezone shifts
  let formattedDoa = null;
  if (doa) {
    if (typeof doa === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doa)) {
      formattedDoa = doa;
    } else {
      const d = new Date(doa);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        formattedDoa = `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  let formattedTime = null;
  if (time_of_appointment) {
    if (typeof time_of_appointment === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(time_of_appointment)) {
      formattedTime = time_of_appointment.length === 5 ? `${time_of_appointment}:00` : time_of_appointment;
    } else {
      const t = new Date(time_of_appointment);
      if (!isNaN(t.getTime())) {
        const hh = String(t.getHours()).padStart(2, '0');
        const mi = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        formattedTime = `${hh}:${mi}:${ss}`;
      }
    }
  }

  // Format end_date / end_time
  let formattedEndDate = null;
  if (end_date) {
    if (typeof end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      formattedEndDate = end_date;
    } else {
      const d = new Date(end_date);
      if (!isNaN(d.getTime())) {
        formattedEndDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    }
  }

  let formattedEndTime = null;
  if (end_time) {
    if (typeof end_time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(end_time)) {
      formattedEndTime = end_time.length === 5 ? `${end_time}:00` : end_time;
    } else {
      const t = new Date(end_time);
      if (!isNaN(t.getTime())) {
        formattedEndTime = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
      }
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const query = `
      UPDATE appointments
      SET 
        subject = ?, 
        description = ?, 
        doa = ?, 
        time_of_appointment = ?, 
        end_date = ?,
        end_time = ?,
        job_id = ?, 
        user_id = ?, 
        appointment_type = ?, 
        zoom_link = ?,
        meeting_location = ?
      WHERE id = ?
    `;

    await connection.query(query, [
      subject || null,
      description || '',
      formattedDoa,
      formattedTime,
      formattedEndDate || formattedDoa,
      formattedEndTime || formattedTime,
      job_id || null,
      user_id || null,
      appointment_type || null,
      zoom_link || null,
      meeting_location || null,
      id,
    ]);

    // Push update to Google Calendar (non-blocking)
    try {
      const [[apptRow]] = await connection.query(
        'SELECT google_event_id, created_by FROM appointments WHERE id = ? LIMIT 1',
        [id],
      );
      if (apptRow && apptRow.created_by) {
        const connected = await gcal.isConnected(apptRow.created_by);
        if (connected) {
          if (apptRow.google_event_id) {
            await gcal.updateEvent(apptRow.created_by, apptRow.google_event_id, {
              subject, description, doa: formattedDoa,
              time_of_appointment: formattedTime,
              end_date: formattedEndDate || formattedDoa,
              end_time: formattedEndTime || formattedTime,
              appointment_type, zoom_link, meeting_location,
            });
          } else {
            const googleEventId = await gcal.createEvent(apptRow.created_by, {
              subject, description, doa: formattedDoa,
              time_of_appointment: formattedTime,
              end_date: formattedEndDate || formattedDoa,
              end_time: formattedEndTime || formattedTime,
              appointment_type, zoom_link, meeting_location,
            });
            if (googleEventId) {
              await connection.query(
                'UPDATE appointments SET google_event_id = ? WHERE id = ?',
                [googleEventId, id],
              );
            }
          }
        }
      }
    } catch (gcalErr) {
      console.error('Google Calendar sync (update) error:', gcalErr.message);
    }

    return res.status(200).json({
      code: "200",
      message: "Appointment updated successfully",
      data: {},
    });
  } catch (error) {
    console.error("Error updating appointment:", error);
    return res.status(500).json({
      code: "500",
      message: "Internal server error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});



router.post("/update-rights", async (req, res) => {
  const { user_id, right_ids } = req.body;

  if (!user_id || !Array.isArray(right_ids)) {
    return res.status(400).json({ message: "Missing or invalid data" });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1️⃣ Get the user's role_id from user table
    const [userRows] = await connection.query(
      "SELECT role AS role_id FROM user WHERE id = ?",
      [user_id]
    );

    if (userRows.length === 0) {
      throw new Error("User not found");
    }

    const role_id = userRows[0].role_id;

    // 2️⃣ Delete old rights for this user
    await connection.query(
      "DELETE FROM role_right_permission WHERE user_id = ?",
      [user_id]
    );

    // 3️⃣ Insert new rights with both role_id and user_id
    if (right_ids.length > 0) {
      const values = right_ids.map((rid) => [
        role_id,
        user_id,
        rid,
        "yes",
        "yes",
        "yes",
        "yes",
      ]);

      await connection.query(
        `INSERT INTO role_right_permission 
          (role_id, user_id, right_id, \`read\`, \`create\`, \`update\`, \`delete\`) 
         VALUES ?`,
        [values]
      );
    }

    await connection.commit();
    res.status(200).json({ message: "Rights updated successfully" });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error updating rights:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/update-resignation", async (req, res) => {
  const { id, resignation_date, resignation_reason, exit_type } = req.body;

  if (!id)
    return res.status(400).json({
      code: "400",
      message: "User ID is required",
      data: {},
    });

  let connection;
  try {
    connection = await pool.getConnection();

    const query = `
      UPDATE user
      SET resignation_date = ?, resignation_reason = ?, exit_type = ? ,status = 0
      WHERE id = ?
    `;

    await connection.query(query, [
      resignation_date,
      resignation_reason,
      exit_type,
      id,
    ]);

    return res.status(200).json({
      code: "200",
      message: "Resignation details updated successfully",
      data: {},
    });
  } catch (error) {
    console.error("Error updating resignation:", error);
    return res.status(500).json({
      code: "500",
      message: "Internal server error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/reactivate-employee", async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      code: "400",
      message: "Employee ID is required",
      data: {},
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const query = `
      UPDATE user
      SET status = 1, exit_type = 0, resignation_date = NULL, resignation_reason = NULL
      WHERE id = ?
    `;
    const [result] = await connection.query(query, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: "404",
        message: "Employee not found",
        data: {},
      });
    }

    return res.status(200).json({
      code: "200",
      message: "Employee reactivated successfully",
      data: {},
    });
  } catch (error) {
    console.error("Error reactivating employee:", error);
    return res.status(500).json({
      code: "500",
      message: "Internal server error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

 
// ✅ Create Leave Type
router.post("/create", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const { leave_type, quota } = req.body;
    if (!leave_type || !quota)
      return res.status(400).json({ message: "All fields are required" });

    const created_by = req.user.id;
    const created_at = new Date();

    await connection.query(
      `INSERT INTO employees_leaves (leave_type, quota, created_at, created_by)
       VALUES (?, ?, ?, ?)`,
      [leave_type, quota, created_at, created_by]
    );

    res.status(200).json({ message: "Leave type created successfully" });
  } catch (err) {
    console.error("Error creating leave:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// ✅ Get All Leave Types
router.get("/list", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT el.*, u.name AS created_by_name
       FROM employees_leaves el
       LEFT JOIN user u ON el.created_by = u.id
       ORDER BY el.id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching leaves:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// ── Per-employee leave allowances (Vacation / Sick days set per person) ──
async function ensureEmployeeLeaveDaysColumn(connection) {
  try {
    await connection.query('ALTER TABLE employee_leaves_quota ADD COLUMN days INT NULL');
  } catch (e) { /* column already exists */ }
}
async function ensureLeaveType(connection, name, createdBy, defaultDays) {
  const [[row]] = await connection.query(
    'SELECT id FROM employees_leaves WHERE LOWER(leave_type) = LOWER(?) LIMIT 1',
    [name]
  );
  if (row) return row.id;
  const [ins] = await connection.query(
    'INSERT INTO employees_leaves (leave_type, quota, created_at, created_by) VALUES (?, ?, NOW(), ?)',
    [name, defaultDays || 0, createdBy]
  );
  return ins.insertId;
}

// Get an employee's leave categories with their per-person day allowance.
router.get('/employee-leave/:empId', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureEmployeeLeaveDaysColumn(connection);
    // One-time: rename legacy "Casual Leaves" → "Unplanned Days Off" (keeps id/history).
    const [[hasUnplanned]] = await connection.query(
      "SELECT id FROM employees_leaves WHERE LOWER(TRIM(leave_type)) = 'unplanned days off' LIMIT 1"
    );
    if (!hasUnplanned) {
      await connection.query(
        "UPDATE employees_leaves SET leave_type = 'Unplanned Days Off' WHERE LOWER(TRIM(leave_type)) = 'casual leaves'"
      );
    }
    const [rows] = await connection.query(
      `SELECT el.id AS leave_id, el.leave_type, COALESCE(elq.days, el.quota) AS days
       FROM employee_leaves_quota elq
       JOIN employees_leaves el ON el.id = elq.leave_id
       WHERE elq.emp_id = ?
       ORDER BY el.leave_type ASC`,
      [req.params.empId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('employee-leave GET error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Set an employee's leave days. body: { emp_id, items: [{ leave_type, days }] }
// Ensures each type exists globally, then upserts the per-employee day count.
router.post('/employee-leave', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { emp_id, items } = req.body;
  if (!emp_id || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'emp_id and items are required' });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureEmployeeLeaveDaysColumn(connection);
    // One-time: keep the legacy "Casual Leaves" type but rename it to
    // "Unplanned Days Off" (preserves its id, so logged history carries over).
    const [[hasUnplanned]] = await connection.query(
      "SELECT id FROM employees_leaves WHERE LOWER(TRIM(leave_type)) = 'unplanned days off' LIMIT 1"
    );
    if (!hasUnplanned) {
      await connection.query(
        "UPDATE employees_leaves SET leave_type = 'Unplanned Days Off' WHERE LOWER(TRIM(leave_type)) = 'casual leaves'"
      );
    }
    for (const it of items) {
      const name = String((it && it.leave_type) || '').trim();
      if (!name) continue;
      const days = it.days == null || it.days === '' ? null : Number(it.days);
      const leaveId = await ensureLeaveType(connection, name, userId, days || 0);
      const [[existing]] = await connection.query(
        'SELECT id FROM employee_leaves_quota WHERE emp_id = ? AND leave_id = ? LIMIT 1',
        [emp_id, leaveId]
      );
      if (existing) {
        await connection.query('UPDATE employee_leaves_quota SET days = ? WHERE id = ?', [days, existing.id]);
      } else {
        await connection.query(
          'INSERT INTO employee_leaves_quota (emp_id, leave_id, days, created_at, created_by) VALUES (?, ?, ?, NOW(), ?)',
          [emp_id, leaveId, days, userId]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('employee-leave POST error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ✅ Update Leave Type
router.put("/update/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { id } = req.params;
    const { leave_type, quota } = req.body;

    await connection.query(
      `UPDATE employees_leaves 
       SET leave_type = ?, quota = ? 
       WHERE id = ?`,
      [leave_type, quota, id]
    );

    res.json({ message: "Leave type updated successfully" });
  } catch (err) {
    console.error("Error updating leave:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// ✅ Delete Leave Type
router.delete("/delete/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { id } = req.params;

    await connection.query(`DELETE FROM employees_leaves WHERE id = ?`, [id]);

    res.json({ message: "Leave type deleted successfully" });
  } catch (err) {
    console.error("Error deleting leave:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/get_job_contacts/:job_id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const job_id = req.params.job_id;

    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
        jc.contact_id AS user_id,
        u.name,
        u.email,
        u.mobile
      FROM job_contacts jc
      JOIN user u ON jc.contact_id = u.id
      WHERE jc.job_id = ?
      ORDER BY u.name ASC
      `,
      [job_id]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching job contacts:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Remove an accepted contact connection ──────────────────────────────
router.delete('/accepted-contacts/:contactUserId', auth.authenticateToken, async (req, res) => {
  // Account-wide: any account member can remove a company contact.
  const ownerId = res.locals.working_id || req.user.id;
  const contactUserId = Number(req.params.contactUserId);
  if (!contactUserId) return res.status(400).json({ message: 'Invalid contact ID' });

  let connection;
  try {
    connection = await pool.getConnection();
    const ACCOUNT = '(SELECT id FROM `user` WHERE id = ? OR created_by = ?)';
    const [result] = await connection.query(
      `DELETE FROM contact
       WHERE (request_by IN ${ACCOUNT} AND request_to = ?)
          OR (request_to IN ${ACCOUNT} AND request_by = ?)`,
      [ownerId, ownerId, contactUserId, ownerId, ownerId, contactUserId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Connection not found' });
    }
    res.json({ message: 'Contact removed successfully' });
  } catch (err) {
    logger.error('Remove contact error:', err);
    res.status(500).json({ message: 'Failed to remove contact', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── One-time maintenance: purge duplicate contact rows for this account ──
// A person can end up with several `contact` rows linking them to the account
// (a mutual/bidirectional connection, or an old Saved/Pending row plus the
// Accept row). The contact list JOIN then draws one card per row → duplicates.
// This collapses each person to a single link, keeping an accepted connection
// (else the most recently updated one) and deleting only the redundant rows —
// never the last link to anyone. Account-scoped; safe to run more than once
// (a second run finds nothing). Pass ?dryRun=1 to preview without deleting.
router.post('/purge-duplicate-contacts', auth.authenticateToken, async (req, res) => {
  const ownerId = res.locals.working_id || req.user.id;
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  let connection;
  try {
    connection = await pool.getConnection();

    // Account = owner + everyone the owner created (employees).
    const [accountRows] = await connection.query(
      'SELECT id FROM `user` WHERE id = ? OR created_by = ?',
      [ownerId, ownerId]
    );
    const accountIds = new Set(accountRows.map((r) => Number(r.id)));

    // Every contact row that this account's contact list can surface — mirrors
    // the WHERE in GET /accepted-contacts so we only touch displayed rows.
    const [rows] = await connection.query(
      `SELECT id, request_by, request_to, status, updated_at
         FROM contact
        WHERE (status = 'Accept'
               AND (request_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)
                 OR request_to IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)))
           OR (status IN ('Pending','Saved')
               AND request_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?))`,
      [ownerId, ownerId, ownerId, ownerId, ownerId, ownerId]
    );

    // Group by the "other" party (the non-account side = the displayed person).
    const statusRank = (s) => (s === 'Accept' ? 2 : 1);
    const groups = new Map(); // otherPartyId -> rows[]
    for (const r of rows) {
      const by = Number(r.request_by);
      const to = Number(r.request_to);
      // The displayed person is whichever side is NOT an account member.
      const other = accountIds.has(by) ? to : by;
      // Skip intra-account rows (owner↔employee) — those aren't contact cards.
      if (accountIds.has(other)) continue;
      if (!groups.has(other)) groups.set(other, []);
      groups.get(other).push(r);
    }

    const toDelete = [];
    const summary = [];
    for (const [other, grp] of groups) {
      if (grp.length <= 1) continue;
      // Keep the best row: Accept beats Pending/Saved, then most recently updated.
      grp.sort((a, b) => {
        const s = statusRank(b.status) - statusRank(a.status);
        if (s !== 0) return s;
        return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
      });
      const keep = grp[0];
      const drop = grp.slice(1);
      drop.forEach((d) => toDelete.push(d.id));
      summary.push({ contactUserId: other, kept: keep.id, deleted: drop.map((d) => d.id) });
    }

    if (!dryRun && toDelete.length) {
      await connection.query(
        `DELETE FROM contact WHERE id IN (${toDelete.map(() => '?').join(',')})`,
        toDelete
      );
    }

    res.json({
      dryRun,
      duplicatePeople: summary.length,
      rowsDeleted: dryRun ? 0 : toDelete.length,
      rowsWouldDelete: toDelete.length,
      details: summary,
    });
  } catch (err) {
    logger.error('Purge duplicate contacts error:', err);
    res.status(500).json({ message: 'Failed to purge duplicate contacts', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Update a contact's profile info (business_name, license, address) ──
router.post('/update-contact-info', auth.authenticateToken, async (req, res) => {
  // Account-wide: any member of the account (owner or employee) can edit a
  // company contact, regardless of which teammate originally added it.
  const ownerId = res.locals.working_id || req.user.id;
  const { contact_user_id, mobile, email, business_name, license_number, license_state, manual_status, address, spouse_name, spouse_email, spouse_phone, first_name, last_name, spouse_last_name } = req.body;
  if (!contact_user_id) return res.status(400).json({ message: 'contact_user_id required' });

  // `name` is the canonical full display name used across the app. When the
  // Contacts form sends split first/last parts, rebuild it from them so the two
  // never drift; otherwise fall back to any `name` the caller supplied.
  const combinedName =
    (first_name != null || last_name != null)
      ? [first_name, last_name].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : null;
  const name = combinedName || req.body.name || null;

  let connection;
  try {
    connection = await pool.getConnection();

    // The contact is editable if it links an account member (owner/employee) to
    // this person, on either side of the relationship.
    const ACCOUNT = '(SELECT id FROM `user` WHERE id = ? OR created_by = ?)';
    const [[conn]] = await connection.query(
      `SELECT id FROM contact
       WHERE (request_by IN ${ACCOUNT} AND request_to = ?)
          OR (request_to IN ${ACCOUNT} AND request_by = ?)
       LIMIT 1`,
      [ownerId, ownerId, contact_user_id, ownerId, ownerId, contact_user_id]
    );
    if (!conn) return res.status(403).json({ message: 'No connection with this user' });

    await ensureCslbColumns(connection);

    // Out-of-state licenses have no auto-checker; the status is set manually
    const stateUpper = (license_state || 'CA').toUpperCase();
    let sql = `UPDATE \`user\`
       SET name = COALESCE(?, name),
           first_name = COALESCE(?, first_name),
           last_name = COALESCE(?, last_name),
           mobile = COALESCE(?, mobile),
           email = COALESCE(?, email),
           business = COALESCE(?, business),
           organization_name = COALESCE(?, organization_name),
           license_number = ?,
           license_state = ?,
           address = ?,
           spouse_name = ?,
           spouse_last_name = ?,
           spouse_email = ?,
           spouse_phone = ?`;
    const params = [
      name || null,
      first_name != null ? (first_name || '') : null,
      last_name != null ? (last_name || '') : null,
      mobile || null,
      email || null,
      business_name || null,
      business_name || null,
      license_number || null,
      license_state || null,
      address || null,
      spouse_name || null,
      spouse_last_name || null,
      spouse_email || null,
      spouse_phone || null,
    ];
    if (stateUpper !== 'CA') {
      sql += `, cslb_status = ?`;
      params.push(manual_status || null);
    }
    sql += ` WHERE id = ?`;
    params.push(contact_user_id);
    await connection.query(sql, params);

    res.json({ message: 'Contact updated successfully' });
  } catch (err) {
    logger.error('update-contact-info error:', err);
    res.status(500).json({ message: 'Failed to update contact', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Create a contact directly from the Contacts page ───────────────────
// Creates (or finds) the user, applies profile fields, and links a contact
// row. send_invite=true emails an invitation (status 'Pending');
// send_invite=false just stores them (status 'Saved').
const inviteMailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

async function sendContactInviteEmail(toEmail, inviterName) {
  await inviteMailer.sendMail({
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Invitation to Join SeeJobRun',
    text: `${inviterName} invited you to join SeeJobRun. Please sign up and accept the invitation at: https://seejobrun.com/signup`,
    html: `<p>Hello,</p><p><strong>${inviterName}</strong> invited you to join SeeJobRun.</p><p><a href="https://seejobrun.com/signup">Click here to sign up and accept the invitation.</a></p>`,
  });
}

router.post('/save-contact', auth.authenticateToken, async (req, res) => {
  // Contacts belong to the COMPANY. For employees, working_id is the account
  // owner, so the new contact (and its link) is owned by the owner's account
  // and visible to the whole team — employees never get private contacts.
  const userId = res.locals.working_id || req.user.id;
  const role = Number(req.user && req.user.role);
  if (role === 12) {
    return res.status(403).json({ message: 'You are not allowed to create contacts.' });
  }
  const {
    email, mobile, business_name, user_type, subcategory,
    license_number, license_state, address, send_invite,
    first_name, last_name,
  } = req.body;
  // `name` is the canonical full display name; build it from the split parts
  // when provided (the Contacts form now sends first/last), else accept a plain
  // `name` for backward compatibility.
  const name =
    (first_name != null || last_name != null)
      ? [first_name, last_name].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : (req.body.name || '');
  if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureCslbColumns(connection);
    await ensureContactStatusColumn(connection);
    const now = getTimeStamp();

    // Find or create the user (same mapping as the job invite flow)
    const [[existingUser]] = await connection.query(
      'SELECT id FROM user WHERE email = ? LIMIT 1', [email]
    );
    let contactUserId = existingUser ? existingUser.id : null;

    if (!contactUserId) {
      const newUserRole = user_type === 'client' ? 3 : Number(subcategory);
      const newUserCategory = user_type === 'client' ? 3 : 2;
      const newUserSubcategory = user_type === 'client' ? 11 : 12;
      const [insertResult] = await connection.query(
        `INSERT INTO user
         (name, first_name, last_name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, '', '', 1, ?, '', 0, '', ?, 0)`,
        [name, (first_name || '').trim() || null, (last_name || '').trim() || null,
         email, newUserRole, mobile || null, newUserCategory, newUserSubcategory,
         business_name || '', now, userId]
      );
      contactUserId = insertResult.insertId;
    }
    if (!contactUserId) return res.status(500).json({ message: 'Could not create contact user' });

    // Apply profile fields (only fill blanks on existing users)
    await connection.query(
      `UPDATE \`user\`
       SET mobile = IF(mobile IS NULL OR mobile = '', COALESCE(?, mobile), mobile),
           business = IF(business IS NULL OR business = '', COALESCE(?, business), business),
           first_name = IF(first_name IS NULL OR first_name = '', COALESCE(?, first_name), first_name),
           last_name = IF(last_name IS NULL OR last_name = '', COALESCE(?, last_name), last_name),
           license_number = COALESCE(license_number, ?),
           license_state = COALESCE(license_state, ?),
           address = IF(address IS NULL OR address = '', COALESCE(?, address), address)
       WHERE id = ?`,
      [mobile || null, business_name || null,
       (first_name || '').trim() || null, (last_name || '').trim() || null,
       license_number || null, license_state || null, address || null, contactUserId]
    );

    // Link the contact (unless one already exists)
    const [[existingLink]] = await connection.query(
      `SELECT id, status FROM contact
       WHERE (request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?)
       LIMIT 1`,
      [userId, contactUserId, contactUserId, userId]
    );

    const targetStatus = send_invite ? 'Pending' : 'Saved';
    if (existingLink) {
      if (existingLink.status === 'Accept') {
        return res.status(409).json({ message: 'This person is already in your contacts.' });
      }
      // Upgrade Saved → Pending when inviting; never downgrade
      if (send_invite && existingLink.status === 'Saved') {
        await connection.query(`UPDATE contact SET status = 'Pending', updated_at = NOW() WHERE id = ?`, [existingLink.id]);
      }
    } else {
      await connection.query(
        `INSERT INTO contact (request_by, request_to, status, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [userId, contactUserId, targetStatus]
      );
    }

    if (send_invite) {
      // Track for signup sync + send the email
      const [[existingInvite]] = await connection.query(
        `SELECT id FROM invited_contacts WHERE email = ? LIMIT 1`, [email]
      );
      if (!existingInvite) {
        await connection.query(
          `INSERT INTO invited_contacts (name, email, status, created_at, created_by)
           VALUES (?, ?, 0, ?, ?)`,
          [name, email, now, userId]
        );
      }
      const [[me]] = await connection.query('SELECT name FROM user WHERE id = ?', [userId]);
      try {
        await sendContactInviteEmail(email, me ? me.name : 'A SeeJobRun user');
      } catch (mailErr) {
        logger.error('Invite email failed:', mailErr);
        return res.json({ contact_user_id: contactUserId, status: targetStatus, email_sent: false, message: 'Contact saved, but the invitation email could not be sent. Try Resend Invitation later.' });
      }
    }

    res.json({ contact_user_id: contactUserId, status: targetStatus, email_sent: !!send_invite });
  } catch (err) {
    logger.error('save-contact error:', err);
    res.status(500).json({ message: 'Failed to save contact', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Quick setup: create contractor contacts from a list of CA license #s ──
// For each license number we look it up on CSLB (name/address/phone/class/
// status) and create a "Saved" subcontractor contact. No email exists on CSLB,
// so a placeholder lic-<num>@no-email.invalid is used. Backward-safe: dupes by
// that email are reused, not duplicated.
router.post('/bulk-create-from-licenses', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const role = Number(req.user && req.user.role);
  if (role === 12) {
    return res.status(403).json({ message: 'You are not allowed to create contacts.' });
  }
  const list = Array.isArray(req.body && req.body.license_numbers) ? req.body.license_numbers : [];
  if (!list.length) return res.status(400).json({ message: 'No license numbers provided.' });

  let connection;
  const created = [];
  const skipped = [];
  const failed = [];
  try {
    connection = await pool.getConnection();
    await ensureCslbColumns(connection);
    await ensureContactStatusColumn(connection);

    for (const raw of list) {
      const cleaned = String(raw || '').replace(/[^a-zA-Z0-9]/g, '').trim();
      if (!cleaned) { failed.push({ license_number: raw, reason: 'Invalid' }); continue; }

      // Each license is isolated: a problem with one never fails the batch.
      try {
        let info;
        try { info = await checkLicense(cleaned); } catch (e) { info = { status: 'Error' }; }

        if (['Not Found', 'Invalid #', 'No License #'].includes(info.status)) {
          failed.push({ license_number: cleaned, reason: info.status });
          continue;
        }

        const name = (info.name && info.name.trim()) || `Contractor (Lic ${cleaned})`;
        const email = `lic-${cleaned.toLowerCase()}@no-email.invalid`;
        const phone = info.phone || null;
        const now = getTimeStamp();

        // Skip when this license already coincides with an existing record —
        // by license number, by our placeholder email, or by mobile number
        // (user.mobile is UNIQUE, so a shared phone means it's already a
        // contact, often the user's own profile).
        const dupeConds = ['license_number = ?', 'email = ?'];
        const dupeParams = [cleaned, email];
        if (phone) { dupeConds.push("(mobile IS NOT NULL AND mobile <> '' AND mobile = ?)"); dupeParams.push(phone); }
        const [[dupe]] = await connection.query(
          `SELECT id, name FROM \`user\` WHERE ${dupeConds.join(' OR ')} LIMIT 1`,
          dupeParams
        );
        if (dupe) {
          skipped.push({ license_number: cleaned, name: dupe.name || name, reason: 'Already a contact' });
          continue;
        }

        const [ins] = await connection.query(
          `INSERT INTO user
           (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
           VALUES (?, ?, '', 12, ?, 2, 12, ?, '', '', 1, ?, '', 0, '', ?, 0)`,
          [name, email, phone, name, now, userId]
        );
        const contactUserId = ins.insertId;

        await connection.query(
          `UPDATE \`user\` SET
             address = IF(address IS NULL OR address = '', COALESCE(?, address), address),
             license_number = ?,
             license_state = 'CA',
             cslb_status = ?, cslb_classification = ?, cslb_address = ?, cslb_phone = ?, cslb_checked_at = ?
           WHERE id = ?`,
          [info.address || null, cleaned,
           info.status || null, info.classification || null, info.address || null, phone, now, contactUserId]
        );

        const [[link]] = await connection.query(
          `SELECT id FROM contact
           WHERE (request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?) LIMIT 1`,
          [userId, contactUserId, contactUserId, userId]
        );
        if (!link) {
          await connection.query(
            `INSERT INTO contact (request_by, request_to, status, created_at, updated_at)
             VALUES (?, ?, 'Saved', NOW(), NOW())`,
            [userId, contactUserId]
          );
        }

        created.push({ id: contactUserId, name, license_number: cleaned, cslb_status: info.status || 'Unknown' });
      } catch (e) {
        // Duplicate mobile/email (or any per-row issue) → skip, keep going.
        if (e && e.code === 'ER_DUP_ENTRY') {
          skipped.push({ license_number: cleaned, reason: 'Already a contact' });
        } else {
          logger.error(`bulk-create license ${cleaned} failed:`, e);
          failed.push({ license_number: cleaned, reason: 'Error' });
        }
      }
    }

    res.json({ created, skipped, failed, total: list.length });
  } catch (err) {
    logger.error('bulk-create-from-licenses error:', err);
    res.status(500).json({ message: 'Failed to create contacts from licenses', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Resend (or first-send) an invitation for a Pending/Saved contact ───
router.post('/resend-invite/:contactUserId', auth.authenticateToken, async (req, res) => {
  // Account-wide: any account member can resend a company contact's invite.
  const ownerId = res.locals.working_id || req.user.id;
  const contactUserId = Number(req.params.contactUserId);
  let connection;
  try {
    connection = await pool.getConnection();
    const [[link]] = await connection.query(
      `SELECT id, status FROM contact
       WHERE request_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)
         AND request_to = ? AND status IN ('Pending','Saved')
       LIMIT 1`,
      [ownerId, ownerId, contactUserId]
    );
    if (!link) return res.status(404).json({ message: 'No pending contact found' });

    const [[contactUser]] = await connection.query(
      'SELECT name, email FROM user WHERE id = ?', [contactUserId]
    );
    if (!contactUser || !contactUser.email || contactUser.email.endsWith('@no-email.invalid')) {
      return res.status(404).json({ message: 'This contact has no email on file yet — add one in Edit first.' });
    }

    const [[existingInvite]] = await connection.query(
      `SELECT id FROM invited_contacts WHERE email = ? LIMIT 1`, [contactUser.email]
    );
    if (!existingInvite) {
      await connection.query(
        `INSERT INTO invited_contacts (name, email, status, created_at, created_by)
         VALUES (?, ?, 0, ?, ?)`,
        [contactUser.name, contactUser.email, getTimeStamp(), userId]
      );
    }
    if (link.status === 'Saved') {
      await connection.query(`UPDATE contact SET status = 'Pending', updated_at = NOW() WHERE id = ?`, [link.id]);
    }

    const [[me]] = await connection.query('SELECT name FROM user WHERE id = ?', [userId]);
    await sendContactInviteEmail(contactUser.email, me ? me.name : 'A SeeJobRun user');
    res.json({ message: 'Invitation sent', status: 'Pending' });
  } catch (err) {
    logger.error('resend-invite error:', err);
    res.status(500).json({ message: 'Failed to send invitation', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Check one contact's license against CSLB (runs after a contact save) ──
// Only California licenses can be auto-verified; other states are stored
// without a status until per-state checkers are added.
router.post('/check-license/:contactUserId', auth.authenticateToken, async (req, res) => {
  // Account-wide: any account member can run a CSLB check on a company contact.
  const ownerId = res.locals.working_id || req.user.id;
  const contactUserId = req.params.contactUserId;
  let connection;
  try {
    connection = await pool.getConnection();

    // The contact is valid if it links an account member to this person.
    const ACCOUNT = '(SELECT id FROM `user` WHERE id = ? OR created_by = ?)';
    const [[conn]] = await connection.query(
      `SELECT id FROM contact
       WHERE (request_by IN ${ACCOUNT} AND request_to = ?)
          OR (request_to IN ${ACCOUNT} AND request_by = ?)
       LIMIT 1`,
      [ownerId, ownerId, contactUserId, ownerId, ownerId, contactUserId]
    );
    if (!conn) return res.status(403).json({ message: 'No connection with this user' });

    await ensureCslbColumns(connection);

    const [[contact]] = await connection.query(
      `SELECT id, license_number, license_state FROM \`user\` WHERE id = ?`,
      [contactUserId]
    );
    if (!contact || !contact.license_number) {
      return res.json({ checked: false, reason: 'no_license' });
    }
    const state = (contact.license_state || 'CA').toUpperCase();
    if (state !== 'CA') {
      // No checker for this state yet — clear CSLB-sourced details but keep
      // any manually-set Active/Inactive status
      await connection.query(
        `UPDATE \`user\` SET cslb_classification = NULL,
         cslb_address = NULL, cslb_phone = NULL, cslb_checked_at = NULL WHERE id = ?`,
        [contactUserId]
      );
      return res.json({ checked: false, reason: 'unsupported_state', state });
    }

    const result = await checkLicense(contact.license_number);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await connection.query(
      `UPDATE \`user\`
       SET cslb_status = ?, cslb_checked_at = ?,
           cslb_classification = ?,
           cslb_address = ?,
           cslb_phone = ?,
           -- Pull the CSLB business name in as the contact's company name.
           business = COALESCE(NULLIF(?, ''), business),
           organization_name = COALESCE(NULLIF(?, ''), organization_name),
           mobile = IF(mobile IS NULL OR mobile = '', COALESCE(?, mobile), mobile),
           address = IF(address IS NULL OR address = '', COALESCE(?, address), address)
       WHERE id = ?`,
      [result.status, now, result.classification || null, result.address || null,
       result.phone || null, result.name || null, result.name || null,
       result.phone || null, result.address || null, contactUserId]
    );

    const [[updated]] = await connection.query(
      `SELECT mobile, address, cslb_status, cslb_checked_at, cslb_classification,
              cslb_address, cslb_phone
       FROM \`user\` WHERE id = ?`,
      [contactUserId]
    );
    res.json({ checked: true, ...updated });
  } catch (err) {
    logger.error('check-license error:', err);
    res.status(500).json({ message: 'License check failed', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ── Check all contractor licenses against CSLB ─────────────────────────
router.get('/check-licenses', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  let connection;
  try {
    connection = await pool.getConnection();

    await ensureCslbColumns(connection);

    // Get all accepted contacts who are contractors and have a license number
    const [contractors] = await connection.query(
      `SELECT DISTINCT
         u.id,
         u.name,
         COALESCE(u.business, u.organization_name, '') AS business_name,
         u.license_number,
         u.cslb_status,
         u.cslb_checked_at,
         u.cslb_classification,
         u.cslb_address,
         u.cslb_phone,
         cat.name AS position
       FROM contact c
       JOIN user u ON (u.id = IF(c.request_by = ?, c.request_to, c.request_by))
       LEFT JOIN category cat ON cat.id = u.category
       WHERE c.status = 'Accept'
         AND (c.request_by = ? OR c.request_to = ?)
         AND u.license_number IS NOT NULL
         AND u.license_number != ''`,
      [userId, userId, userId]
    );

    if (!contractors.length) {
      return res.json({ checked: 0, results: [], message: 'No contractors with license numbers found. Add a license # to a contractor contact first.' });
    }

    // Only contact CSLB for licenses not checked within the last 24 hours.
    // Recently-checked ones are served from the database — the nightly cron
    // keeps them fresh. This caps CSLB traffic regardless of user count.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - DAY_MS;
    const stale = contractors.filter(c => !c.cslb_checked_at || new Date(c.cslb_checked_at).getTime() < cutoff);
    const cached = contractors.filter(c => !stale.includes(c));

    let updated = [];
    if (stale.length) {
      // Run CSLB checks (sequential with delay — respectful to CSLB server)
      updated = await checkAllLicenses(stale);

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      for (const r of updated) {
        await connection.query(
          `UPDATE \`user\`
           SET cslb_status = ?, cslb_checked_at = ?,
               cslb_classification = COALESCE(?, cslb_classification),
               cslb_address = COALESCE(?, cslb_address),
               cslb_phone = COALESCE(?, cslb_phone),
               mobile = IF(mobile IS NULL OR mobile = '', COALESCE(?, mobile), mobile),
               address = IF(address IS NULL OR address = '', COALESCE(?, address), address)
           WHERE id = ?`,
          [r.cslb_status, now, r.cslb_classification, r.cslb_address, r.cslb_phone, r.cslb_phone, r.cslb_address, r.id]
        );
        r.cslb_checked_at = now;
      }
    }

    const results = [...updated, ...cached];
    const flagged = results.filter(r => !['Active', 'No License #', 'Unknown'].includes(r.cslb_status));
    res.json({ checked: updated.length, cached: cached.length, flagged: flagged.length, results });
  } catch (err) {
    logger.error('check-licenses error:', err);
    res.status(500).json({ message: 'License check failed', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;