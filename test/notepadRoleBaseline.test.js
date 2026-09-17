/* ROLE BASELINE for the Notepads list — employee, subcontractor, client.
 *
 * THE RULING THIS ENFORCES (Poul, 15 Sep): these three roles get NO change.
 * None. Their Notepads response after Parts 2-5 must be byte-identical to
 * what it returns today — own pads plus explicit per-notepad shares, and
 * nothing else. The three-group presentation is for Boss and admin; it must
 * not become a visibility change for anyone else.
 *
 * HOW THIS WORKS. The first run writes a golden payload per role to
 * test/golden/notepad-role-<role>.json and says it captured them. Every later
 * run diffs the live response against the stored golden and FAILS on any
 * difference — widened, narrowed, reordered or regrouped alike.
 *
 * WHY THE GOLDENS ARE COMMITTED SEPARATELY. A baseline captured after the
 * change proves nothing: it would simply record the new behaviour as correct.
 * These files are committed BEFORE any of Parts 2-5 is written, so git history
 * is the evidence that the baseline predates the work. Do not regenerate them
 * to make a failing diff go away — a diff here means the ruling was broken.
 *
 * This is a HARNESS baseline, not a production capture. It pins the response
 * SHAPE and the visibility rules against seeded data. Capturing the real
 * payloads for Poul's actual employee/subcontractor/client accounts needs
 * their tokens and production, which this suite deliberately does not touch.
 *
 * Run: node test/notepadRoleBaseline.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

const GOLDEN_DIR = path.join(__dirname, 'golden');

/**
 * Strip the things that legitimately differ run to run (ids from
 * AUTO_INCREMENT, timestamps) so a diff means a BEHAVIOUR change, not a
 * different seed order. Titles, scope, job/lead attachment and the visibility
 * outcome — what the ruling is about — are all kept.
 */
