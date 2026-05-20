# Requirements Document - TASK_2026_007

## Introduction

The openclaw-control dashboard currently lacks full project and task lifecycle management, renders session transcripts as raw JSON dumps, and does not expose project/task delete or agent-reassignment operations through the agent-accessible tool surface. This task delivers a coordinated set of changes across three packages — `daemon`, `dashboard`, and `bot-bridge` — to make the dashboard a first-class control surface and to give agents the same CRUD capability operators have.

Business value: operators spend less time in the database or using the Discord bot for housekeeping, and agents can self-manage project scaffolding without a human relay.

**Classification**: FEATURE | Priority: P1-High | Size: L

---

## Requirements

### Requirement 1: Session Tail — Chat-Style Message Renderer

**User Story:** As a dashboard operator viewing the live session feed or a historical session tail, I want messages rendered as a structured chat interface with role badges, timestamps, and tool-call collapsing, so that I can read what an agent is doing without parsing raw JSON.

#### Acceptance Criteria

1. WHEN a session tail event has `role === 'user'` THEN the renderer SHALL display it left-aligned with a "User" role badge in `badge-ghost` style.
2. WHEN a session tail event has `role === 'assistant'` THEN the renderer SHALL display it right-aligned with an "Assistant" role badge in `badge-primary` style and SHALL pass any text content through `MarkdownComponent` (`<oc-md>`).
3. WHEN a session tail event has `role === 'tool'` or `type === 'tool_result'` THEN the renderer SHALL collapse it into a `<details>` block labelled with the tool name and a "Tool" badge, showing raw content inside on expand.
4. WHEN a session tail event has a timestamp field THEN the renderer SHALL display it in a human-readable relative format (e.g. "2 min ago") using Angular's `DatePipe` or a standalone pipe.
5. WHEN the live feed receives a `session.message` SSE event THEN the renderer SHALL append the new message at the bottom of the feed without a full component re-render, using the existing `liveEvents` signal.
6. WHEN `tail.events` contains zero items THEN the renderer SHALL display the existing empty-state message unchanged.
7. WHEN a message has no recognized role field THEN the renderer SHALL fall back to the current `<details>`-collapsed raw JSON display rather than crashing.

#### Out of Scope for This Requirement
- Full markdown styling theme changes (covered in Requirement 4).
- Session export or search.

---

### Requirement 2: Projects Page — Create and Delete

**User Story:** As a dashboard operator managing the project registry, I want to create new projects via a modal form and delete existing projects with a confirmation prompt, so that I do not need direct database access or a Discord command for project housekeeping.

#### Acceptance Criteria

1. WHEN the Projects page loads THEN a "New Project" button SHALL be visible in the header row alongside the search input.
2. WHEN the operator clicks "New Project" THEN a DaisyUI `dialog` modal SHALL open with three fields: Slug (required, slug-format validated), Name (required), and Workspace path (optional).
3. WHEN the operator submits the form with valid inputs THEN `POST /api/projects` SHALL be called with `{ slug, name, workspace }` and on success the project list SHALL refresh and the modal SHALL close.
4. WHEN the operator submits with an empty Slug or Name THEN the form SHALL show inline validation errors and SHALL NOT submit.
5. WHEN the operator submits a slug that already exists THEN the daemon returns 409 and the modal SHALL display "A project with that slug already exists" without closing.
6. WHEN the operator hovers over a project card THEN a "Delete" icon button SHALL appear in the card's top-right corner.
7. WHEN the operator clicks "Delete" THEN a DaisyUI `dialog` confirmation modal SHALL appear displaying the project slug and a warning that the action cannot be undone.
8. WHEN the operator confirms deletion THEN `DELETE /api/projects/:slug` SHALL be called and on success the card SHALL be removed from the grid without a full page reload.
9. WHEN the project list is empty THEN the empty-state hint SHALL read "No projects found. Create one with the New Project button above." — removing the misleading `OPENCLAW_PROJECT_ROOTS` environment variable reference.
10. WHEN `OPENCLAW_LEADER=0` (follower) THEN `POST /api/projects` and `DELETE /api/projects/:slug` SHALL return `409` and the dashboard SHALL display "Project mutations are only available on the leader instance."

---

### Requirement 3: Tasks Page — Delete Task and Reassign Agent

**User Story:** As a dashboard operator managing tasks in a project, I want to delete tasks that are no longer needed and reassign tasks to a different agent without navigating to a separate page, so that I can manage task lifecycle from the task list view.

#### Acceptance Criteria

