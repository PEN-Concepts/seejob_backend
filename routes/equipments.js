const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");
var auth = require("../services/authentication");
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

// router.post("/create",  upload.single("image"),auth.authenticateToken, async (req, res) => {
//   let connection;
//   try {
//     const {
//       equipment_name,
//       job_id,
//       managed_by,
//       start_date,
//       end_date,
//       user_id,
//       job_location
//     } = req.body;

//     const created_by = res.locals.id;
//     const currentTimestamp = getTimeStamp();

//     const startDate = formatDate(start_date);
//     const endDate = formatDate(end_date);

//     if (!equipment_name) {
//       return res.status(400).json({ message: "Equipment name is required" });
//     }

//     const is_assigned = managed_by != null ? 1 : 0;

//     connection = await pool.getConnection();

//     const [result] = await connection.execute(
//       `INSERT INTO equipments 
//        (user_id, equipment_name, job_id, managed_by, start_date, end_date, is_assigned, created_at, created_by, job_location)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//       [
//         user_id,
//         equipment_name,
//         job_id,
//         managed_by ?? null,
//         startDate,
//         endDate,
//         is_assigned,
//         currentTimestamp,
//         created_by,
//         job_location
//       ]
//     );

//     res.status(201).json({
//       success: true,
//       message: "Equipment created successfully",
//       equipment_id: result.insertId,
//     });

//   } catch (err) {
//     res.status(500).json({ message: "Database error", error: err.message });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.post(
  "/create",
  auth.authenticateToken,
  upload.single("image"),
  async (req, res) => {
    let connection;
    console.log(req.file );
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
      console.error(err);
      res.status(500).json({
        message: "Database error",
        error: err.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);


// router.get("/list", auth.authenticateToken, async (req, res) => {
//   const created_by = res.locals.id;
//   let connection;
//   try {
//     connection = await pool.getConnection();
//     const [rows] = await connection.execute(
//       `
//       SELECT 
//         e.id,
//         e.equipment_name,
//         DATE(e.start_date) as start_date,
//         DATE(e.end_date) as end_date,
//         e.is_assigned,
//         j.id As job_id,
//         j.name AS job_name,
//         u.id  AS managed_by,
//         u.name AS user_name,
//         e.job_location
//       FROM equipments e
//       LEFT JOIN job j ON e.job_id = j.id
//       LEFT JOIN user u ON e.managed_by = u.id
//       WHERE e.created_by = ?
//       ORDER BY e.id DESC
//       `,
//       [created_by]
//     );

//     res.json({ success: true, data: rows });
//   } catch (err) {
//     res.status(500).json({ message: "Database error", error: err.message });
//   } finally {
//     if (connection) connection.release();
//   }
// });

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


// router.put("/update/:id", auth.authenticateToken, async (req, res) => {
//   let connection;
//   try {
//     const { id } = req.params;
//     const {
//       equipment_name,
//       job_id,
//       managed_by,
//       start_date,
//       end_date
//     } = req.body;

//     const updated_at = getTimeStamp();
//     const updated_by = res.locals.id;

//     // ✅ DERIVE is_assigned from managed_by
//     const is_assigned = managed_by !== null ? 1 : 0;


//     connection = await pool.getConnection();

//     const [result] = await connection.execute(
//       `UPDATE equipments 
//        SET equipment_name = ?, 
//            job_id = ?, 
//            managed_by = ?, 
//            start_date = ?, 
//            end_date = ?, 
//            is_assigned = ?, 
//            updated_at = ?, 
//            updated_by = ? 
//        WHERE id = ?`,
//       [
//         equipment_name,
//         job_id,
//         managed_by,
//         start_date,
//         end_date,
//         is_assigned,
//         updated_at,
//         updated_by,
//         id
//       ]
//     );

//     if (result.affectedRows === 0) {
//       return res.status(404).json({ message: "Equipment not found" });
//     }

//     res.json({
//       success: true,
//       message: "Equipment updated successfully"
//     });

//   } catch (err) {
//     res.status(500).json({ message: "Database error", error: err.message });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.put(
  "/update/:id",
  auth.authenticateToken,
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
        is_assigned,   // ✅ directly from frontend
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
          is_assigned,      // ✅ used as-is
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
      console.error(err);
      res.status(500).json({
        message: "Database error",
        error: err.message
      });
    } finally {
      if (connection) connection.release();
    }
  }
);



router.delete("/delete/:id", auth.authenticateToken, async (req, res) => {
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