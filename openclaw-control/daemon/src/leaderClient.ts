/**
 * Leader HTTP client.
 *
 * On followers, the dispatch worker, the invoker's audit-log appender, and
 * any read path that needs canonical state call into this module to reach
 * the leader's Fastify API. The full set of routes covered:
 *
 *   - dispatches: list pending, claim, mark done, get-by-id, append log
 *   - task files: list, read, write
 *   - memory: list, read, write
 *   - SSE: subscribe to `topics=dispatch` for push-notification fan-out
 *
 * All requests carry `Authorization: Bearer ${token}` from initLeaderClient.
 *
 * Errors are surfaced as `LeaderError` with the HTTP status code attached
 * so callers can branch on 404 / 409 / 410 (the claim-distinction the
 * dispatch worker depends on).
 */

import { request as undiciRequest, type Dispatcher } from 'undici';
import type { Dispatch, DispatchState, MemoryScope } from './db/index.js';
import type { Project } from './projects.js';
import type { TaskSummary } from './phase.js';
import type { Agent } from './agents.js';
import type { MemoryEntry } from './memory.js';
import { assertNotForbiddenJsonRpc } from './harness/outboundGuard.js';

/**
 * Single chokepoint wrapper around `undici.request` so the
 * `assertNotForbiddenJsonRpc` guard runs on EVERY outbound POST/PUT body the
 * follower → leader relay constructs. The guard is a no-op in
 * production-default mode (env unset); when active it inspects the body and
 * throws on `wizard:*` / `harness:analyze-intent` BEFORE the request is
 * dispatched. See `daemon/src/harness/outboundGuard.ts` for the contract.
 */
function request(
  url: string,
  opts: Parameters<typeof undiciRequest>[1],
): ReturnType<typeof undiciRequest> {
  if (opts && typeof opts === 'object' && 'body' in opts) {
    assertNotForbiddenJsonRpc(opts.body as string | Buffer | Uint8Array | null | undefined);
  }
  return undiciRequest(url, opts);
}
// Re-export the dispatcher type so existing call signatures elsewhere don't shift.
export type { Dispatcher };

export class LeaderError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'LeaderError';
    this.statusCode = statusCode;
  }
}

interface ConfiguredClient {
  baseUrl: string;
  token: string;
}

let client: ConfiguredClient | null = null;

/**
 * Capture the leader's URL and the internal bearer token. Process-global —
 * followers always talk to exactly one leader.
 */
export function initLeaderClient(baseUrl: string, internalToken: string): void {
  if (!baseUrl || baseUrl.length === 0) {
    throw new Error('initLeaderClient: baseUrl is required');
  }
  client = { baseUrl: baseUrl.replace(/\/$/, ''), token: internalToken };
}

export function isLeaderClientConfigured(): boolean {
  return client !== null;
}

function require_(): ConfiguredClient {
  if (!client) {
    throw new Error(
      'leaderClient: not configured. initLeaderClient must run during boot before any follower-side daemon call.',
    );
  }
  return client;
}

function authHeader(): { authorization: string; 'content-type': string } {
  const c = require_();
  return {
    authorization: `Bearer ${c.token}`,
    'content-type': 'application/json',
  };
}

async function readJson<T>(statusCode: number, body: { json(): Promise<unknown>; text(): Promise<string> }, ctx: string): Promise<T> {
  if (statusCode >= 200 && statusCode < 300) {
    return (await body.json()) as T;
  }
  let detail = '';
  try {
    detail = await body.text();
  } catch {
    // Non-actionable: the response stream may already be drained.
  }
  throw new LeaderError(statusCode, `${ctx}: HTTP ${statusCode}${detail ? ' ' + detail.slice(0, 200) : ''}`);
}

/* -------------------------------------------------------------------------- */
/* Project / task reads (follower → leader)                                   */
/* -------------------------------------------------------------------------- */

interface ProjectListResponse {
  slug: string;
  path: string;
  taskCount: number;
  openTaskCount: number;
  checkpointCount: number;
}

