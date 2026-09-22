/* RED — GET /jobs/all-tasks HANDED A SUBCONTRACTOR THE INVITING CONTRACTOR'S
 * ENTIRE JOB AND LEAD LIST.
 *
 * THIS IS THE ENDPOINT THE DEFAULT DASHBOARD CALLS. Login lands on /spartan
 * (login.component.ts:127), SpartanComponent calls getJobsLeadsWithTasks(),
 * and that is GET /jobs/all-tasks. The phone's m-home calls it too. So this
 * was on the first page most users see, every morning.
 *
 * THE DEFECT, and it is the dashboard tenant-scope bug wearing a different hat:
 *
 *     const managerId = user.created_by || loggedInUserId;     // promote ANYONE
 *     ...
 *     WHERE ( j.created_by = ?          -- loggedInUserId
 *          OR j.created_by = ?          -- managerId  <-- the inviting contractor
 *          ... )
 *     jobsParams = [loggedInUserId, managerId, ...]
 *
 * A subcontractor's `created_by` IS the contractor who invited them, so the
 * second clause selected that contractor's whole job list. The narrow path was
 * gated on category 3 ONLY, with a comment saying category 2 was "intentionally
 * UNCHANGED" — which stopped being true the moment anyone read it as a rule.
 *
 * The lead clause had the same shape: `l.user_id = ?` took managerId directly.
 *
 * THE FIX IS THE RESOLVER, NOT A NEW PREDICATE. `resolveOwnerId` promotes
 * EMPLOYEES ONLY (category 1), so a subcontractor resolves to themselves and
 * `created_by = <self>` selects nothing of anyone else's. GET /jobs already
 * resolved it that way; this makes the two agree instead of keeping a second,
 * looser copy of the rule.
 *
 * jobScopeWhere() is deliberately NOT used: it has no job_contacts,
 * task_assignees or team clause, and this endpoint needs all three. Forcing it
 * would strip a subcontractor of the jobs they are legitimately attached to.
 *
 * Run: node test/allTasksTenantScope.test.js
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

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_alltasks_scope', logLevel: 'ERROR' });
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

    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), business VARCHAR(190) NULL, role INT NULL, category INT NULL, created_by INT NULL, timezone VARCHAR(64) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(30) NULL, client_id INT NULL, sort_order INT DEFAULT 0, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, address VARCHAR(190) NULL, city VARCHAR(90) NULL, state VARCHAR(90) NULL, zipcode VARCHAR(20) NULL, contract_status VARCHAR(40) NULL, type VARCHAR(40) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, status VARCHAR(10) NULL, bid_status VARCHAR(40) NULL, project_street_address VARCHAR(190) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20) NULL, task_name VARCHAR(190) NULL, description TEXT NULL, status INT DEFAULT 0, priority VARCHAR(10) NULL, due_date DATETIME NULL, start_date DATETIME NULL, end_date DATETIME NULL, duration_days INT NULL, all_day TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, is_calendar_task TINYINT DEFAULT 0, is_appointment_task TINYINT DEFAULT 0, is_urgent TINYINT DEFAULT 0, complete_percentage INT NULL, image VARCHAR(255) NULL, archived_at DATETIME NULL, status_note VARCHAR(255) NULL, starred_at DATETIME NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, seen_at DATETIME NULL, response VARCHAR(20) NULL, responded_at DATETIME NULL, completed_at DATETIME NULL, UNIQUE KEY uq_ta (task_id, user_id))");
    await conn.query("CREATE TABLE team_user (team_id INT, user_id INT)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)");
    await conn.query("CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, file_name VARCHAR(255) NULL, file_path VARCHAR(255) NULL, kind VARCHAR(20) NULL, uploaded_by INT NULL, created_at DATETIME NULL)");
    // WIDE ON PURPOSE. /all-tasks also reads the schedule tables, and without
    // them it 500s — which made the subcontractor checks pass on an EMPTY
    // response. Five vacuous passes on the first run; that is exactly the trap
    // the owner/employee control rows exist to catch.
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), photo VARCHAR(255) NULL, assign_to INT NULL, job_id INT NULL, lead_id INT NULL, complete_percentage INT NULL, priority VARCHAR(10) NULL, due_date DATETIME NULL, all_day TINYINT DEFAULT 0, status VARCHAR(20) NULL, note TEXT NULL, assignee_completed TINYINT DEFAULT 0, delegated_task_id INT NULL, delegated_to INT NULL, created_by INT NULL, type VARCHAR(20) NULL, is_calendar TINYINT NULL, is_appointment TINYINT NULL, calendar_task_id INT NULL, appointment_id INT NULL, filed_at DATETIME NULL, kept TINYINT DEFAULT 0, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, lead_id INT NULL, origin VARCHAR(20) NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, skip_saturday TINYINT DEFAULT 1, skip_sunday TINYINT DEFAULT 1)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, task_id INT NULL, name VARCHAR(190), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, is_inspection TINYINT DEFAULT 0, assignee_user_id INT NULL, updated_at DATETIME NULL)");

    /*
     * 700 CONTRACTOR (owner, category 4).
     * 701 EMPLOYEE  (category 1, created_by 700) — SHOULD see the account.
     * 702 SUBCONTRACTOR (category 2, created_by 700) — separate business.
     * 703 CLIENT (category 3, created_by 700).
     */
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by) VALUES
      (700,'Poul (GC)','gc@x.com',14,4,NULL),
      (701,'Ed Employee','ed@x.com',12,1,700),
      (702,'Sam Subcontractor','sub@x.com',12,2,700),
      (703,'Cliff Client','client@x.com',12,3,700)`);

    // FIVE private jobs of the contractor's. The subcontractor is attached to
    // exactly ONE of them, and has a task on a second.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,status,color) VALUES
      (10,'GC PRIVATE ALPHA',700,1,'#111'),
      (11,'GC PRIVATE BETA',700,1,'#222'),
      (12,'GC PRIVATE GAMMA',700,1,'#333'),
      (13,'SUB IS A CONTACT ON THIS',700,1,'#444'),
      (14,'SUB HAS A TASK ON THIS',700,1,'#555')`);
    await conn.query('INSERT INTO job_contacts (job_id, contact_id) VALUES (13, 702)');
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status) VALUES (1,14,702,700,'job','Hang the drywall',0)");

    // THREE private leads of the contractor's.
    await conn.query(`INSERT INTO leads (id,lead_name,user_id,status) VALUES
      (20,'GC PRIVATE LEAD ONE',700,'1'),
      (21,'GC PRIVATE LEAD TWO',700,'1'),
      (22,'GC PRIVATE LEAD THREE',700,'1')`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', require('../routes/jobs'));
    const tok = (id, category) => 'Bearer ' + jwt.sign({ id, category, email: `u${id}@x.com` }, process.env.ACCESS_TOKEN);

    const allTasks = (id, category) =>
      request(app).get('/api/jobs/all-tasks').set('Authorization', tok(id, category));

    const namesOf = (body, key, field) => ((body && body[key]) || []).map((r) => String(r[field] || ''));

    // ════════════════════════════════════════════════════════════════════
    // THE OWNER — the control. If this is empty the rest proves nothing.
    // ════════════════════════════════════════════════════════════════════
    const owner = await allTasks(700, 4);
    ok(owner.status === 200, 'owner: 200', `${owner.status} ${JSON.stringify(owner.body).slice(0, 200)}`);
    const ownerJobs = namesOf(owner.body, 'jobs', 'name');
    const ownerLeads = namesOf(owner.body, 'leads', 'lead_name');
    note(`owner sees ${ownerJobs.length} jobs, ${ownerLeads.length} leads`);
    ok(ownerJobs.length === 5, 'owner: sees all five of their own jobs', ownerJobs.join(' | '));
    ok(ownerLeads.length === 3, 'owner: sees all three of their own leads', ownerLeads.join(' | '));

    // ════════════════════════════════════════════════════════════════════
    // THE EMPLOYEE — must KEEP the account view. resolveOwnerId promotes
    // category 1, so narrowing must not catch them.
    // ════════════════════════════════════════════════════════════════════
    const emp = await allTasks(701, 1);
    const empJobs = namesOf(emp.body, 'jobs', 'name');
    const empLeads = namesOf(emp.body, 'leads', 'lead_name');
    note(`employee sees ${empJobs.length} jobs, ${empLeads.length} leads`);
    ok(empJobs.length === 5,
      'employee: KEEPS the whole account view — the fix must not narrow them',
      empJobs.join(' | '));
    ok(empLeads.length === 3, 'employee: keeps the account leads', empLeads.join(' | '));

    // ════════════════════════════════════════════════════════════════════
    // THE SUBCONTRACTOR — THE LEAK
    // ════════════════════════════════════════════════════════════════════
    const sub = await allTasks(702, 2);
    ok(sub.status === 200, 'subcontractor: 200', String(sub.status));
    const subJobs = namesOf(sub.body, 'jobs', 'name');
    const subLeads = namesOf(sub.body, 'leads', 'lead_name');
    note(`SUBCONTRACTOR sees ${subJobs.length} jobs: ${subJobs.join(' | ') || '(none)'}`);
    note(`SUBCONTRACTOR sees ${subLeads.length} leads: ${subLeads.join(' | ') || '(none)'}`);

    ok(!subJobs.some((n) => n.startsWith('GC PRIVATE')),
      'SUBCONTRACTOR: NOT ONE of the contractor\'s private jobs',
      subJobs.filter((n) => n.startsWith('GC PRIVATE')).join(' | '));
    ok(!subLeads.some((n) => n.startsWith('GC PRIVATE')),
      'SUBCONTRACTOR: NOT ONE of the contractor\'s private leads',
      subLeads.filter((n) => n.startsWith('GC PRIVATE')).join(' | '));

    // AND THE OTHER HALF: what they SHOULD still have.
    ok(subJobs.includes('SUB IS A CONTACT ON THIS'),
      'subcontractor: KEEPS the job they are attached to via job_contacts', subJobs.join(' | '));
    ok(subJobs.includes('SUB HAS A TASK ON THIS'),
      'subcontractor: KEEPS the job they have a task on', subJobs.join(' | '));
    ok(subJobs.length === 2,
      'subcontractor: exactly those two and nothing else',
      `${subJobs.length}: ${subJobs.join(' | ')}`);
    ok(subLeads.length === 0,
      'subcontractor: no leads at all — they are not on any', subLeads.join(' | '));

    // ════════════════════════════════════════════════════════════════════
    // THE CLIENT — its own narrow path, walked rather than assumed.
    // ════════════════════════════════════════════════════════════════════
    const cli = await allTasks(703, 3);
    const cliJobs = namesOf(cli.body, 'jobs', 'name');
    const cliLeads = namesOf(cli.body, 'leads', 'lead_name');
    note(`client sees ${cliJobs.length} jobs, ${cliLeads.length} leads`);
    ok(cliJobs.length === 0,
      'CLIENT: nothing — they are assigned no task, so they are on no job',
      cliJobs.join(' | '));
    ok(cliLeads.length === 0, 'CLIENT: no leads either', cliLeads.join(' | '));

    // A client WITH an assigned task sees that job and only that job.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status) VALUES (2,10,703,700,'job','Sign the change order',0)");
    const cli2 = await allTasks(703, 3);
    const cli2Jobs = namesOf(cli2.body, 'jobs', 'name');
    note(`client with one assigned task sees: ${cli2Jobs.join(' | ') || '(none)'}`);
    ok(cli2Jobs.length === 1 && cli2Jobs[0] === 'GC PRIVATE ALPHA',
      'CLIENT: exactly the one job they are assigned to, not the account',
      cli2Jobs.join(' | '));
  } catch (e) {
    fail++;
    rec.push('  ✗ HARNESS: ' + (e && e.stack ? e.stack : e));
  } finally {
    try { if (conn) conn.release(); } catch (e) { /* ignore */ }
    try { if (pool && pool.end) await pool.end(); } catch (e) { /* ignore */ }
    try { if (db && db.stop) await db.stop(); } catch (e) { /* ignore */ }
  }

  console.log('\nGET /jobs/all-tasks — TENANT SCOPE\n');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
