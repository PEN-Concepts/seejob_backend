/* SCOPE BACK-FILL: legacy job/lead notepads private -> company.
 *
 * The live bug: notepadSchema added `scope` as NOT NULL DEFAULT 'private', so
 * every notepad predating the rebuild was stamped private. The hub only returns
 * a non-owned pad to an allowlisted admin when scope='company', so a granted
 * employee saw none of the company's older job pads. The query is right; the
 * data is wrong.
 *
 * THE RULE THIS SUITE EXISTS TO PROTECT: a notepad with no job and no lead is
 * PERSONAL and stays private, permanently, with no exception. 'No Job
 * Assigned', 'My Notepad' and 'Shopping List' are that. Flipping one would put
 * somebody's private list in front of their colleagues.
 *
 * Everything asserts the STORED ROW. The script prints what it did; that is
 * not evidence of what is in the table.
 *
 * Run: node test/notepadScopeBackfill.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    delete process.env.NOTEPAD_BACKFILL_ARMED;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_scope_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL)");
    await conn.query(`CREATE TABLE checklist_sections (
      id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL,
      type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)`);
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), created_by INT NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), archived_at DATETIME NULL)");

    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by) VALUES
      (700,'Poul','poul@x.com',14,4,NULL),
      (710,'Joshua','josh@x.com',2,1,700)`);
    await conn.query("INSERT INTO `job` (id,name,created_by) VALUES (10,'Lynes - ADU',700),(11,'Frantz - HOME',700)");
    await conn.query("INSERT INTO leads (id,lead_name,user_id) VALUES (50,'Oak Ave Bid',700)");

    // Legacy pads: everything landed at 'private' when the column was added.
    await conn.query(`INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,lead_id,scope,origin,account_owner_id) VALUES
      (1,700,'task','Lynes - ADU',10,NULL,'private','manual',NULL),
      (2,700,'task','Frantz - HOME',11,NULL,'private','manual',NULL),
      (3,700,'task','Oak Ave Bid',NULL,50,'private','manual',NULL),
      (4,700,'task','No Job Assigned',NULL,NULL,'private','auto',NULL),
      (5,700,'task','My Notepad',NULL,NULL,'private','manual',NULL),
      (6,710,'task','My Notepad',NULL,NULL,'private','manual',NULL),
      (7,710,'task','Shopping List',NULL,NULL,'private','manual',NULL),
      (8,710,'task','No Job Assigned',NULL,NULL,'private','auto',NULL),
      (9,700,'task','New job pad',10,NULL,'company','auto',700)`);

    const run = (extraEnv, argv) => {
      const { execFileSync } = require('child_process');
      return execFileSync(process.execPath, ['scripts/backfillNotepadScope.js', ...argv], {
        env: { ...process.env, ...extraEnv }, encoding: 'utf8', cwd: process.cwd(),
      });
    };
    const scopeOf = async (id) => {
      const [[r]] = await conn.query('SELECT scope, account_owner_id FROM checklist_sections WHERE id = ?', [id]);
      return r;
    };

    // ---- 1. DRY RUN writes nothing ----
    const dry = run({}, ['--report']);
    ok(/REPORT ONLY\. Nothing was written\./.test(dry), 'dry run says it wrote nothing', dry.slice(-200));
    ok(/Guard: zero personal pads in the plan/.test(dry), 'dry run runs the personal-pad guard', '');
    ok(/Job\/lead pads still at private:\s+3/.test(dry), 'dry run finds exactly the 3 legacy job/lead pads', dry.slice(0, 400));
    for (const id of [1, 2, 3]) {
      ok((await scopeOf(id)).scope === 'private', 'dry run left id=' + id + ' private IN THE TABLE', '');
    }

    // ---- 2. the plan names no personal pad ----
    ok(!/"No Job Assigned"/.test(dry) && !/"My Notepad"/.test(dry) && !/"Shopping List"/.test(dry),
      'THE RULE: no personal pad appears anywhere in the plan', dry);

    // ---- 3. --apply without the flag refuses ----
    let refused = '';
    try { refused = run({}, ['--apply']); } catch (e) { refused = String(e.stdout || '') + String(e.stderr || ''); }
    ok(/requires NOTEPAD_BACKFILL_ARMED=1/.test(refused), 'unarmed --apply refuses', refused.slice(-200));
    ok((await scopeOf(1)).scope === 'private', 'and wrote nothing', '');

    // ---- 4. armed apply ----
    const applied = run({ NOTEPAD_BACKFILL_ARMED: '1' }, ['--apply']);
    ok(/Rows written: 3\b/.test(applied), 'armed run reports 3 rows WRITTEN (not intended)', applied.slice(-400));

    for (const id of [1, 2, 3]) {
      const r = await scopeOf(id);
      ok(r.scope === 'company', 'id=' + id + ' is company IN THE TABLE', JSON.stringify(r));
      ok(Number(r.account_owner_id) === 700,
        'id=' + id + ' has account_owner_id set EXPLICITLY, so the COALESCE stops being load-bearing',
        JSON.stringify(r));
    }

    // ---- 5. personal pads untouched, checked by title across ALL users ----
    const [personal] = await conn.query(
      `SELECT id, title, owner_user_id, scope FROM checklist_sections
        WHERE title IN ('No Job Assigned','My Notepad','Shopping List')`);
    ok(personal.length === 5, 'all five personal pads still present', JSON.stringify(personal));
    ok(personal.every((r) => r.scope === 'private'),
      'THE RULE HELD: every No Job Assigned / My Notepad / Shopping List is still private',
      JSON.stringify(personal.filter((r) => r.scope !== 'private')));

    const [anyPersonalCompany] = await conn.query(
      "SELECT id, title FROM checklist_sections WHERE job_id IS NULL AND lead_id IS NULL AND scope = 'company'");
    ok(anyPersonalCompany.length === 0,
      'and no pad without a job or lead is company-scoped, by any title',
      JSON.stringify(anyPersonalCompany));

    // ---- 6. idempotent ----
    const second = run({ NOTEPAD_BACKFILL_ARMED: '1' }, ['--apply']);
    ok(/Rows written: 0\b/.test(second), 'a second armed run writes ZERO rows', second.slice(-300));
    ok(/Job\/lead pads still at private:\s+0/.test(second), 'because the plan is now empty', '');

    // ---- 7. the already-company pad was never rewritten ----
    const r9 = await scopeOf(9);
    ok(r9.scope === 'company' && Number(r9.account_owner_id) === 700,
      'the pad that was already company is unchanged', JSON.stringify(r9));

    // ---- 8. the hub clause can now match, which is the whole point ----
    // Expressed the way notepadHub.js expresses it, against the stored rows.
    const [visibleToJoshua] = await conn.query(
      `SELECT id, title FROM checklist_sections s
        WHERE s.owner_user_id = 710
           OR (s.scope = 'company' AND COALESCE(s.account_owner_id, s.owner_user_id) = 700)
        ORDER BY id`);
    const titles = visibleToJoshua.map((r) => r.title);
    ok(titles.includes('Lynes - ADU') && titles.includes('Frantz - HOME'),
      'an allowlisted admin now resolves the legacy job pads', JSON.stringify(titles));
    ok(!titles.includes('Shopping List') || visibleToJoshua.find((r) => r.title === 'Shopping List').id === 7,
      'and the only Shopping List he sees is HIS OWN', JSON.stringify(visibleToJoshua));
    ok(!titles.some((t, i) => t === 'My Notepad' && visibleToJoshua[i].id === 5),
      "and NOT Poul's personal My Notepad", JSON.stringify(visibleToJoshua));

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
