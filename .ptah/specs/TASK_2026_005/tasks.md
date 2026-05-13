# Development Tasks - TASK_2026_005

**Total Tasks**: 8 | **Batches**: 4 | **Status**: 0/4 complete

---

## Plan Validation Summary

**Validation Status**: PASSED WITH RISKS

### Assumptions Verified

- `MarkDoneInput` is an object interface (dispatches.ts:120-124), so adding `progressMade?: boolean` is backward-compatible: VERIFIED
- `QueueAdapter.markDone` (dispatch.ts:47-51) uses the same shape -- must be extended in step with `MarkDoneInput`: VERIFIED
- Single-writer per task per phase is enforced by `dispatches_unique_open` partial UNIQUE index: VERIFIED
- `leaderClient.markDone` (leaderClient.ts:475-490) JSON-serializes `info` fields explicitly -- must also forward `progressMade`: VERIFIED
- `InvokeResult` (invoker.ts:23-29) is a clean interface to extend with an `agentMessageBytes` field: VERIFIED
- `TaskRow` (tasks.ts:51-72) + `RawTaskRow` need `dispatch_budget` column: VERIFIED
- `TaskSummary` (phase.ts:21-39) needs `noProgressStreak` computed field for dashboard: VERIFIED
- The `/api/dispatches/:id/done` follower relay (api.ts:579-625) reads body fields individually -- must read `progressMade`: VERIFIED

### Risks Identified

| Risk | Severity | Mitigation |
|------|----------|------------|
| `leaderClient.markDone` does not forward `progressMade` today -- follower-path dispatches would lose the signal | HIGH | Task 1.2 must update both the repo `MarkDoneInput` AND the `leaderClient.markDone` signature + the `QueueAdapter` type |
| `api.ts` `/api/dispatches/:id/done` reads body fields individually (`exitCode`, `durationMs`, `stderrSnippet`) -- `progressMade` must be added to the destructure | HIGH | Task 1.5 must update the HTTP handler to read `progressMade` from `req.body` and pass it through |
| False positive on legitimately no-op phases (e.g. QA passes with no changes) | LOW | Soft-failure is recoverable via "Acknowledge and force advance" -- err on side of pausing |
| Snapshot drift if sibling worker writes during dispatch | LOW | Single-writer per task/phase enforced by partial UNIQUE index; documented assumption |
| Budget default of 20 may be too tight | LOW | Operators can top up; dashboard makes it one click |

### Edge Cases to Handle

- [ ] `exitCode=0 && progressMade=false` -> soft failure (not done) -> handled in Task 1.2
- [ ] `exitCode=0 && progressMade=true` -> normal done -> handled in Task 1.2
- [ ] `exitCode != 0 && progressMade` is irrelevant -> existing failure path -> handled in Task 1.2
- [ ] `progressMade` not provided (undefined) -> treat as true (backward compat) -> handled in Task 1.2
- [ ] Follower relay loses `progressMade` -> dispatch lands as done instead of failed -> handled in Task 1.2 + 1.5
- [ ] `dispatch_count >= dispatch_budget` -> advanceTask refuses with 409 -> handled in Task 1.4
- [ ] No-progress streak crosses the K-recent-failed threshold -> natural poisoning -> handled in Task 1.7 (test)

---

## Batch 1: Schema + Core Backend (progress detection + markDone) -- PENDING

**Developer**: backend-developer
**Execution Mode**: sequential (tasks have hard dependencies: schema first, then repo changes, then invoker, then continuation)
**Tasks**: 4 | **Dependencies**: None

### Task 1.1: Schema v4 migration -- add dispatch_budget column -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/schema.ts` (line 32: bump CURRENT_VERSION 3 -> 4; add v4 comment to version history)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/migrations.ts` (add `applyV4` function after `applyV3`; add `if (have < 4) { applyV4(db); have = 4; }` in `runMigrations`; add v4 comment to top)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/tasks.ts` (add `dispatch_budget: number` to `TaskRow` interface ~line 69; add `dispatch_budget: number` to `RawTaskRow` ~line 104; map `raw.dispatch_budget` in `toTaskRow` ~line 293; add `topUpBudget` method to `TasksRepo` object; add prepared statement `topUpBudget: Statement<{project_slug: string; id: string; delta: number}>`)

