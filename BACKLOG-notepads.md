# Notepads backlog — recorded, not built

Entries here are decisions Poul has asked to keep, with the reasoning
attached, so the next person does not have to rediscover it. **Nothing in
this file is implemented.** If you are about to build one of these, it
needs its own CCP and its own mockup first.

---

## 1. Job access does not imply notepad visibility

**Status: RECORDED, NOT BUILT. Do not implement any part of this.**

A foreman assigned to a job cannot see that job's notepad.

**Why it happens.** Neither query consults job access at all:

- `routes/notepadHub.js` decides visibility from three OR'd clauses — you
  own the pad; the pad is `scope='company'` and you are on the allowlist;
  or there is an explicit per-notepad share row. Job assignment is not one
  of them.
- `routes/myTasks.js` walks task assignment only (`t.user_id`, or a row in
  `task_assignees`). Also not job access.

Job access is a **third, separate mechanism** that appears in neither
query. So being assigned to a job gets you its *tasks* and not its
*notepads*, and that asymmetry is what people notice.

**Poul wants this fixed** — but as its own piece of work, with its own
design and mockup. It was deliberately excluded from the Parts 1–5 CCP
(15 Sep) because it is a visibility change, not a presentation change, and
it would have ridden in on the back of UI work where nobody would review
it properly.

**Do not** add a join to `job`, `tasks` or `task_assignees` in the
`notepadHub.js` visibility expression "ready for later". A dormant join is
not free: it is the shape of the change sitting in the code where the next
person will assume it was reviewed. Display-only joins are fine and
several already exist — the rule is about the WHERE clause.

`test/notepadRoleBaseline.test.js` will fail if the response for an
employee, subcontractor or client moves, which is the guard against this
being half-built by accident.

---

## 2. Watch out: `status = 1` means opposite things in two tables

Not a task, a landmine. Recorded here because it has already cost time.

| Table  | `status = 1` means |
|--------|--------------------|
| `tasks`| **complete**       |
| `job`  | **active**         |

Same column name, opposite sense. Anything filtering "active" across both
will get exactly one of them backwards, and it will look like it works
because half the data is right.
