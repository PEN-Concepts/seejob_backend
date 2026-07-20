"use strict";

/**
 * Account cascade-delete for the Admin "Plan & Payment Status" page.
 *
 * Owner-only feature (gated by requireAdmin at the route). Deletes an entire
 * account — everything the target user owns/created — while:
 *   - DETACHING real employee logins into independent accounts on a fresh
 *     60-day trial (owner decision 1), never deleting a human's login;
 *   - STRIPPING the target's side of any cross-user reference (delegated tasks,
 *     appointments, notifications, contacts, team membership, job contacts, …)
 *     WITHOUT deleting the other party's data;
 *   - deleting placeholder sub-users (contacts/clients/subs with no password —
 *     these are the owner's data, not separate humans).
 *
 * Instant/permanent (owner decision 3): no soft-delete. Everything runs inside a
 * single transaction owned by the caller, because FKs to `user` are app-enforced
 * (see Project-Context Decision Log) — a partial delete would corrupt integrity.
 *
 * The statement runner tolerates ER_NO_SUCH_TABLE (1146) so environments missing
 * a legacy table don't fail the whole cascade; every OTHER error propagates so the
 * caller's transaction rolls back (fail closed — never a partial delete).
 */

// Run a statement; swallow "table doesn't exist", surface everything else.
async function run(conn, sql, params = []) {
  try {
    const [r] = await conn.query(sql, params);
    return (r && r.affectedRows) || 0;
  } catch (e) {
    if (e && e.errno === 1146) return 0; // ER_NO_SUCH_TABLE
    throw e;
  }
}

async function count(conn, sql, params = []) {
  try {
    const [rows] = await conn.query(sql, params);
    return rows && rows[0] ? Number(rows[0].c || 0) : 0;
  } catch (e) {
    if (e && e.errno === 1146) return 0;
    throw e;
  }
}

async function ids(conn, sql, params = []) {
  try {
    const [rows] = await conn.query(sql, params);
    return rows.map((r) => r.id);
  } catch (e) {
    if (e && e.errno === 1146) return [];
    throw e;
  }
}

/**
 * Dry-run: exact counts the confirmation step shows. Read-only.
 */
async function previewAccountDeletion(conn, targetId) {
  const id = Number(targetId);
  const [uRows] = await conn.query(
    "SELECT id, name, email, role, category, created_by FROM `user` WHERE id = ? LIMIT 1",
    [id]
  );
  if (!uRows.length) return null;
  const user = uRows[0];

  const [activeSubRows] = await conn.query(
    "SELECT id, authorize_subscription_id FROM subscriptions WHERE user_id = ? AND status = 'active'",
    [id]
  );

  const counts = {
    jobs: await count(conn, "SELECT COUNT(*) AS c FROM job WHERE created_by = ?", [id]),
    leads: await count(conn, "SELECT COUNT(*) AS c FROM leads WHERE user_id = ?", [id]),
    tasks: await count(conn, "SELECT COUNT(*) AS c FROM tasks WHERE created_by = ?", [id]),
    appointments: await count(conn, "SELECT COUNT(*) AS c FROM appointments WHERE created_by = ?", [id]),
    notepad_items: await count(conn, "SELECT COUNT(*) AS c FROM check_list WHERE created_by = ?", [id]),
    spartan_goals: await count(conn, "SELECT COUNT(*) AS c FROM spartan_goals WHERE user_id = ?", [id]),
    contacts: await count(
      conn,
      "SELECT COUNT(DISTINCT id) AS c FROM contact WHERE request_by = ? OR request_to = ? OR request_user1 = ? OR request_user2 = ?",
      [id, id, id, id]
    ),
    equipment: await count(conn, "SELECT COUNT(*) AS c FROM equipments WHERE created_by = ?", [id]),
    payment_methods: await count(conn, "SELECT COUNT(*) AS c FROM user_payment_methods WHERE user_id = ?", [id]),
  };

  // Employees (category 1, password set) are DETACHED, not deleted.
  const employeesToDetach = await count(
    conn,
    "SELECT COUNT(*) AS c FROM `user` WHERE created_by = ? AND category = 1 AND password IS NOT NULL AND password <> ''",
    [id]
  );
  // Placeholder sub-users (no password) ARE deleted with the account.
  const placeholderSubUsers = await count(
    conn,
    "SELECT COUNT(*) AS c FROM `user` WHERE created_by = ? AND (password IS NULL OR password = '')",
    [id]
  );

  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    is_employee: Number(user.category) === 1 && !!user.created_by,
    active_subscription_count: activeSubRows.length,
    active_subscription_arb_ids: activeSubRows.map((s) => s.authorize_subscription_id).filter(Boolean),
    employees_to_detach: employeesToDetach,
    placeholder_sub_users: placeholderSubUsers,
    counts,
  };
}

