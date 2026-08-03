/* D2: Quote Manager backend gate mirrors the frontend (quote RIGHT OR quote plan
 * FEATURE; owner-exempt always; public token routes never gated). Real MySQL.
 * Run: NODE_PATH=<backend>/node_modules node test/quoteGate.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_quotegate_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, email VARCHAR(190), role INT, category INT, created_by INT NULL) ENGINE=InnoDB");
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY, name VARCHAR(80), sub_heading INT DEFAULT 0) ENGINE=InnoDB");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT NULL, right_id INT, `read` VARCHAR(5), `create` VARCHAR(5), `update` VARCHAR(5), `delete` VARCHAR(5)) ENGINE=InnoDB");
    await conn.query("CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), level INT) ENGINE=InnoDB");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT, feature_key VARCHAR(80)) ENGINE=InnoDB");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT, status VARCHAR(20), created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await conn.query("CREATE TABLE quotes (id INT PRIMARY KEY AUTO_INCREMENT, public_token VARCHAR(80), user_id INT) ENGINE=InnoDB");

    await conn.query("INSERT INTO `right` (id,name,sub_heading) VALUES (1,'quote',0),(2,'job',0)");
    await conn.query("INSERT INTO plans (id,name,level) VALUES (4,'Gold',4),(5,'Platinum',5)");
    // plan 5 includes 'quote' feature; plan 4 does not.
    await conn.query("INSERT INTO plan_features (plan_id,feature_key) VALUES (5,'quote'),(4,'job')");
    // Users:
    await conn.query(`INSERT INTO \`user\` (id,email,role,category,created_by) VALUES
      (500,'rightuser@x.com',14,2,NULL),
      (501,'featureuser@x.com',14,2,NULL),
      (502,'nobody@x.com',14,2,NULL),
      (503,'admin@oakcoast.net',14,2,NULL)`);
    // 500 has the quote RIGHT (role-14 default, user_id NULL).
    await conn.query("INSERT INTO role_right_permission (role_id,user_id,right_id,`read`,`create`,`update`,`delete`) VALUES (14,NULL,1,'yes','yes','yes','yes')");
    // 501 has NO quote right but its account plan (5) includes the 'quote' feature.
    await conn.query("INSERT INTO subscriptions (user_id,plan_id,status) VALUES (501,5,'active')");
    // 502 has NO right and plan 4 (no quote feature).
    await conn.query("INSERT INTO subscriptions (user_id,plan_id,status) VALUES (502,4,'active')");
    // A quote with a public token for the public-route test.
    await conn.query("INSERT INTO quotes (public_token,user_id) VALUES ('PUBTOKEN',500)");

    // NOTE 502 must NOT match the role-14 default 'quote' right. It does (default is role-wide).
    // To make 502 a true "neither" case, give it a user-specific rights row WITHOUT quote,
    // so the userHasQuoteRight else-branch stops at "has user-specific but not quote".
    await conn.query("INSERT INTO role_right_permission (role_id,user_id,right_id,`read`,`create`,`update`,`delete`) VALUES (14,502,2,'yes','no','no','no')");

    const express = require('express');
    request = require('supertest'); jwt = require('jsonwebtoken');
    const quote = require('../routes/quote');
    app = express();
    app.use(express.json());
    app.use('/api/quote', quote);
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const hit = (id) => request(app).get('/api/quote/quotes').set('Authorization', id ? tok(id) : '');

    const r500 = await hit(500); ok(r500.status !== 403, 'RIGHT: user with the quote right is NOT blocked (gate passes)', String(r500.status));
    const r501 = await hit(501); ok(r501.status !== 403, 'FEATURE: user whose plan includes quote is NOT blocked', String(r501.status));
    const r502 = await hit(502); ok(r502.status === 403 && r502.body && r502.body.code === 'FEATURE_NOT_AVAILABLE', 'NEITHER: no right + no feature -> 403 FEATURE_NOT_AVAILABLE', JSON.stringify([r502.status, r502.body && r502.body.code]));
    const r503 = await hit(503); ok(r503.status !== 403, 'OWNER-EXEMPT: admin@oakcoast.net never blocked', String(r503.status));
    const rNoTok = await hit(null); ok(rNoTok.status === 401 || rNoTok.status === 403, 'NO TOKEN: rejected', String(rNoTok.status));
    // Public token route must NOT be gated (no auth, no quote entitlement needed).
    const rPub = await request(app).get('/api/quote/quotes/public/PUBTOKEN');
    ok(rPub.status !== 403 && rPub.status !== 401, 'PUBLIC: token e-sign route is not plan-gated', String(rPub.status));

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
