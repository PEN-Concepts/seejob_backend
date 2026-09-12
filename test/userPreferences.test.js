/* PER-LOGIN PREFERENCES.
 *
 * One small store for scalar preferences, scoped to user_id so a preference
 * follows the LOGIN rather than the device: set it at the desk, it is set on
 * the phone.
 *
 * The two guards are the reason this is safe to expose. Without them it is an
 * open key-value store with a user's name on it, writable from any browser with
 * a session, growing where nobody is watching:
 *
 *   1. keys are ALLOWLISTED server-side — an unknown key is refused, not stored
 *   2. values are CAPPED — anything larger is refused, never truncated
 *
 * Everything below re-reads the ROW after the call. Asserting the response has
 * produced false passes three times in this project: a handler that echoes its
 * input tells you nothing about what was stored.
 *
 * Run: node test/userPreferences.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_prefs_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    request = require('supertest');
    jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL)");
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by) VALUES
      (700,'Owner Olly','olly@x.com',14,4,NULL),
      (710,'Employee Eve','eve@x.com',2,1,700)`);

    const express = require('express');
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/preferences', require('../routes/preferences'));

    const tok = (id) => 'Bearer ' + jwt.sign(
      { id, working_id: id, role: id === 700 ? 14 : 2, category: id === 700 ? 4 : 1, email: id + '@x.com' },
      process.env.ACCESS_TOKEN);

    const put = (who, body) => request(app).put('/api/preferences').set('Authorization', tok(who)).send(body);
    const get = (who) => request(app).get('/api/preferences').set('Authorization', tok(who));
    const storedRows = async (uid) => {
      const [rows] = await conn.query('SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?', [uid]);
      return rows;
    };

    // ---- 1. the happy path, verified in the TABLE ----
    const w1 = await put(700, { key: 'notepad.showCompleted', value: true });
    ok(w1.status === 200, 'an allowlisted preference is accepted', String(w1.status) + ' ' + JSON.stringify(w1.body));
    {
      const rows = await storedRows(700);
      ok(rows.length === 1 && rows[0].pref_key === 'notepad.showCompleted' && JSON.parse(rows[0].pref_value) === true,
        'and it is really in the table, not just echoed back', JSON.stringify(rows));
    }

    const r1 = await get(700);
    ok(r1.body?.data?.['notepad.showCompleted'] === true,
      'reading it back gives a real boolean, not the string "true"',
      JSON.stringify(r1.body));

    // ---- 2. upsert, not a second row ----
    await put(700, { key: 'notepad.showCompleted', value: false });
    {
      const rows = await storedRows(700);
      ok(rows.length === 1, 'writing again UPSERTS — one row per user per key', JSON.stringify(rows));
      ok(JSON.parse(rows[0].pref_value) === false, 'and the value really changed', rows[0].pref_value);
    }

    // ---- 3. GUARD ONE: the key allowlist ----
    const bad = await put(700, { key: 'anything.i.like', value: 'hello' });
    ok(bad.status === 400 && bad.body?.code === 'PREF_KEY_NOT_ALLOWED',
      'GUARD 1: an unknown key is REFUSED by name', String(bad.status) + ' ' + JSON.stringify(bad.body));
    {
      const [rows] = await conn.query("SELECT * FROM user_preferences WHERE pref_key = 'anything.i.like'");
      ok(rows.length === 0,
        'GUARD 1: and nothing was written — this is what stops it being free storage',
        JSON.stringify(rows));
    }

    // ---- 4. GUARD TWO: the size cap ----
    // The route checks SIZE before shape, so this reaches the cap rather than
    // being rejected as the wrong type first — otherwise the cap would never
    // actually be exercised and this assertion would be theatre.
    const huge = 'x'.repeat(5000);
    const big = await put(700, { key: 'notepad.showCompleted', value: huge });
    ok(big.status === 413 && big.body?.code === 'PREF_VALUE_TOO_LARGE',
      'GUARD 2: an oversized value is refused AS TOO LARGE, so the cap is really reached',
      String(big.status) + ' ' + JSON.stringify(big.body));
    {
      const rows = await storedRows(700);
      ok(rows.length === 1 && JSON.parse(rows[0].pref_value) === false,
        'GUARD 2: and the previous value is untouched — refused, never truncated',
        JSON.stringify(rows));
    }

    // ---- 5. wrong TYPE at a good key ----
    const wrongType = await put(700, { key: 'notepad.showCompleted', value: 'yes' });
    ok(wrongType.status === 400 && wrongType.body?.code === 'PREF_VALUE_INVALID',
      'a string at a boolean key is refused', String(wrongType.status) + ' ' + JSON.stringify(wrongType.body));

    // ---- 6. scoped to the USER, not the account ----
    await put(710, { key: 'notepad.showCompleted', value: true });
    {
      const mine = await storedRows(700);
      const theirs = await storedRows(710);
      ok(JSON.parse(mine[0].pref_value) === false && JSON.parse(theirs[0].pref_value) === true,
        'two users on ONE account keep separate values — a preference is yours, not the company\'s',
        JSON.stringify({ mine: mine[0].pref_value, theirs: theirs[0].pref_value }));
    }
    {
      const asEve = await get(710);
      ok(asEve.body?.data?.['notepad.showCompleted'] === true, 'and each reads back their own', JSON.stringify(asEve.body));
      const asOlly = await get(700);
      ok(asOlly.body?.data?.['notepad.showCompleted'] === false, 'not the other one\'s', JSON.stringify(asOlly.body));
    }

    // ---- 7. a malformed stored row must not break the whole read ----
    await conn.query("INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES (700, 'notepad.showCompleted', '{{{') ON DUPLICATE KEY UPDATE pref_value = '{{{'");
    const rBroken = await get(700);
    ok(rBroken.status === 200,
      'one unparseable row does not 500 the whole preferences read', String(rBroken.status));

    // ---- 8. no auth, no store ----
    const noAuth = await request(app).put('/api/preferences').send({ key: 'notepad.showCompleted', value: true });
    ok(noAuth.status === 401 || noAuth.status === 403,
      'an unauthenticated write is rejected', String(noAuth.status));

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
