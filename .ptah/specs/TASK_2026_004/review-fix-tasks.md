# TASK_2026_004 — Review Fix Tasks

Generated from the triple-review (code-style + code-logic + security) run on 2026-05-06.

## Blockers — fix before merge

### [BLOCKER-1] Rejection is silently recorded as approval
- **Files:** `openclaw-control/daemon/src/storage.ts:371-388`, `openclaw-control/daemon/src/continuation.ts:354-404`
- **Problem:** `storage.recordApproval` accepts `decision: 'APPROVED' | 'REJECTED'` but never passes it through to `continuationRecordApproval`. Both the continuation helper and `TasksRepo.recordApproval` hard-code `approvals[phase] = true`. The dashboard's Reject button returns 200 but the checkpoint is approved anyway, breaking the safety model.
- **Fix:**
  1. Change `TasksRepo.recordApproval` signature to accept `approved: boolean` and write `approvals[phase] = approved`.
  2. Thread `decision` through `continuationRecordApproval` → `TasksRepo.recordApproval(..., decision === 'APPROVED')`.
  3. Update `recordApproval` frontmatter rewrite to set `approvals[phase] = approved` too.
  4. Add a test in `hitl-advance.test.ts` for rejection.

### [BLOCKER-2] Unhandled promise rejection on inline fast path
- **File:** `openclaw-control/daemon/src/continuation.ts:290`
- **Problem:** `void invokeClaudeForTask(...)` is fire-and-forget with no `.catch()`. If `spawnPtahForAgent` throws (missing binary, bad harness), the Promise rejects uncaught and can crash the leader daemon. The HTTP response already returned `ok: true, inlined: true`, so the operator believes work started when nothing is running.
- **Fix:**
  ```ts
  invokeClaudeForTask({ ... }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    DispatchRepo.appendLog(id ?? 'inline', `inline dispatch failed: ${msg}`, 'error');
    broadcast('dispatch.failed', { project: project.slug, taskId: task.id, phase: task.phase, agentId, error: msg });
  });
  ```

### [BLOCKER-3] Stale `dist/` artifacts contain old continuation loop code
- **Files:** `openclaw-control/daemon/dist/continuation.js`, `openclaw-control/daemon/dist/index.js`, `openclaw-control/daemon/dist/storage.js`
- **Problem:** `dist/continuation.js` still exports `tickOnce` and `startContinuationLoop`. `dist/index.js` still imports and calls `startContinuationLoop`. If the container image is built from `dist/` without a rebuild, the old loop deploys and the HITL invariant is violated at runtime.
- **Fix:**
  ```bash
  cd openclaw-control/daemon && npm run build
  git add dist/
  git commit -m "chore(daemon): rebuild dist/ after HITL refactor"
  ```
  Or add `npm run build` to the Dockerfile so `dist/` is never the source of truth.

### [BLOCKER-4] Docs not updated for HITL model
- **Files:** `docs/ARCHITECTURE.md` (lines ~111, 195, 212), `docs/CONFIGURATION.md`, `CLAUDE.md`
- **Problem:** `ARCHITECTURE.md` still describes the "continuation loop" and `tickOnce()` as the dispatch mechanism. `CONFIGURATION.md` still documents `OPENCLAW_TICK_MS`/`OPENCLAW_DISABLE_CONTINUATION` and does not document the new endpoints. `CLAUDE.md` still says the leader "runs the continuation loop."
- **Fix:**
  1. In `ARCHITECTURE.md`, replace the continuation-loop description with the HITL model (Advance button creates one dispatch at a time).
  2. In `CONFIGURATION.md`, remove `OPENCLAW_TICK_MS` and `OPENCLAW_DISABLE_CONTINUATION`. Add a "Manual dispatch (HITL)" section documenting `/advance`, `/cancel-pending`, `DELETE /dispatches/:id`.
  3. In `CLAUDE.md`, update the leader description to say the leader runs only the dispatch worker (no continuation).
  4. Add the invariant statement to all three: "No LLM call ever fires unless a human clicked a button on the dashboard for that specific task, in that specific phase."

---

## Major issues — should fix

### [MAJOR-5] `dispatch_count` under-counts local-agent inline dispatches
- **File:** `openclaw-control/daemon/src/continuation.ts:278-306`
- **Problem:** `TasksRepo.bumpDispatchCount` is only called inside `DispatchRepo.insertPending`. The local-agent inline path skips the DB, so the dashboard "Lifetime" metric stays at 0 for local-agent tasks.
- **Fix:** Call `TasksRepo.bumpDispatchCount(projectSlug, taskId)` in the inline branch before `invokeClaudeForTask`.

### [MAJOR-6] Local-agent inline path can double-dispatch after restart
- **File:** `openclaw-control/daemon/src/continuation.ts:278-306`
- **Problem:** The inline path checks `isInflight()` (an in-memory Set). After a daemon restart, this Set is empty. If a pending dispatch for the same task exists in the DB, the inline path fires while the DB row can still be claimed by a follower worker.
- **Fix:** Before the inline fast-path, query the DB for open dispatches for this (task, phase). If one exists, return the same dedup `blockedReason` the remote path uses. The `DispatchRepo.listForTask` helper can be used for the check.

### [MAJOR-7] Advance confirmation modal lacks pre-dispatch prompt preview
- **File:** `openclaw-control/dashboard/src/app/pages/task-detail.component.ts:565-579`
- **Problem:** The spec says the modal must show the actual prompt preview above the buttons so accidental clicks are obvious. The current modal shows a generic placeholder. The real `promptPreview` is only shown in the toast *after* dispatch.
- **Fix options:**
  - (A) Add a new endpoint `GET /api/projects/:slug/tasks/:taskId/preview` that returns `{ promptPreview }` without inserting a dispatch. Wire it in `api.service.ts` and call it from `openAdvanceConfirm()` before showing the modal.
  - (B) Build the preview client-side from known task state and accept the simpler flow. Update the spec to match.

