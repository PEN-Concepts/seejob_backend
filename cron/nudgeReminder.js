// const cron = require("node-cron");
// const pool = require("../config/connection");
// const admin = require("../config/firebase-admin");


// async function sleep(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// function isTransientDbError(err) {
//   const code = err && err.code ? String(err.code) : '';
//   return code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ETIMEDOUT';
// }

// async function withDbRetry(fn, attempts = 2) {
//   let lastErr;
//   for (let i = 0; i < attempts; i++) {
//     try {
//       return await fn();
//     } catch (err) {
//       lastErr = err;
//       if (!isTransientDbError(err) || i === attempts - 1) throw err;
//       await sleep(300 * (i + 1));
//     }
//   }
//   throw lastErr;
// }


// cron.schedule('*/10 * * * *', async () => {
//   console.log("⏰ Running Nudge Cron");

//   let connection;
//   try {
//     connection = await withDbRetry(() => pool.getConnection());

//     const [tasks] = await withDbRetry(() =>
//       connection.query(`
//         SELECT id, user_id, description, nudge
//         FROM tasks
//         WHERE nudge IS NOT NULL
//           AND nudge_sent = 0
//           AND DATE_FORMAT(nudge, '%Y-%m-%d %H:%i') = DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i')
//       `)
//     );

//     if (tasks.length === 0) {
//       console.log("No pending nudges.");
//       return;
//     }

//     console.log("🔥 Nudges to send:", tasks.length);

//     for (let task of tasks) {
//       console.log(`Sending notification to user ${task.user_id} for task ${task.id}`);

//       try {
//         const assignedUser = task.user_id;
//         const url = '/task';
//         const notifyMessage = `Reminder: ${task.description}`;

//         // Insert notification record (system/cron sender → null)
//         await withDbRetry(() => connection.query(
//           `INSERT INTO notifications (sender_id, receiver_id, content, status, url, created_by)
//            VALUES (?, ?, ?, 1, ?, ?)`,
//           [null, assignedUser, notifyMessage, url, null]
//         ));

//         // Send FCM notification if token exists
//         const [[recipient]] = await withDbRetry(() =>
//           connection.query(
//             'SELECT fcm_token FROM user_device_tokens WHERE user_id=?',
//             [assignedUser]
//           )
//         );

//         if (recipient && recipient.fcm_token) {
//           const message = {
//             token: recipient.fcm_token,
//             notification: { title: 'Task Nudge', body: notifyMessage },
//             data: { type: 'task_nudge', task_id: String(task.id), url },
//           };
//           try {
//             await admin.messaging().send(message);
//           } catch (err) {
//             console.error('FCM Error (cron nudge):', err);
//           }
//         }
//       } catch (innerErr) {
//         console.error('Error processing nudge for task', task.id, innerErr);
//       }

//       // Mark sent
//       await withDbRetry(() =>
//         connection.query(
//           `UPDATE tasks SET nudge_sent = 1 WHERE id = ?`,
//           [task.id]
//         )
//       );
//     }

//   } catch (err) {
//     console.error("Cron error:", err);
//   } finally {
//     if (connection) connection.release();
//   }
// });