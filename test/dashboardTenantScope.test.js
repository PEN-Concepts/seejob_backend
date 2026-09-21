/* THE DASHBOARD IS SCOPED TO THE SIGNED-IN USER'S ACCOUNT.
 *
 * WHAT WENT WRONG. routes/dashboard.js resolved the account with
 * `accountOwnerOf()`, which promotes ANY user to their `created_by` parent.
 * routes/jobs.js used `resolveOwnerId()`, which promotes only employees, and
 * then applied a full account predicate. Two functions answering the same
 * question differently, and the dashboard used its answer as a row selector:
 *
 *     SELECT id, name, color FROM `job` WHERE created_by = <promoted owner>
 *
 * So a SUBCONTRACTOR — a separate business — and a CLIENT — a customer —
 * each received the inviting contractor's private job names and colours, on
 * every dashboard route, and could not open any of them from any screen
 * because the jobs list correctly refused them.
 *
 * WHAT THIS FILE ASSERTS. Four categories against every dashboard route,
 * comparing what each receives with what the jobs list gives the same user.
 * The rule is simple and absolute: NOTHING belonging to the inviting
 * contractor reaches a subcontractor or a client.
 *
 * TWO TRAPS THIS FILE IS BUILT TO AVOID, both of which bit the original
 * investigation:
 *
 *   1. A 500 IS NOT A PASS. The first probe could not exercise /exceptions
 *      because the fixture was too thin, and an empty band list looked like
 *      safety. Every call here asserts 200 first and fails loudly otherwise.
 *   2. AN EMPTY ARRAY IS NOT A PASS EITHER. Each check also proves the route
 *      returned the caller's OWN rows, so "scoped" cannot be satisfied by a
 *      route that simply returns nothing.
 *
 * Run: node test/dashboardTenantScope.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_tenant_scope', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    // The schema the dashboard and the jobs list actually touch. Kept wide
    // enough that BOTH return 200 — see trap 1 above.
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), mobile VARCHAR(40) NULL, street VARCHAR(190) NULL, city VARCHAR(90) NULL, state VARCHAR(90) NULL, zipcode VARCHAR(20) NULL, website_link VARCHAR(190) NULL, subcategory INT NULL, role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, client_id INT NULL, inspector_id INT NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, additional_client_name VARCHAR(190) NULL, additional_client_email VARCHAR(190) NULL, additional_client_mobile VARCHAR(40) NULL, created_at DATETIME NULL)");
    // FIXTURE WIDENED — see the same note in dashboardStallSnooze. §1 reads
    // leads.status and leads.bid_status; without them the query throws into a
    // swallowing catch and every lead assertion passes vacuously on an empty
    // list.
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, status INT NULL, bid_status VARCHAR(40) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, lead_id INT NULL, origin VARCHAR(20) NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_section_shares (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, user_id INT)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, delegated_to INT NULL, assign_to INT NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE notepad_access (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, user_id INT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, subject VARCHAR(190) NULL, description TEXT NULL, doa DATETIME NULL, all_day TINYINT DEFAULT 0, address VARCHAR(190) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, skip_saturday TINYINT DEFAULT 1, skip_sunday TINYINT DEFAULT 1)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, name VARCHAR(190), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, is_inspection TINYINT DEFAULT 0, assignee_user_id INT NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE master_calendar_tasks (id INT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(190), sort_order INT DEFAULT 0, created_by INT NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE chat_conversations (id INT PRIMARY KEY AUTO_INCREMENT, type VARCHAR(20), job_id INT NULL, owner_id INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE chat_messages (id INT PRIMARY KEY AUTO_INCREMENT, conversation_id INT, sender_id INT NULL, body TEXT, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE spartan_goal_log (id INT PRIMARY KEY AUTO_INCREMENT, goal_id INT NOT NULL, user_id INT NOT NULL, log_date DATE NOT NULL, status VARCHAR(20) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_goal_date (goal_id, log_date))");

    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    // 700 the GC. 710 their EMPLOYEE (cat 1, shares the account).
    // 720 a SUBCONTRACTOR the GC invited (cat 2) — a separate business.
    // 730 a CLIENT the GC invited (cat 3).
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul (GC)','gc@x.com',14,4,NULL,NOW()),
      (710,'Employee','emp@x.com',2,1,700,NOW()),
      (720,'Subcontractor','sub@x.com',12,2,700,NOW()),
      (730,'Client','client@x.com',3,3,700,NOW())`);

    // The GC's private work, stale enough to stall.
    await conn.query(`INSERT INTO \`job\` (id,name,created_by,status,color,created_at) VALUES
      (10,'GC PRIVATE A',700,1,'#111', NOW() - INTERVAL 60 DAY),
      (11,'GC PRIVATE B',700,1,'#222', NOW() - INTERVAL 60 DAY),
      (12,'GC PRIVATE C',700,1,'#333', NOW() - INTERVAL 60 DAY)`);
    // The subcontractor's OWN job, and the client's own job (they are its client).
    await conn.query("INSERT INTO `job` (id,name,created_by,status,color,created_at) VALUES (20,'SUB OWN JOB',720,1,'#444', NOW() - INTERVAL 60 DAY)");
    await conn.query("INSERT INTO `job` (id,name,created_by,status,color,client_id,created_at) VALUES (30,'CLIENT OWN JOB',700,1,'#555',730, NOW() - INTERVAL 60 DAY)");
    await conn.query("INSERT INTO leads (id,lead_name,user_id,created_at) VALUES (50,'GC PRIVATE LEAD',700, NOW() - INTERVAL 60 DAY)");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    app.use('/api/jobs', require('../routes/jobs'));

    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const D0 = new Date(); D0.setHours(0, 0, 0, 0);
    const D1 = new Date(D0); D1.setDate(D1.getDate() + 1);

    /** Every dashboard route that resolves an account, by name. */
    const ROUTES = [
      { name: 'GET /stalled', call: (t) => request(app).get('/api/dashboard/stalled').set('Authorization', t) },
      { name: 'GET /exceptions', call: (t) => request(app).get('/api/dashboard/exceptions').set('Authorization', t) },
      { name: 'GET /day', call: (t) => request(app).get(`/api/dashboard/day?from=${fmt(D0)}&to=${fmt(D1)}`).set('Authorization', t) },
      { name: 'GET /item-review', call: (t) => request(app).get(`/api/dashboard/item-review?on=${fmt(D0)}`).set('Authorization', t) },
      { name: 'POST /item-review', call: (t) => request(app).post('/api/dashboard/item-review').set('Authorization', t).send({ item_type: 'appointment', item_id: 1, occurs_on: fmt(D0), state: 'missed' }) },
      { name: 'POST /stall-snooze', call: (t) => request(app).post('/api/dashboard/stall-snooze').set('Authorization', t).send({ target_type: 'job', target_id: 10, check_back_on: fmt(D1) }) },
    ];

    /** Every string anywhere in a response — job names leak as strings. */
    const deepStrings = (v, out = []) => {
      if (v == null) return out;
      if (typeof v === 'string') { out.push(v); return out; }
      if (Array.isArray(v)) { v.forEach((x) => deepStrings(x, out)); return out; }
      if (typeof v === 'object') { Object.values(v).forEach((x) => deepStrings(x, out)); return out; }
      return out;
    };

    const FOREIGN = ['GC PRIVATE A', 'GC PRIVATE B', 'GC PRIVATE C', 'GC PRIVATE LEAD'];
    const FOREIGN_COLORS = ['#111', '#222', '#333'];

    // ── the owner and the employee: everything still works ──────────────
    for (const [id, role, cat, who] of [[700, 14, 4, 'the GC'], [710, 2, 1, 'their employee']]) {
      const r = await ROUTES[0].call(tok(id, role, cat));
      ok(r.status === 200, `${who}: /stalled answers 200`, String(r.status));
      const names = deepStrings(r.body);
      ok(names.includes('GC PRIVATE A'),
        `${who}: STILL SEES the account's own jobs — the fix must not blind the owner`,
        JSON.stringify(names).slice(0, 200));
    }

    // ── THE RULE, for a SUBCONTRACTOR: their own work, nothing foreign ──
    for (const [id, role, cat, who, ownRow] of [
      [720, 12, 2, 'a SUBCONTRACTOR', 'SUB OWN JOB'],
    ]) {
      const t = tok(id, role, cat);

      // What the jobs list — the correct implementation — gives them.
      const jl = await request(app).get('/api/jobs/jobs').set('Authorization', t);
      ok(jl.status === 200, `${who}: the jobs list answers 200`, String(jl.status));
      const listNames = (Array.isArray(jl.body) ? jl.body : []).map((j) => j.name);
      ok(listNames.includes(ownRow),
        `${who}: the jobs list gives them their own job (so "empty" cannot pass)`,
        JSON.stringify(listNames));
      for (const f of FOREIGN) {
        ok(!listNames.includes(f), `${who}: the jobs list withholds ${f}`, JSON.stringify(listNames));
      }

      for (const route of ROUTES) {
        const r = await route.call(t);

        // TRAP 1 — a non-200 is a failure, not a pass. 403 is allowed only
        // for the two WRITE routes, which may legitimately refuse.
        const isWrite = route.name.startsWith('POST');
        const acceptable = isWrite ? [200, 400, 403, 404] : [200];
        ok(acceptable.includes(r.status),
          `${who}: ${route.name} answers ${acceptable.join('/')} — a 500 proves nothing`,
          `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

        // TRAP 2 — and nothing of the contractor's is in the body.
        const strings = deepStrings(r.body);
        const leaked = FOREIGN.filter((f) => strings.includes(f));
        ok(leaked.length === 0,
          `${who}: ${route.name} leaks NO foreign job or lead name`,
          `leaked ${JSON.stringify(leaked)} in ${JSON.stringify(r.body).slice(0, 200)}`);

        const leakedColors = FOREIGN_COLORS.filter((c) => strings.includes(c));
        ok(leakedColors.length === 0,
          `${who}: ${route.name} leaks no foreign job colour either`,
          JSON.stringify(leakedColors));
      }
    }

    // ── the positive half: the subcontractor's own work reaches them ────
    {
      const r = await request(app).get('/api/dashboard/stalled').set('Authorization', tok(720, 12, 2));
      ok(r.status === 200, 'subcontractor: /stalled answers 200', String(r.status));
      ok(deepStrings(r.body).includes('SUB OWN JOB'),
        'subcontractor SEES THEIR OWN stalled job — scoped, not blanked',
        JSON.stringify(r.body).slice(0, 200));
    }

    /*
     * ── A CLIENT GETS NOTHING ──────────────────────────────────────────
     *
     * Not "nothing foreign" — NOTHING. Poul's ruling. A client must not be
     * able to infer that another job exists from a count or a band, so the
     * assertion is on the WHOLE body, including the one job they are
     * legitimately the client of (job 30). That job reaches them through
     * their own screens; it does not reach them here.
     */
    {
      const t = tok(730, 3, 3);
      const CLIENT_SHAPES = {
        'GET /stalled': { success: true, stalled: [] },
        'GET /exceptions': { success: true, bands: {} },
        'GET /day': { success: true, days: {}, reviews: [] },
        'GET /item-review': { success: true, reviews: [] },
      };
      for (const route of ROUTES) {
        const r = await route.call(t);
        const isWrite = route.name.startsWith('POST');

        if (isWrite) {
          ok(r.status === 403,
            `client: ${route.name} is REFUSED (403) — nothing to write and nothing to shape`,
            `${r.status} ${JSON.stringify(r.body)}`);
        } else {
          ok(r.status === 200,
            `client: ${route.name} answers 200 — an empty shape cannot white-screen the phone`,
            `${r.status} ${JSON.stringify(r.body)}`);
          ok(JSON.stringify(r.body) === JSON.stringify(CLIENT_SHAPES[route.name]),
            `client: ${route.name} returns EXACTLY the empty shape`,
            `got ${JSON.stringify(r.body)}`);
        }

        // Whole-body sweep: no job name of ANY kind, including their own.
        const strings = deepStrings(r.body);
        const anyJobName = ['GC PRIVATE A', 'GC PRIVATE B', 'GC PRIVATE C', 'GC PRIVATE LEAD', 'SUB OWN JOB', 'CLIENT OWN JOB']
          .filter((n) => strings.includes(n));
        ok(anyJobName.length === 0,
          `client: ${route.name} carries NO job name at all, not even their own`,
          JSON.stringify(anyJobName));
        const anyColor = ['#111', '#222', '#333', '#444', '#555'].filter((c) => strings.includes(c));
        ok(anyColor.length === 0, `client: ${route.name} carries no colour`, JSON.stringify(anyColor));

        // And no number that could imply an existence — no non-zero count
        // anywhere in the payload.
        const nums = JSON.stringify(r.body).match(/\d+/g) || [];
        ok(nums.every((n) => Number(n) === 0),
          `client: ${route.name} carries no count a client could reason from`,
          JSON.stringify(nums));
      }
    }

    // ── but the client's OWN TASKS are untouched ────────────────────────
    {
      // The path Poul called out as it must keep working: "a client can see
      // any task that I have assigned to them". That is the jobs list /
      // tasks path, not this router, and the deny above must not reach it.
      await conn.query("INSERT INTO tasks (job_id,user_id,created_by,task_type,task_name,created_at) VALUES (30,730,700,'job','Client sees this', NOW())");
      const jl = await request(app).get('/api/jobs/jobs').set('Authorization', tok(730, 3, 3));
      ok(jl.status === 200, 'client: the jobs list still answers 200', String(jl.status));
      const names = (Array.isArray(jl.body) ? jl.body : []).map((j) => j.name);
      ok(names.includes('CLIENT OWN JOB'),
        'client STILL SEES the job they are the client of, on their own screens',
        JSON.stringify(names));
      ok(!names.includes('GC PRIVATE A'),
        'and still not the contractor\'s other jobs', JSON.stringify(names));
    }

    // ── the snooze ownership check still refuses a foreign target ───────
    {
      const r = await request(app).post('/api/dashboard/stall-snooze')
        .set('Authorization', tok(720, 12, 2))
        .send({ target_type: 'job', target_id: 10, check_back_on: fmt(D1) });
      ok(r.status === 403, 'a subcontractor cannot snooze the contractor\'s job', String(r.status));
      const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM dashboard_stall_snooze WHERE user_id = 720');
      ok(Number(n.n) === 0, 'and the refused snooze wrote NO row', JSON.stringify(n));
    }

    // ── one resolver, not two ───────────────────────────────────────────
    {
      const { resolveAccountOwner } = require('../services/accountScope');
      const { resolveOwnerId } = require('../utils/access');
      for (const uid of [700, 710, 720, 730]) {
        const a = await resolveAccountOwner(conn, uid);
        const b = Number(await resolveOwnerId(uid, conn));
        ok(a === b, `resolveAccountOwner agrees with resolveOwnerId for ${uid}`, `${a} vs ${b}`);
      }
      note('the jobs list and the dashboard now call the same predicate — services/accountScope.js');
    }

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