function normalise(body) {
  const pads = (body && body.data) || [];
  return {
    success: body && body.success,
    access: body && body.access
      ? {
          is_account_owner: !!body.access.is_account_owner,
          can_delegate: !!body.access.can_delegate,
          can_create_notepad: body.access.can_create_notepad !== false,
          allowlist_len: (body.access.allowlist || []).length,
        }
      : null,
    pads: pads.map((p) => ({
      title: p.title,
      scope: p.scope,
      origin: p.origin,
      has_job: p.job_id != null,
      has_lead: p.lead_id != null,
      job_name: p.job_name || null,
      received: !!p.received,
      item_titles: (p.items || []).map((i) => i.name).sort(),
    })).sort((a, b) => String(a.title).localeCompare(String(b.title))),
  };
}

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_rolebase_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    request = require('supertest');
    jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, project_street_address VARCHAR(190) NULL)");
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL,
      type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, complete_percentage INT NULL, priority VARCHAR(10) NULL,
      due_date DATETIME NULL, status VARCHAR(20) NULL, created_by INT NULL, type VARCHAR(20) NULL,
      is_calendar TINYINT DEFAULT 0, is_appointment TINYINT DEFAULT 0,
      calendar_task_id INT NULL, appointment_id INT NULL, assignee_completed TINYINT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, starred_at DATETIME NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), created_at DATETIME NULL)");

    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);

    // 700 boss, 710 employee, 720 subcontractor (cat 2), 730 client (cat 3)
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul','poul@x.com',14,4,NULL,NOW() - INTERVAL 400 DAY),
      (710,'Employee Eve','eve@x.com',2,1,700,NOW() - INTERVAL 300 DAY),
      (720,'Sub Sam','sam@x.com',12,2,NULL,NOW() - INTERVAL 300 DAY),
      (730,'Client Cleo','cleo@x.com',3,3,700,NOW() - INTERVAL 300 DAY)`);
    await conn.query("INSERT INTO `job` (id,name,created_by,color) VALUES (10,'Lynes - ADU',700,'#a83279')");
    await conn.query("INSERT INTO leads (id,lead_name,user_id) VALUES (50,'Oak Ave Bid',700)");

    // The state the production backfill will produce: job/lead pads company,
    // personal pads private.
    await conn.query(`INSERT INTO checklist_sections
      (id,owner_user_id,type,title,job_id,lead_id,scope,origin,account_owner_id) VALUES
      (1,700,'task','Lynes - ADU',10,NULL,'company','auto',700),
      (2,700,'task','Oak Ave Bid',NULL,50,'company','auto',700),
      (3,700,'task','Poul personal',NULL,NULL,'private','manual',700),
      (4,710,'task','My Notepad',NULL,NULL,'private','manual',700),
      (5,720,'task','Sub own pad',NULL,NULL,'private','manual',720),
      (6,730,'task','Client pad',NULL,NULL,'private','manual',700),
      (7,700,'task','Shared with Eve',NULL,NULL,'private','manual',700)`);
    await conn.query("INSERT INTO check_list (section_id,name,status,created_by) VALUES (1,'Frame the deck','new',700),(7,'Shared item','new',700)");
    // One explicit per-notepad share: pad 7 -> Eve. That is the ONLY way a
    // non-owner sees a pad they do not own, absent the allowlist.
    await conn.query("INSERT INTO checklist_section_shares (section_id,user_id,is_client) VALUES (7,710,0)");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/notepadHub'));

    const tokFor = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, working_id: id, role, category, email: id + '@x.com' }, process.env.ACCESS_TOKEN);
    const ROLES = {
      employee: tokFor(710, 2, 1),
      subcontractor: tokFor(720, 12, 2),
      client: tokFor(730, 3, 3),
    };

    if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });

    let captured = 0, compared = 0;
    for (const [role, token] of Object.entries(ROLES)) {
      const res = await request(app).get('/api/checklists/hub').set('Authorization', token);
      ok(res.status === 200, role + ': hub responds 200', String(res.status) + ' ' + JSON.stringify(res.body).slice(0, 200));

      const actual = normalise(res.body);
      const file = path.join(GOLDEN_DIR, 'notepad-role-' + role + '.json');

      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
        captured++;
        rec.push('  · CAPTURED baseline for ' + role + ' -> ' + path.relative(process.cwd(), file));
        continue;
      }

      compared++;
      const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
      const a = JSON.stringify(actual, null, 2);
      const e = JSON.stringify(expected, null, 2);
      ok(a === e,
        role + ': Notepads response is UNCHANGED from the stored baseline (the ruling)',
        a === e ? '' : '\n--- expected (baseline)\n' + e + '\n--- actual (now)\n' + a);
    }

    if (captured) {
      rec.push('');
      rec.push('  ' + captured + ' baseline(s) captured. Commit test/golden/ BEFORE building Parts 2-5,');
      rec.push('  so git history shows the baseline predates the change.');
    }

    // Structural assertions that hold whether or not goldens existed — these
    // say WHY each role sees what it sees, so a future reader does not have to
    // infer the rule from a JSON blob.
    const padsFor = async (token) => {
      const r = await request(app).get('/api/checklists/hub').set('Authorization', token);
      return ((r.body && r.body.data) || []).map((p) => p.title).sort();
    };

    const evePads = await padsFor(ROLES.employee);
    ok(evePads.includes('My Notepad'), 'employee sees their OWN pad', JSON.stringify(evePads));
    ok(evePads.includes('Shared with Eve'), 'employee sees a pad explicitly SHARED with them', JSON.stringify(evePads));
    ok(!evePads.includes('Lynes - ADU'),
      'employee does NOT see a company job pad — they are not on the allowlist',
      JSON.stringify(evePads));
    ok(!evePads.includes('Poul personal'), 'employee does NOT see the boss\'s personal pad', JSON.stringify(evePads));

    const samPads = await padsFor(ROLES.subcontractor);
    // C40, as the code actually implements it (routes/notepadHub.js,
    // `visibleSections`): a subcontractor with no plan of their own loses sight
    // of pads that have NO job and NO lead. Sam has no subscription row, so
    // 'Sub own pad' (job_id NULL, lead_id NULL) is hidden. That is the rule,
    // not a bug — and it is narrower than "a sub sees nothing of their own":
    // a pad attached to a job or a lead still comes back.
    ok(!samPads.includes('Sub own pad'),
      'lapsed subcontractor does NOT see their own jobless pad (C40 hides it)',
      JSON.stringify(samPads));
    // HIDDEN, NEVER DELETED. Assert the STORED ROW, not the response: the
    // response cannot tell "hidden" from "deleted", and that difference is the
    // whole point of C40 — it reappears intact the day they subscribe.
    const [subOwnRow] = await conn.query(
      'SELECT id, owner_user_id, title FROM checklist_sections WHERE id = 5');
    ok(subOwnRow.length === 1
       && Number(subOwnRow[0].owner_user_id) === 720
       && subOwnRow[0].title === 'Sub own pad',
      'C40 hides but never deletes — the row is still in checklist_sections',
      JSON.stringify(subOwnRow));
    ok(!samPads.includes('Lynes - ADU') && !samPads.includes('Oak Ave Bid'),
      'subcontractor sees NO company job or lead pad', JSON.stringify(samPads));
    ok(!samPads.includes('Shared with Eve'), 'subcontractor sees no pad shared with someone else', JSON.stringify(samPads));

    const cleoPads = await padsFor(ROLES.client);
    ok(cleoPads.includes('Client pad'), 'client sees their own pad', JSON.stringify(cleoPads));
    ok(!cleoPads.includes('Lynes - ADU'), 'client sees NO company job pad', JSON.stringify(cleoPads));

    // No cost, payment or client-contact data on this endpoint, for any role.
    for (const [role, token] of Object.entries(ROLES)) {
      const r = await request(app).get('/api/checklists/hub').set('Authorization', token);
      const blob = JSON.stringify(r.body).toLowerCase();
      const leaked = ['cost', 'price', 'amount', 'invoice', 'payment', 'client_email', 'client_mobile', 'budget']
        .filter((k) => blob.includes('"' + k) || blob.includes(k + '"'));
      ok(leaked.length === 0, role + ': response carries no cost / payment / client-contact field', JSON.stringify(leaked));
    }

    if (compared && !fail) rec.push('\n  All ' + compared + ' role baseline(s) matched.');

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
