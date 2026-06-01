const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const PDFDocument = require("pdfkit");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const mammoth = require("mammoth");
const { upload } = require("../services/fileUpload");
const nodemailer = require("nodemailer");
var auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");

// List all safety courses
router.get("/course", auth.authenticateToken, async (req, res) => {
  const created_by = res.locals.id;
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM safety_cours`
    );

    res.status(200).json({ code: "200", message: "Courses fetched", data: rows });
  } catch (err) {
    res.status(500).json({ code: "500", message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Overall course statistics for dashboard
router.get("/getCourseStats", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT 
         COUNT(*) AS total_classes,
         SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS completed_classes,
         SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS remaining_classes
       FROM safety_cours`
    );

    const stats = rows[0] || {
      total_classes: 0,
      completed_classes: 0,
      remaining_classes: 0,
    };

    // For now we don't track real next_due, so send 'N/A'
    const response = {
      total_classes: stats.total_classes || 0,
      completed_classes: stats.completed_classes || 0,
      remaining_classes: stats.remaining_classes || 0,
      next_due: "N/A",
    };

    return res.status(200).json({
      code: "200",
      message: "Course stats fetched successfully",
      data: response,
    });
  } catch (err) {
    console.error("Error fetching course stats:", err);
    return res.status(500).json({
      code: "500",
      message: "Database error while fetching course stats",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// Training records for a course
router.get("/safety-records/:courseId", async (req, res) => {
  const { courseId } = req.params;
  if (!courseId) {
    return res.status(400).json({
      code: "400",
      message: "Course ID is required",
      data: [],
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT 
    tr.id,
    tr.training_date,
    tr.safety_course_id,
    tr.duration,
    tr.created_at,
    tr.created_by,
    u2.name AS Instructor,
    COUNT(u1.id) AS total_attendees,
    GROUP_CONCAT(u1.name SEPARATOR ', ') AS Attendees
FROM safety_traning_records tr
JOIN safety_training_attendees ta 
    ON tr.safety_course_id = ta.safety_course_id
    AND DATE_FORMAT(tr.created_at, '%Y-%m-%d %H:%i:%s') = DATE_FORMAT(ta.created_at, '%Y-%m-%d %H:%i:%s')
JOIN user u1 ON ta.user_id = u1.id
JOIN user u2 ON tr.created_by = u2.id
WHERE tr.safety_course_id = ?
GROUP BY 
    tr.id, tr.training_date, tr.safety_course_id, tr.duration, tr.created_at, tr.created_by, u2.name
ORDER BY tr.training_date DESC;`,
      [courseId]
    );

    if (rows.length === 0) {
      return res.status(200).json({
        code: "200",
        message: "No training records found for this course",
        data: [],
      });
    }

    return res.status(200).json({
      code: "200",
      message: "Records fetched successfully",
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching records:", error);
    return res.status(500).json({
      code: "500",
      message: "Server error",
      data: [],
    });
  } finally {
    if (connection) connection.release();
  }
});

// Runtime training content from Word attachment or description
router.get("/content/:courseId", async (req, res) => {
  const courseId = req.params.courseId;
  let connection;

  try {
    connection = await pool.getConnection();

    // Get course info including attachment filename
    const [courses] = await connection.query(
      "SELECT id, name, description, attachments FROM safety_cours WHERE id = ?",
      [courseId]
    );

    if (!courses.length) {
      return res.status(404).json({
        code: "404",
        message: "Course not found",
        data: [],
      });
    }

    const course = courses[0];

    // If no attachment, fall back to description only
    if (!course.attachments) {
      return res.status(200).json({
        code: "200",
        message: "No attachment found; returning course description only",
        data: course.description
          ? [
              {
                heading: course.name,
                content: course.description,
              },
            ]
          : [],
      });
    }

    // Build file path for the uploaded Word file
    const filePath = path.join(__dirname, "..", "uploads", course.attachments);

    if (!fs.existsSync(filePath)) {
      console.warn("Attachment file not found:", filePath);
      return res.status(200).json({
        code: "200",
        message: "Attachment file missing; returning course description only",
        data: course.description
          ? [
              {
                heading: course.name,
                content: course.description,
              },
            ]
          : [],
      });
    }

    // Read Word file at runtime and extract HTML content
    let longText = "";
    try {
      const buffer = fs.readFileSync(filePath);
      const result = await mammoth.convertToHtml({ buffer });
      longText = (result.value || "").trim();
    } catch (parseErr) {
      console.error("Error parsing Word attachment for training content:", parseErr);
    }

    const contentText = longText || course.description || "";

    return res.status(200).json({
      code: "200",
      message: "Training content fetched from attachment",
      data: contentText
        ? [
            {
              heading: course.name,
              content: contentText,
            },
          ]
        : [],
    });
  } catch (err) {
    console.error("Error fetching training content:", err);
    return res.status(500).json({
      code: "500",
      message: "Server error while fetching training content",
      data: [],
    });
  } finally {
    if (connection) connection.release();
  }
});

// Complete class endpoint (kept as before)
router.post("/complete-class", async (req, res) => {
  const { safety_course_id, duration, created_by, attendees } = req.body;
  console.log("Duration:", duration);

  const currentTimestamp = getTimeStamp();
  const trainingDate = currentTimestamp;
  const createdAt = currentTimestamp;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [recordResult] = await connection.query(
      `INSERT INTO safety_traning_records 
       (training_date, safety_course_id, duration, created_at, created_by) 
       VALUES (?, ?, ?, ?, ?)`,
      [trainingDate, safety_course_id, duration, createdAt, created_by]
    );

    if (attendees && attendees.length > 0) {
      const attendeeValues = attendees.map((userId) => [
        userId,
        safety_course_id,
        createdAt,
        created_by,
      ]);

      await connection.query(
        `INSERT INTO safety_training_attendees 
         (user_id, safety_course_id, created_at, created_by) 
         VALUES ?`,
        [attendeeValues]
      );
    }

    const [hours, minutes, seconds] = duration.split(":").map(Number);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;

    if (totalSeconds >= 300) {
      await connection.query(
        `UPDATE safety_cours 
         SET status = 1 
         WHERE id = ?`,
        [safety_course_id]
      );
      console.log("✅ Course marked as completed");
    }

    await connection.commit();

    res.status(200).json({
      code: "200",
      message: "Class completed successfully and status updated if applicable",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("❌ Error completing class:", error);
    res.status(500).json({
      code: "500",
      message: "Error completing class",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// Simple /course creator with file upload
router.post("/course", auth.authenticateToken, upload.single("file"), async (req, res) => {
  const { name, description, duration, status, generated_by } = req.body;
  const created_by = res.locals.id;

  if (!name || !description || !duration) {
    return res.status(400).json({
      code: "400",
      message: "name, description and duration are required",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(
      `
      INSERT INTO safety_cours
        (name, description, duration, status, created_at, created_by, generated_by, attachments)
      VALUES
        (?, ?, ?, ?, NOW(), ?, ?, ?)
      `,
      [
        name,
        description,
        duration,
        status ?? 0,
        created_by,
        generated_by || null,
        req.file ? req.file.filename : null,
      ]
    );

    return res.status(201).json({
      code: "201",
      message: "Course created successfully",
      data: { id: result.insertId },
    });
  } catch (err) {
    console.error("Error creating course:", err);
    return res.status(500).json({
      code: "500",
      message: "Database error while creating course",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

// Update existing safety course
router.put("/course/:id", auth.authenticateToken, upload.single("file"), async (req, res) => {
  const { id } = req.params;
  const { name, description, duration, status, generated_by } = req.body;

  if (!id) {
    return res.status(400).json({
      code: "400",
      message: "Course ID is required",
    });
  }

  if (!name || !description || !duration) {
    return res.status(400).json({
      code: "400",
      message: "name, description and duration are required",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Build dynamic query depending on whether a new file was uploaded
    let query = `
      UPDATE safety_cours
      SET name = ?,
          description = ?,
          duration = ?,
          status = ?,
          generated_by = ?`;
    const params = [
      name,
      description,
      duration,
      status ?? 0,
      generated_by || null,
    ];

    if (req.file) {
      query += `,
          attachments = ?`;
      params.push(req.file.filename);
    }

    query += `
      WHERE id = ?`;
    params.push(id);

    const [result] = await connection.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        code: "404",
        message: "Course not found",
      });
    }

    return res.status(200).json({
      code: "200",
      message: "Course updated successfully",
    });
  } catch (err) {
    console.error("Error updating course:", err);
    return res.status(500).json({
      code: "500",
      message: "Database error while updating course",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
