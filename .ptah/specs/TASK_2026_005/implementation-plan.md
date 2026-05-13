# TASK_2026_005 — Empty-session detection: stop counting "ptah ran, exit 0, wrote nothing" as success

**Type:** BUGFIX
**Status:** PLANNED — depends on TASK_2026_004 landing first (HITL is the
floor; this is defense-in-depth on top of it)
**Created:** 2026-05-06

## Why

Observed on TASK_2026_010: ptah-cli launches, opens a session, the LLM
returns an empty `agent.message` (provider hiccup, rate-limit window,
auth refresh race, model guardrail trip — root cause not yet
isolated), ptah exits with code 0. The daemon's dispatch worker calls
`markDone(exit=0)`, which transitions the row to `done`. Phase
derivation (`db/tasks.ts:301-322`) is purely structural — no
`task-description.md` was written, so the phase stays at CONTEXT. Today
the continuation loop would re-dispatch on the next tick, forever; once
TASK_2026_004 lands, the loop is gone, but the user-driven Advance
button would still re-dispatch the same broken phase as many times as
the operator clicks before realizing the LLM is silently returning
nothing.

This task makes "ptah ran but did no observable work" a first-class
soft-failure that surfaces in the dashboard, blocks further Advance
clicks until acknowledged, and feeds the poison policy.

## Scope (in)

1. **Pre/post artifact snapshot** in the dispatch worker. Before
   invoking ptah, snapshot the set of `(filename, content_hash)` pairs
   for the task's files + the body of `tasks.md`. After the invocation
   completes, snapshot again. Compute `progress_made: boolean` —
   true iff any file was added/modified or the derived phase changed.
2. **Soft-failure path in `markDone`.** Add an optional
   `progressMade?: boolean` parameter. When `exitCode=0 &&
   progressMade=false`, treat as a soft failure: increment
   `failure_count`, transition to `failed` (not `done`), and write a
   stderr_snippet of `"exit 0 but no progress detected"`. This means
   the existing K-recent-failed poison window catches a streak of
   no-progress dispatches.
3. **Dashboard surfacing.** On the task-detail page, show:
   - "Last dispatch: produced no progress" warning badge when the
     latest completed dispatch was a no-progress soft-failure.
   - A "no-progress streak: N" counter on the task header when N >= 1.
   - Disable the Advance button when the streak >= 2 with a tooltip:
     "Two consecutive dispatches produced no observable change. Inspect
     the logs and acknowledge before retrying." A separate "Acknowledge
     and force advance" button re-enables Advance once.
4. **Per-task spending budget enforcement.** TASK_2026_004 added
   `tasks.dispatch_count` for visibility. This task adds
   `tasks.dispatch_budget INTEGER NOT NULL DEFAULT 20` and a check in
   the new `advanceTask` daemon function: if `dispatch_count >=
   dispatch_budget`, refuse with HTTP 409 + a budget-exhausted error.
   The dashboard surfaces a "budget: 17 / 20" badge and a "Top up
   budget" action that POSTs to a new admin endpoint.
5. **Empty-output detection at the chunk level (best-effort).** In the
   invoker (`daemon/src/invoker.ts`), tally the size of `agent.message`
   payloads emitted by the JSON-RPC stream. If the *only* assistant
   text in the entire session was empty, surface that in the dispatch's
   `stderr_snippet` even when the per-file diff would have caught it.
   Belt-and-braces; helps when the agent writes a near-empty file as
   a side effect.

## Scope (out — explicitly deferred)

- Root-cause investigation of *why* the LLM returns empty (provider
  audit, retry policy with exponential backoff, alternative model
  fallback). That's a follow-up once we have observability.
- Streaming the agent's `agent.message` content into the dispatch_log
  table for inline display (nice-to-have; tracked separately).
- A "kill the in-flight ptah subprocess" button. Today the dispatch
  worker is one-at-a-time per machine; cancellation is via the queue.
  In-flight kill is a future task.

## Files (in/out)

- MODIFIED `openclaw-control/daemon/src/dispatch.ts` — pre/post
  snapshot around `invokeClaudeForTask`; pass `progressMade` into
  `markDone`.
- MODIFIED `openclaw-control/daemon/src/db/dispatches.ts` —
  `markDone(id, info)` accepts `info.progressMade?: boolean`. When
  false and `exitCode === 0`, store as `failed` with a no-progress
  stderr; the existing K-recent-failed poison check naturally
  triggers on the third soft failure.
- MODIFIED `openclaw-control/daemon/src/invoker.ts` — track
  `lastNonEmptyAgentMessageBytes` while parsing JSON-RPC stdout;
  return it on the result so the dispatch worker can include it in
  the snapshot diff.
- MODIFIED `openclaw-control/daemon/src/db/schema.ts` — schema v4:
  `ALTER TABLE tasks ADD COLUMN dispatch_budget INTEGER NOT NULL
  DEFAULT 20`. Bump `CURRENT_VERSION` to 4.