**Spec Reference**: implementation-plan.md lines 49-55, 89-93

**Pattern to Follow**: `applyV3` in migrations.ts (lines 101-112) is the exact pattern for `applyV4`.

**Quality Requirements**:
- `ALTER TABLE tasks ADD COLUMN dispatch_budget INTEGER NOT NULL DEFAULT 20`
- `CURRENT_VERSION` bumped to 4
- `TaskRow.dispatchBudget` surfaced as a number
- `TasksRepo.topUpBudget(projectSlug, taskId, delta)` increments `dispatch_budget` by `delta` in a single UPDATE
- Existing v3 tests (`hitl-advance.test.ts` task 6) must still pass -- the default of 20 means existing tasks get the budget automatically

**Validation Notes**:
- The SCHEMA_V1 inline CREATE for `tasks` does NOT include `dispatch_budget` -- just like `dispatch_count` was omitted from v1, `dispatch_budget` must live only in the migration step. A fresh DB applies v1 then v4, landing with the column. An existing DB adds it via ALTER.
- `RawTaskRow.dispatch_budget` may be `undefined` for DBs that haven't run v4 yet -- `toTaskRow` should default to 20.

**Implementation Details**:
- Imports: none new
- `topUpBudget` SQL: `UPDATE tasks SET dispatch_budget = dispatch_budget + @delta, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_slug = @project_slug AND id = @id`
- Consider also adding a `setBudget` variant for the admin API: `UPDATE tasks SET dispatch_budget = @budget WHERE ...`

---

### Task 1.2: Pre/post snapshot + progressMade parameter on markDone -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/dispatches.ts` (add `progressMade?: boolean` to `MarkDoneInput` interface ~line 120; modify `markDone` method ~line 420 to handle soft-failure when `exitCode===0 && progressMade===false`)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/dispatch.ts` (add pre/post snapshot around `invokeClaudeForTask` call ~line 194; compute `progressMade`; pass into `queue.markDone`; extend `QueueAdapter.markDone` signature ~line 47)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/leaderClient.ts` (add `progressMade?: boolean` to `markDone` info parameter ~line 477; include in JSON body ~line 483)

