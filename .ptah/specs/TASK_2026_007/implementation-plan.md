# Implementation Plan — TASK_2026_007

Dashboard CRUD, Session Chat Renderer, Markdown Styles, and Agent MCP Tools

---

## Codebase Investigation Summary

### Verified Patterns

**Backend (daemon)**

- Route guard: `guard` preHandler at `daemon/src/api.ts:180` — every new mutating endpoint must include `{ preHandler: guard }`.
- Leader-only enforcement pattern: `if (!config.leader) return reply.code(409).send({ error: '...' })` — used at `api.ts:198` for `POST /api/projects`. All new mutating project/task endpoints must replicate this check.
- SSE broadcast pattern: `broadcast('event.name', payload)` called AFTER any transaction commits — verified at `api.ts:221`.
- Storage facade: all route handlers call `storage.*` (never repos directly) so leader/follower branching stays in one file — `daemon/src/storage.ts`.
- Follower relay: `leaderClient.rawRelay(method, path, body)` at `leaderClient.ts:341` provides a generic status-code-preserving relay for routes where status-code distinctions matter (claim, dispatch state). For simpler new endpoints it is the preferred relay mechanism from `storage.ts`.
- DB transaction pattern: `db.transaction(() => { ... })()` (better-sqlite3 synchronous transaction function) — used in `TasksRepo.writeFile` at `tasks.ts:421`, `TasksRepo.recordApproval` at `tasks.ts:377`, and `TasksRepo.deleteFile` at `tasks.ts:461`.
- Repo statements cache: lazy `let cached: Statements | null` pattern — used in every repo file; new statements added to `TasksRepo` and `ProjectsRepo` must follow this pattern.

**Frontend (dashboard)**

- Angular 18 standalone signals + OnPush: all components use `signal()`, `computed()`, `input()`, `ChangeDetectionStrategy.OnPush`. New code must follow this — `projects.component.ts:1`, `tasks.component.ts:1`, `sessions.component.ts:1`.
- DaisyUI modal pattern: use a `signal<boolean>` and `@if (showModal()) { <dialog open> }` block. Do NOT call `showModal()` imperatively. Verified requirement from task-description risk analysis.
- Toast pattern: `inject(ToastService)` then `this.toast.error(...)` / `this.toast.success(...)` — used in `tasks.component.ts:200`.
- API service pattern: `this.http.delete<T>(url, { withCredentials: true })` / `this.http.put<T>(url, body, { withCredentials: true })` — verified at `api.service.ts:97-113`.
- Model types: defined in `dashboard/src/app/models/index.ts`. `ProjectSummary` does not yet have a `name` field but `TaskSummary` covers everything needed for tasks.

**Bot-bridge**

- Tool definition shape: `{ name, description, parameters: JSONSchema, handler: async (args, ctx) => string }` — `ToolDef` type from `llm.js`, all existing tools in `daemonTools.ts` follow this.
- Error propagation: handlers `throw` on failure so the LLM sees it as a tool failure. `requireString` helper throws descriptively — `daemonTools.ts:80`.
- Daemon client: `daemon` singleton in `daemonClient.ts:231` with typed methods. New methods follow the `call<T>(method, path, body?)` generic helper at `daemonClient.ts:4`.

**CSS**

- `styles.css` already has comprehensive `.markdown-body` rules covering headings, code blocks, tables, blockquotes, and inline code. The global stylesheet uses Tailwind v4 `@import "tailwindcss"` plus DaisyUI plugin. No new library or component-level styles needed for the markdown requirement — only the existing global rules need minor additions (verified by reading all existing `.markdown-body` rules).

---

## Batch Structure

Changes are ordered so each batch is independently deliverable and the next batch's dependencies are always satisfied:

```
Batch 1 (DB layer)           — daemon/src/db/projects.ts, daemon/src/db/tasks.ts
Batch 2 (Storage facade)     — daemon/src/storage.ts
Batch 3 (API routes)         — daemon/src/api.ts
Batch 4 (Leader client)      — daemon/src/leaderClient.ts
Batch 5 (Frontend API)       — dashboard/src/app/services/api.service.ts
                               dashboard/src/app/models/index.ts
Batch 6 (Markdown CSS)       — dashboard/src/styles.css
Batch 7 (Frontend pages)     — sessions.component.ts, projects.component.ts, tasks.component.ts
Batch 8 (Bot-bridge)         — bot-bridge/src/daemonClient.ts, bot-bridge/src/tools/daemonTools.ts
```

Batches 1–4 are fully independent of batches 5–8. Batches 5–7 can begin once batch 4 is merged (API contract is defined). Batch 8 can begin once batch 3 is deployed (endpoints must exist before tool handlers call them).

---

## Batch 1 — DB Layer

### 1a. `daemon/src/db/projects.ts` — Add `deleteProject` and `updateProject`

**File**: `openclaw-control/daemon/src/db/projects.ts` (MODIFY)

**Changes**:

Add two new prepared statements to the `Statements` interface and the `stmts()` cache function:

```typescript
// Add to Statements interface:
delete: Statement<{ slug: string }>;
update: Statement<{
  slug: string;
  name: string | null;
  workspace: string | null;
  default_branch: string | null;
}>;
```

Add the prepared SQL in `stmts()`:

```typescript
delete: db.prepare(`DELETE FROM projects WHERE slug = @slug`),
update: db.prepare(`
  UPDATE projects SET
    name = COALESCE(@name, name),
    workspace = COALESCE(@workspace, workspace),
    default_branch = COALESCE(@default_branch, default_branch),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE slug = @slug
`),
```

Add two methods to the `ProjectsRepo` export:

