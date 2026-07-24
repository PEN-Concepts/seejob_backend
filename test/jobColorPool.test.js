/* Job color POOL — pickJobColor + ensureJobColorColumn + release/reassign SQL.
 * A converted/created job gets a distinct persisted colour; completing/archiving
 * releases it (NULL) back to the pool for reuse; the pool is per creator.
 * Real MySQL (mysql-memory-server).
 * Run: NODE_PATH=<backend>/node_modules node test/jobColorPool.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_jobcolor_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureJobColorColumn } = require('../services/dbMigrations');
    const { JOB_COLORS, pickJobColor } = require('../services/jobColorPalette');
    conn = await pool.getConnection();

    // job table WITHOUT color, so we can prove the migration adds it.
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY AUTO_INCREMENT, created_by INT, status INT DEFAULT 1)`);

    // ── migration adds `color`, idempotently ──
    await ensureJobColorColumn(conn);
    // Reset the module's memoized flag so a 2nd call actually re-checks (would no-op in one process).
    await ensureJobColorColumn(conn);
    const [[col]] = await conn.query(
      `SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='job' AND COLUMN_NAME='color'`
    );
    ok(col && col.ok === 1, 'migration: job.color column exists', 'missing');
    ok(JOB_COLORS.length === 30, 'palette has 30 job colours', String(JOB_COLORS.length));

    const addJob = async (createdBy, status = 1, color = null) => {
      const [r] = await conn.query('INSERT INTO job (created_by, status, color) VALUES (?, ?, ?)', [createdBy, status, color]);
      return r.insertId;
    };

    // ── distinct assignment for a creator's active jobs ──
    const A = 501;
    const j1 = await addJob(A); const c1 = await pickJobColor(conn, A);
    await conn.query('UPDATE job SET color=? WHERE id=?', [c1, j1]);
    const j2 = await addJob(A); const c2 = await pickJobColor(conn, A);
    await conn.query('UPDATE job SET color=? WHERE id=?', [c2, j2]);
    ok(c1 === JOB_COLORS[0], 'first assignment = palette[0]', c1);
    ok(c2 === JOB_COLORS[1] && c2 !== c1, 'second assignment is the next, distinct colour', c2);

    // ── per-creator scope: creator B is unaffected by A's usage ──
    const B = 502;
    const cB = await pickJobColor(conn, B);
    ok(cB === JOB_COLORS[0], 'per-creator: creator B still starts at palette[0]', cB);

    // ── ignores completed/archived + NULL when computing "used" ──
    await addJob(A, 2, JOB_COLORS[5]); // archived holding [5] — must NOT count as used
    await addJob(A, 1, null);          // active but no colour — ignored
    const c3 = await pickJobColor(conn, A);
    ok(c3 === JOB_COLORS[2], 'used-set ignores archived/NULL (next free is palette[2])', c3);

    // ── release: archiving frees the colour back to the pool ──
    await conn.query('UPDATE job SET status=2, color=NULL WHERE id=?', [j1]); // release [0]
    const c4 = await pickJobColor(conn, A);
    ok(c4 === JOB_COLORS[0], 'release: archived job frees palette[0] for reuse', c4);

    // ── reactivate reassigns when colour was released (COALESCE keeps if present) ──
    const rj = await addJob(A, 2, null); // archived, no colour
    const reColor = await pickJobColor(conn, A);
    await conn.query('UPDATE job SET status=1, color=COALESCE(color, ?) WHERE id=?', [reColor, rj]);
    const [[rrow]] = await conn.query('SELECT color FROM job WHERE id=?', [rj]);
    ok(rrow.color === reColor, 'reactivate: a released job gets a fresh pool colour', JSON.stringify(rrow));

    // ── cycle when all 30 are in use ──
    await conn.query('DELETE FROM job');
    for (let i = 0; i < 30; i++) await addJob(A, 1, JOB_COLORS[i]);
    const cFull = await pickJobColor(conn, A);
    ok(JOB_COLORS.includes(cFull), 'pool full: still returns a valid palette colour (cycles)', cFull);

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
