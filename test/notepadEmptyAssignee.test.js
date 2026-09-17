/* THE SERVER REFUSES AN EMPTY ASSIGNEE — CCP §2 and §3.
 *
 * The defect: POST /items/:id/delegate accepted a request with no assignee_id.
 * It created a real task, wrote the task id into check_list.delegated_task_id,
 * left delegated_to NULL, and answered delegate_state:'delegated'. The hub read
 * then derived the pill from delegated_task_id ALONE, so the row rendered green
 * and blank, permanently.
 *
 * FE #64 closed the door a user walks through. This suite is about the API,
 * which was still open: every rejection case below is a DIRECT call, with no
 * frontend involved.
 *
 * Decision recorded in the CCP: REJECT, not treat-as-unassign. DELETE
 * /items/:id/delegate already means unassign and returns 'none'.
 *
 * Every assertion about a write reads THE ROW BACK. None of them trust the
 * response body — trusting the response is precisely what hid this bug.
 *
 * Run: node test/notepadEmptyAssignee.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const head = (m) => rec.push('\n' + m);
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_emptyassignee_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');

    require('../utils/access').getAccessMode = async () => 'paid';

    conn = await pool.getConnection();

    // ── minimal legacy schema the routers touch ─────────────────────────────
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

    await conn.query("INSERT INTO subcategory (id,name,category_id) VALUES (1,'Carpenter',1)");
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,subcategory,created_by) VALUES
      (800,'Owner Olly','olly@x.com',14,NULL,NULL,NULL),
      (801,'Joshua Reed','josh@x.com',2,1,1,800),
      (802,'Bill Carter','bill@x.com',2,1,1,800),
      (806,'   ','blank@x.com',2,1,1,800)`);
    await conn.query("INSERT INTO `job` (id,created_by,name) VALUES (900,800,'Maple St Remodel')");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/notepadHub'));
    app.use('/api/checklists', require('../routes/notepadDelegate'));
    app.use('/api/checklists', require('../routes/checklists'));

    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(800);

    // A pad and some rows to work on.
    const hub0 = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
    const padId = (hub0.body?.data || []).map((p) => p.id)[0];
    if (!padId) throw new Error('no pad was auto-created; harness cannot continue');

    const newRow = async (name) => {
      const r = await request(app).post('/api/checklists/create').set('Authorization', OWNER)
        .send({ type: 'task', name, section_id: padId });
      if (r.status !== 201) throw new Error('row create failed: ' + JSON.stringify(r.body));
      return r.body.data.id;
    };

    /** Read the STORED row. Never the response. */
    const rowOf = async (id) => (await conn.query(
      'SELECT id, name, status, priority, due_date, complete_percentage, delegated_task_id, delegated_to FROM check_list WHERE id = ?',
      [id]))[0][0];

    /** Find an item in a fresh hub read, as a client would see it. */
    const hubItem = async (itemId, token) => {
      const h = await request(app).get('/api/checklists/hub').set('Authorization', token || OWNER);
      return (h.body?.data || []).flatMap((p) => p.items || []).find((i) => Number(i.id) === Number(itemId));
    };

    // ───────────────────────────────────────────────────────────────────────
    head('§2  THE SERVER REFUSES — by direct API call, no UI involved');
    // ───────────────────────────────────────────────────────────────────────
    {
      const idA = await newRow('Frame the north wall');
      const before = await rowOf(idA);

      const absent = await request(app).post(`/api/checklists/items/${idA}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900 });
      ok(absent.status === 400 && absent.body.code === 'ASSIGNEE_REQUIRED',
        'assignee_id ABSENT -> refused 400 ASSIGNEE_REQUIRED',
        absent.status + ' ' + JSON.stringify(absent.body));

      const nulled = await request(app).post(`/api/checklists/items/${idA}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: null });
      ok(nulled.status === 400 && nulled.body.code === 'ASSIGNEE_REQUIRED',
        'assignee_id NULL -> refused 400 ASSIGNEE_REQUIRED',
        nulled.status + ' ' + JSON.stringify(nulled.body));

      ok(absent.status === nulled.status && absent.body.code === nulled.body.code
        && absent.body.message === nulled.body.message,
        'IDENTICAL behaviour: absent and null give the same status, code and message',
        JSON.stringify([absent.body, nulled.body]));

      const zero = await request(app).post(`/api/checklists/items/${idA}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 0 });
      ok(zero.status === 400 && zero.body.code === 'ASSIGNEE_REQUIRED',
        'assignee_id 0 -> refused the same way (FE sends 0 for "nobody" on one path)',
        zero.status + ' ' + JSON.stringify(zero.body));

      const empty = await request(app).post(`/api/checklists/items/${idA}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: '' });
      ok(empty.status === 400 && empty.body.code === 'ASSIGNEE_REQUIRED',
        'assignee_id "" -> refused the same way', empty.status + ' ' + JSON.stringify(empty.body));

      // THE POINT OF THE WHOLE CCP: the row must be untouched.
      const after = await rowOf(idA);
      ok(JSON.stringify(before) === JSON.stringify(after),
        'after FOUR refused requests the row is BYTE-IDENTICAL to before (read from the table)',
        JSON.stringify({ before, after }));
      ok(after.delegated_task_id == null && after.delegated_to == null,
        '…specifically: no delegated_task_id, no delegated_to');

      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');
      ok(Number(n) === 0, 'and NO TASK was created by any refused request', 'tasks rows = ' + n);
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§2  AN ACCEPTED REQUEST WRITES BOTH COLUMNS — the invariant');
    // ───────────────────────────────────────────────────────────────────────
    let goodItemId, goodTaskId;
    {
      goodItemId = await newRow('Order the windows');
      const r = await request(app).post(`/api/checklists/items/${goodItemId}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 801 });
      ok(r.status === 201, 'a normal assign to a real person still works', JSON.stringify(r.body));
      goodTaskId = r.body.task_id;

      const row = await rowOf(goodItemId);
      ok(row.delegated_task_id != null && row.delegated_to != null,
        'BOTH delegated_task_id and delegated_to are set (read from the table)', JSON.stringify(row));
      ok(Number(row.delegated_to) === 801, '…and delegated_to is the person we named');
      ok(Number(row.delegated_task_id) === Number(goodTaskId), '…and delegated_task_id is the task we made');

      const [[ta]] = await conn.query('SELECT user_id FROM task_assignees WHERE task_id = ?', [goodTaskId]);
      ok(ta && Number(ta.user_id) === 801, 'the task_assignees link was written too');

      ok(r.body.delegate_state === 'delegated',
        'the response says delegated — and now it says it because the ROW says so',
        JSON.stringify(r.body));
      ok(r.body.assignee && Number(r.body.assignee.id) === 801 && r.body.assignee.first_name === 'Joshua',
        'the response carries the resolved assignee object (§3)', JSON.stringify(r.body.assignee));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§2  A PERSON WHO CANNOT BE RESOLVED -> nothing is written');
    // ───────────────────────────────────────────────────────────────────────
    {
      const idC = await newRow('Call the inspector');
      const before = await rowOf(idC);
      const [[{ n: tasksBefore }]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');

      const ghost = await request(app).post(`/api/checklists/items/${idC}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 999999 });
      ok(ghost.status === 404 && ghost.body.code === 'ASSIGNEE_NOT_FOUND',
        'an assignee id with no user row -> refused, not written',
        ghost.status + ' ' + JSON.stringify(ghost.body));

      const blank = await request(app).post(`/api/checklists/items/${idC}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 806 });
      ok(blank.status === 404 && blank.body.code === 'ASSIGNEE_NOT_FOUND',
        'a user row with a BLANK name -> also unresolvable, also refused (it is the green-and-blank row)',
        blank.status + ' ' + JSON.stringify(blank.body));

      ok(JSON.stringify(before) === JSON.stringify(await rowOf(idC)),
        'the row is unchanged after both', JSON.stringify(await rowOf(idC)));
      const [[{ n: tasksAfter }]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');
      ok(Number(tasksBefore) === Number(tasksAfter),
        'and no task was created', `${tasksBefore} -> ${tasksAfter}`);

      ok(!('delegate_state' in ghost.body) && !('delegate_state' in blank.body),
        'a refused request does NOT return delegate_state at all — it is never asserted',
        JSON.stringify([ghost.body, blank.body]));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§2  FORCED FAILURE MID-WRITE -> all or nothing');
    // ───────────────────────────────────────────────────────────────────────
    {
      const idD = await newRow('Pour the footings');
      const before = await rowOf(idD);
      const [[{ n: tasksBefore }]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');

      // Make the task INSERT fail for real, after every guard has passed, by
      // removing a column the INSERT names. This is the "force the task
      // creation to fail" case: the request is valid, the person resolves, and
      // the database refuses.
      await conn.query('ALTER TABLE tasks DROP COLUMN duration_days');
      const boom = await request(app).post(`/api/checklists/items/${idD}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 801 });
      await conn.query('ALTER TABLE tasks ADD COLUMN duration_days INT NULL');

      ok(boom.status === 500, 'the write fails loudly (500), not quietly', String(boom.status));
      ok(!('delegate_state' in boom.body) && boom.body.delegate_state !== 'delegated',
        'AND THE RESPONSE DOES NOT STILL SAY "delegated" — the old code would have',
        JSON.stringify(boom.body));

      const after = await rowOf(idD);
      ok(after.delegated_task_id == null && after.delegated_to == null,
        'NEITHER column was written — a partial failure leaves the row exactly as it was',
        JSON.stringify(after));
      ok(JSON.stringify(before) === JSON.stringify(after), 'the whole row is byte-identical');

      const [[{ n: tasksAfter }]] = await conn.query('SELECT COUNT(*) AS n FROM tasks');
      ok(Number(tasksBefore) === Number(tasksAfter),
        'and no orphan task survived the rollback', `${tasksBefore} -> ${tasksAfter}`);
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§2  DELETE still unassigns, and still says none');
    // ───────────────────────────────────────────────────────────────────────
    {
      const un = await request(app).delete(`/api/checklists/items/${goodItemId}/delegate`).set('Authorization', OWNER);
      ok(un.status === 200 && un.body.delegate_state === 'none',
        'DELETE /items/:id/delegate unassigns and returns "none"', JSON.stringify(un.body));
      const row = await rowOf(goodItemId);
      ok(row.delegated_task_id == null && row.delegated_to == null,
        'BOTH columns cleared together — the invariant holds on the clear path too', JSON.stringify(row));

      // put it back for the §3 cases below
      const re = await request(app).post(`/api/checklists/items/${goodItemId}/delegate`)
        .set('Authorization', OWNER).send({ job_id: 900, assignee_id: 801 });
      goodTaskId = re.body.task_id;
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§3  ONE RESOLVED VALUE — state, label and dialog cannot diverge');
    // ───────────────────────────────────────────────────────────────────────
    note('the one value is resolveAssignee() in services/notepadAssignee.js;');
    note('delegate_state, delegated_first_name, is_self_assigned and the');
    note('assignee object are all projections of that single call.');
    {
      const it = await hubItem(goodItemId);
      ok(it && it.delegate_state === 'delegated' && it.assignee && it.assignee.first_name === 'Joshua',
        'a healthy row: green, named, assignee object present', JSON.stringify(it && it.assignee));
      ok(it && it.delegated_first_name === it.assignee.first_name,
        'the legacy label field is now DERIVED from the same value, not read separately');

      // THE DEFECT ROW, made by hand because the API can no longer make one.
      // This is what the existing damaged rows in production look like.
      await conn.query('UPDATE check_list SET delegated_to = NULL WHERE id = ?', [goodItemId]);
      const orphan = await hubItem(goodItemId);
      ok(orphan && orphan.delegate_state === 'none',
        'a row with delegated_task_id set and delegated_to NULL renders UNASSIGNED, not green-and-blank',
        JSON.stringify(orphan && orphan.delegate_state));
      ok(orphan && orphan.assignee === null,
        '…and carries no assignee object, so the DIALOG shows "Nobody yet" — same answer as the row',
        JSON.stringify(orphan && orphan.assignee));
      ok(orphan && orphan.delegated_first_name === null,
        '…and no first name, so there is nothing to render into an empty green pill');

      // A DELETED USER: the id survives, the person does not.
      await conn.query('UPDATE check_list SET delegated_to = 802 WHERE id = ?', [goodItemId]);
      ok((await hubItem(goodItemId)).delegate_state === 'delegated', 'control: pointing at a live user is green again');
      await conn.query('DELETE FROM `user` WHERE id = 802');
      const dead = await hubItem(goodItemId);
      ok(dead && dead.delegate_state === 'none' && dead.assignee === null,
        'a row whose delegated_to points at a DELETED user also renders unassigned, in row AND dialog',
        JSON.stringify({ state: dead && dead.delegate_state, assignee: dead && dead.assignee }));

      // restore
      await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by) VALUES (802,'Bill Carter','bill@x.com',2,1,1,800)");
      await conn.query('UPDATE check_list SET delegated_to = 801 WHERE id = ?', [goodItemId]);
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§3  THE DIVERGENCE TEST — fails if the three checks come back');
    // ───────────────────────────────────────────────────────────────────────
    {
      // Sweep every row the hub returns and assert the projections agree. This
      // is the test that fails if anyone reintroduces an independent check.
      const h = await request(app).get('/api/checklists/hub').set('Authorization', OWNER);
      const all = (h.body?.data || []).flatMap((p) => p.items || []);
      ok(all.length > 0, 'the sweep has rows to check', 'rows = ' + all.length);

      const bad = all.filter((i) =>
        (i.delegate_state !== 'none' && !i.assignee) ||
        (i.assignee && i.delegated_first_name !== i.assignee.first_name) ||
        (!i.assignee && i.delegated_first_name != null) ||
        (i.is_self_assigned && !i.assignee));
      ok(bad.length === 0,
        'NO row can be non-"none" without a resolved assignee, and no label disagrees with it',
        JSON.stringify(bad.map((i) => ({ id: i.id, s: i.delegate_state, a: i.assignee, f: i.delegated_first_name }))));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('§4  NOTHING WAS REPAIRED');
    // ───────────────────────────────────────────────────────────────────────
    note('This suite writes damaged rows deliberately (above) and never repairs');
    note('one. The route contains no UPDATE that clears or backfills an existing');
    note('row; the only writes are the delegate transaction and the DELETE path.');

    // ───────────────────────────────────────────────────────────────────────
    head('NON-VACUITY — the old code must FAIL these');
    // ───────────────────────────────────────────────────────────────────────
    {
      // 1. Restore `allow(null).optional()` semantics and confirm the rejection
      //    tests were asserting something. We re-validate with the OLD schema
      //    shape and show it accepts what the new one refuses.
      const Joi = require('joi');
      const oldShape = Joi.object({
        job_id: Joi.number().integer().positive().required(),
        assignee_id: Joi.number().integer().positive().allow(null).optional(),
      }).unknown(true);
      const newShape = Joi.object({
        job_id: Joi.number().integer().positive().required(),
        assignee_id: Joi.number().integer().positive().required(),
      }).unknown(true);
      const oldAbsent = oldShape.validate({ job_id: 900 });
      const oldNull = oldShape.validate({ job_id: 900, assignee_id: null });
      ok(!oldAbsent.error && !oldNull.error,
        'with allow(null).optional() restored, BOTH payloads validate — so the rejections above are real',
        JSON.stringify([oldAbsent.error && oldAbsent.error.message, oldNull.error && oldNull.error.message]));
      ok(!!newShape.validate({ job_id: 900 }).error && !!newShape.validate({ job_id: 900, assignee_id: null }).error,
        'and with required() they do not');

      // 2. Reintroduce the OLD independent checks and confirm the §3 sweep
      //    catches it. This is the divergence the single value prevents.
      const { assignmentFields } = require('../services/notepadAssignee');
      const damaged = { delegated_task_id: 5, delegated_to: null, delegated_to_name: null, task_assignee_completed: 0 };

      const oldDelegateState = !damaged.delegated_task_id ? 'none'
        : Number(damaged.task_assignee_completed) === 1 ? 'done' : 'delegated';
      const oldFirstName = String(damaged.delegated_to_name || '').trim().split(/\s+/)[0] || '';
      ok(oldDelegateState === 'delegated' && oldFirstName === '',
        'THE OLD CODE, run on the damaged row, returns green AND blank — the bug, reproduced',
        `state=${oldDelegateState} name="${oldFirstName}"`);

      const now = assignmentFields(damaged, 800);
      ok(now.delegate_state === 'none' && now.assignee === null && now.delegated_first_name === null,
        'THE NEW CODE on the same row returns unassigned everywhere',
        JSON.stringify(now));

      // And prove the sweep predicate would have flagged the old output.
      const oldRow = { id: 1, delegate_state: oldDelegateState, assignee: null, delegated_first_name: oldFirstName, is_self_assigned: false };
      const wouldFlag = (oldRow.delegate_state !== 'none' && !oldRow.assignee);
      ok(wouldFlag, 'and the divergence sweep above WOULD have flagged that row — it is not vacuous');
    }

  } catch (err) {
    fail++;
    rec.push('  ✗ HARNESS ERROR: ' + (err && err.stack || err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
  }

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