```typescript
delete(slug: string): boolean {
  const result = stmts().delete.run({ slug });
  return result.changes > 0;
},

update(slug: string, fields: { name?: string; workspace?: string; defaultBranch?: string }): ProjectRow | null {
  stmts().update.run({
    slug,
    name: fields.name ?? null,
    workspace: fields.workspace ?? null,
    default_branch: fields.defaultBranch ?? null,
  });
  return ProjectsRepo.get(slug);
},
```

**Evidence for pattern**: `ProjectsRepo.upsert` at `projects.ts:91`, statement cache at `projects.ts:48-68`.

---

### 1b. `daemon/src/db/tasks.ts` — Add `deleteTask` and `updateAssignedAgent`

**File**: `openclaw-control/daemon/src/db/tasks.ts` (MODIFY)

**Changes**:

Add new prepared statements to the `Statements` interface:

```typescript
deleteTask: Statement<{ project_slug: string; id: string }>;
deleteTaskFiles: Statement<{ project_slug: string; task_id: string }>;
cancelPendingDispatches: Statement<{ project_slug: string; task_id: string }>;
countCancelledDispatches: Statement<{ project_slug: string; task_id: string }>;
updateAssignedAgent: Statement<{ project_slug: string; id: string; assigned_agent: string }>;
```

Add the prepared SQL in `stmts()`:

```typescript
deleteTask: db.prepare(`
  DELETE FROM tasks WHERE project_slug = @project_slug AND id = @id
`),
deleteTaskFiles: db.prepare(`
  DELETE FROM task_files WHERE project_slug = @project_slug AND task_id = @task_id
`),
cancelPendingDispatches: db.prepare(`
  UPDATE dispatches SET state = 'failed',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE project_slug = @project_slug AND task_id = @task_id
    AND state IN ('pending', 'taken')
`),
countCancelledDispatches: db.prepare(`
  SELECT COUNT(*) AS n FROM dispatches
  WHERE project_slug = @project_slug AND task_id = @task_id
    AND state = 'failed'
    AND completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 seconds')
`),
updateAssignedAgent: db.prepare(`
  UPDATE tasks SET assigned_agent = @assigned_agent,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE project_slug = @project_slug AND id = @id
`),
```

Add two methods to `TasksRepo`:

```typescript
/**
 * Atomic: cancel all pending/taken dispatches for the task, delete all task
 * files, then delete the task row — all in a single BEGIN IMMEDIATE transaction.
 * Returns null when the task doesn't exist. Returns { cancelledDispatches, wasInProgress }.
 */
deleteTask(
  projectSlug: string,
  taskId: string,
): { cancelledDispatches: number; wasInProgress: boolean } | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const task = TasksRepo.get(projectSlug, taskId);
    if (!task) return null;
    const wasInProgress = task.currentPhase === 'IN_PROGRESS' || task.checkpointPending;
    stmts().cancelPendingDispatches.run({
      project_slug: projectSlug,
      task_id: taskId,
    });
    const countRow = stmts().countCancelledDispatches.get({
      project_slug: projectSlug,
      task_id: taskId,
    }) as { n: number };
    const cancelledDispatches = countRow?.n ?? 0;
    stmts().deleteTaskFiles.run({ project_slug: projectSlug, task_id: taskId });
    stmts().deleteTask.run({ project_slug: projectSlug, id: taskId });
    return { cancelledDispatches, wasInProgress };
  });
  return tx();
},

updateAssignedAgent(
  projectSlug: string,
  taskId: string,
  assignedAgent: string,
): boolean {
  const result = stmts().updateAssignedAgent.run({
    project_slug: projectSlug,
    id: taskId,
    assigned_agent: assignedAgent,
  });
  return result.changes > 0;
},
```

**Transaction pattern evidence**: `TasksRepo.writeFile` at `tasks.ts:421`, `TasksRepo.deleteFile` at `tasks.ts:461`. The `BEGIN IMMEDIATE` transaction is implicit in better-sqlite3's `db.transaction()`.

**Note on dispatch cancellation**: The `cancelPendingDispatches` statement transitions dispatches from `pending`/`taken` to `failed` with `completed_at` set. The 5-second window count in `countCancelledDispatches` is a proxy for rows just cancelled by this transaction. An alternative is to count the `changes` from `cancelPendingDispatches.run()`, which better-sqlite3 returns via `Statement.run().changes`. Use `.changes` from the cancel run directly — it is more reliable than a time-window count.

**Revised approach for `deleteTask`**:

```typescript
const cancelResult = stmts().cancelPendingDispatches.run({
  project_slug: projectSlug,
  task_id: taskId,
});
const cancelledDispatches = cancelResult.changes;
```

This is the correct approach. Remove `countCancelledDispatches` statement and use `run().changes` instead.

**Also update `db/index.ts`**: Export the new return-type interfaces if any (none needed beyond what already exists; the method return types are inline).

---

## Batch 2 — Storage Facade

**File**: `openclaw-control/daemon/src/storage.ts` (MODIFY)

Add four new async functions matching the storage facade pattern (leader branch calls repo; follower branch calls leaderClient):

