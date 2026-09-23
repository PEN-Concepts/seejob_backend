/* WHO MAY CHANGE AN APPOINTMENT — the rule that did not exist.
 *
 * Before this, both write paths were:
 *
 *     DELETE FROM appointments WHERE id = ?
 *     UPDATE appointments … WHERE id = ?
 *
 * No creator check, no account scope, nothing. ANY authenticated user could edit
 * or delete ANY appointment in the database by id, INCLUDING ONE BELONGING TO A
 * DIFFERENT COMPANY. There was no UI gap to close — there was no rule.
 *
 * Poul's ruling: the user who MADE it, and that company's account OWNER. Never
 * anyone outside the company. The third case he named — "anyone the Owner
 * authorized to act like the Owner" — has no grant behind it in the schema, so
 * services/appointmentAccess.js leaves a named seam and this file asserts that
 * an employee WITHOUT it is refused.
 *
 * Run: node test/appointmentWriteAuthz.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_apptauthz_test', logLevel: 'ERROR' });
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
    await conn.query(`CREATE TABLE appointments (
      id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL, job_id INT NULL, user_id INT NULL,
      description VARCHAR(255) NULL, subject VARCHAR(190) NULL, doa DATE NULL,
      time_of_appointment VARCHAR(20) NULL, appointment_type VARCHAR(40) NULL,
      zoom_link VARCHAR(255) NULL, created_by INT NULL, created_at DATETIME NULL,
      address VARCHAR(255) NULL, meeting_location VARCHAR(255) NULL, google_event_id VARCHAR(190) NULL,
      end_date DATE NULL, end_time VARCHAR(20) NULL, all_day TINYINT DEFAULT 0
    ) ENGINE=InnoDB`);
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, appointment_id INT NULL, name VARCHAR(190) NULL, is_appointment TINYINT DEFAULT 0)");
    await conn.query("CREATE TABLE user_google_tokens (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NULL, access_token VARCHAR(255) NULL, refresh_token VARCHAR(255) NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, is_appointment_task TINYINT DEFAULT 0)");
    await conn.query("CREATE TABLE appointment_invitations (id INT PRIMARY KEY AUTO_INCREMENT, appointment_id INT NULL)");

    /* TWO COMPANIES.
     *   Company A: owner 100, employee 101, and a CLIENT 108 + SUB 109 invited by it.
     *   Company B: owner 200, employee 201.
     * resolveAccountOwner promotes EMPLOYEES only, so 108 and 109 resolve to
     * themselves — they are separate businesses, not members of A. */
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (100,'A Owner','aowner@x.com',14,2,NULL,NOW()),
      (101,'A Employee','aemp@x.com',5,1,100,NOW()),
      (102,'A Employee Two','aemp2@x.com',5,1,100,NOW()),
      (108,'A Client','aclient@x.com',3,3,100,NOW()),
      (109,'A Sub','asub@x.com',12,2,100,NOW()),
      (200,'B Owner','bowner@x.com',14,2,NULL,NOW()),
      (201,'B Employee','bemp@x.com',5,1,200,NOW()),
      (300,'Unknown Role','weird@x.com',99,77,NULL,NOW())`);

    const mkAppt = async (id, createdBy, subject) => {
      await conn.query(
        "INSERT INTO appointments (id,created_by,subject,doa,time_of_appointment,created_at) VALUES (?,?,?,'2026-10-01','09:00:00',NOW())",
        [id, createdBy, subject]);
    };
    // Company A appointments, all MADE BY EMPLOYEE 101.
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) await mkAppt(id, 101, 'A appt ' + id);
    // Company B appointment, made by employee 201 — the cross-company target.
    await mkAppt(50, 201, 'B appt');
    // An appointment with NO identifiable author (§0b item 5 says these exist).
    await conn.query("INSERT INTO appointments (id,created_by,subject,doa,created_at) VALUES (60,NULL,'Orphan','2026-10-01',NOW())");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/invitations', require('../routes/invitations'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const del = (apptId, actor) =>
      request(app).delete(`/api/invitations/appointments/${apptId}`).set('Authorization', tok(actor));
    const put = (apptId, actor, subject) =>
      request(app).put(`/api/invitations/update_appointments/${apptId}`)
        .set('Authorization', tok(actor)).send({ subject, doa: '2026-10-02' });
    const exists = async (id) => {
      const [[r]] = await conn.query('SELECT COUNT(*) AS c FROM appointments WHERE id = ?', [id]);
      return Number(r.c) === 1;
    };
    const subjectOf = async (id) => {
      const [[r]] = await conn.query('SELECT subject FROM appointments WHERE id = ?', [id]);
      return r && r.subject;
    };

    // ══ 14. a checksum BEFORE, so "no row was modified by this work" is measured ══
    const [[before]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS("|",id,IFNULL(created_by,0),IFNULL(subject,"")))),0) AS sum FROM appointments');
    note(`appointments before: n=${before.n} checksum=${before.sum}`);

    // ══ 3. CROSS-COMPANY IS REFUSED, AND THE ROW IS UNCHANGED ══════════════
    // This is the hole. Before the fix it returned 200 and the row was gone —
    // see the non-vacuity probe in the PR, which removes the check and watches
    // this exact assertion go green the wrong way.
    const xDel = await del(50, 100);                 // A's OWNER deleting B's appointment
    ok(xDel.status === 403, 'cross-company DELETE is refused (403)', String(xDel.status));
    ok(await exists(50), 'and B\'s appointment is still there', 'row missing');
    const xPut = await put(50, 100, 'HACKED');
    ok(xPut.status === 403, 'cross-company UPDATE is refused (403)', String(xPut.status));
    ok(await subjectOf(50) === 'B appt', 'and B\'s appointment is unchanged', await subjectOf(50));

    // ══ 4. THE AUTHOR MAY EDIT AND DELETE ═════════════════════════════════
    const aPut = await put(1, 101, 'Renamed by author');
    ok(aPut.status === 200, 'the user who MADE it can edit it', String(aPut.status) + ' ' + JSON.stringify(aPut.body).slice(0, 120));
    ok(await subjectOf(1) === 'Renamed by author', 'and the stored row changed', await subjectOf(1));
    const aDel = await del(2, 101);
    ok(aDel.status === 200, 'the user who MADE it can delete it', String(aDel.status));
    ok(!(await exists(2)), 'and the row is gone', 'row still present');

    // ══ 5. THE OWNER MAY, FOR SOMEONE ELSE'S IN THEIR OWN COMPANY ═════════
    const oPut = await put(3, 100, 'Renamed by owner');
    ok(oPut.status === 200, 'the account OWNER can edit an employee\'s appointment', String(oPut.status));
    ok(await subjectOf(3) === 'Renamed by owner', 'and the stored row changed', await subjectOf(3));
    const oDel = await del(4, 100);
    ok(oDel.status === 200, 'the account OWNER can delete an employee\'s appointment', String(oDel.status));
    ok(!(await exists(4)), 'and the row is gone', 'row still present');

    // ══ 6/7. AN EMPLOYEE WITHOUT THE GRANT MAY NOT ════════════════════════
    // 102 is in the same company and did NOT make it. The "authorized like the
    // Owner" grant does not exist, so there is nothing that could permit them.
    const eDel = await del(5, 102);
    ok(eDel.status === 403, 'an employee who did not make it is REFUSED (403)', String(eDel.status));
    ok(await exists(5), 'and the row is unchanged', 'row missing');
    const ePut = await put(5, 102, 'employee edit');
    ok(ePut.status === 403, 'and cannot edit it either', String(ePut.status));
    ok(await subjectOf(5) === 'A appt 5', 'row still unchanged', await subjectOf(5));

    // ══ 8. CLIENT AND SUBCONTRACTOR MAY NOT ═══════════════════════════════
    const cDel = await del(6, 108);
    ok(cDel.status === 403, 'a CLIENT is refused (403)', String(cDel.status));
    const sDel = await del(6, 109);
    ok(sDel.status === 403, 'a SUBCONTRACTOR is refused (403)', String(sDel.status));
    ok(await exists(6), 'and the row survives both', 'row missing');

    // ══ 9. AN UNKNOWN ROLE FAILS CLOSED ═══════════════════════════════════
    // 300 has a role and category the code has never seen. A negative test
    // (!isClient) would have let this through; a positive allowlist does not.
    const uDel = await del(7, 300);
    ok(uDel.status === 403, 'an UNKNOWN role fails closed (403)', String(uDel.status));
    ok(await exists(7), 'and the row is unchanged', 'row missing');

    // ══ an appointment with NO AUTHOR is refused, not silently allowed ═════
    const orphanDel = await del(60, 100);
    ok(orphanDel.status === 403, 'an appointment with no recorded creator is refused', String(orphanDel.status));
    ok(await exists(60), 'and is NOT repaired or removed — reported, per §1', 'row missing');

    // ══ 10. EVERY REFUSAL CARRIES A REASON, DELETE INCLUDED ═══════════════
    for (const [label, res] of [['cross-company delete', xDel], ['employee delete', eDel],
                                ['client delete', cDel], ['unknown-role delete', uDel],
                                ['no-author delete', orphanDel], ['cross-company update', xPut]]) {
      const msg = String((res.body && res.body.message) || '');
      ok(msg.length > 0 && msg !== 'Forbidden',
        `${label} refusal names a reason, not a bare Forbidden`, JSON.stringify(res.body));
    }
    note('delete refusal message: ' + JSON.stringify(xDel.body && xDel.body.message));
    note('employee refusal message: ' + JSON.stringify(eDel.body && eDel.body.message));

    // ══ a missing appointment is 404, a refusal is 403 ════════════════════
    const gone = await del(9999, 100);
    ok(gone.status === 404, 'a genuinely missing appointment is 404, not 403', String(gone.status));

    // ══ 14. only the rows this test deliberately changed were touched ═════
    const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM appointments');
    ok(Number(after.n) === Number(before.n) - 2,
      'exactly the two AUTHORISED deletes landed; nothing else was removed',
      `before ${before.n} after ${after.n}`);

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (conn) conn.release();
    if (pool && pool.end) await pool.end();
    if (db && db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n'));
    console.error('HARNESS ERROR:', e && e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
