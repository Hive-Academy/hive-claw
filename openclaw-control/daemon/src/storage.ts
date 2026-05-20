/**
 * Storage facade — read/write entry points used by the HTTP route layer.
 *
 * On the leader, every method calls the local repos (ProjectsRepo /
 * TasksRepo / DispatchRepo / MemoryRepo) directly. On a follower, every
 * method routes through `leaderClient` over HTTP. The route handlers stay
 * the same on both modes; the branch happens here.
 *
 * Why a facade rather than per-route `if (config.leader)` ladders:
 *   1. The dispatch worker already has the same shape (localQueueAdapter
 *      vs remoteQueueAdapter in dispatch.ts) — repeating the pattern keeps
 *      one mental model.
 *   2. Routes stay declarative. Adding a new endpoint touches the facade
 *      once and the route once.
 *   3. The follower cannot call `getDb()` (it has no DB open), so any new
 *      route that forgets to go through the facade fails fast at boot,
 *      not later in production.
 *
 * Persona-privacy invariants are still enforced at the HTTP layer in
 * api.ts (PRIVATE_AGENT_FILES → 404 GET / 403 PUT). The facade's memory
 * methods do not re-enforce them; they're called only after the gate.
 */

import { config } from './config.js';
import {
  DispatchRepo,
  ProjectsRepo,
  TasksRepo,
  getReadOnlyDb,
  isTerminalState,
  UnknownDispatchError,
  DispatchStateError,
  type Dispatch,
  type DispatchState,
  type MemoryScope,
  type ProjectRow,
} from './db/index.js';
import { discoverProjects, getProject, type Project } from './projects.js';
import { listTasks, readTask, readTaskArtifacts, type TaskSummary } from './phase.js';
import { listAgents, type Agent } from './agents.js';
import {
  listScope,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  type MemoryEntry,
} from './memory.js';
import { createTask as continuationCreateTask, recordApproval as continuationRecordApproval, tickOnce } from './continuation.js';
import * as leaderClient from './leaderClient.js';

/* -------------------------------------------------------------------------- */
/* Types — shared between leader and follower paths                            */
/* -------------------------------------------------------------------------- */

export interface ProjectListItem {
  slug: string;
  path: string;
  taskCount: number;
  openTaskCount: number;
  checkpointCount: number;
}

