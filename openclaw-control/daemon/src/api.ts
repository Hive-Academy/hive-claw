import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.js';
import { discoverProjects, getProject } from './projects.js';
import { listTasks, readTask, readTaskArtifacts, type Phase } from './phase.js';
import { listAgents } from './agents.js';
import { listSessions, tailSession, newestSessionForProject } from './sessions.js';
import { attachSse, broadcast } from './sse.js';
import { registerAuth, requireAuth } from './auth.js';
import {
  listScope,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  type MemoryScope,
} from './memory.js';
import {
  createTask,
  recordApproval,
  tickOnce,
} from './continuation.js';
import { publishHandoff } from './bus.js';
import {
  DispatchRepo,
  TasksRepo,
  PRIVATE_AGENT_FILES,
  isTerminalState,
  getReadOnlyDb,
  type Dispatch,
  type DispatchState,
} from './db/index.js';
import * as leaderClient from './leaderClient.js';

const TASK_FILE_MAX_BYTES = 1 * 1024 * 1024; // 1 MB — matches TasksRepo.writeFile

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

  const guard = async (req: any, reply: any) => {
    const u = await requireAuth(req, reply);
    if (!u) return reply;
    req.user = u;
  };

  // --- projects / tasks --------------------------------------------------
  app.get('/api/projects', { preHandler: guard }, async () => {
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
  });

  app.get<{ Params: { slug: string } }>(
    '/api/projects/:slug/tasks',
    { preHandler: guard },
    async (req, reply) => {
      const project = await getProject(req.params.slug);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return listTasks(project);
    },
  );

  app.get<{ Params: { slug: string; taskId: string } }>(
    '/api/projects/:slug/tasks/:taskId',
    { preHandler: guard },
    async (req, reply) => {
      const project = await getProject(req.params.slug);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const summary = await readTask(project, req.params.taskId);
      if (!summary) return reply.code(404).send({ error: 'task not found' });
      const artifacts = await readTaskArtifacts(project, req.params.taskId);
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
    return createTask({ projectSlug: slug, description, taskType, agentId, discordUserId, channelId });
  });

  app.post<{
    Params: { slug: string; taskId: string };
    Body: { phase: Phase; decision: 'APPROVED' | 'REJECTED'; feedback?: string };
  }>('/api/projects/:slug/tasks/:taskId/approve', { preHandler: guard }, async (req, reply) => {
    const project = await getProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const ok = await recordApproval(
      project,
      req.params.taskId,
      req.body.phase,
      (req as any).user?.username ?? 'unknown',
      req.body.feedback,
    );
    if (!ok) return reply.code(404).send({ error: 'task not found' });
    return { ok: true };
  });

  app.post<{
    Params: { slug: string; taskId: string };
    Body: { toAgent: string; reason?: string };
  }>('/api/projects/:slug/tasks/:taskId/handoff', { preHandler: guard }, async (req, reply) => {
    const project = await getProject(req.params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const summary = await readTask(project, req.params.taskId);
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

  app.post('/api/continuation/tick', { preHandler: guard }, async () => tickOnce());

  // --- task files (T3.2) ------------------------------------------------
  // List files for a task. Returns metadata only — no body.
  app.get<{ Params: { slug: string; taskId: string } }>(
    '/api/projects/:slug/tasks/:taskId/files',
    { preHandler: guard },
    async (req, reply) => {
      const task = TasksRepo.get(req.params.slug, req.params.taskId);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const files = TasksRepo.listFiles(req.params.slug, req.params.taskId);
      return files.map((f) => ({
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        updatedAt: f.updatedAt,
      }));
    },
  );

  // Read a single task file. 404 when the row is absent.
  app.get<{ Params: { slug: string; taskId: string; filename: string } }>(
    '/api/projects/:slug/tasks/:taskId/files/:filename',
    { preHandler: guard },
    async (req, reply) => {
      const file = TasksRepo.readFile(
        req.params.slug,
        req.params.taskId,
        req.params.filename,
      );
      if (!file) return reply.code(404).send({ error: 'file not found' });
      return {
        content: file.content,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        updatedAt: file.updatedAt,
      };
    },
  );

  // Write a task file. Body size capped at 1 MB; the underlying
  // TasksRepo.writeFile is the BEGIN IMMEDIATE transaction that also
  // re-derives `tasks.current_phase` (the §6 atomicity invariant).
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
      const task = TasksRepo.get(req.params.slug, req.params.taskId);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const updatedBy = (req as any).user?.username ?? null;
      try {
        const result = TasksRepo.writeFile(
          req.params.slug,
          req.params.taskId,
          req.params.filename,
          content,
          updatedBy,
        );
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
      const task = TasksRepo.get(req.params.slug, req.params.taskId);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const result = TasksRepo.deleteFile(
        req.params.slug,
        req.params.taskId,
        req.params.filename,
      );
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
  // Paginated list with optional filters. Uses `dispatches_by_state` index
  // when filtered by state.
  app.get<{
    Querystring: { state?: string; projectSlug?: string; taskId?: string; limit?: string };
  }>('/api/dispatches', { preHandler: guard }, async (req, reply) => {
    const validStates: ReadonlySet<DispatchState> = new Set([
      'pending', 'taken', 'done', 'failed', 'poisoned',
    ]);
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.state) {
      if (!validStates.has(req.query.state as DispatchState)) {
        return reply.code(400).send({ error: `invalid state "${req.query.state}"` });
      }
      where.push('state = ?');
      params.push(req.query.state);
    }
    if (req.query.projectSlug) {
      where.push('project_slug = ?');
      params.push(req.query.projectSlug);
    }
    if (req.query.taskId) {
      where.push('task_id = ?');
      params.push(req.query.taskId);
    }
    let limit = Number.parseInt(req.query.limit ?? '50', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 500) limit = 500;
    const sql = `
      SELECT * FROM dispatches
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = getReadOnlyDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rawRowToDispatch);
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
      const rows = DispatchRepo.listPendingForAgents(ids);
      return rows.map((d) => ({
        id: d.id,
        projectSlug: d.projectSlug,
        taskId: d.taskId,
        phase: d.phase,
        agentId: d.agentId,
        createdAt: d.createdAt,
      }));
    },
  );

  // Dispatch detail.
  app.get<{ Params: { id: string } }>(
    '/api/dispatches/:id',
    { preHandler: guard },
    async (req, reply) => {
      const row = DispatchRepo.getById(req.params.id);
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
        ((req as any).user?.username as string | undefined) ??
        'unknown';
      const dispatch = DispatchRepo.claim(req.params.id, claimedBy);
      if (!dispatch) {
        const cur = DispatchRepo.getById(req.params.id);
        if (!cur) return reply.code(404).send({ error: 'unknown dispatch' });
        if (isTerminalState(cur.state)) {
          return reply.code(410).send({ error: 'already terminal', state: cur.state });
        }
        // cur.state must be 'taken' here (it can't be 'pending', or claim
        // would have succeeded).
        return reply.code(409).send({ error: 'already taken', claimedBy: cur.claimedBy });
      }
      broadcast('dispatch.taken', {
        dispatchId: dispatch.id,
        agent: dispatch.agentId,
        claimedBy,
      });
      return dispatch;
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
        const final = DispatchRepo.markDone(req.params.id, {
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
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('markDone: unknown dispatch')) {
          return reply.code(404).send({ error: 'unknown dispatch' });
        }
        if (msg.startsWith('markDone: cannot complete from state=')) {
          return reply.code(409).send({ error: msg.replace('markDone: ', '') });
        }
        throw err;
      }
    },
  );

  // Append an audit-log row for a dispatch. Followers post here via
  // leaderClient.appendLog so mid-invocation log lines land in the leader's
  // dispatch_log table (cross-machine traceability replacing the old
  // .invoker/*.log + git audit). The leader's own invoker writes directly
  // via DispatchRepo.appendLog; this route exists for the follower hop.
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
      const dispatch = DispatchRepo.getById(req.params.id);
      if (!dispatch) return reply.code(404).send({ error: 'unknown dispatch' });
      const host = typeof req.body?.host === 'string' ? req.body.host : undefined;
      DispatchRepo.appendLog(req.params.id, message, level, host);
      return { ok: true };
    },
  );

  // --- agents -----------------------------------------------------------
  app.get('/api/agents', { preHandler: guard }, async () => listAgents());

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
    async (req) => listScope(req.params.scope),
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
      const r = await readMemoryFile(scope, id, file);
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
      const updatedBy = (req as any).user?.username ?? null;
      const r = await writeMemoryFile(scope, id, file, req.body.content, updatedBy);
      broadcast('memory.updated', { scope, id, file, private: r.private });
      return { ok: true, private: r.private };
    } catch (err: any) {
      const code = err?.statusCode ?? 400;
      return reply.code(code).send({ error: err?.message ?? 'write failed' });
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
        await deleteMemoryFile(scope, id, file);
        broadcast('memory.updated', { scope, id, file, deleted: true });
        return { ok: true };
      } catch (err: any) {
        const code = err?.statusCode ?? 400;
        return reply.code(code).send({ error: err?.message ?? 'delete failed' });
      }
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

/**
 * Convert a raw dispatches row (snake_case columns) to the typed Dispatch
 * shape exposed by the API. Mirrors the toDispatch in db/dispatches.ts but
 * lives here because the listing route builds dynamic SQL for filters
 * rather than reusing DispatchRepo's prepared statements.
 */
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
    exitCode: raw.exit_code === null || raw.exit_code === undefined ? null : Number(raw.exit_code),
    durationMs:
      raw.duration_ms === null || raw.duration_ms === undefined ? null : Number(raw.duration_ms),
    stderrSnippet:
      raw.stderr_snippet === null || raw.stderr_snippet === undefined
        ? null
        : String(raw.stderr_snippet),
    createdBy: String(raw.created_by),
    claimedBy: raw.claimed_by === null || raw.claimed_by === undefined ? null : String(raw.claimed_by),
    createdAt: String(raw.created_at),
    claimedAt: raw.claimed_at === null || raw.claimed_at === undefined ? null : String(raw.claimed_at),
    completedAt:
      raw.completed_at === null || raw.completed_at === undefined ? null : String(raw.completed_at),
  };
}