1. WHEN the operator opens the task row actions (rightmost column) THEN an "Open →" link SHALL remain and a "Delete" button (destructive, `btn-error btn-xs`) SHALL be added alongside it.
2. WHEN the operator clicks "Delete" on a task THEN a DaisyUI `dialog` confirmation modal SHALL display the task ID and phase, with a warning that dispatches in flight will be cancelled.
3. WHEN the operator confirms task deletion THEN `DELETE /api/projects/:slug/tasks/:taskId` SHALL be called; on success the task row SHALL be removed from the grouped table without a full reload.
4. WHEN the task is in phase `IN_PROGRESS` or has `checkpointPending === true` THEN the confirmation modal SHALL display an additional warning banner: "This task is actively running. Deleting it will cancel all pending dispatches."
5. WHEN the operator clicks the assigned agent badge on a task row THEN an inline `<select>` dropdown SHALL replace the badge, populated from `GET /api/agents` response, with the current agent pre-selected.
6. WHEN the operator selects a different agent from the dropdown THEN `PUT /api/projects/:slug/tasks/:taskId` SHALL be called with `{ assignedAgent: <newAgentId> }` and on success the badge SHALL update in place; on error a toast SHALL appear.
7. WHEN the operator presses Escape or clicks outside the reassign dropdown THEN it SHALL close without persisting any change.
8. WHEN `newAgent` is left blank during task creation (existing behavior) THEN the create flow SHALL remain unchanged and default to the requesting agent.

---

### Requirement 4: Markdown Component — Full Styled Rendering

**User Story:** As a dashboard operator reading task files, memory entries, and session messages, I want all markdown-bearing text surfaces to display rendered headings, code blocks with syntax highlighting, tables, and blockquotes, so that I can read formatted content without decoding markup.

#### Acceptance Criteria

1. WHEN `MarkdownComponent` receives a non-empty `source` input THEN it SHALL render the full GFM markdown body (already implemented with `marked` + `DOMPurify`) via `[innerHTML]` binding on a `div.markdown-body` host.
2. WHEN the rendered output contains a fenced code block THEN the block SHALL be wrapped in a styled `<pre><code>` with `bg-base-300`, monospace font, horizontal scrolling, and no overflow clipping.
3. WHEN the rendered output contains a `<table>` THEN the table SHALL be styled using DaisyUI table classes (`table table-sm`) applied via global styles scoped to `.markdown-body table`.
4. WHEN the rendered output contains `<h1>`–`<h4>` THEN headings SHALL be styled with appropriate size, weight, and bottom border matching the dashboard's base theme.
5. WHEN the rendered output contains a `<blockquote>` THEN it SHALL be styled with a left border accent and muted background using Tailwind utility classes via the global stylesheet.
6. WHEN `MarkdownComponent` receives an empty `source` or whitespace-only string THEN it SHALL display the existing italic "empty" fallback without crashing.
7. WHEN the `sessions.component.ts` tail renderer passes assistant message text to `<oc-md>` THEN the same styling rules SHALL apply as in all other usage sites — no bespoke session-specific markdown style.

**Implementation note:** The `MarkdownComponent` already imports `marked` and `DOMPurify` and performs correct parsing and sanitization. The primary deliverable for this requirement is the global CSS rules under `dashboard/src/styles.scss` (or equivalent global stylesheet) scoped to `.markdown-body` and integration of `<oc-md>` into the sessions chat renderer. No library replacements are required.

---

### Requirement 5: Backend — Missing REST Endpoints

**User Story:** As a developer building dashboard and agent features, I want complete CRUD REST endpoints for projects and tasks, so that UI components and agent tools have a consistent API surface.

#### Acceptance Criteria

1. WHEN `DELETE /api/projects/:slug` is called with a valid auth token THEN the daemon SHALL delete the project row and return `{ ok: true }` with HTTP 200; if the project does not exist it SHALL return 404.
2. WHEN `DELETE /api/projects/:slug` is called on a follower instance THEN the daemon SHALL return HTTP 409 `{ error: 'projects can only be deleted on the leader' }`.
3. WHEN `PUT /api/projects/:slug` is called with `{ name?, workspace?, defaultBranch? }` THEN the daemon SHALL update only the provided fields and return the updated `ProjectRow`; if the project does not exist it SHALL return 404.
4. WHEN `DELETE /api/projects/:slug/tasks/:taskId` is called THEN the daemon SHALL: cancel all `pending` dispatches for that task, delete the task row and its task files, and return `{ ok: true, cancelledDispatches: number }` with HTTP 200; if the task does not exist it SHALL return 404.
5. WHEN `DELETE /api/projects/:slug/tasks/:taskId` is called for a task in phase `IN_PROGRESS` THEN the daemon SHALL still proceed with deletion (after cancelling pending dispatches) and SHALL include `{ warning: 'task was IN_PROGRESS' }` in the response body.
6. WHEN `PUT /api/projects/:slug/tasks/:taskId` is called with `{ assignedAgent: string }` THEN the daemon SHALL update the `assigned_agent` column on the task row and return `{ ok: true, taskId, assignedAgent }`.
7. WHEN any new mutating endpoint is called without a valid auth token THEN it SHALL return HTTP 401, consistent with existing endpoints.
8. WHEN a `DELETE /api/projects/:slug` or `DELETE /api/projects/:slug/tasks/:taskId` succeeds THEN the daemon SHALL broadcast an SSE event (`project.deleted` or `task.deleted` respectively) on the Redis bus so followers and open browser tabs receive the update.

