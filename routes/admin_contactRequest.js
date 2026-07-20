const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require('nodemailer');
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const admin = require("../config/firebase-admin");
const crypto = require("crypto");


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
  // Fail fast instead of hanging forever when the SMTP server is unreachable.
  // Without these, an unreachable/dead SMTP host blocks routes that await
  // sendMail (e.g. login-otp-request) indefinitely, leaving the login screen
  // stuck on "Sending...". These bound the connect/greeting/idle waits so the
  // request rejects (and the UI shows an error) within ~10-15s.
  connectionTimeout: 10000, // ms to establish the TCP connection
  greetingTimeout: 10000,   // ms to wait for the SMTP greeting
  socketTimeout: 15000,     // ms of socket inactivity before aborting
});

// Optional: verify transporter
transporter.verify((err, success) => {
  if (err) {
    logger.error("SMTP connection failed:", err);
  } else {
    logger.info("SMTP server is ready to send emails");
  }
});

async function sendContactEmail(data) {
  const { firstName, lastName, email, phone, message } = data;

  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: "poul@oakcoast.net",
    subject: "New Contact Form Submission",

    html: `
      <div style="font-family: Arial; max-width: 600px; margin: auto;">
        <div style="background:#4CAF50;color:#fff;padding:15px;text-align:center;">
          <h2>New Contact Request</h2>
        </div>

        <div style="padding:20px;border:1px solid #ddd;background:#f9f9f9;">
          <p><strong>Name:</strong> ${firstName} ${lastName}</p>
          <p><strong>Email:</strong> ${email || "N/A"}</p>
          <p><strong>Phone:</strong> ${phone || "N/A"}</p>

          <div style="margin-top:15px;padding:10px;background:#e8f5e9;">
            <strong>Message:</strong>
            <p>${message}</p>
          </div>
        </div>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info("Contact email sent!");
  } catch (error) {
    logger.error("Email error:", error);
  }
}

function generateOTP() {
  const digits = "0123456789";
  let OTP = "";
  for (let i = 0; i < 4; i++) {
    OTP += digits[Math.floor(Math.random() * 10)];
  }
  return OTP;
}

function generateDeviceToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendOTPEmail(toEmail, otp) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "Your OTP Verification Code",
    text: `Your OTP code is: ${otp}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>OTP Verification</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .logo-container { text-align: center; padding: 20px 0; }
            .logo { max-width: 150px; height: auto; }
            .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; }
            .otp-box { background-color: #e8f5e9; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #777; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo-container">
              <img src="http://seejobrun.com/user-dashboard/assets/seeJobRun.png" alt="SeeJobRun Logo" class="logo">
            </div>
            <div class="header">
              <h1>SeeJobRun</h1>
            </div>
            <div class="content">
              <h2>OTP Verification</h2>
              <p>Hello,</p>
              <p>Please use the following OTP code to verify your email address:</p>
              <div class="otp-box">${otp}</div>
              <p>This code will expire in 3 minutes. If you didn't request this verification, please ignore this email.</p>
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
    logger.info("OTP email sent successfully!");
  } catch (error) {
    logger.error("Error sending OTP email:", error);
    throw error;
  }
}