/**
 * Perform the cascade. MUST be called inside a transaction by the caller.
 * @param cancelArb optional async (arbId) => void to cancel a live ARB subscription.
 */
async function cascadeDeleteAccount(conn, targetId, opts = {}) {
  const id = Number(targetId);
  const cancelArb = opts.cancelArb || null;
  const result = { arb_canceled: [], employees_detached: 0, placeholder_deleted: 0, tables: {} };
  const tally = (k, n) => { if (n) result.tables[k] = (result.tables[k] || 0) + n; };

  // ── 0. Cancel live Authorize.Net subscriptions BEFORE removing the local rows ──
  if (cancelArb) {
    const [subs] = await conn.query(
      "SELECT authorize_subscription_id FROM subscriptions WHERE user_id = ? AND status = 'active' AND authorize_subscription_id IS NOT NULL",
      [id]
    );
    for (const s of subs) {
      await cancelArb(s.authorize_subscription_id); // caller decides error handling
      result.arb_canceled.push(s.authorize_subscription_id);
    }
  }

  // ── 1. Collect parent ids so children can be removed by parent key ──
  const jobIds = await ids(conn, "SELECT id FROM job WHERE created_by = ?", [id]);
  const leadIds = await ids(conn, "SELECT id FROM leads WHERE user_id = ?", [id]);
  const coIds = await ids(conn, "SELECT id FROM change_orders WHERE created_by_user_id = ?", [id]);
  const quoteIds = await ids(conn, "SELECT id FROM quotes WHERE created_by_user_id = ?", [id]);
  const taskIds = await ids(conn, "SELECT id FROM tasks WHERE created_by = ?", [id]);
  const inList = (arr) => arr.map(() => "?").join(",");

  // ── 2. Children of jobs (by job_id) ──
  if (jobIds.length) {
    const ph = inList(jobIds);
    tally("job_documents", await run(conn, `DELETE FROM job_documents WHERE job_id IN (${ph})`, jobIds));
    tally("stages", await run(conn, `DELETE FROM stages WHERE job_id IN (${ph})`, jobIds));
    tally("jobstages", await run(conn, `DELETE FROM jobstages WHERE job_id IN (${ph})`, jobIds));
    tally("materials", await run(conn, `DELETE FROM materials WHERE job_id IN (${ph})`, jobIds));
    tally("job_contacts", await run(conn, `DELETE FROM job_contacts WHERE job_id IN (${ph})`, jobIds));
    tally("daily_report", await run(conn, `DELETE FROM daily_report WHERE job_id IN (${ph})`, jobIds));
    tally("division_lineitems", await run(conn, `DELETE FROM division_lineitems WHERE job_id IN (${ph})`, jobIds));
  }
  // ── 3. Children of leads (by lead_id) ──
  if (leadIds.length) {
    const ph = inList(leadIds);
    tally("lead_documents", await run(conn, `DELETE FROM lead_documents WHERE lead_id IN (${ph})`, leadIds));
    tally("lead_comments", await run(conn, `DELETE FROM lead_comments WHERE lead_id IN (${ph})`, leadIds));
    tally("lead_notes", await run(conn, `DELETE FROM lead_notes WHERE lead_id IN (${ph})`, leadIds));
    tally("leads_to_do", await run(conn, `DELETE FROM leads_to_do WHERE lead_id IN (${ph})`, leadIds));
  }
  // ── 4. Change-order / quote items (new + legacy) ──
  if (coIds.length) tally("change_order_items", await run(conn, `DELETE FROM change_order_items WHERE change_order_id IN (${inList(coIds)})`, coIds));
  if (quoteIds.length) tally("quote_items", await run(conn, `DELETE FROM quote_items WHERE quote_id IN (${inList(quoteIds)})`, quoteIds));
  tally("change_order_list", await run(conn, "DELETE FROM change_order_list WHERE created_by = ?", [id]));
  tally("change_order_emp", await run(conn, "DELETE FROM change_order_emp WHERE created_by = ?", [id]));
  tally("quote_list", await run(conn, "DELETE FROM quote_list WHERE created_by = ?", [id]));
  tally("quote_emp", await run(conn, "DELETE FROM quote_emp WHERE created_by = ?", [id]));
  // ── 5. Task images, then the parents ──
  if (taskIds.length) tally("tasks_images", await run(conn, `DELETE FROM tasks_images WHERE task_id IN (${inList(taskIds)})`, taskIds));

  // ── 6. Parents / owned rows ──
  tally("change_orders", await run(conn, "DELETE FROM change_orders WHERE created_by_user_id = ?", [id]));
  tally("change_order_legacy", await run(conn, "DELETE FROM change_order WHERE created_by = ?", [id]));
  tally("quotes", await run(conn, "DELETE FROM quotes WHERE created_by_user_id = ?", [id]));
  tally("quote_legacy", await run(conn, "DELETE FROM quote WHERE created_by = ?", [id]));
  tally("job", await run(conn, "DELETE FROM job WHERE created_by = ?", [id]));
  tally("leads", await run(conn, "DELETE FROM leads WHERE user_id = ?", [id]));
  tally("tasks", await run(conn, "DELETE FROM tasks WHERE created_by = ?", [id]));
  tally("appointments", await run(conn, "DELETE FROM appointments WHERE created_by = ?", [id]));
  tally("check_list", await run(conn, "DELETE FROM check_list WHERE created_by = ?", [id]));
  tally("checklist_sections", await run(conn, "DELETE FROM checklist_sections WHERE owner_user_id = ?", [id]));
  tally("notepad", await run(conn, "DELETE FROM notepad WHERE created_by = ? OR user_id = ?", [id, id]));
  tally("notepad_contacts", await run(conn, "DELETE FROM notepad_contacts WHERE created_by = ?", [id]));
  tally("notepad_groups", await run(conn, "DELETE FROM notepad_groups WHERE created_by = ?", [id]));
  tally("notepad_group_users", await run(conn, "DELETE FROM notepad_group_users WHERE created_by = ? OR user_id = ?", [id, id]));
  tally("spartan_goals", await run(conn, "DELETE FROM spartan_goals WHERE user_id = ?", [id]));
  tally("spartan_goal_log", await run(conn, "DELETE FROM spartan_goal_log WHERE user_id = ?", [id]));
  tally("reminders", await run(conn, "DELETE FROM reminders WHERE user_id = ?", [id]));
  tally("master_calendar_tasks", await run(conn, "DELETE FROM master_calendar_tasks WHERE created_by = ?", [id]));
  tally("equipments", await run(conn, "DELETE FROM equipments WHERE created_by = ?", [id]));
  tally("safety_cours", await run(conn, "DELETE FROM safety_cours WHERE created_by = ?", [id]));
  tally("safety_traning_records", await run(conn, "DELETE FROM safety_traning_records WHERE created_by = ?", [id]));
  tally("support_ticket", await run(conn, "DELETE FROM support_ticket WHERE created_by = ?", [id]));
  tally("report_documents", await run(conn, "DELETE FROM report_documents WHERE created_by = ?", [id]));
  tally("bid_requests", await run(conn, "DELETE FROM bid_requests WHERE gc_user_id = ?", [id]));
  tally("clockin", await run(conn, "DELETE FROM clockin WHERE created_by = ?", [id]));
  // Schedule library: delete the account's own templates (keep the shared seed = NULL owner).
  tally("job_schedules", await run(conn, "DELETE FROM job_schedules WHERE created_by = ?", [id]));
  tally("schedule_templates", await run(conn, "DELETE FROM schedule_templates WHERE created_by = ? AND account_owner_id IS NOT NULL", [id]));

  // ── 7. Personal / account-scoped rows ──
  tally("subscriptions", await run(conn, "DELETE FROM subscriptions WHERE user_id = ?", [id]));
  tally("user_payment_methods", await run(conn, "DELETE FROM user_payment_methods WHERE user_id = ?", [id]));
  tally("user_device_tokens", await run(conn, "DELETE FROM user_device_tokens WHERE user_id = ?", [id]));
  tally("user_devices", await run(conn, "DELETE FROM user_devices WHERE user_id = ?", [id]));
  tally("user_google_tokens", await run(conn, "DELETE FROM user_google_tokens WHERE user_id = ?", [id]));
  tally("users_pins", await run(conn, "DELETE FROM users_pins WHERE user_id = ?", [id]));
  tally("invited_contacts", await run(conn, "DELETE FROM invited_contacts WHERE created_by = ?", [id]));
  tally("reverification_email_log", await run(conn, "DELETE FROM reverification_email_log WHERE user_id = ?", [id]));
  // Only the user's OWN permission rows (never the user_id IS NULL role defaults).
  tally("role_right_permission", await run(conn, "DELETE FROM role_right_permission WHERE user_id = ?", [id]));

  // ── 8. Cross-user references — strip the target's side, keep the other party's ──
  tally("contact", await run(conn, "DELETE FROM contact WHERE request_by = ? OR request_to = ? OR request_user1 = ? OR request_user2 = ?", [id, id, id, id]));
  tally("notifications_inbox", await run(conn, "DELETE FROM notifications WHERE receiver_id = ?", [id]));
  tally("notifications_sent", await run(conn, "UPDATE notifications SET sender_id = NULL WHERE sender_id = ?", [id]));
  tally("task_assignee_stripped", await run(conn, "UPDATE tasks SET user_id = NULL WHERE user_id = ? AND (created_by IS NULL OR created_by <> ?)", [id, id]));
  tally("appt_assignee_stripped", await run(conn, "UPDATE appointments SET user_id = NULL WHERE user_id = ? AND (created_by IS NULL OR created_by <> ?)", [id, id]));
  tally("checklist_assignee_stripped", await run(conn, "UPDATE check_list SET assign_to = NULL WHERE assign_to = ? AND (created_by IS NULL OR created_by <> ?)", [id, id]));
  tally("job_contact_stripped", await run(conn, "DELETE FROM job_contacts WHERE contact_id = ?", [id]));
  tally("team_membership_stripped", await run(conn, "DELETE FROM team_user WHERE user_id = ?", [id]));
  tally("team_leader_stripped", await run(conn, "UPDATE teams SET team_leader = NULL WHERE team_leader = ? AND created_by <> ?", [id, id]));
  tally("teams_owned", await run(conn, "DELETE FROM teams WHERE created_by = ?", [id]));
  tally("lineitem_sub_stripped", await run(conn, "UPDATE division_lineitems SET subcontractor_id = NULL WHERE subcontractor_id = ?", [id]));
  tally("equipment_manager_stripped", await run(conn, "UPDATE equipments SET managed_by = NULL WHERE managed_by = ?", [id]));
  tally("job_client_stripped", await run(conn, "UPDATE job SET client_id = NULL WHERE client_id = ?", [id]));
  tally("job_inspector_stripped", await run(conn, "UPDATE job SET inspector_id = NULL WHERE inspector_id = ?", [id]));
  tally("lead_client_stripped", await run(conn, "UPDATE leads SET client_id = NULL WHERE client_id = ?", [id]));

  // ── 9. Employees & sub-users under this account ──
  // Real employee logins → detach into standalone accounts on a FRESH 60-day trial.
  result.employees_detached = await run(
    conn,
    "UPDATE `user` SET created_by = NULL, created_at = NOW() WHERE created_by = ? AND category = 1 AND password IS NOT NULL AND password <> ''",
    [id]
  );
  // Real non-employee sub-users (contractors/clients with a real login) → detach,
  // but keep their existing signup date (they aren't "newly signed up" employees).
  await run(
    conn,
    "UPDATE `user` SET created_by = NULL WHERE created_by = ? AND category <> 1 AND password IS NOT NULL AND password <> ''",
    [id]
  );
  // Placeholder sub-users (no login) are the owner's data → delete.
  result.placeholder_deleted = await run(
    conn,
    "DELETE FROM `user` WHERE created_by = ? AND (password IS NULL OR password = '')",
    [id]
  );

  // ── 10. The account row itself, last ──
  tally("user", await run(conn, "DELETE FROM `user` WHERE id = ?", [id]));

  return result;
}

module.exports = { previewAccountDeletion, cascadeDeleteAccount };
