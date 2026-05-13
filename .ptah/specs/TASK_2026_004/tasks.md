# TASK_2026_004 — Tasks

**Total Batches:** 1 | **Status:** 0/1 PENDING

Strict HITL refactor: kill the periodic continuation loop, force every
LLM dispatch behind an explicit per-task dashboard click. The empty-
session bug that the loop's bursts exposed is tracked separately in
TASK_2026_005.

## Status legend

- **PENDING** — not yet assigned
- **IN PROGRESS** — work has started
- **IMPLEMENTED** — code merged; awaiting verification
- **COMPLETE** — verified end-to-end on a real leader+follower

## Batch B1 — Kill the loop, add manual dispatch

- **Status:** PENDING
- **Files (in/out):** see `implementation-plan.md` § "Files (in/out)".
- **Sub-tasks:**
  - [ ] PENDING B1.1 — Schema v3 migration: add `tasks.dispatch_count`
    (file: `daemon/src/db/schema.ts`, `daemon/src/db/migrations.ts`,
    `daemon/src/db/tasks.ts`)
  - [ ] PENDING B1.2 — `cancelPending` / `cancelOne` in dispatches repo
    (file: `daemon/src/db/dispatches.ts`)
  - [ ] PENDING B1.3 — Delete the timer; rename `tickOnce` →
    `previewReadyTasks`; add `advanceTask`. Update `index.ts` start
    sequence and `storage.ts` re-exports
    (file: `daemon/src/continuation.ts`, `daemon/src/index.ts`,
    `daemon/src/storage.ts`)
  - [ ] PENDING B1.4 — New API endpoints: `/advance`, `/cancel-pending`,
    `DELETE /api/dispatches/:id`. Remove or 410 the old
    `/api/continuation/tick`
    (file: `daemon/src/api.ts`)
  - [ ] PENDING B1.5 — Bot-bridge audit: remove any tool that wraps the
    deleted endpoint
    (file: `openclaw-control/bot-bridge/src/**`)
  - [ ] PENDING B1.6 — Dashboard `api.service.ts`: add `advanceTask`,
    `cancelPendingForTask`, `cancelDispatch`. Drop `tickContinuation`
    (file: `dashboard/src/app/services/api.service.ts`)
  - [ ] PENDING B1.7 — Dashboard task-detail Phase actions card +
    confirm modal + dispatch-count display. Drop the old "Tick loop"
    button
    (file: `dashboard/src/app/pages/task-detail.component.ts`)
  - [ ] PENDING B1.8 — Dashboard shell: permanent "loop: OFF (HITL)"
    badge in topbar
    (file: `dashboard/src/app/components/shell.component.ts`)
  - [ ] PENDING B1.9 — Tests: `daemon/test/hitl-advance.test.ts`
    covering acceptance criteria #1, #3, #5
    (file: `daemon/test/hitl-advance.test.ts`)
  - [ ] PENDING B1.10 — Docs: `ARCHITECTURE.md`, `CONFIGURATION.md`,
    `CLAUDE.md` (the HITL invariant statement)
    (file: `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `CLAUDE.md`)
