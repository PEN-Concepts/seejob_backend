/* The widened STALLED activity definition, and account-wide missed/kept.
 *
 * Covers the 15 Sep follow-up checklist items 1-7.
 *
 * Each of the four added activity types is tested INDEPENDENTLY: a job that
 * is 40 days stale by every other measure is brought back to life by one
 * chat message, one file, one budget edit, one appointment — each on its own
 * job, so a single working source cannot mask three broken ones.
 *
 * Run: node test/dashboardActivityReview.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_activity_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), created_at DATETIME NULL)");
    // The four added sources, shaped as the app writes them.
    await conn.query("CREATE TABLE chat_conversations (id INT PRIMARY KEY AUTO_INCREMENT, type VARCHAR(20), job_id INT NULL, owner_id INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE chat_messages (id INT PRIMARY KEY AUTO_INCREMENT, conversation_id INT, sender_id INT NULL, body TEXT, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(255), job_id INT, mime_type VARCHAR(100) NULL, created_by INT NULL, created_at DATETIME NULL, type VARCHAR(40) NULL)");
    await conn.query("CREATE TABLE division_lineitems (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(20) NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, subject VARCHAR(190) NULL, doa DATETIME NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, updated_at DATETIME NULL)");

    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul','poul@x.com',14,4,NULL,NOW()),
      (710,'Josh','josh@x.com',2,1,700,NOW()),
      (720,'Eve','eve@x.com',2,1,700,NOW())`);

    // Six jobs, ALL 40 days stale by creation. Each gets exactly one kind of
    // recent human activity (or none) so the sources cannot mask each other.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,color,created_at) VALUES
      (20,'Chat Job',700,'#111',   NOW() - INTERVAL 40 DAY),
      (21,'File Job',700,'#222',   NOW() - INTERVAL 40 DAY),
      (22,'Budget Job',700,'#333', NOW() - INTERVAL 40 DAY),
      (23,'Appt Job',700,'#444',   NOW() - INTERVAL 40 DAY),
      (24,'Viewed Job',700,'#555', NOW() - INTERVAL 40 DAY),
      (25,'Robot Job',700,'#666',  NOW() - INTERVAL 40 DAY)`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const stalledNames = async (who) => {
      const r = await request(app).get('/api/dashboard/stalled')
        .set('Authorization', tok(who, who === 700 ? 14 : 2, who === 700 ? 4 : 1));
      return ((r.body && r.body.stalled) || []).map((s) => s.name).sort();
    };

    // Baseline: with no activity at all, every one of them is stalled.
    let list = await stalledNames(700);
    const allSix = ['Appt Job', 'Budget Job', 'Chat Job', 'File Job', 'Robot Job', 'Viewed Job'];
    ok(allSix.every((n) => list.includes(n)),
      'baseline: all six 40-day-old jobs are STALLED before any activity',
      JSON.stringify(list));

    // ── 3 (part). Every source actually READ. ───────────────────────────
    // A probe that cannot read its table fails open and contributes nothing,
    // which looks exactly like "no activity of that kind". Assert the full set
    // resolved, or the four tests below would pass for the wrong reason.
    const { activitySources, EXPECTED_JOB_SOURCES } = require('../services/dashboardStalled');
    const got = activitySources();
    const missing = EXPECTED_JOB_SOURCES.filter((s) => !got.includes(s));
    ok(missing.length === 0,
      'every activity source resolved against the schema — none silently failed open',
      'missing: ' + JSON.stringify(missing) + ' got: ' + JSON.stringify(got));
    note('activity sources read: ' + got.join(', '));

    // ── 1. Each added type resets the clock, INDEPENDENTLY ──────────────
    await conn.query("INSERT INTO chat_conversations (id,type,job_id,owner_id,created_by,created_at) VALUES (900,'job',20,700,700,NOW() - INTERVAL 40 DAY)");
    await conn.query("INSERT INTO chat_messages (conversation_id,sender_id,body,created_at) VALUES (900,710,'what is happening here', NOW() - INTERVAL 2 DAY)");
    list = await stalledNames(700);
    ok(!list.includes('Chat Job'), 'a CHAT MESSAGE 2 days ago clears STALLED', JSON.stringify(list));

    await conn.query("INSERT INTO job_documents (path,name,job_id,created_by,created_at) VALUES ('/x','plan.pdf',21,710, NOW() - INTERVAL 2 DAY)");
    list = await stalledNames(700);
    ok(!list.includes('File Job'), 'a FILE UPLOAD 2 days ago clears STALLED', JSON.stringify(list));

    await conn.query("INSERT INTO division_lineitems (job_id,owner_type,updated_at) VALUES (22,'job', NOW() - INTERVAL 2 DAY)");
    list = await stalledNames(700);
    ok(!list.includes('Budget Job'), 'a BUDGET EDIT 2 days ago clears STALLED', JSON.stringify(list));

    await conn.query("INSERT INTO appointments (job_id,user_id,subject,doa,created_by,created_at) VALUES (23,700,'Walk it', NOW(), 700, NOW() - INTERVAL 2 DAY)");
    list = await stalledNames(700);
    ok(!list.includes('Appt Job'), 'an APPOINTMENT 2 days ago clears STALLED', JSON.stringify(list));

    // ── 2. Viewing does NOT reset it ────────────────────────────────────
    // There is no read-tracking table feeding the definition, which is the
    // point: a view has nowhere to be recorded as activity. Job 24 has been
    // "viewed" (i.e. nothing was written) and is still stalled.
    ok(list.includes('Viewed Job'),
      'VIEWING a job does not clear STALLED — a glance is not progress',
      JSON.stringify(list));

    // ── 3. Automatic writes do NOT reset it ─────────────────────────────
    // Same tables, same recency, but no human actor. Each source requires its
    // actor column to be non-null, so a scheduled job / sync / recalculation
    // cannot mark a neglected job active.
    await conn.query("INSERT INTO chat_conversations (id,type,job_id,owner_id,created_by,created_at) VALUES (901,'job',25,700,700,NOW() - INTERVAL 40 DAY)");
    await conn.query("INSERT INTO chat_messages (conversation_id,sender_id,body,created_at) VALUES (901,NULL,'automated digest', NOW())");
    await conn.query("INSERT INTO job_documents (path,name,job_id,created_by,created_at) VALUES ('/y','auto-report.pdf',25,NULL, NOW())");
    await conn.query("INSERT INTO tasks (job_id,user_id,created_by,task_type,task_name,created_at) VALUES (25,710,NULL,'job','auto-generated', NOW())");
    await conn.query("INSERT INTO appointments (job_id,user_id,subject,doa,created_by,created_at) VALUES (25,700,'synced from Google', NOW(), NULL, NOW())");
    list = await stalledNames(700);
    ok(list.includes('Robot Job'),
      'rows written with NO human actor (chat, file, task, appointment) do NOT clear STALLED',
      JSON.stringify(list));
    note('checked for actorless writes: chat_messages.sender_id, job_documents.created_by, ' +
         'tasks.created_by, appointments.created_by — each required non-null');

    // ── 6. ONE ROW PER ITEM — from the SCHEMA, not from behaviour ───────
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dashboard_item_review'`);
    const colNames = cols.map((c) => c.COLUMN_NAME);
    ok(!colNames.includes('user_id'),
      'dashboard_item_review has NO user_id column — it cannot be keyed per user',
      JSON.stringify(colNames));
    ok(colNames.includes('account_owner_id'), 'it is keyed on account_owner_id', JSON.stringify(colNames));

    const [idx] = await conn.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dashboard_item_review'
        GROUP BY INDEX_NAME, NON_UNIQUE`);
    const uniq = idx.filter((i) => Number(i.NON_UNIQUE) === 0 && i.INDEX_NAME !== 'PRIMARY');
    ok(uniq.some((i) => i.cols === 'account_owner_id,item_type,item_id,occurs_on'),
      'the UNIQUE key is (account, item_type, item_id, day) — one row per item per day, not one per user',
      JSON.stringify(uniq.map((i) => i.cols)));

    // ── 4. One user marks missed, another SEES it ───────────────────────
    const day = ymd(new Date(Date.now() - 86400000));
    const mark = await request(app).post('/api/dashboard/item-review')
      .set('Authorization', tok(710, 2, 1))
      .send({ item_type: 'appointment', item_id: 5150, occurs_on: day, state: 'missed' });
    ok(mark.status === 200, 'user 710 marks an item missed', String(mark.status) + ' ' + JSON.stringify(mark.body).slice(0, 120));

    const [stored] = await conn.query(
      `SELECT account_owner_id, item_type, item_id, state, set_by_user_id
         FROM dashboard_item_review WHERE item_id = 5150`);
    ok(stored.length === 1, 'exactly ONE review row exists, not one per user', JSON.stringify(stored));
    ok(stored[0] && Number(stored[0].account_owner_id) === 700,
      'the stored row is keyed to the ACCOUNT (700), not the person who set it',
      JSON.stringify(stored[0]));
    ok(stored[0] && Number(stored[0].set_by_user_id) === 710,
      'who set it is recorded, but is not part of the key', JSON.stringify(stored[0]));

    const seenByOther = await request(app).get('/api/dashboard/item-review?on=' + day)
      .set('Authorization', tok(720, 2, 1));
    const other = ((seenByOther.body && seenByOther.body.reviews) || []).find((r) => Number(r.item_id) === 5150);
    ok(other && other.state === 'missed',
      'a SECOND user on the same account sees it as missed',
      JSON.stringify(seenByOther.body));

    // ── 5. The second user switches it to KEPT; the first sees kept ─────
    const flip = await request(app).post('/api/dashboard/item-review')
      .set('Authorization', tok(720, 2, 1))
      .send({ item_type: 'appointment', item_id: 5150, occurs_on: day, state: 'kept' });
    ok(flip.status === 200, 'user 720 switches it to kept', String(flip.status));

    const [afterFlip] = await conn.query(
      "SELECT state, set_by_user_id FROM dashboard_item_review WHERE item_id = 5150");
    ok(afterFlip.length === 1 && afterFlip[0].state === 'kept',
      'the STORED row is now kept — still exactly one row',
      JSON.stringify(afterFlip));
    ok(Number(afterFlip[0].set_by_user_id) === 720, 'and records who changed it', JSON.stringify(afterFlip));

    const backToFirst = await request(app).get('/api/dashboard/item-review?on=' + day)
      .set('Authorization', tok(710, 2, 1));
    const first = ((backToFirst.body && backToFirst.body.reviews) || []).find((r) => Number(r.item_id) === 5150);
    ok(first && first.state === 'kept',
      'the FIRST user now sees kept — one shared answer, no contradiction',
      JSON.stringify(backToFirst.body));

    // Grey is the absence of a row: an unreviewed item has nothing stored.
    const [none] = await conn.query("SELECT COUNT(*) AS n FROM dashboard_item_review WHERE item_id = 9999");
    ok(Number(none[0].n) === 0,
      'an unreviewed item has NO row — grey is absence, so it cannot age into red',
      JSON.stringify(none[0]));

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