export async function listProjects(): Promise<ProjectListResponse[]> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/projects`, {
    method: 'GET',
    headers: authHeader(),
  });
  return readJson<ProjectListResponse[]>(res.statusCode, res.body, 'listProjects');
}

/**
 * Resolve a project by slug from the leader. Returns null on 404.
 *
 * The leader does not currently expose a single-project GET (only
 * /api/projects for the aggregated list and /api/projects/:slug/tasks for
 * the task list). We synthesise a Project shape from the aggregated list —
 * the only fields the follower's route handlers need are `slug` and
 * `path`. This avoids adding a new leader route just for the relay.
 */
export async function readProject(slug: string): Promise<Project | null> {
  const projects = await listProjects();
  const match = projects.find((p) => p.slug === slug);
  if (!match) return null;
  return { slug: match.slug, path: match.path, hasSpecs: true };
}

export async function listTasksForProject(slug: string): Promise<TaskSummary[]> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks`,
    { method: 'GET', headers: authHeader() },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return [];
  }
  return readJson<TaskSummary[]>(res.statusCode, res.body, 'listTasksForProject');
}

interface TaskWithArtifactsResponse extends TaskSummary {
  artifacts?: Record<string, string>;
}

export async function readTaskSummary(
  slug: string,
  taskId: string,
): Promise<TaskSummary | null> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'GET', headers: authHeader() },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  const body = await readJson<TaskWithArtifactsResponse>(
    res.statusCode,
    res.body,
    'readTaskSummary',
  );
  // Strip `artifacts` — readTaskSummary returns the summary shape only;
  // readTaskArtifacts is a separate call that re-fetches if needed.
  const { artifacts: _drop, ...summary } = body;
  void _drop;
  return summary;
}

export async function readTaskArtifacts(
  slug: string,
  taskId: string,
): Promise<Record<string, string>> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'GET', headers: authHeader() },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return {};
  }
  const body = await readJson<TaskWithArtifactsResponse>(
    res.statusCode,
    res.body,
    'readTaskArtifacts',
  );
  return body.artifacts ?? {};
}

/* -------------------------------------------------------------------------- */
/* Task / approval / continuation write relays                                */
/* -------------------------------------------------------------------------- */

export interface CreateTaskRequest {
  project: string;
  description: string;
  taskType?: string;
  agentId?: string;
  discordUserId?: string;
  channelId?: string;
}

export interface CreateTaskResponse {
  taskId: string;
  folder: string;
}

export async function createTask(body: CreateTaskRequest): Promise<CreateTaskResponse> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify(body),
  });
  return readJson<CreateTaskResponse>(res.statusCode, res.body, 'createTask');
}

export async function recordApproval(
  slug: string,
  taskId: string,
  body: { phase: string; decision: 'APPROVED' | 'REJECTED'; feedback?: string },
): Promise<{ ok: true } | null> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(
      taskId,
    )}/approve`,
    {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
    },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  return readJson<{ ok: true }>(res.statusCode, res.body, 'recordApproval');
}

export async function deleteTaskFile(
  slug: string,
  taskId: string,
  filename: string,
): Promise<void> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(
      taskId,
    )}/files/${encodeURIComponent(filename)}`,
    { method: 'DELETE', headers: authHeader() },
  );
  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return;
  }
  const detail = await res.body.text().catch(() => '');
  throw new LeaderError(
    res.statusCode,
    `deleteTaskFile: HTTP ${res.statusCode}${detail ? ' ' + detail.slice(0, 200) : ''}`,
  );
}

export async function continuationTick(): Promise<{
  dispatched: number;
  pending: number;
  checkpoints: number;
  skipped: number;
  dispatchedIds?: string[];
}> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/continuation/tick`, {
    method: 'POST',
    headers: authHeader(),
  });
  return readJson<{
    dispatched: number;
    pending: number;
    checkpoints: number;
    skipped: number;
    dispatchedIds?: string[];
  }>(res.statusCode, res.body, 'continuationTick');
}

/**
 * Raw HTTP relay — sends the request and returns the leader's `(statusCode,
 * body)` verbatim so the follower's route handler can mirror them on its
 * reply. Used when status-code distinctions matter (claim 200/404/409/410,
 * dispatch state edges, etc.) and constructing typed helpers each time
 * would be more code than the call site warrants.
 */
export async function rawRelay(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const c = require_();
  const res = await request(`${c.baseUrl}${path}`, {
    method,
    headers: authHeader(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    const text = await res.body.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
  } catch {
    // Empty body — leave parsed as null.
  }
  return { statusCode: res.statusCode, body: parsed };
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

export async function listAgents(): Promise<Agent[]> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/agents`, {
    method: 'GET',
    headers: authHeader(),
  });
  return readJson<Agent[]>(res.statusCode, res.body, 'listAgents');
}