**Affected file:** `openclaw-control/daemon/src/api.ts`
**Affected DB layer files:** `daemon/src/db/projects.ts` (add `deleteProject`), `daemon/src/db/tasks.ts` (add `deleteTask`, `updateAssignedAgent`).

---

### Requirement 6: Frontend API Service — New Client Methods

**User Story:** As a frontend developer, I want `ApiService` to expose typed methods for every new backend endpoint, so that components do not write raw `HttpClient` calls inline.

#### Acceptance Criteria

1. WHEN `ApiService.createProject(body: { slug: string; name: string; workspace?: string })` is called THEN it SHALL POST to `/api/projects` and return `Observable<ProjectSummary>`.
2. WHEN `ApiService.deleteProject(slug: string)` is called THEN it SHALL DELETE `/api/projects/:slug` and return `Observable<{ ok: true }>`.
3. WHEN `ApiService.updateProject(slug: string, body: Partial<{ name: string; workspace: string; defaultBranch: string }>)` is called THEN it SHALL PUT `/api/projects/:slug` and return `Observable<ProjectRow>`.
4. WHEN `ApiService.deleteTask(slug: string, taskId: string)` is called THEN it SHALL DELETE `/api/projects/:slug/tasks/:taskId` and return `Observable<{ ok: true; cancelledDispatches: number }>`.
5. WHEN `ApiService.updateTask(slug: string, taskId: string, body: { assignedAgent?: string })` is called THEN it SHALL PUT `/api/projects/:slug/tasks/:taskId` and return `Observable<{ ok: true; taskId: string; assignedAgent: string }>`.
6. WHEN any of the above methods receives a non-2xx response THEN the Observable SHALL error with the parsed JSON error body, consistent with existing methods in `ApiService`.

**Affected file:** `openclaw-control/dashboard/src/app/services/api.service.ts`

---

### Requirement 7: Agent MCP Tools — Project and Task CRUD

**User Story:** As an agent operating via Discord or a dispatched task, I want `create_project`, `delete_project`, `delete_task`, and `update_task` tools available in my tool registry, so that I can manage projects and tasks programmatically without asking a human to use the dashboard.

#### Acceptance Criteria

1. WHEN `create_project` is called with `{ slug: string, name: string, workspace?: string }` THEN it SHALL POST to `POST /api/projects` and return a JSON string `{ ok: true, slug, name }`.
2. WHEN `delete_project` is called with `{ project: string }` THEN it SHALL call `DELETE /api/projects/:project` and return `{ ok: true, slug }`.
3. WHEN `delete_task` is called with `{ project: string, taskId: string }` THEN it SHALL call `DELETE /api/projects/:project/tasks/:taskId` and return `{ ok: true, taskId, cancelledDispatches }`.
4. WHEN `update_task` is called with `{ project: string, taskId: string, assignedAgent: string }` THEN it SHALL call `PUT /api/projects/:project/tasks/:taskId` with `{ assignedAgent }` and return `{ ok: true, taskId, assignedAgent }`.
5. WHEN any of the above tools is called and the daemon returns an error THEN the tool handler SHALL throw so the LLM receives the error as a tool failure, consistent with the error-handling pattern in `daemonTools.ts`.
6. WHEN `daemonTools.list()` is called THEN all four new tools SHALL be included in the returned array alongside the existing nine tools.
7. WHEN the daemon client (`daemon/src/daemonClient.ts` or equivalent) does not yet have `deleteProject`, `deleteTask`, or `updateTask` methods THEN those methods SHALL be added before the tool handlers call them.

**Affected file:** `openclaw-control/bot-bridge/src/tools/daemonTools.ts`
**Affected file (if applicable):** `openclaw-control/bot-bridge/src/daemonClient.ts`

---

## Non-Functional Requirements

### Performance Requirements

- **Session chat renderer**: rendering 100 events in the tail view SHALL complete within 50 ms of data arrival with `ChangeDetectionStrategy.OnPush` and signal-based updates.
- **Modal open latency**: Create Project and Delete confirmation modals SHALL open within one animation frame (< 16 ms) — no async data fetch required to open either modal.
- **API response times**: all new DELETE/PUT endpoints SHALL respond within 200 ms at the 95th percentile under normal load (single-writer SQLite, WAL mode).

