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
const { checkAllLicenses } = require("../services/cslbChecker");

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
    const request_by = (req.user && req.user.id);
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

    // url will come to dashboard (same structure as your other API)
    const url = `/invitation`; // update if you have specific page

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
      WHERE c.request_to  = ? and c.status != 'Accept'
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
  const userId = req.user.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const sql = `
      SELECT
        u.id,
        u.name,
        u.email,
        u.image,
        u.mobile,
        u.created_at AS joined_at,
        sub.name AS subcategory_name,
        cat.name AS position,
        COALESCE(u.business, u.organization_name, '') AS business_name,
        u.license_number,
        u.address,
        u.cslb_status,
        u.cslb_checked_at,
        (
          SELECT COUNT(*) FROM contact
          WHERE status = 'Accept' AND (request_by = u.id OR request_to = u.id)
        ) AS total_connections,
        c.updated_at AS connected_at
      FROM contact c
      JOIN user u ON (u.id = IF(c.request_by = ?, c.request_to, c.request_by))
      LEFT JOIN subcategory sub ON u.subcategory = sub.id
      LEFT JOIN category cat ON cat.id = u.category
      WHERE c.status = 'Accept' AND (c.request_by = ? OR c.request_to = ?)
      ORDER BY c.updated_at DESC
    `;

    const [rows] = await connection.query(sql, [userId, userId, userId]);

    res.json(rows);
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

    const query = 'SELECT u.id,u.name,u.email,u.mobile,u.employment_type,u.rate,u.resignation_date,u.resignation_reason,u.exit_type,sub.name AS subcategory_name,cat.name AS position,u.created_at AS hiringDate,GROUP_CONCAT(DISTINCT el.leave_type SEPARATOR " , ") AS leave_types,GROUP_CONCAT(DISTINCT el.quota SEPARATOR ", ") AS leave_quotas,GROUP_CONCAT(DISTINCT r.display_name SEPARATOR ", ") AS rights FROM user u LEFT JOIN subcategory sub ON u.subcategory=sub.id LEFT JOIN category cat ON cat.id=u.category LEFT JOIN employee_leaves_quota elq ON elq.emp_id=u.id LEFT JOIN employees_leaves el ON el.id=elq.leave_id LEFT JOIN role_right_permission rrp ON rrp.user_id=u.id AND rrp.role_id=u.subcategory LEFT JOIN `right` r ON r.id=rrp.right_id WHERE u.created_by=? AND u.category=1 GROUP BY u.id,u.name,u.email,u.mobile,u.employment_type,u.rate,u.resignation_date,u.resignation_reason,u.exit_type,sub.name,cat.name,u.created_at ORDER BY u.created_at DESC;'


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
  const userId = req.user.id;
  const contactUserId = Number(req.params.contactUserId);
  if (!contactUserId) return res.status(400).json({ message: 'Invalid contact ID' });

  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.query(
      `DELETE FROM contact
       WHERE status = 'Accept'
         AND ((request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?))`,
      [userId, contactUserId, contactUserId, userId]
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

// ── Update a contact's profile info (business_name, license, address) ──
router.post('/update-contact-info', auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { contact_user_id, name, mobile, email, business_name, license_number, address } = req.body;
  if (!contact_user_id) return res.status(400).json({ message: 'contact_user_id required' });

  let connection;
  try {
    connection = await pool.getConnection();

    // Verify an accepted connection exists
    const [[conn]] = await connection.query(
      `SELECT id FROM contact
       WHERE status = 'Accept'
         AND ((request_by = ? AND request_to = ?) OR (request_by = ? AND request_to = ?))
       LIMIT 1`,
      [userId, contact_user_id, contact_user_id, userId]
    );
    if (!conn) return res.status(403).json({ message: 'No accepted connection with this user' });

    // Ensure columns exist (safe one-time migration)
    for (const [col, def] of [
      ['license_number', 'VARCHAR(100) DEFAULT NULL'],
      ['address', 'TEXT DEFAULT NULL'],
      ['cslb_status', 'VARCHAR(50) DEFAULT NULL'],
      ['cslb_checked_at', 'DATETIME DEFAULT NULL'],
    ]) {
      const [[row]] = await connection.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = ?`,
        [col]
      );
      if (!row) await connection.query(`ALTER TABLE \`user\` ADD COLUMN \`${col}\` ${def}`);
    }

    await connection.query(
      `UPDATE \`user\`
       SET name = COALESCE(?, name),
           mobile = COALESCE(?, mobile),
           email = COALESCE(?, email),
           business = COALESCE(?, business),
           organization_name = COALESCE(?, organization_name),
           license_number = ?,
           address = ?
       WHERE id = ?`,
      [
        name || null,
        mobile || null,
        email || null,
        business_name || null,
        business_name || null,
        license_number || null,
        address || null,
        contact_user_id,
      ]
    );

    res.json({ message: 'Contact updated successfully' });
  } catch (err) {
    logger.error('update-contact-info error:', err);
    res.status(500).json({ message: 'Failed to update contact', error: err.message });
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

    // Ensure columns exist
    for (const [col, def] of [
      ['license_number', 'VARCHAR(100) DEFAULT NULL'],
      ['cslb_status', 'VARCHAR(50) DEFAULT NULL'],
      ['cslb_checked_at', 'DATETIME DEFAULT NULL'],
    ]) {
      const [[row]] = await connection.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = ?`,
        [col]
      );
      if (!row) await connection.query(`ALTER TABLE \`user\` ADD COLUMN \`${col}\` ${def}`);
    }

    // Get all accepted contacts who are contractors and have a license number
    const [contractors] = await connection.query(
      `SELECT DISTINCT
         u.id,
         u.name,
         COALESCE(u.business, u.organization_name, '') AS business_name,
         u.license_number,
         u.cslb_status,
         u.cslb_checked_at,
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

    // Run CSLB checks (sequential with delay — respectful to CSLB server)
    const results = await checkAllLicenses(contractors);

    // Persist updated statuses
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const r of results) {
      await connection.query(
        `UPDATE \`user\` SET cslb_status = ?, cslb_checked_at = ? WHERE id = ?`,
        [r.cslb_status, now, r.id]
      );
      r.cslb_checked_at = now;
    }

    const flagged = results.filter(r => !['Active', 'No License #', 'Unknown'].includes(r.cslb_status));
    res.json({ checked: results.length, flagged: flagged.length, results });
  } catch (err) {
    logger.error('check-licenses error:', err);
    res.status(500).json({ message: 'License check failed', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;