router.post("/create_admin_user", auth.authenticateToken, async (req, res) => {
  const currentTimestamp = getTimeStamp();
  const r = req.body || {};
  let connection;

  if (!r.name || !r.email || !r.category || !r.subcategory) {
    return res.status(400).json({
      success: false,
      message: "name, email, category and subcategory are required",
      data: {},
    });
  }

  const normalizedEmail = String(r.email).trim();
  if (!normalizedEmail) {
    return res.status(400).json({
      success: false,
      message: "Email is required",
      data: {},
    });
  }

  try {
    connection = await pool.getConnection();

    const [existingRows] = await connection.execute(
      "SELECT id FROM admin_users WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );

    if (existingRows.length) {
      return res.status(200).json({
        success: false,
        code: "409",
        message: "Email already exists",
        data: {},
      });
    }

    const otp = generateOTP();
    const createdBy = req.user && req.user.id ? req.user.id : r.created_by || null;
    const role = r.role || r.subcategory;

    const [result] = await connection.execute(
      `INSERT INTO admin_users
       (name, email, category, subcategory, otp, role, otp_status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.name,
        normalizedEmail,
        Number(r.category),
        Number(r.subcategory),
        Number(otp),
        Number(role),
        1,
        currentTimestamp,
        createdBy,
      ]
    );

    await sendOTPEmail(normalizedEmail, otp);

    return res.status(201).json({
      success: true,
      code: "201",
      message: "Admin user created successfully. OTP sent to email.",
      data: {
        id: result.insertId,
      },
    });
  } catch (err) {
    logger.error("Create admin user error:", err);
    return res.status(500).json({
      success: false,
      code: "500",
      message: "Database or server error",
      error: err.message,
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/login-otp-request", async (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ code: "400", message: "Email is required", data: {} });
  }

  const normalizedEmail = String(email).trim();
  let connection;

  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT id FROM admin_users WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );

    if (!rows.length) {
      return res.status(200).json({ code: "404", message: "Email does not exist", data: {} });
    }

    const adminUser = rows[0];
    const otp = generateOTP();

    await connection.query(
      "UPDATE admin_users SET otp = ?, otp_status = 1, created_at = NOW() WHERE id = ?",
      [Number(otp), Number(adminUser.id)]
    );

    await sendOTPEmail(normalizedEmail, otp);

    return res.status(200).json({ code: "200", message: "OTP sent", data: {} });
  } catch (error) {
    logger.error(`- ${normalizedEmail} - ${new Date()} - Admin login OTP request error:`, error);
    return res.status(200).json({ code: "500", message: "Internal Server Error", data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/login-otp-verify", async (req, res) => {
  const { email, otp } = req.body || {};

  if (!email || !otp) {
    return res.status(400).json({
      code: "400",
      message: "Email and OTP are required.",
      data: {},
    });
  }

  const normalizedEmail = String(email).trim();
  const normalizedOtpDigits = String(otp).trim().replace(/\D/g, "");

  if (normalizedOtpDigits.length !== 4) {
    return res.status(200).json({
      code: "400",
      message: "Invalid or expired OTP.",
      data: {},
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT 
          au.id,
          au.name,
          au.email,
          au.category,
          au.subcategory,
          au.role,
          au.otp_status,
          au.created_by,
          sub.name AS subcategory_name,
          cat.name AS category_name
       FROM admin_users au
       LEFT JOIN subcategory sub ON au.subcategory = sub.id
       LEFT JOIN category cat ON cat.id = au.category
       WHERE au.email = ?
         AND LPAD(CAST(au.otp AS CHAR), 4, '0') = ?
         AND au.otp_status = 1
         AND au.created_at >= (NOW() - INTERVAL 3 MINUTE)
       LIMIT 1`,
      [normalizedEmail, normalizedOtpDigits]
    );

    if (!rows.length) {
      return res.status(200).json({
        code: "400",
        message: "Invalid or expired OTP.",
        data: {},
      });
    }

    const adminUser = rows[0];
    const { id, name, role, created_by } = adminUser;

    const deviceToken = generateDeviceToken();

    res.cookie("device_token", deviceToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    await connection.query(
      "UPDATE admin_users SET otp_status = 0, otp = 0 WHERE id = ?",
      [id]
    );

    const [rightsRows] = await connection.query(
      `SELECT 
          right_id,
          \`read\`,
          \`create\`,
          \`update\`,
          \`delete\`,
          user_id
       FROM role_right_permission
       WHERE user_id = ?`,
      [id]
    );

    const rights = rightsRows || [];
    const working_id = created_by || id;

    const response = {
      id,
      name,
      email: normalizedEmail,
      category: adminUser.category,
      subcategory: adminUser.subcategory,
      role,
      subcategory_name: adminUser.subcategory_name,
      category_name: adminUser.category_name,
      rights,
      working_id,
      otp_status: 0,
      user_type: "admin",
    };

    const accessToken = jwt.sign(
      response,
      process.env.ACCESS_TOKEN,
      { expiresIn: "7d" }
    );

    logger.info(`Admin login successful (OTP): Admin User ID - ${id} - ${new Date()}`);

    return res.status(200).json({
      code: "200",
      message: "Login successful",
      data: {
        token: accessToken,
        basicData: response,
        photoName: "user.png",
      },
    });
  } catch (error) {
    logger.error(
      `- ${normalizedEmail} - ${new Date()} - Admin login OTP verify error:`,
      error
    );

    return res.status(200).json({
      code: "500",
      message: "Internal Server Error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/contact",
  async (req, res) => {
    let connection;

    try {
      const { firstName, lastName, email, phone, message } = req.body;

      // Validation
      if (!firstName || !lastName || !message) {
        return res.status(400).json({
          success: false,
          message: "First name, last name and message are required",
        });
      }

      connection = await pool.getConnection();

      // 1ï¸âƒ£ Insert into DB
      const [result] = await connection.execute(
        `INSERT INTO contact_request 
        (firstName, lastName, email, phone, message)
        VALUES (?, ?, ?, ?, ?)`,
        [
          firstName,
          lastName,
          email ?? null,
          phone ?? null,
          message,
        ]
      );

      // 2ï¸âƒ£ Send Email AFTER successful insert
      await sendContactEmail({
        firstName,
        lastName,
        email,
        phone,
        message,
      });

      res.status(201).json({
        success: true,
        message: "Contact request submitted successfully",
        id: result.insertId,
      });

    } catch (err) {
      logger.error("Contact request error:", err);
      res.status(500).json({
        success: false,
        message: "Database error",
        error: err.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);

// sendDemoEmail.js
async function sendDemoEmail(data) {
  const { firstName, lastName, email, phone, message } = data;

  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: "poul@oakcoast.net",
    subject: "New Demo Request",
    html: `
      <div style="font-family: Arial; max-width: 600px; margin: auto;">
        <div style="background:#2196F3;color:#fff;padding:15px;text-align:center;">
          <h2>New Demo Request</h2>
        </div>
        <div style="padding:20px;border:1px solid #ddd;background:#f9f9f9;">
          <p><strong>Name:</strong> ${firstName} ${lastName}</p>
          <p><strong>Email:</strong> ${email || "N/A"}</p>
          <p><strong>Phone:</strong> ${phone || "N/A"}</p>
          <div style="margin-top:15px;padding:10px;background:#e3f2fd;">
            <strong>Message / Request Details:</strong>
            <p>${message}</p>
          </div>
        </div>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info("Demo request email sent!");
  } catch (error) {
    logger.error("Demo email error:", error);
  }
}

// --- 2ï¸âƒ£ API route for demo requests ---
router.post("/demo_request", async (req, res) => {
  let connection;
  const { firstName, lastName, email, phone, message } = req.body;

  try {
    // Basic validation
    if (!firstName || !lastName || !message) {
      return res.status(400).json({
        success: false,
        message: "First name, last name, and message are required",
      });
    }

    connection = await pool.getConnection();

    // Insert into demo_request table
    const [result] = await connection.execute(
      `INSERT INTO demo_request
       (firstName, lastName, email, phone,  message)
       VALUES (?, ?, ?, ?, ?)`,
      [firstName, lastName, email ?? null, phone ?? null, message]
    );

    // Send email after insert
    await sendDemoEmail({ firstName, lastName, email, phone, message });

    res.status(201).json({
      success: true,
      message: "Demo request submitted successfully",
      id: result.insertId,
    });

  } catch (err) {
    logger.error("Demo request error:", err);
    res.status(500).json({
      success: false,
      message: "Database or server error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/contact_list", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
        id,
        firstName,
        lastName,
        email,
        phone,
        message
      FROM contact_request
      ORDER BY id DESC
      `
    );

    res.json({
      success: true,
      data: rows,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/demo_request_list", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
        id,
        firstName,
        lastName,
        email,
        phone,
        message
      FROM demo_request
      ORDER BY id DESC
      `
    );

    res.json({
      success: true,
      data: rows,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/user_list", async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
              SELECT 
  u.id,
  u.name,
  u.email,
  u.mobile,
  u.status,

  s.status AS subscription_status,
  p.name AS package_name,
  p.amount

FROM user u

LEFT JOIN subscriptions s 
  ON s.id = (
    SELECT s2.id
    FROM subscriptions s2
    WHERE s2.user_id = u.id
    ORDER BY s2.id DESC   -- latest subscription
    LIMIT 1
  )

LEFT JOIN plans p 
  ON p.id = s.plan_id

ORDER BY u.id DESC;
      `
    );

    res.json({
      success: true,
      data: rows,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/update_user_status", async (req, res) => {
  let connection;

  try {
    const { user_id, status } = req.body;

    if (!user_id || status === undefined) {
      return res.status(400).json({
        success: false,
        message: "user_id and status are required",
      });
    }

    connection = await pool.getConnection();

    await connection.execute(
      `
      UPDATE user
      SET status = ?
      WHERE id = ?
      `,
      [status, user_id]
    );

    res.json({
      success: true,
      message: "User status updated successfully",
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// RETIRED 2026-07-20. This endpoint had NO authentication and ran a bare
// single-row user delete with zero child cleanup — it orphaned all of a
// user's data and was an unauthenticated bypass around every safeguard. Account
// deletion now goes exclusively through the owner-gated, two-step, cascade-aware
// flow: GET /payments/admin/account-delete-preview/:id then
// DELETE /payments/admin/account/:id (requireAdmin + typed-email confirmation +
// full cascade + ARB cancel + employee detach, all in one transaction). This stub
// stays only so any stale caller gets a clear 410 instead of silently deleting.
router.post("/delete_user", (req, res) => {
  return res.status(410).json({
    success: false,
    code: "ENDPOINT_RETIRED",
    message:
      "This endpoint has been retired. Use the Admin Plan & Payment Status page (owner-only) to delete an account safely.",
  });
});

router.get('/rights', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query("SELECT * FROM `right` where admin_module = 1 ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching rights:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/admin_user_list", auth.authenticateToken, async (req, res) => {
  const loggedInUserId = req.user.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
    SELECT 
      au.id,
      au.name,
      au.email,
      au.category,
      au.subcategory,

      sub.name AS subcategory_name,
      cat.name AS category_name,

      JSON_ARRAYAGG(
        JSON_OBJECT(
          'right_id', rrp.right_id,
          'role_id', rrp.role_id,
          'read', rrp.read,
          'create', rrp.create,
          'update', rrp.update,
          'delete', rrp.delete
        )
      ) AS permissions

    FROM admin_users au

    LEFT JOIN subcategory sub ON au.subcategory = sub.id
    LEFT JOIN category cat ON cat.id = au.category

    LEFT JOIN role_right_permission rrp 
      ON rrp.user_id = au.id

    WHERE au.created_by = ?

    GROUP BY au.id

    ORDER BY au.id DESC
    `, [loggedInUserId]);
    res.json({
      success: true,
      data: rows,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/update_admin_user", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    const {
      user_id,
      name,
      email,
      category,
      subcategory,
      right_ids,
    } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    if (!name || !email || !category || !subcategory) {
      return res.status(400).json({
        success: false,
        message: "name, email, category and subcategory are required",
      });
    }

    const normalizedEmail = String(email).trim();
    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existingRows] = await connection.execute(
      "SELECT id FROM admin_users WHERE email = ? AND id <> ? LIMIT 1",
      [normalizedEmail, user_id]
    );

    if (existingRows.length) {
      await connection.rollback();
      return res.status(200).json({
        success: false,
        code: "409",
        message: "Email already exists",
        data: {},
      });
    }

    const [result] = await connection.execute(
      `
      UPDATE admin_users
      SET
        name = ?,
        email = ?,
        category = ?,
        subcategory = ?,
        role = ?
      WHERE id = ?
      `,
      [
        name,
        normalizedEmail,
        Number(category),
        Number(subcategory),
        Number(subcategory),
        user_id,
      ]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Admin user not found",
      });
    }

    await connection.execute(
      "DELETE FROM role_right_permission WHERE user_id = ?",
      [user_id]
    );

    if (Array.isArray(right_ids) && right_ids.length > 0) {
      const values = right_ids.map((rightId) => [
        Number(subcategory),
        user_id,
        Number(rightId),
        "yes",
        "yes",
        "yes",
        "yes",
      ]);

      await connection.query(
        `
        INSERT INTO role_right_permission
          (role_id, user_id, right_id, \`read\`, \`create\`, \`update\`, \`delete\`)
        VALUES ?
        `,
        [values]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Admin user updated successfully",
    });
  } catch (err) {
    if (connection) await connection.rollback();
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});
router.get("/support_ticket_list", auth.authenticateToken, async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    // =========================
    // 1. GET TICKETS
    // =========================
    const [tickets] = await connection.execute(`
      SELECT 
        st.id,
        st.client_email,
        st.client_contact,
        st.subject,
        st.message,
        st.attachment,
        st.created_at,
        st.updated_at,

        st.status_id,
        sts.name AS status_name,

        st.priority_id,
        st.assigned_to
      FROM support_ticket st
      LEFT JOIN support_ticket_status_lookup sts 
        ON sts.id = st.status_id
      ORDER BY st.id DESC
    `);

    // =========================
    // 2. GET COUNTS
    // =========================
    const [counts] = await connection.execute(`
      SELECT 
        COUNT(*) AS total,

        SUM(CASE WHEN st.status_id = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN st.status_id = 2 THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN st.status_id IN (3,4) THEN 1 ELSE 0 END) AS completed

      FROM support_ticket st
    `);

    res.json({
      success: true,
      data: tickets,
      counts: counts[0]
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});
module.exports = router;

