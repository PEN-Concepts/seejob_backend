'use strict';

/**
 * Schema for the Notepad-as-boss-task-manager rebuild (CCP 2026-09-08).
 *
 * Everything here is additive and idempotent, in the same style as
 * services/dbMigrations.js — a cold boot on an un-migrated database must never
 * throw, and a warm boot must be a no-op.
 *
 * What the rebuild needs that main does not have:
 *   notepad_access            — the GLOBAL allowlist (§6). Two states only.
 *   checklist_sections.*      — lead_id / origin / scope / account_owner_id, so
 *                               a pad can be an AUTO company pad, an AUTO
 *                               private pad, or a hand-made pad.
 *   checklist_section_shares  — per-notepad live share, hand-made pads only (§9).
 *   checklist_section_order   — per-USER card order (§4), because company pads
 *                               are shared and a per-section order cannot be
 *                               per-user.
 *   notepad_merge_queue       — the employee half of the two-step merge (§8).
 *   notepad_merge_log         — who / how many rows / which notepads (§8).
 *   check_list.delegated_*    — links a notepad row to the task it became, so
 *                               the pill can read the assignee's signal (§3).
 *   task_notes                — the two-way note thread on a task (§10).
 *   tasks.starred_at          — star ORDER, so "newest star goes to the very
 *                               top" is expressible (§10).
 */

let ensured = false;

async function hasColumn(connection, table, column) {
  const [rows] = await connection.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}

