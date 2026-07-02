const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const { addcontactSchema } = require("../models/notepad");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require('nodemailer');
var auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");


const mime = require('mime-types');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// Optional: Filter to accept only image and audio files
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image and audio files are allowed'), false);
  }
};

const upload = multer({ storage, fileFilter });


router.get('/get_user',auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`SELECT u.*, sc.name as 'designation'  FROM user u left JOIN subcategory sc ON sc.id = u.subcategory where status = 1 AND u.category <> 1 ORDER BY created_at DESC;`);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.post('/add', auth.authenticateToken, async (req, res) => {
  console.log(req.body);

  // const signedin_user = res.locals.id;
  const currentTimestamp = getTimeStamp();

  const result = addcontactSchema(req.body);
  if (result.error) {
    return res.status(400).json({
      message: result.error.details[0].message,
    });
  }

  const { value } = result; // ✅ Extract the validated value
  const { user_id, created_by } = value;

  let connection;

  try {
    connection = await pool.getConnection();

    const [insertResult] = await connection.execute(
      `INSERT INTO notepad_contacts (user_id, created_at, created_by)
       VALUES (?, ?, ?)`,
      [user_id, currentTimestamp, created_by ]
    );

    res.json({
      message: 'Contact added successfully',
      stage_id: insertResult.insertId
    });
  } catch (err) {
    res.status(500).json({
      message: 'Database error',
      error: err.message
    });
  } finally {
    if (connection) connection.release();
  }
});