**Dependencies**: Task 1.1 (schema must exist first, though this task doesn't directly read dispatch_budget)

**Spec Reference**: implementation-plan.md lines 29-41, 77-83

**Pattern to Follow**: Existing `markDone` failure path (dispatches.ts lines 444-489) -- the soft-failure branch goes before the existing `exitCode === 0` healthy completion at line 432.

**Quality Requirements**:
- `MarkDoneInput.progressMade?: boolean` -- when undefined, treat as `true` (backward compat: callers that don't pass it get the old behavior)
- When `exitCode === 0 && progressMade === false`: treat as a soft failure -- transition to `failed` (NOT `done`), set `stderr_snippet` to `"exit 0 but no progress detected"` (append to any existing stderr), increment `failure_count`. This means the existing K-recent-failed poison window catches no-progress streaks naturally.
- When `exitCode === 0 && progressMade !== false`: existing `done` path -- no change.
- Pre/post snapshot: before invocation, query `TasksRepo.listFiles(projectSlug, taskId)` and compute a set of `(filename, sizeBytes)`. After invocation, query again. `progressMade = true` iff any file was added/modified/deleted OR the derived phase changed (`TasksRepo.deriveCurrentPhase`).
- `QueueAdapter.markDone` type (dispatch.ts line 47-51) must also accept `progressMade?: boolean`.
- `leaderClient.markDone` (leaderClient.ts line 475-490) must forward `progressMade` in the JSON body.

**Validation Notes**:
- CRITICAL: The follower relay path. `api.ts` POST `/api/dispatches/:id/done` (lines 579-625) reads `exitCode`, `durationMs`, `stderrSnippet` from the body. It must ALSO read `progressMade` and pass it through to `storage.markDispatchDone`. This will be handled in Task 1.5 (API endpoints), but the developer implementing this task must be aware that the `QueueAdapter` and `leaderClient.markDone` signatures need updating HERE, while the HTTP body parsing in `api.ts` is a SEPARATE task.
- The snapshot should also check phase change: if the phase advanced (e.g. CONTEXT -> DESCRIPTION), that IS progress even if no files changed size.
- `progressMade` defaults to `true` when not provided -- this is the safe backward-compatible default because existing callers (follower relays that haven't been updated yet) will still get the old `done` behavior.

**Implementation Details**:
- New snapshot helper (can live in dispatch.ts or a new `snapshot.ts`):
  ```
  function snapshotTaskFiles(projectSlug, taskId): Map<string, number>  // filename -> sizeBytes
  function diffSnapshots(before, after, phaseChanged): boolean
  ```
- In `processOneDispatch` (dispatch.ts ~line 194):
  1. Before `invokeClaudeForTask`: `const before = snapshotTaskFiles(claimed.projectSlug, claimed.taskId); const beforePhase = TasksRepo.get(claimed.projectSlug, claimed.taskId)?.currentPhase;`
  2. After invocation: `const after = snapshotTaskFiles(claimed.projectSlug, claimed.taskId); const afterPhase = TasksRepo.get(claimed.projectSlug, claimed.taskId)?.currentPhase; const phaseChanged = beforePhase !== afterPhase; const progressMade = diffSnapshots(before, after, phaseChanged);`
  3. Pass `progressMade` into `queue.markDone(id, { ..., progressMade })`

---

### Task 1.3: Invoker emits agentMessageBytes (empty-stream signal) -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/invoker.ts` (add `agentMessageBytes: number` to `InvokeResult` interface ~line 23; accumulate `agent.message` content length in `invokeClaudeForTask` ~line 72; return on result)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/harness/ptahLauncher.ts` (add `agentMessageBytes: number` to `SpawnPtahResult` interface ~line 47; accumulate while parsing JSON-RPC stdout chunks in `spawnPtahForAgent`)

**Dependencies**: None (independent of schema)

**Spec Reference**: implementation-plan.md lines 56-61, 85-87

**Pattern to Follow**: The invoker delegates to `spawnPtahForAgent` which returns `SpawnPtahResult`. The JSON-RPC stream parsing lives inside the bridge invocation (`invokeViaBridge`). The best-effort approach: if the bridge doesn't report `agentMessageBytes`, default to 0 and rely on the file-diff snapshot as the primary progress signal.

**Quality Requirements**:
- `InvokeResult.agentMessageBytes: number` -- total bytes of non-empty `agent.message` payloads across the entire session. 0 means the LLM produced no assistant text.
- `SpawnPtahResult.agentMessageBytes: number` -- same, from the ptah launcher layer.
- This is best-effort: if the bridge/ptah version doesn't report it, default to 0. The file-diff snapshot is the authoritative progress signal; this is belt-and-braces.
- The dispatch worker (dispatch.ts) can use this to enrich the `stderr_snippet` when `agentMessageBytes === 0 && exitCode === 0`.

**Validation Notes**:
- The bridge (`invokeViaBridge`) returns `{ ok, exitCode, stdout, stderr, durationMs }`. If the bridge doesn't report `agentMessageBytes`, we parse it from `stdout` if available (the JSONL stream contains `agent.message` events). If not parseable, default to 0.
- This is explicitly best-effort per the plan -- failure to compute this number must NOT block the dispatch lifecycle.

**Implementation Details**:
- If the bridge returns `stdout` containing JSONL, scan for lines matching `.*"agent\.message".*` and sum the content lengths. This is approximate but catches the "entirely empty session" case.
- If `stdout` is not available or not JSONL, `agentMessageBytes = 0` (don't block on parse failures).

---

### Task 1.4: advanceTask budget gate + acknowledgeNoProgress -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/continuation.ts` (add budget check in `advanceTask` ~line 206; add `acknowledgeNoProgress` function; update `blockedReasonFor` to check no-progress streak; update `ReadyTaskPreview` with noProgressStreak field)

**Dependencies**: Task 1.1 (needs `dispatchBudget` on TaskRow), Task 1.2 (needs `progressMade` in markDone so dispatches land as `failed` instead of `done`)

**Spec Reference**: implementation-plan.md lines 49-55, 96-98

**Pattern to Follow**: Existing `blockedReasonFor` function (continuation.ts lines 168-173) -- add new check after checkpoint check.

**Quality Requirements**:
- `advanceTask`: before dispatching, read `TasksRepo.get(projectSlug, taskId)`. If `row.dispatchCount >= row.dispatchBudget`, refuse with `blockedReason: 'dispatch budget exhausted (N/M). Top up budget to continue.'` Return HTTP 409 from the API layer (same pattern as checkpoint not approved).
- `blockedReasonFor`: add a check for the no-progress streak. Count the consecutive recent dispatches for this (task, phase) that ended in `failed` with `stderr_snippet` matching `no progress detected`. If streak >= 2, add `blockedReason: 'Two consecutive dispatches produced no observable change. Acknowledge before retrying.'`
- New `acknowledgeNoProgress(projectSlug, taskId)`: this should clear the no-progress streak so Advance re-enables. Implementation: find the failed dispatches with the no-progress marker and... the cleanest approach is to not modify dispatch history but instead track acknowledgment on the task row. Add a `no_progress_acknowledged_at TEXT` column (or simply reset by bumping `dispatch_budget` by 1 as a side-effect of acknowledgment, effectively granting one more attempt). Per the plan's open question, "force advance" should decrement the budget.
- `ReadyTaskPreview`: add `noProgressStreak: number` field.
- `AdvanceTaskResult`: add `noProgressStreak?: number` and `budgetExhausted?: boolean`.

**Validation Notes**:
- The no-progress streak is computed from dispatch history -- query the most recent dispatches for the task, count consecutive `failed` rows where `stderr_snippet` contains the no-progress marker. This is read-only and doesn't need a new column.
- `acknowledgeNoProgress` is the operator action that clears the streak. Simplest implementation: it's a no-op marker that the dashboard checks. The streak is computed from dispatches; "acknowledgment" means the operator has seen the warning and wants to retry. We don't need to mutate dispatch history. Instead, the acknowledgment can be modeled as bumping `dispatch_budget` by 1 (giving one more attempt).
- The plan's open question asks whether "force advance" itself decrements the budget. Recommendation: YES -- acknowledgment + advance should consume one budget unit. The "Acknowledge and force advance" button in the dashboard calls `acknowledgeNoProgress` (which tops up budget by 1) and then `advanceTask` (which consumes it). This prevents budget bypass.

**Implementation Details**:
- `acknowledgeNoProgress(projectSlug, taskId)`: `TasksRepo.topUpBudget(projectSlug, taskId, 1)` -- grants one more dispatch.
- No-progress streak computation:
  ```
  function noProgressStreak(projectSlug, taskId, phase): number
    // Query dispatches for (project, task, phase) ordered by created_at DESC
    // Count consecutive rows where state='failed' AND stderr_snippet LIKE '%no progress detected%'
    // Stop counting at the first non-matching row
  ```

---

**Batch 1 Verification**:
- All modified files exist at their paths
- Build passes: `cd openclaw-control/daemon && npx tsc --noEmit`
- code-logic-reviewer approved
- Edge cases from validation handled
- Existing `hitl-advance.test.ts` and `dispatch-poison.test.ts` still pass

---

## Batch 2: API Endpoints + Dashboard Wiring -- PENDING

**Developer**: backend-developer (Task 2.1), frontend-developer (Task 2.2)
**Execution Mode**: parallel (Task 2.1 and 2.2 are file-disjoint; 2.2 depends on the endpoint URLs from 2.1 but the API shape is already defined)
**Tasks**: 2 | **Dependencies**: Batch 1 complete

### Task 2.1: API endpoints for acknowledge-no-progress + budget top-up -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/api.ts` (add `POST /api/projects/:slug/tasks/:taskId/acknowledge-no-progress` ~after line 350; add `POST /api/projects/:slug/tasks/:taskId/budget` ~after that; update `POST /api/dispatches/:id/done` to read `progressMade` from body ~line 579-625; update `POST /api/projects/:slug/tasks/:taskId/advance` to map budget-exhausted to 409)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/storage.ts` (add `acknowledgeNoProgress` relay; add `topUpBudget` relay)

**Dependencies**: Batch 1 (needs `acknowledgeNoProgress` from continuation.ts, `topUpBudget` from tasks.ts)

**Spec Reference**: implementation-plan.md lines 97-102

**Pattern to Follow**: Existing `POST /api/projects/:slug/tasks/:taskId/advance` (api.ts lines 300-321) -- same auth + leader-only pattern.

**Quality Requirements**:
- `POST /api/projects/:slug/tasks/:taskId/acknowledge-no-progress` -- leader-only, guarded. Calls `acknowledgeNoProgress(projectSlug, taskId)`. Returns `{ ok: true }`. Broadcast `task.no_progress_acknowledged`.
- `POST /api/projects/:slug/tasks/:taskId/budget` -- leader-only, guarded. Body: `{ delta?: number, set?: number }`. Calls `TasksRepo.topUpBudget` or a new `TasksRepo.setBudget`. Returns `{ ok: true, dispatchBudget: N }`. Broadcast `task.budget_updated`.
- `POST /api/dispatches/:id/done` -- add `progressMade` to the body destructuring (currently reads `exitCode`, `durationMs`, `stderrSnippet`). Pass through to `storage.markDispatchDone`.
- `POST /api/projects/:slug/tasks/:taskId/advance` -- when `advanceTask` returns `blockedReason` matching `budget exhausted`, map to 409 with error code `E_BUDGET_EXHAUSTED`.
- GET `/api/projects/:slug/tasks/:taskId` -- ensure response includes `dispatchBudget` and `noProgressStreak` fields.

**Validation Notes**:
- The `storage.ts` facade must relay these new endpoints to the leader for followers. Since these are leader-only, follower callers get 405 (same pattern as advance/cancel).
- The `/api/dispatches/:id/done` handler currently reads body fields individually -- must add `progressMade` destructure: `const progressMade = typeof req.body?.progressMade === 'boolean' ? req.body.progressMade : undefined;`

**Implementation Details**:
- Budget endpoint accepts either `{ delta: 5 }` (add 5) or `{ set: 30 }` (set to 30), not both. If both provided, prefer `set`.
- Error code for budget exhaustion: `{ error: 'dispatch budget exhausted (17/20)', code: 'E_BUDGET_EXHAUSTED', dispatchCount: 17, dispatchBudget: 20 }`

---

### Task 2.2: Dashboard: streak badge, budget badge, force-advance button -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/models/index.ts` (add `dispatchBudget?: number` and `noProgressStreak?: number` to `TaskSummary` interface ~line 23-41)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/services/api.service.ts` (add `acknowledgeNoProgress(slug, taskId)` method; add `topUpBudget(slug, taskId, opts)` method ~after line 86)
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/pages/task-detail.component.ts` (add no-progress streak badge in header ~line 44-48; add budget badge in Phase actions card ~line 121-126; disable Advance button when streak >= 2; add "Acknowledge and force advance" button; add "Top up budget" action)

**Dependencies**: Task 2.1 (API endpoints must exist for the service methods to call -- but the service methods can be written against the expected endpoint shape without waiting)

**Spec Reference**: implementation-plan.md lines 42-55, 103-111

**Pattern to Follow**: Existing Phase actions card (task-detail.component.ts lines 112-138) -- badges follow the DaisyUI badge pattern already in use.

**Quality Requirements**:
- Task header badges: when `noProgressStreak >= 1`, show a warning badge `"no-progress streak: N"`. Badge color: `badge-warning` for N=1, `badge-error` for N>=2.
- Phase actions card: show `"budget: dispatchCount / dispatchBudget"` badge (e.g. `"budget: 17 / 20"`). Badge color: `badge-warning` when >= 80%, `badge-error` when >= 100%.
- Advance button: disabled when `noProgressStreak >= 2` with tooltip: `"Two consecutive dispatches produced no observable change. Inspect the logs and acknowledge before retrying."`
- "Acknowledge and force advance" button: appears when `noProgressStreak >= 2`. Calls `acknowledgeNoProgress` then `advanceTask`. Shows a confirmation dialog first.
- "Top up budget" button: appears when budget is close to exhausted. Opens a small input for the delta (default +5). Calls `topUpBudget`.
- Handle `E_BUDGET_EXHAUSTED` error code from the advance endpoint: show a specific toast with a "Top up budget" link.

**Validation Notes**:
- The `TaskDetail` type extends `TaskSummary`, so adding fields to `TaskSummary` in models/index.ts automatically makes them available in the task-detail component.
- The API service's `task()` method returns `TaskDetail` which includes all `TaskSummary` fields. The backend must return `dispatchBudget` and `noProgressStreak` in the GET task response -- this is handled in Task 2.1.
- The `advanceTask` API method must handle the new error response shape (with `code: 'E_BUDGET_EXHAUSTED'`). The error handler in `confirmAdvance()` (line 585-608) must detect this code and show the appropriate UI.

**Implementation Details**:
- New signals in the component: `noProgressStreak = computed(() => this.task()?.noProgressStreak ?? 0)`, `budgetExhausted = computed(() => ...)`
- New API methods:
  ```
  acknowledgeNoProgress(slug, taskId): Observable<{ ok: true }>
  topUpBudget(slug, taskId, opts: { delta?: number; set?: number }): Observable<{ ok: true; dispatchBudget: number }>
  ```
- The "Acknowledge and force advance" flow: 1) call `acknowledgeNoProgress`, 2) on success call `advanceTask`, 3) on either failure show toast.

---

**Batch 2 Verification**:
- All modified files exist at their paths
- Dashboard builds: `cd openclaw-control/dashboard && npx ng build`
- API endpoints return correct status codes (409 for budget exhausted, 200 for ack/budget)
- `progressMade` flows through the follower relay path
- Edge cases from validation handled

---

## Batch 3: Tests -- PENDING

**Developer**: senior-tester
**Execution Mode**: sequential (test file is single; test assertions build on each other)
**Tasks**: 1 | **Dependencies**: Batch 1 + Batch 2 complete

### Task 3.1: No-progress detection test suite -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/test/no-progress-detection.test.ts` (NEW)

**Spec Reference**: implementation-plan.md lines 112-120

**Pattern to Follow**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/test/dispatch-poison.test.ts` -- same test structure, same `setupTestDb()` pattern.

**Quality Requirements**:
Five test cases (per implementation-plan.md acceptance criteria):
1. Dispatch that writes a new file -> `progressMade=true` -> row state = `done`
2. Dispatch that writes nothing -> `progressMade=false` -> state = `failed` + stderr matches `"no progress detected"`
3. Three consecutive no-progress dispatches -> third transitions to `poisoned` (existing K-window catches it)
4. `acknowledgeNoProgress` clears the streak (bumps budget by 1)
5. `advanceTask` refuses when `dispatch_count >= dispatch_budget` (returns blockedReason matching `budget`)

**Validation Notes**:
- Test 1: Create a task, claim a dispatch, call `markDone(id, { exitCode: 0, durationMs, progressMade: true })` -> verify state is `done`.
- Test 2: Same but `progressMade: false` -> verify state is `failed`, stderr includes no-progress marker.
- Test 3: Do test 2 three times for the same (project, task, phase) -> third should be `poisoned`.
- Test 4: After acknowledgment, the streak check should allow advance again. Verify by calling `acknowledgeNoProgress` then `advanceTask`.
- Test 5: Set `dispatch_budget` to a low value (e.g. 1), insert one dispatch, then try to advance -> blocked.
- Import `./env-stamp.ts` for leader mode, use `setupTestDb()`, stamp `OPENCLAW_PROJECTS_DIR`.

**Implementation Details**:
- Use `node:test` + `node:assert/strict` (same as existing tests).
- Each test gets its own TASK_TEST_NNN id to avoid collisions.
- For the `markDone` tests, directly call `DispatchRepo.markDone` with `progressMade` -- no need for HTTP harness.
- For the `advanceTask` tests, use the continuation module directly (same as `hitl-advance.test.ts`).

---

**Batch 3 Verification**:
- All 5 test cases pass: `cd openclaw-control/daemon && node --test --import tsx test/no-progress-detection.test.ts`
- Existing tests still pass: `cd openclaw-control/daemon && node --test --import tsx test/dispatch-poison.test.ts test/hitl-advance.test.ts`

---

## Batch 4: Documentation -- PENDING

**Developer**: backend-developer
**Execution Mode**: sequential (small batch, single task)
**Tasks**: 1 | **Dependencies**: Batch 1 + 2 complete (implementation must be finalized before documenting)

### Task 4.1: Docs sweep -- ARCHITECTURE.md + OPERATIONS.md -- PENDING

**Files**:
- `/home/anubis/Desktop/fixing-openclaw/docs/ARCHITECTURE.md` (add paragraph under "dispatch lifecycle": exit 0 + no progress = soft-failure; poison policy applies; document `dispatch_budget` semantics)
- `/home/anubis/Desktop/fixing-openclaw/docs/OPERATIONS.md` (add runbook for "task is stuck on no-progress, what do I check": logs, ptah session JSONL, LLM provider status, then ack-and-retry vs cancel-task)

**Spec Reference**: implementation-plan.md lines 121-126

**Pattern to Follow**: Existing dispatch lifecycle section in ARCHITECTURE.md; existing runbook format in OPERATIONS.md.

**Quality Requirements**:
- ARCHITECTURE.md: short paragraph explaining that `exitCode=0` + `progressMade=false` is now a first-class soft-failure. Explain the data flow: snapshot before/after -> `markDone(progressMade=false)` -> state=`failed` with no-progress stderr -> K-recent-failed window catches streaks -> `poisoned` on Kth no-progress. Document `dispatch_budget` column (default 20, `advanceTask` checks before dispatching, operator can top up).
- OPERATIONS.md: runbook-style section. Steps: 1) Check the task-detail dashboard for no-progress badge, 2) Inspect the most recent dispatch stderr for the "no progress detected" marker, 3) Check the ptah session JSONL for empty `agent.message` events, 4) Check LLM provider status (rate limits, auth refresh), 5) If root cause is transient: "Acknowledge and force advance" (bumps budget by 1), 6) If root cause is persistent: cancel the task or reconfigure the agent.

**Validation Notes**:
- When code disagrees with docs, code wins -- so the docs must accurately reflect the implemented behavior.
- The `dispatch_budget` default of 20 is documented as a tunable. Mention that operators can adjust per-task via the budget endpoint.

---

**Batch 4 Verification**:
- Both doc files updated
- No factual conflicts with the implemented code
- Runbook steps are actionable and reference the correct API endpoints

---

## Dependency Graph

```
Batch 1 (sequential)
  Task 1.1 (schema v4)
    |
    v
  Task 1.2 (markDone + snapshot)
    |
    v
  Task 1.3 (invoker agentMessageBytes)  [can run in parallel with 1.2 after 1.1]
    |
    v
  Task 1.4 (advanceTask budget + ack)

Batch 2 (parallel: 2.1 and 2.2 are file-disjoint)
  Task 2.1 (API endpoints)  [depends on Batch 1]
  Task 2.2 (Dashboard)      [depends on Batch 1; can start alongside 2.1]

Batch 3 (sequential)
  Task 3.1 (Tests)          [depends on Batch 1 + 2]

Batch 4 (sequential)
  Task 4.1 (Docs)           [depends on Batch 1 + 2]
```

## Recommended Execution Order

1. **Batch 1** -> backend-developer / sequential (Tasks 1.1 -> 1.2 -> 1.3 -> 1.4)
   - Task 1.3 (invoker) is independent of 1.2 and could run in parallel via CLI agent, but it's small enough that sequential is simpler.
2. **Batch 2** -> backend-developer (2.1) + frontend-developer (2.2) / parallel
   - Two file-disjoint tasks. CLI agents (gemini) can fan these out.
3. **Batch 3** -> senior-tester / sequential
4. **Batch 4** -> backend-developer / sequential (small, can be merged with Batch 2 if desired)