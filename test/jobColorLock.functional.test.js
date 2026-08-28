/* Manual job-colour LOCK — functional test (real local MySQL via mysql-memory-server).
 * Proves a user-picked colour (color_locked=1) is NEVER overwritten by any of the
 * auto-colour routines, and that new-job assignment avoids it:
 *   - repaletteOrphanedColors leaves a locked (even non-pool) colour alone;
 *   - reassignActiveDiverse (conservative AND full) never moves a locked job;
 *   - backfillJobColors(reassign) never overwrites a locked job;
 *   - pickJobColor for a new job does not reuse a locked colour.
 * Run: node test/jobColorLock.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  → ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_colorlock_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, created_by INT NULL, category INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, status INT NULL, color VARCHAR(9) NULL, color_locked TINYINT(1) NOT NULL DEFAULT 0)');
    await conn.query('INSERT INTO `user` (id, created_by, category) VALUES (1, NULL, 14)');

    // LOCKED = user pick, a NON-pool custom colour (would otherwise be "orphaned"):
    const LOCK = '#123456';
    await conn.query('INSERT INTO job (id, created_by, status, color, color_locked) VALUES (10, 1, 1, ?, 1)', [LOCK]);
    // Unlocked, non-pool colour → repalette SHOULD recolour it.
    await conn.query("INSERT INTO job (id, created_by, status, color, color_locked) VALUES (11, 1, 1, '#010203', 0)");
    // Two unlocked near-identical pool oranges (a cluster) → conservative reassign moves one.
    await conn.query("INSERT INTO job (id, created_by, status, color, color_locked) VALUES (12, 1, 1, '#cc5500', 0), (13, 1, 1, '#c1651d', 0)");

    const { pickJobColor, reassignActiveDiverse, backfillJobColors, repaletteOrphanedColors } = require('../services/jobColorPalette');
    const colorOf = async (id) => { const [[r]] = await conn.query('SELECT color FROM job WHERE id = ?', [id]); return r.color; };

    // 1. repaletteOrphanedColors — locked custom colour untouched; unlocked orphan recoloured.
    await repaletteOrphanedColors(conn);
    ok(await colorOf(10) === LOCK, 'repalette: locked custom colour untouched', await colorOf(10));
    ok(await colorOf(11) !== '#010203', 'repalette: unlocked orphan WAS recoloured (control)', await colorOf(11));

    // 2. reassignActiveDiverse conservative (apply) — locked job never moves.
    let before10 = await colorOf(10);
    let r = await reassignActiveDiverse(conn, { apply: true });
    ok(await colorOf(10) === LOCK, 'reassign(conservative): locked job untouched', await colorOf(10));
    ok(!r.plan.some((p) => p.jobId === 10), 'reassign(conservative): plan never includes the locked job');

    // 3. reassignActiveDiverse FULL (apply) — even an aggressive full reassign skips it.
    r = await reassignActiveDiverse(conn, { apply: true, full: true });
    ok(await colorOf(10) === LOCK, 'reassign(full): locked job untouched', await colorOf(10));
    ok(!r.plan.some((p) => p.jobId === 10), 'reassign(full): plan never includes the locked job');

    // 4. backfillJobColors(reassign) — overwrites everything EXCEPT the locked job.
    await backfillJobColors(conn, { apply: true, reassign: true });
    ok(await colorOf(10) === LOCK, 'backfill(reassign): locked job untouched', await colorOf(10));
    ok(await colorOf(12) !== null, 'backfill(reassign): unlocked jobs still (re)coloured (control)');

    // 5. pickJobColor for a NEW job does not reuse the locked colour.
    const picks = new Set();
    for (let i = 0; i < 6; i++) picks.add((await pickJobColor(conn, 1)).toLowerCase());
    ok(![...picks].includes(LOCK.toLowerCase()), 'pickJobColor: never returns the locked colour', [...picks].join(','));

    // 6. sanity: the locked job is STILL locked after all the routines ran.
    const [[l]] = await conn.query('SELECT color_locked FROM job WHERE id = 10');
    ok(Number(l.color_locked) === 1, 'locked flag persists through every routine');

  } catch (e) {
    fail++; rec.push('  ✗ EXCEPTION: ' + (e && e.stack || e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
  console.log('\n==== Manual job-colour lock functional test ====');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
