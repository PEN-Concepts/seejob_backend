/* Notepad single-owner — synthetic-data functional test (real local MySQL via
 * mysql-memory-server + supertest). Proves the collaborative model is GONE:
 *   - a second account CANNOT view / add / edit / check / delete another user's
 *     Notepad section or items (via sections-with-items, list, update, status-
 *     update, delete, or create-into-someone-else's-section);
 *   - even a legacy shared_with_user_id row grants NO access (single-owner ignores it);
 *   - the "shopping" list type is retired (create rejected; default seed is task-only);
 *   - the owner can still fully manage their own Notepad.
 * getAccessMode is stubbed to 'paid' so the test targets the access SQL, not billing.
 * Run: node test/notepadSingleOwner.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_notepad_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');

    // Stub billing so getChecklistAccess grants read+write (canWrite) — patch BEFORE
    // requiring the router, which destructures getAccessMode at load time.
    const accessMod = require('../utils/access');
    accessMod.getAccessMode = async () => 'paid';

    conn = await pool.getConnection();
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, timezone VARCHAR(64) NULL)");
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, shared_with_user_id INT NULL,
      type VARCHAR(20), title VARCHAR(255), sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE check_list (
      id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), photo VARCHAR(255) NULL,
      assign_to INT NULL, job_id INT NULL, lead_id INT NULL, complete_percentage INT NULL,
      priority VARCHAR(10) DEFAULT 'low', due_date DATETIME NULL, status VARCHAR(20) DEFAULT 'new',
      assignee_completed TINYINT DEFAULT 0, created_by INT NULL, type VARCHAR(20) DEFAULT 'task',
      is_calendar TINYINT NULL, is_appointment TINYINT NULL, calendar_task_id INT NULL,
      appointment_id INT NULL, filed_at DATETIME NULL, kept TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), color VARCHAR(30) NULL, status INT DEFAULT 1)");
    await conn.query("INSERT INTO `user` (id,name,email,role) VALUES (700,'Owner Olly','olly@x.com',14),(701,'Other Ollie','ollie@x.com',14)");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/checklists', require('../routes/checklists'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const OWNER = tok(700), OTHER = tok(701);

    // ---- Owner sets up a Notepad page + item ----
    const mk = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'task', title: 'Bid Lynes' });
    ok(mk.status === 201 && mk.body?.data?.id, 'owner: create section (201)', JSON.stringify(mk.body));
    const secId = mk.body.data.id;
    ok(mk.body.data.shared_with_user_id === null, 'create section: shared_with is forced NULL (no share)', JSON.stringify(mk.body.data));

    const it = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'task', name: 'HVAC', section_id: secId });
    ok(it.status === 201 && it.body?.data?.id, 'owner: create item (201)', JSON.stringify(it.body));
    const itemId = it.body.data.id;

    const ownerView = await request(app).get('/api/checklists/sections-with-items').set('Authorization', OWNER);
    const ownerSecs = ownerView.body?.data || [];
    ok(ownerSecs.some((s) => s.id === secId && (s.items || []).some((i) => i.id === itemId)), 'owner: sees own section + item', JSON.stringify(ownerSecs.map(s=>s.title)));

    // ===== SECOND ACCOUNT — must have ZERO access =====
    const otherView = await request(app).get('/api/checklists/sections-with-items').set('Authorization', OTHER);
    const otherSecs = otherView.body?.data || [];
    ok(!otherSecs.some((s) => s.id === secId), 'other: does NOT see owner\'s section in sections-with-items', JSON.stringify(otherSecs.map(s=>s.title)));
    ok(!otherSecs.some((s) => (s.items || []).some((i) => i.id === itemId)), 'other: does NOT see owner\'s item');

    const otherList = await request(app).get('/api/checklists/list').set('Authorization', OTHER);
    ok(!(otherList.body?.data || []).some((i) => i.id === itemId), 'other: /list does NOT include owner\'s item');

    const upd = await request(app).put('/api/checklists/update/' + itemId).set('Authorization', OTHER).send({ name: 'HACKED' });
    ok(upd.status === 404, 'other: cannot edit owner\'s item (404)', String(upd.status));

    const su = await request(app).put('/api/checklists/status-update').set('Authorization', OTHER).send({ ids: [itemId], status: 'completed' });
    ok(su.status === 200 && su.body?.data?.affectedRows === 0, 'other: cannot check owner\'s item (affectedRows 0)', JSON.stringify(su.body));

    const del = await request(app).delete('/api/checklists/delete/' + itemId).set('Authorization', OTHER);
    ok(del.status === 404, 'other: cannot delete owner\'s item (404)', String(del.status));

    const addTo = await request(app).post('/api/checklists/create').set('Authorization', OTHER).send({ type: 'task', name: 'sneaky', section_id: secId });
    ok(addTo.status === 404, 'other: cannot add an item into owner\'s section (404)', String(addTo.status));

    // ===== LEGACY SHARE ROW must grant nothing =====
    await conn.query('UPDATE checklist_sections SET shared_with_user_id = 701 WHERE id = ?', [secId]);
    const sharedView = await request(app).get('/api/checklists/sections-with-items').set('Authorization', OTHER);
    ok(!(sharedView.body?.data || []).some((s) => s.id === secId), 'legacy shared_with row: still NOT visible to the "shared" user (single-owner ignores it)');
    const updShared = await request(app).put('/api/checklists/update/' + itemId).set('Authorization', OTHER).send({ name: 'HACKED2' });
    ok(updShared.status === 404, 'legacy shared_with row: still cannot edit (404)', String(updShared.status));

    // ===== SHOPPING type retired =====
    const shopSec = await request(app).post('/api/checklists/sections').set('Authorization', OWNER).send({ type: 'shopping', title: 'Groceries' });
    ok(shopSec.status === 400, 'shopping section create rejected (400)', String(shopSec.status));
    const shopItem = await request(app).post('/api/checklists/create').set('Authorization', OWNER).send({ type: 'shopping', name: 'milk' });
    ok(shopItem.status === 400, 'shopping item create rejected (400)', String(shopItem.status));
    // default seed is task-only
    await conn.query('DELETE FROM checklist_sections WHERE owner_user_id = 701');
    const freshOther = await request(app).get('/api/checklists/sections-with-items').set('Authorization', OTHER);
    const seeded = freshOther.body?.data || [];
    ok(seeded.length === 1 && seeded[0].type === 'task' && seeded[0].title === 'My Notepad', 'default seed is a single task-type "My Notepad" (no shopping)', JSON.stringify(seeded.map(s=>({t:s.type,ti:s.title}))));

    // ===== OWNER still fully manages own =====
    const ownEdit = await request(app).put('/api/checklists/update/' + itemId).set('Authorization', OWNER).send({ name: 'HVAC unit' });
    ok(ownEdit.status === 200, 'owner: can still edit own item (200)', String(ownEdit.status));
    const ownCheck = await request(app).put('/api/checklists/status-update').set('Authorization', OWNER).send({ ids: [itemId], status: 'completed' });
    ok(ownCheck.body?.data?.affectedRows === 1, 'owner: can still check own item (affectedRows 1)', JSON.stringify(ownCheck.body));
    const ownDel = await request(app).delete('/api/checklists/delete/' + itemId).set('Authorization', OWNER);
    ok(ownDel.status === 200, 'owner: can still delete own item (200)', String(ownDel.status));

  } catch (e) {
    fail++; rec.push('  ✗ THREW: ' + e.message + '\n' + (e.stack || ''));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
    console.log('\nNotepad single-owner functional test');
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