### [MAJOR-8] `previewReadyTasks` is dead code — no HTTP endpoint
- **File:** `openclaw-control/daemon/src/continuation.ts:145`
- **Problem:** The function is exported but never registered as an API endpoint. The dashboard's Phase actions card only disables "Run phase" for `phase === 'DONE'`; it does not use `blockedReason` to preemptively disable for unapproved checkpoints.
- **Fix options:**
  - (A) Wire `previewReadyTasks` to a new `GET /api/projects/:slug/tasks/:taskId/preview` (can share the route with MAJOR-7) and have the dashboard poll it.
  - (B) Remove `previewReadyTasks` entirely if the simpler client-side gating is sufficient. Update the spec.

---

## Minor issues — nice to have

### [MINOR-9] Stale checkpoint banner text references "continuation loop"
- **File:** `openclaw-control/dashboard/src/app/pages/task-detail.component.ts:57`
- **Fix:** Change "Approve to let the continuation loop run the next phase." to "Approve to enable the Advance button for the next phase."

### [MINOR-10] Type duplication in `api.service.ts`
- **File:** `openclaw-control/dashboard/src/app/services/api.service.ts:62-86`
- **Fix:** Extract a named `TaskAdvanceResult` DTO in `models/index.ts` and reference it from `api.service.ts`.

### [MINOR-11] Unused template alias
- **File:** `openclaw-control/dashboard/src/app/pages/task-detail.component.ts:141`
- **Fix:** Remove `as confirm` from `@if (advanceConfirmOpen(); as confirm)` — the variable is never referenced.

### [MINOR-12] Dead code branch in advance toast
- **File:** `openclaw-control/dashboard/src/app/pages/task-detail.component.ts:596-598`
- **Fix:** Remove the `else` branch that toasts "Advance accepted". The condition is unreachable because `advanceTask` always returns either `inlined: true` or `dispatchId` when `ok: true`.

### [MINOR-13] `dispatchCount` typed as optional on client
- **File:** `openclaw-control/dashboard/src/app/models/index.ts:38`
- **Fix:** Make `dispatchCount: number` (non-optional) since the daemon always returns it (default 0). Remove `?? 0` coalescing in the template.

---

## Sub-task completion tracker

| # | Sub-task | Status | Notes |
|---|----------|--------|-------|
| B1.1 | Schema v3 (`dispatch_count`) | Complete | Migrations work on fresh + existing DBs |
| B1.2 | `cancelPending` / `cancelOne` | Complete | Correct no-failure-count semantics |
| B1.3 | Delete timer; rename `tickOnce` → `previewReadyTasks`; add `advanceTask` | Complete | Timer gone, `advanceTask` is sole dispatch path |
| B1.4 | New API endpoints; 410 old tick | Complete | `/advance`, `/cancel-pending`, `DELETE /dispatches/:id`, 410 on `/continuation/tick` |
| B1.5 | Bot-bridge audit (no tick tool) | Complete | No `tickContinuation` in `src/`, but stale `dist/` remains (BLOCKER-3) |
| B1.6 | Dashboard `api.service` updates | Complete | `advanceTask`, `cancelPendingForTask`, `cancelDispatch` added |
| B1.7 | Dashboard task-detail Phase actions card | Partial | Card exists but modal lacks pre-dispatch prompt preview (MAJOR-7) |
| B1.8 | Dashboard shell "loop: OFF (HITL)" badge | Complete | Badge present with tooltip |
| B1.9 | Tests (`hitl-advance.test.ts`) | Partial | 6 tests cover core paths; missing inline-path test + rejection test |
| B1.10 | Docs sweep (`ARCHITECTURE.md`, `CONFIGURATION.md`, `CLAUDE.md`) | Incomplete | Still describe continuation loop; no new endpoint docs (BLOCKER-4) |

---

## Recommended fix order

1. Fix BLOCKER-1 (rejection bug) — this breaks the safety model
2. Fix BLOCKER-2 (unhandled rejection) — crash risk
3. Fix BLOCKER-3 (stale dist/) — runtime invariant violation
4. Fix BLOCKER-4 (docs) — future agents will reintroduce the loop otherwise
5. Fix MAJOR-5 (dispatch_count inline) + MAJOR-6 (inline double-dispatch)
6. Fix MAJOR-7 (modal preview) — spec deviation
7. Decide on MAJOR-8 (previewReadyTasks endpoint) — either wire or remove
8. Run `node --test openclaw-control/daemon/test/hitl-advance.test.ts`
9. Add tests for: (a) rejection records `approved=false`, (b) inline path bumps `dispatch_count`
10. Address minors 9-13
11. Re-run reviewers on the delta

---

## Pre-existing security issues (not introduced by TASK_2026_004)

These were flagged by the security reviewer but are **not new** in this task. Track them separately if not already:

- Local-dev auth bypass when `DISCORD_CLIENT_ID` is empty (`daemon/src/auth.ts:194-195`)
- Path traversal in `projects.ts:resolveWorkspace` via attacker-controlled slug
- Prompt injection via unvalidated task metadata (`task.assignedAgent`, `task.discordUserId`) interpolated into LLM prompts
- Persona privacy leak in `buildContextForMessage` — reads `persona.md` without verifying `localAgentIds.includes(agentId)`
- Unauthenticated SSE stream (`/api/stream` has no `preHandler: guard`)

The TOCTOU race in `DELETE /api/dispatches/:id` (`getById` then `cancelOne`) is handled defensively (returns 409 on race). No additional action needed.
