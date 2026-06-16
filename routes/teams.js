const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const auth = require("../services/authentication");
const { denyExpiredFreeWrites } = require("../utils/access");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");

// helper to convert incoming date (ISO or date string) -> 'YYYY-MM-DD' or null
function toSqlDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

router.post("/create", auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  let connection;
  try {
    const { team_name, team_color, job_id, team_leader, start_date, end_date, team_users } = req.body;
    const created_by = res.locals.id;
    const currentTimestamp = getTimeStamp();

    const startDate = toSqlDate(start_date);
    const endDate = toSqlDate(end_date);

    if (!team_name || !team_color || !job_id || !team_leader) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "Invalid or missing start/end date" });
    }

    if (new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ message: "End date must be same or after start date" });
    }

    connection = await pool.getConnection();

    // âœ… COLOR UNIQUENESS CHECK
    const [existingColor] = await connection.execute(
      `SELECT id FROM teams WHERE team_color = ? AND created_by = ? LIMIT 1`,
      [team_color, created_by]
    );

    if (existingColor.length > 0) {
      return res.status(409).json({
        message: "You already have a team with this color. Please choose another color."
      });
    }

    await connection.beginTransaction();

    const [teamResult] = await connection.execute(
      `INSERT INTO teams 
        (team_name, team_color, job_id, team_leader, start_date, end_date, created_by, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [team_name, team_color, job_id, team_leader, startDate, endDate, created_by, currentTimestamp]
    );

    const teamId = teamResult.insertId;

    if (Array.isArray(team_users) && team_users.length > 0) {
      await Promise.all(
        team_users.map(userId =>
          connection.execute(
            `INSERT INTO team_user (team_id, user_id, login_user) VALUES (?, ?, ?)`,
            [teamId, userId, created_by]
          )
        )
      );
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Team created successfully",
      team_id: teamId,
    });

  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Create team error:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.put("/update/:id", auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
  let connection;
  const teamId = req.params.id;

  try {
    const {
      team_name,
      team_color,
      job_id,
      team_leader,
      start_date,
      end_date,
      team_users = []
    } = req.body;

    const updated_by = res.locals.id;
    const currentTimestamp = getTimeStamp();

    const startDate = toSqlDate(start_date);
    const endDate = toSqlDate(end_date);

    if (!team_name || !team_color || !job_id || !team_leader) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "Invalid or missing start/end date" });
    }

    if (new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ message: "End date must be same or after start date" });
    }

    connection = await pool.getConnection();

    // âœ… COLOR UNIQUENESS CHECK (exclude current team)
    const [existingColor] = await connection.execute(
      `SELECT id FROM teams 
       WHERE team_color = ? 
       AND created_by = ? 
       AND id != ?
       LIMIT 1`,
      [team_color, updated_by, teamId]
    );

    if (existingColor.length > 0) {
      return res.status(409).json({
        message: "Another team with this color already exists. Please choose a different color."
      });
    }

    await connection.beginTransaction();

    await connection.execute(
      `UPDATE teams SET
        team_name = ?,
        team_color = ?,
        job_id = ?,
        team_leader = ?,
        start_date = ?,
        end_date = ?,
        created_by = ?,
        updated_at = ?
       WHERE id = ?`,
      [team_name, team_color, job_id, team_leader, startDate, endDate, updated_by, currentTimestamp, teamId]
    );

    await connection.execute(`DELETE FROM team_user WHERE team_id = ?`, [teamId]);

    if (Array.isArray(team_users) && team_users.length > 0) {
      await Promise.all(
        team_users.map(userId =>
          connection.execute(
            `INSERT INTO team_user (team_id, user_id, login_user) VALUES (?, ?, ?)`,
            [teamId, userId, updated_by]
          )
        )
      );
    }

    await connection.commit();

    res.json({ success: true, message: "Team updated successfully", team_id: teamId });

  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Update team error:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});




router.get("/all", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    // First, get teams with job + leader info
    const [teams] = await connection.execute(
      `SELECT 
          t.id AS team_id,
          t.team_name,
          t.team_color,
          t.job_id,
          j.name as job_name,
          t.team_leader,
          u.name AS team_leader_name,
          t.start_date,
          t.end_date
       FROM teams t
       LEFT JOIN job j ON t.job_id = j.id
       LEFT JOIN user u ON t.team_leader = u.id
       ORDER BY t.id DESC`
    );

    // Now, fetch members for each team
    for (let team of teams) {
      const [members] = await connection.execute(
        `SELECT tu.user_id, u.name , s.name as role
         FROM team_user tu
         LEFT JOIN user u ON tu.user_id = u.id
         left join subcategory s on u.subcategory = s.id
         WHERE tu.team_id = ?`,
        [team.team_id]
      );
      team.members = members;
    }

    res.json({ success: true, data: teams });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.delete('/teams/:id', async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await pool.getConnection();

    // Delete team members first
    await connection.execute(
      'DELETE FROM team_user WHERE team_id = ?',
      [id]
    );

    // Delete the team itself
    const [teamResult] = await connection.execute(
      'DELETE FROM teams WHERE id = ?',
      [id]
    );

    if (teamResult.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Team not found or already deleted',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Team deleted successfully',
    });

  } catch (err) {
    logger.error('Delete team error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error while deleting team',
      error: err.sqlMessage || err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});




module.exports = router;