/* -------------------------------------------------------------------------- */
/* Dispatch surface                                                           */
/* -------------------------------------------------------------------------- */

interface DispatchListFilters {
  state?: DispatchState;
  projectSlug?: string;
  taskId?: string;
  limit?: number;
}

export async function listDispatches(
  filters: DispatchListFilters,
): Promise<Dispatch[]> {
  const c = require_();
  const qs = new URLSearchParams();
  if (filters.state) qs.set('state', filters.state);
  if (filters.projectSlug) qs.set('projectSlug', filters.projectSlug);
  if (filters.taskId) qs.set('taskId', filters.taskId);
  if (filters.limit !== undefined) qs.set('limit', String(filters.limit));
  const url = `${c.baseUrl}/api/dispatches${qs.size ? '?' + qs.toString() : ''}`;
  const res = await request(url, { method: 'GET', headers: authHeader() });
  return readJson<Dispatch[]>(res.statusCode, res.body, 'listDispatches');
}

/**
 * Slim shape returned by GET /api/dispatches/pending. The leader strips
 * the heavy fields (prompt, log details) on its way out; surfacing the
 * trimmed type here prevents future callers from relying on `prompt` /
 * `failureCount` etc. that are not actually populated. Callers that need
 * the full row should `getById` the candidate they want to act on.
 */
export type PendingDispatchSummary = Pick<
  Dispatch,
  'id' | 'projectSlug' | 'taskId' | 'phase' | 'agentId' | 'createdAt'
>;

/**
 * Returns the leader's claimable list as the slim shape. The worker only
 * reads `id` from each entry and re-fetches via `claim`, so the slim shape
 * is sufficient. To reach the full row, call `getById(id)`.
 *
 * Compatibility: legacy callers expected `Dispatch[]`. The slim type is
 * structurally compatible with that interface for the read sites that
 * matter (id-based selection); structural compatibility prevents a silent
 * regression where a caller reads `.prompt` and gets `''`.
 */
export async function listPendingForAgents(
  agentIds: readonly string[],
): Promise<PendingDispatchSummary[]> {
  const c = require_();
  const qs = encodeURIComponent(agentIds.join(','));
  const res = await request(`${c.baseUrl}/api/dispatches/pending?agentIds=${qs}`, {
    method: 'GET',
    headers: authHeader(),
  });
  return readJson<PendingDispatchSummary[]>(
    res.statusCode,
    res.body,
    'listPendingForAgents',
  );
}

export async function claim(id: string, claimedBy: string): Promise<Dispatch | null> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/dispatches/${encodeURIComponent(id)}/claim`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ claimedBy }),
  });
  if (res.statusCode === 200) {
    return (await res.body.json()) as Dispatch;
  }
  if (res.statusCode === 409) {
    // Already taken by someone else — null tells the worker to move on.
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  // 404 unknown / 410 terminal / anything else → surface as LeaderError so
  // the caller can branch on statusCode.
  const detail = await res.body.text().catch(() => '');
  throw new LeaderError(
    res.statusCode,
    `claim: HTTP ${res.statusCode}${detail ? ' ' + detail.slice(0, 200) : ''}`,
  );
}

export async function markDone(
  id: string,
  info: { exitCode: number | null; durationMs: number; stderrSnippet?: string | null },
): Promise<Dispatch> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/dispatches/${encodeURIComponent(id)}/done`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({
      exitCode: info.exitCode,
      durationMs: info.durationMs,
      stderrSnippet: info.stderrSnippet ?? undefined,
    }),
  });
  return readJson<Dispatch>(res.statusCode, res.body, 'markDone');
}

export async function getById(id: string): Promise<Dispatch | null> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/dispatches/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: authHeader(),
  });
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  return readJson<Dispatch>(res.statusCode, res.body, 'getById');
}

