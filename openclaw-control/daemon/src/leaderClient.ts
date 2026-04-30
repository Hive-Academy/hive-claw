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

import { request } from 'undici';
import type { Dispatch, MemoryScope } from './db/index.js';

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
/* Dispatch surface                                                           */
/* -------------------------------------------------------------------------- */

export async function listPendingForAgents(agentIds: readonly string[]): Promise<Dispatch[]> {
  const c = require_();
  const qs = encodeURIComponent(agentIds.join(','));
  const res = await request(`${c.baseUrl}/api/dispatches/pending?agentIds=${qs}`, {
    method: 'GET',
    headers: authHeader(),
  });
  // The /pending route returns a slim shape; cast to Dispatch is acceptable
  // because the worker only reads the listed fields. If callers need the
  // full row they should use getById on the chosen candidate.
  const slim = await readJson<
    Array<{
      id: string;
      projectSlug: string;
      taskId: string;
      phase: string;
      agentId: string;
      createdAt: string;
    }>
  >(res.statusCode, res.body, 'listPendingForAgents');
  // Fill in the rest of Dispatch with conservative defaults — the worker
  // only inspects id; downstream calls (claim, getById) re-fetch full state.
  return slim.map((s) => ({
    id: s.id,
    projectSlug: s.projectSlug,
    taskId: s.taskId,
    phase: s.phase,
    agentId: s.agentId,
    prompt: '',
    state: 'pending',
    failureCount: 0,
    exitCode: null,
    durationMs: null,
    stderrSnippet: null,
    createdBy: '',
    claimedBy: null,
    createdAt: s.createdAt,
    claimedAt: null,
    completedAt: null,
  }));
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
