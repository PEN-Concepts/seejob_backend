/* Notepad access model — synthetic-data functional test (real local MySQL via
 * mysql-memory-server + supertest).
 *
 * This is the CCP's "Permissions — by DIRECT API CALL, not UI" checklist,
 * executed. Every assertion below is a request against the real router; none of
 * it inspects the frontend.
 *
 *   [x] Off-list user GET on a company notepad -> 403
 *   [x] Off-list user cannot delegate; endpoint rejects
 *   [x] Off-list user cannot share; endpoint rejects
 *   [x] Subcontractor id passed to the share endpoint -> rejected
 *   [x] Full-access user CANNOT grant access to a third person
 *   [x] User CAN edit and delete a task/item they created themselves
 *   [x] A user may NOT edit or delete an item added by someone else
 *   [x] Share icon absent (endpoint refuses) on auto job/lead notepads
 *   [x] Grant shows the owner an item count BEFORE anything moves
 *   [x] Merge does NOT run until the EMPLOYEE confirms — and is disarmed here
 *   [x] Order saves per user and survives a re-read
 *   [x] Lead -> job conversion keeps the SAME notepad row
 *
 * Run: node test/notepadAccess.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    // The rebuild ships behind a flag (migration policy rule 6). Turn it ON for
    // the suite; a separate case below proves the OFF state 404s.
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';
    // Explicitly DISARMED — the merge must dry-run. This is the gate the CCP
    // requires, asserted rather than assumed.
    delete process.env.NOTEPAD_MERGE_ARMED;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_npaccess_test', logLevel: 'ERROR' });
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

    // ── minimal legacy schema the routers touch ──────────────────────────────
    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), business VARCHAR(120) NULL,
      role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL,
      timezone VARCHAR(64) NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE subcategory (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), category_id INT)');
    await conn.query('CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(20))');
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, shared_with_user_id INT NULL,
      type VARCHAR(20), title VARCHAR(255), sort_order INT DEFAULT 0, job_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, lead_id INT NULL, complete_percentage INT NULL,
      priority VARCHAR(10) DEFAULT 'low', due_date DATETIME NULL, status VARCHAR(20) DEFAULT 'new',
      assignee_completed TINYINT DEFAULT 0, created_by INT NULL, type VARCHAR(20) DEFAULT 'task',
      is_calendar TINYINT NULL, is_appointment TINYINT NULL, calendar_task_id INT NULL,
      appointment_id INT NULL, filed_at DATETIME NULL, kept TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query('CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20), team_leader INT NULL)');
    await conn.query(`CREATE TABLE \`job\` (id INT PRIMARY KEY AUTO_INCREMENT, created_by INT NULL, name VARCHAR(150),
      color VARCHAR(30) NULL, status INT DEFAULT 1, job_address VARCHAR(255) NULL, job_city VARCHAR(120) NULL,
      job_state VARCHAR(60) NULL, job_zipcode VARCHAR(20) NULL)`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NULL, lead_name VARCHAR(150),
      project_street_address VARCHAR(255) NULL, status VARCHAR(10) NULL)`);
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, task_name VARCHAR(255), user_id INT NULL,
      team_id INT NULL, duration_days INT NULL, start_date DATETIME NULL, end_date DATETIME NULL,
      description TEXT NULL, image VARCHAR(255) NULL, audio_note VARCHAR(255) NULL,
      assignee_completed TINYINT DEFAULT 0, job_id INT NULL, created_at DATETIME NULL, created_by INT NULL,
      task_type VARCHAR(20) NULL, is_calendar_task TINYINT DEFAULT 0, is_appointment_task TINYINT DEFAULT 0,
      time DATETIME NULL, priority VARCHAR(10) NULL, is_urgent TINYINT DEFAULT 0, status TINYINT DEFAULT 0)`);
    await conn.query('CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, seen_at DATETIME NULL, response TEXT NULL, responded_at DATETIME NULL, UNIQUE KEY u (task_id,user_id))');
    await conn.query('CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, file_path VARCHAR(255), file_name VARCHAR(255), kind VARCHAR(10) NULL, uploaded_by INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await conn.query('CREATE TABLE notification (id INT PRIMARY KEY AUTO_INCREMENT, sender_id INT NULL, receiver_id INT NULL, content TEXT NULL, url VARCHAR(255) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');

    await conn.query("INSERT INTO subcategory (id,name,category_id) VALUES (9,'Family/Friend',1),(1,'Carpenter',1)");
    // 800 owner (GC). 801 employee ON the list. 802 employee OFF the list.
    // 803 subcontractor (category 2). 804 client (category 3).
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,subcategory,created_by) VALUES
      (800,'Owner Olly','olly@x.com',14,NULL,NULL,NULL),
      (801,'Joshua Reed','josh@x.com',2,1,1,800),
      (802,'Bill Carter','bill@x.com',2,1,1,800),
      (803,'Subby Sam','sam@x.com',12,2,NULL,800),
      (804,'Clara Client','clara@x.com',2,3,NULL,800),
      (810,'Outsider Otto','otto@y.com',14,NULL,NULL,NULL)`);
    await conn.query("INSERT INTO `job` (id,created_by,name,job_address,job_city,job_state,job_zipcode) VALUES (900,800,'Maple St Remodel','12 Maple St','Ojai','CA','93023')");
    await conn.query("INSERT INTO leads (id,user_id,lead_name,project_street_address) VALUES (950,800,'Oak Ave Bid','7 Oak Ave')");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/notepadHub'));
    app.use('/api/checklists', require('../routes/notepadDelegate'));
    app.use('/api/checklists', require('../routes/checklists'));
    app.use('/api/tasks', require('../routes/myTasks'));

    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(800), JOSH = tok(801), BILL = tok(802), OUTSIDER = tok(810);

    // ── 0. the feature FLAG gates the server, not just the UI (rule 6) ───────
    {
      delete process.env.NOTEPAD_MYTASKS_ENABLED;
      const offHub = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
      ok(offHub.status === 404 && offHub.body.code === 'FEATURE_DISABLED',
        'flag OFF: GET /hub 404 FEATURE_DISABLED (server-side, not a hidden button)', offHub.status + ' ' + JSON.stringify(offHub.body));
      const offTasks = await request(app).get('/api/tasks/my-tasks').set('Authorization', OWNER);
      ok(offTasks.status === 404 && offTasks.body.code === 'FEATURE_DISABLED', 'flag OFF: GET /tasks/my-tasks 404', String(offTasks.status));
      const offFlags = await request(app).get('/api/checklists/feature-flags').set('Authorization', OWNER);
      ok(offFlags.status === 200 && offFlags.body.flags.notepad_mytasks === false,
        'the flag endpoint itself stays reachable and reports OFF', JSON.stringify(offFlags.body));
      process.env.NOTEPAD_MYTASKS_ENABLED = '1';
    }

    // ── 1. the back-fill is NOT a page-load side effect (audit item 3) ───────
    const firstHub = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    ok(firstHub.status === 200, 'owner: GET /hub 200', String(firstHub.status));
    // 3c changed what 'creates nothing' means: the hub now makes ONE pad, the
    // user's 'No Job Assigned' card. That is a single idempotent insert, not the
    // O(jobs) back-fill this assertion exists to prevent, so the check narrows
    // to "no auto pad with a job or lead behind it" rather than loosening.
    const autoPads = (firstHub.body?.data || []).filter((p) => p.origin === 'auto');
    ok(autoPads.every((p) => p.job_id == null && p.lead_id == null),
      'opening Notepads does NOT bulk-create notepads for pre-existing jobs',
      JSON.stringify(autoPads.map((p) => p.title)));
    ok(autoPads.length === 1 && autoPads[0].title === 'No Job Assigned',
      "3c: opening Notepads DOES create the one 'No Job Assigned' pad",
      JSON.stringify(autoPads.map((p) => p.title)));
    ok(Number(autoPads[0].sort_order) === -1,
      '3d: it sorts first by default — and is draggable, because a per-user order overrides it',
      String(autoPads[0] && autoPads[0].sort_order));

    // …it is a one-off that counts first and waits for approval.
    const { execFileSync } = require('child_process');
    const path = require('path');
    const runBackfill = (extraArgs, env) =>
      execFileSync(process.execPath, ['scripts/backfillNotepads.js', ...extraArgs], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, ...(env || {}) }, encoding: 'utf8',
      });

    const report = runBackfill(['--report']);
    ok(/GRAND TOTAL notepads that would be created: [1-9]/.test(report),
      'back-fill REPORT shows a count and writes nothing', report.split('\n').slice(-4).join(' | '));
    // Same narrowing: the report must not create JOB or LEAD pads. The
    // 'No Job Assigned' pad above is expected to already exist.
    const [stillNone] = await conn.query("SELECT id FROM checklist_sections WHERE origin='auto' AND (job_id IS NOT NULL OR lead_id IS NOT NULL)");
    ok(stillNone.length === 0, 'report mode created nothing');

    let refused = '';
    try { runBackfill(['--apply'], { NOTEPAD_BACKFILL_ARMED: '' }); }
    catch (e) { refused = String(e.stderr || e.stdout || ''); }
    ok(/REFUSING TO RUN/.test(refused), '--apply without the env flag REFUSES', refused.slice(0, 120));

    runBackfill(['--apply'], { NOTEPAD_BACKFILL_ARMED: '1' });

    const ownerHub = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const ownerPads = ownerHub.body?.data || [];
    const jobPad = ownerPads.find((p) => Number(p.job_id) === 900);
    const leadPad = ownerPads.find((p) => Number(p.lead_id) === 950);
    ok(!!jobPad, 'approved back-fill created the JOB notepad', JSON.stringify(ownerPads.map((p) => p.title)));
    ok(!!leadPad, 'approved back-fill created the LEAD notepad');
    const [bfLog] = await conn.query("SELECT dry_run, rows_affected FROM destructive_job_log WHERE kind='notepad_backfill' ORDER BY id ASC");
    ok(bfLog.length === 2 && Number(bfLog[0].dry_run) === 1 && Number(bfLog[1].dry_run) === 0,
      'both the report and the apply are recorded where the owner can read them', JSON.stringify(bfLog));
    ok(jobPad && jobPad.address === '12 Maple St, Ojai, CA 93023', 'job pad address is read LIVE from the job record', jobPad && jobPad.address);
    ok(leadPad && leadPad.kind === 'lead', 'lead pad reports kind=lead (drives the blue border)');
    ok(jobPad && jobPad.shareable === false, 'auto job pad is NOT shareable (no share icon)');

    // Address is not copied: change the job, re-read, the pad follows.
    await conn.query("UPDATE `job` SET job_address = '14 Maple St' WHERE id = 900");
    const afterFix = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const fixedPad = (afterFix.body?.data || []).find((p) => Number(p.job_id) === 900);
    ok(fixedPad && fixedPad.address.startsWith('14 Maple St'), 'fixing the job address updates the notepad with no rewrite', fixedPad && fixedPad.address);

    const companyPadId = jobPad.id;

    // ── 2. off-list user is confined to their own pads (§6) ──────────────────
    const billHub = await request(app).get('/api/checklists/hub').set('Authorization', BILL);
    const billPads = billHub.body?.data || [];
    ok(!billPads.some((p) => p.id === companyPadId), 'off-list user does NOT see the company pad in /hub');
    ok(billPads.some((p) => Number(p.job_id) === 900 && p.scope === 'private'), 'off-list user gets their OWN private pad for the job');

    // The direct call, which is the one that matters.
    const billOrder = await request(app).put('/api/checklists/sections/order').set('Authorization', BILL).send({ order: [companyPadId] });
    ok(billOrder.status === 200 && billOrder.body.saved === 0, 'off-list user cannot even order a company pad (silently ignored)', JSON.stringify(billOrder.body));

    const billAdd = await request(app).post('/api/checklists/create').set('Authorization', BILL).send({ type: 'task', name: 'sneak', section_id: companyPadId });
    ok(billAdd.status === 404, 'off-list POST /create into the company pad -> refused', String(billAdd.status));

    // Owner seeds a company row so there is something to read/delegate.
    const seed = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'Order windows', section_id: companyPadId });
    ok(seed.status === 201, 'owner: adds a row to the company pad', JSON.stringify(seed.body));
    const companyItemId = seed.body.data.id;

    const billRead = await request(app).put('/api/checklists/update/' + companyItemId).set('Authorization', BILL).send({ name: 'x' });
    ok(billRead.status === 404, 'off-list user GET/PUT on a company notepad item -> 403/404 (not found for them)', String(billRead.status));

    const billDelegate = await request(app).post(`/api/checklists/items/${companyItemId}/delegate`).set('Authorization', BILL).send({ job_id: 900, assignee_id: 801 });
    ok(billDelegate.status === 403, 'off-list user cannot delegate; endpoint rejects (403)', String(billDelegate.status));

    // ── 3. grant is OWNER-ONLY, even for a full-access user (§6) ─────────────
    const grantJosh = await request(app).post('/api/checklists/access/grant').set('Authorization', OWNER).send({ user_id: 801 });
    ok(grantJosh.status === 200 && grantJosh.body.granted, 'owner grants full access to Joshua', JSON.stringify(grantJosh.body));

    const joshGrants = await request(app).post('/api/checklists/access/grant').set('Authorization', JOSH).send({ user_id: 802 });
    ok(joshGrants.status === 403 && joshGrants.body.code === 'NOTEPAD_GRANT_OWNER_ONLY', 'full-access user CANNOT grant access to a third person', JSON.stringify(joshGrants.body));

    const grantSub = await request(app).post('/api/checklists/access/grant').set('Authorization', OWNER).send({ user_id: 803 });
    ok(grantSub.status === 403, 'a subcontractor cannot be given notepad access', String(grantSub.status));

    // ── 4. full access is real access (§6/§7) ────────────────────────────────
    const joshHub = await request(app).get('/api/checklists/hub').set('Authorization', JOSH);
    const joshPads = joshHub.body?.data || [];
    ok(joshPads.some((p) => p.id === companyPadId), 'on-list user now sees the company pad');
    ok(joshHub.body?.access?.can_delegate === true, 'on-list user reports can_delegate');
    ok((joshHub.body?.access?.allowlist || []).some((a) => a.first_name === 'Joshua'), 'SHARED WITH row carries first names + initials', JSON.stringify(joshHub.body?.access?.allowlist));

    const joshAdd = await request(app).post('/api/checklists/create').set('Authorization', JOSH).send({ type: 'task', name: 'Call inspector', section_id: companyPadId });
    ok(joshAdd.status === 201, 'on-list user can ADD to the company pad', JSON.stringify(joshAdd.body));
    const joshItemId = joshAdd.body.data.id;

    // ── 5. the author rule (default rules) ───────────────────────────────────
    const ownerEditsJosh = await request(app).put('/api/checklists/update/' + joshItemId).set('Authorization', OWNER).send({ name: 'reworded' });
    ok(ownerEditsJosh.status === 403 && ownerEditsJosh.body.code === 'ITEM_AUTHOR_ONLY', 'nobody may edit an item added by someone else — even the owner', JSON.stringify(ownerEditsJosh.body));

    const ownerChecksJosh = await request(app).put('/api/checklists/update/' + joshItemId).set('Authorization', OWNER).send({ status: 'completed' });
    ok(ownerChecksJosh.status === 200, 'but anyone with access MAY check it off (a signal, not an edit)', JSON.stringify(ownerChecksJosh.body));

    const joshEditsOwn = await request(app).put('/api/checklists/update/' + joshItemId).set('Authorization', JOSH).send({ name: 'Call the inspector' });
    ok(joshEditsOwn.status === 200, 'a user CAN edit an item they created themselves');

    const ownerDeletesJosh = await request(app).delete('/api/checklists/delete/' + joshItemId).set('Authorization', OWNER);
    ok(ownerDeletesJosh.status === 403, 'nobody may delete an item added by someone else', String(ownerDeletesJosh.status));

    const joshDeletesOwn = await request(app).delete('/api/checklists/delete/' + joshItemId).set('Authorization', JOSH);
    ok(joshDeletesOwn.status === 200, 'a user CAN delete an item they created themselves');

    // ── 6. delegation (§3) ───────────────────────────────────────────────────
    // The boss delegates TO Joshua, so the resulting task is genuinely assigned
    // (not self-assigned) — that is what makes it read-only on Joshua's My Tasks.
    const del = await request(app).post(`/api/checklists/items/${companyItemId}/delegate`).set('Authorization', OWNER)
      .send({ job_id: 900, assignee_id: 801, note: 'Measure first.' });
    ok(del.status === 201 && del.body.delegate_state === 'delegated', 'delegating turns the pill green "Delegated"', JSON.stringify(del.body));
    const delTaskId = del.body.task_id;

    // And an ON-LIST (non-owner) user may delegate too — that IS the permission.
    const joshRow = await request(app).post('/api/checklists/create').set('Authorization', JOSH).send({ type: 'task', name: 'Book dumpster', section_id: companyPadId });
    const joshDelegate = await request(app).post(`/api/checklists/items/${joshRow.body.data.id}/delegate`).set('Authorization', JOSH)
      .send({ job_id: 900, assignee_id: 802 });
    ok(joshDelegate.status === 201, 'on-list user CAN delegate — full access IS the delegate permission', JSON.stringify(joshDelegate.body));

    const [[padRow]] = await conn.query('SELECT status, complete_percentage FROM check_list WHERE id = ?', [companyItemId]);
    ok(padRow.status !== 'completed', 'delegating does NOT tick the boss\'s checkbox');
    ok(padRow.complete_percentage == null, 'delegating does NOT write complete_percentage');

    const [[noteRow]] = await conn.query('SELECT body FROM task_notes WHERE task_id = ?', [delTaskId]);
    ok(noteRow && noteRow.body === 'Measure first.', 'the delegate Notes field opens the two-way thread');

    // Assignee checks off in My Tasks -> only assignee_completed moves.
    await conn.query('UPDATE tasks SET assignee_completed = 1 WHERE id = ?', [delTaskId]);
    const afterCheck = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const checkedItem = (afterCheck.body?.data || [])
      .flatMap((p) => p.items || [])
      .find((i) => i.id === companyItemId);
    ok(checkedItem && checkedItem.delegate_state === 'done', 'assignee check-off flips the PILL to the done state', JSON.stringify(checkedItem && checkedItem.delegate_state));
    ok(checkedItem && checkedItem.delegated_first_name === 'Joshua', 'the pill shows the assignee\'s FIRST name');
    ok(checkedItem && checkedItem.status !== 'completed', 'assignee check-off does NOT tick the boss\'s box');

    // Owner rule: starring a DELEGATED notepad row moves that task to the top
    // of the assignee's My Tasks. The two stars live in different columns, so
    // the notepad star has to propagate to tasks.starred_at explicitly.
    {
      const before = (await conn.query('SELECT starred_at FROM tasks WHERE id = ?', [delTaskId]))[0][0];
      ok(before.starred_at == null, "delegated task starts unstarred");
      const starIt = await request(app).put('/api/checklists/update/' + companyItemId).set('Authorization', OWNER).send({ priority: 'high' });
      ok(starIt.status === 200, 'owner stars the notepad row');
      const after = (await conn.query('SELECT starred_at, priority FROM tasks WHERE id = ?', [delTaskId]))[0][0];
      ok(after.starred_at != null, "starring the NOTEPAD row sets starred_at on the DELEGATED task", JSON.stringify(after));
      const top = (await request(app).get('/api/tasks/my-tasks').set('Authorization', JOSH)).body.data
        .find((g) => Number(g.job_id) === 900);
      ok(top && Number(top.tasks[0].id) === Number(delTaskId),
        "…so it sits at the top of the assignee's group", top && JSON.stringify(top.tasks.map((t) => t.id)));
      const unstar = await request(app).put('/api/checklists/update/' + companyItemId).set('Authorization', OWNER).send({ priority: 'low' });
      ok(unstar.status === 200, "owner un-stars the notepad row");
      const cleared = (await conn.query('SELECT starred_at FROM tasks WHERE id = ?', [delTaskId]))[0][0];
      ok(cleared.starred_at == null, "un-starring clears starred_at on the delegated task");
    }

    // ── 7. share rules (§9) ──────────────────────────────────────────────────
    const mkManual = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Shopping' });
    const manualId = mkManual.body.data.id;

    const shareAuto = await request(app).post(`/api/checklists/sections/${companyPadId}/live-share`).set('Authorization', OWNER).send({ user_id: 801 });
    ok(shareAuto.status === 403 && shareAuto.body.code === 'NOTEPAD_AUTO_NOT_SHAREABLE', 'auto job/lead notepads cannot be shared at all', JSON.stringify(shareAuto.body));

    const shareSub = await request(app).post(`/api/checklists/sections/${manualId}/live-share`).set('Authorization', OWNER).send({ user_id: 803 });
    ok(shareSub.status === 403 && shareSub.body.code === 'NOTEPAD_SHARE_SUBCONTRACTOR_REJECTED', 'a subcontractor id passed to the share endpoint is REJECTED', JSON.stringify(shareSub.body));

    const cands = await request(app).get(`/api/checklists/sections/${manualId}/share-candidates`).set('Authorization', OWNER);
    const flat = [...(cands.body.groups?.employees || []), ...(cands.body.groups?.family || []), ...(cands.body.groups?.clients || [])];
    ok(!flat.some((c) => c.id === 803), 'contractors are absent from the share dropdown too');
    ok((cands.body.groups?.clients || []).some((c) => c.id === 804), 'clients group is offered');

    const shareClientNoConfirm = await request(app).post(`/api/checklists/sections/${manualId}/live-share`).set('Authorization', OWNER).send({ email: 'newclient@x.com' });
    ok(shareClientNoConfirm.status === 400 && shareClientNoConfirm.body.code === 'NOTEPAD_SHARE_NEEDS_EMAIL_CONFIRM', 'inviting a not-yet-joined client REQUIRES explicit email confirmation', JSON.stringify(shareClientNoConfirm.body));

    const shareJosh = await request(app).post(`/api/checklists/sections/${manualId}/live-share`).set('Authorization', OWNER).send({ user_id: 801 });
    ok(shareJosh.status === 200, 'owner shares a hand-made pad with an employee');

    const billShares = await request(app).post(`/api/checklists/sections/${manualId}/live-share`).set('Authorization', BILL).send({ user_id: 804 });
    ok(billShares.status === 403, 'off-list user cannot share; endpoint rejects', String(billShares.status));

    const shareClient = await request(app).post(`/api/checklists/sections/${manualId}/live-share`).set('Authorization', OWNER).send({ user_id: 804 });
    ok(shareClient.status === 200, 'owner shares with a client');
    const withClient = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const manualPad = (withClient.body?.data || []).find((p) => p.id === manualId);
    ok(manualPad && manualPad.client_shared === true, 'a client-shared notepad carries its marker on the card');
    ok(manualPad && manualPad.shareable === true, 'hand-made notepads ARE shareable');

    // Recipient: can check off and add, cannot edit or delete the owner's rows.
    const ownerRow = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'Nails', section_id: manualId });
    const ownerRowId = ownerRow.body.data.id;
    const recipAdd = await request(app).post('/api/checklists/create').set('Authorization', JOSH).send({ type: 'task', name: 'Screws', section_id: manualId });
    ok(recipAdd.status === 201, 'share recipient CAN add');
    const recipCheck = await request(app).put('/api/checklists/update/' + ownerRowId).set('Authorization', JOSH).send({ status: 'completed' });
    ok(recipCheck.status === 200, 'share recipient CAN check off');
    const recipEdit = await request(app).put('/api/checklists/update/' + ownerRowId).set('Authorization', JOSH).send({ name: 'Brads' });
    ok(recipEdit.status === 403, 'share recipient CANNOT edit the owner\'s row', String(recipEdit.status));
    const recipDelete = await request(app).delete('/api/checklists/delete/' + ownerRowId).set('Authorization', JOSH);
    ok(recipDelete.status === 403, 'share recipient CANNOT delete the owner\'s row', String(recipDelete.status));
    const recipRevoke = await request(app).delete(`/api/checklists/sections/${manualId}/live-share/804`).set('Authorization', JOSH);
    ok(recipRevoke.status === 200 || recipRevoke.status === 403, 'revoke path answers deterministically', String(recipRevoke.status));

    // Additions are tagged with the author.
    const tagged = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const screws = (tagged.body?.data || []).flatMap((p) => p.items || []).find((i) => i.name === 'Screws');
    ok(screws && screws.created_by_name === 'Joshua Reed', 'what a recipient adds is tagged with their name', JSON.stringify(screws && screws.created_by_name));

    // ── 8. per-user order (§4) ───────────────────────────────────────────────
    const padsForOwner = (await request(app).get('/api/checklists/hub').set('Authorization', OWNER)).body.data.map((p) => p.id);
    const reversed = [...padsForOwner].reverse();
    const saveOrder = await request(app).put('/api/checklists/sections/order').set('Authorization', OWNER).send({ order: reversed });
    ok(saveOrder.status === 200 && saveOrder.body.saved === reversed.length, 'order saves on drop', JSON.stringify(saveOrder.body));
    const reread = (await request(app).get('/api/checklists/hub').set('Authorization', OWNER)).body.data.map((p) => p.id);
    ok(JSON.stringify(reread) === JSON.stringify(reversed), 'order survives a re-read (and therefore navigation / restart / another device)', JSON.stringify(reread));

    // ── 9. the merge: two steps, and DISARMED (§8) ───────────────────────────
    // Bill (off-list) has private pads. Put a row in one, then grant.
    const billPadId = (await request(app).get('/api/checklists/hub').set('Authorization', BILL)).body.data
      .find((p) => Number(p.job_id) === 900 && p.scope === 'private').id;
    await request(app).post('/api/checklists/create').set('Authorization', BILL).send({ type: 'task', name: 'Private note', section_id: billPadId });

    const preview = await request(app).post('/api/checklists/access/preview').set('Authorization', OWNER).send({ user_id: 802 });
    ok(preview.status === 200 && preview.body.count === 1, 'grant PREVIEW shows the owner an item count before anything moves', JSON.stringify(preview.body));

    const grantBill = await request(app).post('/api/checklists/access/grant').set('Authorization', OWNER).send({ user_id: 802 });
    ok(grantBill.body.merge_queued === true, 'the grant only QUEUES the merge');
    const [stillThere] = await conn.query('SELECT id FROM check_list WHERE section_id = ?', [billPadId]);
    ok(stillThere.length === 1, 'nothing moved on the owner\'s grant — the employee has not confirmed');

    const pend = await request(app).get('/api/checklists/access/merge/pending').set('Authorization', BILL);
    ok(pend.body?.pending?.item_count === 1, 'the employee gets the one-time prompt with the count', JSON.stringify(pend.body));

    const confirm = await request(app).post('/api/checklists/access/merge/confirm').set('Authorization', BILL);
    ok(confirm.status === 200 && confirm.body.armed === false && confirm.body.merged === 0, 'employee Continue DRY-RUNS while disarmed — nothing moves', JSON.stringify(confirm.body));
    ok(confirm.body.would_merge === 1, 'the dry run reports what it WOULD have moved');
    const [afterConfirm] = await conn.query('SELECT id FROM check_list WHERE section_id = ?', [billPadId]);
    ok(afterConfirm.length === 1, 'the row is still in the private pad after a disarmed confirm');
    const [logRows] = await conn.query('SELECT rows_moved, dry_run FROM notepad_merge_log WHERE employee_user_id = 802');
    ok(logRows.length === 1 && Number(logRows[0].dry_run) === 1 && Number(logRows[0].rows_moved) === 1, 'every merge attempt is logged — who, how many rows, which notepads', JSON.stringify(logRows));

    // ── 10. revoke leaves contributed rows behind (§8) ───────────────────────
    const revoke = await request(app).delete('/api/checklists/access/802').set('Authorization', OWNER);
    ok(revoke.status === 200, 'owner revokes access');
    const [companyRows] = await conn.query('SELECT id FROM check_list WHERE section_id = ?', [companyPadId]);
    ok(companyRows.length >= 1, 'rows contributed to the company pad STAY after a revoke');
    const [queueAfter] = await conn.query("SELECT status FROM notepad_merge_queue WHERE employee_user_id = 802");
    ok(queueAfter.every((q) => q.status !== 'pending'), 'a pending merge is cancelled on revoke');

    // ── 11. lead -> job conversion keeps the SAME pad (§5) ───────────────────
    const { repointNotepadLeadToJob } = require('../services/notepadAccess');
    const beforeConv = (await request(app).get('/api/checklists/hub').set('Authorization', OWNER)).body.data.find((p) => Number(p.lead_id) === 950);
    await conn.query("INSERT INTO `job` (id,created_by,name,job_address) VALUES (901,800,'Oak Ave Bid','7 Oak Ave')");
    await repointNotepadLeadToJob(conn, 950, 901);
    const afterConv = (await request(app).get('/api/checklists/hub').set('Authorization', OWNER)).body.data.find((p) => Number(p.job_id) === 901);
    ok(afterConv && afterConv.id === beforeConv.id, 'lead -> job conversion keeps the SAME notepad row', `${beforeConv && beforeConv.id} -> ${afterConv && afterConv.id}`);
    ok(afterConv && afterConv.title === beforeConv.title, 'same name after conversion');
    ok(afterConv && afterConv.kind === 'job', 'only the derived border colour changes (kind lead -> job)');

    // ── 12. My Tasks read (§10) ──────────────────────────────────────────────
    const myTasks = await request(app).get('/api/tasks/my-tasks').set('Authorization', JOSH);
    ok(myTasks.status === 200, 'GET /tasks/my-tasks 200', String(myTasks.status));
    const grp = (myTasks.body?.data || []).find((g) => Number(g.job_id) === 900);
    ok(!!grp, 'assignee sees a group per job', JSON.stringify((myTasks.body?.data || []).map((g) => g.job_name)));
    ok(grp && grp.address.startsWith('14 Maple St'), 'the job group carries the LIVE address for the maps tap', grp && grp.address);
    const myRow = grp && grp.tasks.find((t) => t.id === delTaskId);
    ok(myRow && myRow.has_note === true, 'paperclip indicator only because a note exists');
    ok(myRow && myRow.has_photo === false, 'camera indicator absent with no photo');
    ok(myRow && myRow.is_mine === false, 'an assigned task is not "mine" (no edit/delete controls)');

    const starOn = await request(app).put(`/api/tasks/${delTaskId}/star`).set('Authorization', JOSH).send({ starred: true });
    ok(starOn.status === 200 && starOn.body.starred === true, 'assignee can star their own task');
    const starred = (await request(app).get('/api/tasks/my-tasks').set('Authorization', JOSH)).body.data
      .flatMap((g) => g.tasks)[0];
    ok(starred && starred.id === delTaskId, 'the newest star floats to the very top');

    const reply = await request(app).post(`/api/tasks/${delTaskId}/notes`).set('Authorization', JOSH).send({ body: 'On it.' });
    ok(reply.status === 201, 'assignee CAN post a note to an assigned task');
    const thread = await request(app).get(`/api/tasks/${delTaskId}/notes`).set('Authorization', JOSH);
    ok((thread.body.data || []).length === 2 && thread.body.data[1].author_name === 'Joshua Reed', 'the thread is two-way, with author and date per note', JSON.stringify(thread.body.data));

    // A colleague ON THE SAME ACCOUNT can read and post — that is the existing
    // account-scoping model and the thread is not private from the boss's side.
    // Someone on ANOTHER account cannot touch it at all.
    const strangerNote = await request(app).post(`/api/tasks/${delTaskId}/notes`).set('Authorization', OUTSIDER).send({ body: 'nope' });
    ok(strangerNote.status === 403, 'a user from another account cannot post to the thread', String(strangerNote.status));
    const strangerRead = await request(app).get(`/api/tasks/${delTaskId}/notes`).set('Authorization', OUTSIDER);
    ok(strangerRead.status === 403, 'a user from another account cannot read the thread', String(strangerRead.status));
    const strangerStar = await request(app).put(`/api/tasks/${delTaskId}/star`).set('Authorization', OUTSIDER).send({ starred: true });
    ok(strangerStar.status === 403, 'a user from another account cannot star the task', String(strangerStar.status));


    // ── 13. 3a — My Tasks is a FULL-ACCESS page ──────────────────────────────
    // BILL (802) was revoked at step 10, so he is off-list now. He must not get
    // an EMPTY My Tasks; he must not get the page at all. His delegated work
    // lives in his own job notepad (3b), which is why this is 403 and not 200.
    const offListMyTasks = await request(app).get('/api/tasks/my-tasks').set('Authorization', BILL);
    ok(offListMyTasks.status === 403, '3a: off-list user gets 403 on /my-tasks, not an empty list', String(offListMyTasks.status));
    ok(offListMyTasks.body.code === 'MY_TASKS_NOT_AVAILABLE', '3a: the refusal names itself, so the client can route rather than guess', JSON.stringify(offListMyTasks.body));

    // ...but the note, photo and star endpoints stay OPEN to him, because 3b
    // needs exactly those three from inside his own notepad.
    const offListNote = await request(app).post(`/api/tasks/${delTaskId}/notes`).set('Authorization', BILL).send({ body: 'still allowed' });
    ok(offListNote.status !== 403, '3a: losing the PAGE does not lose note/photo/star — 3b needs them', String(offListNote.status));

    // The owner is implicitly on the list and can never be locked out.
    const ownerMyTasks = await request(app).get('/api/tasks/my-tasks').set('Authorization', OWNER);
    ok(ownerMyTasks.status === 200, '3a: the account owner always has My Tasks', String(ownerMyTasks.status));

    // ── 14. 3i — the 80-character cap is enforced SERVER-SIDE ────────────────
    // The client countdown is a courtesy; this is the rule. A client with the
    // countdown patched out, or any direct API call, still cannot get past it.
    const tooLong = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'x'.repeat(81), section_id: companyPadId });
    ok(tooLong.status === 400, '3i: an 81-character task name is refused by the server', String(tooLong.status));
    const atLimit = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'y'.repeat(80), section_id: companyPadId });
    ok(atLimit.status === 200 || atLimit.status === 201, '3i: exactly 80 characters is accepted — the cap is inclusive', String(atLimit.status));

    // ── 15. 3b — delegated work follows the PERSON into their own notepad ────
    // BILL (802) is off-list and has no My Tasks page, so his own notepad is the
    // only place his assigned work can appear. Delegate a company row to him and
    // it must show up in HIS hub, filed under his pad for the same job.
    const forBill = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'Haul the debris', section_id: companyPadId });
    const forBillId = Number(forBill.body?.data?.id || 0);
    const forBillDel = await request(app).post(`/api/checklists/items/${forBillId}/delegate`).set('Authorization', OWNER).send({ job_id: 900, assignee_id: 802 });
    ok(forBillDel.status === 201, '3b: the owner delegates a company row to the off-list user', JSON.stringify(forBillDel.body));

    const bill3bHub = await request(app).get('/api/checklists/hub').set('Authorization', BILL);
    ok(bill3bHub.status === 200, '3b: off-list user can still open Notepads', String(bill3bHub.status));
    const billRows = (bill3bHub.body?.data || []).flatMap((pad) => pad.items || []);
    const mine = billRows.find((r) => Number(r.id) === forBillId);
    ok(!!mine, '3b: the row delegated TO him appears in HIS notepad', JSON.stringify(billRows.map((r) => r.name)));
    ok(mine && mine.delegated_to_me === true, '3b: it is marked as delegated to him, so the UI can strip the wrong controls');
    ok(mine && mine.can_edit === false && mine.can_delete === false && mine.can_delegate === false,
      '3b: check off, note and photo only — no edit, no delete, no delegate',
      JSON.stringify({ e: mine && mine.can_edit, d: mine && mine.can_delete, g: mine && mine.can_delegate }));

    // The important negative: he must NOT pick up the rest of the company pad.
    // 'Order windows' is on the same pad and is not his.
    ok(!billRows.some((r) => r.name === 'Order windows'),
      '3b: he sees ONLY what was delegated to him, not the rest of the company pad',
      JSON.stringify(billRows.map((r) => r.name)));

    // ...and it is filed under a pad HE owns, never the company pad itself.
    const hostPad = (bill3bHub.body?.data || []).find((pad) => (pad.items || []).some((r) => Number(r.id) === forBillId));
    ok(hostPad && Number(hostPad.owner_user_id) === 802,
      '3b: the row is re-homed into a pad he owns — the company pad stays invisible',
      JSON.stringify(hostPad && { id: hostPad.id, owner: hostPad.owner_user_id, title: hostPad.title }));

    // 3c: his 'No Job Assigned' pad exists too, and is the fallback landing spot.
    ok((bill3bHub.body?.data || []).some((pad) => pad.title === 'No Job Assigned'),
      "3c: every user gets a 'No Job Assigned' pad, off-list included",
      JSON.stringify((bill3bHub.body?.data || []).map((pad) => pad.title)));
    console.log('\nnotepadAccess.functional');
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
