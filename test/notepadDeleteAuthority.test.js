/* Does DELETE /sections/:id let a NON-OWNER destroy a company pad's items?
 *
 * routes/checklists.js:861-862 runs two statements:
 *     DELETE FROM check_list        WHERE section_id = ?          <- not owner-scoped
 *     DELETE FROM checklist_sections WHERE id = ? AND owner_user_id = ?
 * getManageableSection admits anyone whose role is not 'share', and
 * getSectionAccess hands an allowlisted user role 'full' on a company pad
 * they do not own. If that is reachable, the items die and the pad lives.
 *
 * Assert the STORED ROWS. The response says success either way.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.NOTEPAD_MYTASKS_ENABLED = '1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_delauth_test', logLevel: 'ERROR' });
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

    // 700 boss (owns the pad), 710 admin ON the allowlist, not the owner.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul','poul@x.com',14,4,NULL,NOW() - INTERVAL 400 DAY),
      (710,'Admin Josh','josh@x.com',2,1,700,NOW())`);
    await conn.query("INSERT INTO `job` (id,name,created_by,color) VALUES (10,'Lynes - ADU',700,'#a83279')");
    // Employees inherit the OWNER's tier (resolveOwnerId), so the boss needs an
    // active subscription or canWrite gates everyone out before ownership is checked.
    await conn.query("INSERT INTO subscriptions (user_id, status) VALUES (700, 'active')");
    await conn.query(`INSERT INTO checklist_sections
      (id,owner_user_id,type,title,job_id,lead_id,scope,origin,account_owner_id) VALUES
      (1,700,'task','Lynes - ADU',10,NULL,'company','auto',700),
      (2,710,'task','Josh personal',NULL,NULL,'private','manual',700),
      (3,710,'task','Josh handed over',NULL,NULL,'company','manual',700)`);
    await conn.query("INSERT INTO check_list (section_id,name,status,created_by) VALUES (1,'Frame the deck','new',700),(1,'Pour footings','new',700)");

    // Put 710 on the allowlist so getSectionAccess hands back role 'full'.
    const { listAllowlist } = require('../services/notepadAccess');
    try {
      await conn.query("INSERT INTO notepad_access (owner_user_id, user_id, granted_by, granted_at) VALUES (700, 710, 700, NOW())");
    } catch (e) {
      const [cols] = await conn.query("SHOW COLUMNS FROM notepad_access");
      rec.push('  · notepad_access columns: ' + cols.map(c => c.Field).join(', '));
      throw e;
    }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/checklists'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const itemsNow = async () => {
      const [r] = await conn.query('SELECT id FROM check_list WHERE section_id = 1');
      return r.length;
    };
    const padExists = async () => {
      const [r] = await conn.query('SELECT id, owner_user_id FROM checklist_sections WHERE id = 1');
      return r.length ? Number(r[0].owner_user_id) : null;
    };

    ok(await itemsNow() === 2, 'precondition: pad 1 has 2 items', String(await itemsNow()));
    ok(await padExists() === 700, 'precondition: pad 1 owned by the boss', String(await padExists()));

    const res = await request(app).delete('/api/checklists/sections/1').set('Authorization', tok(710, 2, 1));
    rec.push('  · admin DELETE responded ' + res.status + ' ' + JSON.stringify(res.body));

    const itemsAfter = await itemsNow();
    const ownerAfter = await padExists();

    ok(res.status === 403,
      'a non-owner admin is REFUSED (403) when deleting a pad they do not own',
      'got ' + res.status);
    ok(itemsAfter === 2,
      'the pad still has its 2 items — a refused delete destroys nothing',
      'items left: ' + itemsAfter);
    ok(ownerAfter === 700,
      'the pad row itself is untouched',
      'owner now: ' + ownerAfter);


    // A refusal-only test would also pass if delete were broken outright.
    // These two prove the legitimate paths still work.
    await conn.query("INSERT INTO check_list (section_id,name,status,created_by) VALUES (2,'Buy screws','new',710)");
    const r2 = await request(app).delete('/api/checklists/sections/2').set('Authorization', tok(710, 2, 1));
    const [pad2] = await conn.query('SELECT id FROM checklist_sections WHERE id = 2');
    const [items2] = await conn.query('SELECT id FROM check_list WHERE section_id = 2');
    ok(r2.status === 200 && pad2.length === 0 && items2.length === 0,
      'the OWNER can still delete their own pad — row and items both gone',
      'status ' + r2.status + ', pad rows ' + pad2.length + ', item rows ' + items2.length);

    const r3 = await request(app).delete('/api/checklists/sections/3').set('Authorization', tok(700, 14, 4));
    const [pad3] = await conn.query('SELECT id FROM checklist_sections WHERE id = 3');
    ok(r3.status === 200 && pad3.length === 0,
      'the BOSS can delete a COMPANY pad owned by someone else',
      'status ' + r3.status + ', pad rows ' + pad3.length);

    const r4 = await request(app).delete('/api/checklists/sections/999').set('Authorization', tok(700, 14, 4));
    ok(r4.status === 404, 'a pad that does not exist is still 404, not 403', 'status ' + r4.status);


    // PRODUCTION-SHAPED. The Part 1 backfill flipped five real job pads from
    // private to company on 15 Sep. Before that flip an allowlisted admin held
    // no 'full' role on them and the bug was unreachable for these pads; after
    // it, all five were exposed. Mirror that exact shape: company scope, job
    // attached, owned by the boss, with items, and an allowlisted admin
    // attacking each one.
    const REAL = ['Lynes - ADU', 'Dumas', 'Mann ADU', 'Rodriguez', 'Samuel'];
    let jid = 100, sid = 100, allSafe = true, detail = [];
    for (const name of REAL) {
      await conn.query('INSERT INTO `job` (id,name,created_by,color) VALUES (?,?,700,?)', [jid, name, '#888']);
      await conn.query(
        'INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,lead_id,scope,origin,account_owner_id) VALUES (?,700,?,?,?,NULL,?,?,700)',
        [sid, 'task', name, jid, 'company', 'auto']);
      await conn.query('INSERT INTO check_list (section_id,name,status,created_by) VALUES (?,?,?,700),(?,?,?,700),(?,?,?,700)',
        [sid,'item A','new', sid,'item B','new', sid,'item C','new']);
      const rr = await request(app).delete('/api/checklists/sections/' + sid).set('Authorization', tok(710, 2, 1));
      const [left] = await conn.query('SELECT id FROM check_list WHERE section_id = ?', [sid]);
      const [padLeft] = await conn.query('SELECT id FROM checklist_sections WHERE id = ?', [sid]);
      const safe = rr.status === 403 && left.length === 3 && padLeft.length === 1;
      if (!safe) allSafe = false;
      detail.push(name + ': ' + rr.status + '/' + left.length + ' items');
      jid++; sid++;
    }
    ok(allSafe,
      'production-shaped: all five backfilled job pads refuse a non-owner admin delete with every item intact',
      detail.join(' | '));

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