export interface TaskFileMeta {
  filename: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface TaskFileBody {
  content: string;
  contentType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface MemoryReadBody {
  content: string;
  private: boolean;
}

export interface DispatchListFilters {
  state?: DispatchState;
  projectSlug?: string;
  taskId?: string;
  limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Project / task reads                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Aggregate project list with task counts. On the leader this is a local
 * walk over discoverProjects + listTasks. On a follower this is one HTTP
 * GET to the leader's `/api/projects` (which already returns aggregated
 * shape — we relay verbatim).
 */
export async function listProjects(): Promise<ProjectListItem[]> {
  if (config.leader) {
    const projects = await discoverProjects();
    return Promise.all(
      projects.map(async (p) => {
        const tasks = await listTasks(p);
        return {
          slug: p.slug,
          path: p.path,
          taskCount: tasks.length,
          openTaskCount: tasks.filter((t) => t.phase !== 'DONE').length,
          checkpointCount: tasks.filter((t) => t.checkpointPending).length,
        };
      }),
    );
  }
  return leaderClient.listProjects();
}

/**
 * Resolve a project by slug. Returns null when missing. Followers query
 * the leader; leader resolves locally.
 */
export async function readProject(slug: string): Promise<Project | null> {
  if (config.leader) {
    return getProject(slug);
  }
  return leaderClient.readProject(slug);
}

export async function listTasksForProject(slug: string): Promise<TaskSummary[]> {
  if (config.leader) {
    const project = await getProject(slug);
    if (!project) return [];
    return listTasks(project);
  }
  return leaderClient.listTasksForProject(slug);
}

/**
 * Read a single task summary. Returns null when missing.
 */
export async function readTaskSummary(
  slug: string,
  taskId: string,
): Promise<TaskSummary | null> {
  if (config.leader) {
    const project = await getProject(slug);
    if (!project) return null;
    return readTask(project, taskId);
  }
  return leaderClient.readTaskSummary(slug, taskId);
}

export async function readTaskArtifactsBy(
  slug: string,
  taskId: string,
): Promise<Record<string, string>> {
  if (config.leader) {
    const project = await getProject(slug);
    if (!project) return {};
    return readTaskArtifacts(project, taskId);
  }
  return leaderClient.readTaskArtifacts(slug, taskId);
}

/* -------------------------------------------------------------------------- */
/* Project / task writes                                                       */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Task files                                                                  */
/* -------------------------------------------------------------------------- */

/** Returns null when the task itself does not exist. */
export async function listTaskFiles(
  slug: string,
  taskId: string,
): Promise<TaskFileMeta[] | null> {
  if (config.leader) {
    const task = TasksRepo.get(slug, taskId);
    if (!task) return null;
    return TasksRepo.listFiles(slug, taskId).map((f) => ({
      filename: f.filename,
      sizeBytes: f.sizeBytes,
      updatedAt: f.updatedAt,
    }));
  }
  // Followers: relay. The leader's route returns 404 when missing — the
  // client's listTaskFiles surfaces that as a thrown LeaderError (404),
  // which we translate to null here.
  try {
    return await leaderClient.listTaskFiles(slug, taskId);
  } catch (err) {
    if (isLeader404(err)) return null;
    throw err;
  }
}

/** Returns null when the file row is absent. */
export async function readTaskFile(
  slug: string,
  taskId: string,
  filename: string,
): Promise<TaskFileBody | null> {
  if (config.leader) {
    const file = TasksRepo.readFile(slug, taskId, filename);
    if (!file) return null;
    return {
      content: file.content,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
    };
  }
  return leaderClient.readTaskFile(slug, taskId, filename);
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

export async function listMemoryScope(scope: MemoryScope): Promise<MemoryEntry[]> {
  if (config.leader) {
    return listScope(scope);
  }
  // Follower: trust the leader's filtered list. The shape is the same —
  // private agent files are routed through local FS on the OWNER machine,
  // so the leader's listScope already includes the owner's local entries
  // when the leader IS the owner. Followers see the leader's view.
  return leaderClient.listMemoryScope(scope);
}

export async function readMemory(
  scope: MemoryScope,
  id: string,
  filename: string,
): Promise<MemoryReadBody | null> {
  if (config.leader) {
    return readMemoryFile(scope, id, filename);
  }
  return leaderClient.readMemory(scope, id, filename);
}

export async function writeMemory(
  scope: MemoryScope,
  id: string,
  filename: string,
  content: string,
  updatedBy: string | null,
  opts?: { skipOwnership?: boolean },
): Promise<{ private: boolean }> {
  if (config.leader) {
    return writeMemoryFile(scope, id, filename, content, updatedBy, opts);
  }
  const r = await leaderClient.writeMemory(scope, id, filename, content);
  return { private: r.private };
}

export async function deleteMemory(
  scope: MemoryScope,
  id: string,
  filename: string,
  opts?: { skipOwnership?: boolean },
): Promise<void> {
  if (config.leader) {
    await deleteMemoryFile(scope, id, filename, opts);
    return;
  }
  await leaderClient.deleteMemory(scope, id, filename);
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                      */
/* -------------------------------------------------------------------------- */

export async function listAgentsList(): Promise<Agent[]> {
  if (config.leader) {
    return listAgents();
  }
  return leaderClient.listAgents();
}

/* -------------------------------------------------------------------------- */
/* Dispatches                                                                  */
/* -------------------------------------------------------------------------- */

export async function listDispatches(filters: DispatchListFilters): Promise<Dispatch[]> {
  if (config.leader) {
    // Build the dynamic SQL locally — the leader has the read-only DB
    // handle. Followers never reach this branch (early return below).
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.state) {
      where.push('state = ?');
      params.push(filters.state);
    }
    if (filters.projectSlug) {
      where.push('project_slug = ?');
      params.push(filters.projectSlug);
    }
    if (filters.taskId) {
      where.push('task_id = ?');
      params.push(filters.taskId);
    }
    let limit = filters.limit ?? 50;
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 500) limit = 500;
    const sql = `
      SELECT * FROM dispatches
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = getReadOnlyDb()
      .prepare(sql)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rawRowToDispatch);
  }
  return leaderClient.listDispatches(filters);
}

export async function listPendingDispatches(agentIds: readonly string[]): Promise<
  Array<Pick<Dispatch, 'id' | 'projectSlug' | 'taskId' | 'phase' | 'agentId' | 'createdAt'>>
> {
  if (config.leader) {
    const rows = DispatchRepo.listPendingForAgents(agentIds);
    return rows.map((d) => ({
      id: d.id,
      projectSlug: d.projectSlug,
      taskId: d.taskId,
      phase: d.phase,
      agentId: d.agentId,
      createdAt: d.createdAt,
    }));
  }
  // leaderClient.listPendingForAgents already returns the slim shape.
  return leaderClient.listPendingForAgents(agentIds);
}

export async function readDispatchById(id: string): Promise<Dispatch | null> {
  if (config.leader) {
    return DispatchRepo.getById(id);
  }
  return leaderClient.getById(id);
}

/* -------------------------------------------------------------------------- */
/* Task / approval / continuation writes                                       */
/* -------------------------------------------------------------------------- */

export interface CreateTaskInput {
  projectSlug: string;
  description: string;
  taskType?: string;
  agentId?: string;
  discordUserId?: string;
  channelId?: string;
}

export async function createTask(input: CreateTaskInput): Promise<{ taskId: string; folder: string }> {
  if (config.leader) {
    return continuationCreateTask(input);
  }
  return leaderClient.createTask({
    project: input.projectSlug,
    description: input.description,
    taskType: input.taskType,
    agentId: input.agentId,
    discordUserId: input.discordUserId,
    channelId: input.channelId,
  });
}

/**
 * Returns true on success, false when the task is unknown.
 */
export async function recordApproval(
  slug: string,
  taskId: string,
  phase: string,
  by: string,
  feedback: string | undefined,
  decision: 'APPROVED' | 'REJECTED' = 'APPROVED',
): Promise<boolean> {
  if (config.leader) {
    const project = await getProject(slug);
    if (!project) return false;
    // The continuation helper takes a Phase string; the API layer already
    // typed-narrowed it for us.
    return continuationRecordApproval(project, taskId, phase as Parameters<typeof continuationRecordApproval>[2], by, feedback);
  }
  const r = await leaderClient.recordApproval(slug, taskId, { phase, decision, feedback });
  return r !== null;
}

export async function continuationTickThroughFacade(): Promise<{
  dispatched: number;
  pending: number;
  checkpoints: number;
  skipped: number;
  dispatchedIds: string[];
}> {
  if (config.leader) {
    return tickOnce();
  }
  // Followers relay to the leader. The leader's response shape matches
  // tickOnce (B6 forwarded #13: includes `dispatchedIds`); we accept a
  // missing field as `[]` for graceful degradation against an older leader.
  const r = await leaderClient.continuationTick();
  return {
    ...r,
    dispatchedIds: Array.isArray((r as { dispatchedIds?: unknown }).dispatchedIds)
      ? ((r as { dispatchedIds: unknown[] }).dispatchedIds as string[])
      : [],
    skipped: (r as { skipped?: number }).skipped ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Task file writes                                                            */
/* -------------------------------------------------------------------------- */

export interface WriteTaskFileResult {
  ok: true;
  sizeBytes: number;
  /** Phase after the write; only present on the leader path (the leader's
   *  HTTP route returns ok+sizeBytes only, not the phase). */
  phase?: string;
}

/**
 * Returns null when the task doesn't exist (so the route can map to 404).
 * Throws RangeError on size cap (so the route can map to 413).
 */
export async function writeTaskFile(
  slug: string,
  taskId: string,
  filename: string,
  content: string,
  updatedBy: string | null,
): Promise<WriteTaskFileResult | null> {
  if (config.leader) {
    const task = TasksRepo.get(slug, taskId);
    if (!task) return null;
    const result = TasksRepo.writeFile(slug, taskId, filename, content, updatedBy);
    return { ok: true, sizeBytes: result.sizeBytes, phase: result.phase };
  }
  // Followers: relay. The leader's route returns 404 if the task is
  // missing; we surface that as null so the route can map back to 404.
  try {
    const r = await leaderClient.writeTaskFile(slug, taskId, filename, content);
    return { ok: true, sizeBytes: r.sizeBytes };
  } catch (err) {
    if (isLeader404(err)) return null;
    throw err;
  }
}

/** Returns null when the task doesn't exist. */
export async function deleteTaskFile(
  slug: string,
  taskId: string,
  filename: string,
): Promise<{ phase: string } | null> {
  if (config.leader) {
    const task = TasksRepo.get(slug, taskId);
    if (!task) return null;
    const result = TasksRepo.deleteFile(slug, taskId, filename);
    return { phase: result.phase };
  }
  try {
    await leaderClient.deleteTaskFile(slug, taskId, filename);
    // The leader doesn't return the post-delete phase from this route;
    // the follower-side broadcast doesn't need it (it's already a
    // non-authoritative event), so omit phase.
    return { phase: '' };
  } catch (err) {
    if (isLeader404(err)) return null;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch writes (claim / done / log)                                        */
/* -------------------------------------------------------------------------- */

export interface ClaimResult {
  outcome: 'claimed' | 'unknown' | 'terminal' | 'taken';
  dispatch?: Dispatch;
  state?: DispatchState;
  claimedBy?: string | null;
}

export async function claimDispatch(id: string, claimedBy: string): Promise<ClaimResult> {
  if (config.leader) {
    const dispatch = DispatchRepo.claim(id, claimedBy);
    if (dispatch) return { outcome: 'claimed', dispatch };
    const cur = DispatchRepo.getById(id);
    if (!cur) return { outcome: 'unknown' };
    if (isTerminalState(cur.state)) return { outcome: 'terminal', state: cur.state };
    return { outcome: 'taken', claimedBy: cur.claimedBy };
  }
  // Follower: relay through the rawRelay so we can preserve the
  // leader's status-code distinction (200/404/409/410).
  const r = await leaderClient.rawRelay(
    'POST',
    `/api/dispatches/${encodeURIComponent(id)}/claim`,
    { claimedBy },
  );
  if (r.statusCode === 200) {
    return { outcome: 'claimed', dispatch: r.body as Dispatch };
  }
  if (r.statusCode === 404) return { outcome: 'unknown' };
  if (r.statusCode === 410) {
    const body = r.body as { state?: DispatchState } | null;
    return { outcome: 'terminal', state: body?.state };
  }
  if (r.statusCode === 409) {
    const body = r.body as { claimedBy?: string | null } | null;
    return { outcome: 'taken', claimedBy: body?.claimedBy ?? null };
  }
  throw new Error(`claimDispatch: unexpected leader status ${r.statusCode}`);
}

export interface MarkDoneInput {
  exitCode: number | null;
  durationMs: number;
  stderrSnippet?: string | null;
}

/**
 * Returns the post-update Dispatch on success.
 * Throws `UnknownDispatchError` on 404 and `DispatchStateError` on 409 so
 * the HTTP route can map to status codes via instanceof checks.
 */
export async function markDispatchDone(id: string, info: MarkDoneInput): Promise<Dispatch> {
  if (config.leader) {
    return DispatchRepo.markDone(id, {
      exitCode: info.exitCode,
      durationMs: info.durationMs,
      stderrSnippet: info.stderrSnippet ?? null,
    });
  }
  const r = await leaderClient.rawRelay(
    'POST',
    `/api/dispatches/${encodeURIComponent(id)}/done`,
    info,
  );
  if (r.statusCode >= 200 && r.statusCode < 300) {
    return r.body as Dispatch;
  }
  if (r.statusCode === 404) throw new UnknownDispatchError(id);
  if (r.statusCode === 409) {
    const body = r.body as { state?: DispatchState } | null;
    throw new DispatchStateError('markDone', id, body?.state ?? 'pending');
  }
  throw new Error(`markDispatchDone: unexpected leader status ${r.statusCode}`);
}

/**
 * Append a dispatch log row. Returns null when the dispatch is unknown.
 */
export async function appendDispatchLog(
  id: string,
  message: string,
  level: 'info' | 'warn' | 'error',
  host: string | undefined,
): Promise<{ ok: true } | null> {
  if (config.leader) {
    const dispatch = DispatchRepo.getById(id);
    if (!dispatch) return null;
    DispatchRepo.appendLog(id, message, level, host);
    return { ok: true };
  }
  const r = await leaderClient.rawRelay(
    'POST',
    `/api/dispatches/${encodeURIComponent(id)}/log`,
    { message, level, host },
  );
  if (r.statusCode === 404) return null;
  if (r.statusCode >= 200 && r.statusCode < 300) return { ok: true };
  throw new Error(`appendDispatchLog: unexpected leader status ${r.statusCode}`);
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function isLeader404(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode: unknown }).statusCode === 404
  );
}

function rawRowToDispatch(raw: Record<string, unknown>): Dispatch {
  return {
    id: String(raw.id),
    projectSlug: String(raw.project_slug),
    taskId: String(raw.task_id),
    phase: String(raw.phase),
    agentId: String(raw.agent_id),
    prompt: String(raw.prompt),
    state: String(raw.state) as DispatchState,
    failureCount: Number(raw.failure_count ?? 0),
    exitCode:
      raw.exit_code === null || raw.exit_code === undefined ? null : Number(raw.exit_code),
    durationMs:
      raw.duration_ms === null || raw.duration_ms === undefined ? null : Number(raw.duration_ms),
    stderrSnippet:
      raw.stderr_snippet === null || raw.stderr_snippet === undefined
        ? null
        : String(raw.stderr_snippet),
    createdBy: String(raw.created_by),
    claimedBy:
      raw.claimed_by === null || raw.claimed_by === undefined ? null : String(raw.claimed_by),
    createdAt: String(raw.created_at),
    claimedAt:
      raw.claimed_at === null || raw.claimed_at === undefined ? null : String(raw.claimed_at),
    completedAt:
      raw.completed_at === null || raw.completed_at === undefined
        ? null
        : String(raw.completed_at),
  };
}
