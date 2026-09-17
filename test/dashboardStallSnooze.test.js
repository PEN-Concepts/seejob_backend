/* STALLED detection and the per-user snooze.
 *
 * Covers the Dashboard CCP checklist items 13, 14, 16, 17, 18 and 19.
 *
 * Every assertion about the snooze reads the STORED ROW. The response echoes
 * what it was handed, so it cannot tell a write that happened from one that
 * did not, and the whole point of these rules is what is on disk.
 *
 * Run: node test/dashboardStallSnooze.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_stall_test', logLevel: 'ERROR' });
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

    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    // 700 boss. 710 and 720 are two employees on the same account.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul','poul@x.com',14,4,NULL,NOW()),
      (710,'Josh','josh@x.com',2,1,700,NOW()),
      (720,'Eve','eve@x.com',2,1,700,NOW())`);

    // Jobs whose ONLY activity is their own creation, at controlled ages.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,color,created_at) VALUES
      (10,'Nine Day Job',700,'#888', NOW() - INTERVAL 9 DAY),
      (11,'Ten Day Job',700,'#999',  NOW() - INTERVAL 10 DAY),
      (12,'Fresh Job',700,'#aaa',    NOW() - INTERVAL 1 DAY),
      (13,'Old But Active',700,'#bbb', NOW() - INTERVAL 40 DAY)`);
    // Job 13 is old but had a task two days ago — activity, so NOT stalled.
    await conn.query("INSERT INTO tasks (job_id,user_id,created_by,task_type,task_name,created_at) VALUES (13,710,700,'job','Recent work', NOW() - INTERVAL 2 DAY)");

    await conn.query(`INSERT INTO leads (id,lead_name,user_id,created_at) VALUES
      (50,'Nine Day Lead',700, NOW() - INTERVAL 9 DAY),
      (51,'Ten Day Lead',700,  NOW() - INTERVAL 10 DAY)`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const stalledFor = async (who) => {
      const r = await request(app).get('/api/dashboard/stalled').set('Authorization', tok(who, who === 700 ? 14 : 2, who === 700 ? 4 : 1));
      return r.body && r.body.stalled ? r.body.stalled : [];
    };
    const names = (list) => list.map((s) => s.name).sort();

    // ── 13. The job boundary, BOTH sides ────────────────────────────────
    let list = await stalledFor(700);
    note('threshold shipped at ' + require('../services/dashboardSchema').stallDays() + ' days');
    ok(!names(list).includes('Nine Day Job'),
      'a job last touched 9 days ago is NOT stalled', JSON.stringify(names(list)));
    ok(names(list).includes('Ten Day Job'),
      'a job last touched 10 days ago IS stalled', JSON.stringify(names(list)));
    ok(!names(list).includes('Fresh Job'), 'a job touched yesterday is not stalled', JSON.stringify(names(list)));
    ok(!names(list).includes('Old But Active'),
      'a 40-day-old job with a task 2 days ago is NOT stalled — activity is not just creation',
      JSON.stringify(names(list)));

    // ── 14. The same boundary for a LEAD ────────────────────────────────
    ok(!names(list).includes('Nine Day Lead'), 'a lead idle 9 days is NOT stalled', JSON.stringify(names(list)));
    ok(names(list).includes('Ten Day Lead'), 'a lead idle 10 days IS stalled', JSON.stringify(names(list)));

    // ── 16. Past days are unselectable — enforced on the SERVER ─────────
    const past = await request(app).post('/api/dashboard/stall-snooze')
      .set('Authorization', tok(700, 14, 4))
      .send({ target_type: 'job', target_id: 11, check_back_on: ymd(daysFromNow(-1)) });
    ok(past.status === 400, 'a PAST date is refused (400), not merely greyed in the UI', String(past.status));
    const [pastRows] = await conn.query('SELECT COUNT(*) AS n FROM dashboard_stall_snooze');
    ok(Number(pastRows[0].n) === 0, 'the refused past date wrote NO row', JSON.stringify(pastRows[0]));

    // ── 19b. There is no way to construct an indefinite snooze ──────────
    const indefinite = [
      { label: 'null', v: null },
      { label: 'empty string', v: '' },
      { label: 'the word never', v: 'never' },
      { label: 'year 9999 sentinel as non-date', v: 'forever' },
      { label: 'a date that does not exist', v: '2026-02-31' },
    ];
    let refused = 0;
    for (const c of indefinite) {
      const r = await request(app).post('/api/dashboard/stall-snooze')
        .set('Authorization', tok(700, 14, 4))
        .send({ target_type: 'job', target_id: 11, check_back_on: c.v });
      if (r.status === 400) refused++; else note('NOT refused: ' + c.label + ' -> ' + r.status);
    }
    ok(refused === indefinite.length,
      'every attempt at an indefinite snooze is refused (' + refused + '/' + indefinite.length + ')',
      String(refused));
    const [[stillNone]] = await conn.query('SELECT COUNT(*) AS n FROM dashboard_stall_snooze');
    ok(Number(stillNone.n) === 0, 'none of them wrote a row either', JSON.stringify(stillNone));

    // ── 17. Pick a date — ASSERT THE STORED ROW ─────────────────────────
    const chosen = ymd(daysFromNow(7));
    const good = await request(app).post('/api/dashboard/stall-snooze')
      .set('Authorization', tok(700, 14, 4))
      .send({ target_type: 'job', target_id: 11, check_back_on: chosen });
    ok(good.status === 200, 'a future date is accepted', String(good.status) + ' ' + JSON.stringify(good.body).slice(0, 120));

    const [stored] = await conn.query(
      `SELECT user_id, target_type, target_id, DATE_FORMAT(check_back_on,'%Y-%m-%d') AS d
         FROM dashboard_stall_snooze`);
    ok(stored.length === 1, 'exactly one snooze row exists', JSON.stringify(stored));
    ok(stored[0] && Number(stored[0].user_id) === 700, 'the stored row is scoped to THAT user', JSON.stringify(stored[0]));
    ok(stored[0] && stored[0].target_type === 'job' && Number(stored[0].target_id) === 11,
      'the stored row names that job and no other', JSON.stringify(stored[0]));
    ok(stored[0] && stored[0].d === chosen,
      'the stored row carries the date chosen', (stored[0] && stored[0].d) + ' vs ' + chosen);

    // ── 18. Absent while snoozed, back when the date arrives ────────────
    list = await stalledFor(700);
    ok(!names(list).includes('Ten Day Job'), 'the snoozed job is absent from STALLED', JSON.stringify(names(list)));
    ok(names(list).includes('Ten Day Lead'), 'the OTHER stalled item is untouched', JSON.stringify(names(list)));

    // Move the check-back date to today, which is what the clock passing it
    // looks like from the query's side.
    await conn.query("UPDATE dashboard_stall_snooze SET check_back_on = ? WHERE user_id = 700 AND target_id = 11", [ymd(daysFromNow(0))]);
    list = await stalledFor(700);
    ok(names(list).includes('Ten Day Job'),
      'once the check-back date arrives the job RETURNS, with no cleanup needed',
      JSON.stringify(names(list)));

    // ── 19. Per USER, not per account ───────────────────────────────────
    await conn.query("UPDATE dashboard_stall_snooze SET check_back_on = ? WHERE user_id = 700 AND target_id = 11", [ymd(daysFromNow(7))]);
    const mine = await stalledFor(700);
    const theirs = await stalledFor(720);
    ok(!names(mine).includes('Ten Day Job'), 'user 700 has it snoozed', JSON.stringify(names(mine)));
    ok(names(theirs).includes('Ten Day Job'),
      'user 720 on the SAME account still sees it — the snooze is per user',
      JSON.stringify(names(theirs)));

    // Picking a new date replaces rather than stacks.
    await request(app).post('/api/dashboard/stall-snooze')
      .set('Authorization', tok(700, 14, 4))
      .send({ target_type: 'job', target_id: 11, check_back_on: ymd(daysFromNow(3)) });
    const [afterReplace] = await conn.query(
      "SELECT DATE_FORMAT(check_back_on,'%Y-%m-%d') AS d FROM dashboard_stall_snooze WHERE user_id=700 AND target_id=11");
    ok(afterReplace.length === 1 && afterReplace[0].d === ymd(daysFromNow(3)),
      'picking a new date REPLACES the old one — one answer to when it returns',
      JSON.stringify(afterReplace));

    // The column itself forbids an indefinite snooze.
    const [[col]] = await conn.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='dashboard_stall_snooze' AND COLUMN_NAME='check_back_on'`);
    ok(col && col.IS_NULLABLE === 'NO',
      'check_back_on is NOT NULL — "hide forever" has nowhere to be written',
      JSON.stringify(col));

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
