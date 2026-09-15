/* NO DATE MEANS NO DATE.
 *
 * Two write paths used to fall back to new Date() when the user gave no date:
 *
 *   routes/checklists.js   — every task-type notepad line added without a date
 *                            was stamped with the moment it was typed
 *   routes/notepadDelegate — delegating without a date scheduled the task for
 *                            the moment you pressed the button
 *
 * Neither was a display default. Both wrote to the database, which is why the
 * values survived a refresh, drove the "late" calculation and re-sorted the
 * list around dates nobody had entered.
 *
 * Every assertion here reads the STORED ROW. The response cannot distinguish a
 * stored null from a stored timestamp, and the stored value is the whole point.
 *
 * Run: node test/noAutoDateStamp.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_nodate_test', logLevel: 'ERROR' });
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
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, complete_percentage INT NULL, priority VARCHAR(10) NULL,
      due_date DATETIME NULL, status VARCHAR(20) NULL, created_by INT NULL, type VARCHAR(20) NULL,
      is_calendar TINYINT DEFAULT 0, is_appointment TINYINT DEFAULT 0,
      calendar_task_id INT NULL, appointment_id INT NULL, assignee_completed TINYINT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, task_name VARCHAR(190), user_id INT NULL, team_id INT NULL, duration_days INT NULL, start_date DATETIME NULL, end_date DATETIME NULL, description TEXT NULL, assignee_completed TINYINT DEFAULT 0, job_id INT NULL, created_at DATETIME NULL, created_by INT NULL, task_type VARCHAR(20) NULL, is_calendar_task TINYINT DEFAULT 0, is_appointment_task TINYINT DEFAULT 0, priority VARCHAR(10) NULL, is_urgent TINYINT DEFAULT 0, starred_at DATETIME NULL, image VARCHAR(255) NULL, status INT DEFAULT 0)");
    await conn.query("CREATE TABLE task_assignees (task_id INT, user_id INT, PRIMARY KEY (task_id, user_id))");
    await conn.query("CREATE TABLE task_notes (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), created_at DATETIME NULL)");

    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul','poul@example.invalid',14,4,NULL,NOW()),
      (710,'Josh','josh@example.invalid',2,1,700,NOW())`);
    await conn.query("INSERT INTO `job` (id,name,created_by,color,created_at) VALUES (10,'Sample Deck',700,'#888',NOW())");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,scope,origin,account_owner_id) VALUES (1,700,'task','Sample Deck',10,'company','auto',700)");

    // A line that ALREADY has a date, to prove the fix does not touch it.
    await conn.query("INSERT INTO check_list (id,section_id,name,due_date,status,created_by,type) VALUES (999,1,'Dry in Deck','2026-09-15 09:33:00','new',700,'task')");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/checklists'));
    app.use('/api/notepad', require('../routes/notepadDelegate'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@example.invalid' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const dueOf = async (id) => {
      const [[r]] = await conn.query('SELECT due_date FROM check_list WHERE id = ?', [id]);
      return r ? r.due_date : undefined;
    };

    // ── 1. Create WITHOUT a date -> stored null ────────────────────────
    const noDate = await request(app).post('/api/checklists/create')
      .set('Authorization', tok(700, 14, 4))
      .send({ section_id: 1, name: 'No date at all', type: 'task' });
    note('create (no date) responded ' + noDate.status);
    const createdId = noDate.body && noDate.body.data && noDate.body.data.id;
    ok(!!createdId, 'the item was created', JSON.stringify(noDate.body).slice(0, 160));

    const storedNull = await dueOf(createdId);
    ok(storedNull === null,
      'a task created with NO date stores NULL — not now, not today, not epoch',
      JSON.stringify(storedNull));

    // ── 2. Create WITH a date -> that date, unchanged ──────────────────
    const withDate = await request(app).post('/api/checklists/create')
      .set('Authorization', tok(700, 14, 4))
      .send({ section_id: 1, name: 'Has a date', type: 'task', due_date: '2026-10-03 14:00:00' });
    const datedId = withDate.body && withDate.body.data && withDate.body.data.id;
    const storedDate = await dueOf(datedId);
    ok(storedDate !== null && String(storedDate).includes('2026-10-03'),
      'a task created WITH a date stores that date', JSON.stringify(storedDate));

    // ── 3. A date-only pick (no time) ──────────────────────────────────
    const dateOnly = await request(app).post('/api/checklists/create')
      .set('Authorization', tok(700, 14, 4))
      .send({ section_id: 1, name: 'Date only', type: 'task', due_date: '2026-10-03' });
    const dateOnlyId = dateOnly.body && dateOnly.body.data && dateOnly.body.data.id;
    const storedDateOnly = await dueOf(dateOnlyId);
    note('date with no time is stored as: ' + JSON.stringify(storedDateOnly) +
         '  (DATETIME column — midnight, so "3 Oct" and "3 Oct 00:00" are the SAME stored value)');
    // CHARACTERISATION, NOT APPROVAL. This pins the CURRENT behaviour so the
    // defect is visible and cannot change unnoticed. A bare 'YYYY-MM-DD' is
    // parsed as UTC midnight and then converted to local time, so in any
    // negative-offset zone it lands on the PREVIOUS DAY. Picking 3 Oct stores
    // 2 Oct 17:00 in Pacific. That is wrong and is reported, not fixed here:
    // due_date is a DATETIME and genuinely cannot distinguish '3 Oct, no time'
    // from '3 Oct at midnight', which makes it a data-model question rather
    // than a parsing one. When it IS fixed, this assertion should start
    // failing — that is the point of it.
    ok(storedDateOnly !== null,
      'a date with no time is stored (as something) rather than dropped',
      JSON.stringify(storedDateOnly));
    ok(String(storedDateOnly).startsWith('2026-10-02'),
      'KNOWN DEFECT pinned: a bare date shifts back a day in a negative-offset zone',
      JSON.stringify(storedDateOnly));

    // ── 4. The pre-existing date is untouched ──────────────────────────
    const dryIn = await dueOf(999);
    ok(dryIn !== null && String(dryIn).includes('2026-09-15 09:33'),
      'Dry in Deck keeps the date Poul entered — the fix takes nothing away',
      JSON.stringify(dryIn));

    // ── 5. Reading the pad repeatedly writes nothing ───────────────────
    const [[before]] = await conn.query('SELECT COUNT(*) AS n FROM check_list WHERE due_date IS NOT NULL');
    for (let i = 0; i < 5; i++) {
      await request(app).get('/api/checklists/items').set('Authorization', tok(700, 14, 4));
    }
    const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM check_list WHERE due_date IS NOT NULL');
    ok(Number(before.n) === Number(after.n),
      'reading the notepad FIVE times adds no date to anything',
      JSON.stringify({ before: before.n, after: after.n }));
    ok((await dueOf(createdId)) === null,
      'and the undated task is still undated after those reads', JSON.stringify(await dueOf(createdId)));

    // ── 6. Delegate without a date -> null start/end ───────────────────
    const del = await request(app).post(`/api/notepad/items/${createdId}/delegate`)
      .set('Authorization', tok(700, 14, 4))
      .send({ job_id: 10, assignee_id: 710 });
    note('delegate (no date) responded ' + del.status);
    const [[t1]] = await conn.query('SELECT start_date, end_date FROM tasks ORDER BY id DESC LIMIT 1');
    ok(t1 && t1.start_date === null && t1.end_date === null,
      'delegating with NO date stores NULL start_date and end_date',
      JSON.stringify(t1));

    // ── 7. Delegate WITH a date -> that date ───────────────────────────
    const del2 = await request(app).post(`/api/notepad/items/${datedId}/delegate`)
      .set('Authorization', tok(700, 14, 4))
      .send({ job_id: 10, assignee_id: 710, due_date: '2026-11-20 08:00:00' });
    note('delegate (with date) responded ' + del2.status);
    const [[t2]] = await conn.query('SELECT start_date FROM tasks ORDER BY id DESC LIMIT 1');
    ok(t2 && t2.start_date !== null && String(t2.start_date).includes('2026-11-20'),
      'delegating WITH a date stores that date', JSON.stringify(t2));

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
