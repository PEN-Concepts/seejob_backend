const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
var auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { sendNotificationToUser } = require('./notifier');
const admin = require("../config/firebase-admin");
const crypto = require("crypto");

// Set up multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads')); // absolute path
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});

function generateDeviceToken() {
  return crypto.randomBytes(32).toString("hex");
}

router.post("/change-password", auth.authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { password } = req.body;
  let connection;

  try {
    connection = await pool.getConnection();
    const hashedPassword = await bcrypt.hash(password, 10);

    const query =
      "UPDATE user SET password = ?, must_change_password = 0 WHERE id = ?";
    const [result] = await connection.query(query, [hashedPassword, userId]);

    if (result.affectedRows === 0) {
      return res.status(200).json({
        code: "404",
        message: "User not found",
        data: {},
      });
    }

    return res.status(200).json({
      code: "200",
      message: "Password updated successfully",
      data: {},
    });
  } catch (error) {
    logger.error("Error updating password: ", error);
    return res.status(200).json({
      code: "500",
      message: "Internal server error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/my-rights", auth.authenticateToken, async (req, res) => {
  const userId = req.user && req.user.id ? req.user.id : null;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const [userRows] = await connection.query(
      "SELECT id, role FROM user WHERE id = ? LIMIT 1",
      [userId]
    );

    if (!userRows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const role = userRows[0].role;
    let rightsQuery = "";
    let params = [];

    if (Number(role) === 12) {
      rightsQuery =
        "SELECT r.display_name, r.name, rrp.read, rrp.create, rrp.update, rrp.delete, rrp.user_id AS emp_id " +
        "FROM `right` r " +
        "LEFT JOIN role_right_permission rrp ON rrp.right_id = r.id AND rrp.role_id = 12 AND rrp.user_id IS NULL " +
        "WHERE r.sub_heading = 0";
      params = [];
    } else if (role == 2 || role == 3 || role == 4 || role == 5) {
      rightsQuery =
        "SELECT  r.display_name,r.name, rrp.read, rrp.create,  rrp.update, rrp.delete, rrp.user_id AS emp_id FROM role_right_permission rrp JOIN `right` r ON r.id = rrp.right_id  WHERE rrp.role_id = ? AND rrp.user_id = ? AND r.sub_heading = 0";
      params = [role, userId];
    }

    let rightsRows = [];
    if (rightsQuery) {
      const [rows] = await connection.query(rightsQuery, params);
      rightsRows = rows;

      if (Number(role) === 12) {
        const permissionsFor = (moduleName) => {
          const name = String(moduleName || "").toLowerCase();
          if (name === "subscription") {
            return { read: "yes", create: "yes", update: "yes", delete: "no" };
          }
          if (name === "invitation") {
            return { read: "yes", create: "no", update: "yes", delete: "no" };
          }
          if (name === "support") {
            return { read: "yes", create: "yes", update: "yes", delete: "no" };
          }
          return { read: "yes", create: "no", update: "no", delete: "no" };
        };

        rightsRows = (Array.isArray(rightsRows) ? rightsRows : []).map((r) => {
          const defaults = permissionsFor(r.name);
          return {
            ...r,
            read: r.read ?? defaults.read,
            create: r.create ?? defaults.create,
            update: r.update ?? defaults.update,
            delete: r.delete ?? defaults.delete,
            emp_id: r.emp_id ?? null,
          };
        });
      }
    } else {
      // For roles like GC where default rights are stored with user_id NULL,
      // prefer user-specific rows if they exist, otherwise fall back to role defaults.
      const [userSpecific] = await connection.query(
        "SELECT r.display_name,  r.name,  rrp.read, rrp.create, rrp.update, rrp.delete,  rrp.user_id AS emp_id FROM role_right_permission rrp JOIN `right` r ON r.id = rrp.right_id  WHERE rrp.role_id = ? AND rrp.user_id = ? AND r.sub_heading = 0 ",
        [role, userId]
      );
      if (Array.isArray(userSpecific) && userSpecific.length) {
        rightsRows = userSpecific;
      } else {
        const [roleDefaults] = await connection.query(
          "SELECT r.display_name,  r.name,  rrp.read, rrp.create, rrp.update, rrp.delete,  rrp.user_id AS emp_id FROM role_right_permission rrp JOIN `right` r ON r.id = rrp.right_id  WHERE rrp.role_id = ? AND rrp.user_id IS NULL AND r.sub_heading = 0 ",
          [role]
        );
        rightsRows = roleDefaults;
      }
    }
    return res.json({ success: true, rights: rightsRows });
  } catch (error) {
    logger.error("Error fetching user rights: ", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

const localupload = multer({ storage: storage });

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
    console.error("SMTP connection failed:", err);
  } else {
    console.log("SMTP server is ready to send emails");
  }
});

// Function to generate a random OTP
function generateOTP() {
  const digits = "0123456789";
  let OTP = "";
  for (let i = 0; i < 4; i++) {
    OTP += digits[Math.floor(Math.random() * 10)];
  }
  return OTP;
}

function generateRandomPassword(length = 10) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function sendOTPEmail(toEmail, otp) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`, // sender name + email
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
              <p>Thank you for registering with SeeJobRun. Please use the following OTP code to verify your email address:</p>
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
    console.log("OTP email sent successfully!");
  } catch (error) {
    console.error("Error sending OTP email:", error);
  }
}

async function sendPasswordEmail(toEmail, tempPassword) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`, // Sender name + email
    to: toEmail,
    subject: "Your Temporary Password",
    text: `Your password is: ${tempPassword}\n\nPlease log in using this password at: http://seejobrun.com/user-dashboard/signup`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Temporary Password</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .logo-container { text-align: center; padding: 20px 0; }
            .logo { max-width: 150px; height: auto; }
            .header { background-color: #2196F3; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; }
            .password-box { background-color: #e3f2fd; padding: 15px; text-align: center; font-size: 20px; font-weight: bold; margin: 20px 0; word-break: break-all; }
            .warning { background-color: #fff3e0; padding: 15px; border-left: 4px solid #ff9800; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #777; font-size: 14px; }
            .login-link { display: inline-block; padding: 10px 20px; background-color: #2196F3; color: white!important; text-decoration: none; border-radius: 4px; margin: 15px 0; }
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
              <h2>Temporary Password</h2>
              <p>Hello,</p>
              <p>We have received a request to reset your password. Here is your temporary password:</p>
              <div class="password-box">${tempPassword}</div>
              <p>Please log in using this password:</p>
              <a href="http://seejobrun.com/user-dashboard/signup" class="login-link">Go to Login Page</a>
              <div class="warning">
                <strong>Important:</strong> Please change this temporary password immediately after logging in for security reasons.
              </div>
              <p>If you didn't request this password reset, please contact our support team immediately.</p>
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
    console.log("Temporary password email sent successfully!");
  } catch (error) {
    console.error("Error sending temporary password email:", error);
  }
}

async function sendRecoveryEmail(toEmail, otp) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "Password Recovery",
    text: `Your OTP for password recovery is: ${otp}\n\nPlease use this code to verify your identity and reset your password.`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Recovery</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .logo-container { text-align: center; padding: 20px 0; }
            .logo { max-width: 150px; height: auto; }
            .header { background-color: #f44336; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; }
            .otp-box { background-color: #ffebee; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; margin: 20px 0; }
            .instructions { background-color: #e8f5e9; padding: 15px; border-left: 4px solid #4CAF50; margin: 20px 0; }
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
              <h2>Password Recovery</h2>
              <p>Hello,</p>
              <p>We received a request to recover your password. Please use the following OTP code to verify your identity:</p>
              <div class="otp-box">${otp}</div>
              <div class="instructions">
                <h3>Next Steps:</h3>
                <ol>
                  <li>Enter this OTP code on the password recovery page</li>
                  <li>Create a new password for your account</li>
                  <li>Confirm your new password</li>
                </ol>
              </div>
              <p>If you didn't request a password recovery, please ignore this email or contact our support team.</p>
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
    console.log("Recovery email sent successfully!");
  } catch (error) {
    console.error("Error sending recovery email:", error);
  }
}

// Add a new user publically
// router.post("/register", async (req, res) => {

//   const currentTimestamp = getTimeStamp();
//   const result = addUserSchema(req.body);

//   if (result.error) {
//     return res.status(400).json({
//       code: "400",
//       message: result.error.details[0].message,
//       data: {},
//     });
//   }

//   const r = req.body;
//   console.log(r);
//   let connection;

//   try {
//     connection = await pool.getConnection();
//     const hashedPassword = '';
//     const otp = generateOTP();

//     const query = `
//       INSERT INTO user 
//       (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security,created_by, must_change_password)
//       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?, ?)
//     `;

//     const [resultInsert] = await connection.query(query, [
//       r.name,
//       r.email,
//       hashedPassword,
//       r.subcategory, // 👈 still using subcategory as role_id
//       r.mobile,
//       r.category,
//       r.subcategory,
//       r.business_name,
//       r.trade,
//       otp,
//       1, // otp_status
//       currentTimestamp, // created_at
//       r.employment_type,
//       r.rate,
//       r.social_security,
//       r.created_by,
//       0
//     ]);

//     const emp_id = resultInsert.insertId;

//     logger.info("User added successfully");
//     await sendOTPEmail(r.email, otp);

//     // ✅ ONLY EXECUTE FOR EMPLOYEES (role 2, 3, 4, 5)
//     const employeeRoles = [2, 3, 4, 5];
//     if (employeeRoles.includes(Number(r.subcategory))) {
//       if (Array.isArray(r.leave_ids) && r.leave_ids.length > 0) {
//         const leavesData = r.leave_ids.map((leave_id) => [
//           emp_id,
//           leave_id,
//           currentTimestamp,
//           r.created_by,
//         ]);

//         const leaveInsertQuery = `
//           INSERT INTO employee_leaves_quota (emp_id, leave_id, created_at, created_by)
//           VALUES ?
//         `;
//         await connection.query(leaveInsertQuery, [leavesData]);
//         logger.info("Employee leaves quota added successfully");
//       }
//     }

//     return res.status(201).json({
//       code: "201",
//       message: "Registered successfully",
//       data: { userId: emp_id, email: r.email },
//     });
//   } catch (error) {
//     if (error.code === "ER_DUP_ENTRY") {
//       logger.error("Create user error:", error);
//       return res.status(409).json({
//         code: "409",
//         message: "Email and Mobile must be unique",
//         data: {},
//       });
//     } else {
//       logger.error("Error adding user:", error);
//       return res.status(500).json({
//         code: "500",
//         message: error.message,
//         stack: error.stack,
//         data: {},
//       });
//     }
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post("/register", async (req, res) => {
  const currentTimestamp = getTimeStamp();
  const validation = addUserSchema(req.body);

  if (validation.error) {
    return res.status(400).json({
      code: "400",
      message: validation.error.details[0].message,
      data: {},
    });
  }

  const r = req.body;
  let connection;

  try {
    connection = await pool.getConnection();

    // 🔥 PASSWORD LOGIC
    let plainPassword = null;
    let hashedPassword = null;

    if (Number(r.category) === 5) {
      plainPassword = generateRandomPassword(10);
      hashedPassword = await bcrypt.hash(plainPassword, 10);
    }

    // 🔥 OTP
    const otp = generateOTP();

    // 🔥 INSERT USER
    const query = `
      INSERT INTO user 
      (name, email, password, role, mobile, category, subcategory, business, trade, otp, otp_status, created_at, employment_type, rate, social_security, created_by, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [resultInsert] = await connection.query(query, [
      r.name,
      r.email,
      hashedPassword,
      r.subcategory, // role
      r.mobile,
      r.category,
      r.subcategory,
      r.business_name,
      r.trade,
      otp,
      1,
      currentTimestamp,
      r.employment_type,
      r.rate,
      r.social_security,
      r.created_by,
      1 // ✅ ALWAYS FORCE PASSWORD CHANGE
    ]);

    const emp_id = resultInsert.insertId;

    // 🔥 SEND EMAILS
    if (Number(r.category) === 5) {
  // Send ONLY password
  await sendPasswordEmail(r.email, plainPassword);
} else {
  // Send ONLY OTP
  await sendOTPEmail(r.email, otp);
}

    if (plainPassword) {
      await sendPasswordEmail(r.email, plainPassword);
    }

    // 🔥 LEAVES LOGIC (ONLY FOR EMPLOYEES)
    const employeeRoles = [2, 3, 4, 5];

    if (employeeRoles.includes(Number(r.subcategory))) {
      if (Array.isArray(r.leave_ids) && r.leave_ids.length > 0) {
        const leavesData = r.leave_ids.map((leave_id) => [
          emp_id,
          leave_id,
          currentTimestamp,
          r.created_by,
        ]);

        const leaveInsertQuery = `
          INSERT INTO employee_leaves_quota (emp_id, leave_id, created_at, created_by)
          VALUES ?
        `;

        await connection.query(leaveInsertQuery, [leavesData]);
      }
    }

    return res.status(201).json({
      code: "201",
      message: "Registered successfully",
      data: {
        userId: emp_id,
        email: r.email,
      },
    });

  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        code: "409",
        message: "Email and Mobile must be unique",
        data: {},
      });
    }

    return res.status(500).json({
      code: "500",
      message: error.message,
      stack: error.stack,
      data: {},
    });

  } finally {
    if (connection) connection.release();
  }
});

router.post("/login-pin", async (req, res) => {
  const { pin } = req.body;
  const deviceToken = req.cookies.device_token;

  if (!deviceToken) {
    return res.status(200).json({
      code: "401",
      message: "Device not recognized",
    });
  }

  const connection = await pool.getConnection();

  const [rows] = await connection.query(
    `SELECT u.*
     FROM user_devices ud
     JOIN user u ON u.id = ud.user_id
     WHERE ud.device_token = ? AND u.pin_enabled = 1`,
    [deviceToken]
  );

  if (!rows.length) {
    return res.status(200).json({
      code: "401",
      message: "Invalid device or PIN",
    });
  }

  const user = rows[0];
  const isValidPin = await bcrypt.compare(pin, user.pin_hash);

  if (!isValidPin) {
    return res.status(200).json({
      code: "401",
      message: "Invalid PIN",
    });
  }

  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    working_id:
      [2,3,4,5].includes(user.role) ? user.created_by : user.id,
    otp_status: user.otp_status,
    must_change_password: user.must_change_password,
  };

  const token = jwt.sign(payload, process.env.ACCESS_TOKEN, {
    expiresIn: "7d",
  });

  res.status(200).json({
    code: "200",
    message: "Login successful",
    data: {
      token,
      basicData: payload,
      photoName: user.image || "user.png",
    },
  });
});


router.post("/create-pin", async (req, res) => {
  const { userId, pin } = req.body;

  if (!pin || pin.length !== 4) {
    return res.status(400).json({ message: "PIN must be 4 digits" });
  }

  let connection;

  try {
    connection = await pool.getConnection();

    const hashedPin = await bcrypt.hash(pin, 10);

    await connection.execute(
      "UPDATE user SET pin_hash = ?, pin_enabled = 1 WHERE id = ?",
      [hashedPin, userId]
    );

    res.json({ message: "PIN created successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});


// router.post("/login", async (req, res) => {
//   const { email, password } = req.body;
//   const user_email = email;
//   let connection;

//   try {
//     connection = await pool.getConnection();
//     const query = `
//       SELECT u.id, u.name, u.email, u.password, u.image, u.status, u.role, 
//              u.otp_status, u.created_by, u.must_change_password, u.pin_hash
//       FROM user u
//       WHERE u.email = ?`;
//     const [rows] = await connection.query(query, [email]);

//     if (rows.length === 0) {
//       logger.info(`Login failed: Incorrect Email or Password - ${email} - ${new Date()}`);
//       return res.status(200).json({ code: "401", message: "Incorrect Email or Password", data: {} });
//     }

//     const user = rows[0];

//     if (user.status == 0) {
//       return res.status(200).json({ code: "401", message: "Your account is inactive", data: {} });
//     }

//     if (!user.password) {
//       logger.error(`Login error: Password not found - ${email} - ${new Date()}`);
//       return res.status(200).json({ code: "400", message: "Something went wrong. Please try again later", data: {} });
//     }

//     // Compare password
//     const bResult = await bcrypt.compare(password, user.password);
//     if (!bResult) {
//       logger.info(`Login failed: Incorrect Email or Password - ${email} - ${new Date()}`);
//       return res.status(200).json({ code: "401", message: "Incorrect Email or Password", data: {} });
//     }

//     const { id, name, role, otp_status, must_change_password } = user;

//     // 🔐 Generate device token
//     const crypto = require("crypto");
//     const deviceToken = crypto.randomBytes(32).toString("hex");

//     // Save device in DB
//     await connection.query(
//       "INSERT INTO user_devices (user_id, device_token, user_agent) VALUES (?, ?, ?)",
//       [id, deviceToken, req.headers["user-agent"]]
//     );
//       console.log('check id', id);
//     // 🍪 Set HttpOnly cookie (working with Angular localhost)
//     res.cookie("device_token", deviceToken, {
//       httpOnly: true,
//       secure: true,      // set true if using HTTPS
//       sameSite: "none",    // ✅ must be 'lax' or 'none' for cross-origin
//       maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
//     });

//     let rights = [];
//     const userId = parseInt(id);

// const [userRightsRows] = await connection.query(`
//   SELECT 
//     r.display_name,
//     r.name,
//     rrp.\`read\`,
//     rrp.\`create\`,
//     rrp.\`update\`,
//     rrp.\`delete\`,
//     rrp.user_id AS emp_id
//   FROM role_right_permission rrp
//   INNER JOIN \`right\` r ON r.id = rrp.right_id
//   WHERE rrp.user_id = ?
//   AND r.sub_heading = 0
// `, [userId]);
// console.log("Rights rows:", userRightsRows);
// const rights = userRightsRows;

//     // First time PIN setup
//     if (!user.pin_hash) {
//       return res.json({ requirePinSetup: true, userId: id, rights });
//     }

//     // Role-based working_id
//     let working_id = [2,3,4,5].includes(role) ? user.created_by : id;

//     const response = { id, name, email, role, rights, working_id, otp_status, must_change_password };
//     const accessToken = jwt.sign(response, process.env.ACCESS_TOKEN, { expiresIn: "7d" });

//     logger.info(`Login successful: Employee ID - ${id} - ${new Date()}`);
//     const photoName = user.image || "user.png";

//     return res.status(200).json({
//       code: "200",
//       message: "Login successful",
//       data: { token: accessToken, basicData: response, photoName },
//     });

//   } catch (error) {
//     logger.error(`- ${email} - ${new Date()} - Login error:`, error);
//     return res.status(200).json({ code: "500", message: "Internal Server Error", data: {} });
//   } finally {
//     if (connection) connection.release();
//   }
// });

// ── Passwordless Login OTP ──────────────────────────────────────────

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  let connection;

  try {
    connection = await pool.getConnection();

    // ===============================
    // Get User By Email
    // ===============================
    const [rows] = await connection.query(
      `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.password,
        u.image,
        u.status,
        u.role,
        u.otp_status,
        u.created_by,
        u.must_change_password,
        u.pin_hash
      FROM user u
      WHERE u.email = ?
      `,
      [email]
    );

    // User not found
    if (rows.length === 0) {
      logger.info(`Login failed: Invalid email - ${email}`);
      return res.status(200).json({
        code: "401",
        message: "Incorrect Email or Password",
        data: {},
      });
    }

    const user = rows[0];

    // Inactive account
    if (user.status == 0) {
      return res.status(200).json({
        code: "401",
        message: "Your account is inactive",
        data: {},
      });
    }

    // Password check
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      logger.info(`Login failed: Wrong password - ${email}`);
      return res.status(200).json({
        code: "401",
        message: "Incorrect Email or Password",
        data: {},
      });
    }

    const {
      id,
      name,
      role,
      otp_status,
      must_change_password,
      created_by,
      image,
      pin_hash,
    } = user;

    // ===============================
    // Generate Device Token
    // ===============================
    const crypto = require("crypto");
    const deviceToken = crypto.randomBytes(32).toString("hex");

    await connection.query(
      `
      INSERT INTO user_devices (user_id, device_token, user_agent)
      VALUES (?, ?, ?)
      `,
      [id, deviceToken, req.headers["user-agent"]]
    );

    // ===============================
    // Set Cookie
    // ===============================
    res.cookie("device_token", deviceToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    // ===============================
    // Get User Rights By user_id
    // ===============================
    const userId = parseInt(id);

    console.log("Logged User ID:", userId);

    const [userRightsRows] = await connection.query(`
  SELECT
    right_id,
    \`read\`,
    \`create\`,
    \`update\`,
    \`delete\`,
    user_id
  FROM role_right_permission
  WHERE user_id = ?
`, [userId]);

const rights = userRightsRows || [];

    // ===============================
    // First Time PIN Setup
    // ===============================
    // if (!pin_hash) {
    //   return res.status(200).json({
    //     requirePinSetup: true,
    //     userId: id,
    //     rights: rights,
    //   });
    // }

    // ===============================
    // Working ID
    // ===============================
    let working_id = [2, 3, 4, 5].includes(role)
      ? created_by
      : id;

    // ===============================
    // JWT Response
    // ===============================
    const response = {
      id,
      name,
      email,
      role,
      rights,
      working_id,
      otp_status,
      must_change_password,
    };

    const accessToken = jwt.sign(
      response,
      process.env.ACCESS_TOKEN,
      { expiresIn: "7d" }
    );

    logger.info(`Login successful: User ID ${id}`);

    return res.status(200).json({
      code: "200",
      message: "Login successful",
      data: {
        token: accessToken,
        basicData: response,
        photoName: image || "user.png",
      },
    });

  } catch (error) {
    console.error("Login Error:", error);

    logger.error(`Login Error - ${email}`, error);

    return res.status(200).json({
      code: "500",
      message: "Internal Server Error",
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
      "SELECT id, status FROM user WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );

    if (!rows.length) {
      return res.status(200).json({ code: "404", message: "Email does not exist", data: {} });
    }

    const user = rows[0];
    if (Number(user.status) === 0) {
      return res.status(200).json({ code: "401", message: "Your account is inactive", data: {} });
    }

    const otp = generateOTP();

    await connection.query(
      "UPDATE user SET otp = ?, otp_status = 1, updated_at = NOW(), updated_by = ? WHERE id = ?",
      [otp, Number(user.id), Number(user.id)]
    );

    await sendOTPEmail(normalizedEmail, otp);

    return res.status(200).json({ code: "200", message: "OTP sent", data: {} });
  } catch (error) {
    logger.error(`- ${normalizedEmail} - ${new Date()} - Login OTP request error:`, error);
    return res.status(200).json({ code: "500", message: "Internal Server Error", data: {} });
  } finally {
    if (connection) connection.release();
  }
});

// router.post("/login-otp-verify", async (req, res) => {
//   const { email, otp } = req.body || {};
//   if (!email || !otp) {
//     return res.status(400).json({ code: "400", message: "Email and OTP are required.", data: {} });
//   }

//   const normalizedEmail = String(email).trim();
//   const normalizedOtpDigits = String(otp).trim().replace(/\D/g, "");
//   if (normalizedOtpDigits.length !== 4) {
//     return res.status(200).json({ code: "400", message: "Invalid or expired OTP.", data: {} });
//   }

//   let connection;
//   try {
//     connection = await pool.getConnection();

//     const [rows] = await connection.query(
//       `SELECT u.id, u.name, u.email, u.image, u.status, u.role,
//               u.otp_status, u.created_by, u.must_change_password, u.pin_hash
//        FROM user u
//        WHERE u.email = ?
//          AND LPAD(CAST(u.otp AS CHAR), 4, '0') = ?
//          AND u.otp_status = 1
//          AND u.updated_at >= (NOW() - INTERVAL 3 MINUTE)
//        LIMIT 1`,
//       [normalizedEmail, normalizedOtpDigits]
//     );

//     if (!rows.length) {
//       return res.status(200).json({ code: "400", message: "Invalid or expired OTP.", data: {} });
//     }

//     const user = rows[0];
//     if (Number(user.status) === 0) {
//       return res.status(200).json({ code: "401", message: "Your account is inactive", data: {} });
//     }

//     const { id, name, role, must_change_password } = user;

//     const deviceToken = generateDeviceToken();
//     await connection.query(
//       "INSERT INTO user_devices (user_id, device_token, user_agent) VALUES (?, ?, ?)",
//       [id, deviceToken, req.headers["user-agent"]]
//     );

//     res.cookie("device_token", deviceToken, {
//       httpOnly: true,
//       secure: true,
//       sameSite: "none",
//       maxAge: 1000 * 60 * 60 * 24 * 30,
//     });

//     // Clear OTP regardless of pin_hash
//     await connection.query(
//       "UPDATE user SET otp_status = 0, otp = '', updated_at = NOW(), updated_by = ? WHERE id = ?",
//       [id, id]
//     );

//    const userId = parseInt(id);

// const [rightsRows] = await connection.query(
//   `SELECT 
//       right_id,
//       \`read\`,
//       \`create\`,
//       \`update\`,
//       \`delete\`,
//       user_id
//    FROM role_right_permission
//    WHERE user_id = ?`,
//   [userId]
// );

// const rights = rightsRows || [];

//     const response = {
//       id,
//       name,
//       email: normalizedEmail,
//       role,
//       rights,
//       working_id,
//       otp_status: 0,
//       must_change_password,
//     };
//     const accessToken = jwt.sign(response, process.env.ACCESS_TOKEN, { expiresIn: "7d" });
//     const photoName = user.image || "user.png";

//     logger.info(`Login successful (OTP): Employee ID - ${id} - ${new Date()}`);

//     return res.status(200).json({
//       code: "200",
//       message: "Login successful",
//       data: { token: accessToken, basicData: response, photoName },
//     });
//   } catch (error) {
//     logger.error(`- ${normalizedEmail} - ${new Date()} - Login OTP verify error:`, error);
//     return res.status(200).json({ code: "500", message: "Internal Server Error", data: {} });
//   } finally {
//     if (connection) connection.release();
//   }
// });


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
          u.id, 
          u.name, 
          u.email, 
          u.image, 
          u.status, 
          u.role,
          u.otp_status, 
          u.created_by, 
          u.must_change_password, 
          u.pin_hash
       FROM user u
       WHERE u.email = ?
         AND LPAD(CAST(u.otp AS CHAR), 4, '0') = ?
         AND u.otp_status = 1
         AND u.updated_at >= (NOW() - INTERVAL 3 MINUTE)
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

    const user = rows[0];

    if (Number(user.status) === 0) {
      return res.status(200).json({
        code: "401",
        message: "Your account is inactive",
        data: {},
      });
    }

    const {
      id,
      name,
      role,
      must_change_password,
      created_by,
      image,
    } = user;

    // ===============================
    // Generate Device Token
    // ===============================
    const deviceToken = generateDeviceToken();

    await connection.query(
      "INSERT INTO user_devices (user_id, device_token, user_agent) VALUES (?, ?, ?)",
      [id, deviceToken, req.headers["user-agent"]]
    );

    res.cookie("device_token", deviceToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    // ===============================
    // Clear OTP
    // ===============================
    await connection.query(
      "UPDATE user SET otp_status = 0, otp = '', updated_at = NOW(), updated_by = ? WHERE id = ?",
      [id, id]
    );

    // ===============================
    // Get User Rights (FIXED)
    // ===============================
    const userId = parseInt(id);

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
      [userId]
    );

    const rights = rightsRows || [];

    // ===============================
    // Working ID
    // ===============================
    let working_id = [2, 3, 4, 5].includes(role)
      ? created_by
      : id;

    // ===============================
    // Response + JWT
    // ===============================
    const response = {
      id,
      name,
      email: normalizedEmail,
      role,
      rights,
      working_id,
      otp_status: 0,
      must_change_password,
    };

    const accessToken = jwt.sign(
      response,
      process.env.ACCESS_TOKEN,
      { expiresIn: "7d" }
    );

    const photoName = image || "user.png";

    logger.info(`Login successful (OTP): Employee ID - ${id} - ${new Date()}`);

    return res.status(200).json({
      code: "200",
      message: "Login successful",
      data: {
        token: accessToken,
        basicData: response,
        photoName,
      },
    });

  } catch (error) {
    logger.error(
      `- ${normalizedEmail} - ${new Date()} - Login OTP verify error:`,
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
router.post("/saveDeviceToken", auth.authenticateToken, async (req, res) => {
  const { user_id, fcm_token } = req.body;

  if (!user_id || !fcm_token) {
    return res.status(400).json({ code: "400", message: "user_id and fcm_token required" });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Check if user already has a token
    const [existing] = await connection.query(
      "SELECT id, fcm_token FROM user_device_tokens WHERE user_id = ?",
      [user_id]
    );

    if (existing.length === 0) {
      // Insert if no token found for this user
      await connection.query(
        "INSERT INTO user_device_tokens (user_id, fcm_token, created_at) VALUES (?, ?, NOW())",
        [user_id, fcm_token]
      );

      return res.status(200).json({ code: "200", message: "Token inserted" });
    }

    // Token exists → check if it is different
    if (existing[0].fcm_token !== fcm_token) {
      await connection.query(
        "UPDATE user_device_tokens SET fcm_token = ?, updated_at = NOW() WHERE id = ?",
        [fcm_token, existing[0].id]
      );

      return res.status(200).json({ code: "200", message: "Token updated" });
    }

    // Token is same → no action
    res.status(200).json({ code: "200", message: "Token already up to date" });

  } catch (error) {
    console.error("Error saving FCM token:", error);
    res.status(500).json({ code: "500", message: "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/images/:imageName", auth.authenticateToken, async (req, res) => {
  const imageName = req.params.imageName;
  viewImage(imageName, (result) => {
    if (result.error) {
      res.status(404).json({ message: result.error });
    } else {
      res.writeHead(200, { "Content-Type": result.contentType });
      res.end(result.data);
    }
  });
});



async function viewImage(imageName, callback) {
  const imagePath = path.join(__dirname, "../uploads", imageName); // Path to your images directory
  fs.readFile(imagePath, (err, data) => {
    if (err) {
      logger.error("Get Profile Picture", err);
      callback({ status: "404", error: "Image not found" });
      // res.status(404).json({ message: "Image not found" });
    } else {
      const extension = path.extname(imageName).toLowerCase();
      let contentType = "image/jpeg"; // Default content type

      if (extension === ".png") {
        contentType = "image/png";
      } else if (extension === ".jpg" || extension === ".jpeg") {
        contentType = "image/jpeg";
      }
      callback({ status: "200", data: data, contentType: contentType });
      // res.writeHead(200, { "Content-Type": contentType });
      // res.end(data);
    }
  });
}

// Add a new user of only 3 types Foreman, Secretary, Bookkeeper

router.post("/addUser", auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;
  const currentTimestamp = getTimeStamp();
  const result = addUserSchema(req.body);
  if (result.error) {
    res.status(200).json({
      code: "400",
      message: result.error.details[0].message,
      data: {},
    });
    return;
  }

  const r = req.body;

  if (r.subcategory == 3 || r.subcategory == 4 || r.subcategory == 5) {
    let connection;

    try {
      connection = await pool.getConnection();

      const hashedPassword = await bcrypt.hash(r.password, 10);

      const otp = generateOTP();

      const query =
        "INSERT INTO `user` (`name`, `email`, `password`, `role`, `mobile`, `category`, `subcategory`, `business`, `trade`, `social_security`, `street`, `city`, `state`, `zipcode`, `contact_note`, `otp`,`otp_status`, `created_at`, `created_by`, `must_change_password`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
      const [result] = await connection.query(query, [
        r.name,
        r.email,
        hashedPassword,
        r.subcategory,
        r.mobile,
        r.category,
        r.subcategory,
        r.business_name,
        r.trade,
        r.social_security_num,
        r.street_address,
        r.city,
        r.state,
        r.zipcode,
        r.contact_notes,
        otp,
        1,
        currentTimestamp,
        signedin_user,
        1,
      ]);
      logger.info("User added successfully");
      res
        .status(200)
        .json({ code: "200", message: "User added successfully", data: {} });
      return;
    } catch (error) {
      if (error.code == "ER_DUP_ENTRY") {
        logger.error("Create user error is:", error);
        res.status(200).json({
          code: "400",
          message: "Email and Mobile must be Unique",
          data: {},
        });
        return;
      } else {
        logger.error("Error adding user: ", error);
        res
          .status(200)
          .json({ code: "500", message: "Internal server error", data: {} });
        return;
      }
    } finally {
      if (connection) connection.release();
    }
  } else {
    logger.error("Create user error is:this subcategory is not allowed ");
    res.status(200).json({
      code: "400",
      message: "This subcategory is not allowed",
      data: {},
    });
    return;
  }
});

// Change user status
router.put("/changestatus", auth.authenticateToken, async (req, res) => {
  const { status } = req.body;
  let connection;
  const signedin_user = res.locals.id;
  const currentTimestamp = getTimeStamp();

  try {
    connection = await pool.getConnection();

    if (typeof status === "undefined") {
      return res
        .status(200)
        .json({ code: "400", message: "Status is required", data: {} });
    }

    const query =
      "UPDATE user SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?";
    const [result] = await connection.query(query, [
      status,
      currentTimestamp,
      signedin_user,
      signedin_user,
    ]);

    if (result.affectedRows === 0) {
      return res
        .status(200)
        .json({ code: "404", message: "User not found", data: {} });
    }

    res.status(200).json({
      code: "200",
      message: "User Status updated successfully",
      data: {},
    });
  } catch (error) {
    logger.error("Error updating user status: ", error);
    return res
      .status(200)
      .json({ code: "500", message: "Internal server error", data: {} });
  } finally {
    if (connection) connection.release();
  }
});

// ----------------job's contact addition--------------
// get user by id
router.get("/getuser", auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;
  let connection;
  try {
    connection = await pool.getConnection();
    query =
      "SELECT u.id,u.name, c.name as 'category', c.id as 'category_id', sc.id as 'subcategory_id', sc.name 'subcategory', u.email,u.role as 'role', r.name 'role_name' ,u.image,u.mobile,u.business,u.organization_name,u.trade,u.social_security,u.street,city,u.zipcode,u.contact_note,u.status, u.contact_available FROM user u join category c on (c.id = u.category) join subcategory sc on (sc.id = u.subcategory) join role r on (r.id = u.role) where u.id = ?";
    const [rows] = await connection.query(query, [signedin_user]);
    res.status(200).json({
      code: "200",
      message: "Get user data successfully",
      data: rows[0],
    });
    return;
  } catch (error) {
    logger.error(`${error}`);
    res
      .status(200)
      .json({ code: "500", data: {}, message: "Something went wrong" });
    return;
  } finally {
    if (connection) connection.release();
  }
});




router.get("/getallusers", auth.authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const query = `
(
  SELECT 
    u.id,
    u.name,
    u.category,
    u.subcategory,
    u.email,
    r.name AS role_name,
    u.image,
    u.mobile,
    NULL AS team_id,
    NULL AS team_name,
    NULL AS team_color
  FROM contact c
  INNER JOIN user u ON u.id = c.request_user2
  LEFT JOIN role r ON r.id = u.role
  WHERE c.request_user1 = ?
    AND c.status = 'Accept'
)

UNION

(
  SELECT 
    u.id,
    u.name,
    u.category,
    u.subcategory,
    u.email,
    r.name AS role_name,
    u.image,
    u.mobile,
    NULL AS team_id,
    NULL AS team_name,
    NULL AS team_color
  FROM contact c
  INNER JOIN user u ON u.id = c.request_user1
  LEFT JOIN role r ON r.id = u.role
  WHERE c.request_user2 = ?
    AND c.status = 'Accept'
)

UNION

(
  SELECT 
    u.id,
    u.name,
    u.category,
    u.subcategory,
    u.email,
    r.name AS role_name,
    u.image,
    u.mobile,
    NULL AS team_id,
    NULL AS team_name,
    NULL AS team_color
  FROM user u
  LEFT JOIN role r ON r.id = u.role
  LEFT JOIN category c ON u.category = c.id
  WHERE c.id = 1
    AND u.created_by = ?
    AND (
      u.exit_type IS NULL
      OR u.exit_type = ''
      OR u.exit_type = '0'
      OR u.exit_type NOT IN ('1', '2')
    )
)

UNION

(
  SELECT
    ic.id,
    ic.name,
    NULL AS category,
    NULL AS subcategory,
    ic.email,
    NULL AS role_name,
    NULL AS image,
    NULL AS mobile,
    NULL AS team_id,
    NULL AS team_name,
    NULL AS team_color
  FROM invited_contacts ic
  WHERE ic.created_by = ?
    AND ic.status = 0
)

UNION

(
  -- ✅ Teams
  SELECT
    NULL AS id,
    NULL AS name,
    NULL AS category,
    NULL AS subcategory,
    NULL AS email,
    NULL AS role_name,
    NULL AS image,
    NULL AS mobile,
    t.id AS team_id,
    t.team_name,
    t.team_color
  FROM teams t
  WHERE t.created_by = ?
)
`;

    const [rows] = await connection.query(query, [
      user_id,
      user_id,
      user_id,
      user_id,
      user_id
    ]);

    // Attach members[] to team rows so the Task Manager assign overlay can
    // expose a "Teams" column and fan-out a task to all members of a team.
    const teamIds = rows
      .map((r) => r && r.team_id)
      .filter((id) => id !== null && id !== undefined);

    if (teamIds.length) {
      const placeholders = teamIds.map(() => '?').join(',');
      const [memberRows] = await connection.query(
        `SELECT tu.team_id, tu.user_id, u.name, s.name AS role
         FROM team_user tu
         LEFT JOIN user u ON tu.user_id = u.id
         LEFT JOIN subcategory s ON u.subcategory = s.id
         WHERE tu.team_id IN (${placeholders})`,
        teamIds
      );

      const byTeam = new Map();
      for (const m of memberRows) {
        if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
        byTeam.get(m.team_id).push({
          user_id: m.user_id,
          name: m.name,
          role: m.role,
        });
      }
      for (const r of rows) {
        if (r && r.team_id) {
          r.members = byTeam.get(r.team_id) || [];
        }
      }
    }

    res.status(200).json({
      code: "200",
      message: "All users fetched successfully",
      data: rows
    });
  } catch (error) {
    logger.error(`${error}`);
    res.status(500).json({
      code: "500",
      data: [],
      message: "Something went wrong"
    });
  } finally {
    if (connection) connection.release();
  }
});



router.get("/get-task-users", auth.authenticateToken, async (req, res) => {
  const user_id = Number(req.user?.id || 0);
  const working_user_id = Number(req.user?.working_id || user_id || 0);
  let connection;

  try {
    connection = await pool.getConnection();
    const query = `
    (
      SELECT
        p.id,
        MAX(p.name) AS name,
        MAX(p.category) AS category,
        MAX(p.subcategory) AS subcategory,
        MAX(p.subcategory_name) AS subcategory_name,
        MAX(p.effective_category_id) AS effective_category_id,
        MAX(p.effective_category_name) AS effective_category_name,
        MAX(p.email) AS email,
        MAX(p.role_name) AS role_name,
        MAX(p.image) AS image,
        MAX(p.mobile) AS mobile,
        NULL AS team_id,
        NULL AS team_name,
        NULL AS team_color
      FROM (
        -- Contacts where 1 sent the request
        SELECT
            u.id,
            u.name,
            u.category,
            u.subcategory,
            sc.name AS subcategory_name,
            cat.id AS effective_category_id,
            cat.name AS effective_category_name,
            u.email,
            r.name AS role_name,
            u.image,
            u.mobile
        FROM contact c
        INNER JOIN user u ON u.id = c.request_user2
        LEFT JOIN role r ON r.id = u.role
        LEFT JOIN subcategory sc ON sc.id = u.subcategory
        LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
        WHERE c.request_user1 IN (?, ?)

        UNION

        -- Contacts where 1 received the request
        SELECT
            u.id,
            u.name,
            u.category,
            u.subcategory,
            sc.name AS subcategory_name,
            cat.id AS effective_category_id,
            cat.name AS effective_category_name,
            u.email,
            r.name AS role_name,
            u.image,
            u.mobile
        FROM contact c
        INNER JOIN user u ON u.id = c.request_user1
        LEFT JOIN role r ON r.id = u.role
        LEFT JOIN subcategory sc ON sc.id = u.subcategory
        LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
        WHERE c.request_user2 IN (?, ?)

        UNION

        -- Users created by 1 with role = 3
        SELECT
            u.id,
            u.name,
            u.category,
            u.subcategory,
            sc.name AS subcategory_name,
            cat.id AS effective_category_id,
            cat.name AS effective_category_name,
            u.email,
            r.name AS role_name,
            u.image,
            u.mobile
        FROM user u
        LEFT JOIN role r ON r.id = u.role
        LEFT JOIN subcategory sc ON sc.id = u.subcategory
        LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
        WHERE cat.id = 1
          AND u.created_by IN (?, ?) AND (
            u.exit_type IS NULL
            OR u.exit_type = ''
            OR u.exit_type = '0'
            OR u.exit_type NOT IN ('1', '2')
          )

        UNION

        -- The user themself (id = 1)
        SELECT
            u.id,
            u.name,
            u.category,
            u.subcategory,
            sc.name AS subcategory_name,
            cat.id AS effective_category_id,
            cat.name AS effective_category_name,
            u.email,
            r.name AS role_name,
            u.image,
            u.mobile
        FROM user u
        LEFT JOIN role r ON r.id = u.role
        LEFT JOIN subcategory sc ON sc.id = u.subcategory
        LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
        WHERE u.id = ?
      ) p
      GROUP BY p.id
    )

    UNION

    (
      -- Teams created by the logged-in user (used by the Task Manager
      -- assign overlay to expose a "Teams" column).
      SELECT
          NULL AS id,
          NULL AS name,
          NULL AS category,
          NULL AS subcategory,
          NULL AS subcategory_name,
          NULL AS effective_category_id,
          NULL AS effective_category_name,
          NULL AS email,
          NULL AS role_name,
          NULL AS image,
          NULL AS mobile,
          t.id AS team_id,
          t.team_name,
          t.team_color
      FROM teams t
      WHERE t.created_by IN (?, ?)
    )

    ORDER BY COALESCE(name, team_name) ASC;

    `;

    const [rows] = await connection.query(query, [
      working_user_id,
      user_id,
      working_user_id,
      user_id,
      working_user_id,
      user_id,
      user_id,
      working_user_id,
      user_id,
    ]);

    // Attach members[] to team rows so the frontend can fan-out a task to
    // every member of a team.
    const teamIds = rows
      .map((r) => r && r.team_id)
      .filter((id) => id !== null && id !== undefined);

    if (teamIds.length) {
      const placeholders = teamIds.map(() => '?').join(',');
      const [memberRows] = await connection.query(
        `SELECT tu.team_id, tu.user_id, u.name, s.name AS role
         FROM team_user tu
         LEFT JOIN user u ON tu.user_id = u.id
         LEFT JOIN subcategory s ON u.subcategory = s.id
         WHERE tu.team_id IN (${placeholders})`,
        teamIds
      );

      const byTeam = new Map();
      for (const m of memberRows) {
        if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
        byTeam.get(m.team_id).push({
          user_id: m.user_id,
          name: m.name,
          role: m.role,
        });
      }
      for (const r of rows) {
        if (r && r.team_id) {
          r.members = byTeam.get(r.team_id) || [];
        }
      }
    }

    res.status(200).json({
      code: "200",
      message: "All users fetched successfully",
      data: rows,
    });
  } catch (error) {
    logger.error(`${error}`);
    res.status(500).json({
      code: "500",
      data: [],
      message: "Something went wrong"
    });
  } finally {
    if (connection) connection.release();
  }
});




// router.post("/jobAddContact", auth.authenticateToken, async (req, res) => {
//   const { job_id, contact_id } = req.body;
//   const user_id = req.user.id;
 
//   if (!job_id || !contact_id) {
//     return res.status(400).json({
//       code: "400",
//       message: "job_id and contact_id are required",
//     });
//   }

//   let connection;
//   try {
//     connection = await pool.getConnection();

//     // --- Insert record ---
//     const insertQuery = `
//       INSERT INTO job_contacts (user_id, job_id, contact_id)
//       VALUES (?, ?, ?)
//     `;
//     await connection.query(insertQuery, [user_id, job_id, contact_id]);

//     // --- Fetch actor (adder) name ---
//     const [[actorRow]] = await connection.query(
//       "SELECT name FROM user WHERE id = ?",
//       [user_id]
//     );
//     const actorName = actorRow ? actorRow.name : "Someone";

//     // --- Fetch job title (optional) ---
//     const [[jobRow]] =
//       (await connection
//         .query("SELECT name AS title FROM job WHERE id = ?", [job_id])
//         .catch(() => [[]])) || [];
//     const jobTitle = jobRow ? jobRow.title : null;

//     // --- Fetch recipient’s FCM token ---
//     const [[recipient]] = await connection.query(
//       "SELECT fcm_token FROM user_device_tokens WHERE user_id= ?",
//       [contact_id]
//     );

//     const title = "New Job Contact";
//     const body = jobTitle
//       ? `${actorName} added you to job "${jobTitle}".`
//       : `${actorName} added you to a job.`;

//     // --- Insert notification record ---
//     const url = `/job`; // 👈 link to the job page
//     const insertNotifQuery = `
//       INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
//       VALUES (?, ?, ?, 1, ?, ?)
//     `;
//     await connection.query(insertNotifQuery, [
//       user_id,
//       contact_id,
//       body,
//       url,
//       user_id,
//     ]);

//     // --- Send FCM notification (if token exists) ---
//     if (recipient && recipient.fcm_token) {
//       const fcmToken = recipient.fcm_token;

//       const message = {
//         token: fcmToken,
//         notification: { title, body },
//         data: {
//           type: "job_contact",
//           job_id: String(job_id),
//           from_user_id: String(user_id),
//           url, // 👈 include link in FCM payload too
//         },
//       };

//       try {
//         await admin.messaging().send(message);
//         console.log("✅ Push notification sent to contact user:", contact_id);
//       } catch (notifyErr) {
//         console.error("❌ Error sending notification:", notifyErr);
//       }
//     } else {
//       console.warn(`⚠️ No FCM token found for user ${contact_id}`);
//     }

//     res.status(200).json({
//       code: "200",
//       message: "Contact added successfully",
//     });
//   } catch (error) {
//     logger.error(`Add Contact Error: ${error}`);
//     res.status(500).json({ code: "500", message: "Internal server error" });
//   } finally {
//     if (connection) connection.release();
//   }
// });



// Get all contacts for a specific job

router.post("/jobAddContact", auth.authenticateToken, async (req, res) => {
  const { job_id, contact_id } = req.body;
  const user_id = req.user.id;

  if (!job_id || !contact_id) {
    return res.status(400).json({
      code: "400",
      message: "job_id and contact_id are required",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // --- Check if contact already added ---
    const [existing] = await connection.query(
      `SELECT id FROM job_contacts 
       WHERE job_id = ? AND contact_id = ?`,
      [job_id, contact_id]
    );

    if (existing.length > 0) {
      return res.status(200).json({
        code: "200",
        message: "Contact already added",
      });
    }

    // --- Insert record ---
    const insertQuery = `
      INSERT INTO job_contacts (user_id, job_id, contact_id)
      VALUES (?, ?, ?)
    `;
    await connection.query(insertQuery, [user_id, job_id, contact_id]);

    // --- Fetch actor (adder) name ---
    const [[actorRow]] = await connection.query(
      "SELECT name FROM user WHERE id = ?",
      [user_id]
    );
    const actorName = actorRow ? actorRow.name : "Someone";

    // --- Fetch job title ---
    const [[jobRow]] =
      (await connection
        .query("SELECT name AS title FROM job WHERE id = ?", [job_id])
        .catch(() => [[]])) || [];
    const jobTitle = jobRow ? jobRow.title : null;

    // --- Fetch recipient’s FCM token ---
    const [[recipient]] = await connection.query(
      "SELECT fcm_token FROM user_device_tokens WHERE user_id= ?",
      [contact_id]
    );

    const title = "New Job Contact";
    const body = jobTitle
      ? `${actorName} added you to job "${jobTitle}".`
      : `${actorName} added you to a job.`;

    // --- Insert notification record ---
    const url = `/job`;
    const insertNotifQuery = `
      INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
      VALUES (?, ?, ?, 1, ?, ?)
    `;
    await connection.query(insertNotifQuery, [
      user_id,
      contact_id,
      body,
      url,
      user_id,
    ]);

    // --- Send FCM notification ---
    if (recipient && recipient.fcm_token) {
      const fcmToken = recipient.fcm_token;
      const message = {
        token: fcmToken,
        notification: { title, body },
        data: {
          type: "job_contact",
          job_id: String(job_id),
          from_user_id: String(user_id),
          url,
        },
      };

      try {
        await admin.messaging().send(message);
        console.log("✅ Push notification sent to contact user:", contact_id);
      } catch (notifyErr) {
        console.error("❌ Error sending notification:", notifyErr);
      }
    } else {
      console.warn(`⚠️ No FCM token found for user ${contact_id}`);
    }

    res.status(200).json({
      code: "200",
      message: "Contact added successfully",
    });
  } catch (error) {
    // --- Handle duplicate entry if UNIQUE constraint exists ---
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(200).json({
        code: "200",
        message: "Contact already added",
      });
    }

    logger.error(`Add Contact Error: ${error}`);
    res.status(500).json({ code: "500", message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

router.get(
  "/getJobContacts/:job_id",
  auth.authenticateToken,
  async (req, res) => {
    const { job_id } = req.params;
    //console.log("job id ", job_id);
    let connection;

    try {
      connection = await pool.getConnection();
      const query = `
      SELECT u.id, u.name, u.email, u.image, sc.name AS subcategory, jc.id as 'jcid'
      FROM job_contacts jc
      JOIN user u ON u.id = jc.contact_id
      LEFT JOIN subcategory sc ON u.subcategory = sc.id
      WHERE jc.job_id = ?
    `;
      const [rows] = await connection.query(query, [job_id]);

      res
        .status(200)
        .json({ code: "200", message: "Job contacts fetched", data: rows });
    } catch (error) {
      logger.error(`Get Job Contacts Error: ${error}`);
      res
        .status(500)
        .json({ code: "500", message: "Internal server error", data: [] });
    } finally {
      if (connection) connection.release();
    }
  }
);
// delete contacts for a specific job
router.delete("/deleteJobContact", auth.authenticateToken, async (req, res) => {
  const { job_id, contact_id } = req.query; // Use req.query for DELETE

  if (!job_id || !contact_id) {
    return res
      .status(400)
      .json({ code: "400", message: "job_id and contact_id are required" });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const deleteQuery = `
      DELETE FROM job_contacts 
      WHERE job_id = ? AND id = ?
    `;
    await connection.query(deleteQuery, [job_id, contact_id]);

    res
      .status(200)
      .json({ code: "200", message: "Contact deleted successfully" });
  } catch (error) {
    logger.error(`Delete Job Contact Error: ${error}`);
    res.status(500).json({ code: "500", message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// ----------------job's contact addition--------------

// Update a user
router.post("/updateuser", auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;
  // req.body.password = 'emptypassword'; // append the password
  const result = addUserSchema(req.body);
  const show_email = req.body.show_email ? 1 : 0;
  if (result.error) {
    res.status(200).json({
      code: "400",
      message: result.error.details[0].message,
      data: {},
    });
    return;
  }

  const r = req.body;
  let connection;
  const currentTimestamp = getTimeStamp();

  try {
    connection = await pool.getConnection();

    query =
      "UPDATE `user` SET `name` = ?, `email` = ? , `mobile` = ?, `category` = ?, `subcategory` = ?, `business` = ?, `organization_name` = ?, `trade` = ?, `social_security` = ?, `street` = ?, `city` = ?, `state` = ?, `zipcode` = ?, `contact_note` = ?, `updated_at` = ?, `updated_by` = ?, `secondary_email` = ?, `show_email`= ? , `time_zone` = ? WHERE (`id` = ?)";

    const [result] = await connection.query(query, [
      r.name,
      r.email,
      r.mobile,
      r.category,
      r.subcategory,
      r.business || r.business_name || "",
      r.organization_name || r.business_name || "",
      r.trade,
      r.social_security_num,
      r.street_address,
      r.city,
      r.state,
      r.zipcode,
      r.contact_notes,
      currentTimestamp,
      signedin_user,
      r.secondary_email,
      show_email,
      r.time_zone,
      signedin_user,
    ]);

    logger.info(`User updated successfully: Employee ID - ${signedin_user}`);
    res
      .status(200)
      .json({ code: "200", message: "User updated successfully", data: {} });
  } catch (error) {
    if (error.code == "ER_DUP_ENTRY") {
      logger.error("Update user error is:", error);
      res.status(200).json({
        code: "400",
        message: "Email and Mobile must be Unique",
        data: {},
      });
      return;
    } else {
      logger.error("Error adding user: ", error);
      res
        .status(200)
        .json({ code: "500", message: "Internal server error", data: {} });
      return;
    }
  } finally {
    if (connection) connection.release();
  }
});

router.post("/resendotp", async (req, res) => {
  const { signedin_useremail, signedin_user } = req.body; // Now coming from frontend
  const currentTimestamp = getTimeStamp();
  const otp = generateOTP();
  let connection;

  if (!signedin_useremail || !signedin_user) {
    return res.status(400).json({
      code: "400",
      message: "Email and User ID are required",
      data: {},
    });
  }

  const updateQuery = `
    UPDATE user 
    SET otp = ?, otp_status = 1, updated_at = ?, updated_by = ? 
    WHERE id = ? AND email = ?
  `;

  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(updateQuery, [
      otp,
      currentTimestamp,
      signedin_user, // updated_by
      signedin_user, // WHERE id = ?
      signedin_useremail, // WHERE email = ?
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: "404",
        message: "User not found",
        data: {},
      });
    }

    await sendOTPEmail(signedin_useremail, otp);

    return res.status(200).json({
      code: "200",
      message: "OTP resent successfully",
      data: {},
    });
  } catch (error) {
    logger.error("Error in resendotp:", error);
    return res.status(500).json({
      code: "500",
      message: "Internal server error",
      data: {},
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/changepassword", auth.authenticateToken, async (req, res) => {
  const r = req.body;
  const email = res.locals.email;
  const signedin_user = res.locals.id;
  let connection;

  if (!r.oldpassword && !r.newpassword) {
    logger.error("Change Password error, old and new password are required ");
    return res.status(200).json({
      code: "400",
      message: "Old and new password are required",
      data: {},
    });
  }

  query = "SELECT * FROM user WHERE email=?";

  const [result] = await connection.query(query, [email]);

  if (result.length <= 0) {
    logger.warn("User not found");
    return res
      .status(200)
      .json({ code: "400", message: "User not found", data: {} });
  } else {
    try {
      connection = await pool.getConnection();
      bcrypt.compare(r.oldpassword, result[0].password, (bErr, bResult) => {
        // wrong password
        if (bErr) {
          logger.error("Password comparison error:", bErr);
          return res
            .status(200)
            .json({ code: "500", message: "Internal server error", data: {} });
        }
        if (bResult) {
          bcrypt.hash(r.newpassword, 10, async (error, hash) => {
            if (error) {
              logger.error("Password hashing error:", error);
              return res.status(200).json({
                code: "500",
                message: "Internal server error",
                data: {},
              });
            } else {
              query =
                "UPDATE user SET password = ?, updated_by = ?, updated_at = NOW()  WHERE email = ?";

              const [result] = await connection.query(query, [
                hash,
                signedin_user,
                email,
              ]);
              logger.info(
                `self password update by successfully - ${signedin_user} - ${new Date()}`
              );
              return res.status(200).json({
                code: "200",
                data: {},
                message: "Password updated successfully",
              });
            }
          });
        } else {
          logger.warn("Incorrect old password");
          return res
            .status(200)
            .json({ code: "400", data: {}, message: "Incorrect Old Password" });
        }
      });
    } catch (error) {
      logger.error(`${error}`);
      res
        .status(200)
        .json({ code: "500", data: {}, message: "Something went wrong" });
      return;
    } finally {
      if (connection) connection.release();
    }
  }
});

router.post(
  "/picture",
  auth.authenticateToken,
  localupload.single("file"),
  async (req, res) => {
    const signedin_user = res.locals.id;
    let connection;

    if (req.file) {
      const uploadedFileName = req.file.filename;

      query =
        "UPDATE user SET image = ?, updated_by = ?, updated_at = NOW()  WHERE id = ?";

      try {
        connection = await pool.getConnection();
        const [result] = await connection.query(query, [
          uploadedFileName,
          signedin_user,
          signedin_user,
        ]);

        logger.info(
          `Profile picture update successfully - ${signedin_user} - ${new Date()}`
        );
        return res.status(200).json({
          code: "200",
          data: { image: `uploads/${uploadedFileName}` },
          message: "Profile picture  updated successfully",
        });
      } catch (error) {
        logger.error(`${error}`);
        res
          .status(200)
          .json({ code: "500", data: {}, message: "Something went wrong" });
        return;
      } finally {
        if (connection) connection.release();
      }
    } else {
      logger.warn("Create picture error is:", "File not found");
      return res
        .status(400)
        .json({ code: "400", data: {}, message: "File not found" });
    }
  }
);
// router.post("/verify-otp", async (req, res) => {
//   const { email, otp } = req.body;

//   if (!email || !otp) {
//     res
//       .status(400)
//       .json({ code: "400", message: "Email and OTP are required." });
//     return;
//   }

//   let connection;

//   try {
//     connection = await pool.getConnection();

//     // Check if OTP matches
//     const [users] = await connection.query(
//       "SELECT * FROM `user` WHERE `email` = ? AND `otp` = ? AND `otp_status` = 1",
//       [email, otp]
//     );

//     if (users.length === 0) {
//       res
//         .status(200)
//         .json({ code: "400", message: "Invalid OTP or already verified." });
//       return;
//     }

//     // Update otp_status to 0 after successful verification
//     await connection.query(
//       "UPDATE `user` SET `otp_status` = 0 WHERE `email` = ?",
//       [email]
//     );

//     res
//       .status(200)
//       .json({ code: "200", message: "OTP verified successfully." });
//   } catch (error) {
//     console.error("Error verifying OTP:", error);
//     res.status(500).json({ code: "500", message: "Internal server error." });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ code: "400", message: "Email and OTP are required." });
  }

  let connection;

  try {
    connection = await pool.getConnection();

    // 1) Check if OTP matches
    const [users] = await connection.query(
      "SELECT * FROM `user` WHERE `email` = ? AND `otp` = ? AND `otp_status` = 1",
      [email, otp]
    );

    if (users.length === 0) {
      return res.status(200).json({ code: "400", message: "Invalid OTP or already verified." });
    }

    const user = users[0];   // user record
    const userId = user.id;

    // 2) Update otp_status = 0
    await connection.query(
      "UPDATE `user` SET `otp_status` = 0 WHERE `email` = ?",
      [email]
    );

    // 3) INSERT DEFAULT JOB (only required fields)
    await connection.query(
      `INSERT INTO job (type, name, created_by)
       VALUES (?, ?, ?)`,
      ["Residential", "office/shop", userId]
    );

    return res.status(200).json({
      code: "200",
      message: "OTP verified successfully and default job created."
    });

  } catch (error) {
    console.error("Error verifying OTP:", error);
    return res.status(500).json({ code: "500", message: "Internal server error." });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  let connection;
  if (!email) {
    return res.status(400).json({ code: "400", message: "Email is required" });
  }

  try {
    connection = await pool.getConnection();

    // 1. Check if user exists
    const [rows] = await connection.query(
      "SELECT * FROM user WHERE email = ?",
      [email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ code: "404", message: "Email not found" });
    }

    const user = rows[0];

    // 2. Generate temp password
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // 3. Update password
    const [updateResult] = await connection.query(
      "UPDATE user SET password = ? WHERE id = ?",
      [hashedPassword, user.id]
    );

    // 4. Send temp password email
    await sendPasswordEmail(email, tempPassword);

    res
      .status(200)
      .json({ code: "200", message: "Temporary password sent to your email." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ code: "500", message: "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/get-user/:id", auth.authenticateToken, async (req, res) => {
  let user_id = req.params.id;
  let connection;
  try {
    connection = await pool.getConnection();
    query = `
      SELECT
        u.id,
        u.name,
        c.name AS category,
        u.state,
        u.secondary_email,
        u.show_email,
        c.id AS category_id,
        sc.id AS subcategory_id,
        sc.name AS subcategory,
        u.email,
        u.role AS role,
        r.name AS role_name,
        u.image,
        u.mobile,
        u.business,
        u.organization_name,
        u.trade,
        u.social_security,
        u.street,
        u.city,
        u.zipcode,
        u.contact_note,
        u.status,
        u.contact_available,
        u.time_zone
      FROM user u
      LEFT JOIN category c    ON c.id = u.category
      LEFT JOIN subcategory sc ON sc.id = u.subcategory
      LEFT JOIN role r          ON r.id = u.role
      WHERE u.id = ?
    `;
    const [rows] = await connection.query(query, [user_id]);
    res.status(200).json({
      code: "200",
      message: "Get user data successfully",
      data: rows[0],
    });
    return;
  } catch (error) {
    logger.error(`${error}`);
    res
      .status(200)
      .json({ code: "500", data: {}, message: "Something went wrong" });
    return;
  } finally {
    if (connection) connection.release();
  }
});
// routes/user.js
router.post("/send-recovery-email", async (req, res) => {
  const { recovery_email } = req.body;
  const otp = generateOTP(); // e.g., a 4-digit number
  const timestamp = getTimeStamp();

  let connection;

  try {
    connection = await pool.getConnection();
    // Check if user exists
    const [rows] = await connection.query(
      "SELECT id FROM user WHERE email = ?",
      [recovery_email]
    );
    if (rows.length === 0) {
      return res.status(200).json({ code: "404", message: "Email not found." });
    }

    // Update OTP and timestamp
    await connection.query(
      "UPDATE user SET otp = ?, otp_status = 1, updated_at = ? WHERE email = ?",
      [otp, timestamp, recovery_email]
    );

    // Send email
    await sendRecoveryEmail(recovery_email, otp); // Function using Nodemailer

    res.status(200).json({
      code: "200",
      message: "OTP sent to email successfully.",
      data: {},
    });
  } catch (err) {
    console.error("Error sending recovery email:", err);
    res.status(500).json({ code: "500", message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});
router.post("/update-password", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res
      .status(400)
      .json({ code: "400", message: "Missing email or password" });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const [user] = await pool.query("SELECT id FROM user WHERE email = ?", [
      email,
    ]);

    if (user.length === 0)
      return res.status(404).json({ code: "404", message: "User not found" });

    await pool.query("UPDATE user SET password = ? WHERE email = ?", [
      hashedPassword,
      email,
    ]);

    return res
      .status(200)
      .json({ code: "200", message: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ code: "500", message: "Internal server error" });
  }
});
router.get("/employee/:id", async (req, res) => {
  const id = req.params.id;
  let connection;

  try {
    connection = await pool.getConnection();

    // ✅ Fetch employee with leaves
    const [rows] = await connection.query(
      `
      SELECT 
          u.id, 
          u.name, 
          u.email, 
          u.mobile, 
          u.employment_type,
          u.rate,
          u.resignation_date,
          u.resignation_reason,
          u.exit_type,    
          sub.name AS subcategory_name, 
          sub.id AS subcategory_id,
          cat.name AS position,
          u.created_at AS hiringDate,
          -- 👇 Return leave_ids as array
          GROUP_CONCAT(DISTINCT el.id ORDER BY el.id SEPARATOR ',') AS leave_ids
      FROM user u
      LEFT JOIN subcategory sub ON u.subcategory = sub.id
      LEFT JOIN category cat ON cat.id = u.category
      LEFT JOIN employee_leaves_quota elq ON elq.emp_id = u.id
      LEFT JOIN employees_leaves el ON el.id = elq.leave_id
      WHERE u.id = ?
      GROUP BY 
          u.id, u.name, u.email, u.mobile, u.employment_type,
          u.rate, u.resignation_date, u.resignation_reason, u.exit_type,
          sub.name, cat.name, u.created_at, sub.id
      ORDER BY u.created_at DESC
    `,
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ code: "404", message: "Not found" });

    // ✅ Fetch assigned rights
    const [rightsRows] = await connection.query(
      `SELECT right_id, role_id FROM role_right_permission WHERE role_id = ? AND user_id = ?`,
      [rows[0].subcategory_id, id]
    );
    const right_ids = rightsRows.map((r) => r.right_id);
    const leave_ids = rows[0].leave_ids
      ? rows[0].leave_ids.split(",").map(Number)
      : [];

    res.json({
      code: "200",
      data: { ...rows[0], right_ids, leave_ids },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: "500", message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
});

// router.put("/employee/:id", async (req, res) => {
//   const id = req.params.id;
//   const { name, email, mobile, subcategory } = req.body;
//   let connection;
//   try {
//     connection = await pool.getConnection();
//     await connection.query(
//       `
//       UPDATE user SET name = ?, email = ?, mobile = ?, subcategory = ?
//       WHERE id = ?
//     `,
//       [name, email, mobile, subcategory, id]
//     );

//     res.json({ code: "200", message: "Employee updated successfully" });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ code: "500", message: "Update failed" });
//   }
//   finally {
//     if (connection) connection.release();   // ✅ releases no matter success or error
//   }
// });

router.put("/employee/:id", async (req, res) => {
  const id = req.params.id;
  const {
    name,
    email,
    mobile,
    subcategory,
    employment_type,
    rate,
    leave_ids = [],
    created_by,
  } = req.body;

  //const created_by = res.locals.id; // ✅ assuming this is from auth middleware
  const currentTimestamp = getTimeStamp(); // ✅ your timestamp helper

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ✅ Update employee info
    await connection.query(
      `
      UPDATE user 
      SET 
        name = ?, 
        email = ?, 
        mobile = ?, 
        subcategory = ?, 
        employment_type = ?, 
        rate = ?
      WHERE id = ?
      `,
      [name, email, mobile, subcategory, employment_type, rate, id]
    );

    // ✅ Refresh employee leaves
    await connection.query(
      `DELETE FROM employee_leaves_quota WHERE emp_id = ?`,
      [id]
    );

    if (Array.isArray(leave_ids) && leave_ids.length > 0) {
      const leaveValues = leave_ids.map((leaveId) => [
        id, // emp_id
        leaveId, // leave_id
        currentTimestamp, // created_at
        created_by, // created_by
      ]);
      await connection.query(
        `
        INSERT INTO employee_leaves_quota 
          (emp_id, leave_id, created_at, created_by) 
        VALUES ?
        `,
        [leaveValues]
      );
    }

    await connection.commit();
    res.json({ code: "200", message: "Employee updated successfully" });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error updating employee:", err);
    res.status(500).json({ code: "500", message: "Update failed" });
  } finally {
    if (connection) connection.release();
  }
});

// router.post("/addInspector", auth.authenticateToken, async (req, res) => {
//   const signedin_user = res.locals.id;
//   const currentTimestamp = getTimeStamp();

//   const {
//     inspector_name,
//     inspector_email,
//     inspector_mobile,
//     inspector_website,
//   } = req.body;

//   if (!inspector_name || !inspector_mobile) {
//     return res.status(400).json({
//       code: "400",
//       message: "Name, email, and mobile are required",
//       data: {},
//     });
//   }

//   const category = 2;
//   const subcategory = 13;
//   const password = await bcrypt.hash("1234567", 10);
//   const otp = generateOTP();

//   let connection;
//   try {
//     connection = await pool.getConnection();

//     const query = `
//       INSERT INTO \`user\` 
//       (\`name\`, \`email\`, \`password\`, \`role\`, \`mobile\`, \`category\`, \`subcategory\`, 
//        \`otp\`, \`otp_status\`, \`website_link\`, \`created_at\`, \`created_by\`)
//       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
//     `;

//     const [result] = await connection.query(query, [
//       inspector_name,
//       inspector_email || null,
//       password,
//       subcategory,
//       inspector_mobile,
//       category,
//       subcategory,
//       otp,
//       1, // otp_status
//       inspector_website,
//       currentTimestamp,
//       signedin_user,
//     ]);

//     logger.info("Inspector added successfully");
//     res.status(200).json({
//       code: "200",
//       message: "Inspector added successfully",
//       data: {
//         inspector_id: result.insertId,
//         inspector_name,
//         inspector_email,
//         inspector_mobile,
//         inspector_website,
//       },
//     });
//   } catch (error) {
//     if (error.code === "ER_DUP_ENTRY") {
//       logger.error("Create inspector error:", error);
//       res.status(400).json({
//         code: "400",
//         message: "Email and Mobile must be unique",
//         data: {},
//       });
//     } else {
//       res
//         .status(500)
//         .json({ code: "500", message: "Internal server error", data: {} });
//     }
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post("/addInspector", auth.authenticateToken, async (req, res) => {
  const signedin_user = res.locals.id;
  const currentTimestamp = getTimeStamp();
  console.log(req.body.job_id)

  const {
    inspector_name,
    inspector_email,
    inspector_mobile,
    inspector_website,
    job_id
  } = req.body;

  if (!inspector_name || !inspector_mobile) {
    return res.status(400).json({
      code: "400",
      message: "Inspector name and mobile are required",
      data: {}
    });
  }

  const category = 2;
  const subcategory = 13;
  const password = await bcrypt.hash("1234567", 10);
  const otp = generateOTP();

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1️⃣ Insert Inspector in user table
    const insertQuery = `
      INSERT INTO user 
      (name, email, password, role, mobile, category, subcategory, otp, otp_status, website_link, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    const [result] = await connection.query(insertQuery, [
      inspector_name,
      inspector_email || null,
      password,
      subcategory,
      inspector_mobile,
      category,
      subcategory,
      otp,
      1,
      inspector_website || null,
      currentTimestamp,
      signedin_user
    ]);

    const inspectorId = result.insertId;

    // 2️⃣ If job_id provided then check job table
    if (job_id) {

      const [jobRows] = await connection.query(
        "SELECT inspector_id FROM job WHERE id = ?",
        [job_id]
      );

      // 3️⃣ If job exists
      if (jobRows.length > 0) {

        const job = jobRows[0];

        // 4️⃣ If inspector_id is empty update it
        if (!job.inspector_id) {

          await connection.query(
            "UPDATE job SET inspector_id = ? WHERE id = ?",
            [inspectorId, job_id]
          );

        }

      }

    }

    await connection.commit();

    logger.info("Inspector added successfully");

    res.status(200).json({
      code: "200",
      message: "Inspector added successfully",
      data: {
        inspector_id: inspectorId,
        inspector_name,
        inspector_email,
        inspector_mobile,
        inspector_website
      }
    });

  } catch (error) {

    if (connection) await connection.rollback();

    if (error.code === "ER_DUP_ENTRY") {
      logger.error("Create inspector error:", error);
      return res.status(400).json({
        code: "400",
        message: "Email or Mobile already exists",
        data: {}
      });
    }

    logger.error("Internal server error:", error);

    res.status(500).json({
      code: "500",
      message: "Internal server error",
      data: {}
    });

  } finally {
    if (connection) connection.release();
  }
});

router.get("/tasks", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const userId = req.user.id;

    const [rows] = await connection.query(
      `SELECT 
         t.id, 
         t.task_name, 
         t.created_at, 
         u.name AS createdBy, 
         t.status,
         t.job_id,
         j.name AS jobName
       FROM tasks t
       INNER JOIN user u ON u.id = t.created_by
       inner JOIN job j ON j.id = t.job_id
       WHERE t.user_id = ? AND t.created_by = ?`,
      [userId, userId]
    );

    // ✅ If no rows, just return an empty array
    if (!rows || rows.length === 0) {
      return res.status(200).json([]);
    }

    res.status(200).json(rows);
  } catch (err) {
    logger.error("Error fetching tasks", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/getforemanusers", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const query = `
      SELECT u.id, u.name, c.name as category, sc.name as subcategory, u.email, r.name as role_name,
             u.image, u.mobile
      FROM user u
      JOIN category c ON c.id = u.category
      JOIN subcategory sc ON sc.id = u.subcategory
      JOIN role r ON r.id = u.role
      where u.role = 3
    `;
    const [rows] = await connection.query(query);
    res.status(200).json({
      code: "200",
      message: "All users fetched successfully",
      data: rows,
    });
  } catch (error) {
    logger.error(`${error}`);
    res
      .status(500)
      .json({ code: "500", data: [], message: "Something went wrong" });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/daily-report",
  localupload.array("photos", 10),
  auth.authenticateToken,
  async (req, res) => {
    const {
      date,
      project,
      foreman,
      hoursWorked,
      weather,
      completion,
      workDone,
      scheduleStatus,
      materials,
      materialsNotes,
      issues,
      issuesNotes,
      safetyChecks,
      safetyNotes,
      inspections,
      inspectionNotes,
      tomorrowPlan,
      needs,
      needsDetails,
      additionalNotes,
      crew,
      notes,
      report_status,
    } = req.body;

    const normalize = (value) =>
      value === "" || value === undefined ? null : value;
    const userId = req.user.id;
    let connection;
    try {
      connection = await pool.getConnection();
      const formattedDate = date
        ? new Date(date).toISOString().split("T")[0]
        : null;

      const [result] = await connection.query(
        `INSERT INTO daily_report
      (
        job_id, foreman_id, hours, weather_condition, progress,
        completion_note, status, crew, sub, crew_note, material,
        material_note, issue_note, safety, safety_note, inspection,
        inspection_note, plan, needs, needs_note, additional_note,
        report_status, issue, date
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          normalize(project),
          normalize(foreman),
          normalize(hoursWorked),
          JSON.stringify(weather || []),
          normalize(completion),
          normalize(workDone),
          normalize(scheduleStatus),
          crew?.ourCrew || 0,
          crew?.subs || 0,
          normalize(notes),
          JSON.stringify(materials || []),
          normalize(materialsNotes),
          normalize(issuesNotes),
          JSON.stringify(safetyChecks || []),
          normalize(safetyNotes),
          JSON.stringify(inspections || []),
          normalize(inspectionNotes),
          normalize(tomorrowPlan),
          JSON.stringify(needs || []),
          normalize(needsDetails),
          normalize(additionalNotes),
          normalize(report_status) || "draft",
          JSON.stringify(issues || []),
          formattedDate,
        ]
      );

      const reportId = result.insertId;

      const files = req.files || [];
      if (files.length > 0) {
        const docInserts = files.map((file) => [
          path.join("uploads", file.filename), // path
          file.filename, // name
          reportId, // report_id (FK to daily_report)
          file.mimetype, // mime_type
          userId, // created_by
          new Date(), // created_at
          null, // updated_by (initially null)
        ]);

        await connection.query(
          `INSERT INTO report_documents
    (path, name, report_id, mime_type, created_by, created_at, updated_by)
    VALUES ?`,
          [docInserts]
        );
      }
      res.json({
        message: "Daily report and photos saved successfully",
        report_id: reportId,
        uploaded_files: files.map((f) => f.filename),
      });
    } catch (err) {
      console.error("Error saving daily report:", err);
      res
        .status(500)
        .json({ message: "Database or upload error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET a specific daily report by ID
router.get("/daily-report", async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(`
      SELECT 
        dr.*, 
        j.name AS project
      FROM daily_report dr
      JOIN job j ON j.id = dr.job_id
      ORDER BY dr.date DESC
    `);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ message: "No daily reports found", data: [] });
    }

    const parsedReports = rows.map((report) => ({
      ...report,
      weather_condition: safeParse(report.weather_condition),
      material: safeParse(report.material),
      safety: safeParse(report.safety),
      inspection: safeParse(report.inspection),
      needs: safeParse(report.needs),
      issue: safeParse(report.issue),
    }));

    res.json({
      message: "Daily reports fetched successfully",
      data: parsedReports,
    });
  } catch (err) {
    console.error("Error fetching daily reports:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// small helper function to safely parse strings
function safeParse(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value || [];
  } catch {
    return [];
  }
}

router.put(
  "/daily-report/:id",
  localupload.array("photos", 10),
  auth.authenticateToken,
  async (req, res) => {
    const {
      date,
      project,
      foreman,
      hoursWorked,
      weather,
      completion,
      workDone,
      scheduleStatus,
      materials,
      materialsNotes,
      issues,
      issuesNotes,
      safetyChecks,
      safetyNotes,
      inspections,
      inspectionNotes,
      tomorrowPlan,
      needs,
      needsDetails,
      additionalNotes,
      crew,
      notes,
      report_status,
    } = req.body;

    const normalize = (value) =>
      value === "" || value === undefined ? null : value;
    const userId = req.user.id;
    const reportId = req.params.id;
    let connection;

    try {
      connection = await pool.getConnection();
      const formattedDate = date
        ? new Date(date).toISOString().split("T")[0]
        : null;

      // ✅ Step 1: Update the daily_report
      const [result] = await connection.query(
        `
      UPDATE daily_report
      SET 
        job_id = ?,
        foreman_id = ?,
        hours = ?,
        weather_condition = ?,
        progress = ?,
        completion_note = ?,
        status = ?,
        crew = ?,
        sub = ?,
        crew_note = ?,
        material = ?,
        material_note = ?,
        issue_note = ?,
        safety = ?,
        safety_note = ?,
        inspection = ?,
        inspection_note = ?,
        plan = ?,
        needs = ?,
        needs_note = ?,
        additional_note = ?,
        report_status = ?,
        issue = ?,
        date = ?
      WHERE id = ?
      `,
        [
          normalize(project),
          normalize(foreman),
          normalize(hoursWorked),
          JSON.stringify(weather || []),
          normalize(completion),
          normalize(workDone),
          normalize(scheduleStatus),
          crew?.ourCrew || 0,
          crew?.subs || 0,
          normalize(notes),
          JSON.stringify(materials || []),
          normalize(materialsNotes),
          normalize(issuesNotes),
          JSON.stringify(safetyChecks || []),
          normalize(safetyNotes),
          JSON.stringify(inspections || []),
          normalize(inspectionNotes),
          normalize(tomorrowPlan),
          JSON.stringify(needs || []),
          normalize(needsDetails),
          normalize(additionalNotes),
          normalize(report_status) || "draft",
          JSON.stringify(issues || []),
          formattedDate,
          reportId,
        ]
      );

      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Daily report not found" });

      const files = req.files || [];

      if (files.length > 0) {
        const docInserts = files.map((file) => [
          path.join("uploads", file.filename), // path
          file.filename, // name
          reportId, // report_id
          file.mimetype, // mime_type
          userId, // created_by
          new Date(), // created_at
          null, // updated_by
        ]);

        await connection.query(
          `INSERT INTO report_documents
        (path, name, report_id, mime_type, created_by, created_at, updated_by)
        VALUES ?`,
          [docInserts]
        );
      }

      res.json({
        message: "Daily report updated successfully",
        report_id: reportId,
        uploaded_files: files.map((f) => f.filename),
      });
    } catch (err) {
      console.error("Error updating daily report:", err);
      res
        .status(500)
        .json({ message: "Database or upload error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.delete("/daily-report/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID
    if (!id) {
      return res.status(400).json({ message: "Report ID is required." });
    }

    // Check if report exists
    const [existing] = await pool.query(
      "SELECT * FROM daily_report WHERE id = ?",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: "Daily report not found." });
    }

    // Delete the report
    await pool.query("DELETE FROM daily_report WHERE id = ?", [id]);

    return res.status(200).json({
      message: "Daily report deleted successfully.",
      success: true,
      deletedId: id,
    });
  } catch (error) {
    console.error("Error deleting daily report:", error);
    res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});



router.get("/employee-status/:managerId", async (req, res) => {
  const { managerId } = req.params;

  try {
    // 1️⃣ All employees created by this manager (exclude manager)
    const [employees] = await pool.query(
      `SELECT id, name, email 
       FROM user
       WHERE created_by = ?
       AND id != ?`,
      [managerId, managerId]
    );

    if (!employees.length) {
      return res.status(200).json({
        success: true,
        message: "No employees found for this manager",
        data: { clocked_in: [], clocked_out: [], absent: [], on_leave: [] },
      });
    }

    const employeeIds = employees.map((e) => e.id);

    // 2️⃣ Latest clock-in log for each employee today
    const [taskLogs] = await pool.query(
      `SELECT c.created_by AS employee_id, c.is_task_active
       FROM clockin c
       INNER JOIN (
           SELECT created_by, MAX(start_time) AS latest_start
           FROM clockin
           WHERE DATE(start_time) = CURDATE()
           GROUP BY created_by
       ) latest ON c.created_by = latest.created_by AND c.start_time = latest.latest_start
       WHERE c.created_by IN (?)`,
      [employeeIds]
    );

    //  Get all employees who are on leave *today* (any status)
    const [leaveRecords] = await pool.query(
      `SELECT 
          l.id as leave_id, 
          u.id as employee_id, 
          u.name, 
          u.email, 
          l.from_date, 
          l.to_date, 
          l.status,
          l.approver
       FROM leave_request l
       JOIN user u ON u.id = l.emp_id
       WHERE u.created_by = ?
       AND CURDATE() BETWEEN l.from_date AND l.to_date`,
      [managerId]
    );

    //  Categorize users
    const clocked_in = [];
    const clocked_out = [];
    const absent = [];
    const on_leave = [];

    employees.forEach((emp) => {
      const leave = leaveRecords.find((l) => l.employee_id === emp.id);
      const log = taskLogs.find((t) => t.employee_id === emp.id);

      if (leave) {
        on_leave.push(leave);
      } else if (!log) {
        absent.push(emp);
      } else if (log.is_task_active === 1) {
        clocked_in.push(emp);
      } else {
        clocked_out.push(emp);
      }
    });

    res.status(200).json({
      success: true,
      data: {
        clocked_in,
        clocked_out,
        absent,
        on_leave,
      },
    });
  } catch (err) {
    console.error("Error fetching employee status:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch employee status",
      error: err.message,
    });
  }
});

router.put("/approve-leave/:leaveId", async (req, res) => {
  try {
    const { leaveId } = req.params;
    const { approverId } = req.body;

    const [result] = await pool.query(
      `UPDATE leave_request
       SET status = 'approved', approver = ? 
       WHERE id = ?`,
      [approverId, leaveId]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Leave not found" });
    }

    res.status(200).json({
      success: true,
      message: "Leave approved successfully",
    });
  } catch (err) {
    console.error(" Error approving leave:", err);
    res.status(500).json({
      success: false,
      message: "Failed to approve leave",
      error: err.message,
    });
  }
});

router.post('/check-email', async (req, res) => {
  const { email } = req.body;
  try {
    const [rows] = await pool.query('SELECT id FROM user WHERE email = ?', [email]);
    res.json({ exists: rows.length > 0 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error checking email' });
  }
});

router.get("/check-device", async (req, res) => {
 
  const deviceToken = req.cookies.device_token;
  console.log('token:',deviceToken);

  if (!deviceToken) {
    return res.json({ allowPinLogin: false });
  }

  const [rows] = await pool.query(
    `SELECT u.pin_hash
     FROM user_devices ud
     JOIN user u ON u.id = ud.user_id
     WHERE ud.device_token = ?`,
    [deviceToken]
  );

  if (!rows.length || !rows[0].pin_hash) {
    return res.json({ allowPinLogin: false });
  }

  return res.json({ allowPinLogin: true });
});



// ── Hidden impersonation endpoints ───────────────────────────────────
// Restricted to a single super-admin user (gc gc, id = 246). These endpoints
// power a hidden "Impersonate" tab in the Angular app that lets that user
// log in as any other user without their password.
const IMPERSONATOR_USER_ID = 246;

function requireImpersonator(req, res, next) {
  if (Number(req.user?.id) !== IMPERSONATOR_USER_ID) {
    return res.status(403).json({ code: '403', message: 'Forbidden', data: {} });
  }
  next();
}

// List every user in the system (id, name, email, role, category, mobile).
router.get(
  '/admin/all-system-users',
  auth.authenticateToken,
  requireImpersonator,
  async (req, res) => {
    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        `SELECT u.id, u.name, u.email, u.mobile, u.role,
                r.name AS role_name,
                u.category, c.name AS category_name,
                u.image
           FROM user u
           LEFT JOIN role r ON r.id = u.role
           LEFT JOIN category c ON c.id = u.category
          WHERE u.id <> ?
          ORDER BY u.name ASC`,
        [IMPERSONATOR_USER_ID]
      );
      return res.status(200).json({
        code: '200',
        message: 'All system users fetched',
        data: rows,
      });
    } catch (error) {
      logger.error(`${error}`);
      return res.status(500).json({ code: '500', message: 'Server error', data: [] });
    } finally {
      if (connection) connection.release();
    }
  }
);

// Issue a JWT for an arbitrary user. Mirrors the payload shape used by the
// regular login flow (see /login endpoint above) so the frontend can reuse
// the same login-side handlers.
router.post(
  '/admin/impersonate/:id',
  auth.authenticateToken,
  requireImpersonator,
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ code: '400', message: 'Invalid user id', data: {} });
    }
    if (targetId === IMPERSONATOR_USER_ID) {
      return res.status(400).json({ code: '400', message: 'Already this user', data: {} });
    }

    let connection;
    try {
      connection = await pool.getConnection();

      const [users] = await connection.query(
        `SELECT id, name, email, role, otp_status, must_change_password, image, created_by
           FROM user WHERE id = ? LIMIT 1`,
        [targetId]
      );
      if (!users.length) {
        return res.status(404).json({ code: '404', message: 'User not found', data: {} });
      }
      const user = users[0];

      const role = Number(user.role);
      const working_id = [2, 3, 4, 5].includes(role) ? user.created_by : user.id;

      // Same rights query as the regular login flow.
      let rights = [];
      if ([2, 3, 4, 5, 12].includes(role)) {
        const [rightsRows] = await connection.query(
          `SELECT r.display_name, r.name, rrp.read, rrp.create, rrp.update, rrp.delete, rrp.user_id AS emp_id
             FROM role_right_permission rrp
             JOIN \`right\` r ON r.id = rrp.right_id
            WHERE rrp.role_id = ? AND rrp.user_id = ? AND r.sub_heading = 0`,
          [role, user.id]
        );
        rights = rightsRows;
      }

      const basicData = {
        id: user.id,
        name: user.name,
        email: user.email,
        role,
        rights,
        working_id,
        // Impersonation bypasses OTP/password gates by definition — the
        // super-admin is already authenticated. Force these to a "verified"
        // state in the issued token so the frontend doesn't bounce to the
        // verify-OTP / change-password screens.
        otp_status: 0,
        must_change_password: 0,
      };

      const accessToken = jwt.sign(basicData, process.env.ACCESS_TOKEN, { expiresIn: '7d' });
      const photoName = user.image || 'user.png';

      logger.info(
        `Impersonation: user 246 -> ${user.id} (${user.email}) - ${new Date()}`
      );

      return res.status(200).json({
        code: '200',
        message: 'Impersonation token issued',
        data: { token: accessToken, basicData, photoName },
      });
    } catch (error) {
      logger.error(`${error}`);
      return res.status(500).json({ code: '500', message: 'Server error', data: {} });
    } finally {
      if (connection) connection.release();
    }
  }
);

module.exports = router;
