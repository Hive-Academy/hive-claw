# TASK_2026_004 — Strict HITL: kill the continuation loop, manual-only dispatch

**Type:** REFACTOR (with safety-critical bug-fix character)
**Status:** PLANNED — awaiting first batch
**Created:** 2026-05-06

## Why

The continuation loop in `daemon/src/continuation.ts` ran every 30 s on the
leader and dispatched every non-DONE task whose phase wasn't gated by a
checkpoint. Combined with three independent bugs (phase derived purely from
filenames; dedup constraint releases on `done`; exit-0-empty-output counted
as success), it produced an unbounded re-dispatch loop on TASK_2026_010
that drained the operator's LLM subscription. The empty-output failure
mode is tracked separately in TASK_2026_005; this task strips the loop's
ability to *cause* hidden work in the first place.

The non-negotiable invariant after this task: **no LLM call ever fires
unless a human clicked a button on the dashboard for that specific task,
in that specific phase**. There is no timer, no scan, no implicit
"approval implies the next phase auto-runs". Approval is pure consent
state; the Advance button is the only thing that creates a dispatch.

## Scope (in)

1. Delete the periodic timer in the daemon. `tickOnce` survives only as a
   read-only "what *would* be ready" probe (renamed `previewReadyTasks`)
   used by the dashboard for visibility.
2. Add explicit per-task HITL endpoints:
   - `POST /api/projects/:slug/tasks/:taskId/advance` — build the prompt
     for the *current* phase, insert exactly one pending dispatch (or
     invoke locally if the agent is owned here). Returns
     `{ dispatchId, phase, agentId, promptPreview }`.
   - `POST /api/projects/:slug/tasks/:taskId/cancel-pending` — transition
     all `pending`/`taken` dispatches for that task to `failed` with
     `stderr_snippet='cancelled by user (HITL)'`.
   - `DELETE /api/dispatches/:id` — cancel a single pending or taken
     dispatch by id.
3. Schema v3: add `tasks.dispatch_count INTEGER NOT NULL DEFAULT 0`,
   incremented on every successful `insertPending`. Pure visibility — no
   logic depends on it. Sets up TASK_2026_005's per-task budget gate.
4. Dashboard: replace the "Tick loop" button with a per-task **Phase
   actions** card on `task-detail.component.ts` (Run-phase + Cancel
   buttons + confirmation modal). Add a permanent "loop: OFF (HITL)"
   badge in `shell.component.ts`. Delete the now-orphaned
   `tickContinuation` method from `api.service.ts`.
5. Remove `POST /api/continuation/tick` from `api.ts` (or 410 Gone with
   a note pointing to `/advance`). The endpoint cannot exist if it is
   the last hidden way to fire work in bulk.

## Scope (out — explicitly deferred)

- Empty-session detection / no-progress guard / poison policy fixes —
  TASK_2026_005.
- Per-task spending budget (we'll add the column here for visibility,
  but the *enforcement* lives in TASK_2026_005 alongside the no-progress
  detector).
- Optional `tasks.auto_advance` flag for trusted batch overrides — a
  future task. Manual is the floor; automation must be opt-in per task,
  not the default.
- Persona / scheduling rework. Out of scope.

## Files (in/out)

- MODIFIED `openclaw-control/daemon/src/index.ts` — drop the
  `startContinuationLoop` call. The leader still runs the dispatch
  worker (it processes manually-created `pending` rows), it just no
  longer auto-creates them.
- MODIFIED `openclaw-control/daemon/src/continuation.ts` — delete
  `startContinuationLoop`, `stopContinuationLoop`, the module-level
  timer/stopping state. Rename `tickOnce` → `previewReadyTasks` and
  change its return shape (no `dispatched` count; just
  `{ taskId, phase, hasCheckpoint, isApproved, blockedReason }[]`).
  Add new exported `advanceTask(projectSlug, taskId)` that does the
  per-task version of what `tickOnce` used to do for the whole world,
  for a single task.
