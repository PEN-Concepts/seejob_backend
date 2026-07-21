/* Expired-free FULL LOCKOUT of a Contractor/Client's OWN jobs (CCP addendum).
 *
 * Proves, against real MySQL (mysql-memory-server) + supertest:
 *  A) access.js primitives: canViewJob / isExpiredOwnJob / blockExpiredOwnJob
 *     correctly lock an expired user's OWN jobs (even self-assigned) while
 *     leaving FOREIGN collaborator jobs and all paid/trial users untouched.
 *  B) filterTasksForExpired hides own job/lead/no-job tasks, keeps foreign.
 *  C) HTTP: expired user is 403'd reading their OWN job's stages/materials and
 *     gets their own tasks filtered out of all_job_task/daily_tasks/GET:id,
 *     but CAN still read + COMPLETE a task assigned on a FOREIGN job (#4).
 *  D) HTTP: expired user's OWN Notepad sections/items are hidden while a section
 *     SHARED with them (and items delegated to them by others) stay visible.
 * Run: NODE_PATH=<backend>/node_modules node test/expiredLockout.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt, access, tasksRouter;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.AUTHORIZE_API_LOGIN_ID;
    delete process.env.AUTHORIZE_TRANSACTION_KEY;
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_lockout_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    access = require('../utils/access');
    tasksRouter = require('../routes/tasks'); // exposes filterTasksForExpired
    const invitationsRouter = require('../routes/invitations'); // exposes filterAppointmentsForExpired
    conn = await pool.getConnection();

    // ---- schema ----
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, created_by INT NULL, created_at DATETIME NULL, timezone VARCHAR(64) NULL, password VARCHAR(120) NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30))");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), status INT DEFAULT 1, client_id INT NULL, inspector_id INT NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL, lead_name VARCHAR(150), status INT DEFAULT 1, bid_status VARCHAR(50) NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20), task_name VARCHAR(150), status INT NULL, priority VARCHAR(20) NULL, start_date DATE NULL, time VARCHAR(20) NULL, duration_days INT NULL, is_calendar_task INT NULL, is_appointment_task INT NULL, assignee_completed INT NULL, image VARCHAR(255) NULL, created_at DATETIME NULL, archived_at DATETIME NULL, status_note VARCHAR(255) NULL)");
    await conn.query("CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, file_path VARCHAR(255), file_name VARCHAR(255), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(30), team_leader INT NULL, created_by INT NULL)");
    await conn.query("CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL)");
    await conn.query("CREATE TABLE stages (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', status INT DEFAULT 1, stage_name VARCHAR(120) NULL)");
    await conn.query("CREATE TABLE materials (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', name VARCHAR(120) NULL)");
    await conn.query("CREATE TABLE division_lineitems (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', division_id INT NULL, lineitem_description VARCHAR(200) NULL, amount DECIMAL(12,2) NULL, csi_number VARCHAR(30) NULL, contingency DECIMAL(12,2) NULL)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', contact_id INT NULL, user_id INT NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, shared_with_user_id INT NULL, type VARCHAR(20), title VARCHAR(150), sort_order INT DEFAULT 0, created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY, section_id INT NULL, name VARCHAR(200), description TEXT NULL, photo VARCHAR(255) NULL, created_by INT NULL, assign_to INT NULL, job_id INT NULL, lead_id INT NULL, type VARCHAR(20) DEFAULT 'task', status VARCHAR(20) NULL, priority VARCHAR(20) NULL, due_date DATE NULL, filed_at DATETIME NULL, kept INT DEFAULT 0, is_calendar INT DEFAULT 0, is_appointment INT DEFAULT 0, calendar_task_id INT NULL, appointment_id INT NULL, complete_percentage INT NULL, assignee_completed INT NULL, created_at DATETIME NULL)");

    // ---- accounts ----
    //  E(700) expired contractor · P(710) paid · T(720) trial · F(800) foreign GC
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Expired Contractor','e@x.com',14,2,NULL, NOW() - INTERVAL 200 DAY),
      (710,'Paid Contractor','p@x.com',14,2,NULL, NOW() - INTERVAL 200 DAY),
      (720,'Trial Contractor','t@x.com',14,2,NULL, NOW() - INTERVAL 5 DAY),
      (800,'Foreign GC','f@x.com',14,2,NULL, NOW() - INTERVAL 200 DAY)`);
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (710,'active'),(800,'active')"); // P & F paid; E & T none

    // ---- jobs ----
    await conn.query("INSERT INTO job (id,created_by,name,status) VALUES (1000,700,'E own job',1),(1010,710,'P own job',1),(1020,800,'F foreign job',1)");
    // ---- leads: E(3000) own · P(3010) own · F(3020) foreign ----
    await conn.query("INSERT INTO leads (id,user_id,lead_name,status) VALUES (3000,700,'E own lead',1),(3010,710,'P own lead',1),(3020,800,'F lead',1)");
    // lead-owned stages/materials (owner_type='lead', id carried in job_id column)
    await conn.query("INSERT INTO stages (job_id,owner_type,status,stage_name) VALUES (3000,'lead',1,'E lead stage'),(3010,'lead',1,'P lead stage')");
    await conn.query("INSERT INTO materials (job_id,owner_type,name) VALUES (3000,'lead','E lead material')");
    // ---- tasks ----
    await conn.query(`INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,created_at) VALUES
      (2000,1000,700,700,'job','E own job task (self-assigned)',0, CURDATE(), NOW()),
      (2001,1020,700,800,'job','Foreign job task assigned to E',0, CURDATE(), NOW()),
      (2002,NULL,700,700,'task','E own no-job task',0, CURDATE(), NOW()),
      (2003,3000,700,700,'lead','E own lead task',0, CURDATE(), NOW()),
      (2010,1010,710,710,'job','P own job task',0, CURDATE(), NOW())`);
    // ---- stages / materials on E's own job + a stage on the foreign job ----
    await conn.query("INSERT INTO stages (job_id,owner_type,status,stage_name) VALUES (1000,'job',1,'E stage'),(1020,'job',1,'F stage'),(1010,'job',1,'P stage')");
    await conn.query("INSERT INTO materials (job_id,owner_type,name) VALUES (1000,'job','E material')");
    // ---- Notepad: E own section+items, a section shared TO E by F, delegations ----
    await conn.query(`INSERT INTO checklist_sections (id,owner_user_id,shared_with_user_id,type,title,sort_order) VALUES
      (4000,700,NULL,'task','E own section',1),
      (4001,800,700,'task','F section shared with E',2),
      (4002,710,NULL,'task','P own section',3)`);
    await conn.query(`INSERT INTO check_list (id,section_id,name,created_by,assign_to,type,status) VALUES
      (5000,4000,'E own item',700,NULL,'task','pending'),
      (5001,4001,'Shared item from F',800,700,'task','pending'),
      (5002,NULL,'E self-delegated item',700,700,'task','pending'),
      (5003,NULL,'Item delegated to E by F',800,700,'task','pending'),
      (5010,4002,'P own item',710,NULL,'task','pending')`);

    // =====================================================================
    // A) access.js primitives
    // =====================================================================
    ok((await access.getAccessMode(700, conn)) === 'expired_free', 'A: E resolves to expired_free', await access.getAccessMode(700, conn));
    ok((await access.getAccessMode(710, conn)) === 'paid', 'A: P resolves to paid');
    ok((await access.getAccessMode(720, conn)) === 'trial_active', 'A: T resolves to trial_active');

    ok((await access.canViewJob(700, 1000, conn)) === false, 'A: canViewJob(E, own job) = FALSE even though E self-assigned a task on it (#5 leak closed)');
    ok((await access.canViewJob(700, 1020, conn)) === true, 'A: canViewJob(E, FOREIGN job) = TRUE — collaborator access preserved (#4)');
    ok((await access.canViewJob(710, 1010, conn)) === true, 'A: canViewJob(P, own job) = TRUE — paid unchanged');

    ok((await access.isExpiredOwnJob(700, 1000, conn)) === true, 'A: isExpiredOwnJob(E, own job) = true');
    ok((await access.isExpiredOwnJob(700, 1020, conn)) === false, 'A: isExpiredOwnJob(E, foreign job) = false (#4)');
    ok((await access.isExpiredOwnJob(710, 1010, conn)) === false, 'A: isExpiredOwnJob(P, own job) = false — paid never blocked');
    ok((await access.isExpiredOwnJob(720, 1000, conn)) === false, 'A: isExpiredOwnJob(T, any job) = false — trial never blocked');

    // A2) blockExpiredOwnJob middleware with each route's job-id extractor.
    const runMw = (getJobId, req) => new Promise((resolve) => {
      const mw = access.blockExpiredOwnJob(getJobId);
      let statusCode = 200, nextCalled = false;
      const res = { status(c) { statusCode = c; return this; }, json() { resolve({ statusCode, nextCalled }); return this; } };
      mw(req, res, () => { nextCalled = true; resolve({ statusCode: 200, nextCalled: true }); });
    });
    const runMw2 = (getId, getOwnerType, req) => new Promise((resolve) => {
      const mw = access.blockExpiredOwnRecord(getId, getOwnerType);
      let statusCode = 200, nextCalled = false;
      const res = { status(c) { statusCode = c; return this; }, json() { resolve({ statusCode, nextCalled }); return this; } };
      mw(req, res, () => { nextCalled = true; resolve({ statusCode: 200, nextCalled: true }); });
    });
    const reqFor = (uid, role, part) => ({ user: { id: uid, role }, params: part.params || {}, query: part.query || {}, body: part.body || {} });
    // stages (params.job_id)
    ok((await runMw((r) => r.params.job_id, reqFor(700, 14, { params: { job_id: 1000 } }))).statusCode === 403, 'A2: stages gate — E + own job -> 403');
    ok((await runMw((r) => r.params.job_id, reqFor(700, 14, { params: { job_id: 1020 } }))).nextCalled === true, 'A2: stages gate — E + FOREIGN job -> passes (#4)');
    ok((await runMw((r) => r.params.job_id, reqFor(710, 14, { params: { job_id: 1010 } }))).nextCalled === true, 'A2: stages gate — P + own job -> passes (paid unchanged)');
    // materials (query.job_id)
    ok((await runMw((r) => r.query.job_id, reqFor(700, 14, { query: { job_id: 1000 } }))).statusCode === 403, 'A2: materials gate — E + own job -> 403');
    // budget contingency (body.job_id)
    ok((await runMw((r) => r.body && r.body.job_id, reqFor(700, 14, { body: { job_id: 1000 } }))).statusCode === 403, 'A2: budget gate — E + own job -> 403');
    ok((await runMw((r) => r.body && r.body.job_id, reqFor(700, 14, { body: { job_id: 1020 } }))).nextCalled === true, 'A2: budget gate — E + foreign job -> passes (#4)');
    // quote/CO details (params.job_id)
    ok((await runMw((r) => r.params.job_id, reqFor(700, 14, { params: { job_id: 1000 } }))).statusCode === 403, 'A2: quote/CO details gate — E + own job -> 403');

    // =====================================================================
    // B) filterTasksForExpired
    // =====================================================================
    const filter = tasksRouter.filterTasksForExpired;
    const eRows = [
      { id: 2000, job_id: 1000, task_type: 'job' },
      { id: 2001, job_id: 1020, task_type: 'job' },
      { id: 2002, job_id: null, task_type: 'task' },
      { id: 2003, job_id: 3000, task_type: 'lead' },
    ];
    const eVisible = await filter(conn, 700, eRows);
    const eIds = eVisible.map((r) => r.id).sort();
    ok(eIds.length === 1 && eIds[0] === 2001, 'B: expired E keeps ONLY the foreign job task (2001); own job/lead/no-job tasks dropped', JSON.stringify(eIds));
    const pVisible = await filter(conn, 710, [{ id: 2010, job_id: 1010, task_type: 'job' }]);
    ok(pVisible.length === 1 && pVisible[0].id === 2010, 'B: paid P keeps their own job task (filter is a no-op for paid)');

    // =====================================================================
    // E) LEADS — own lead data locked for expired; paid/trial + foreign unaffected
    // =====================================================================
    ok((await access.isExpiredOwnLead(700, 3000, conn)) === true, 'E: isExpiredOwnLead(E, own lead) = true');
    ok((await access.isExpiredOwnLead(700, 3020, conn)) === false, 'E: isExpiredOwnLead(E, FOREIGN lead) = false');
    ok((await access.isExpiredOwnLead(710, 3010, conn)) === false, 'E: isExpiredOwnLead(P, own lead) = false — paid unchanged');
    // blockExpiredOwnRecord with owner_type=lead (stages/materials/budget/quote lead_details all use this)
    ok((await runMw2((r) => r.params.job_id, (r) => r.query.owner_type, reqFor(700, 14, { params: { job_id: 3000 }, query: { owner_type: 'lead' } }))).statusCode === 403, 'E: lead gate — E + own lead -> 403 (stages/materials owner_type=lead)');
    ok((await runMw2((r) => r.params.job_id, () => 'lead', reqFor(700, 14, { params: { job_id: 3000 } }))).statusCode === 403, 'E: lead gate — E + own lead -> 403 (quote lead_details)');
    ok((await runMw2((r) => r.params.job_id, (r) => r.query.owner_type, reqFor(700, 14, { params: { job_id: 3020 }, query: { owner_type: 'lead' } }))).nextCalled === true, 'E: lead gate — E + FOREIGN lead -> passes');
    ok((await runMw2((r) => r.params.job_id, (r) => r.query.owner_type, reqFor(710, 14, { params: { job_id: 3010 }, query: { owner_type: 'lead' } }))).nextCalled === true, 'E: lead gate — P + own lead -> passes (paid unchanged)');

    // =====================================================================
    // F) APPOINTMENTS — own locked; foreign-invited kept (filter unit)
    // =====================================================================
    const filterAppt = invitationsRouter.filterAppointmentsForExpired;
    const apptRows = [
      { id: 9000, created_by: 700, user_id: 700 },   // E's OWN appointment
      { id: 9001, created_by: 800, user_id: 700 },   // F invited E (foreign)
    ];
    const apptE = await filterAppt(conn, 700, apptRows);
    const apptEids = apptE.map((r) => r.id).sort();
    ok(apptEids.length === 1 && apptEids[0] === 9001, 'F: expired E keeps ONLY the foreign-invited appointment (9001); own appointment 9000 hidden', JSON.stringify(apptEids));
    const apptP = await filterAppt(conn, 710, [{ id: 9010, created_by: 710, user_id: 710 }]);
    ok(apptP.length === 1 && apptP[0].id === 9010, 'F: paid P keeps their own appointment (filter no-op for paid)');
    // POST /appointments create is gated by denyExpiredFreeWrites (source check).
    const invSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'invitations.js'), 'utf8');
    ok(/router\.post\('\/appointments',\s*auth\.authenticateToken,\s*denyExpiredFreeWrites/.test(invSrc), 'F: POST /appointments create is gated by denyExpiredFreeWrites (expired cannot create)');

    // =====================================================================
    // C) + D) HTTP integration
    // =====================================================================
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobs', require('../routes/jobs'));
    app.use('/api/tasks', require('../routes/tasks'));
    app.use('/api/checklists', require('../routes/checklists'));
    const tok = (id, role) => 'Bearer ' + jwt.sign({ id, role, email: id + '@x.com', working_id: id }, process.env.ACCESS_TOKEN);

    // C1) stages: E blocked on own, allowed on foreign; P sees own (unchanged)
    const sE = await request(app).get('/api/jobs/stages/1000').set('Authorization', tok(700, 14));
    ok(sE.status === 403, 'C: GET stages of E OWN job as E -> 403', sE.status);
    const sF = await request(app).get('/api/jobs/stages/1020').set('Authorization', tok(700, 14));
    ok(sF.status === 200, 'C: GET stages of FOREIGN job as E -> 200 (collaborator, #4)', sF.status);
    const sP = await request(app).get('/api/jobs/stages/1010').set('Authorization', tok(710, 14));
    ok(sP.status === 200 && Array.isArray(sP.body) && sP.body.length === 1, 'C: GET stages of P OWN job as P -> 200 with data (paid unchanged)', sP.status);

    // C2) materials: E blocked on own job
    const mE = await request(app).get('/api/jobs/materials?job_id=1000').set('Authorization', tok(700, 14));
    ok(mE.status === 403, 'C: GET materials?job_id=<E own> as E -> 403', mE.status);

    // C2b) LEAD-owned stages/materials: E blocked on own lead; P sees own lead (HTTP)
    const lsE = await request(app).get('/api/jobs/stages/3000?owner_type=lead').set('Authorization', tok(700, 14));
    ok(lsE.status === 403, 'C: GET stages/<E own LEAD>?owner_type=lead as E -> 403', lsE.status);
    const lmE = await request(app).get('/api/jobs/materials?job_id=3000&owner_type=lead').set('Authorization', tok(700, 14));
    ok(lmE.status === 403, 'C: GET materials?job_id=<E own LEAD>&owner_type=lead as E -> 403', lmE.status);
    const lsP = await request(app).get('/api/jobs/stages/3010?owner_type=lead').set('Authorization', tok(710, 14));
    ok(lsP.status === 200 && Array.isArray(lsP.body) && lsP.body.length === 1, 'C: GET stages/<P own LEAD>?owner_type=lead as P -> 200 with data (paid unchanged)', lsP.status);

    // C3) all_job_task: own job filtered out; foreign job kept
    const ajE = await request(app).get('/api/tasks/all_job_task/1000').set('Authorization', tok(700, 14));
    ok(ajE.status === 200 && Array.isArray(ajE.body) && !ajE.body.some((t) => t.id === 2000), 'C: all_job_task(E own job) as E excludes the own task 2000', JSON.stringify((ajE.body || []).map((t) => t.id)));
    const ajF = await request(app).get('/api/tasks/all_job_task/1020').set('Authorization', tok(700, 14));
    ok(ajF.status === 200 && ajF.body.some((t) => t.id === 2001), 'C: all_job_task(FOREIGN job) as E INCLUDES the assigned foreign task 2001 (#4)', JSON.stringify((ajF.body || []).map((t) => t.id)));
    const ajP = await request(app).get('/api/tasks/all_job_task/1010').set('Authorization', tok(710, 14));
    ok(ajP.status === 200 && ajP.body.some((t) => t.id === 2010), 'C: all_job_task(P own job) as P INCLUDES own task 2010 (paid unchanged)', JSON.stringify((ajP.body || []).map((t) => t.id)));

    // C4) daily_tasks: excludes own (2000/2002/2003), includes foreign (2001)
    const dtE = await request(app).get('/api/tasks/daily_tasks').set('Authorization', tok(700, 14));
    const dtIds = (dtE.body || []).map((t) => t.id);
    ok(dtE.status === 200 && dtIds.includes(2001) && !dtIds.includes(2000) && !dtIds.includes(2002) && !dtIds.includes(2003), 'C: daily_tasks as E = only foreign-assigned (2001); own job/no-job/lead tasks hidden', JSON.stringify(dtIds));
    const dtP = await request(app).get('/api/tasks/daily_tasks').set('Authorization', tok(710, 14));
    ok(dtP.status === 200 && (dtP.body || []).some((t) => t.id === 2010), 'C: daily_tasks as P still shows own task 2010 (paid unchanged)', JSON.stringify((dtP.body || []).map((t) => t.id)));

    // C5) GET /tasks/:id — own blocked, foreign allowed
    const tiOwn = await request(app).get('/api/tasks/2000').set('Authorization', tok(700, 14));
    ok(tiOwn.status === 403, 'C: GET /tasks/<E own task> as E -> 403', tiOwn.status);
    const tiForeign = await request(app).get('/api/tasks/2001').set('Authorization', tok(700, 14));
    ok(tiForeign.status === 200 && tiForeign.body && tiForeign.body.id === 2001, 'C: GET /tasks/<foreign assigned task> as E -> 200 (#4)', tiForeign.status);

    // C6) task-complete on the FOREIGN assigned task is still allowed for expired E (#4)
    const compl = await request(app).patch('/api/tasks/2001/complete').set('Authorization', tok(700, 14)).send({ assignee_completed: 1 });
    const [[t2001]] = await conn.query('SELECT assignee_completed FROM tasks WHERE id = 2001');
    ok(compl.status === 200 && Number(t2001.assignee_completed) === 1, 'C: expired E CAN complete a task assigned on a FOREIGN job (#4)', compl.status);

    // D) Notepad: own hidden, shared-to-E + delegated-by-others visible
    const npE = await request(app).get('/api/checklists/sections-with-items?type=task').set('Authorization', tok(700, 14));
    const secIds = (npE.body && npE.body.data || []).map((s) => Number(s.id));
    const itemIds = [];
    (npE.body && npE.body.data || []).forEach((s) => (s.items || []).forEach((i) => itemIds.push(Number(i.id))));
    ok(npE.status === 200 && !secIds.includes(4000) && secIds.includes(4001), 'D: Notepad as E hides OWN section 4000, keeps SHARED-to-E section 4001 (#4)', JSON.stringify(secIds));
    ok(!itemIds.includes(5000) && !itemIds.includes(5002), 'D: Notepad as E hides own item 5000 (own section) + self-delegated 5002', JSON.stringify(itemIds));
    // 5001 lives in section 4001 which F shared TO E — collaborator content, must stay (#4).
    // (5003 is section-less; the endpoint groups items under sections, so section-less
    //  items surface in NO tier — not asserted.)
    ok(itemIds.includes(5001), 'D: Notepad as E keeps the shared-section item 5001 from F (#4)', JSON.stringify(itemIds));
    const npP = await request(app).get('/api/checklists/sections-with-items?type=task').set('Authorization', tok(710, 14));
    const pSecIds = (npP.body && npP.body.data || []).map((s) => Number(s.id));
    ok(npP.status === 200 && pSecIds.includes(4002), 'D: Notepad as P still shows own section 4002 (paid unchanged)', JSON.stringify(pSecIds));

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