```typescript
export async function deleteProject(
  slug: string,
): Promise<{ ok: true } | null> {
  if (config.leader) {
    const deleted = ProjectsRepo.delete(slug);
    if (!deleted) return null;
    return { ok: true };
  }
  const r = await leaderClient.rawRelay('DELETE', `/api/projects/${encodeURIComponent(slug)}`);
  if (r.statusCode === 404) return null;
  if (r.statusCode >= 200 && r.statusCode < 300) return { ok: true };
  throw new Error(`deleteProject: unexpected leader status ${r.statusCode}`);
}

export async function updateProject(
  slug: string,
  fields: { name?: string; workspace?: string; defaultBranch?: string },
): Promise<ProjectRow | null> {
  if (config.leader) {
    return ProjectsRepo.update(slug, fields);
  }
  const r = await leaderClient.rawRelay('PUT', `/api/projects/${encodeURIComponent(slug)}`, fields);
  if (r.statusCode === 404) return null;
  if (r.statusCode >= 200 && r.statusCode < 300) return r.body as ProjectRow;
  throw new Error(`updateProject: unexpected leader status ${r.statusCode}`);
}

export async function deleteTask(
  slug: string,
  taskId: string,
): Promise<{ ok: true; cancelledDispatches: number; wasInProgress: boolean } | null> {
  if (config.leader) {
    const result = TasksRepo.deleteTask(slug, taskId);
    if (!result) return null;
    return { ok: true, ...result };
  }
  const r = await leaderClient.rawRelay(
    'DELETE',
    `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
  );
  if (r.statusCode === 404) return null;
  if (r.statusCode >= 200 && r.statusCode < 300) {
    return r.body as { ok: true; cancelledDispatches: number; wasInProgress: boolean };
  }
  throw new Error(`deleteTask: unexpected leader status ${r.statusCode}`);
}

