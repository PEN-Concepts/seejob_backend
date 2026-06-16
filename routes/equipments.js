const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const auth = require("../services/authentication");
const { denyExpiredFreeWrites } = require("../utils/access");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});

const upload = multer({ storage });

const formatDate = (d) => {
  if (!d) return null;

  const date = new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString().split("T")[0];
};

router.post(
  "/create",
  auth.authenticateToken,
  denyExpiredFreeWrites,
  upload.single("image"),
  async (req, res) => {
    let connection;
    logger.info("Equipment file upload received");
    try {
      const {
        equipment_name,
        year,
        license,
        vin,
        current_location,
        job_location,
        status
      } = req.body;

      const created_by = res.locals.id;

      if (!equipment_name) {
        return res.status(400).json({
          message: "Equipment name is required",
        });
      }

      const image = req.file ? req.file.filename : null;

      connection = await pool.getConnection();

      const [result] = await connection.execute(
        `INSERT INTO equipments 
        (equipment_name, year, license, vin, current_location, job_location, image, is_assigned, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          equipment_name,
          year ?? null,
          license ?? null,
          vin ?? null,
          current_location ?? null,
          job_location ?? null,
          image,
          status ?? 0,
          created_by
        ]
      );

      res.status(201).json({
        success: true,
        message: "Equipment created successfully",
        equipment_id: result.insertId,
      });

    } catch (err) {
      logger.error("Error creating equipment:", err);
      res.status(500).json({
        message: "Database error",
        error: err.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);


router.get("/list", auth.authenticateToken, async (req, res) => {
  const created_by = res.locals.id;
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `
      SELECT 
        id,
        equipment_name,
        year,
        license,
        vin,
        current_location,
        job_location,
        image,
        is_assigned,
        created_at
      FROM equipments
      WHERE created_by = ?
      ORDER BY id DESC
      `,
      [created_by]
    );

    res.json({
      success: true,
      data: rows
    });

  } catch (err) {
    res.status(500).json({
      message: "Database error",
      error: err.message
    });
  } finally {
    if (connection) connection.release();
  }
});


router.put(
  "/update/:id",
  auth.authenticateToken,
  denyExpiredFreeWrites,
  upload.single('image'),
  async (req, res) => {

    let connection;
    try {
      const { id } = req.params;

      const {
        equipment_name,
        year,
        license,
        vin,
        current_location,
        is_assigned,   // âœ… directly from frontend
        job_id,
        job_location,
        managed_by
      } = req.body;

      const updated_at = getTimeStamp();
      const updated_by = res.locals.id;

      // image (optional)
      let imagePath = null;
      if (req.file) {
        imagePath = req.file.filename;
      }

      connection = await pool.getConnection();

      const [result] = await connection.execute(
        `
        UPDATE equipments
        SET
          equipment_name = ?,
          year = ?,
          license = ?,
          vin = ?,
          current_location = ?,
          job_id = ?,
          job_location = ?,
          managed_by = ?,
          is_assigned = ?,
          image = COALESCE(?, image),
          updated_at = ?,
          updated_by = ?
        WHERE id = ?
        `,
        [
          equipment_name,
          year || null,
          license || null,
          vin || null,
          current_location || null,
          job_id || null,
          job_location || null,
          managed_by || null,
          is_assigned,      // âœ… used as-is
          imagePath,
          updated_at,
          updated_by,
          id
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Equipment not found" });
      }

      res.json({
        success: true,
        message: "Equipment updated successfully"
      });

    } catch (err) {
      logger.error("Error updating equipment:", err);
      res.status(500).json({
        message: "Database error",
        error: err.message
      });
    } finally {
      if (connection) connection.release();
    }
  }
);



router.delete("/delete/:id", auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const created_by = res.locals.id;

    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `DELETE FROM equipments WHERE id = ? AND created_by = ?`,
      [id, created_by]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Equipment not found or not authorized" });
    }

    res.json({ success: true, message: "Equipment deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put(
  "/toggle-assignment",
  auth.authenticateToken,
  denyExpiredFreeWrites,
  async (req, res) => {
    const { id, is_assigned } = req.body;
    const created_by = res.locals.id;
    let connection;

    try {
      connection = await pool.getConnection();

      await connection.execute(
        `UPDATE equipments
         SET is_assigned = ?
         WHERE id = ? AND created_by = ?`,
        [is_assigned, id, created_by]
      );

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({
        message: "Database error",
        error: err.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);

module.exports = router;