/**
 * Append an audit-log row for a dispatch via POST /api/dispatches/:id/log.
 * Best-effort by design: failures (network, leader 5xx, leader restart) are
 * caught and logged via console.warn so a transient leader hiccup never
 * crashes the follower's invoker. The host field carries the FOLLOWER's
 * HOSTNAME so cross-machine traceability survives the hop — without it the
 * leader's repo would default to its own hostname.
 */
export async function appendLog(
  dispatchId: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  if (!client) {
    // Match the contract: never throw on missing config for this call.
    return;
  }
  const c = client;
  try {
    const res = await request(
      `${c.baseUrl}/api/dispatches/${encodeURIComponent(dispatchId)}/log`,
      {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          message,
          level,
          host: process.env.HOSTNAME ?? null,
        }),
      },
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const detail = await res.body.text().catch(() => '');
      console.warn(
        `[leaderClient] appendLog HTTP ${res.statusCode}${detail ? ' ' + detail.slice(0, 200) : ''}`,
      );
      return;
    }
    // Drain so the connection can be reused.
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
  } catch (err) {
    console.warn('[leaderClient] appendLog failed:', err);
  }
}

/* -------------------------------------------------------------------------- */
/* Task files                                                                 */
/* -------------------------------------------------------------------------- */

export interface RemoteTaskFileMeta {
  filename: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface RemoteTaskFile {
  content: string;
  contentType: string;
  sizeBytes: number;
  updatedAt: string;
}

export async function listTaskFiles(slug: string, taskId: string): Promise<RemoteTaskFileMeta[]> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/files`,
    { method: 'GET', headers: authHeader() },
  );
  return readJson<RemoteTaskFileMeta[]>(res.statusCode, res.body, 'listTaskFiles');
}

export async function readTaskFile(
  slug: string,
  taskId: string,
  filename: string,
): Promise<RemoteTaskFile | null> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(
      taskId,
    )}/files/${encodeURIComponent(filename)}`,
    { method: 'GET', headers: authHeader() },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  return readJson<RemoteTaskFile>(res.statusCode, res.body, 'readTaskFile');
}

export async function writeTaskFile(
  slug: string,
  taskId: string,
  filename: string,
  content: string,
): Promise<{ ok: true; sizeBytes: number }> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(
      taskId,
    )}/files/${encodeURIComponent(filename)}`,
    {
      method: 'PUT',
      headers: authHeader(),
      body: JSON.stringify({ content }),
    },
  );
  return readJson<{ ok: true; sizeBytes: number }>(res.statusCode, res.body, 'writeTaskFile');
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

export async function listMemory(scope: MemoryScope, _ownerId?: string): Promise<unknown[]> {
  const c = require_();
  // The leader's GET /api/memories/:scope already filters server-side; we
  // pass the scope through and let the caller filter ownerId locally.
  const res = await request(`${c.baseUrl}/api/memories/${encodeURIComponent(scope)}`, {
    method: 'GET',
    headers: authHeader(),
  });
  return readJson<unknown[]>(res.statusCode, res.body, 'listMemory');
}

/**
 * Typed `listMemory` for the storage facade — same wire format as listMemory
 * above, but the typed `MemoryEntry[]` return signals the caller's intent.
 * The leader's route already includes private-FS entries when the leader
 * IS the owner; the follower simply relays its view.
 */
export async function listMemoryScope(scope: MemoryScope): Promise<MemoryEntry[]> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/memories/${encodeURIComponent(scope)}`, {
    method: 'GET',
    headers: authHeader(),
  });
  return readJson<MemoryEntry[]>(res.statusCode, res.body, 'listMemoryScope');
}

export async function deleteMemory(
  scope: MemoryScope,
  ownerId: string,
  filename: string,
): Promise<void> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/memories/${encodeURIComponent(scope)}/${encodeURIComponent(
      ownerId,
    )}/${encodeURIComponent(filename)}`,
    { method: 'DELETE', headers: authHeader() },
  );
  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return;
  }
  const detail = await res.body.text().catch(() => '');
  throw new LeaderError(
    res.statusCode,
    `deleteMemory: HTTP ${res.statusCode}${detail ? ' ' + detail.slice(0, 200) : ''}`,
  );
}

export async function readMemory(
  scope: MemoryScope,
  ownerId: string,
  filename: string,
): Promise<{ content: string; private: boolean } | null> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/memories/${encodeURIComponent(scope)}/${encodeURIComponent(
      ownerId,
    )}/${encodeURIComponent(filename)}`,
    { method: 'GET', headers: authHeader() },
  );
  if (res.statusCode === 404) {
    try {
      await res.body.text();
    } catch {
      // Non-actionable
    }
    return null;
  }
  return readJson<{ content: string; private: boolean }>(
    res.statusCode,
    res.body,
    'readMemory',
  );
}

