/* THE DEAD JOB ON A NOTEPAD — Section A and §2.
 *
 * THE BUG THIS CLOSES ("Cliff Branch").
 *
 * `checklist_sections.job_id` has no foreign key. Both job-delete paths left
 * it pointing at a row they had just deleted:
 *
 *   DELETE /jobs/delete/:id       archived the job's TASKS, ignored its pads
 *   POST  /jobs/convert-to-lead   deleted the job outright, ignored its pads
 *
 * The LEFT JOIN that supplies `job_name` then returned NULL, and the delegate
 * sheet's `sec.job_name || sec.title` fallback printed the pad's OWN TITLE in
 * the job slot and LOCKED it there. The user was shown a confident, wrong
 * statement — a job that does not exist — and the Assign button was live.
 * The server was right to refuse it. The form is the thing that lied.
 *
 * WHAT IS PROVED HERE, and each one fails if its fix is reverted:
 *
 *   A1  a hard job delete clears job_id on that job's pads
 *   A2  convert-to-lead RE-POINTS them to the lead (not NULL — the lead is
 *       the same real-world thing, and NULL would destroy the link)
 *   A3  the two section joins are account-scoped, so a pad pointing at a
 *       FOREIGN job resolves to NULL rather than leaking that job's name
 *   §2  the three delegate outcomes are three different answers:
 *         row absent      → 404 JOB_GONE, "no longer exists"
 *         out of account  → 403, verbatim message, tripwire log w/ BOTH owners
 *         real + in scope → still works
 *
 * NON-VACUITY. Every check below was run against the UNFIXED code first and
 * the failures are recorded in the CCP report. A1/A2 fail as "job_id still
 * 10"; A3 fails by returning the foreign job's name; §2's 404 fails on the
 * old wording; the tripwire check fails because no such line was ever logged.
 *
 * Run: node test/notepadDeadJob.test.js
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
    // The delegate route lives behind the rebuild flag (live on prod since
    // 2026-09-11). Without this every §2 check 404s on FEATURE_DISABLED and
    // passes vacuously — which is exactly what the first run did.
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_dead_job', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');

    const accessMod = require('../utils/access');
    accessMod.getAccessMode = async () => 'paid';

    // CAPTURE THE LOGGER. The §2 tripwire is a log line, and a log line that
    // is never asserted is a log line that quietly stops being written.
    const logger = require('../common/logger');
    const warnings = [];
    const realWarn = logger.warn;
    logger.warn = (...a) => { warnings.push(a.join(' ')); return realWarn ? realWarn.apply(logger, a) : undefined; };

    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, timezone VARCHAR(64) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(30) NULL, client_id INT NULL, lead_id INT NULL, type VARCHAR(40) NULL, address VARCHAR(190) NULL, city VARCHAR(90) NULL, state VARCHAR(90) NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, additional_client_name VARCHAR(150) NULL, additional_client_email VARCHAR(190) NULL, additional_client_mobile VARCHAR(40) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY AUTO_INCREMENT, lead_name VARCHAR(150), lead_type VARCHAR(40) NULL, client_id INT NULL, client_name VARCHAR(150) NULL, client_email VARCHAR(190) NULL, client_phone VARCHAR(40) NULL, project_street_address VARCHAR(190) NULL, project_town VARCHAR(90) NULL, project_state VARCHAR(90) NULL, leads_street_address VARCHAR(190) NULL, leads_town_city VARCHAR(90) NULL, leads_state VARCHAR(90) NULL, leads_zipcode VARCHAR(20) NULL, status INT NULL, created_at DATETIME NULL, user_id INT NULL)");
    // WIDE ON PURPOSE. A narrow fixture here does not fail loudly — the route
    // catches, logs, and answers 500 or an empty result, which reads exactly
    // like a real refusal. That has bitten this repo twice (the dashboard
    // scope fixtures and dashboardTwoOwners' missing all_day), so every column
    // the INSERT names is present even when this test asserts nothing about it.
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20) NULL, task_name VARCHAR(190) NULL, description TEXT NULL, status INT DEFAULT 0, priority VARCHAR(10) NULL, due_date DATETIME NULL, start_date DATETIME NULL, end_date DATETIME NULL, duration_days INT NULL, all_day TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, is_calendar_task TINYINT DEFAULT 0, is_appointment_task TINYINT DEFAULT 0, is_urgent TINYINT DEFAULT 0, image VARCHAR(255) NULL, archived_at DATETIME NULL, status_note VARCHAR(255) NULL, starred_at DATETIME NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (task_id INT, user_id INT, PRIMARY KEY (task_id, user_id))");
    await conn.query("CREATE TABLE task_notes (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, client_user_id INT NULL, owner_contact_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(255), sort_order INT DEFAULT 0, job_id INT NULL, lead_id INT NULL, origin VARCHAR(20) NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), photo VARCHAR(255) NULL, assign_to INT NULL, job_id INT NULL, lead_id INT NULL, complete_percentage INT NULL, priority VARCHAR(10) DEFAULT 'low', due_date DATETIME NULL, all_day TINYINT DEFAULT 0, status VARCHAR(20) DEFAULT 'new', note TEXT NULL, assignee_completed TINYINT DEFAULT 0, delegated_task_id INT NULL, delegated_to INT NULL, created_by INT NULL, type VARCHAR(20) DEFAULT 'task', is_calendar TINYINT NULL, is_appointment TINYINT NULL, calendar_task_id INT NULL, appointment_id INT NULL, filed_at DATETIME NULL, kept TINYINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))");
    await conn.query("CREATE TABLE notepad_access (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, user_id INT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    // 700 the owner. 701 their employee. 800 a SEPARATE business.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by) VALUES
      (700,'Owner Olly','olly@x.com',14,4,NULL),
      (701,'Ed Employee','ed@x.com',12,1,700),
      (800,'Foreign Fran','fran@x.com',14,4,NULL)`);

    // Job 10 + 11 belong to 700. Job 20 belongs to the foreign account 800.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,status,color,lead_id) VALUES
      (10,'Lynes - ADU',700,1,'#a83279',NULL),
      (11,'Cliff Branch',700,1,'#334455',NULL),
      (20,'FOREIGN SECRET JOB',800,1,'#123456',NULL)`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', require('../routes/jobs'));
    app.use('/api/checklists', require('../routes/checklists'));
    app.use('/api/checklists', require('../routes/notepadDelegate'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(700);

    const padJobId = async (secId) => {
      const [[r]] = await conn.query('SELECT job_id, lead_id FROM checklist_sections WHERE id = ?', [secId]);
      return r;
    };

    // ════════════════════════════════════════════════════════════════════
    // A1 — HARD DELETE CLEARS THE PADS
    // ════════════════════════════════════════════════════════════════════
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (1,700,'task','Cliff Branch',11,'manual','private')");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (2,700,'task','Lynes pad',10,'auto','private')");

    const del = await request(app).delete('/api/jobs/delete/11').set('Authorization', OWNER);
    ok(del.status === 200, 'A1: owner deletes job 11 → 200', `${del.status} ${JSON.stringify(del.body)}`);

    const pad1 = await padJobId(1);
    ok(pad1 && pad1.job_id === null,
      'A1: the deleted job\'s pad no longer points at it (job_id NULL)',
      `job_id=${pad1 && pad1.job_id} — THIS IS THE CLIFF BRANCH BUG`);

    const pad2 = await padJobId(2);
    ok(pad2 && Number(pad2.job_id) === 10,
      'A1: a pad on a DIFFERENT job is untouched',
      `job_id=${pad2 && pad2.job_id} — the UPDATE is too wide`);

    const [[goneJob]] = await conn.query('SELECT id FROM `job` WHERE id = 11');
    ok(!goneJob, 'A1: the job really was deleted (not just the pad detached)', 'job 11 survived');

    // ════════════════════════════════════════════════════════════════════
    // A2 — CONVERT-TO-LEAD RE-POINTS, IT DOES NOT BLANK
    // ════════════════════════════════════════════════════════════════════
    await conn.query("INSERT INTO `job` (id,name,created_by,status,color,lead_id) VALUES (12,'Becomes A Lead',700,1,'#556677',NULL)");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (3,700,'task','Becomes A Lead',12,'auto','private')");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (4,700,'task','Hand-made pad on that job',12,'manual','private')");

    const conv = await request(app).post('/api/jobs/convert-to-lead/12').set('Authorization', OWNER).send({});
    ok(conv.status === 200, 'A2: convert-to-lead → 200', `${conv.status} ${JSON.stringify(conv.body)}`);
    const newLeadId = conv.body && conv.body.leadId;
    ok(Number(newLeadId) > 0, 'A2: a lead was produced', String(newLeadId));

    const pad3 = await padJobId(3);
    ok(pad3 && pad3.job_id === null && Number(pad3.lead_id) === Number(newLeadId),
      'A2: the auto pad FOLLOWS the job to its lead (job_id NULL, lead_id set)',
      `job_id=${pad3 && pad3.job_id} lead_id=${pad3 && pad3.lead_id} expected lead ${newLeadId}`);

    // The forward direction (repointNotepadLeadToJob) filters to origin='auto'.
    // The reverse must NOT: a hand-made pad left behind is an orphan, which is
    // the whole defect. This is the one place the two directions differ.
    const pad4 = await padJobId(4);
    ok(pad4 && pad4.job_id === null && Number(pad4.lead_id) === Number(newLeadId),
      'A2: a MANUAL pad on that job follows it too (origin filter would orphan it)',
      `job_id=${pad4 && pad4.job_id} lead_id=${pad4 && pad4.lead_id}`);

    // ════════════════════════════════════════════════════════════════════
    // A3 — THE SECTION JOINS ARE ACCOUNT-SCOPED
    // ════════════════════════════════════════════════════════════════════
    // A pad owned by 700 but pointing at account 800's job. Reachable because
    // the section-update route lets the owner write job_id.
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (5,700,'task','Points at a foreign job',20,'manual','private')");

    const readSections = async (path) => {
      const v = await request(app).get(path).set('Authorization', OWNER);
      const list = v.body?.data || v.body?.sections || [];
      return { status: v.status, byId: Object.fromEntries(list.map((s) => [Number(s.id), s])) };
    };

    for (const path of ['/api/checklists/sections', '/api/checklists/sections-with-items']) {
      const r = await readSections(path);
      ok(r.status === 200, `A3 ${path}: 200`, String(r.status));
      const foreign = r.byId[5];
      ok(foreign && (foreign.job_name === null || foreign.job_name === undefined),
        `A3 ${path}: a pad aimed at ANOTHER ACCOUNT'S job resolves to no name`,
        `job_name=${JSON.stringify(foreign && foreign.job_name)} — LEAKED "FOREIGN SECRET JOB"`);
      const own = r.byId[2];
      ok(own && own.job_name === 'Lynes - ADU',
        `A3 ${path}: the owner's OWN job still resolves (the scope is not simply off)`,
        `job_name=${JSON.stringify(own && own.job_name)}`);
    }

    // ════════════════════════════════════════════════════════════════════
    // §2 — THREE OUTCOMES, THREE ANSWERS
    // ════════════════════════════════════════════════════════════════════
    // A pad with NO job, so the client's job_id is what gets used.
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (6,700,'task','Free pad',NULL,'manual','private')");
    await conn.query("INSERT INTO check_list (id,section_id,name,created_by) VALUES (100,6,'Fix the gate',700),(101,6,'Paint it',700),(102,6,'Third thing',700)");

    const delegate = (itemId, body) =>
      request(app).post(`/api/checklists/items/${itemId}/delegate`).set('Authorization', OWNER).send(body);

    // (i) the row is absent
    const r404 = await delegate(100, { job_id: 999999, assignee_id: 701 });
    ok(r404.status === 404, '§2 absent job → 404', `${r404.status} ${JSON.stringify(r404.body)}`);
    ok(r404.body && r404.body.message === 'That job no longer exists. Pick another job and try again.',
      '§2 absent job → the NEW wording, which tells the user what to do',
      JSON.stringify(r404.body && r404.body.message));
    ok(r404.body && r404.body.code === 'JOB_GONE', '§2 absent job → code JOB_GONE', JSON.stringify(r404.body));

    // (ii) the row exists but belongs to another account
    warnings.length = 0;
    const r403 = await delegate(101, { job_id: 20, assignee_id: 701 });
    ok(r403.status === 403, '§2 out-of-scope job → 403, NOT 404', `${r403.status} ${JSON.stringify(r403.body)}`);
    ok(r403.body && r403.body.message === 'That job is not in your account.',
      '§2 out-of-scope keeps its vague wording verbatim (it must not confirm the job exists)',
      JSON.stringify(r403.body && r403.body.message));
    ok(r403.body && r403.body.message !== r404.body.message,
      '§2 the two refusals are DISTINGUISHABLE to the user', 'both said the same thing');

    const trip = warnings.find((w) => w.includes('DELEGATE_JOB_OUT_OF_SCOPE'));
    ok(!!trip, '§2 the out-of-scope branch writes the tripwire log line', warnings.join(' | ') || '(nothing logged)');
    ok(!!trip && /caller_account_owner=700\b/.test(trip),
      '§2 the tripwire carries the CALLER\'s account owner', trip || '');
    ok(!!trip && /job_account_owner=800\b/.test(trip),
      '§2 the tripwire carries the JOB\'s account owner — both ids, so they can be compared', trip || '');
    ok(!!trip && /job_id=20\b/.test(trip) && /caller=700\b/.test(trip),
      '§2 the tripwire carries the job id and the caller', trip || '');
    ok(!!trip && trip.includes('/delegate'),
      '§2 the tripwire names the route', trip || '');

    const trip404 = warnings.filter((w) => w.includes('DELEGATE_JOB_OUT_OF_SCOPE'));
    ok(trip404.length === 1, '§2 exactly one tripwire line per refusal', String(trip404.length));

    // (iii) a real job in the caller's account still works
    const rOk = await delegate(102, { job_id: 10, assignee_id: 701 });
    ok(rOk.status === 200 || rOk.status === 201,
      '§2 a real, in-account job still delegates (the guard is not simply refusing everything)',
      `${rOk.status} ${JSON.stringify(rOk.body)}`);

    // And the 404 branch did NOT log the scope tripwire — if it did, the
    // tripwire would fire on every mistyped id and be useless as a signal.
    warnings.length = 0;
    await delegate(100, { job_id: 999998, assignee_id: 701 });
    ok(!warnings.some((w) => w.includes('DELEGATE_JOB_OUT_OF_SCOPE')),
      '§2 an ABSENT job does not trip the scope wire (it would drown the signal)',
      warnings.join(' | '));

    logger.warn = realWarn;
  } catch (e) {
    fail++;
    rec.push('  ✗ HARNESS: ' + (e && e.stack ? e.stack : e));
  } finally {
    try { if (conn) conn.release(); } catch (e) { /* ignore */ }
    try { if (pool && pool.end) await pool.end(); } catch (e) { /* ignore */ }
    try { if (db && db.stop) await db.stop(); } catch (e) { /* ignore */ }
  }

  console.log('\nDEAD JOB ON A NOTEPAD — Section A + §2\n');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
