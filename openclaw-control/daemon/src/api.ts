import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { discoverProjects, getProject } from './projects.js';
import { listTasks, readTask, readTaskArtifacts, type Phase } from './phase.js';
import { listAgents } from './agents.js';
import { listSessions, tailSession, newestSessionForProject } from './sessions.js';
import { attachSse } from './sse.js';
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

export function buildApp() {
  const app = Fastify({ logger: { level: 'info' } });
  app.register(cors, { origin: true, credentials: true });
  app.register(cookie);
  app.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: config.cookieName, signed: false },
  });

  app.get('/api/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    leader: config.leader,
    localAgentIds: config.localAgentIds,
    gitEnabled: config.git.enabled,
  }));

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

  // --- memories ---------------------------------------------------------
  app.get<{ Params: { scope: MemoryScope } }>(
    '/api/memories/:scope',
    { preHandler: guard },
    async (req) => listScope(req.params.scope),
  );

  app.get<{ Params: { scope: MemoryScope; id: string; file: string } }>(
    '/api/memories/:scope/:id/:file',
    { preHandler: guard },
    async (req, reply) => {
      const r = await readMemoryFile(req.params.scope, req.params.id, req.params.file);
      if (r == null) return reply.code(404).send({ error: 'not found' });
      return r;
    },
  );

  app.put<{
    Params: { scope: MemoryScope; id: string; file: string };
    Body: { content: string };
  }>('/api/memories/:scope/:id/:file', { preHandler: guard }, async (req, reply) => {
    try {
      const r = await writeMemoryFile(
        req.params.scope,
        req.params.id,
        req.params.file,
        req.body.content,
      );
      return { ok: true, private: r.private };
    } catch (err: any) {
      const code = (err as any)?.statusCode ?? 400;
      return reply.code(code).send({ error: err.message });
    }
  });

  app.delete<{ Params: { scope: MemoryScope; id: string; file: string } }>(
    '/api/memories/:scope/:id/:file',
    { preHandler: guard },
    async (req, reply) => {
      try {
        await deleteMemoryFile(req.params.scope, req.params.id, req.params.file);
        return { ok: true };
      } catch (err: any) {
        const code = (err as any)?.statusCode ?? 400;
        return reply.code(code).send({ error: err.message });
      }
    },
  );

  // --- SSE stream -------------------------------------------------------
  app.get('/api/stream', async (req, reply) => {
    attachSse(reply);
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
