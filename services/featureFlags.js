'use strict';

/**
 * Feature flags — one place, read from the environment, default OFF.
 *
 * Migration policy rule 6: "Large user-visible changes ship behind a feature
 * flag." The Notepad/My-Tasks rebuild is the largest user-visible change in the
 * app so far (two pages rebuilt on both platforms, the mobile nav restructured),
 * so it is gated end to end — the SERVER refuses the new endpoints when the flag
 * is off, not merely the UI hiding buttons. A frontend that ships ahead of the
 * backend therefore degrades cleanly instead of 404-storming.
 *
 * Flags are read per call (not cached) so flipping the env and restarting is the
 * only step; there is no build to redo.
 *
 *   NOTEPAD_MYTASKS_ENABLED=1     the whole rebuild (default OFF)
 *   NOTEPAD_MERGE_ARMED=1         the two-step merge may actually move rows
 *   NOTEPAD_CLIENT_INVITE_ARMED=1 the client-invite email may actually send
 *   NOTEPAD_BACKFILL_ARMED=1      the one-off historical notepad back-fill
 *   TASK_PURGE_ARMED=1            the old Task Manager task deletion
 *
 * Everything except the first is DESTRUCTIVE-or-outbound and stays off until
 * the owner has watched it fire once.
 */

const on = (name) => String(process.env[name] || '') === '1';

/** The Notepad-as-boss-task-manager / My Tasks rebuild. */
function notepadMyTasksEnabled() {
  return on('NOTEPAD_MYTASKS_ENABLED');
}

/** The two-step merge may MOVE rows. Off = dry run that logs and reports. */
function mergeArmed() {
  return on('NOTEPAD_MERGE_ARMED');
}

/** The client-invite email may actually leave the building. Off = record only. */
function clientInviteArmed() {
  return on('NOTEPAD_CLIENT_INVITE_ARMED');
}

/** The one-off historical notepad back-fill may write. Off = count and report. */
function backfillArmed() {
  return on('NOTEPAD_BACKFILL_ARMED');
}

/**
 * Express guard for every endpoint that only exists as part of the rebuild.
 * Answers 404 (not 403) with a distinct code: to a client that has not been
 * told about the feature, the route genuinely does not exist, and the frontend
 * reads the code to fall back to the pre-rebuild behaviour.
 */
function requireNotepadMyTasks(req, res, next) {
  if (notepadMyTasksEnabled()) return next();
  return res.status(404).json({
    success: false,
    code: 'FEATURE_DISABLED',
    feature: 'notepad_mytasks',
    message: 'This feature is not switched on.',
  });
}

/** Everything the client needs to decide what to render. Never gated itself. */
function publicFlags() {
  return {
    notepad_mytasks: notepadMyTasksEnabled(),
    // Surfaced so the UI can say "recorded, not sent" honestly rather than
    // implying an email went out.
    client_invite_email: clientInviteArmed(),
    merge_armed: mergeArmed(),
  };
}

module.exports = {
  notepadMyTasksEnabled,
  mergeArmed,
  clientInviteArmed,
  backfillArmed,
  requireNotepadMyTasks,
  publicFlags,
};