router.get('/fetch', auth.authenticateToken, async (req, res) => {
  const user_id = req.query.user_id; // coming from Angular query param
  let connection;

  if (!user_id) {
    return res.status(400).json({ message: 'user_id is required' });
  }

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT np.*, u.name 
       FROM notepad_contacts np 
       JOIN user u ON u.id = np.user_id 
       WHERE np.created_by = ?
       ORDER BY np.updated_at DESC`,
      [user_id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});



router.get('/chat_contact', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const currentUserId = req.user.id;

    connection = await pool.getConnection();

    // Fetch unique names of users who created notepads for this user
    const [rows] = await connection.execute(`
      SELECT DISTINCT u.name
      FROM notepad n
      JOIN user u ON n.created_by = u.id
      WHERE n.user_id = ?
    `, [currentUserId]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});




// router.post(
//   '/addcontact',
//   auth.authenticateToken,
//   upload.fields([
//     { name: 'image', maxCount: 1 },
//     { name: 'audio_note', maxCount: 1 }
//   ]),
//   async (req, res) => {
//     const signedInUserId = res.locals.id;
//     const currentTimestamp = getTimeStamp();

//     const {
//       description,
//       job_id,
//       nudge,
//       user_id
//     } = req.body;

//     // Log uploaded files for debugging
//     console.log('Uploaded files:', req.files);

//     // Extract uploaded filenames safely
//     const image = req.files?.image?.[0]?.filename || null;
//     const audio_note = req.files?.audio_note?.[0]?.filename || null;

//     let connection;
//     try {
//       connection = await pool.getConnection();

//       await connection.execute(
//         `INSERT INTO notepad (user_id, job_id, nudge, description, image, audio_note, created_at, created_by)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//         [user_id, job_id, nudge, description, image, audio_note, currentTimestamp, 1]
//       );
//               await connection.execute(
//           `UPDATE notepad_contacts 
//           SET updated_by = ?, updated_at = ? 
//           WHERE user_id = ?`,
//           [1, currentTimestamp, user_id]
//         );

//       res.json({ message: 'Contact added successfully' });
//     } catch (err) {
//       console.error('DB Error:', err);
//       res.status(500).json({ message: 'Database error', error: err.message });
//     } finally {
//       if (connection) connection.release();
//     }
//   }
// );


router.post(
  '/addcontact',
  auth.authenticateToken,
  upload.fields([
    { name: 'image', maxCount: 10 },       // ✅ allow multiple images now
    { name: 'audio_note', maxCount: 1 }
  ]),
  async (req, res) => {
    const signedInUserId = res.locals.id;
    const currentTimestamp = getTimeStamp();

    const {
      description,
      job_id,
      nudge,
      user_id
    } = req.body;

    // Uploaded files
    const audio_note = req.files?.audio_note?.[0]?.filename || null;
    const imageFiles = req.files?.image || [];
    console.log(imageFiles);

    let connection;
    try {
      connection = await pool.getConnection();

      // ✅ Step 1: Insert main notepad record (only first image shown if needed)
      const [insertResult] = await connection.execute(
        `INSERT INTO notepad (user_id, job_id, nudge, description, image, audio_note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user_id,
          job_id || null,
          nudge || null,
          description || null,
          imageFiles[0]?.filename || null, // ✅ store first image as main if needed
          audio_note,
          currentTimestamp,
          1
        ]
      );

      const notepad_id = insertResult.insertId;

      // ✅ Step 2: Insert all gallery images into notepad_gallery table
      if (imageFiles.length > 0) {
        const insertGalleryQuery = `
          INSERT INTO notepad_gallery (notepad_id, image, created_at)
          VALUES (?, ?, ?)
        `;
        for (const file of imageFiles) {
          await connection.execute(insertGalleryQuery, [
            notepad_id,
            file.filename,
            currentTimestamp
          ]);
        }
      }

      // ✅ Step 3: Update contact activity
      await connection.execute(
        `UPDATE notepad_contacts 
         SET updated_by = ?, updated_at = ? 
         WHERE user_id = ?`,
        [1, currentTimestamp, user_id]
      );

      res.json({ message: 'Contact added successfully', notepad_id });
    } catch (err) {
      console.error('DB Error:', err);
      res.status(500).json({ message: 'Database error', error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.get('/all/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  const user_id = req.params.id;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
      SELECT 
        n.*, 
        j.name AS job_name, j.address as 'job_address',
        GROUP_CONCAT(g.image) AS images
      FROM notepad n
      LEFT JOIN job j ON j.id = n.job_id
      LEFT JOIN notepad_gallery g ON g.notepad_id = n.id
      WHERE n.user_id = ?
      GROUP BY n.id
      ORDER BY n.created_at DESC
    `, [user_id]);

    // Optional: convert comma-separated images string to array
    const formatted = rows.map(row => ({
      ...row,
      images: row.images ? row.images.split(',') : []
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


  router.get('/view/:filename', (req, res) => {
  const fileName = req.params.filename;
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
    return res.status(400).json({ message: 'Invalid filename' });
  }

  const fullPath = path.join(__dirname, '../uploads', fileName);
  if (fs.existsSync(fullPath)) {
    res.sendFile(fullPath); // 👈 Sends the image as-is
  } else {
    res.status(404).json({ message: 'File not found' });
  }
});

router.get('/view_audio/:filename', (req, res) => {
  const fileName = req.params.filename;

  if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
    return res.status(400).json({ message: 'Invalid filename' });
  }

  const fullPath = path.join(__dirname, '../uploads', fileName);

  if (fs.existsSync(fullPath)) {
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.sendFile(fullPath);
  } else {
    res.status(404).json({ message: 'File not found' });
  }
});

router.post(
  '/update',
  upload.fields([
    { name: 'image', maxCount: 10 },
    { name: 'audio_note', maxCount: 1 }
  ]),
  async (req, res) => {
    const { job_id, nudge, notepad_id, startDate, endDate, description } = req.body;
    if (!notepad_id) {
      return res.status(400).json({ message: 'Missing notepad_id (primary key)' });
    }

    const imageFiles = req.files?.image || [];
    const audioFile = req.files?.audio_note?.[0]?.filename || null;

    let updateFields = [];
    let values = [];

    if (typeof description !== 'undefined' && description !== null) {
      updateFields.push('description = ?');
      values.push(description);
    }

    if (job_id) {
      updateFields.push('job_id = ?');
      values.push(job_id);
    }

    if (nudge) {
      updateFields.push('nudge = ?');
      values.push(nudge);
    }

    if (audioFile) {
      updateFields.push('audio_note = ?');
      values.push(audioFile);
    }

    if (startDate) {
      updateFields.push('startDate = ?');
      values.push(startDate);
    }

    if (endDate) {
      updateFields.push('endDate = ?');
      values.push(endDate);
    }

    if (updateFields.length > 0) {
      const query = `UPDATE notepad SET ${updateFields.join(', ')} WHERE id = ?`;
      values.push(notepad_id);
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.execute(query, values);
      } catch (error) {
        return res.status(500).json({ message: 'Database error', error: error.message });
      } finally {
        if (connection) connection.release();
      }
    }

    if (imageFiles.length > 0) {
      let connection;
      try {
        connection = await pool.getConnection();
        const insertGalleryQuery = `
          INSERT INTO notepad_gallery (notepad_id, image, created_at)
          VALUES (?, ?, NOW())
        `;
        for (const file of imageFiles) {
          await connection.execute(insertGalleryQuery, [notepad_id, file.filename]);
        }
      } catch (error) {
        return res.status(500).json({ message: 'Gallery insert error', error: error.message });
      } finally {
        if (connection) connection.release();
      }
    }

    res.json({ message: 'Contact updated successfully' });
  }
);


router.post('/updatestatus', auth.authenticateToken, async (req, res) => {
  console.log(req.body);
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || typeof status !== 'number') {
    return res.status(400).json({ message: 'Invalid request format' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const placeholders = ids.map(() => '?').join(',');
    const query = `UPDATE notepad SET status = ? WHERE id IN (${placeholders})`;

    await connection.execute(query, [status, ...ids]);

    res.json({ message: 'Statuses updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/addgroup', auth.authenticateToken, async (req, res) => {
  const { name, user_ids } = req.body;
  const created_by = res.locals.id;
  const currentTimestamp = getTimeStamp();
  const created_at = currentTimestamp
  

  if (!name || !Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ message: 'Group name and users are required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Insert into notepad_groups
    const [groupResult] = await connection.execute(
      `INSERT INTO notepad_groups (ngu_id, name, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [0, name, 1, created_at, 1, created_at]
    );

    const groupId = groupResult.insertId;

    // Insert user records into notepad_group_users
    for (const userId of user_ids) {
      await connection.execute(
        `INSERT INTO notepad_group_users (id, user_id, created_at, created_by)
         VALUES (?, ?, ?, ?)`,
        [groupId, userId, created_at, 1]
      );
    }

    // Update ngu_id to match id
    await connection.execute(`UPDATE notepad_groups SET ngu_id = ? WHERE id = ?`, [groupId, groupId]);

    await connection.commit();
    res.json({ message: 'Group and contacts added successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('Error adding group:', error);
    res.status(500).json({ message: 'Failed to add group' });
  } finally {
    if (connection) connection.release();
  }
});


// router.get('/get-groups-with-users', auth.authenticateToken, async (req, res) => {
//   try {
//     const [rows] = await pool.execute(`
//       SELECT 
//         ng.id AS group_id,
//         ng.name AS group_name,
//         u.id AS user_id,
//         u.name AS user_name
//       FROM notepad_groups ng
//       JOIN notepad_group_users ngu ON ngu.id = ng.ngu_id
//       JOIN user u ON u.id = ngu.user_id
//       ORDER BY ng.id, u.name
//     `);

//     const groupMap = new Map();

//     for (const row of rows) {
//       // Create group node if not already in the map
//       if (!groupMap.has(row.group_id)) {
//         groupMap.set(row.group_id, {
//           key: `group-${row.group_id}`,
//           label: row.group_name,
//           data: {
//             id: row.group_id,
//             name: row.group_name,
//             users: [] // to hold user ids and names for form prefill
//           },
//           children: []
//         });
//       }

//       // Add user node to group's children
//       groupMap.get(row.group_id).children.push({
//         key: `user-${row.user_id}`,
//         label: row.user_name,
//         icon: 'pi pi-user'
//       });

//       // Also store in data.users for edit usage
//       groupMap.get(row.group_id).data.users.push({
//         id: row.user_id,
//         name: row.user_name
//       });
//     }

//     // Return as array of tree nodes
//     res.json(Array.from(groupMap.values()));
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: 'Failed to fetch groups', error: err.message });
//   }
// });
router.get('/get-groups-with-users', auth.authenticateToken, async (req, res) => {
  const user_id = req.query.user_id;
  let connection;

  if (!user_id) {
    return res.status(400).json({ message: 'user_id is required' });
  }

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT 
        ng.id AS group_id,
        ng.name AS group_name,
        u.id AS user_id,
        u.name AS user_name
      FROM notepad_groups ng
      JOIN notepad_group_users ngu ON ngu.id = ng.ngu_id
      JOIN user u ON u.id = ngu.user_id
      where ng.created_by = ?
      ORDER BY ng.id, u.name`,
      [user_id]
    );

    // Convert raw data into group tree format
    const groupMap = new Map();

    for (const row of rows) {
      if (!groupMap.has(row.group_id)) {
        groupMap.set(row.group_id, {
          key: `group-${row.group_id}`,
          label: row.group_name,
          data: {
            id: row.group_id,
            name: row.group_name,
            users: []
          },
          children: []
        });
      }

      groupMap.get(row.group_id).children.push({
        key: `user-${row.user_id}`,
        label: row.user_name,
        icon: 'pi pi-user'
      });

      groupMap.get(row.group_id).data.users.push({
        id: row.user_id,
        name: row.user_name
      });
    }

    res.json(Array.from(groupMap.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch groups', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});



router.put('/updategroup/:id', auth.authenticateToken, async (req, res) => {

  const groupId = req.params.id;
  console.log(groupId);
  const { name, user_ids } = req.body;
  // const updated_by = res.locals.id;
   const updated_by = 1
  const updated_at = getTimeStamp();

  let connection;
  try {
    connection = await pool.getConnection();

    await connection.execute(
      `UPDATE notepad_groups SET name = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [name, updated_by, updated_at, groupId]
    );

    // Delete existing users
    await connection.execute(`DELETE FROM notepad_group_users WHERE id = ?`, [groupId]);

    // Insert updated users
    const userValues = user_ids.map(user_id => [groupId, user_id, updated_by, updated_at]);
    await connection.query(
      `INSERT INTO notepad_group_users (id, user_id, created_by, created_at) VALUES ?`,
      [userValues]
    );

    res.json({ message: 'Group updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Update failed', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/notepad/mark-removed', auth.authenticateToken, async (req, res) => {
  const { ids, user_id } = req.body;

  if (!Array.isArray(ids) || ids.length === 0 || !user_id) {
    return res.status(400).json({ message: 'Invalid request data' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const values = [...ids, user_id];

  let connection;
  try {
    connection = await pool.getConnection();

    const query = `
      UPDATE notepad
      SET remove_by = ?
      WHERE id IN (${placeholders})
    `;

    await connection.execute(query, [user_id, ...ids]);
    res.json({ message: 'Records marked as removed' });
  } catch (err) {
    console.error('Error updating notepad:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/update-group-favourite', auth.authenticateToken, async (req, res) => {
  const { group_id, add_to_favourite } = req.body;

  if (typeof group_id === 'undefined' || typeof add_to_favourite === 'undefined') {
    return res.status(400).json({ message: 'Invalid request payload' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.execute(
      `UPDATE notepad_groups SET add_to_favourite = ? WHERE id = ?`,
      [add_to_favourite, group_id]
    );
    res.json({ message: 'Group favourite status updated' });
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});
router.post('/update-single-field', auth.authenticateToken, upload.single('image'), async (req, res) => {
  const { notepad_id, job_id, nudge, image, audio } = req.body;

  if (!notepad_id) return res.status(400).json({ message: 'Missing ID' });

  const fields = [];
  const values = [];

  if (job_id !== undefined) {
    fields.push('job_id = ?');
    values.push(job_id);
  }

  if (nudge !== undefined) {
    fields.push('nudge = ?');
    values.push(nudge);
  }

  if (image !== undefined) {
    fields.push('image = ?');
    values.push(image);
  }

  if (audio !== undefined) {
    fields.push('audio_note = ?');
    values.push(audio);
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: 'No field to update' });
  }

  values.push(notepad_id);
  const query = `UPDATE notepad SET ${fields.join(', ')} WHERE id = ?`;

  try {
    await pool.execute(query, values);
    res.json({ message: 'Field updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update field' });
  }
});

router.get('/get-favourite-groups', auth.authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT id, name FROM notepad_groups
      WHERE add_to_favourite = 1
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch favourite groups' });
  }
});
router.post('/delete-image', async (req, res) => {
  const { notepad_id, filename } = req.body;

  if (!notepad_id || !filename) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    await connection.execute(
      'DELETE FROM notepad_gallery WHERE notepad_id = ? AND image = ?',
      [notepad_id, filename]
    );

    // Optional: delete file from disk
    const fs = require('fs');
    const imagePath = path.join(__dirname, '../uploads', filename);
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting image', error: error.message });
  } finally {
    if (connection) connection.release();
  }
});


module.exports = router;