### Security Requirements

- **Authentication**: all new daemon endpoints (`DELETE /api/projects/:slug`, `PUT /api/projects/:slug`, `DELETE /api/projects/:slug/tasks/:taskId`, `PUT /api/projects/:slug/tasks/:taskId`) SHALL be gated behind the existing `guard` preHandler (Discord OAuth JWT cookie or `OPENCLAW_INTERNAL_TOKEN` Bearer).
- **Leader-only enforcement**: project create and delete SHALL enforce `OPENCLAW_LEADER=1` at the route level, mirroring the existing `POST /api/projects` guard pattern.
- **Input sanitization**: slug fields accepted by new endpoints SHALL be validated against the existing slug-safety pattern (no `..`, `/`, `\`).
- **XSS**: all markdown rendered via `MarkdownComponent` continues to be sanitized by `DOMPurify` before `bypassSecurityTrustHtml`. No change to the sanitizer configuration is permitted by this task.

### Reliability Requirements

- **Dispatch cancellation atomicity**: `DELETE /api/projects/:slug/tasks/:taskId` SHALL cancel all pending dispatches and delete the task in a single SQLite transaction so a partial failure leaves neither orphaned dispatches nor a half-deleted task.
- **SSE broadcast on delete**: `project.deleted` and `task.deleted` broadcasts SHALL fire after the transaction commits, not inside it.
- **No modal state leak**: if a Create Project or Delete modal is dismissed via Escape or backdrop click, form state SHALL be reset so re-opening shows a blank form.

### Scalability Requirements

- No topology changes. All changes remain within the existing single-writer leader model.

---

## Stakeholder Analysis

### Primary Stakeholders

| Stakeholder | Impact | Involvement | Success Criteria |
|---|---|---|---|
| Dashboard operators (humans) | High | UAT validation | Create/delete project and task without touching the DB or Discord |
| Agents (chappie, anubis, etc.) | High | Tool consumers | `delete_project`, `delete_task`, `update_task`, `create_project` callable from Discord and dispatched tasks |
| Development team | Medium | Implementation | All five packages build cleanly; no regressions in existing API routes |

### Secondary Stakeholders

| Stakeholder | Impact | Involvement | Success Criteria |
|---|---|---|---|
| Operations | Low | Deploy validation | Zero-downtime deploy; no DB migration required for new routes |

---

## Risk Analysis

| Risk | Probability | Impact | Score | Mitigation |
|---|---|---|---|---|
| SQLite transaction scope for task delete is too narrow — dispatches are cancelled but task row delete fails | Low | High | 6 | Wrap both operations in a single `BEGIN IMMEDIATE … COMMIT` block in `TasksRepo.deleteTask`; add an integration test |
| DaisyUI `dialog` element requires `showModal()` which is incompatible with Angular's default zone-less change detection | Medium | Medium | 4 | Use a signal boolean + `@if` to toggle the modal's `open` attribute as a pure Angular pattern rather than imperative `showModal()` calls |
| `MarkdownComponent` global CSS scoped to `.markdown-body` bleeds into other components using that class name | Low | Low | 2 | Scope rules under the `oc-md` host selector or via Angular `::ng-deep` within the component's encapsulated styles |
| `daemonTools.ts` new tools call daemon endpoints that do not exist yet — ship order matters | High | High | 9 | Backend endpoints (Requirement 5) MUST be implemented and deployed before bot-bridge tool handlers (Requirement 7) |
| Follower instances do not proxy new DELETE/PUT routes to the leader | Medium | Medium | 4 | Audit `api.ts` follower-relay logic; add relay stubs matching the pattern used by task file PUT |

---

## Explicitly Out of Scope

- Auth changes, Discord OAuth configuration, or JWT secret rotation.
- Multi-machine/leader-follower sync architecture (the `gitSync.ts` flow, SSE stream on followers).
- The continuation loop (`daemon/src/continuation.ts`) and dispatch worker (`daemon/src/dispatch.ts`).
- `PUT /api/projects/:slug/tasks/:taskId` fields beyond `assignedAgent` (e.g. phase override, description edit).
- Syntax highlighting library integration (e.g. Prism, highlight.js) — styled code blocks with monospace font and background color are sufficient.
- Project rename (slug change) — only `name`, `workspace`, and `defaultBranch` are editable via `PUT /api/projects/:slug`.
- Bulk delete operations.
- `OPENCLAW_PROJECT_ROOTS`-based project discovery changes — the hint text removal in the empty state is the only change touching that feature.
