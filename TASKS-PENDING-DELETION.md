# TASKS PENDING DELETION

CCP §14 — jobs come off the old Task Manager page and the tasks under them are
to be **DELETED, not merged** (Poul's decision).

## COUNT: not run — see below

**Nothing has been deleted, and no count against real data was produced.**

The build that added this file is barred from connecting to the production
database or the EC2 host, and there is no local copy of production data. Rather
than print a fabricated number, this file records the exact query, the exact
command, and where the output lands. Producing the real list is a one-command
job for whoever has prod access.

## What counts as an affected task

A task that lives under a JOB on the old Task Manager page: a row in `tasks`
with a non-null `job_id` whose `task_type` is not `'lead'`.

Personal daily tasks (no job) are **not** touched. Lead tasks are **not**
touched. Nothing else in the database is touched.

```sql
SELECT
  t.id,
  t.task_name                                   AS title,
  t.job_id,
  j.name                                        AS job_name,
  COALESCE(u.name, '(unassigned)')              AS assignee,
  t.start_date                                  AS due_date,
  t.created_at,
  CASE WHEN t.status = 1 THEN 'completed' ELSE 'open' END AS completion_state
FROM tasks t
LEFT JOIN `job`  j ON j.id = t.job_id
LEFT JOIN `user` u ON u.id = t.user_id
WHERE t.job_id IS NOT NULL
  AND (t.task_type IS NULL OR t.task_type <> 'lead')
ORDER BY j.name ASC, t.id ASC;
```

## To produce the real list (deletes nothing)

```
node scripts/purgeTaskManagerJobTasks.js --report
```

That rewrites **this file** with the count and the full table — id, title, job,
assignee, due date, created date, completion state — one row per affected task.
It is read-only. Add `--account=<id>` to scope it to a single account while
reviewing.

## To actually delete (after Poul has read the list)

```
TASK_PURGE_ARMED=1 node scripts/purgeTaskManagerJobTasks.js --execute
```

Two gates, both required: the `--execute` flag **and** `TASK_PURGE_ARMED=1` in
the environment. `--execute` without the env flag refuses and prints the count
it would have deleted.

A live run writes `task-purge-<timestamp>.log` next to the script containing the
count, the full comma-separated id list, and a tab-separated line per task
(id, job, title, assignee, due date, state). It also prints the count and ids to
stdout. This is the purgeShoppingLists lesson applied: that purge ran and nobody
could read afterwards what it had removed.

Children are removed first inside a single transaction — `task_assignees`,
`tasks_images`, `task_notes` — then the `tasks` rows. Any failure rolls the
whole thing back and appends the reason to the log.

## Why this is held

The delete is permanent and the backup status of that database is unconfirmed.
Per the CCP, it is built, gated, and left un-run.
