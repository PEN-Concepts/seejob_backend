/* NEW TEAM-SIZE PLAN MODEL — seedNewPlanModel.
 *
 * No existing subscribers, so we replace plans freely: deactivate the old 5
 * (Bid Pro / Basic / Bronze / Silver / Gold — Bid Pro DROPPED per ruling) and stand
 * up Starter $69 / Team $99 / Crew $129, all level 5 (all-features). Every new plan
 * gets every known feature_key so billing/status returns them all (no feature-gating).
 * The 60-day trial → expired_free read-only free tier is the existing access model and
 * is covered elsewhere; here we prove the plan swap + all-features + idempotency.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV;
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_planmodel', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();

    // Mirror prod schema for the pre-existing tables.
    await conn.query("CREATE TABLE plans (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), amount DECIMAL(10,2), `interval` VARCHAR(20), is_active TINYINT DEFAULT 1, level INT NULL, description VARCHAR(190) NULL)");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT NULL, feature_key VARCHAR(80))");
    // The OLD 5 plans + a representative feature catalog on the top plan.
    await conn.query("INSERT INTO plans (name, amount, `interval`, is_active, level) VALUES ('Bid Pro',19,'month',1,NULL),('Basic',29,'month',1,1),('Bronze',59,'month',1,2),('Silver',99,'month',1,3),('Gold',199,'month',1,4)");
    const [[gold]] = await conn.query("SELECT id FROM plans WHERE name='Gold'");
    for (const k of ['job', 'contact', 'task', 'checklist', 'quote', 'calendar', 'budget', 'billing', 'equipment', 'user']) {
      await conn.query("INSERT INTO plan_features (plan_id, feature_key) VALUES (?, ?)", [gold.id, k]);
    }

    const mig = require('../services/dbMigrations');

    // SAFETY GATE: without ENABLE_NEW_PLAN_MODEL=true the seed is a no-op — the live
    // plan catalog is never touched by merely deploying the code.
    delete process.env.ENABLE_NEW_PLAN_MODEL;
    await mig.seedNewPlanModel(conn);
    const [[stillGold]] = await conn.query("SELECT is_active FROM plans WHERE name='Gold'");
    ok(Number(stillGold.is_active) === 1, 'flag OFF: seed is a no-op (old plans untouched)', JSON.stringify(stillGold));

    // Opt in, then run for real.
    process.env.ENABLE_NEW_PLAN_MODEL = 'true';
    await mig.seedNewPlanModel(conn);

    // ── old plans deactivated (Bid Pro dropped) ──
    const [[bidpro]] = await conn.query("SELECT is_active FROM plans WHERE name='Bid Pro'");
    ok(Number(bidpro.is_active) === 0, 'Bid Pro is deactivated (dropped)', JSON.stringify(bidpro));
    const [[oldActive]] = await conn.query("SELECT COUNT(*) AS n FROM plans WHERE is_active=1 AND name IN ('Bid Pro','Basic','Bronze','Silver','Gold')");
    ok(Number(oldActive.n) === 0, 'no old plan is active', JSON.stringify(oldActive));

    // ── the three new plans, active, level 5, correct amounts ──
    const [active] = await conn.query("SELECT id, name, amount, level, is_active, description FROM plans WHERE is_active=1 AND LOWER(name) <> 'platinum' ORDER BY amount ASC");
    const names = active.map((p) => p.name);
    ok(JSON.stringify(names) === JSON.stringify(['Starter', 'Team', 'Crew']), 'active plans are exactly Starter/Team/Crew (ascending price)', names.join());
    const byName = Object.fromEntries(active.map((p) => [p.name, p]));
    ok(Number(byName.Starter.amount) === 69 && Number(byName.Team.amount) === 99 && Number(byName.Crew.amount) === 129,
      'prices are $69 / $99 / $129', JSON.stringify(active.map((p) => [p.name, Number(p.amount)])));
    ok(active.every((p) => Number(p.level) === 5), 'every new plan is level 5 (all-features, all gates pass)', active.map((p) => p.level).join());
    const [seatRows] = await conn.query("SELECT name, max_employees FROM plans WHERE is_active=1 ORDER BY amount ASC");
    const seats = Object.fromEntries(seatRows.map((r) => [r.name, Number(r.max_employees)]));
    ok(seats.Starter === 3 && seats.Team === 5 && seats.Crew === 10, 'seat caps stored: 3 / 5 / 10 employees', JSON.stringify(seats));

    // ── all-features: each new plan carries EVERY known feature_key ──
    const [[cat]] = await conn.query("SELECT COUNT(DISTINCT feature_key) AS n FROM plan_features");
    const catalog = Number(cat.n);
    for (const p of active) {
      const [[cnt]] = await conn.query("SELECT COUNT(DISTINCT feature_key) AS n FROM plan_features WHERE plan_id = ?", [p.id]);
      ok(Number(cnt.n) === catalog, `${p.name} exposes all ${catalog} features`, `${cnt.n}/${catalog}`);
    }

    // ── idempotent: re-run changes nothing ──
    const before = JSON.stringify((await conn.query("SELECT name,amount,level,is_active FROM plans ORDER BY id"))[0]);
    // reset the once-guard so the function body runs again
    delete require.cache[require.resolve('../services/dbMigrations')];
    const mig2 = require('../services/dbMigrations');
    await mig2.seedNewPlanModel(conn);
    const after = JSON.stringify((await conn.query("SELECT name,amount,level,is_active FROM plans ORDER BY id"))[0]);
    ok(before === after, 're-running the seed is idempotent (no dupes, no changes)', 'changed');
    const [[dupe]] = await conn.query("SELECT COUNT(*) AS n FROM plans WHERE name='Starter'");
    ok(Number(dupe.n) === 1, 'no duplicate Starter plan on re-run', JSON.stringify(dupe));

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
