'use strict';
// Real-MySQL PRIVACY test for GET tasks/company_calendar. Runs the EXACT WHERE
// clause from the route against seeded rows and asserts which tasks each viewer
// sees — the security-critical property is that a jobless self-assigned task
// never leaks to another account member, while real job tasks stay company-wide.
// node test/verify-company-calendar.js
let pass = 0, fail = 0; const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const setEq = (a, b) => { const A = new Set(a), B = new Set(b); return A.size === B.size && [...A].every((x) => B.has(x)); };

// The EXACT visibility WHERE from routes/tasks.js GET /company_calendar.
const WHERE = `
  WHERE jt.start_date IS NOT NULL
    AND jt.task_type IN ('job','task')
    AND jt.archived_at IS NULL
    AND jt.created_by IN (SELECT id FROM \`user\` WHERE id = ? OR created_by = ?)
    AND (
         (jt.job_id IS NOT NULL AND jt.job_id <> 0)
         OR jt.created_by = ?
         OR NOT (
              jt.team_id IS NULL
              AND jt.user_id IS NOT NULL
              AND jt.user_id = jt.created_by
              AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = jt.id AND ta.user_id <> jt.created_by)
         )
    )`;

(async () => {
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_compcal', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName });

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, role INT, category INT, created_by INT NULL)");
    await conn.query(`CREATE TABLE tasks (
      id INT PRIMARY KEY, task_name VARCHAR(190), user_id INT NULL, team_id INT NULL, job_id INT NULL,
      start_date DATETIME NULL, end_date DATETIME NULL, task_type VARCHAR(20), is_calendar_task TINYINT DEFAULT 0,
      archived_at DATETIME NULL, created_by INT NULL)`);
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT)");

    // Account root 74; members 74(owner), 86(Poul login), 90(employee E). Outsider account 200.
    await conn.query("INSERT INTO `user`(id,role,category,created_by) VALUES (74,14,4,NULL),(86,3,1,74),(90,2,1,74),(91,2,1,74),(200,14,4,NULL)");

    const D = "'2026-08-22 09:00:00'";
    const rows = [
      // id, name, user_id, team_id, job_id, start?, type, archived?, created_by
      `(1,'T1 job',90,NULL,10,${D},'job',NULL,86)`,           // job task, company-visible
      `(2,'T2 jobless unassigned',NULL,NULL,NULL,${D},'task',NULL,86)`, // jobless, no assignee → visible
      `(3,'T3 jobless self E90',90,NULL,NULL,${D},'task',NULL,90)`,     // private to 90
      `(4,'T4 jobless self Poul86',86,NULL,NULL,${D},'task',NULL,86)`,  // private to 86
      `(5,'T5 jobless broadcast',90,NULL,NULL,${D},'task',NULL,90)`,    // self + other assignee → not private
      `(6,'T6 lead',86,NULL,10,${D},'lead',NULL,86)`,          // excluded (lead)
      `(7,'T7 no date',86,NULL,NULL,NULL,'task',NULL,86)`,     // excluded (no start_date)
      `(8,'T8 archived',90,NULL,10,${D},'job','2026-08-20 00:00:00',86)`, // excluded (archived)
      `(9,'T9 outsider',200,NULL,99,${D},'job',NULL,200)`,     // excluded from account (created_by 200)
      `(10,'T10 job self E90',90,NULL,10,${D},'job',NULL,90)`, // job self-assigned → still company-visible
    ];
    await conn.query(`INSERT INTO tasks (id,task_name,user_id,team_id,job_id,start_date,task_type,archived_at,created_by) VALUES ${rows.join(',')}`);
    // T5 has a SECOND assignee (91) → broadcast, not a private personal task.
    await conn.query("INSERT INTO task_assignees (task_id,user_id) VALUES (3,90),(4,86),(5,90),(5,91)");

    const visibleFor = async (ownerId, meId) => {
      const [r] = await conn.query(`SELECT jt.id FROM tasks jt ${WHERE} ORDER BY jt.id`, [ownerId, ownerId, meId]);
      return r.map((x) => x.id);
    };

    // Viewer Poul (login 86, account owner 74)
    const poul = await visibleFor(74, 86);
    ok(setEq(poul, [1, 2, 4, 5, 10]), 'Poul (86) sees job/jobless-own/broadcast/unassigned; NOT E90 private, lead, no-date, archived, outsider', JSON.stringify(poul));
    ok(!poul.includes(3), 'PRIVACY: Poul does NOT see employee E90 self-assigned jobless task (no leak)', JSON.stringify(poul));
    ok(poul.includes(10), 'Real job task self-assigned by E90 IS visible to Poul (company-wide, not over-hidden)');
    ok(poul.includes(4), 'Poul sees his OWN jobless self-assigned task');

    // Viewer employee E (login 90, account owner 74)
    const e = await visibleFor(74, 90);
    ok(setEq(e, [1, 2, 3, 5, 10]), 'E (90) sees own private + shared/job tasks; NOT Poul-86 private', JSON.stringify(e));
    ok(!e.includes(4), 'PRIVACY: E does NOT see Poul-86 self-assigned jobless task (no leak)', JSON.stringify(e));
    ok(e.includes(3), 'E sees his OWN jobless self-assigned task');

    // Excluded-for-everyone checks
    ok(!poul.includes(6) && !e.includes(6), 'lead task excluded');
    ok(!poul.includes(7) && !e.includes(7), 'task with no date excluded');
    ok(!poul.includes(8) && !e.includes(8), 'archived task excluded');
    ok(!poul.includes(9) && !e.includes(9), 'another account\'s task excluded');
    ok(poul.includes(5) && e.includes(5), 'jobless BROADCAST (self + other assignee) is company-visible, not private');

    // Outsider account (200) sees only its own task
    const out = await visibleFor(200, 200);
    ok(setEq(out, [9]), 'Outsider account sees ONLY its own task (9), none of the 74-account tasks', JSON.stringify(out));

    console.log(`\n${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally { try { if (conn) await conn.end(); } catch {} try { if (db && db.stop) await db.stop(); } catch {} }
})();
