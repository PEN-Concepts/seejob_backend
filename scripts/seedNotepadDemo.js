/**
 * CCP verification seed — "Seed data covers every state: delegated,
 * checked-by-assignee, starred, note-only, photo-only, both, completed, lead,
 * shared, client-shared, full-access user, off-list user."
 *
 * ============================ READ THIS FIRST =============================
 * This WRITES demo rows. It refuses to run unless you point it at a database
 * that is clearly not production:
 *
 *   - NODE_ENV must not be 'production', AND
 *   - SEED_NOTEPAD_DEMO=1 must be set.
 *
 * It was NOT run as part of the build that added it. It exists so Poul (or
 * anyone) can stand the feature up locally and click through every state
 * without hand-crafting data.
 *
 *   NODE_ENV=development SEED_NOTEPAD_DEMO=1 node scripts/seedNotepadDemo.js
 *   NODE_ENV=development SEED_NOTEPAD_DEMO=1 node scripts/seedNotepadDemo.js --wipe
 *
 * --wipe removes anything a previous seed run created (everything it makes is
 * tagged with the CCP_DEMO marker below) before re-seeding.
 * ==========================================================================
 */

const pool = require('../config/connection');
const { ensureNotepadSchema } = require('../services/notepadSchema');

const MARKER = '[ccp-demo]';
const ARMED = String(process.env.SEED_NOTEPAD_DEMO || '') === '1';
const IS_PROD = String(process.env.NODE_ENV || '') === 'production';
const WIPE = process.argv.includes('--wipe');

// Fixed ids well above anything a real install is likely to hold, so a wipe can
// be exact and a re-run is idempotent.
const U = { owner: 990001, full: 990002, off: 990003, client: 990004, sub: 990005 };
const J = { alpha: 990101, beta: 990102 };
const L = { lead: 990201 };

