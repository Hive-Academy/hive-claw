# Development Tasks - TASK_2026_007

**Total Tasks**: 14 | **Batches**: 6 | **Status**: 0/6 complete

---

## Plan Validation Summary

**Validation Status**: PASSED WITH RISKS

### Assumptions Verified

- `rawRelay` at `leaderClient.ts:341` handles all four new endpoints generically: VERIFIED (no leaderClient changes needed)
- `ProjectsRepo` uses lazy `let cached: Statements | null` pattern: VERIFIED (projects.ts:48)
- `stmts()` cache function exists and follows the established pattern: VERIFIED (projects.ts:50-68)
- `storage.ts` imports `ProjectsRepo` via `db/index.js`: needs verification during Task 2.1 — `ProjectRow` type import may need to be added
- `styles.css` `.markdown-body` rules are already complete: VERIFIED per implementation plan — Batch 6 skipped entirely
- `leaderClient.ts` Batch 4 requires no changes: VERIFIED per implementation plan — skipped
- `TaskSummary` in `models/index.ts` has `checkpointPending` field: VERIFIED (models/index.ts:29)
- `Agent` type is already exported from `models/index.ts`: VERIFIED (models/index.ts:57-67)

### Risks Identified

| Risk | Severity | Mitigation |
|------|----------|------------|
| `ProjectRow` import may not exist in `storage.ts` | LOW | Task 2.1 developer must check existing imports and add if missing |
| `countCancelledDispatches` statement described in plan but superseded by `run().changes` approach | LOW | Task 1.2 must use `cancelResult.changes` — do NOT add the `countCancelledDispatches` statement |
| Follower relay in `storage.ts` calls leader endpoints with 409 leader-only guard | LOW | Confirmed intentional — followers return 409; no proxy needed |
| `optionalString` helper referenced in bot-bridge Task 8.2 may not exist in `daemonTools.ts` | MED | Task 8.2 developer must verify `optionalString` helper exists or implement inline fallback |

### Edge Cases to Handle

