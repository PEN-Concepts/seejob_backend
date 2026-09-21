/* THE REQUEST LOG RECORDS WHO, NOT JUST WHAT.
 *
 * WHAT WAS WRONG. The global logger in index.js sat before the route mounts
 * and therefore before auth.authenticateToken ran, so req.user was always
 * undefined: every line read `user=anonymous`. When the dashboard tenant
 * leak was found, "did a real client ever receive those job names" could
 * not be answered from thirty days of logs — the path was recorded and the
 * identity never was.
 *
 * ONE LOGGER, EARLY, WRITING AT FINISH. Registered before everything so it
 * sees requests rejected before any route runs, but it writes on
 * res.on('finish'), by which point auth has populated req.user and the
 * status is known. Both halves true from one hook.
 *
 * This test exercises the middleware itself rather than the whole server,
 * because the thing under test is WHAT IT WRITES — so the assertion is on
 * captured log lines, not on a response body.
 *
 * Run: node test/requestLogIdentity.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  try {
    process.env.ACCESS_TOKEN = 'test_secret';

    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const logger = require('../common/logger');

    // Capture what the app WOULD write, without touching a log file.
    const lines = [];
    const realInfo = logger.info.bind(logger);
    logger.info = (msg) => { lines.push(String(msg)); };

    try {
      const app = express();
      app.use(express.json());

      // The middleware exactly as index.js registers it.
      app.use((req, res, next) => {
        const started = Date.now();
        res.on('finish', () => {
          const u = req.user;
          const who = u && u.id
            ? `user=${u.id} category=${u.category == null ? 'unknown' : u.category}`
            : 'user=- auth=none';
          const pathOnly = String(req.originalUrl || '').split('?')[0];
          logger.info(
            `API: ${req.method} ${pathOnly} ${res.statusCode} ${who} ${Date.now() - started}ms`,
          );
        });
        next();
      });

      const auth = require('../services/authentication');
      app.get('/api/v1/secure', auth.authenticateToken, (req, res) => res.json({ ok: true }));

      const tok = (id, category) => 'Bearer ' + jwt.sign(
        { id, category, role: 2, email: 'u' + id + '@x.com' },
        process.env.ACCESS_TOKEN, { expiresIn: '1h' },
      );

      // ── an authenticated request ────────────────────────────────────
      lines.length = 0;
      await request(app).get('/api/v1/secure').set('Authorization', tok(730, 3));
      const authed = lines.find((l) => l.includes('/api/v1/secure')) || '';
      note('authenticated -> ' + authed);
      ok(/user=730\b/.test(authed), 'logs the real user id', authed);
      ok(/category=3\b/.test(authed), 'logs the account CATEGORY, so "was it a client" needs no second lookup', authed);
      ok(!/anonymous/.test(authed), 'and no longer says anonymous', authed);
      ok(/\bGET\b/.test(authed) && /\/api\/v1\/secure/.test(authed) && /\b200\b/.test(authed),
        'keeps method, path and status', authed);

      // ── a request that FAILS authentication ─────────────────────────
      // Moving the logger behind auth would have silenced these, and a
      // sweep of 401s is how you notice someone probing.
      lines.length = 0;
      await request(app).get('/api/v1/secure');
      const anon = lines.find((l) => l.includes('/api/v1/secure')) || '';
      note('unauthenticated -> ' + anon);
      ok(anon.length > 0, 'an unauthenticated request is STILL logged', JSON.stringify(lines));
      ok(/auth=none/.test(anon), 'and is marked plainly as unauthenticated', anon);
      ok(/\b401\b/.test(anon), 'with its status', anon);

      // ── what must NEVER reach the file ──────────────────────────────
      lines.length = 0;
      await request(app)
        .get('/api/v1/secure?job_id=4242&email=someone%40example.com&share_token=abcdef123456')
        .set('Authorization', tok(700, 4))
        .set('Cookie', 'session=supersecretcookie');
      const q = lines.find((l) => l.includes('/api/v1/secure')) || '';
      note('with a query string -> ' + q);
      ok(!/4242/.test(q), 'NO query-string identifiers (job_id) in the line', q);
      ok(!/example\.com/.test(q), 'no email from the query string', q);
      ok(!/abcdef123456/.test(q), 'no share token', q);
      ok(!/supersecretcookie/.test(q), 'no headers or cookies', q);
      ok(!/Bearer|eyJ/.test(q), 'no bearer token', q);
      ok(/\/api\/v1\/secure\b/.test(q) && !/\?/.test(q),
        'the path is logged, the query string is cut off at the ?', q);

      // ── a POST body must not be logged either ───────────────────────
      lines.length = 0;
      app.post('/api/v1/thing', auth.authenticateToken, (req, res) => res.json({ ok: true }));
      await request(app).post('/api/v1/thing')
        .set('Authorization', tok(700, 4))
        .send({ secret_note: 'PRIVATE-BODY-CONTENT', amount: 999 });
      const post = lines.find((l) => l.includes('/api/v1/thing')) || '';
      note('POST -> ' + post);
      ok(!/PRIVATE-BODY-CONTENT/.test(post), 'no request body in the line', post);
      ok(!/999/.test(post.replace(/\d+ms/, '')), 'no body values either', post);
    } finally {
      logger.info = realInfo;
    }
  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
