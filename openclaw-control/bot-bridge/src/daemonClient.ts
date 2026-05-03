import { request } from 'undici';
import { config } from './config.js';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.internalToken) headers['authorization'] = `Bearer ${config.internalToken}`;
  const r = await request(`${config.daemonUrl}${path}`, {
    method: method as any,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) throw new Error(`${method} ${path} → ${r.statusCode}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export type MemoryScope = 'users' | 'agents' | 'threads' | 'projects';

export interface MemoryReadResult {
  content: string;
  private: boolean;
}

export class HttpStatusError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpStatusError';
  }
}

/**
 * GET /api/memories/{scope}/{ownerId}/{filename}.
 *
 * 404 → null (normal "missing" flow). 5xx (or unexpected 4xx other than 404)
 * throws an `HttpStatusError` carrying the status code.
 *
 * Note: there is intentionally NO `readPersona` helper. Personas are a
 * local-FS concern (PRIVATE_AGENT_FILES — see persona privacy invariant in
 * docs/SECURITY.md); the daemon's HTTP gate already 404s scope=agents +
 * persona.md, but bot-bridge must short-circuit before any HTTP call exists.
 */
async function readMemory(
  scope: MemoryScope,
  ownerId: string,
  filename: string,
): Promise<MemoryReadResult | null> {
  const url =
    `${config.daemonUrl}/api/memories/${encodeURIComponent(scope)}` +
    `/${encodeURIComponent(ownerId)}/${encodeURIComponent(filename)}`;
  const r = await request(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    // Drain the body so the connection can be reused.
    await r.body.dump();
    return null;
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/memories/${scope}/${ownerId}/${filename} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as MemoryReadResult;
}

async function readAgentIdentity(agentId: string): Promise<MemoryReadResult | null> {
  return readMemory('agents', agentId, 'identity.md');
}

async function readDiscordJson(agentId: string): Promise<unknown | null> {
  const result = await readMemory('agents', agentId, 'discord.json');
  if (result === null) return null;
  // JSON.parse failure here is a data-integrity error, not "missing" —
  // let it propagate so it surfaces in logs rather than being swallowed.
  return JSON.parse(result.content);
}

/**
 * Fetch a persona's harness.yaml from shared memory (TASK_2026_002).
 *
 * Unlike persona.md (PRIVATE_AGENT_FILES), harness.yaml is public and
 * traverses HTTP — it lists skills, subagents, MCP server commands, and
 * model tier. The persona privacy invariant is unaffected.
 *
 * Returns null on 404 (persona has no harness configured yet — common case
 * during rollout). 5xx and unexpected 4xx propagate as `HttpStatusError`
 * for the caller to log and treat as transient.
 */
async function readHarnessYaml(agentId: string): Promise<MemoryReadResult | null> {
  return readMemory('agents', agentId, 'harness.yaml');
}

// ---------------------------------------------------------------------------
// Project-files helpers (TASK_2026_002 B7) — consume the daemon endpoints
// landed in B6 (`api.ts` lines 752–910).
//
// The bot-bridge harness-author tools (harnessAuthor.ts) call these to probe
// a project's working tree, read individual files for shape inference, and
// (after operator confirmation) write `<project>/.claude/harness.yaml`.
//
// All three helpers go through the internal-token Bearer auth path. The
// daemon enforces leader-only on these endpoints (405 from a follower) and
// runs `safeProjectPath` for every relative-path argument — these helpers
// are thin transports, not validators. The harness-author tools are
// responsible for their own boundary checks before calling here.
// ---------------------------------------------------------------------------

export interface ProjectFileMeta {
  path: string;
  size: number;
  mtime: string;
}

export interface ProjectFileReadResult {
  content: string;
  sizeBytes: number;
  mtime: string;
}

/**
 * GET /api/projects/:slug/files?path=<relativePath>
 *
 * Returns the file contents + stat metadata. `null` on 404 (file missing).
 * 5xx and unexpected 4xx propagate as `HttpStatusError` so the caller can
 * surface a meaningful error to the LLM rather than papering over it.
 *
 * The daemon caps the body at PROJECT_FILE_MAX_BYTES; oversize → 413, which
 * propagates as `HttpStatusError` (the harness-author tool re-shapes that
 * into a friendly LLM message).
 */
async function readProjectFile(
  slug: string,
  relativePath: string,
): Promise<ProjectFileReadResult | null> {
  const url =
    `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files` +
    `?path=${encodeURIComponent(relativePath)}`;
  const r = await request(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    await r.body.dump();
    return null;
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/projects/${slug}/files?path=${relativePath} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as ProjectFileReadResult;
}

/**
 * GET /api/projects/:slug/files?prefix=<dir>
 *
 * Returns the (non-recursive) file listing under `<project>/<prefix>`.
 * `prefix` is "" → list `<project>` root. Uses the same Bearer auth and
 * daemon-side `safeProjectPath` validation as the read helper.
 *
 * Returns an empty array on 404 (prefix dir missing) — the caller's probe
 * loop treats "no such directory" as "no entries to consider".
 */
async function listProjectFiles(
  slug: string,
  prefix: string = '',
): Promise<ProjectFileMeta[]> {
  const qs = prefix.length > 0 ? `?prefix=${encodeURIComponent(prefix)}` : '';
  const url = `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files${qs}`;
  const r = await request(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    await r.body.dump();
    return [];
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/projects/${slug}/files${qs} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as ProjectFileMeta[];
}

/**
 * POST /api/projects/:slug/files
 *
 * Writes `<project>/<relativePath>` with `content`. The daemon mkdirs the
 * parent directory recursively (matching api.ts:867). Returns the byte size
 * the daemon recorded; throws `HttpStatusError` on 4xx/5xx so the caller
 * can decide whether to retry or surface the error to the operator.
 *
 * This is the only mutation in the project-files surface. The harness-author
 * `write_harness_file` tool guards on `stage === 'writing'` BEFORE calling
 * this; do not relax the gating elsewhere.
 */
async function writeProjectFile(
  slug: string,
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; sizeBytes: number }> {
  const url = `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files`;
  const r = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.internalToken}`,
    },
    body: JSON.stringify({ path: relativePath, content }),
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `POST /api/projects/${slug}/files (path=${relativePath}) → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as { ok: boolean; sizeBytes: number };
}

export const daemon = {
  listProjects: () => call<any[]>('GET', '/api/projects'),
  listAgents: () => call<any[]>('GET', '/api/agents'),
  listTasks: (slug: string) => call<any[]>('GET', `/api/projects/${slug}/tasks`),
  getTask: (slug: string, id: string) => call<any>('GET', `/api/projects/${slug}/tasks/${id}`),
  createTask: (body: { project: string; description: string; agentId?: string; discordUserId?: string; channelId?: string }) =>
    call<{ taskId: string }>('POST', '/api/tasks', body),
  approve: (slug: string, id: string, body: { phase: string; decision: 'APPROVED' | 'REJECTED'; feedback?: string }) =>
    call('POST', `/api/projects/${slug}/tasks/${id}/approve`, body),
  handoff: (slug: string, id: string, toAgent: string, reason?: string) =>
    call('POST', `/api/projects/${slug}/tasks/${id}/handoff`, { toAgent, reason }),
  tick: () => call<{ dispatched: number; checkpoints: number; pending: number; dispatchedIds?: string[] }>('POST', '/api/continuation/tick'),

  // -------------------------------------------------------------------------
  // TASK_2026_002 B2 — daemon-CRUD tool surface helpers.
  //
  // These are the canonical names the chat-tier tool registry calls
  // (tools/daemonTools.ts). They alias the existing helpers above with the
  // names the impl-plan §`tools/daemonTools.ts` enumerates so the tool
  // handlers can stay one-line wrappers. We keep the legacy names so the
  // pre-existing `chat.ts` directive flow doesn't churn — both surfaces
  // coexist by design.
  // -------------------------------------------------------------------------
  approveTask: (
    slug: string,
    id: string,
    body: { phase: string; decision: 'APPROVED' | 'REJECTED'; feedback?: string },
  ) => call('POST', `/api/projects/${slug}/tasks/${id}/approve`, body),
  handoffTask: (slug: string, id: string, toAgent: string, reason?: string) =>
    call('POST', `/api/projects/${slug}/tasks/${id}/handoff`, { toAgent, reason }),
  /**
   * Tick the continuation loop. TASK_2026_002 B6 forwarded sub-task #13:
   * the leader now returns `dispatchedIds: string[]` so callers can surface
   * the real dispatch row id rather than synthesizing `dispatched:<n>`.
   * The field is optional in the response shape for backwards-compat
   * against an older leader (returns `[]` in that case).
   */
  tickContinuation: () =>
    call<{
      dispatched: number;
      checkpoints: number;
      pending: number;
      dispatchedIds?: string[];
    }>('POST', '/api/continuation/tick'),
  // NOTE: `appendInteraction` was removed in TASK_2026_001 Batch 8 — it was
  // a 4-arg stub that ignored 3 of its arguments, wrote a placeholder body,
  // and silently swallowed errors (`.catch(() => {})`). It had no callers.
  // The canonical interaction-append helper lives daemon-side at
  // `daemon/src/memory.ts:appendInteraction` (read-modify-write of
  // `users/<id>/interactions.md`). If a future bot-bridge caller needs to
  // record interactions, route through that helper via a real HTTP endpoint
  // — do not resurrect a swallow-errors stub.
  readMemory,
  readAgentIdentity,
  readDiscordJson,
  readHarnessYaml,

  // TASK_2026_002 B7 — harness-author project-files surface.
  readProjectFile,
  listProjectFiles,
  writeProjectFile,

  /**
   * Forward a chat-tier observability event to the daemon's SSE bus
   * (TASK_2026_002 B3 — forwarded sub-task 8 from B2).
   *
   * The chat-tier `ctx.emit` callback in `chat.ts` routes through here so
   * `invoker.tool_call` / `invoker.subagent_started` / `invoker.subagent_finished`
   * surface on `/api/stream` for the dashboard. AT#3 (visibility) hangs on
   * this wire being present.
   *
   * Posts to `POST /api/sse/emit` with `{ event, data }`. **B6 owns the
   * daemon-side endpoint** — for the B3 cut a no-op route is registered so
   * this helper does not 404 on every tool call. Errors are swallowed so a
   * dead daemon (or a stricter rate limiter B6 might add) never breaks the
   * Discord chat path.
   */
  emitSseHint: async (event: string, data: unknown): Promise<void> => {
    try {
      await call('POST', '/api/sse/emit', { event, data });
    } catch {
      // Observability hint must never break the chat path. The daemon's
      // logger captures the failed call shape on its side if it cares.
    }
  },
};