export async function updateTaskAgent(
  slug: string,
  taskId: string,
  assignedAgent: string,
): Promise<{ ok: true; taskId: string; assignedAgent: string } | null> {
  if (config.leader) {
    const updated = TasksRepo.updateAssignedAgent(slug, taskId, assignedAgent);
    if (!updated) return null;
    return { ok: true, taskId, assignedAgent };
  }
  const r = await leaderClient.rawRelay(
    'PUT',
    `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
    { assignedAgent },
  );
  if (r.statusCode === 404) return null;
  if (r.statusCode >= 200 && r.statusCode < 300) {
    return r.body as { ok: true; taskId: string; assignedAgent: string };
  }
  throw new Error(`updateTaskAgent: unexpected leader status ${r.statusCode}`);
}
```

Add import for `ProjectRow` from `db/index.js` (it is already exported from `db/projects.ts` via `db/index.ts` — verify import already exists in storage.ts; if not, add it).

**Follower relay**: All four functions use `leaderClient.rawRelay` — the generic relay already handles Bearer auth, JSON serialization, and response parsing. No new methods needed in `leaderClient.ts` for these. The `rawRelay` function is verified at `leaderClient.ts:341`.

---

## Batch 3 — API Routes

**File**: `openclaw-control/daemon/src/api.ts` (MODIFY)

Add four new route handlers after the existing `POST /api/projects` handler (around line 223). Import additions at the top of the file: `storage.deleteProject`, `storage.updateProject`, `storage.deleteTask`, `storage.updateTaskAgent` are accessed via the already-imported `* as storage` import.

### Route: `DELETE /api/projects/:slug`

```typescript
app.delete<{ Params: { slug: string } }>(
  '/api/projects/:slug',
  { preHandler: guard },
  async (req, reply) => {
    if (!config.leader) {
      return reply.code(409).send({ error: 'projects can only be deleted on the leader' });
    }
    const { slug } = req.params;
    if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      return reply.code(400).send({ error: 'invalid slug' });
    }
    const result = await storage.deleteProject(slug);
    if (!result) return reply.code(404).send({ error: 'project not found' });
    broadcast('project.deleted', { slug });
    return { ok: true };
  },
);
```

### Route: `PUT /api/projects/:slug`

```typescript
app.put<{
  Params: { slug: string };
  Body: { name?: unknown; workspace?: unknown; defaultBranch?: unknown };
}>(
  '/api/projects/:slug',
  { preHandler: guard },
  async (req, reply) => {
    if (!config.leader) {
      return reply.code(409).send({ error: 'projects can only be updated on the leader' });
    }
    const { slug } = req.params;
    const body = req.body ?? {};
    const fields: { name?: string; workspace?: string; defaultBranch?: string } = {};
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      fields.name = body.name.trim();
    }
    if (typeof body.workspace === 'string') {
      fields.workspace = body.workspace.trim();
    }
    if (typeof body.defaultBranch === 'string') {
      fields.defaultBranch = body.defaultBranch.trim();
    }
    const updated = await storage.updateProject(slug, fields);
    if (!updated) return reply.code(404).send({ error: 'project not found' });
    return updated;
  },
);
```

### Route: `DELETE /api/projects/:slug/tasks/:taskId`

```typescript
app.delete<{ Params: { slug: string; taskId: string } }>(
  '/api/projects/:slug/tasks/:taskId',
  { preHandler: guard },
  async (req, reply) => {
    if (!config.leader) {
      return reply.code(409).send({ error: 'task mutations are only available on the leader' });
    }
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const result = await storage.deleteTask(req.params.slug, req.params.taskId);
    if (!result) return reply.code(404).send({ error: 'task not found' });
    broadcast('task.deleted', { slug: req.params.slug, taskId: req.params.taskId });
    const response: Record<string, unknown> = {
      ok: true,
      cancelledDispatches: result.cancelledDispatches,
    };
    if (result.wasInProgress) {
      response.warning = 'task was IN_PROGRESS';
    }
    return response;
  },
);
```

### Route: `PUT /api/projects/:slug/tasks/:taskId`

```typescript
app.put<{
  Params: { slug: string; taskId: string };
  Body: { assignedAgent?: unknown };
}>(
  '/api/projects/:slug/tasks/:taskId',
  { preHandler: guard },
  async (req, reply) => {
    if (!config.leader) {
      return reply.code(409).send({ error: 'task mutations are only available on the leader' });
    }
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const body = req.body ?? {};
    if (typeof body.assignedAgent !== 'string' || body.assignedAgent.trim().length === 0) {
      return reply.code(400).send({ error: 'assignedAgent (non-empty string) required' });
    }
    const assignedAgent = body.assignedAgent.trim();
    const result = await storage.updateTaskAgent(req.params.slug, req.params.taskId, assignedAgent);
    if (!result) return reply.code(404).send({ error: 'task not found' });
    return result;
  },
);
```

**SSE broadcast placement**: `broadcast(...)` calls are AFTER the storage mutation returns, never inside the transaction. This matches the existing pattern at `api.ts:221`.

**Auth**: All four routes carry `{ preHandler: guard }` — verified pattern from `api.ts:180-184`.

**Leader-only check**: `DELETE /api/projects/:slug` and `PUT /api/projects/:slug` enforce leader-only. `DELETE /api/projects/:slug/tasks/:taskId` and `PUT /api/projects/:slug/tasks/:taskId` also enforce leader-only per requirement 5.2 and security requirements.

---

## Batch 4 — Leader Client

**File**: `openclaw-control/daemon/src/leaderClient.ts` (no changes needed)

The `rawRelay` function at `leaderClient.ts:341` handles all four new endpoints generically. No new typed methods in `leaderClient.ts` are required. The storage facade's follower branches in Batch 2 use `rawRelay` directly.

This is consistent with the existing pattern: `rawRelay` is used for all dispatch state-transition relays (claim, done, log) where the follower needs to mirror the leader's status codes.

---

## Batch 5 — Frontend API Service and Models

### 5a. `dashboard/src/app/models/index.ts` (MODIFY)

Add `ProjectRow` interface to expose the richer project shape returned by `PUT /api/projects/:slug`:

```typescript
export interface ProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}
```

The existing `ProjectSummary` (used for list views) does not have `name` or `githubRepo`. Both are needed for the create-project form response and update response.

### 5b. `dashboard/src/app/services/api.service.ts` (MODIFY)

Add five typed methods. All follow the exact pattern of existing methods (verified at `api.service.ts:37-163`):

```typescript
import type { ..., ProjectRow } from '../models/index';

createProject(body: { slug: string; name: string; workspace?: string }): Observable<ProjectRow> {
  return this.http.post<ProjectRow>('/api/projects', body, { withCredentials: true });
}

deleteProject(slug: string): Observable<{ ok: true }> {
  return this.http.delete<{ ok: true }>(`/api/projects/${slug}`, { withCredentials: true });
}

updateProject(
  slug: string,
  body: Partial<{ name: string; workspace: string; defaultBranch: string }>,
): Observable<ProjectRow> {
  return this.http.put<ProjectRow>(`/api/projects/${slug}`, body, { withCredentials: true });
}

deleteTask(slug: string, taskId: string): Observable<{ ok: true; cancelledDispatches: number }> {
  return this.http.delete<{ ok: true; cancelledDispatches: number }>(
    `/api/projects/${slug}/tasks/${taskId}`,
    { withCredentials: true },
  );
}

updateTask(
  slug: string,
  taskId: string,
  body: { assignedAgent?: string },
): Observable<{ ok: true; taskId: string; assignedAgent: string }> {
  return this.http.put<{ ok: true; taskId: string; assignedAgent: string }>(
    `/api/projects/${slug}/tasks/${taskId}`,
    body,
    { withCredentials: true },
  );
}
```

Add `ProjectRow` to the re-export at the bottom of `api.service.ts`.

**Error handling**: No special handling needed — Angular's `HttpClient` surfaces non-2xx responses as Observable errors with the parsed JSON body, matching requirement 6.6 and consistent with all existing methods.

---

## Batch 6 — Markdown CSS

**File**: `openclaw-control/dashboard/src/styles.css` (MODIFY)

After reading the existing `styles.css`, the `.markdown-body` rules already cover:
- Headings h1-h6 with sizing, weight, border-bottom on h1/h2
- `pre` and `pre code` with `bg-base-300`, monospace, `overflow-x: auto`
- `table`, `th`, `td` with borders and `bg-base-300` header
- `blockquote` with `border-left: 3px solid var(--color-primary)` and muted background
- Inline `code` with `bg-base-300`

The existing CSS already satisfies requirements 4.2 through 4.5. No additions are needed to the markdown CSS rules. The file does not need changes for this requirement.

If the review reveals any gap (e.g. the task-description mentions DaisyUI `table table-sm` classes applied via global styles), add:

```css
.markdown-body table {
  /* existing rules already cover this; add DaisyUI table classes via attribute */
}
```

However, DaisyUI table classes are not compatible with the existing border-collapse approach. The current custom table rules in `styles.css` are sufficient and complete. No CSS changes required.

**Rationale**: The requirement's implementation note states "The primary deliverable for this requirement is the global CSS rules under `dashboard/src/styles.scss`". All necessary rules already exist at `styles.css:92-107`. The only new work for requirement 4 is integrating `<oc-md>` into the sessions chat renderer (covered in Batch 7).

---

## Batch 7 — Frontend Pages

### 7a. `dashboard/src/app/pages/sessions.component.ts` (MODIFY)

**Current state**: Renders session tail events as `<pre>{{ stringify(e) }}</pre>` raw JSON (lines 91-95). The live-feed section renders minimal preview text.

**Changes**:

1. Add `MarkdownComponent` to the `imports` array.
2. Add `DatePipe` to the `imports` array (or implement a standalone `RelativeTimePipe`).
3. Replace the tail events `@for` loop with a chat-style renderer.

**New tail events renderer** (replace lines 91-95):

```html
@for (e of t.events; track $index) {
  @let role = e.role ?? e.type ?? '';
  @if (role === 'user') {
    <div class="flex flex-col items-start gap-1">
      <div class="flex items-center gap-2">
        <span class="badge badge-ghost badge-sm">User</span>
        @if (e.timestamp) {
          <span class="text-xs text-base-content/40">{{ formatTs(e.timestamp) }}</span>
        }
      </div>
      <div class="bg-base-300 rounded p-2 text-sm max-w-[90%]">
        {{ e.content ?? e.text ?? '' }}
      </div>
    </div>
  } @else if (role === 'assistant') {
    <div class="flex flex-col items-end gap-1">
      <div class="flex items-center gap-2">
        @if (e.timestamp) {
          <span class="text-xs text-base-content/40">{{ formatTs(e.timestamp) }}</span>
        }
        <span class="badge badge-primary badge-sm">Assistant</span>
      </div>
      <div class="bg-primary/10 border border-primary/20 rounded p-2 max-w-[90%]">
        @if (e.content ?? e.text) {
          <oc-md [source]="e.content ?? e.text ?? ''" />
        }
      </div>
    </div>
  } @else if (role === 'tool' || e.type === 'tool_result') {
    <details class="text-xs">
      <summary class="cursor-pointer flex items-center gap-2 p-1 hover:bg-base-300 rounded select-none">
        <span class="badge badge-ghost badge-xs">Tool</span>
        <span class="font-mono text-base-content/70">{{ e.name ?? e.tool_use_id ?? 'tool_result' }}</span>
        @if (e.timestamp) {
          <span class="text-base-content/40 ml-auto">{{ formatTs(e.timestamp) }}</span>
        }
      </summary>
      <pre class="font-mono bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all">{{ stringify(e) }}</pre>
    </details>
  } @else {
    <details class="text-xs">
      <summary class="cursor-pointer text-base-content/50 select-none">unknown ({{ role || 'no role' }})</summary>
      <pre class="font-mono bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all">{{ stringify(e) }}</pre>
    </details>
  }
}
```

4. Add `formatTs(ts: string | number): string` method to the component class — use `DatePipe.transform` or a simple relative-time helper. DatePipe is the existing Angular solution; it does not produce "2 min ago" natively, so either use a custom pipe or format as local time. A simple relative formatter is acceptable:

```typescript
formatTs(ts: string | number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  return d.toLocaleTimeString();
}
```

5. Add `MarkdownComponent` import from `'../components/markdown.component'`.

**Live-feed section**: No change required — the existing live-feed renderer (lines 99-115) shows minimal preview text from SSE events and is not scoped by this requirement.

**OnPush compliance**: The tail `signal` is already a signal (`tail = signal<SessionTail | null>(null)`). The new template reads `t.events` from `tail()` inside `@if (tail(); as t)`, which is signal-tracked. No additional computed signals are required.

---

### 7b. `dashboard/src/app/pages/projects.component.ts` (MODIFY)

**Current state**: No create button, no delete button, empty-state references `OPENCLAW_PROJECT_ROOTS`.

**Changes**:

1. Add `FormsModule` to `imports` array.
2. Add `ToastService` inject.
3. Add `ApiService` already injected — add `createProject` and `deleteProject` calls.

**New signals**:

```typescript
showCreateModal = signal(false);
showDeleteModal = signal(false);
deleteTarget = signal<ProjectSummary | null>(null);
creating = signal(false);
deleting = signal(false);

// Form fields — plain properties (not signals) since FormsModule ngModel binds to them
newSlug = '';
newName = '';
newWorkspace = '';
createError = signal('');
```

**Template changes**:

- Add "New Project" button to the header row next to the search input.
- Wrap each project card `<a>` in a `<div class="relative group">` and add an absolutely-positioned delete icon button that appears on hover.
- Replace the empty-state hint text from `Set OPENCLAW_PROJECT_ROOTS...` to `No projects found. Create one with the New Project button above.`

**Create modal** (append after the grid, inside the component template):

```html
@if (showCreateModal()) {
  <dialog open class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg">New Project</h3>
      <div class="form-control mt-4">
        <label class="label"><span class="label-text">Slug <span class="text-error">*</span></span></label>
        <input [(ngModel)]="newSlug" type="text" placeholder="my-project"
          class="input input-bordered input-sm" />
        <label class="label"><span class="label-text-alt text-base-content/50">kebab-case, a-z0-9, max 64 chars</span></label>
      </div>
      <div class="form-control mt-2">
        <label class="label"><span class="label-text">Name <span class="text-error">*</span></span></label>
        <input [(ngModel)]="newName" type="text" placeholder="My Project"
          class="input input-bordered input-sm" />
      </div>
      <div class="form-control mt-2">
        <label class="label"><span class="label-text">Workspace path</span></label>
        <input [(ngModel)]="newWorkspace" type="text" placeholder="/home/user/my-project"
          class="input input-bordered input-sm" />
      </div>
      @if (createError()) {
        <div class="alert alert-error alert-sm mt-3 text-sm">{{ createError() }}</div>
      }
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" (click)="closeCreateModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" [disabled]="creating()" (click)="submitCreate()">
          @if (creating()) { <span class="loading loading-spinner loading-xs"></span> }
          Create
        </button>
      </div>
    </div>
    <div class="modal-backdrop" (click)="closeCreateModal()"></div>
  </dialog>
}
```

**Delete confirmation modal**:

```html
@if (showDeleteModal()) {
  <dialog open class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg text-error">Delete project?</h3>
      <p class="mt-2">Are you sure you want to delete <span class="font-mono font-bold">{{ deleteTarget()?.slug }}</span>?</p>
      <p class="text-sm text-base-content/60 mt-1">This action cannot be undone.</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" (click)="closeDeleteModal()">Cancel</button>
        <button class="btn btn-error btn-sm" [disabled]="deleting()" (click)="confirmDelete()">
          @if (deleting()) { <span class="loading loading-spinner loading-xs"></span> }
          Delete
        </button>
      </div>
    </div>
    <div class="modal-backdrop" (click)="closeDeleteModal()"></div>
  </dialog>
}
```

**New methods**:

```typescript
openCreateModal() {
  this.newSlug = ''; this.newName = ''; this.newWorkspace = '';
  this.createError.set('');
  this.showCreateModal.set(true);
}

closeCreateModal() {
  this.showCreateModal.set(false);
  this.newSlug = ''; this.newName = ''; this.newWorkspace = '';
  this.createError.set('');
}

submitCreate() {
  const slug = this.newSlug.trim();
  const name = this.newName.trim();
  if (!slug) { this.createError.set('Slug is required'); return; }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    this.createError.set('Slug must be lowercase letters, numbers, and hyphens (max 64 chars)');
    return;
  }
  if (!name) { this.createError.set('Name is required'); return; }
  this.creating.set(true);
  this.createError.set('');
  this.api.createProject({ slug, name, workspace: this.newWorkspace.trim() || undefined }).subscribe({
    next: () => {
      this.creating.set(false);
      this.closeCreateModal();
      this.reload();
    },
    error: (err) => {
      this.creating.set(false);
      const msg = err?.error?.error ?? 'Create failed';
      if (err?.status === 409) {
        this.createError.set('A project with that slug already exists');
      } else {
        this.createError.set(msg);
      }
    },
  });
}

openDeleteModal(p: ProjectSummary, event: Event) {
  event.preventDefault();
  event.stopPropagation();
  this.deleteTarget.set(p);
  this.showDeleteModal.set(true);
}

closeDeleteModal() {
  this.showDeleteModal.set(false);
  this.deleteTarget.set(null);
}

confirmDelete() {
  const target = this.deleteTarget();
  if (!target) return;
  this.deleting.set(true);
  this.api.deleteProject(target.slug).subscribe({
    next: () => {
      this.deleting.set(false);
      this.closeDeleteModal();
      this.projects.update((list) => list.filter((p) => p.slug !== target.slug));
    },
    error: (err) => {
      this.deleting.set(false);
      this.toast.error(err?.error?.error ?? 'Delete failed');
      this.closeDeleteModal();
    },
  });
}

reload() {
  this.api.projects().subscribe({
    next: (p) => this.projects.set(p),
    error: () => this.toast.error('Failed to reload projects'),
  });
}
```

**Modal reset on dismiss**: Both `closeCreateModal` and `closeDeleteModal` reset form state, satisfying the "no modal state leak" reliability requirement.

---

### 7c. `dashboard/src/app/pages/tasks.component.ts` (MODIFY)

**Current state**: Has row action column with "Open →" link only.

**Changes**:

1. Import `MarkdownComponent` is not needed here (no markdown rendering in tasks table).
2. Add new signals:

```typescript
showDeleteModal = signal(false);
deleteTarget = signal<TaskSummary | null>(null);
deleting = signal(false);
reassigningTaskId = signal<string | null>(null);
agents = signal<Agent[]>([]);
```

3. Add `Agent` import from `api.service.ts`.
4. Load agents on `ngOnInit`:

```typescript
ngOnInit() {
  this.refresh();
  this.api.agents().subscribe({
    next: (a) => this.agents.set(a),
    error: () => { /* non-fatal — reassign dropdown degrades to empty */ },
  });
}
```

5. In the task row actions column, add the Delete button and make the agent badge clickable:

**Agent badge column** (replace the existing `<td>` for agent at line 165):

```html
<td>
  @if (reassigningTaskId() === t.id) {
    <select class="select select-xs select-bordered"
      (change)="reassignAgent(t, $any($event.target).value)"
      (blur)="reassigningTaskId.set(null)"
      (keydown.escape)="reassigningTaskId.set(null)">
      @for (a of agents(); track a.id) {
        <option [value]="a.id" [selected]="a.id === t.assignedAgent">{{ a.id }}</option>
      }
    </select>
  } @else {
    @if (t.assignedAgent) {
      <span class="badge badge-outline badge-sm cursor-pointer"
        (click)="startReassign(t, $event)">{{ t.assignedAgent }}</span>
    } @else {
      <span class="text-base-content/40 cursor-pointer text-sm"
        (click)="startReassign(t, $event)">—</span>
    }
  }
</td>
```

**Actions column** (replace the last `<td>` at line 178):

```html
<td class="text-right">
  <div class="flex items-center gap-1 justify-end">
    <a [routerLink]="['/projects', slug(), 'tasks', t.id]"
      class="btn btn-xs btn-ghost"
      (click)="$event.stopPropagation()">Open →</a>
    <button class="btn btn-xs btn-error btn-outline"
      (click)="openDeleteModal(t, $event)">Delete</button>
  </div>
</td>
```

**Delete modal** (append after the task table card):

```html
@if (showDeleteModal()) {
  <dialog open class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg text-error">Delete task?</h3>
      <p class="mt-2">Task <span class="font-mono font-bold">{{ deleteTarget()?.id }}</span>
        (phase: <span class="font-mono">{{ deleteTarget()?.phase }}</span>) will be permanently deleted.</p>
      @if (deleteTarget()?.phase === 'IN_PROGRESS' || deleteTarget()?.checkpointPending) {
        <div class="alert alert-warning mt-3 text-sm">
          This task is actively running. Deleting it will cancel all pending dispatches.
        </div>
      } @else {
        <p class="text-sm text-base-content/60 mt-1">Pending dispatches for this task will be cancelled.</p>
      }
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" (click)="closeDeleteModal()">Cancel</button>
        <button class="btn btn-error btn-sm" [disabled]="deleting()" (click)="confirmDeleteTask()">
          @if (deleting()) { <span class="loading loading-spinner loading-xs"></span> }
          Delete
        </button>
      </div>
    </div>
    <div class="modal-backdrop" (click)="closeDeleteModal()"></div>
  </dialog>
}
```

**New methods**:

```typescript
openDeleteModal(t: TaskSummary, event: Event) {
  event.stopPropagation();
  this.deleteTarget.set(t);
  this.showDeleteModal.set(true);
}

closeDeleteModal() {
  this.showDeleteModal.set(false);
  this.deleteTarget.set(null);
}

confirmDeleteTask() {
  const target = this.deleteTarget();
  if (!target) return;
  this.deleting.set(true);
  this.api.deleteTask(this.slug(), target.id).subscribe({
    next: () => {
      this.deleting.set(false);
      this.closeDeleteModal();
      this.tasks.update((list) => list.filter((t) => t.id !== target.id));
      this.toast.success(`Task ${target.id} deleted`);
    },
    error: (err) => {
      this.deleting.set(false);
      this.toast.error(err?.error?.error ?? 'Delete failed');
      this.closeDeleteModal();
    },
  });
}

startReassign(t: TaskSummary, event: Event) {
  event.stopPropagation();
  this.reassigningTaskId.set(t.id);
}

reassignAgent(t: TaskSummary, newAgentId: string) {
  if (newAgentId === t.assignedAgent) {
    this.reassigningTaskId.set(null);
    return;
  }
  this.api.updateTask(this.slug(), t.id, { assignedAgent: newAgentId }).subscribe({
    next: (result) => {
      this.reassigningTaskId.set(null);
      this.tasks.update((list) =>
        list.map((task) =>
          task.id === t.id ? { ...task, assignedAgent: result.assignedAgent } : task,
        ),
      );
    },
    error: (err) => {
      this.reassigningTaskId.set(null);
      this.toast.error(err?.error?.error ?? 'Reassign failed');
    },
  });
}
```

**Escape/blur handling**: The `<select>` has `(keydown.escape)` and `(blur)` bindings that call `reassigningTaskId.set(null)` without persisting changes, satisfying requirement 3.7.

**OnPush note**: `reassigningTaskId` is a signal so template re-renders happen automatically within Angular's signal graph. No `markForCheck()` calls needed.

---

## Batch 8 — Bot-bridge

### 8a. `openclaw-control/bot-bridge/src/daemonClient.ts` (MODIFY)

Add four new methods to the `daemon` export object:

```typescript
// Add to daemon export object:
createProject: (body: { slug: string; name: string; workspace?: string }) =>
  call<{ slug: string; name: string }>('POST', '/api/projects', body),
deleteProject: (slug: string) =>
  call<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(slug)}`),
deleteTask: (slug: string, taskId: string) =>
  call<{ ok: true; cancelledDispatches: number; warning?: string }>(
    'DELETE',
    `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
  ),
updateTask: (slug: string, taskId: string, body: { assignedAgent: string }) =>
  call<{ ok: true; taskId: string; assignedAgent: string }>(
    'PUT',
    `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
    body,
  ),
```

The `call<T>` helper at `daemonClient.ts:4` already throws on 4xx/5xx, so errors propagate to the tool handler which can re-throw — satisfying requirement 7.5.

---

### 8b. `openclaw-control/bot-bridge/src/tools/daemonTools.ts` (MODIFY)

Add four tool definitions to the `list()` return array. Insert them after the existing `dispatch_orchestration_task` tool:

```typescript
{
  name: 'create_project',
  description: 'Create a new project in the daemon. Returns { ok: true, slug, name } on success.',
  parameters: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Project slug (kebab-case, a-z0-9, max 64 chars).' },
      name: { type: 'string', description: 'Human-readable project name.' },
      workspace: { type: 'string', description: 'Optional absolute path to the project workspace.' },
    },
    required: ['slug', 'name'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const slug = requireString(args, 'slug', 'create_project');
    const name = requireString(args, 'name', 'create_project');
    const workspace = optionalString(args, 'workspace');
    const result = await daemon.createProject({ slug, name, workspace });
    return JSON.stringify({ ok: true, slug: result.slug ?? slug, name: result.name ?? name });
  },
},
{
  name: 'delete_project',
  description: 'Delete a project by slug. This is irreversible. Returns { ok: true, slug }.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug to delete.' },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const slug = requireString(args, 'project', 'delete_project');
    await daemon.deleteProject(slug);
    return JSON.stringify({ ok: true, slug });
  },
},
{
  name: 'delete_task',
  description: 'Delete a task and cancel all its pending dispatches. Returns { ok: true, taskId, cancelledDispatches }.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug.' },
      taskId: { type: 'string', description: 'Task id (e.g. TASK_2026_001).' },
    },
    required: ['project', 'taskId'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const slug = requireString(args, 'project', 'delete_task');
    const taskId = requireString(args, 'taskId', 'delete_task');
    const result = await daemon.deleteTask(slug, taskId);
    return JSON.stringify({ ok: true, taskId, cancelledDispatches: result.cancelledDispatches });
  },
},
{
  name: 'update_task',
  description: 'Update a task\'s assigned agent. Returns { ok: true, taskId, assignedAgent }.',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug.' },
      taskId: { type: 'string', description: 'Task id.' },
      assignedAgent: { type: 'string', description: 'Agent id to assign the task to.' },
    },
    required: ['project', 'taskId', 'assignedAgent'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const slug = requireString(args, 'project', 'update_task');
    const taskId = requireString(args, 'taskId', 'update_task');
    const assignedAgent = requireString(args, 'assignedAgent', 'update_task');
    const result = await daemon.updateTask(slug, taskId, { assignedAgent });
    return JSON.stringify({ ok: true, taskId: result.taskId, assignedAgent: result.assignedAgent });
  },
},
```

**Error propagation**: All handlers let errors from `daemon.*` propagate naturally (no try/catch). The `call<T>` helper throws on non-2xx, so the LLM sees a tool failure — satisfying requirement 7.5.

**Tool count**: After addition, `list()` returns 13 tools (9 original + 4 new), satisfying requirement 7.6.

---

## Files Affected Summary

**CREATE**: None

**MODIFY**:
- `openclaw-control/daemon/src/db/projects.ts` — add `delete`, `update` statements and methods
- `openclaw-control/daemon/src/db/tasks.ts` — add `deleteTask`, `updateAssignedAgent` statements and methods
- `openclaw-control/daemon/src/storage.ts` — add `deleteProject`, `updateProject`, `deleteTask`, `updateTaskAgent` functions
- `openclaw-control/daemon/src/api.ts` — add 4 new route handlers
- `openclaw-control/daemon/src/leaderClient.ts` — no changes (rawRelay covers all relay needs)
- `openclaw-control/dashboard/src/app/models/index.ts` — add `ProjectRow` interface
- `openclaw-control/dashboard/src/app/services/api.service.ts` — add 5 typed methods
- `openclaw-control/dashboard/src/styles.css` — no changes needed (rules already complete)
- `openclaw-control/dashboard/src/app/pages/sessions.component.ts` — chat-style tail renderer
- `openclaw-control/dashboard/src/app/pages/projects.component.ts` — create/delete modals, empty state fix
- `openclaw-control/dashboard/src/app/pages/tasks.component.ts` — delete modal, inline reassign
- `openclaw-control/bot-bridge/src/daemonClient.ts` — add 4 daemon client methods
- `openclaw-control/bot-bridge/src/tools/daemonTools.ts` — add 4 tool definitions

---

## Critical Architecture Notes

### Transaction Atomicity (Requirement 5.4 / Risk 1)

`TasksRepo.deleteTask` wraps three operations in a single `db.transaction()`:
1. Cancel pending/taken dispatches (UPDATE dispatches SET state = 'failed')
2. Delete all task_files rows
3. Delete the task row

The `changes` property from the cancel UPDATE gives the count of cancelled dispatches without a separate query. This ensures partial failure is impossible — better-sqlite3 transactions roll back automatically on throw.

### SSE Broadcast After Commit (Requirement 5.8 / Reliability)

Both `broadcast('project.deleted', ...)` and `broadcast('task.deleted', ...)` are called in the route handler AFTER `await storage.deleteProject()` / `await storage.deleteTask()` returns — which itself returns AFTER the synchronous SQLite transaction commits. The broadcast is never inside the transaction.

### Follower Relay Strategy (Requirement 5.2 / Risk 5)

All four new mutating endpoints (DELETE /api/projects/:slug, PUT /api/projects/:slug, DELETE /api/projects/:slug/tasks/:taskId, PUT /api/projects/:slug/tasks/:taskId) enforce leader-only at the route level with a 409 response. Followers do NOT need to proxy these via leaderClient because:

1. The dashboard is always served from the local daemon — operators on a follower machine will receive a 409 and see the "Project mutations are only available on the leader instance" message.
2. The bot-bridge calls the daemon directly (via `config.daemonUrl`) — agent tools on a follower will also receive the 409 and throw it as a tool error.

This is the correct design. The follower relay is used only in `storage.ts` for the leader to call its own DB, not to proxy dashboard mutations across machines.

### DaisyUI Modal Pattern (Risk 2)

Both modals in projects and tasks components use the signal + `@if` + `open` attribute pattern:

```html
@if (showModal()) {
  <dialog open class="modal modal-open">
```

This avoids imperative `showModal()` calls incompatible with Angular's zone-less change detection. When `showModal` signal is set to false, Angular removes the entire `<dialog>` from the DOM, automatically resetting all form state within it.

### Markdown CSS Scope (Risk 3)

The `.markdown-body` CSS rules live in the global `styles.css`. The `MarkdownComponent` renders a `<div class="markdown-body" [innerHTML]="...">` inside its template. Angular's ViewEncapsulation does not apply to `[innerHTML]`-rendered content, so global styles are the only option that works. The existing approach is correct and complete — no `::ng-deep` needed.

### Bot-bridge Deployment Order (Risk 4)

Backend (Batches 1–4) MUST be deployed before bot-bridge (Batch 8). The four new daemon endpoints must exist before the tool handlers attempt to call them. Within a single deployment the daemon starts before the bot-bridge (they are the same container, with the daemon as the parent process), so deployment order is automatically satisfied.

---

## Complexity Assessment

**Complexity**: MEDIUM-HIGH

**Estimated effort**: 6–10 hours total

| Batch | Effort | Parallelizable with |
|---|---|---|
| 1 (DB layer) | 1h | Independent |
| 2 (Storage facade) | 0.5h | Depends on Batch 1 |
| 3 (API routes) | 1h | Depends on Batch 2 |
| 4 (Leader client) | 0h | No changes |
| 5 (Frontend API) | 0.5h | Independent of 1–4 |
| 6 (Markdown CSS) | 0h | No changes |
| 7a (Sessions) | 1h | Depends on Batch 5 |
| 7b (Projects) | 2h | Depends on Batch 5 |
| 7c (Tasks) | 2h | Depends on Batch 5 |
| 8 (Bot-bridge) | 1h | Depends on Batch 3 |

Batches 1–3 and Batches 5–7 can proceed in parallel. Batch 8 waits on Batch 3 being deployed.

---

## Developer Type Recommendation

**Frontend**: Angular developer handles Batches 5, 6, 7a, 7b, 7c.

**Backend**: TypeScript/Node.js developer handles Batches 1, 2, 3, 4, 8.

Both can work simultaneously after batch assignment.
