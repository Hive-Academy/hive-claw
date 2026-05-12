import Fastify, { type preHandlerHookHandler } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listSessions, tailSession, newestSessionForProject } from './sessions.js';
import { attachSse, broadcast } from './sse.js';
import { registerAuth, requireAuth } from './auth.js';
import { MemoryError } from './memory.js';
import { publishHandoff, publishHarnessSync } from './bus.js';
import { harnessHash } from './harness/types.js';
import { materializeAgent, materializeAll } from './harness/materialize.js';
import { spawnPtahForAgent } from './harness/ptahLauncher.js';
import {
  PRIVATE_AGENT_FILES,
  isTerminalState,
  getReadOnlyDb,
  UnknownDispatchError,
  DispatchStateError,
  type DispatchState,
  type MemoryScope,
} from './db/index.js';
import type { Phase } from './phase.js';
import * as leaderClient from './leaderClient.js';
import * as storage from './storage.js';

const TASK_FILE_MAX_BYTES = 1 * 1024 * 1024; // 1 MB — matches TasksRepo.writeFile

/**
 * Project-files cluster (TASK_2026_002 B6 sub-task 8). Same 1 MB cap as
 * task files. The harness-authoring chat (B7) uses these to write
 * `<project>/.claude/harness.yaml`; the route is generic so any future
 * caller writing into the project workspace tree picks up the same
 * path-validation + size guard.
 */
const PROJECT_FILE_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Validate a project-files relative path. Rejects:
 *   - empty / non-string
 *   - absolute paths (anything starting with `/` on POSIX)
 *   - any segment equal to `..` (path traversal)
 *   - resolved paths that fall outside `projectRoot`
 *
 * Returns the absolute path on success. The caller is responsible for the
 * subsequent FS access; this helper is purely a validation gate so the
 * 4xx mapping is consistent across GET/POST/DELETE.
 */
function safeProjectPath(projectRoot: string, rel: unknown): string | { error: string } {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { error: 'path must be a non-empty string' };
  }
  if (rel.startsWith('/')) {
    return { error: 'absolute paths are forbidden' };
  }
  // POSIX-only check — Windows separators are not in scope (the daemon
  // runs in a Linux container and project paths are container-side).
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '..') return { error: 'path traversal segment ".." is forbidden' };
  }
  const resolved = path.resolve(projectRoot, rel);
  const root = path.resolve(projectRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { error: 'resolved path escapes project root' };
  }
  return resolved;
}

/**
 * SSE event-name allowlist (TASK_2026_002 B6 forwarded sub-task #14 — was
 * a wide-open placeholder in B3). Any internal-token holder POSTing to
 * `/api/sse/emit` must use one of these names. Adding a new name here is
 * the explicit gate for "this is a public observability hint, not a
 * potential broadcast-storm vector".
 */
const SSE_EMIT_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'invoker.tool_call',
  'invoker.subagent_started',
  'invoker.subagent_finished',
  'mcp.server_failed',
  'harness.materialized',
  'harness.synced',
]);

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read the database schema version from `schema_version`. Cached for the
 * process lifetime — the value is set once at boot by the migrator and
 * does not change at runtime. On read failure we surface null and let the
 * health route omit the field rather than 500.
 */
let cachedDbVersion: number | null | undefined;
function readDbVersion(): number | null {
  if (cachedDbVersion !== undefined) return cachedDbVersion;
  try {
    const row = getReadOnlyDb()
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null } | undefined;
    cachedDbVersion = row && typeof row.v === 'number' ? row.v : null;
  } catch {
    cachedDbVersion = null;
  }
  return cachedDbVersion;
}

/**
 * Cached relay of the leader's dbVersion for follower-mode health responses.
 * Refreshed on first read and on HTTP error during a relay attempt.
 */
let cachedLeaderDbVersion: number | null = null;
let lastLeaderProbeAt = 0;
const LEADER_HEALTH_TTL_MS = 30_000;

async function readLeaderDbVersion(): Promise<number | null> {
  const now = Date.now();
  if (cachedLeaderDbVersion !== null && now - lastLeaderProbeAt < LEADER_HEALTH_TTL_MS) {
    return cachedLeaderDbVersion;
  }
  try {
    const v = await leaderClient.getLeaderDbVersion();
    cachedLeaderDbVersion = v;
    lastLeaderProbeAt = now;
    return v;
  } catch {
    // Keep the last-known value if we have one; otherwise null.
    lastLeaderProbeAt = now;
    return cachedLeaderDbVersion;
  }
}

