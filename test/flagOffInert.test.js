/* PROOF, not assertion: with NOTEPAD_MYTASKS_ENABLED off, the ordinary
 * job/lead paths write NOTHING into the rebuild's tables.
 *
 * The owner's condition for switching the feature on was that switching it
 * back off is a COMPLETE rollback. That only holds if the flag-off state is
 * genuinely inert — a flag that gates the new ENDPOINTS but lets the new
 * side-effects run would leave rows behind that no amount of flag-flipping
 * removes. Three tables carry those side-effects:
 *
 *     checklist_sections        the auto-created notepad itself
 *     notepad_access            the per-user grant rows
 *     checklist_section_order   the per-user card order
 *
 * Counted before and after each action, with the flag OFF and then ON.
 *
 * Run: node test/flagOffInert.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    delete process.env.NOTEPAD_MYTASKS_ENABLED;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_flagoff_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    request = require('supertest');
    jwt = require('jsonwebtoken');

    // ---- base schema (the columns these two routes actually touch) ----
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, permission_level INT NULL, `level` INT NULL, mobile VARCHAR(40) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE `job` (id INT PRIMARY KEY AUTO_INCREMENT, type VARCHAR(40), name VARCHAR(150), permit_no VARCHAR(60), permit_type VARCHAR(60), gate_no VARCHAR(60), lock_box_code VARCHAR(60), inspector_id INT NULL, client_id INT NULL, additional_client_email VARCHAR(190), additional_client_mobile VARCHAR(60), additional_client_name VARCHAR(120), address VARCHAR(190), city VARCHAR(90), state VARCHAR(90), zipcode VARCHAR(20), job_address VARCHAR(190), job_city VARCHAR(90), job_state VARCHAR(90), job_zipcode VARCHAR(20), sameAsAddress TINYINT DEFAULT 0, contract_status VARCHAR(40), from_leads INT NULL, lead_id INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, created_by INT, sort_order INT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY AUTO_INCREMENT, lead_name VARCHAR(150), lead_type VARCHAR(40), lead_category VARCHAR(60) NULL, budget VARCHAR(60) NULL, bid_status VARCHAR(40) NULL, status VARCHAR(10) NULL, client_id INT NULL, client_name VARCHAR(120) NULL, client_email VARCHAR(190) NULL, client_phone VARCHAR(60) NULL, project_street_address VARCHAR(190) NULL, project_town VARCHAR(90) NULL, project_state VARCHAR(90) NULL, project_description TEXT NULL, project_start_date DATE NULL, leads_street_address VARCHAR(190) NULL, leads_town_city VARCHAR(90) NULL, leads_state VARCHAR(90) NULL, leads_zipcode VARCHAR(20) NULL, next_phase VARCHAR(60) NULL, finance_method VARCHAR(60) NULL, user_id INT NULL, converted_job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), is_checked TINYINT DEFAULT 0, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)');
    await conn.query('CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, task_type VARCHAR(20), user_id INT, created_by INT, task_name VARCHAR(190) NULL, archived_at DATETIME NULL)');
    await conn.query('CREATE TABLE job_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(190), job_id INT, mime_type VARCHAR(90) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, type VARCHAR(40) NULL, is_shared TINYINT DEFAULT 0)');
    await conn.query('CREATE TABLE lead_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(190), lead_id INT, mime_type VARCHAR(90) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, type VARCHAR(40) NULL, is_shared TINYINT DEFAULT 0)');
    await conn.query('CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)');
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), plan_name VARCHAR(60) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    // The rebuild's own tables, built by the SAME function production runs, so
    // the fixture cannot drift from the real shape.
    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,permission_level,`level`) VALUES (74,'Owner','owner@t.co',14,4,NULL,5,5)");
    await conn.query("INSERT INTO subscriptions (user_id,status,plan_name) VALUES (74,'active','platinum')");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api', require('../routes/jobs'));
    app.use('/api/leads', require('../routes/leads'));
    // The rebuild's own routers, so the READ paths are exercised too. /hub
    // WRITES ON READ (ensureNoJobNotepad, ensurePrivatePadsForDelegatedWork),
    // which the first version of this test never covered: it drove three
    // CREATE actions and no reads at all.
    app.use('/api/checklists', require('../routes/notepadHub'));
    app.use('/api/tasks', require('../routes/myTasks'));
    app.use('/api/checklists', require('../routes/checklists'));

    const TOK = 'Bearer ' + jwt.sign(
      { id: 74, working_id: 74, role: 14, category: 4, email: 'owner@t.co' }, process.env.ACCESS_TOKEN);

    const TABLES = ['checklist_sections', 'notepad_access', 'checklist_section_order'];
    const counts = async () => {
      const out = {};
      for (const t of TABLES) {
        const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM `' + t + '`');
        out[t] = Number(r.n);
      }
      return out;
    };
    const show = (label, c) =>
      label + '  checklist_sections=' + c.checklist_sections +
      '  notepad_access=' + c.notepad_access +
      '  checklist_section_order=' + c.checklist_section_order;
    const same = (a, b) => TABLES.every((t) => a[t] === b[t]);
    const delta = (a, b) => TABLES.map((t) => t + ' ' + a[t] + '->' + b[t]).join(', ');

    const makeJob = (name) => request(app).post('/api/jobs').set('Authorization', TOK)
      .send({ type: 'Residential', name, address: '1 A St', city: 'Ojai', state: 'CA', zipcode: '93023', job_address: '1 A St', job_city: 'Ojai', job_state: 'CA', job_zipcode: '93023', sameAsAddress: 1, contract_status: 'pending' });
    const makeLead = (name) => request(app).post('/api/leads/leads/create').set('Authorization', TOK)
      .send({ lead_name: name, lead_type: 'residential', project_street_address: '2 B St',
              project_town: 'Ojai', project_state: 'CA', leads_zipcode: '93023' });

    // ================ FLAG OFF ================
    delete process.env.NOTEPAD_MYTASKS_ENABLED;
    console.log('\n-------- NOTEPAD_MYTASKS_ENABLED = OFF --------');

    let before = await counts();
    console.log(show('baseline           ', before));

    const j1 = await makeJob('Flag Off Job');
    let after = await counts();
    console.log(show('after CREATE JOB   ', after));
    ok(j1.status === 201 || j1.status === 200, 'flag OFF: the job was really created', j1.status + ' ' + JSON.stringify(j1.body).slice(0, 200));
    ok(same(before, after), 'flag OFF: creating a JOB wrote NOTHING to the three tables', delta(before, after));

    before = after;
    const l1 = await makeLead('Flag Off Lead');
    after = await counts();
    console.log(show('after CREATE LEAD  ', after));
    ok(l1.status === 201 || l1.status === 200, 'flag OFF: the lead was really created', l1.status + ' ' + JSON.stringify(l1.body).slice(0, 200));
    ok(same(before, after), 'flag OFF: creating a LEAD wrote NOTHING to the three tables', delta(before, after));

    const [[leadRow]] = await conn.query('SELECT id FROM leads ORDER BY id DESC LIMIT 1');
    before = after;
    const c1 = await request(app).post('/api/leads/convert-to-job/' + leadRow.id).set('Authorization', TOK).send({});
    after = await counts();
    console.log(show('after CONVERT      ', after));
    ok(c1.status === 200, 'flag OFF: the lead really converted to a job', c1.status + ' ' + JSON.stringify(c1.body).slice(0, 200));
    ok(same(before, after), 'flag OFF: CONVERTING a lead wrote NOTHING to the three tables', delta(before, after));

    const offFinal = after;
    ok(offFinal.checklist_sections === 0 && offFinal.notepad_access === 0 && offFinal.checklist_section_order === 0,
      'flag OFF: all three tables are still EMPTY after three real actions', JSON.stringify(offFinal));

    // routes/checklists.js ensureDefaultSection() seeds ONE pad for a user who
    // has none of that type. It is on origin/main and predates the rebuild, so
    // it is not a flag concern - but it fires on a READ, so it has to be
    // accounted for or it looks like the rebuild writing. Prove it explicitly,
    // then give the user a pad so the rest of the read phase measures only
    // what the REBUILD would do. The owner already has three pads, so his
    // state is "has pads", not "has none".
    {
      const b = await counts();
      await request(app).get('/api/checklists/sections').set('Authorization', TOK);
      const a = await counts();
      ok(a.checklist_sections === b.checklist_sections + 1,
        'LEGACY (pre-rebuild, on main): the first /sections read seeds one default pad for a user with none',
        delta(b, a));
      const [[seeded]] = await conn.query(
        'SELECT title, origin, scope FROM checklist_sections ORDER BY id DESC LIMIT 1');
      ok(seeded && seeded.origin !== 'auto',
        'LEGACY seed is not an auto pad - it is the old default page, not a rebuild notepad',
        JSON.stringify(seeded));
    }

    // ---- READS, flag off. The half that was missing. ----
    // /hub calls ensureNoJobNotepad() and ensurePrivatePadsForDelegatedWork(),
    // both of which INSERT. If the flag ever stops covering the ROUTE, a mere
    // page load starts creating notepads - and no amount of flag-flipping
    // takes them back. The old ungated /checklists/sections is included
    // because it is what actually serves users while the flag is off.
    before = await counts();
    console.log(show('before READS       ', before));

    const rHub = await request(app).get('/api/checklists/hub').set('Authorization', TOK);
    ok(rHub.status === 404 && rHub.body && rHub.body.code === 'FEATURE_DISABLED',
      'flag OFF: GET /hub is refused by name, not served',
      rHub.status + ' ' + JSON.stringify(rHub.body).slice(0, 120));

    const rMine = await request(app).get('/api/tasks/my-tasks').set('Authorization', TOK);
    ok(rMine.status === 404 && rMine.body && rMine.body.code === 'FEATURE_DISABLED',
      'flag OFF: GET /my-tasks is refused by name, not served',
      rMine.status + ' ' + JSON.stringify(rMine.body).slice(0, 120));

    const rOld = await request(app).get('/api/checklists/sections').set('Authorization', TOK);
    ok(rOld.status === 200,
      'flag OFF: the OLD sections read still WORKS - this is what users get',
      rOld.status + ' ' + JSON.stringify(rOld.body).slice(0, 120));

    // Read it twice: ensureNoJobNotepad is NOT EXISTS-guarded, so a second
    // call must also add nothing. A guard that only holds once is not a guard.
    await request(app).get('/api/checklists/hub').set('Authorization', TOK);
    await request(app).get('/api/checklists/sections').set('Authorization', TOK);

    after = await counts();
    console.log(show('after  READS       ', after));
    ok(same(before, after),
      'flag OFF: with pads already present, FIVE page reads wrote NOTHING - the rebuild adds nothing on read',
      delta(before, after));

    // ================ FLAG ON ================
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';
    console.log('\n-------- NOTEPAD_MYTASKS_ENABLED = ON ---------');

    before = await counts();
    console.log(show('baseline           ', before));

    const j2 = await makeJob('Flag On Job');
    after = await counts();
    console.log(show('after CREATE JOB   ', after));
    ok(j2.status === 201 || j2.status === 200, 'flag ON: the job was created', j2.status);
    ok(after.checklist_sections === before.checklist_sections + 1,
      'flag ON: creating a JOB adds exactly one notepad', delta(before, after));

    before = after;
    const l2 = await makeLead('Flag On Lead');
    after = await counts();
    console.log(show('after CREATE LEAD  ', after));
    ok(l2.status === 201 || l2.status === 200, 'flag ON: the lead was created', l2.status);
    ok(after.checklist_sections === before.checklist_sections + 1,
      'flag ON: creating a LEAD adds exactly one notepad', delta(before, after));

    const [[lead2]] = await conn.query('SELECT id FROM leads ORDER BY id DESC LIMIT 1');
    const [[padBefore]] = await conn.query('SELECT id, job_id, lead_id FROM checklist_sections WHERE lead_id = ? LIMIT 1', [lead2.id]);
    before = after;
    const c2 = await request(app).post('/api/leads/convert-to-job/' + lead2.id).set('Authorization', TOK).send({});
    after = await counts();
    console.log(show('after CONVERT      ', after));
    ok(c2.status === 200, 'flag ON: the lead converted', c2.status + ' ' + JSON.stringify(c2.body).slice(0, 200));
    ok(after.checklist_sections === before.checklist_sections,
      'flag ON: converting RE-POINTS the same pad, it does not add a second one', delta(before, after));
    if (padBefore) {
      const [[padAfter]] = await conn.query('SELECT id, job_id, lead_id FROM checklist_sections WHERE id = ?', [padBefore.id]);
      ok(padAfter && padAfter.job_id != null && padAfter.lead_id == null,
        'flag ON: that same pad row now points at the JOB instead of the lead',
        JSON.stringify(padAfter));
    }

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log('\n' + rec.join('\n'));
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