- MODIFIED `openclaw-control/daemon/src/db/migrations.ts` — apply v4.
- MODIFIED `openclaw-control/daemon/src/db/tasks.ts` — surface
  `dispatchBudget` on `TaskRow`; helper `topUpBudget(taskId, by)`.
- MODIFIED `openclaw-control/daemon/src/continuation.ts` —
  `advanceTask` checks budget before dispatching; new
  `acknowledgeNoProgress(projectSlug, taskId)` clears the soft-failure
  streak so Advance re-enables.
- MODIFIED `openclaw-control/daemon/src/api.ts` —
  - `POST /api/projects/:slug/tasks/:taskId/acknowledge-no-progress`
  - `POST /api/projects/:slug/tasks/:taskId/budget` — body
    `{ delta?: number, set?: number }`.
- MODIFIED `openclaw-control/dashboard/src/app/services/api.service.ts` —
  `acknowledgeNoProgress`, `setBudget` methods.
- MODIFIED
  `openclaw-control/dashboard/src/app/pages/task-detail.component.ts` —
  no-progress streak badge, budget badge, top-up action, force-advance
  button.
- MODIFIED `openclaw-control/dashboard/src/app/models/index.ts` — add
  `dispatchBudget?: number`, `noProgressStreak?: number` on
  `TaskSummary`.
- NEW `openclaw-control/daemon/test/no-progress-detection.test.ts` —
  - dispatch that writes a new file → progressMade=true → row state =
    `done`
  - dispatch that writes nothing → progressMade=false →
    state = `failed` + stderr matches
  - three consecutive no-progress dispatches → third transitions to
    `poisoned` (existing K-window catches it)
  - acknowledgeNoProgress clears the streak
  - advanceTask refuses when dispatch_count >= dispatch_budget
- MODIFIED `docs/ARCHITECTURE.md` — short paragraph under "dispatch
  lifecycle": exit 0 + no progress = soft-failure; poison policy
  applies. Document `dispatch_budget` semantics.
- MODIFIED `docs/OPERATIONS.md` — runbook for "task is stuck on
  no-progress, what do I check": logs, ptah session JSONL, LLM
  provider status, then ack-and-retry vs cancel-task.

## Sub-tasks (Batch B1)

- PENDING B1.1 — Schema v4 migration (dispatch_budget) (file: schema.ts,
  migrations.ts, tasks.ts)
- PENDING B1.2 — Pre/post snapshot helper in dispatches.ts; add
  `progressMade` to markDone (file: db/dispatches.ts, dispatch.ts)
- PENDING B1.3 — Invoker emits `lastNonEmptyAgentMessageBytes` (file:
  invoker.ts)
- PENDING B1.4 — `advanceTask` budget check; `acknowledgeNoProgress`
  clears streak (file: continuation.ts)
- PENDING B1.5 — API endpoints for ack and budget top-up (file: api.ts)
- PENDING B1.6 — Dashboard wiring (badges, force-advance button) (file:
  dashboard/...)
- PENDING B1.7 — Tests (file: daemon/test/no-progress-detection.test.ts)
- PENDING B1.8 — Docs sweep (file: docs/ARCHITECTURE.md,
  docs/OPERATIONS.md)

## Acceptance criteria

1. A dispatch where ptah exits 0 without writing any file lands as
   `failed`, not `done`, with stderr_snippet identifying the
   no-progress cause.
2. Three such dispatches in a row for the same (task, phase) transition
   the third to `poisoned`. Operator acknowledgment via the new endpoint
   is required to retry.
3. Dashboard task-detail visibly badges no-progress streaks and disables
   Advance once the streak hits 2. The badge tells the operator what to
   investigate.
4. `dispatch_budget` blocks Advance cleanly with HTTP 409 and a
   structured error code (`E_BUDGET_EXHAUSTED`) the dashboard maps to
   a top-up affordance.
5. Existing happy-path tests still pass — a normal dispatch that writes
   the expected artifact still lands as `done`.

## Risks

- **False positives on legitimately no-op phases.** Some agents may
  legitimately exit 0 with no file change (e.g. "QA: everything passed,
  no changes needed"). Mitigation: the soft-failure is recoverable in
  one click via "Acknowledge and force advance"; we err on the side of
  pausing rather than burning budget.
- **Snapshot drift if a sibling worker writes during the dispatch.** In
  practice each task is single-writer (one dispatch open per phase per
  the unique index). Documented assumption.
- **Budget too tight for legitimate work.** Default 20 is a guess.
  Operators can top up; the dashboard makes it one click.

## Open questions

- Default `dispatch_budget` value: 20 chosen to comfortably cover a
  full happy-path walk through all 7 phases (plus retries) without
  blocking, while catching a runaway long before TASK_2026_010-scale
  damage. Reconsider after a week of operation.
- Should "force advance" itself decrement the budget? Probably yes —
  otherwise it's a budget-bypass. To be confirmed during implementation.