async function addColumn(connection, table, column, definition) {
  if (await hasColumn(connection, table, column)) return;
  await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function addIndex(connection, sql) {
  try {
    await connection.query(sql);
  } catch (e) {
    // Duplicate key name — already there. Anything else is worth knowing but is
    // never fatal: an index is an optimisation, not a correctness requirement.
    if (!/Duplicate key name/i.test(String(e && e.message))) {
      // eslint-disable-next-line no-console
      console.error('notepadSchema index:', e && e.message);
    }
  }
}

async function ensureNotepadSchema(connection) {
  if (ensured) return;

  // Each step runs in isolation. A step that fails must not abort the others:
  // on a partial or legacy schema (or a test harness that only creates the
  // tables it needs) `SHOW COLUMNS FROM tasks` throws, and without this the
  // allowlist tables would silently never get created either. We only cache the
  // "done" flag when EVERY step succeeded, so a genuinely missing table is
  // retried on the next request rather than skipped forever.
  let allOk = true;
  const run = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      allOk = false;
      // eslint-disable-next-line no-console
      console.error(`notepadSchema[${label}]:`, e && e.message);
    }
  };

  // ── §6 the global allowlist. TWO STATES ONLY: a row exists (full access) or
  // it does not (own notepads only). There is deliberately no "level" column —
  // adding one would create the middle tier the spec forbids.
  await run('notepad_access', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS notepad_access (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_user_id INT NOT NULL,
        user_id INT NOT NULL,
        granted_by INT NULL,
        granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_np_access (owner_user_id, user_id),
        KEY idx_np_access_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §5/§7 what kind of pad this is.
  //   origin 'auto'   = created by the system for a job/lead. Never shareable (§9).
  //   origin 'manual' = hand-made. The ONLY kind that gets a share icon.
  //   scope  'company'= the single pad all full-access users collaborate in (§7).
  //   scope  'private'= one person's own pad.
  // account_owner_id is the resolved account (see QUESTIONS #1) so a company pad
  // can be found without walking back through the creator every time.
  await run('checklist_sections columns', async () => {
    await addColumn(connection, 'checklist_sections', 'lead_id', 'INT NULL DEFAULT NULL');
    await addColumn(connection, 'checklist_sections', 'origin', "VARCHAR(8) NOT NULL DEFAULT 'manual'");
    await addColumn(connection, 'checklist_sections', 'scope', "VARCHAR(8) NOT NULL DEFAULT 'private'");
    await addColumn(connection, 'checklist_sections', 'account_owner_id', 'INT NULL DEFAULT NULL');
    await addIndex(
      connection,
      'ALTER TABLE checklist_sections ADD INDEX idx_cs_auto (account_owner_id, origin, scope, job_id, lead_id)',
    );
  });

  // ── §9 per-notepad live share. A row grants LIVE access (not a snapshot) to
  // one person. invited_email carries a not-yet-joined client so the invite can
  // be resent; user_id is 0 until they join.
  await run('checklist_section_shares', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS checklist_section_shares (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_id INT NOT NULL,
        user_id INT NOT NULL DEFAULT 0,
        invited_email VARCHAR(255) NULL,
        is_client TINYINT NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_sec_share (section_id, user_id, invited_email),
        KEY idx_sec_share_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §4 per-user card order. Saved ON DROP, so it survives navigation, an app
  // restart, and a different device under the same login.
  await run('checklist_section_order', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS checklist_section_order (
        user_id INT NOT NULL,
        section_id INT NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, section_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §8 step 2. The owner's grant only ENQUEUES; the employee's Continue runs
  // it. status: pending -> done | cancelled.
  await run('notepad_merge_queue', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS notepad_merge_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_user_id INT NOT NULL,
        employee_user_id INT NOT NULL,
        item_count INT NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME NULL,
        KEY idx_merge_pending (employee_user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §8 "Log every merge: who, how many rows, which notepads." dry_run=1 rows
  // are the gated build's output — they record what WOULD have moved.
  await run('notepad_merge_log', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS notepad_merge_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_user_id INT NOT NULL,
        employee_user_id INT NOT NULL,
        from_section_id INT NULL,
        to_section_id INT NULL,
        rows_moved INT NOT NULL DEFAULT 0,
        item_ids TEXT NULL,
        dry_run TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_merge_log_owner (owner_user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §3 the delegation link. delegated_task_id points at the tasks row the
  // notepad item became; delegated_to is the assignee whose FIRST NAME the green
  // pill shows. Both NULL = state (a) "not delegated".
  await run('check_list delegation columns', async () => {
    await addColumn(connection, 'check_list', 'delegated_task_id', 'INT NULL DEFAULT NULL');
    await addColumn(connection, 'check_list', 'delegated_to', 'INT NULL DEFAULT NULL');
    await addIndex(connection, 'ALTER TABLE check_list ADD INDEX idx_cl_delegated (delegated_task_id)');
  });

  // ── C9b: a note ON THE ROW ITSELF.
  //
  // The two-way thread in task_notes only exists once a row has been
  // delegated and become a task. A plain notepad line had nowhere to keep a
  // note at all, so there was nothing for the paperclip indicator to report.
  // Additive TEXT column, nullable — nothing existing changes meaning.
  await run('check_list note column', async () => {
    await addColumn(connection, 'check_list', 'note', 'TEXT NULL DEFAULT NULL');
  });

  // ── C9c: photos on a notepad row.
  //
  // check_list.photo is a single VARCHAR(255) filename and cannot hold a set.
  // Rather than overload it, a proper child table: many images per row, each
  // knowing who added it and when, so a thumbnail strip and a full-size
  // viewer both have something honest to read.
  await run('checklist_item_images', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS checklist_item_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        filename VARCHAR(255) NOT NULL,
        uploaded_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cli_item (item_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── C19: the row note becomes a THREAD.
  //
  // check_list.note was a single TEXT field — one person, one note, no way to
  // reply. The owner asked for a conversation, so notes get their own table
  // with an author and a timestamp per message.
  //
  // task_notes could not be reused: it is keyed on task_id and a notepad row
  // that has never been delegated has no task. The old note column stays put
  // and is migrated in on first read, so nothing already typed is lost.
  await run('checklist_item_notes', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS checklist_item_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        user_id INT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cln_item (item_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── C25: PLANS BELONG TO THE NOTEPAD, NOT THE TASK.
  //
  // A plan set is about the whole job, not one line of it — attaching it per
  // task meant the same PDF hanging off six rows. It moves up to the section,
  // where one link serves every task on the pad.
  //
  // Still a LINK to job_documents, never a copy: plans are versioned in the
  // job Files and a duplicate would drift from whatever the job holds.
  await run('checklist_section_files', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS checklist_section_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_id INT NOT NULL,
        job_document_id INT NOT NULL,
        added_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_csf (section_id, job_document_id),
        INDEX idx_csf_section (section_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── C35: a LEAD has files too, and a lead notepad needs its plans.
  //
  // Lead documents live in lead_documents, a different table from
  // job_documents, so the link needs its own column rather than a shared
  // id that could mean either. job_document_id becomes nullable: a row now
  // carries exactly one of the two.
  await run('checklist_section_files lead column', async () => {
    await addColumn(connection, 'checklist_section_files', 'lead_document_id', 'INT NULL DEFAULT NULL');
    try {
      await connection.query('ALTER TABLE checklist_section_files MODIFY job_document_id INT NULL DEFAULT NULL');
    } catch (e) {
      /* already nullable */
    }
    await addIndex(connection, `ALTER TABLE checklist_section_files ADD UNIQUE KEY uq_csf_lead (section_id, lead_document_id)`);
  });

  // ── C24: an attachment is not always a photograph.
  //
  // A set of plans or a spec PDF belongs on the same row as the pictures —
  // the field crew opens whichever is relevant. Storing the mime type lets
  // the client draw a thumbnail for an image and a document tile for a PDF
  // instead of guessing from the file extension.
  await run('checklist_item_images mime column', async () => {
    await addColumn(connection, 'checklist_item_images', 'mime', 'VARCHAR(100) NULL DEFAULT NULL');
    await addColumn(connection, 'checklist_item_images', 'original_name', 'VARCHAR(255) NULL DEFAULT NULL');
    // C24: a LINK to an existing job document, not a copy of it. Plans live in
    // the job's Files and are versioned there; duplicating a 40MB plan set
    // onto a notepad row would leave two files that drift apart. When this is
    // set, filename/mime/original_name are only a display cache.
    await addColumn(connection, 'checklist_item_images', 'job_document_id', 'INT NULL DEFAULT NULL');
  });

  // ── §10 the two-way note thread. Author + date per note, both directions.
  await run('task_notes', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS task_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        user_id INT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_task_notes_task (task_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── §10 star ORDER. A boolean cannot express "newest star goes to the very
  // top"; a timestamp can.
  await run('tasks.starred_at', async () => {
    await addColumn(connection, 'tasks', 'starred_at', 'DATETIME NULL DEFAULT NULL');
    await addIndex(connection, 'ALTER TABLE tasks ADD INDEX idx_tasks_starred (starred_at)');
  });

  // ── §5 "Link the notepad to the owner/client in the background. Do not
  // surface that in the UI yet." The client is derivable from the joined job,
  // but derivable is not linked: a job's client can change, and a lead pad has
  // no job at all. Store it, populate it, surface nothing.
  await run('checklist_sections.client_user_id', async () => {
    await addColumn(connection, 'checklist_sections', 'client_user_id', 'INT NULL DEFAULT NULL');
    await addColumn(connection, 'checklist_sections', 'owner_contact_id', 'INT NULL DEFAULT NULL');
  });

  // ── Migration-policy rule 9: "Destructive jobs log what they did, in a place
  // the owner can read." A file on the EC2 box and a raw table are not that.
  // This is the one table the owner-facing Activity view reads, so every gated
  // job — armed or dry-run — lands somewhere reachable from the UI.
  await run('destructive_job_log', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS destructive_job_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_owner_id INT NULL,
        kind VARCHAR(32) NOT NULL,
        actor_user_id INT NULL,
        summary VARCHAR(500) NOT NULL,
        detail MEDIUMTEXT NULL,
        rows_affected INT NOT NULL DEFAULT 0,
        dry_run TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_djl_account (account_owner_id, created_at),
        KEY idx_djl_kind (kind, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  if (allOk) ensured = true;
}

/** Test seam — lets a suite re-run the migration against a fresh database. */
function resetNotepadSchemaCache() {
  ensured = false;
}

module.exports = { ensureNotepadSchema, resetNotepadSchemaCache };