async function main() {
  if (IS_PROD) {
    console.error('REFUSING: NODE_ENV=production. This script writes demo data.');
    process.exitCode = 1;
    return;
  }
  if (!ARMED) {
    console.error('REFUSING: set SEED_NOTEPAD_DEMO=1 to confirm you want demo rows written.');
    process.exitCode = 1;
    return;
  }

  const c = await pool.getConnection();
  try {
    await ensureNotepadSchema(c);

    if (WIPE) {
      console.log('wiping previous demo rows…');
      await c.query('DELETE FROM check_list WHERE section_id IN (SELECT id FROM checklist_sections WHERE owner_user_id IN (?,?,?))', [U.owner, U.full, U.off]);
      await c.query('DELETE FROM checklist_section_shares WHERE created_by IN (?,?,?)', [U.owner, U.full, U.off]);
      await c.query('DELETE FROM checklist_section_order WHERE user_id IN (?,?,?)', [U.owner, U.full, U.off]);
      await c.query('DELETE FROM checklist_sections WHERE owner_user_id IN (?,?,?)', [U.owner, U.full, U.off]);
      await c.query('DELETE FROM notepad_access WHERE owner_user_id = ?', [U.owner]);
      await c.query('DELETE FROM notepad_merge_queue WHERE owner_user_id = ?', [U.owner]);
      await c.query('DELETE FROM notepad_merge_log WHERE owner_user_id = ?', [U.owner]);
      await c.query('DELETE FROM task_notes WHERE task_id IN (SELECT id FROM tasks WHERE created_by IN (?,?))', [U.owner, U.full]);
      await c.query('DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE created_by IN (?,?))', [U.owner, U.full]);
      await c.query('DELETE FROM tasks_images WHERE task_id IN (SELECT id FROM tasks WHERE created_by IN (?,?))', [U.owner, U.full]);
      await c.query('DELETE FROM tasks WHERE created_by IN (?,?)', [U.owner, U.full]);
      await c.query('DELETE FROM `job` WHERE id IN (?,?)', [J.alpha, J.beta]);
      await c.query('DELETE FROM leads WHERE id = ?', [L.lead]);
      await c.query('DELETE FROM `user` WHERE id IN (?,?,?,?,?)', Object.values(U));
    }

    // ── people ────────────────────────────────────────────────────────────
    // owner (GC) · a FULL-ACCESS employee · an OFF-LIST employee · a client ·
    // a subcontractor (present so the share endpoint's rejection is clickable).
    const [[famRow]] = await c.query(
      "SELECT id FROM subcategory WHERE category_id = 1 AND name = 'Family/Friend' LIMIT 1",
    );
    const fam = famRow ? famRow.id : null;
    await c.query(
      `INSERT INTO \`user\` (id, name, email, role, category, subcategory, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,NOW()), (?,?,?,?,?,?,?,NOW()), (?,?,?,?,?,?,?,NOW()),
              (?,?,?,?,?,?,?,NOW()), (?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        U.owner, `Demo Owner ${MARKER}`, 'ccp-owner@example.test', 14, null, null, null,
        U.full, `Joshua Fullaccess ${MARKER}`, 'ccp-josh@example.test', 2, 1, null, U.owner,
        U.off, `Bill Offlist ${MARKER}`, 'ccp-bill@example.test', 2, 1, fam, U.owner,
        U.client, `Clara Client ${MARKER}`, 'ccp-clara@example.test', 2, 3, null, U.owner,
        U.sub, `Sam Subcontractor ${MARKER}`, 'ccp-sam@example.test', 12, 2, null, U.owner,
      ],
    );

    // ── a JOB (gold border) and a LEAD (blue border) ──────────────────────
    await c.query(
      `INSERT INTO \`job\` (id, created_by, name, status, color, job_address, job_city, job_state, job_zipcode)
       VALUES (?,?,?,1,'#7a9e7e','12 Maple St','Ojai','CA','93023'),
              (?,?,?,1,'#9e7a7a','480 Ridge Rd','Ojai','CA','93023')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [J.alpha, U.owner, `Maple St Remodel ${MARKER}`, J.beta, U.owner, `Ridge Rd Addition ${MARKER}`],
    );
    await c.query(
      `INSERT INTO leads (id, user_id, lead_name, project_street_address)
       VALUES (?,?,?,'7 Oak Ave')
       ON DUPLICATE KEY UPDATE lead_name = VALUES(lead_name)`,
      [L.lead, U.owner, `Oak Ave Bid ${MARKER}`],
    );

    // ── access: Joshua ON the list, Bill OFF it ───────────────────────────
    await c.query(
      'INSERT IGNORE INTO notepad_access (owner_user_id, user_id, granted_by) VALUES (?,?,?)',
      [U.owner, U.full, U.owner],
    );

    // ── notepads ──────────────────────────────────────────────────────────
    // Company pads for the job + lead, a hand-made pad (the only shareable
    // kind), and one PRIVATE pad for the off-list employee so the merge prompt
    // has something to move.
    const pad = async (owner, title, jobId, leadId, origin, scope) => {
      const [[hit]] = await c.query(
        `SELECT id FROM checklist_sections
          WHERE owner_user_id = ? AND title = ? AND origin = ? AND scope = ? LIMIT 1`,
        [owner, title, origin, scope],
      );
      if (hit) return hit.id;
      const [r] = await c.query(
        `INSERT INTO checklist_sections
           (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
         VALUES (?, NULL, 'task', ?, 0, ?, ?, ?, ?, ?)`,
        [owner, title, jobId, leadId, origin, scope, U.owner],
      );
      return r.insertId;
    };

    const jobPad = await pad(U.owner, `Maple St Remodel ${MARKER}`, J.alpha, null, 'auto', 'company');
    const leadPad = await pad(U.owner, `Oak Ave Bid ${MARKER}`, null, L.lead, 'auto', 'company');
    const handPad = await pad(U.owner, `Hardware run ${MARKER}`, null, null, 'manual', 'private');
    const billPad = await pad(U.off, `Maple St Remodel ${MARKER}`, J.alpha, null, 'auto', 'private');

    // ── notepad rows, one per delegate state ──────────────────────────────
    const row = async (sectionId, name, createdBy, status, priority) => {
      const [[hit]] = await c.query(
        'SELECT id FROM check_list WHERE section_id = ? AND name = ? LIMIT 1',
        [sectionId, name],
      );
      if (hit) return hit.id;
      const [r] = await c.query(
        `INSERT INTO check_list (section_id, name, created_by, status, priority, type, due_date)
         VALUES (?,?,?,?,?, 'task', NOW())`,
        [sectionId, name, createdBy, status, priority],
      );
      return r.insertId;
    };

    const notDelegated = await row(jobPad, 'Order the windows', U.owner, 'new', 'low');
    const starred = await row(jobPad, 'STARRED — call the inspector', U.owner, 'new', 'high');
    const byOther = await row(jobPad, 'Added by Joshua (author byline)', U.full, 'new', 'low');
    const completed = await row(jobPad, 'COMPLETED — permit collected', U.owner, 'completed', 'low');
    const delegatedRow = await row(jobPad, 'DELEGATED — frame the deck', U.owner, 'new', 'low');
    const doneRow = await row(jobPad, 'ASSIGNEE CHECKED OFF — pour footings', U.owner, 'new', 'low');
    await row(leadPad, 'Measure the site', U.owner, 'new', 'low');
    await row(handPad, 'Box of 3in screws', U.owner, 'new', 'low');
    await row(billPad, 'Private note Bill has not shared', U.off, 'new', 'low');

    // ── tasks behind the delegated rows, plus the My Tasks states ─────────
    const task = async (name, assignee, jobId, opts = {}) => {
      const [[hit]] = await c.query('SELECT id FROM tasks WHERE task_name = ? LIMIT 1', [name]);
      if (hit) return hit.id;
      const [r] = await c.query(
        `INSERT INTO tasks
           (task_name, user_id, duration_days, start_date, end_date, job_id, created_at, created_by,
            task_type, is_calendar_task, is_appointment_task, priority, status, assignee_completed, starred_at)
         VALUES (?,?,1,NOW(),NOW(),?,NOW(),?, 'job',0,0,?,?,?,?)`,
        [
          name, assignee, jobId, opts.createdBy || U.owner,
          opts.starred ? 'high' : 'low',
          opts.status || 0,
          opts.assigneeDone ? 1 : 0,
          opts.starred ? new Date() : null,
        ],
      );
      await c.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [r.insertId, assignee]);
      return r.insertId;
    };

    const tDelegated = await task(`Frame the deck ${MARKER}`, U.full, J.alpha);
    await c.query('UPDATE check_list SET delegated_task_id = ?, delegated_to = ? WHERE id = ?', [tDelegated, U.full, delegatedRow]);

    const tDone = await task(`Pour footings ${MARKER}`, U.full, J.alpha, { assigneeDone: true });
    await c.query('UPDATE check_list SET delegated_task_id = ?, delegated_to = ? WHERE id = ?', [tDone, U.full, doneRow]);

    // My Tasks indicator states: note-only, photo-only, both, starred, completed.
    const tNote = await task(`NOTE ONLY — check the survey ${MARKER}`, U.full, J.alpha);
    const tPhoto = await task(`PHOTO ONLY — snap the panel ${MARKER}`, U.full, J.beta);
    const tBoth = await task(`NOTE + PHOTO — punch list ${MARKER}`, U.full, J.beta);
    await task(`STARRED — call the sub back ${MARKER}`, U.full, J.beta, { starred: true });
    await task(`COMPLETED — deliver lumber ${MARKER}`, U.full, J.beta, { status: 1, assigneeDone: true });
    await task(`SELF-ASSIGNED — order dumpster ${MARKER}`, U.full, J.alpha, { createdBy: U.full });

    const note = async (taskId, userId, body) => {
      const [[hit]] = await c.query('SELECT id FROM task_notes WHERE task_id = ? AND body = ? LIMIT 1', [taskId, body]);
      if (hit) return;
      await c.query('INSERT INTO task_notes (task_id, user_id, body) VALUES (?,?,?)', [taskId, userId, body]);
    };
    await note(tNote, U.owner, 'Survey is in the truck — check it before you start.');
    await note(tBoth, U.owner, 'Walk it with the client on Friday.');
    await note(tBoth, U.full, 'Will do. Two items already fixed.');
    await note(tDelegated, U.owner, 'Measure first.');

    const img = async (taskId, file) => {
      const [[hit]] = await c.query('SELECT id FROM tasks_images WHERE task_id = ? AND file_name = ? LIMIT 1', [taskId, file]);
      if (hit) return;
      await c.query(
        `INSERT INTO tasks_images (task_id, file_path, file_name, kind, uploaded_by) VALUES (?, '/uploads/', ?, 'request', ?)`,
        [taskId, file, U.owner],
      );
    };
    await img(tPhoto, 'ccp-demo-panel.jpg');
    await img(tBoth, 'ccp-demo-punch.jpg');

    // ── shares: one employee (live) and one CLIENT (card marker) ──────────
    await c.query(
      `INSERT IGNORE INTO checklist_section_shares (section_id, user_id, is_client, created_by)
       VALUES (?,?,0,?), (?,?,1,?)`,
      [handPad, U.full, U.owner, handPad, U.client, U.owner],
    );

    // ── a PENDING merge, so the employee prompt is clickable ──────────────
    const [[pending]] = await c.query(
      `SELECT id FROM notepad_merge_queue WHERE owner_user_id = ? AND employee_user_id = ? AND status = 'pending' LIMIT 1`,
      [U.owner, U.off],
    );
    if (!pending) {
      await c.query(
        'INSERT INTO notepad_merge_queue (owner_user_id, employee_user_id, item_count) VALUES (?,?,1)',
        [U.owner, U.off],
      );
    }

    console.log('seeded.');
    console.log('  owner (account owner, sees Manage access):', U.owner, 'ccp-owner@example.test');
    console.log('  FULL-ACCESS employee (can delegate):      ', U.full, 'ccp-josh@example.test');
    console.log('  OFF-LIST employee (gets the merge prompt):', U.off, 'ccp-bill@example.test');
    console.log('  client (share marker):                    ', U.client);
    console.log('  subcontractor (share must reject):        ', U.sub);
    console.log('  job pad', jobPad, '· lead pad', leadPad, '· hand-made pad', handPad, '· Bill private pad', billPad);
    console.log('\nStates covered: not-delegated, delegated, assignee-checked-off, starred,');
    console.log('completed, author-byline, note-only, photo-only, both, self-assigned,');
    console.log('lead pad, client-shared pad, full-access user, off-list user, pending merge.');
  } catch (err) {
    console.error('seedNotepadDemo failed:', err && err.message);
    process.exitCode = 1;
  } finally {
    c.release();
    try { await pool.end(); } catch (e) { /* ignore */ }
  }
}

main();