export function buildApp() {
  const app = Fastify({ logger: { level: 'info' } });
  app.register(cors, { origin: true, credentials: true });
  app.register(cookie);
  app.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: config.cookieName, signed: false },
  });

  app.get('/api/health', async () => {
    const base: Record<string, unknown> = {
      ok: true,
      ts: new Date().toISOString(),
      leader: config.leader,
      localAgentIds: config.localAgentIds,
      // Storage tier — `db` on the leader (SQLite under config.dbPath),
      // `leader-http` on a follower (talks to config.leaderUrl).
      storage: config.leader ? 'db' : 'leader-http',
    };
    if (config.leader) {
      const v = readDbVersion();
      if (v !== null) base.dbVersion = v;
      base.dbPath = config.dbPath;
    } else {
      const v = await readLeaderDbVersion();
      if (v !== null) base.dbVersion = v;
      // dbPath omitted on followers per §4 (they do not have a local DB).
    }
    return base;
  });

  registerAuth(app);

  // Auth pre-handler. The Fastify type augmentation in `types/fastify.d.ts`
  // typechecks every downstream `req.user.username` read.
  const guard: preHandlerHookHandler = async (req, reply) => {
    const u = await requireAuth(req, reply);
    if (!u) return reply;
    req.user = u;
  };

  // --- projects / tasks --------------------------------------------------
  // Routes go through the storage facade (storage.ts) so the leader and a
  // follower share the same handler shape — the facade dispatches to repos
  // on the leader and to leaderClient HTTP relays on a follower (CD1 fix).
  app.get('/api/projects', { preHandler: guard }, async () => storage.listProjects());

  app.get<{ Params: { slug: string } }>(
    '/api/projects/:slug/tasks',
    { preHandler: guard },
    async (req, reply) => {
      const project = await storage.readProject(req.params.slug);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return storage.listTasksForProject(req.params.slug);
    },
  );

  app.get<{ Params: { slug: string; taskId: string } }>(
    '/api/projects/:slug/tasks/:taskId',
    { preHandler: guard },
    async (req, reply) => {
      const project = await storage.readProject(req.params.slug);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const summary = await storage.readTaskSummary(req.params.slug, req.params.taskId);
      if (!summary) return reply.code(404).send({ error: 'task not found' });
      const artifacts = await storage.readTaskArtifactsBy(req.params.slug, req.params.taskId);
      return { ...summary, artifacts };
    },
  );

  app.post<{
    Body: {
      project: string;
      description: string;
      taskType?: string;
      agentId?: string;
      discordUserId?: string;
      channelId?: string;
    };
  }>('/api/tasks', { preHandler: guard }, async (req, reply) => {
    const { project: slug, description, taskType, agentId, discordUserId, channelId } = req.body;
    if (!slug || !description) return reply.code(400).send({ error: 'project and description required' });
    return storage.createTask({ projectSlug: slug, description, taskType, agentId, discordUserId, channelId });
  });

  app.post<{
    Params: { slug: string; taskId: string };
    Body: { phase: Phase; decision: 'APPROVED' | 'REJECTED'; feedback?: string };
  }>('/api/projects/:slug/tasks/:taskId/approve', { preHandler: guard }, async (req, reply) => {
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const ok = await storage.recordApproval(
      req.params.slug,
      req.params.taskId,
      req.body.phase,
      req.user?.username ?? 'unknown',
      req.body.feedback,
      req.body.decision,
    );
    if (!ok) return reply.code(404).send({ error: 'task not found' });
    return { ok: true };
  });

  app.post<{
    Params: { slug: string; taskId: string };
    Body: { toAgent: string; reason?: string };
  }>('/api/projects/:slug/tasks/:taskId/handoff', { preHandler: guard }, async (req, reply) => {
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const summary = await storage.readTaskSummary(req.params.slug, req.params.taskId);
    if (!summary) return reply.code(404).send({ error: 'task not found' });
    await publishHandoff({
      taskId: req.params.taskId,
      project: project.slug,
      fromAgent: summary.assignedAgent ?? 'unknown',
      toAgent: req.body.toAgent,
      reason: req.body.reason,
      checkpointPhase: summary.phase,
      at: new Date().toISOString(),
    });
    return { ok: true };
  });

  app.post('/api/continuation/tick', { preHandler: guard }, async () =>
    storage.continuationTickThroughFacade(),
  );

  // --- POST /api/ptah/invoke -------------------------------------------
  //
  // Thin wrapper around `harness/ptahLauncher.ts:spawnPtahForAgent`. Called
  // by the future openclaw-control plugin's `invoke_ptah` tool (TASK_2026_006
  // batch 4). The plugin runs in-process with openclaw on the host; this
  // route is the trust-boundary crossing into the daemon.
  //
  // Body:
  //   { project, prompt, agentId?, sessionKey?, timeoutMs? }
  // Response on success:
  //   { ok: true, exitCode: 0, durationMs, output }
  // Response on failure:
  //   { ok: false, exitCode, durationMs, output, stderr? }
  //
  // Leader-only: the project workspace path comes from `storage.readProject`
  // which is local-FS on the leader. Followers 405.
  // Auth: `guard` (internal-token bearer is the canonical caller).
  // `timeoutMs` is bounded by `config.ptah.invokerTimeoutMs`; caller cannot
  // exceed it. Route-side timeout is enforced via `Promise.race`; the bridge
  // call itself does not yet honor the value (Phase 2 plumbing).
  app.post<{
    Body: {
      project?: unknown;
      prompt?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
      timeoutMs?: unknown;
    };
  }>('/api/ptah/invoke', { preHandler: guard }, async (req, reply) => {
    if (!config.leader) {
      return reply
        .code(405)
        .send({ error: 'ptah/invoke is leader-only — POST to OPENCLAW_LEADER_URL instead' });
    }

    // --- body validation ----------------------------------------------
    const body = req.body ?? {};
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (project.length === 0) {
      return reply.code(400).send({ error: 'body.project (non-empty string) required' });
    }
    if (prompt.length === 0) {
      return reply.code(400).send({ error: 'body.prompt (non-empty string) required' });
    }
    // Defense-in-depth path-traversal rejection at the trust boundary;
    // belt-and-braces on top of `safeProjectPath` (which the plugin code
    // also enforces client-side per arch §7.1 layer 6).
    if (project.includes('..') || project.includes('/') || project.includes('\\')) {
      return reply.code(400).send({ error: 'project slug must not contain "..", "/" or "\\"' });
    }

    const agentId =
      typeof body.agentId === 'string' && body.agentId.length > 0 ? body.agentId : null;
    const sessionKey =
      typeof body.sessionKey === 'string' && body.sessionKey.length > 0
        ? body.sessionKey
        : null;

    const maxTimeoutMs = config.ptah.invokerTimeoutMs;
    let timeoutMs: number = maxTimeoutMs;
    if (body.timeoutMs !== undefined && body.timeoutMs !== null) {
      if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 1) {
        return reply
          .code(400)
          .send({ error: 'body.timeoutMs (positive number, ms) is invalid' });
      }
      if (body.timeoutMs > maxTimeoutMs) {
        return reply.code(400).send({
          error: `body.timeoutMs ${body.timeoutMs} exceeds PTAH_INVOKER_TIMEOUT_MS=${maxTimeoutMs}`,
        });
      }
      timeoutMs = body.timeoutMs;
    }

    // --- project lookup -----------------------------------------------
    const proj = await storage.readProject(project);
    if (!proj) return reply.code(404).send({ error: 'project not found' });

    // --- agent resolution ---------------------------------------------
    // If caller omitted `agentId`, fall back to the x-openclaw-agent-id
    // header (the openclaw runtime forwards the current agent's id in this
    // header — see arch §6.1). If neither is present, pick the first
    // configured local agent. The fallback chain is intentionally
    // permissive — callers that care should set agentId explicitly.
    const headerAgent = req.headers['x-openclaw-agent-id'];
    const resolvedAgentId =
      agentId ??
      (typeof headerAgent === 'string' && headerAgent.length > 0 ? headerAgent : null) ??
      config.localAgentIds[0] ??
      'unknown';

    // --- spawn (with route-side timeout) ------------------------------
    const taskId = sessionKey ?? `ptah-invoke-${Date.now()}`;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    try {
      const spawnPromise = spawnPtahForAgent({
        agentId: resolvedAgentId,
        cwd: proj.path,
        prompt,
        taskId,
      });
      const winner = await Promise.race([spawnPromise, timeoutPromise]);
      if ('timedOut' in winner) {
        return {
          ok: false,
          exitCode: null,
          durationMs: Date.now() - started,
          output: '',
          stderr: `[ptah/invoke] timed out after ${timeoutMs}ms`,
        };
      }
      // Spawn completed first. Cancel the timer.
      const r = winner;
      const durationMs = r.durationMs ?? Date.now() - started;
      if (r.ok) {
        return {
          ok: true,
          exitCode: r.exitCode ?? 0,
          durationMs,
          output: r.stdout,
        };
      }
      return {
        ok: false,
        exitCode: r.exitCode,
        durationMs,
        output: r.stdout,
        stderr: r.stderr,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // --- task files (T3.2) ------------------------------------------------
  // List files for a task. Returns metadata only — no body.
  app.get<{ Params: { slug: string; taskId: string } }>(
    '/api/projects/:slug/tasks/:taskId/files',
    { preHandler: guard },
    async (req, reply) => {
      const files = await storage.listTaskFiles(req.params.slug, req.params.taskId);
      if (files === null) return reply.code(404).send({ error: 'task not found' });
      return files;
    },
  );

  // Read a single task file. 404 when the row is absent.
  app.get<{ Params: { slug: string; taskId: string; filename: string } }>(
    '/api/projects/:slug/tasks/:taskId/files/:filename',
    { preHandler: guard },
    async (req, reply) => {
      const file = await storage.readTaskFile(
        req.params.slug,
        req.params.taskId,
        req.params.filename,
      );
      if (!file) return reply.code(404).send({ error: 'file not found' });
      return file;
    },
  );

  // Write a task file. Body size capped at 1 MB; on the leader the
  // underlying TasksRepo.writeFile is the BEGIN IMMEDIATE transaction
  // that also re-derives `tasks.current_phase` (the §6 atomicity invariant).
  // On a follower this PUT relays to the leader.
  app.put<{
    Params: { slug: string; taskId: string; filename: string };
    Body: { content: string };
  }>(
    '/api/projects/:slug/tasks/:taskId/files/:filename',
    { preHandler: guard },
    async (req, reply) => {
      const content = typeof req.body?.content === 'string' ? req.body.content : null;
      if (content === null) {
        return reply.code(400).send({ error: 'body.content (string) required' });
      }
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      if (sizeBytes > TASK_FILE_MAX_BYTES) {
        return reply
          .code(413)
          .send({ error: 'task file exceeds 1 MB limit', sizeBytes });
      }
      const updatedBy = req.user?.username ?? null;
      try {
        const result = await storage.writeTaskFile(
          req.params.slug,
          req.params.taskId,
          req.params.filename,
          content,
          updatedBy,
        );
        if (!result) return reply.code(404).send({ error: 'task not found' });
        broadcast('task.updated', {
          project: req.params.slug,
          taskId: req.params.taskId,
          filename: req.params.filename,
          phase: result.phase,
          sizeBytes: result.sizeBytes,
        });
        return { ok: true, sizeBytes: result.sizeBytes };
      } catch (err) {
        if (err instanceof RangeError) {
          return reply.code(413).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { slug: string; taskId: string; filename: string } }>(
    '/api/projects/:slug/tasks/:taskId/files/:filename',
    { preHandler: guard },
    async (req, reply) => {
      const result = await storage.deleteTaskFile(
        req.params.slug,
        req.params.taskId,
        req.params.filename,
      );
      if (!result) return reply.code(404).send({ error: 'task not found' });
      broadcast('task.updated', {
        project: req.params.slug,
        taskId: req.params.taskId,
        filename: req.params.filename,
        phase: result.phase,
        deleted: true,
      });
      return { ok: true };
    },
  );

  // --- dispatches (T3.3) ------------------------------------------------
  // Paginated list with optional filters. On the leader this hits
  // `dispatches_by_state` directly; on a follower it relays to the leader.
  app.get<{
    Querystring: { state?: string; projectSlug?: string; taskId?: string; limit?: string };
  }>('/api/dispatches', { preHandler: guard }, async (req, reply) => {
    const validStates: ReadonlySet<DispatchState> = new Set([
      'pending', 'taken', 'done', 'failed', 'poisoned',
    ]);
    let state: DispatchState | undefined;
    if (req.query.state) {
      if (!validStates.has(req.query.state as DispatchState)) {
        return reply.code(400).send({ error: `invalid state "${req.query.state}"` });
      }
      state = req.query.state as DispatchState;
    }
    let limit: number | undefined;
    if (req.query.limit !== undefined) {
      const parsed = Number.parseInt(req.query.limit, 10);
      limit = Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
    }
    return storage.listDispatches({
      state,
      projectSlug: req.query.projectSlug,
      taskId: req.query.taskId,
      limit,
    });
  });

  // Followers' claimable list. `agentIds=horus,anubis` filters to those
  // ids; required (returning [] when absent matches the worker's
  // expectations — they always pass their own ids).
  app.get<{ Querystring: { agentIds?: string } }>(
    '/api/dispatches/pending',
    { preHandler: guard },
    async (req) => {
      const ids = (req.query.agentIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return storage.listPendingDispatches(ids);
    },
  );

  // Dispatch detail.
  app.get<{ Params: { id: string } }>(
    '/api/dispatches/:id',
    { preHandler: guard },
    async (req, reply) => {
      const row = await storage.readDispatchById(req.params.id);
      if (!row) return reply.code(404).send({ error: 'unknown dispatch' });
      return row;
    },
  );

  // Atomic claim — the linearization point per §4 lines 500-515.
  // Status code distinction matters: 200 win / 404 unknown / 410 terminal /
  // 409 already-taken. Operators rely on this.
  app.post<{ Params: { id: string }; Body: { claimedBy?: string } }>(
    '/api/dispatches/:id/claim',
    { preHandler: guard },
    async (req, reply) => {
      const claimedBy =
        asString(req.body?.claimedBy) ??
        req.user?.username ??
        'unknown';
      const result = await storage.claimDispatch(req.params.id, claimedBy);
      switch (result.outcome) {
        case 'claimed': {
          const dispatch = result.dispatch!;
          broadcast('dispatch.taken', {
            dispatchId: dispatch.id,
            agent: dispatch.agentId,
            claimedBy,
          });
          return dispatch;
        }
        case 'unknown':
          return reply.code(404).send({ error: 'unknown dispatch' });
        case 'terminal':
          return reply.code(410).send({ error: 'already terminal', state: result.state });
        case 'taken':
          return reply.code(409).send({ error: 'already taken', claimedBy: result.claimedBy });
      }
    },
  );

  // Worker-reports-completion. The poison policy lives server-side in
  // DispatchRepo.markDone (defect-C fix). Returns the new state row.
  app.post<{
    Params: { id: string };
    Body: { exitCode: number | null; durationMs: number; stderrSnippet?: string };
  }>(
    '/api/dispatches/:id/done',
    { preHandler: guard },
    async (req, reply) => {
      const exitCode =
        typeof req.body?.exitCode === 'number' || req.body?.exitCode === null
          ? req.body.exitCode
          : null;
      const durationMs =
        typeof req.body?.durationMs === 'number' && Number.isFinite(req.body.durationMs)
          ? req.body.durationMs
          : 0;
      const stderrSnippet = asString(req.body?.stderrSnippet) ?? null;
      try {
        const final = await storage.markDispatchDone(req.params.id, {
          exitCode,
          durationMs,
          stderrSnippet,
        });
        broadcast(`dispatch.${final.state}`, {
          dispatchId: final.id,
          ok: final.state === 'done',
          exitCode,
          durationMs,
          terminal: isTerminalState(final.state),
        });
        return final;
      } catch (err) {
        // Typed errors → typed HTTP status codes. The repo (and the
        // follower-side relay in storage.ts) throw compile-time-pinned
        // errors so a future refactor of the message strings can never
        // silently degrade us to 500.
        if (err instanceof UnknownDispatchError) {
          return reply.code(404).send({ error: 'unknown dispatch' });
        }
        if (err instanceof DispatchStateError) {
          return reply
            .code(409)
            .send({ error: `cannot complete from state=${err.state}`, state: err.state });
        }
        throw err;
      }
    },
  );

  // Append an audit-log row for a dispatch. The leader's own invoker writes
  // directly via DispatchRepo.appendLog; this route exists for the follower
  // hop and for any other client posting cross-machine log lines. On a
  // follower the storage facade relays to the leader.
  app.post<{
    Params: { id: string };
    Body: { message?: unknown; level?: unknown; host?: unknown };
  }>(
    '/api/dispatches/:id/log',
    { preHandler: guard },
    async (req, reply) => {
      const message = asString(req.body?.message);
      if (!message) {
        return reply.code(400).send({ error: 'body.message (string) required' });
      }
      const validLevels = new Set(['info', 'warn', 'error']);
      const rawLevel = req.body?.level;
      let level: 'info' | 'warn' | 'error' = 'info';
      if (rawLevel !== undefined && rawLevel !== null) {
        if (typeof rawLevel !== 'string' || !validLevels.has(rawLevel)) {
          return reply.code(400).send({ error: `invalid level "${String(rawLevel)}"` });
        }
        level = rawLevel as 'info' | 'warn' | 'error';
      }
      const host = typeof req.body?.host === 'string' ? req.body.host : undefined;
      const result = await storage.appendDispatchLog(req.params.id, message, level, host);
      if (!result) return reply.code(404).send({ error: 'unknown dispatch' });
      return result;
    },
  );

  // --- agents -----------------------------------------------------------
  app.get('/api/agents', { preHandler: guard }, async () => storage.listAgentsList());

  // POST /api/agents/:id/harness/sync — TASK_2026_002 B3.
  //
  // Re-reads the persona's harness.yaml from shared memory, computes the
  // sha256 hash, and publishes a `harness/sync` event so the bot-bridge
  // hot-reloads that agent. Leader-only: followers return 405 because the
  // shared-memory read goes through `storage.readMemory`, which would relay
  // back to the leader anyway — having the leader own the publish keeps
  // the broadcast topology a single hop.
  //
  // Auth: `guard` (cookie-JWT or internal-token bearer). The bot-bridge,
  // dispatched agents, or an operator-driven curl can all reach this.
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/harness/sync',
    { preHandler: guard },
    async (req, reply) => {
      if (!config.leader) {
        return reply
          .code(405)
          .send({ error: 'harness/sync is leader-only — POST to OPENCLAW_LEADER_URL instead' });
      }
      const agentId = req.params.id;
      const r = await storage.readMemory('agents', agentId, 'harness.yaml');
      if (!r) return reply.code(404).send({ error: 'harness.yaml not found' });
      const hash = harnessHash(r.content);
      await publishHarnessSync({ agentId, harnessHash: hash });
      return { ok: true, agentId, harnessHash: hash };
    },
  );

  // --- sessions ---------------------------------------------------------
  app.get('/api/sessions', { preHandler: guard }, async () => listSessions());

  app.get<{ Querystring: { lines?: string }; Params: { projectKey: string } }>(
    '/api/sessions/:projectKey/latest',
    { preHandler: guard },
    async (req, reply) => {
      const sess = await newestSessionForProject(req.params.projectKey);
      if (!sess) return reply.code(404).send({ error: 'no session' });
      const events = await tailSession(sess.filePath, Number(req.query.lines ?? 50));
      return { session: sess, events };
    },
  );

  // --- memories (T3.5) --------------------------------------------------
  // GET list per scope — already filtered server-side, no per-file gate.
  app.get<{ Params: { scope: MemoryScope } }>(
    '/api/memories/:scope',
    { preHandler: guard },
    async (req) => storage.listMemoryScope(req.params.scope),
  );

  // GET single file. Persona privacy gate FIRST: scope=agents +
  // PRIVATE_AGENT_FILES → 404 (NOT 403, deliberately, to avoid leaking the
  // existence of a persona) before any DB call.
  app.get<{ Params: { scope: MemoryScope; id: string; file: string } }>(
    '/api/memories/:scope/:id/:file',
    { preHandler: guard },
    async (req, reply) => {
      const { scope, id, file } = req.params;
      if (scope === 'agents' && PRIVATE_AGENT_FILES.has(file)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const r = await storage.readMemory(scope, id, file);
      if (r == null) return reply.code(404).send({ error: 'not found' });
      return r;
    },
  );

  // PUT — gate FIRST: scope=agents + PRIVATE_AGENT_FILES → 403, before any
  // DB call. The underlying writeMemoryFile chokepoint in memory.ts is
  // defense-in-depth on top of this gate.
  app.put<{
    Params: { scope: MemoryScope; id: string; file: string };
    Body: { content: string };
  }>('/api/memories/:scope/:id/:file', { preHandler: guard }, async (req, reply) => {
    const { scope, id, file } = req.params;
    if (scope === 'agents' && PRIVATE_AGENT_FILES.has(file)) {
      return reply
        .code(403)
        .send({ error: 'private agent files cannot be sent over the network' });
    }
    try {
      const updatedBy = req.user?.username ?? null;
      // Internal-token callers (follower→leader forwards, bot-bridge,
      // dispatched agents) bypass per-machine ownership: the token IS the
      // fleet trust boundary. JWT browser users still get the check.
      const skipOwnership = req.user?.username === 'service:internal';
      const r = await storage.writeMemory(scope, id, file, req.body.content, updatedBy, {
        skipOwnership,
      });
      broadcast('memory.updated', { scope, id, file, private: r.private });
      return { ok: true, private: r.private };
    } catch (err) {
      if (err instanceof MemoryError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : 'write failed';
      return reply.code(400).send({ error: message });
    }
  });

  // DELETE — same gate as PUT.
  app.delete<{ Params: { scope: MemoryScope; id: string; file: string } }>(
    '/api/memories/:scope/:id/:file',
    { preHandler: guard },
    async (req, reply) => {
      const { scope, id, file } = req.params;
      if (scope === 'agents' && PRIVATE_AGENT_FILES.has(file)) {
        return reply
          .code(403)
          .send({ error: 'private agent files cannot be sent over the network' });
      }
      try {
        const skipOwnership = req.user?.username === 'service:internal';
        await storage.deleteMemory(scope, id, file, { skipOwnership });
        broadcast('memory.updated', { scope, id, file, deleted: true });
        return { ok: true };
      } catch (err) {
        if (err instanceof MemoryError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        const message = err instanceof Error ? err.message : 'delete failed';
        return reply.code(400).send({ error: message });
      }
    },
  );

  // POST /api/sse/emit — TASK_2026_002 B6 forwarded sub-task #14.
  //
  // The bot-bridge's `daemonClient.emitSseHint` POSTs chat-tier observability
  // hints here so they surface on `/api/stream`. The event name is gated by
  // SSE_EMIT_ALLOWED_EVENTS — any name not on the allowlist is rejected
  // with 400 (not silently dropped) so a typo or a misbehaving caller is
  // easy to spot in operator logs.
  //
  // Per-event payload validation: every allowed event must carry a plain
  // object payload. The schema-per-event is intentionally light — these
  // are observability hints, not a control surface — but we DO require
  // the canonical `taskId` / `agentId` / `name` fields when present so
  // downstream SSE consumers (the dashboard) get a stable shape.
  app.post<{ Body: { event: string; data: unknown } }>(
    '/api/sse/emit',
    { preHandler: guard },
    async (req, reply) => {
      const event =
        typeof req.body?.event === 'string' && req.body.event.length > 0
          ? req.body.event
          : null;
      if (!event) return reply.code(400).send({ error: 'body.event (string) required' });
      if (!SSE_EMIT_ALLOWED_EVENTS.has(event)) {
        return reply.code(400).send({
          error: `event "${event}" is not on the SSE_EMIT_ALLOWED_EVENTS allowlist`,
          allowed: [...SSE_EMIT_ALLOWED_EVENTS].sort(),
        });
      }
      const data = req.body?.data ?? null;
      // Per-event payload schema. Light-touch — strings/numbers only,
      // optional fields. Anything else is rejected so the dashboard's
      // typed event consumers don't get surprises.
      if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
        return reply
          .code(400)
          .send({ error: 'data must be an object or null' });
      }
      const obj = (data ?? {}) as Record<string, unknown>;
      const stringOpt = (k: string): boolean =>
        obj[k] === undefined || typeof obj[k] === 'string';
      const numberOpt = (k: string): boolean =>
        obj[k] === undefined || typeof obj[k] === 'number';
      const boolOpt = (k: string): boolean =>
        obj[k] === undefined || typeof obj[k] === 'boolean';
      switch (event) {
        case 'invoker.tool_call':
          // { taskId?, agentId?, name?, ok?, durationMs? }
          if (!stringOpt('taskId') || !stringOpt('agentId') || !stringOpt('name')) {
            return reply.code(400).send({ error: 'invoker.tool_call: taskId/agentId/name must be strings if set' });
          }
          if (!boolOpt('ok')) {
            return reply.code(400).send({ error: 'invoker.tool_call: ok must be a boolean if set' });
          }
          if (!numberOpt('durationMs')) {
            return reply.code(400).send({ error: 'invoker.tool_call: durationMs must be a number if set' });
          }
          break;
        case 'invoker.subagent_started':
        case 'invoker.subagent_finished':
          if (!stringOpt('agentId') || !stringOpt('name') || !stringOpt('parent')) {
            return reply.code(400).send({ error: `${event}: agentId/name/parent must be strings if set` });
          }
          if (!boolOpt('ok') || !numberOpt('durationMs')) {
            return reply.code(400).send({ error: `${event}: ok/durationMs typecheck failed` });
          }
          break;
        case 'mcp.server_failed':
          if (!stringOpt('agentId') || !stringOpt('serverId') || !stringOpt('error')) {
            return reply.code(400).send({ error: 'mcp.server_failed: agentId/serverId/error must be strings if set' });
          }
          break;
        case 'harness.materialized':
          if (!stringOpt('agentId') || !stringOpt('settingsPath') || !stringOpt('pluginDir')) {
            return reply.code(400).send({ error: 'harness.materialized: path fields must be strings if set' });
          }
          if (!boolOpt('changed')) {
            return reply.code(400).send({ error: 'harness.materialized: changed must be a boolean if set' });
          }
          break;
        case 'harness.synced':
          if (!stringOpt('agentId') || !stringOpt('source')) {
            return reply.code(400).send({ error: 'harness.synced: agentId/source must be strings if set' });
          }
          break;
      }
      broadcast(event, data);
      return { ok: true };
    },
  );

  // --- project files (TASK_2026_002 B6 sub-task 8) ----------------------
  // Generic file IO inside a project's workspace tree. The harness-authoring
  // chat (B7) writes `.claude/harness.yaml` through these endpoints; any
  // future caller that needs to write inside the project workspace gets the
  // same path-validation + 1 MB cap.
  //
  // Leader-only: the workspace path comes from `Project.path` resolved on
  // the leader. Followers don't have access to the project FS so they 405.
  // The harness-authoring chat runs in bot-bridge which talks to the
  // LEADER (config.daemonUrl), not a follower, so this is the right shape.

  app.get<{
    Params: { slug: string };
    Querystring: { path?: string; prefix?: string };
  }>('/api/projects/:slug/files', { preHandler: guard }, async (req, reply) => {
    if (!config.leader) {
      return reply
        .code(405)
        .send({ error: 'project files are leader-only — POST to OPENCLAW_LEADER_URL instead' });
    }
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!project.path.startsWith('/')) {
      return reply
        .code(409)
        .send({ error: `project "${project.slug}" has no resolved workspace path` });
    }

    // Single-file read.
    if (typeof req.query.path === 'string') {
      const validated = safeProjectPath(project.path, req.query.path);
      if (typeof validated !== 'string') {
        return reply.code(400).send({ error: validated.error });
      }
      try {
        const stat = await fsp.stat(validated);
        if (!stat.isFile()) {
          return reply.code(404).send({ error: 'not a regular file' });
        }
        if (stat.size > PROJECT_FILE_MAX_BYTES) {
          return reply.code(413).send({
            error: `file exceeds ${PROJECT_FILE_MAX_BYTES} byte cap`,
            sizeBytes: stat.size,
          });
        }
        const content = await fsp.readFile(validated, 'utf8');
        return {
          content,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return reply.code(404).send({ error: 'not found' });
        }
        throw err;
      }
    }

    // Prefix listing.
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    let prefixRoot: string;
    if (prefix.length === 0) {
      prefixRoot = path.resolve(project.path);
    } else {
      const validated = safeProjectPath(project.path, prefix);
      if (typeof validated !== 'string') {
        return reply.code(400).send({ error: validated.error });
      }
      prefixRoot = validated;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(prefixRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return reply.code(404).send({ error: 'prefix not found' });
      }
      throw err;
    }
    const out: Array<{ path: string; size: number; mtime: string }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = path.join(prefixRoot, e.name);
      const stat = await fsp.stat(abs);
      const rel = path.relative(project.path, abs);
      out.push({
        path: rel,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  });

  app.post<{
    Params: { slug: string };
    Body: { path: string; content: string };
  }>('/api/projects/:slug/files', { preHandler: guard }, async (req, reply) => {
    if (!config.leader) {
      return reply
        .code(405)
        .send({ error: 'project files are leader-only — POST to OPENCLAW_LEADER_URL instead' });
    }
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!project.path.startsWith('/')) {
      return reply
        .code(409)
        .send({ error: `project "${project.slug}" has no resolved workspace path` });
    }
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (content === null) {
      return reply.code(400).send({ error: 'body.content (string) required' });
    }
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > PROJECT_FILE_MAX_BYTES) {
      return reply
        .code(413)
        .send({ error: `file exceeds ${PROJECT_FILE_MAX_BYTES} byte cap`, sizeBytes });
    }
    const validated = safeProjectPath(project.path, req.body?.path);
    if (typeof validated !== 'string') {
      return reply.code(400).send({ error: validated.error });
    }
    await fsp.mkdir(path.dirname(validated), { recursive: true });
    await fsp.writeFile(validated, content, 'utf8');
    broadcast('project.file_written', {
      project: project.slug,
      path: req.body!.path,
      sizeBytes,
    });
    return { ok: true, sizeBytes };
  });

  app.delete<{
    Params: { slug: string };
    Querystring: { path?: string };
  }>('/api/projects/:slug/files', { preHandler: guard }, async (req, reply) => {
    if (!config.leader) {
      return reply
        .code(405)
        .send({ error: 'project files are leader-only — POST to OPENCLAW_LEADER_URL instead' });
    }
    const project = await storage.readProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!project.path.startsWith('/')) {
      return reply
        .code(409)
        .send({ error: `project "${project.slug}" has no resolved workspace path` });
    }
    const validated = safeProjectPath(project.path, req.query.path);
    if (typeof validated !== 'string') {
      return reply.code(400).send({ error: validated.error });
    }
    try {
      await fsp.unlink(validated);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return reply.code(404).send({ error: 'not found' });
      }
      throw err;
    }
    broadcast('project.file_deleted', {
      project: project.slug,
      path: req.query.path,
    });
    return { ok: true };
  });

  // --- harness materialize endpoints (TASK_2026_002 B6 sub-task 8) ------
  // Operator/diagnostic surface for re-materializing per-agent ptah scope.
  // Both leader-only — followers 405. The Redis `harness/sync` event is
  // the preferred trigger; these endpoints exist for "I just edited the
  // row, want it on disk RIGHT NOW" + tests.

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/harness/materialize',
    { preHandler: guard },
    async (req, reply) => {
      if (!config.leader) {
        return reply
          .code(405)
          .send({ error: 'harness/materialize is leader-only — POST to OPENCLAW_LEADER_URL instead' });
      }
      try {
        const result = await materializeAgent(req.params.id);
        broadcast('harness.materialized', {
          agentId: result.agentId,
          changed: result.changed,
          settingsPath: result.settingsPath,
          pluginDir: result.pluginDir,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'materialize failed';
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.post(
    '/api/harness/materialize',
    { preHandler: guard },
    async (req, reply) => {
      if (!config.leader) {
        return reply
          .code(405)
          .send({ error: 'harness/materialize is leader-only — POST to OPENCLAW_LEADER_URL instead' });
      }
      const results = await materializeAll();
      for (const r of results) {
        broadcast('harness.materialized', {
          agentId: r.agentId,
          changed: r.changed,
          settingsPath: r.settingsPath,
          pluginDir: r.pluginDir,
        });
      }
      return results;
    },
  );

  // --- SSE stream -------------------------------------------------------
  // Optional `?topics=dispatch,task` filters which event prefixes the
  // client receives. Followers subscribe with `topics=dispatch` to get
  // dispatch.* events for the push-notification path.
  app.get<{ Querystring: { topics?: string } }>('/api/stream', async (req, reply) => {
    const topics = (req.query.topics ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    attachSse(reply, topics);
    return reply;
  });

  // --- static dashboard -------------------------------------------------
  if (fs.existsSync(config.dashboardDir)) {
    app.register(staticPlugin, { root: config.dashboardDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