- MODIFIED `openclaw-control/daemon/src/api.ts` —
  - replace `POST /api/continuation/tick` (or 410-and-leave-stub).
  - new `POST /api/projects/:slug/tasks/:taskId/advance`.
  - new `POST /api/projects/:slug/tasks/:taskId/cancel-pending`.
  - new `DELETE /api/dispatches/:id`.
  - All four use `requireAuth` and the existing `safeId` helpers.
- MODIFIED `openclaw-control/daemon/src/db/dispatches.ts` — add
  `cancelPending(projectSlug, taskId): { cancelled: number }` and
  `cancelOne(id): boolean`. Both transition `pending`/`taken` →
  `failed`. Idempotent (no-op when nothing matches). Increment
  `tasks.dispatch_count` on `insertPending` (single transaction).
- MODIFIED `openclaw-control/daemon/src/db/schema.ts` — add v3
  migration: `ALTER TABLE tasks ADD COLUMN dispatch_count INTEGER NOT
  NULL DEFAULT 0`. Bump `CURRENT_VERSION` to 3.
- MODIFIED `openclaw-control/daemon/src/db/migrations.ts` — apply v3.
- MODIFIED `openclaw-control/daemon/src/db/tasks.ts` — surface
  `dispatchCount` on `TaskRow` so the dashboard can read it.
- MODIFIED `openclaw-control/dashboard/src/app/services/api.service.ts` —
  add `advanceTask`, `cancelPendingForTask`, `cancelDispatch`. Delete
  `tickContinuation` (or have it return Observable<void> that no-ops).
- MODIFIED
  `openclaw-control/dashboard/src/app/pages/task-detail.component.ts` —
  new **Phase actions** card with Run-phase + Cancel-pending buttons
  and a confirmation modal that previews `{ agent, phase, promptPreview }`.
  Drop the existing "Tick loop" button. Show `dispatchCount` next to the
  task header.
- MODIFIED
  `openclaw-control/dashboard/src/app/components/shell.component.ts` —
  permanent "loop: OFF (HITL)" badge in the topbar.
- MODIFIED `openclaw-control/dashboard/src/app/models/index.ts` — add
  `dispatchCount?: number` on `TaskSummary`.
- MODIFIED `docs/ARCHITECTURE.md` — replace the "leader runs the
  continuation loop" paragraph with the HITL model. Diagram update
  optional.
- MODIFIED `docs/CONFIGURATION.md` — remove `OPENCLAW_TICK_MS` and
  `OPENCLAW_DISABLE_CONTINUATION` (now defunct). Document the new
  endpoints under a "Manual dispatch (HITL)" section.
- MODIFIED `CLAUDE.md` — update the "Multi-machine topology" section's
  description of the leader; the leader now runs only the dispatch
  worker (no continuation).
- NEW `openclaw-control/daemon/test/hitl-advance.test.ts` —
  - advance on a fresh task creates exactly one pending dispatch
  - advance twice without intervening dispatch completion is rejected
    (the existing `dispatches_unique_open` constraint protects this)
  - cancel-pending transitions every open dispatch to failed
  - DELETE /api/dispatches/:id refuses to cancel `done`/`failed`/`poisoned`
  - approval no longer triggers any dispatch (prove the absence)
  - `previewReadyTasks` is a pure read; calling it does not insert any
    row regardless of state.
- NEW `openclaw-control/dashboard/test/...` — at minimum a smoke test
  that the Run-phase button renders a confirm modal before firing.

## Sub-tasks (Batch B1 — atomic; cannot ship partial)

1. Schema v3 migration (`schema.ts`, `migrations.ts`, `tasks.ts` row
   shape). Verified by an existing-DB-upgrade test — apply v2-shape DB,
   run migrator, assert `dispatch_count` column exists with default 0.
2. `cancelPending` / `cancelOne` in `db/dispatches.ts`. Pure DB layer,
   no HTTP yet.
3. Delete the timer in `continuation.ts`; rename `tickOnce` →
   `previewReadyTasks`; add `advanceTask`. Update `index.ts` to drop
   the start call. Update `storage.ts` (which re-exports `tickOnce`) —
   either drop the re-export or alias it to the new name.
