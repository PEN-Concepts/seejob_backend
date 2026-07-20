/* Account cascade-delete — synthetic-data integration test (real local MySQL via
 * mysql-memory-server). NO real account is ever touched. Verifies:
 *   - preview counts are accurate;
 *   - owned rows are deleted;
 *   - employee logins are DETACHED (created_by NULL) + trial reset (created_at now),
 *     NOT deleted; placeholder (no-password) sub-users ARE deleted;
 *   - cross-user references are stripped on the deleted user's side only — the
 *     OTHER party's rows survive (delegated tasks/appts/checklists unassigned,
 *     contacts edge removed, notifications sender nulled, job_contacts, team
 *     membership/leader, client/inspector, equipment manager);
 *   - a live Authorize.Net subscription is handed to the ARB canceler;
 *   - an unrelated external account is completely untouched.
 * Run: node test/accountDelete.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_delete_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const { previewAccountDeletion, cascadeDeleteAccount } = require('../services/accountDelete');

    // ---- Schema (representative subset; the module tolerates missing tables) ----
    await conn.query(`CREATE TABLE \`user\` (id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190), role INT, category INT, created_by INT NULL, created_at DATETIME NULL, password VARCHAR(255) NULL)`);
    await conn.query(`CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), authorize_subscription_id VARCHAR(60) NULL)`);
    await conn.query(`CREATE TABLE user_payment_methods (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT)`);
    await conn.query(`CREATE TABLE user_device_tokens (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, client_id INT NULL, inspector_id INT NULL)`);
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY, created_by INT NULL, user_id INT NULL)`);
    await conn.query(`CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL, request_user1 INT NULL, request_user2 INT NULL)`);
    await conn.query(`CREATE TABLE appointments (id INT PRIMARY KEY, created_by INT NULL, user_id INT NULL)`);
    await conn.query(`CREATE TABLE check_list (id INT PRIMARY KEY, created_by INT NULL, assign_to INT NULL)`);
    await conn.query(`CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT)`);
    await conn.query(`CREATE TABLE reminders (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT)`);
    await conn.query(`CREATE TABLE notifications (id INT PRIMARY KEY AUTO_INCREMENT, receiver_id INT NULL, sender_id INT NULL)`);
    await conn.query(`CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, contact_id INT NULL, user_id INT NULL)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT NULL, user_id INT NULL)`);
    await conn.query(`CREATE TABLE teams (id INT PRIMARY KEY, created_by INT NULL, team_leader INT NULL)`);
    await conn.query(`CREATE TABLE equipments (id INT PRIMARY KEY, created_by INT NULL, managed_by INT NULL)`);

    // ---- Seed: 500 = account to delete, 600 = unrelated external owner ----
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at,password) VALUES
      (500,'Delete Me','del@x.com',14,2,NULL, NOW() - INTERVAL 200 DAY,'hash'),
      (501,'Employee Human','emp@x.com',5,1,500, NOW() - INTERVAL 400 DAY,'hash'),
      (502,'Placeholder Client','client@x.com',3,3,500, NOW() - INTERVAL 10 DAY,''),
      (503,'Real Sub','sub@x.com',12,2,500, NOW() - INTERVAL 30 DAY,'hash'),
      (600,'External Owner','ext@x.com',14,2,NULL, NOW() - INTERVAL 50 DAY,'hash'),
      (900,'Bystander','by@x.com',14,2,NULL, NOW() - INTERVAL 50 DAY,'hash')`);
    await conn.query(`INSERT INTO subscriptions (user_id,status,authorize_subscription_id) VALUES (500,'active','ARBDEL'),(600,'active','ARBKEEP')`);
    await conn.query(`INSERT INTO user_payment_methods (user_id) VALUES (500),(600)`);
    await conn.query(`INSERT INTO user_device_tokens (user_id) VALUES (500),(600)`);
    await conn.query(`INSERT INTO job (id,created_by,client_id,inspector_id) VALUES (700,500,502,NULL),(701,600,500,NULL)`);
    await conn.query(`INSERT INTO tasks (id,created_by,user_id) VALUES (800,500,500),(801,500,600),(802,600,500),(803,600,600)`);
    await conn.query(`INSERT INTO contact (request_by,request_to,request_user1,request_user2) VALUES (500,600,500,600),(600,500,600,500),(600,900,600,900)`);
    await conn.query(`INSERT INTO appointments (id,created_by,user_id) VALUES (810,500,500),(811,600,500)`);
    await conn.query(`INSERT INTO check_list (id,created_by,assign_to) VALUES (820,500,500),(821,600,500)`);
    await conn.query(`INSERT INTO spartan_goals (user_id) VALUES (500),(600)`);
    await conn.query(`INSERT INTO reminders (user_id) VALUES (500),(600)`);
    await conn.query(`INSERT INTO notifications (receiver_id,sender_id) VALUES (500,600),(600,500),(600,900)`);
    await conn.query(`INSERT INTO job_contacts (job_id,contact_id,user_id) VALUES (701,500,600),(701,600,600)`);
    await conn.query(`INSERT INTO team_user (team_id,user_id) VALUES (900,500),(902,600)`);
    await conn.query(`INSERT INTO teams (id,created_by,team_leader) VALUES (900,500,501),(901,600,500),(902,600,600)`);
    await conn.query(`INSERT INTO equipments (id,created_by,managed_by) VALUES (910,500,500),(911,600,500)`);

    // ---- Preview (dry-run counts) ----
    const preview = await previewAccountDeletion(conn, 500);
    ok(preview && preview.email === 'del@x.com', 'preview: returns the target account', JSON.stringify(preview && preview.email));
    ok(preview.counts.jobs === 1, 'preview: 1 job', String(preview.counts.jobs));
    ok(preview.counts.tasks === 2, 'preview: 2 tasks (owned)', String(preview.counts.tasks));
    ok(preview.counts.appointments === 1, 'preview: 1 appointment', String(preview.counts.appointments));
    ok(preview.counts.notepad_items === 1, 'preview: 1 notepad item', String(preview.counts.notepad_items));
    ok(preview.counts.spartan_goals === 1, 'preview: 1 spartan goal', String(preview.counts.spartan_goals));
    ok(preview.counts.contacts === 2, 'preview: 2 contact links involve the user', String(preview.counts.contacts));
    ok(preview.counts.equipment === 1, 'preview: 1 equipment', String(preview.counts.equipment));
    ok(preview.counts.payment_methods === 1, 'preview: 1 payment method', String(preview.counts.payment_methods));
    ok(preview.employees_to_detach === 1, 'preview: 1 employee to detach', String(preview.employees_to_detach));
    ok(preview.placeholder_sub_users === 1, 'preview: 1 placeholder sub-user to delete', String(preview.placeholder_sub_users));
    ok(preview.active_subscription_count === 1 && preview.active_subscription_arb_ids.includes('ARBDEL'), 'preview: 1 active subscription with its ARB id', JSON.stringify(preview.active_subscription_arb_ids));

    // ---- Cascade delete (transaction) with a fake ARB canceler ----
    const arbCanceled = [];
    await conn.beginTransaction();
    let result;
    try {
      result = await cascadeDeleteAccount(conn, 500, { cancelArb: async (arbId) => { arbCanceled.push(arbId); } });
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }

    ok(JSON.stringify(arbCanceled) === JSON.stringify(['ARBDEL']), 'ARB: the live subscription was handed to the canceler', JSON.stringify(arbCanceled));
    ok(result.employees_detached === 1, 'result: 1 employee detached', String(result.employees_detached));
    ok(result.placeholder_deleted === 1, 'result: 1 placeholder deleted', String(result.placeholder_deleted));

    const exists = async (t, id) => { const [r] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\` WHERE id = ?`, [id]); return Number(r[0].c) > 0; };
    const one = async (sql, p) => { const [r] = await conn.query(sql, p); return r[0]; };

    // Users
    ok(!(await exists('user', 500)), 'user: target account row is gone');
    ok(!(await exists('user', 502)), 'user: placeholder (no-password) sub-user is deleted');
    const emp = await one('SELECT created_by, created_at FROM `user` WHERE id = ?', [501]);
    ok(emp, 'user: employee login STILL EXISTS (detached, not deleted)');
    ok(emp && emp.created_by === null, 'user: detached employee has created_by = NULL', JSON.stringify(emp && emp.created_by));
    ok(emp && (Date.now() - new Date(emp.created_at).getTime()) < 5 * 60 * 1000, 'user: detached employee trial reset (created_at ~ now)', JSON.stringify(emp && emp.created_at));
    const sub = await one('SELECT created_by FROM `user` WHERE id = ?', [503]);
    ok(sub && sub.created_by === null, 'user: real non-employee sub-user detached (created_by NULL), not deleted', JSON.stringify(sub));
    ok(await exists('user', 600), 'user: unrelated external owner untouched');

    // Owned rows deleted
    ok(!(await exists('job', 700)), 'job: owned job deleted');
    ok((await one('SELECT COUNT(*) AS c FROM tasks WHERE created_by = 500', [])).c === 0, 'tasks: owned tasks deleted');
    ok(!(await exists('appointments', 810)), 'appointments: owned appt deleted');
    ok(!(await exists('check_list', 820)), 'check_list: owned item deleted');
    ok((await one('SELECT COUNT(*) AS c FROM spartan_goals WHERE user_id = 500', [])).c === 0, 'spartan_goals: deleted');
    ok((await one('SELECT COUNT(*) AS c FROM reminders WHERE user_id = 500', [])).c === 0, 'reminders: deleted');
    ok((await one('SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = 500', [])).c === 0, 'subscriptions: deleted');
    ok((await one('SELECT COUNT(*) AS c FROM user_payment_methods WHERE user_id = 500', [])).c === 0, 'payment methods: deleted');
    ok((await one('SELECT COUNT(*) AS c FROM equipments WHERE created_by = 500', [])).c === 0, 'equipment: owned deleted');

    // Cross-user: OTHER party's rows survive, target's side stripped
    ok(await exists('tasks', 802), 'x-task assigned to deleted user is KEPT');
    ok((await one('SELECT user_id FROM tasks WHERE id = 802', [])).user_id === null, 'x-task: deleted user stripped from assignee (user_id NULL)');
    ok((await one('SELECT user_id FROM tasks WHERE id = 803', [])).user_id === 600, 'x-task: unrelated assignment untouched');
    ok(await exists('appointments', 811) && (await one('SELECT user_id FROM appointments WHERE id = 811', [])).user_id === null, 'x-appointment kept, assignee stripped');
    ok(await exists('check_list', 821) && (await one('SELECT assign_to FROM check_list WHERE id = 821', [])).assign_to === null, 'x-checklist kept, assign_to stripped');
    ok((await one('SELECT COUNT(*) AS c FROM contact WHERE request_by=500 OR request_to=500 OR request_user1=500 OR request_user2=500', [])).c === 0, 'contact: all edges touching the user removed');
    ok((await one('SELECT COUNT(*) AS c FROM contact WHERE request_by=600 AND request_to=900', [])).c === 1, 'contact: an unrelated edge survives');
    ok(!(await exists('notifications', 1)) || (await one('SELECT COUNT(*) AS c FROM notifications WHERE receiver_id=500', [])).c === 0, "notifications: the user's own inbox deleted");
    ok((await one('SELECT COUNT(*) AS c FROM notifications WHERE receiver_id=600 AND sender_id IS NULL', [])).c === 1, 'notifications: message to another user KEPT with sender nulled');
    ok((await one('SELECT COUNT(*) AS c FROM notifications WHERE receiver_id=600 AND sender_id=900', [])).c === 1, 'notifications: unrelated message untouched');
    ok((await one('SELECT COUNT(*) AS c FROM job_contacts WHERE contact_id=500', [])).c === 0, "job_contacts: deleted user stripped from others' jobs");
    ok((await one('SELECT COUNT(*) AS c FROM job_contacts WHERE contact_id=600', [])).c === 1, 'job_contacts: another party contact untouched');
    ok((await one('SELECT COUNT(*) AS c FROM team_user WHERE user_id=500', [])).c === 0, 'team_user: membership removed');
    ok((await one('SELECT COUNT(*) AS c FROM team_user WHERE user_id=600', [])).c === 1, 'team_user: other member untouched');
    ok(!(await exists('teams', 900)), 'teams: owned team deleted');
    ok(await exists('teams', 901) && (await one('SELECT team_leader FROM teams WHERE id=901', [])).team_leader === null, "teams: other account's team kept, leader nulled");
    ok((await one('SELECT team_leader FROM teams WHERE id=902', [])).team_leader === 600, 'teams: unrelated leader untouched');
    ok(await exists('equipments', 911) && (await one('SELECT managed_by FROM equipments WHERE id=911', [])).managed_by === null, "equipment: other account's equipment kept, manager nulled");
    ok((await one('SELECT client_id FROM job WHERE id=701', [])).client_id === null, "job: deleted user stripped as another account's client");

    // External account fully intact
    ok((await one('SELECT COUNT(*) AS c FROM subscriptions WHERE user_id=600', [])).c === 1, 'external: subscription intact');
    ok((await one('SELECT COUNT(*) AS c FROM user_payment_methods WHERE user_id=600', [])).c === 1, 'external: payment method intact');
    ok((await one('SELECT COUNT(*) AS c FROM tasks WHERE created_by=600', [])).c === 2, 'external: their tasks intact');
  } catch (err) {
    ok(false, 'test threw', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
