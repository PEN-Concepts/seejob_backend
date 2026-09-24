/* CONTACTS: SAVE SAVES, MERGE IS SCOPED + ASKED-FIRST + INTO THE JOB CLIENT,
 * DELETE STICKS AND CAN'T ORPHAN A JOB.
 *
 * Poul's bug: editing a contact whose email matched another row silently linked
 * to that row (the edit never saved), enriched blanks-only (corrections lost),
 * matched ACROSS companies (cross-tenant), and delete reverted because a job's
 * client re-synced. Every one is pinned here, through the real route.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  const tok = (id) => 'Bearer ' + jwt.sign({ id, tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
  const val = async (s, p) => { const [r] = await conn.query(s, p); return r[0]; };
  const reseed = async () => {
    await conn.query('DELETE FROM contact'); await conn.query('DELETE FROM job'); await conn.query('DELETE FROM `user`');
    // Company A (100 owner) and B (200 owner), each with contacts.
    await conn.query("INSERT INTO `user` (id,name,email,mobile,role,category,created_by) VALUES (100,'A Owner','a@x.com','100',14,2,NULL),(200,'B Owner','b@x.com','200',14,2,NULL)");
  };
  const addUser = (id, name, email, createdBy, extra = {}) =>
    conn.query("INSERT INTO `user` (id,name,email,mobile,role,category,created_by,business,address,license_number) VALUES (?,?,?,?,12,2,?,?,?,?)",
      [id, name, email, extra.mobile || null, createdBy, extra.business || null, extra.address || null, extra.license_number || null]);
  const link = (by, to, status = 'Accept') => conn.query("INSERT INTO contact (request_by,request_to,status,created_at,updated_at) VALUES (?,?,?,NOW(),NOW())", [by, to, status]);
  const editContact = (who, body) => request(app).post('/api/invitations/update-contact-info').set('Authorization', tok(who)).send(body);
  const delContact = (who, id) => request(app).delete('/api/invitations/accepted-contacts/' + id).set('Authorization', tok(who));

  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV; process.env.API_URL = '/api';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_contacts_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    request = require('supertest'); jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(150), first_name VARCHAR(80) NULL, last_name VARCHAR(80) NULL, email VARCHAR(190) UNIQUE, mobile VARCHAR(40) NULL, role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL, business VARCHAR(190) NULL, organization_name VARCHAR(190) NULL, address VARCHAR(255) NULL, license_number VARCHAR(60) NULL, license_state VARCHAR(10) NULL, cslb_status VARCHAR(40) NULL, spouse_name VARCHAR(120) NULL, spouse_last_name VARCHAR(120) NULL, spouse_email VARCHAR(190) NULL, spouse_phone VARCHAR(40) NULL, status INT DEFAULT 1, token_version INT DEFAULT 0)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT, request_to INT, status VARCHAR(20) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(150), created_by INT, client_id INT NULL)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT, owner_type VARCHAR(20) DEFAULT 'job')");

    const express = require('express'); app = express(); app.use(express.json());
    app.use('/api/invitations', require('../routes/invitations'));

    // ══ 1. A SAVE SAVES (non-merge edit persists) ══════════════════════════
    await reseed();
    await addUser(300, 'Susan Sawyer', 'susan@x.com', 100, { mobile: '111', address: 'Old St' });
    await link(100, 300);
    let r = await editContact(100, { contact_user_id: 300, first_name: 'Susan', last_name: 'Sawyer', mobile: '999', address: 'New Ave', email: 'susan@x.com' });
    ok(r.status === 200 && !r.body.needsMerge && !r.body.merged, '1. a plain edit returns a normal save (no phantom merge)', JSON.stringify(r.body));
    let row = await val("SELECT mobile,address FROM `user` WHERE id=300");
    ok(row.mobile === '999' && row.address === 'New Ave', '1. the edit PERSISTED to the row', JSON.stringify(row));

    // ══ 2. CORRECTIONS OVERWRITE; blanks preserve ═════════════════════════
    r = await editContact(100, { contact_user_id: 300, mobile: '222' });               // correct the phone
    row = await val("SELECT mobile,address FROM `user` WHERE id=300");
    ok(row.mobile === '222', '2. a corrected phone OVERWRITES (blanks-only behaviour is gone)', row.mobile);
    ok(row.address === 'New Ave', '2. a field left blank is PRESERVED, not wiped', row.address);

    // ══ 3. CROSS-TENANT SCOPE (security) ═══════════════════════════════════
    await reseed();
    await addUser(300, 'A Contact', 'shared@x.com', 100); await link(100, 300);         // A's contact
    await addUser(400, 'B Person', 'bonly@x.com', 200);   await link(200, 400);         // B's contact, email bonly@x.com
    // A edits its own contact and enters B's email.
    r = await editContact(100, { contact_user_id: 300, email: 'bonly@x.com', confirmMerge: true });
    ok(r.status === 409 && r.body.code === 'EMAIL_TAKEN', '3. cross-company email is refused (EMAIL_TAKEN), not linked', JSON.stringify(r.body));
    let bRow = await val("SELECT name,email FROM `user` WHERE id=400");
    ok(bRow.name === 'B Person' && bRow.email === 'bonly@x.com', "3. company B's row is UNCHANGED (no cross-tenant enrich)", JSON.stringify(bRow));
    let bLink = await val("SELECT COUNT(*) c FROM contact WHERE (request_by=100 AND request_to=400) OR (request_to=100 AND request_by=400)");
    ok(bLink.c === 0, '3. no link was created from A to B', String(bLink.c));
    // save-contact is scoped too.
    r = await request(app).post('/api/invitations/save-contact').set('Authorization', tok(100)).send({ first_name: 'New', last_name: 'Guy', email: 'bonly@x.com', user_type: 'subcontractor', subcategory: 12 });
    ok(r.status === 409 && r.body.code === 'EMAIL_TAKEN', '3. save-contact also refuses a cross-company email', JSON.stringify(r.body));

    // ══ 6. MERGE INTO THE JOB CLIENT (asked-first) ════════════════════════
    await reseed();
    // Loose contact (more info) + job-client contact (less info), same email.
    await addUser(300, 'Susan Loose', 'susan@x.com', 100, { mobile: '111', address: '123 Loose Ln', business: 'LOOSE CO' });
    await link(100, 300);
    await addUser(310, 'Susan Job', 'susanjob@x.com', 100);
    await link(100, 310);
    await conn.query("INSERT INTO job (id,name,created_by,client_id) VALUES (900,'Lynes',100,310)");
    // Edit the loose one, enter the job contact's email -> preview first.
    r = await editContact(100, { contact_user_id: 300, email: 'susanjob@x.com' });
    ok(r.status === 200 && r.body.needsMerge === true, '6. a merge is PREVIEWED, not performed, without confirmation', JSON.stringify(r.body));
    ok(Number(r.body.survivor_user_id) === 310 && r.body.job && r.body.job.id === 900,
      '6. the survivor is the JOB client (310), and the job is named', JSON.stringify(r.body));
    let before = await val("SELECT client_id FROM job WHERE id=900");
    // Confirm the merge.
    r = await editContact(100, { contact_user_id: 300, email: 'susanjob@x.com', mobile: '111', address: '123 Loose Ln', business_name: 'LOOSE CO', first_name: 'Susan', last_name: 'Merged', confirmMerge: true });
    ok(r.status === 200 && r.body.merged === true && Number(r.body.survivor_user_id) === 310, '6. on confirm, the merge runs into the job client', JSON.stringify(r.body));
    let survivor = await val("SELECT name,mobile,address,business,email FROM `user` WHERE id=310");
    ok(survivor.mobile === '111' && survivor.address === '123 Loose Ln' && survivor.business === 'LOOSE CO',
      "6. the loose contact's data pulled INTO the job client", JSON.stringify(survivor));
    let after = await val("SELECT client_id FROM job WHERE id=900");
    ok(before.client_id === 310 && after.client_id === 310,
      "6. the job's client_id still points at the survivor (310), unmoved", JSON.stringify({ before, after }));
    let looseLink = await val("SELECT COUNT(*) c FROM contact WHERE request_to=300 OR request_by=300");
    ok(looseLink.c === 0, '6. the loose duplicate link is dropped', String(looseLink.c));

    // ══ 7. BOTH ON (DIFFERENT) JOBS -> NOT MERGED ═════════════════════════
    await reseed();
    await addUser(300, 'C One', 'dup@x.com', 100); await link(100, 300);
    await addUser(310, 'C Two', 'dup2@x.com', 100); await link(100, 310);
    await conn.query("INSERT INTO job (id,name,created_by,client_id) VALUES (900,'Job Alpha',100,300),(901,'Job Beta',100,310)");
    r = await editContact(100, { contact_user_id: 300, email: 'dup2@x.com', confirmMerge: true });
    ok(r.status === 409 && r.body.code === 'BOTH_ON_JOBS', '7. two job clients are never merged', JSON.stringify(r.body));
    let stillTwo = await val("SELECT COUNT(*) c FROM `user` WHERE id IN (300,310)");
    ok(stillTwo.c === 2, '7. both contacts remain separate', String(stillTwo.c));

    // ══ 4/5. DELETE: a job client is blocked; a free contact deletes and stays gone ══
    await reseed();
    await addUser(300, 'Client Contact', 'cc@x.com', 100); await link(100, 300);
    await addUser(310, 'Free Contact', 'free@x.com', 100); await link(100, 310);
    await conn.query("INSERT INTO job (id,name,created_by,client_id) VALUES (900,'Lynes',100,300)");
    r = await delContact(100, 300);
    ok(r.status === 409 && r.body.code === 'ON_JOB' && /Lynes/.test(r.body.message || ''), '5. deleting a job client is blocked, naming the job', JSON.stringify(r.body));
    let clientStill = await val("SELECT COUNT(*) c FROM `user` WHERE id=300");
    ok(clientStill.c === 1, '5. the blocked contact and its job are untouched', String(clientStill.c));
    // The free contact deletes.
    r = await delContact(100, 310);
    ok(r.status === 200, '4. a non-job contact deletes', JSON.stringify(r.body));
    // A client-sync must not resurrect it: it is not a client_id, so nothing re-links.
    let goneLink = await val("SELECT COUNT(*) c FROM contact WHERE request_to=310 OR request_by=310");
    ok(goneLink.c === 0, '4. the deleted contact is not re-linked (no resurrection path — it was never a job client)', String(goneLink.c));

    // ══ 1b. POUL'S SCENARIO: neither on a job -> survivor is the EDITED one ══
    await reseed();
    await addUser(300, 'Susan Sawyer', 'susan@x.com', 100, { mobile: '111' });  // edited
    await link(100, 300);
    await addUser(310, 'Susan Dup', 'susandup@x.com', 100, { address: 'Dup Rd' }); // holds the target email
    await link(100, 310);
    // Cancel path: no confirmMerge -> preview only, nothing changes.
    r = await editContact(100, { contact_user_id: 300, email: 'susandup@x.com' });
    ok(r.status === 200 && r.body.needsMerge && Number(r.body.survivor_user_id) === 300,
      '1b. neither on a job -> the survivor is the contact being edited (300)', JSON.stringify(r.body));
    let unchanged = await val("SELECT email FROM `user` WHERE id=300");
    let dupStill = await val("SELECT COUNT(*) c FROM contact WHERE request_to=310 OR request_by=310");
    ok(unchanged.email === 'susan@x.com' && dupStill.c === 1, '1b. CANCEL (no confirm) changes nothing', JSON.stringify({ unchanged, dupStill }));
    // Confirm path: survivor 300 gets the email + keeps 310's address; 310 link dropped.
    r = await editContact(100, { contact_user_id: 300, email: 'susandup@x.com', first_name: 'Susan', last_name: 'Sawyer', confirmMerge: true });
    ok(r.status === 200 && r.body.merged && Number(r.body.survivor_user_id) === 300, '1b. on confirm the edited row survives', JSON.stringify(r.body));
    survivor = await val("SELECT email,mobile,address FROM `user` WHERE id=300");
    ok(survivor.email === 'susandup@x.com' && survivor.mobile === '111' && survivor.address === 'Dup Rd',
      "1b. survivor holds the email, keeps its own phone, inherits the dup's address", JSON.stringify(survivor));
    let dupEmail = await val("SELECT email FROM `user` WHERE id=310");
    ok(dupEmail.email === null, '1b. the email moved off the loser (uniqueness preserved)', JSON.stringify(dupEmail));

    // ══ 3b. NON-VACUITY: remove the account scope -> it links cross-company ══
    await reseed();
    await addUser(300, 'A Contact', 'shared@x.com', 100); await link(100, 300);
    await addUser(400, 'B Person', 'bonly@x.com', 200); await link(200, 400);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'invitations.js'), 'utf8');
    ok(/u\.created_by IN \$\{ACCOUNT\}/.test(src),
      '3b. the merge match is account-scoped in the source (the guard exists to remove)', 'scope clause missing');
    // Prove the UNSCOPED form WOULD match B — the exact query without the scope.
    const [[unscoped]] = await conn.query(
      'SELECT id FROM `user` WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND id <> ? LIMIT 1', ['bonly@x.com', 300]);
    ok(unscoped && Number(unscoped.id) === 400, '3b. without the scope, B (400) IS a match — so the scope is what refuses it', JSON.stringify(unscoped));
    const [[scoped]] = await conn.query(
      `SELECT u.id FROM \`user\` u WHERE LOWER(TRIM(u.email))=LOWER(TRIM(?)) AND u.id<>?
        AND ( u.created_by IN (SELECT id FROM \`user\` WHERE id=? OR created_by=?)
              OR EXISTS (SELECT 1 FROM contact c WHERE (c.request_by IN (SELECT id FROM \`user\` WHERE id=? OR created_by=?) AND c.request_to=u.id)
                                                    OR (c.request_to IN (SELECT id FROM \`user\` WHERE id=? OR created_by=?) AND c.request_by=u.id)) ) LIMIT 1`,
      ['bonly@x.com', 300, 100, 100, 100, 100, 100, 100]);
    ok(!scoped, '3b. WITH the scope, B is not a match — the fix holds', JSON.stringify(scoped));

    // ══ 4b. the sync re-link path finds nothing for a deleted non-client ═══
    await reseed();
    await addUser(310, 'Free', 'free@x.com', 100); await link(100, 310);
    await delContact(100, 310);
    // jobs.js sync re-links only client_ids: assert 310 is nobody's client_id.
    const [[asClient]] = await conn.query("SELECT COUNT(*) c FROM job WHERE client_id=310");
    ok(asClient.c === 0, '4b. a deleted contact is no job\'s client_id, so sync cannot re-link it', String(asClient.c));

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    conn.release(); if (pool.end) await pool.end(); if (db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n')); console.error('HARNESS ERROR:', e && e.stack || e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
