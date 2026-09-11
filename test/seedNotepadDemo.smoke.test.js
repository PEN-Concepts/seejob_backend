/* Smoke test for scripts/seedNotepadDemo.js — proves the CCP verification seed
 * actually RUNS and produces every state the checklist asks for, against a real
 * throwaway MySQL (mysql-memory-server). Nothing here touches production.
 *
 * The checklist item is: "Seed data covers every state: delegated,
 * checked-by-assignee, starred, note-only, photo-only, both, completed, lead,
 * shared, client-shared, full-access user, off-list user."
 *
 * Run: node test/seedNotepadDemo.smoke.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_seed_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    process.env.NODE_ENV = 'development';
    process.env.SEED_NOTEPAD_DEMO = '1';

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // Minimal legacy schema the seed writes into (the migration adds the rest).
    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL,
      subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE subcategory (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), category_id INT)');
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, shared_with_user_id INT NULL,
      type VARCHAR(20), title VARCHAR(255), sort_order INT DEFAULT 0, job_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), created_by INT NULL,
      status VARCHAR(20) DEFAULT 'new', priority VARCHAR(10) DEFAULT 'low', type VARCHAR(20) DEFAULT 'task',
      due_date DATETIME NULL, assignee_completed TINYINT DEFAULT 0)`);
    await conn.query(`CREATE TABLE \`job\` (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150),
      status INT DEFAULT 1, color VARCHAR(30) NULL, job_address VARCHAR(255) NULL, job_city VARCHAR(120) NULL,
      job_state VARCHAR(60) NULL, job_zipcode VARCHAR(20) NULL)`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL, lead_name VARCHAR(150),
      project_street_address VARCHAR(255) NULL)`);
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, task_name VARCHAR(255), user_id INT NULL,
      duration_days INT NULL, start_date DATETIME NULL, end_date DATETIME NULL, job_id INT NULL,
      created_at DATETIME NULL, created_by INT NULL, task_type VARCHAR(20) NULL,
      is_calendar_task TINYINT DEFAULT 0, is_appointment_task TINYINT DEFAULT 0,
      priority VARCHAR(10) NULL, status TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0)`);
    await conn.query('CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, UNIQUE KEY u (task_id,user_id))');
    await conn.query(`CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT,
      file_path VARCHAR(255), file_name VARCHAR(255), kind VARCHAR(10) NULL, uploaded_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("INSERT INTO subcategory (id,name,category_id) VALUES (9,'Family/Friend',1)");
    conn.release();
    conn = null;

    // Run the script exactly as an operator would.
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['scripts/seedNotepadDemo.js'], {
      cwd: require('path').join(__dirname, '..'),
      env: process.env,
      encoding: 'utf8',
    });
    ok(/seeded\./.test(out), 'seed script runs to completion', out.slice(-300));

    // Re-open a connection (the script closed its own pool).
    const mysql = require('mysql2/promise');
    const c2 = await mysql.createConnection({
      host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName,
    });
    const one = async (sql, p = []) => (await c2.query(sql, p))[0];

    const users = await one("SELECT id, category FROM `user` WHERE name LIKE '%[ccp-demo]%'");
    ok(users.length === 5, 'people: owner + full-access + off-list + client + subcontractor', String(users.length));
    const access = await one('SELECT user_id FROM notepad_access');
    ok(access.length === 1 && Number(access[0].user_id) === 990002, 'one FULL-ACCESS user on the allowlist; the other employee is OFF-list');

    const pads = await one('SELECT id, origin, scope, job_id, lead_id, owner_user_id FROM checklist_sections');
    ok(pads.some((p) => p.origin === 'auto' && p.scope === 'company' && p.job_id), 'a company JOB notepad (gold border)');
    ok(pads.some((p) => p.origin === 'auto' && p.scope === 'company' && p.lead_id), 'a company LEAD notepad (blue border)');
    ok(pads.some((p) => p.origin === 'manual'), 'a hand-made notepad (the only shareable kind)');
    ok(pads.some((p) => p.scope === 'private' && Number(p.owner_user_id) === 990003), "the off-list employee's PRIVATE job pad");

    const rows = await one('SELECT name, status, priority, created_by, delegated_task_id, delegated_to FROM check_list');
    ok(rows.some((r) => !r.delegated_task_id && r.status !== 'completed'), 'notepad row: NOT delegated');
    ok(rows.some((r) => r.name.startsWith('DELEGATED')), 'notepad row: delegated');
    ok(rows.some((r) => r.name.startsWith('ASSIGNEE CHECKED OFF')), 'notepad row: assignee has checked off');
    ok(rows.some((r) => r.priority === 'high'), 'notepad row: starred');
    ok(rows.some((r) => r.status === 'completed'), 'notepad row: completed');
    ok(rows.some((r) => Number(r.created_by) === 990002), 'notepad row added by someone else (author byline)');

    const delegated = rows.filter((r) => r.delegated_task_id);
    ok(delegated.length === 2, 'both delegated rows are linked to a real task', String(delegated.length));
    const [[doneTask]] = await c2.query(
      'SELECT assignee_completed, status FROM tasks WHERE id = (SELECT delegated_task_id FROM check_list WHERE name LIKE ? LIMIT 1)',
      ['ASSIGNEE CHECKED OFF%'],
    );
    ok(Number(doneTask.assignee_completed) === 1 && Number(doneTask.status) === 0,
      "the assignee's check-off is set WITHOUT the boss's status — two independent signals");

    const tasks = await one('SELECT task_name, starred_at, status, created_by, user_id FROM tasks');
    ok(tasks.some((t) => t.starred_at), 'My Tasks: a starred task');
    ok(tasks.some((t) => Number(t.status) === 1), 'My Tasks: a completed task');
    ok(tasks.some((t) => Number(t.created_by) === Number(t.user_id)), 'My Tasks: a self-assigned task');

    const notes = await one('SELECT task_id FROM task_notes');
    const imgs = await one('SELECT task_id FROM tasks_images');
    const noteIds = new Set(notes.map((n) => Number(n.task_id)));
    const imgIds = new Set(imgs.map((i) => Number(i.task_id)));
    ok([...noteIds].some((id) => !imgIds.has(id)), 'indicator state: NOTE ONLY (paperclip)');
    ok([...imgIds].some((id) => !noteIds.has(id)), 'indicator state: PHOTO ONLY (camera)');
    ok([...noteIds].some((id) => imgIds.has(id)), 'indicator state: BOTH (stacked)');

    const shares = await one('SELECT user_id, is_client FROM checklist_section_shares');
    ok(shares.some((s) => Number(s.is_client) === 0), 'a notepad shared with an employee');
    ok(shares.some((s) => Number(s.is_client) === 1), 'a notepad shared with a CLIENT (card marker)');

    const merge = await one("SELECT employee_user_id, item_count FROM notepad_merge_queue WHERE status='pending'");
    ok(merge.length === 1 && Number(merge[0].employee_user_id) === 990003, 'a PENDING merge prompt for the off-list employee');

    // Idempotence: running it twice must not duplicate anything.
    execFileSync(process.execPath, ['scripts/seedNotepadDemo.js'], {
      cwd: require('path').join(__dirname, '..'), env: process.env, encoding: 'utf8',
    });
    const rows2 = await one('SELECT id FROM check_list');
    ok(rows2.length === rows.length, 're-running the seed does not duplicate rows', `${rows.length} -> ${rows2.length}`);

    await c2.end();

    console.log('\nseedNotepadDemo.smoke');
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('\nHARNESS ERROR:', e && e.stack ? e.stack : e);
    fail++;
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