4. New API endpoints in `api.ts`. Each route is a 6-line guard +
   delegate to step 2/3.
5. Remove `POST /api/continuation/tick` (or 410). Grep for callers in
   bot-bridge and dashboard; both will be updated in steps 7–8.
6. Bot-bridge audit: search for any tool definition that wraps
   `tickContinuation` or `/api/continuation/tick`; remove. The chat
   tier must not be able to trigger work either — Discord operators
   click Advance via the dashboard, not via chat.
7. Dashboard `api.service.ts` updates. Drop `tickContinuation`.
8. Dashboard `task-detail.component.ts` — new Phase actions card +
   confirm modal + `dispatchCount` display. Remove the "Tick loop"
   button.
9. Dashboard `shell.component.ts` — permanent "loop: OFF (HITL)" badge.
10. Tests in `daemon/test/hitl-advance.test.ts`.
11. Docs sweep: `ARCHITECTURE.md`, `CONFIGURATION.md`, `CLAUDE.md`. The
    invariant statement ("no LLM call without an explicit per-task
    click") goes into all three.

## Acceptance criteria

1. `OPENCLAW_LEADER=1` with a fresh DB and a 30-minute observation window
   produces **zero** dispatch rows unless someone POSTs to
   `/advance`. (Tested manually; reflected in the new test suite as a
   timer-injection assertion.)
2. The dashboard's task-detail page can drive a task from CONTEXT to
   DONE one phase at a time, with no other user interaction required
   between dispatches finishing and the next Advance click being
   *available*.
3. Cancel-pending wipes a runaway in one click. After cancellation,
   `previewReadyTasks` for that task returns `blockedReason: null` and
   the Advance button is enabled again — no zombie state.
4. The leader's startup logs say `[continuation] disabled — HITL mode`
   prominently. (Today the loop announces "loop running every Xms" —
   the absence of that line is the success signal.)
5. Bot-bridge and dashboard contain zero references to
   `tickContinuation` / `/api/continuation/tick` (`grep` clean).

## Risks

- **A follower's dispatch worker still polls every 10 s** —
  `dispatch.ts:261-272`. That's correct: it polls for *manually-created*
  pending rows. We are not changing that. Documented explicitly so a
  future reader doesn't think the worker is the runaway.
- **Existing in-flight dispatches at upgrade time.** Operator must run
  the cancel-all SQL from the rollout runbook below before deploying,
  or the worker will resume them post-upgrade.
- **Bot-bridge tools that drove the old endpoint.** If any persona's
  harness lists `tick_continuation` (or similar) as a chat tool, that
  call will start 404'ing. Step 6 audits and removes those.
- **Documentation drift.** `docs/ARCHITECTURE.md` has a continuation-loop
  section; if missed, future agents will reintroduce a timer thinking
  it's broken. Step 11 is non-optional.

## Rollout runbook (operator)

1. Read damage: `sqlite3 /data/specs.db "SELECT task_id, phase, state,
   COUNT(*) FROM dispatches GROUP BY task_id, phase, state ORDER BY 1,2;"`
2. Drain in-flight: `UPDATE dispatches SET state='failed',
   stderr_snippet='cancelled by operator (HITL migration)' WHERE state
   IN ('pending','taken');`
3. Pull the new image / restart the daemon.
4. Verify cold: `docker logs <daemon> 2>&1 | grep -i continuation` should
   show `disabled — HITL mode` and nothing else.
5. Verify the dashboard topbar shows "loop: OFF (HITL)".
6. Pick one task, click Advance, watch one dispatch flow through to
   `done`. Confirm no second dispatch appears.

## Open questions resolved

- **Confirm modal style:** simple "Yes, run this phase" button, with
  the *prompt preview* visible above the buttons so accidental clicks
  are obvious. No type-the-task-id requirement (we considered
  `terraform destroy`-style, decided the friction wasn't worth it for a
  reversible operation that has its own cancel button). Matches the
  recommendation given in the planning conversation 2026-05-06.
- **`tickOnce` rename:** `previewReadyTasks`. Keeps the name honest —
  it's a read.