export async function writeMemory(
  scope: MemoryScope,
  ownerId: string,
  filename: string,
  content: string,
): Promise<{ ok: true; private: boolean }> {
  const c = require_();
  const res = await request(
    `${c.baseUrl}/api/memories/${encodeURIComponent(scope)}/${encodeURIComponent(
      ownerId,
    )}/${encodeURIComponent(filename)}`,
    {
      method: 'PUT',
      headers: authHeader(),
      body: JSON.stringify({ content }),
    },
  );
  return readJson<{ ok: true; private: boolean }>(res.statusCode, res.body, 'writeMemory');
}

/* -------------------------------------------------------------------------- */
/* Health relay (for follower /api/health)                                    */
/* -------------------------------------------------------------------------- */

export async function getLeaderDbVersion(): Promise<number | null> {
  const c = require_();
  const res = await request(`${c.baseUrl}/api/health`, {
    method: 'GET',
    headers: authHeader(),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new LeaderError(res.statusCode, 'getLeaderDbVersion: leader unavailable');
  }
  const body = (await res.body.json()) as { dbVersion?: number };
  return typeof body.dbVersion === 'number' ? body.dbVersion : null;
}

/* -------------------------------------------------------------------------- */
/* SSE subscription                                                           */
/* -------------------------------------------------------------------------- */

interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Long-lived subscription against the leader's `/api/stream?topics=dispatch`.
 *
 * The callback is invoked with `null` on every successful (re)connection so
 * the worker can do an initial pending-list refresh — covering the case
 * where the worker missed events while disconnected.
 *
 * Reconnect uses exponential backoff capped at 30 s. Returns a stop
 * function the caller can invoke to tear the subscription down on
 * shutdown.
 */
export function subscribeDispatchSse(callback: (event: SseEvent | null) => void): () => void {
  const c = require_();
  let stopped = false;
  let backoffMs = 500;
  const MAX_BACKOFF_MS = 30_000;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await request(`${c.baseUrl}/api/stream?topics=dispatch`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${c.token}`,
            accept: 'text/event-stream',
          },
          // No timeout on the long-lived stream itself — the response body
          // is consumed iteratively below until the leader closes or we abort.
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new LeaderError(
            res.statusCode,
            `subscribeDispatchSse: leader returned HTTP ${res.statusCode}`,
          );
        }

        // Reset backoff on a healthy connection and signal the caller.
        backoffMs = 500;
        callback(null);

        // Parse SSE incrementally. The leader writes `event: <name>\ndata:
        // <json>\n\n` blocks; we accumulate text and split on blank lines.
        let buffer = '';
        const decoder = new TextDecoder('utf-8');
        for await (const chunk of res.body) {
          if (stopped) break;
          buffer += decoder.decode(chunk as Buffer, { stream: true });
          let blankIdx: number;
          while ((blankIdx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, blankIdx);
            buffer = buffer.slice(blankIdx + 2);
            const evt = parseSseBlock(block);
            if (evt) callback(evt);
          }
        }
        // Stream ended cleanly — fall through to the reconnect loop.
      } catch (err) {
        if (stopped) return;
        // Best-effort log; the reconnect loop will retry.
        console.warn('[leaderClient] SSE stream error, will reconnect:', err);
      }

      if (stopped) return;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  };

  // Kick off the loop without blocking the caller. Errors in the loop are
  // handled internally; this `void` is intentional.
  void run();

  return () => {
    stopped = true;
  };
}

function parseSseBlock(block: string): SseEvent | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (!event && dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  if (dataStr.length > 0) {
    try {
      data = JSON.parse(dataStr);
    } catch {
      // Leave as raw string when the leader emits non-JSON payloads.
    }
  }
  return { event, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