- Task 1.1: `delete()` returns `false` when project not found — surface correctly through storage and API (404)
- Task 1.2: `deleteTask()` transaction must use `cancelResult.changes` not a time-window COUNT query
- Task 3.1: slug path-traversal guard (`..`, `/`, `\`) required on DELETE /api/projects/:slug
- Task 7.2: `createProject` 409 error must show "A project with that slug already exists" (not generic message)
- Task 7.3: `reassignAgent` must no-op (no API call) when new agent equals current agent
- Task 8.2: `create_project` tool handler must use `optionalString` helper or safe fallback for optional `workspace` param

---

## Batch 1: DB Layer - Backend 🔄 IN PROGRESS

**Developer**: backend-developer
**Tasks**: 2 | **Dependencies**: None

### Task 1.1: Add `deleteProject` and `updateProject` to ProjectsRepo 🔄 IN PROGRESS

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/projects.ts`
**Spec Reference**: implementation-plan.md, Batch 1 section 1a

**Quality Requirements**:
- Follow lazy `let cached: Statements | null` pattern (existing at line 48)
- `delete` statement: `DELETE FROM projects WHERE slug = @slug`
- `update` statement: `UPDATE projects SET name/workspace/default_branch = COALESCE(@field, field), updated_at = strftime(...)` WHERE slug = @slug
- `delete()` method returns `boolean` (result.changes > 0)
- `update()` method returns `ProjectRow | null` (calls `ProjectsRepo.get(slug)` after update)
- Add both statements to the `Statements` interface AND the `stmts()` function
- Do NOT invalidate the `cached` reference — append new fields to the existing interface

**Implementation Details**:
- Add to `Statements` interface: `delete: Statement<{ slug: string }>` and `update: Statement<{ slug: string; name: string | null; workspace: string | null; default_branch: string | null }>`
- In `stmts()`: assign `delete` and `update` prepared statements
- Add `delete(slug: string): boolean` and `update(slug, fields): ProjectRow | null` to the `ProjectsRepo` export object

---

### Task 1.2: Add `deleteTask` and `updateAssignedAgent` to TasksRepo 🔄 IN PROGRESS

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/db/tasks.ts`
**Spec Reference**: implementation-plan.md, Batch 1 section 1b
**Dependencies**: None (independent of Task 1.1)

**Quality Requirements**:
- Add to `Statements` interface: `deleteTask`, `deleteTaskFiles`, `cancelPendingDispatches`, `updateAssignedAgent`
- Do NOT add `countCancelledDispatches` — use `cancelResult.changes` instead (plan §1b revised approach)
- `deleteTask()` method wraps three operations in a single `db.transaction()`: (1) cancel pending/taken dispatches, (2) delete task_files, (3) delete task row
- Return type: `{ cancelledDispatches: number; wasInProgress: boolean } | null`
- `updateAssignedAgent()` returns `boolean` (result.changes > 0)
- Follow `db.transaction(() => { ... })()` pattern — NOT async

**Implementation Details**:
- `cancelPendingDispatches`: `UPDATE dispatches SET state = 'failed', completed_at = strftime(...) WHERE project_slug = @project_slug AND task_id = @task_id AND state IN ('pending', 'taken')`
- `deleteTaskFiles`: `DELETE FROM task_files WHERE project_slug = @project_slug AND task_id = @task_id`
- `deleteTask`: `DELETE FROM tasks WHERE project_slug = @project_slug AND id = @id`
- `updateAssignedAgent`: `UPDATE tasks SET assigned_agent = @assigned_agent, updated_at = strftime(...) WHERE project_slug = @project_slug AND id = @id`
- Use `const cancelResult = stmts().cancelPendingDispatches.run(...)` then `cancelResult.changes` for the count

**Validation Notes**:
- `wasInProgress` is determined by reading the task BEFORE deleting: `task.currentPhase === 'IN_PROGRESS' || task.checkpointPending`
- Transaction rolls back automatically on throw (better-sqlite3 behavior)

---

**Batch 1 Verification**:
- Both files compile without TypeScript errors
- `ProjectsRepo` export has `delete` and `update` methods
- `TasksRepo` export has `deleteTask` and `updateAssignedAgent` methods
- No `countCancelledDispatches` statement added
- code-logic-reviewer approved

---

## Batch 2: Storage Facade - Backend ⏸️ PENDING

**Developer**: backend-developer
**Tasks**: 1 | **Dependencies**: Batch 1

### Task 2.1: Add four new functions to storage.ts ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/storage.ts`
**Spec Reference**: implementation-plan.md, Batch 2

**Quality Requirements**:
- Add four exported async functions: `deleteProject`, `updateProject`, `deleteTask`, `updateTaskAgent`
- Each function: leader branch calls repo directly; follower branch calls `leaderClient.rawRelay`
- `rawRelay` pattern: check `r.statusCode === 404` → return null; `>= 200 && < 300` → return success; else throw
- Import `ProjectRow` from `./db/index.js` if not already imported (check existing imports first)
- Import `ProjectsRepo` from `./db/index.js` if not already imported (check existing imports)
- Follow the existing leader/follower branching pattern in the file

**Implementation Details**:
- `deleteProject(slug)`: leader calls `ProjectsRepo.delete(slug)`, returns `{ ok: true } | null`; follower relays `DELETE /api/projects/${encodeURIComponent(slug)}`
- `updateProject(slug, fields)`: leader calls `ProjectsRepo.update(slug, fields)`, returns `ProjectRow | null`; follower relays `PUT /api/projects/${encodeURIComponent(slug)}`
- `deleteTask(slug, taskId)`: leader calls `TasksRepo.deleteTask(slug, taskId)`, returns `{ ok: true; cancelledDispatches: number; wasInProgress: boolean } | null`; follower relays `DELETE /api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`
- `updateTaskAgent(slug, taskId, assignedAgent)`: leader calls `TasksRepo.updateAssignedAgent(slug, taskId, assignedAgent)`, returns `{ ok: true; taskId: string; assignedAgent: string } | null`; follower relays `PUT /api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`

**Validation Notes**:
- Verify whether `ProjectsRepo` and `ProjectRow` are already imported from `./db/index.js` before adding imports
- The follower relay is for routing, NOT for circumventing the leader-only guard — followers will receive 409 from the leader and re-throw

---

**Batch 2 Verification**:
- File compiles without TypeScript errors
- All four new functions exported
- No direct `getDb()` calls (facade pattern)
- code-logic-reviewer approved

---

## Batch 3: API Routes - Backend ⏸️ PENDING

**Developer**: backend-developer
**Tasks**: 1 | **Dependencies**: Batch 2

### Task 3.1: Add four new route handlers to api.ts ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/daemon/src/api.ts`
**Spec Reference**: implementation-plan.md, Batch 3

**Quality Requirements**:
- All four routes carry `{ preHandler: guard }` (pattern from api.ts:180-184)
- All four routes enforce leader-only with `if (!config.leader) return reply.code(409).send({ error: '...' })`
- `broadcast(...)` called AFTER storage mutation returns, never inside the transaction
- Insert after the existing `POST /api/projects` handler
- All four routes use `storage.*` functions (never repos directly)

**Implementation Details**:

Route 1 — `DELETE /api/projects/:slug`:
- Slug path-traversal guard: reject if slug contains `..`, `/`, or `\` with 400
- Call `storage.deleteProject(slug)` → null means 404
- On success: `broadcast('project.deleted', { slug })` then return `{ ok: true }`

Route 2 — `PUT /api/projects/:slug`:
- Parse `body.name`, `body.workspace`, `body.defaultBranch` — only update fields present and non-empty string
- Call `storage.updateProject(slug, fields)` → null means 404
- Return the updated `ProjectRow`

Route 3 — `DELETE /api/projects/:slug/tasks/:taskId`:
- Verify project exists first: `storage.readProject(req.params.slug)` → 404 if null
- Call `storage.deleteTask(slug, taskId)` → null means 404
- On success: `broadcast('task.deleted', { slug, taskId })` then return `{ ok: true, cancelledDispatches, warning? }`
- Include `warning: 'task was IN_PROGRESS'` in response only if `result.wasInProgress` is true

Route 4 — `PUT /api/projects/:slug/tasks/:taskId`:
- Verify project exists first: `storage.readProject(req.params.slug)` → 404 if null
- Validate `body.assignedAgent` is a non-empty string → 400 if invalid
- Call `storage.updateTaskAgent(slug, taskId, assignedAgent)` → null means 404
- Return `{ ok: true, taskId, assignedAgent }`

**Validation Notes**:
- The `storage.readProject` call on task routes must handle follower relay correctly (it already does via existing facade)
- Do NOT add leader-only guard after already checking follower — pick one: either enforce leader-only (reject at route) or relay; implementation plan confirms leader-only enforcement (no follower relay for mutating routes)

---

**Batch 3 Verification**:
- All four routes registered and respond correctly
- TypeScript compiles clean
- SSE broadcasts fire after storage calls
- code-logic-reviewer approved

---

## Batch 5: Frontend API Service and Models ⏸️ PENDING

**Developer**: frontend-developer
**Tasks**: 2 | **Dependencies**: None (can run in parallel with Batches 1-3)

### Task 5.1: Add `ProjectRow` interface to models/index.ts ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/models/index.ts`
**Spec Reference**: implementation-plan.md, Batch 5 section 5a

**Quality Requirements**:
- Add `ProjectRow` as a new exported interface (does NOT replace `ProjectSummary`)
- Fields: `slug`, `name`, `workspace: string | null`, `githubRepo: string | null`, `defaultBranch: string | null`, `createdAt: string`, `updatedAt: string`
- Append to bottom of file, after existing exports

---

### Task 5.2: Add five typed methods to ApiService ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/services/api.service.ts`
**Spec Reference**: implementation-plan.md, Batch 5 section 5b
**Dependencies**: Task 5.1

**Quality Requirements**:
- Add `ProjectRow` to the existing `import type { ... } from '../models/index'` statement
- All methods follow existing pattern: `this.http.METHOD<T>(url, [body,] { withCredentials: true })`
- Return types must be `Observable<T>` matching the backend response shapes
- No special error handling — Angular HttpClient surfaces non-2xx as Observable errors automatically

**Implementation Details**:
- `createProject(body: { slug: string; name: string; workspace?: string }): Observable<ProjectRow>` — POST /api/projects
- `deleteProject(slug: string): Observable<{ ok: true }>` — DELETE /api/projects/:slug
- `updateProject(slug, body): Observable<ProjectRow>` — PUT /api/projects/:slug
- `deleteTask(slug, taskId): Observable<{ ok: true; cancelledDispatches: number }>` — DELETE /api/projects/:slug/tasks/:taskId
- `updateTask(slug, taskId, body): Observable<{ ok: true; taskId: string; assignedAgent: string }>` — PUT /api/projects/:slug/tasks/:taskId

---

**Batch 5 Verification**:
- TypeScript compiles without errors
- `ProjectRow` exported from models
- All five new methods on `ApiService`
- code-logic-reviewer approved

---

## Batch 7: Frontend Pages ⏸️ PENDING

**Developer**: frontend-developer
**Tasks**: 3 | **Dependencies**: Batch 5

### Task 7.1: sessions.component.ts — Chat-style tail renderer ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/pages/sessions.component.ts`
**Spec Reference**: implementation-plan.md, Batch 7 section 7a

**Quality Requirements**:
- Angular 18 standalone signals + OnPush: follow existing component pattern
- Add `MarkdownComponent` to the `imports` array; import from `'../components/markdown.component'`
- Replace the raw `<pre>{{ stringify(e) }}</pre>` tail events loop with the chat-style renderer
- Add `formatTs(ts: string | number): string` method to the component class (relative time: Xs ago / Xm ago / localeTimeString)
- Role dispatch: `'user'` → left-aligned ghost badge; `'assistant'` → right-aligned primary badge with `<oc-md>`; `'tool'`/`'tool_result'` → `<details>` collapsed; fallback → `<details>` collapsed raw JSON
- Do NOT change the live-feed section (lines 99-115)
- Preserve the empty-state message for zero events

**Implementation Details**:
- New `@for` loop: `@let role = e.role ?? e.type ?? ''` then `@if`/`@else if`/`@else` branches per spec
- Assistant branch uses `<oc-md [source]="e.content ?? e.text ?? ''" />`
- Tool branch: `<summary>` shows tool name/tool_use_id and timestamp; `<pre>` body shows `{{ stringify(e) }}`
- `formatTs`: `const diffMs = Date.now() - new Date(ts).getTime()` → `Xs ago` / `Xm ago` / `toLocaleTimeString()`

**Validation Notes**:
- `tail` is already a signal — template reads inside `@if (tail(); as t)` which is signal-tracked; no `markForCheck()` needed
- OnPush is satisfied because signals trigger re-render automatically

---

### Task 7.2: projects.component.ts — Create and delete modals ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/pages/projects.component.ts`
**Spec Reference**: implementation-plan.md, Batch 7 section 7b

**Quality Requirements**:
- Add `FormsModule` to `imports` array
- Inject `ToastService` if not already injected
- `ApiService` is already injected — add calls to `createProject` and `deleteProject`
- DaisyUI modal pattern: `signal<boolean>` + `@if (showModal()) { <dialog open class="modal modal-open"> }` — do NOT call `showModal()` imperatively
- Form fields are plain class properties for `ngModel` two-way binding (not signals)
- `createError` is a `signal('')`

**New signals to add**:
- `showCreateModal = signal(false)`
- `showDeleteModal = signal(false)`
- `deleteTarget = signal<ProjectSummary | null>(null)`
- `creating = signal(false)`
- `deleting = signal(false)`
- `createError = signal('')`

**Plain properties to add**:
- `newSlug = ''`, `newName = ''`, `newWorkspace = ''`

**Template changes**:
- Add "New Project" button in the header row next to the search input
- Wrap each project card `<a>` in `<div class="relative group">` with absolutely-positioned delete icon (appears on hover via group-hover)
- Replace empty-state hint: `No projects found. Create one with the New Project button above.`
- Append create modal and delete confirmation modal after the grid

**New methods to add**:
- `openCreateModal()`, `closeCreateModal()`, `submitCreate()`, `openDeleteModal(p, event)`, `closeDeleteModal()`, `confirmDelete()`, `reload()`
- `submitCreate` validates slug format with regex `^[a-z0-9][a-z0-9-]{0,63}$` before submitting
- 409 response from `createProject` → show "A project with that slug already exists"
- `confirmDelete` on success: `this.projects.update((list) => list.filter((p) => p.slug !== target.slug))` (no full reload)

**Validation Notes**:
- Both `closeCreateModal` and `closeDeleteModal` must reset form state (no modal state leak between openings)
- `openDeleteModal` must call `event.preventDefault()` AND `event.stopPropagation()` to avoid navigating to the project

---

### Task 7.3: tasks.component.ts — Delete modal and inline agent reassign ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/dashboard/src/app/pages/tasks.component.ts`
**Spec Reference**: implementation-plan.md, Batch 7 section 7c

**Quality Requirements**:
- Add `Agent` import from `'../models/index'` (already exported)
- DaisyUI modal pattern for delete: same signal + `@if` approach as projects
- `reassigningTaskId` is a signal — template re-renders automatically (no `markForCheck`)
- `<select>` has both `(blur)` and `(keydown.escape)` bindings that cancel reassign without saving
- No `MarkdownComponent` needed here

**New signals to add**:
- `showDeleteModal = signal(false)`
- `deleteTarget = signal<TaskSummary | null>(null)`
- `deleting = signal(false)`
- `reassigningTaskId = signal<string | null>(null)`
- `agents = signal<Agent[]>([])`

**Template changes**:
- Replace agent `<td>` with inline reassign select (when `reassigningTaskId() === t.id`) or clickable badge
- Replace last actions `<td>` to include both "Open ->" link and "Delete" button
- Append delete confirmation modal after the task table card
- Delete modal body: show task id, phase, and warning if `phase === 'IN_PROGRESS' || checkpointPending`

**New methods to add**:
- `openDeleteModal(t, event)`, `closeDeleteModal()`, `confirmDeleteTask()`, `startReassign(t, event)`, `reassignAgent(t, newAgentId)`
- Load agents in `ngOnInit` via `this.api.agents().subscribe(...)` — non-fatal on error (agents degrade to empty list)
- `reassignAgent` no-ops (sets `reassigningTaskId(null)`) when `newAgentId === t.assignedAgent`
- `confirmDeleteTask` on success: `this.tasks.update((list) => list.filter((t) => t.id !== target.id))` + `this.toast.success(...)`

---

**Batch 7 Verification**:
- TypeScript compiles without errors
- All three components compile with OnPush + signals pattern intact
- No imperative `showModal()` DOM calls
- code-logic-reviewer approved

---

## Batch 8: Bot-bridge ⏸️ PENDING

**Developer**: backend-developer
**Tasks**: 2 | **Dependencies**: Batch 3 (endpoints must exist before handlers call them)

### Task 8.1: Add four daemon client methods to daemonClient.ts ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/bot-bridge/src/daemonClient.ts`
**Spec Reference**: implementation-plan.md, Batch 8 section 8a

**Quality Requirements**:
- Add four new methods to the `daemon` export object
- Follow existing `call<T>(method, path, body?)` generic helper pattern
- Use `encodeURIComponent` for all path segments (slug, taskId)

**Implementation Details**:
- `createProject`: `call<{ slug: string; name: string }>('POST', '/api/projects', body)`
- `deleteProject(slug)`: `call<{ ok: true }>('DELETE', \`/api/projects/${encodeURIComponent(slug)}\`)`
- `deleteTask(slug, taskId)`: `call<{ ok: true; cancelledDispatches: number; warning?: string }>('DELETE', \`/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}\`)`
- `updateTask(slug, taskId, body)`: `call<{ ok: true; taskId: string; assignedAgent: string }>('PUT', \`/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}\`, body)`

---

### Task 8.2: Add four tool definitions to daemonTools.ts ⏸️ PENDING

**File**: `/home/anubis/Desktop/fixing-openclaw/openclaw-control/bot-bridge/src/tools/daemonTools.ts`
**Spec Reference**: implementation-plan.md, Batch 8 section 8b
**Dependencies**: Task 8.1

**Quality Requirements**:
- Add four tool definitions to the `list()` return array after existing `dispatch_orchestration_task` tool
- Tool definition shape: `{ name, description, parameters: JSONSchema, handler: async (args, ctx) => string }`
- Use `requireString` helper for required string args — throws descriptively on missing/wrong type
- For optional `workspace` arg in `create_project`: verify `optionalString` helper exists in scope; if not, implement inline as `typeof args.workspace === 'string' ? args.workspace : undefined`
- All handlers let `daemon.*` errors propagate naturally — no try/catch (LLM sees tool failure)
- After addition, `list()` must return 13 tools total

**Tool definitions**:
- `create_project`: params `{ slug: string (required), name: string (required), workspace: string (optional) }` — calls `daemon.createProject`
- `delete_project`: params `{ project: string (required) }` — calls `daemon.deleteProject`
- `delete_task`: params `{ project: string (required), taskId: string (required) }` — calls `daemon.deleteTask`
- `update_task`: params `{ project: string (required), taskId: string (required), assignedAgent: string (required) }` — calls `daemon.updateTask`

**Validation Notes**:
- `delete_project` description must clearly state this is irreversible
- All JSON schemas include `additionalProperties: false`

---

**Batch 8 Verification**:
- TypeScript compiles without errors
- `daemon` export has four new methods
- `list()` returns 13 tools
- No try/catch in handlers
- code-logic-reviewer approved
