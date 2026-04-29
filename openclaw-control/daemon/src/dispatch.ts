import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { commitAndPush, atomicRenameAndPush, pullOnce } from './gitSync.js';
import { broadcast } from './sse.js';
import { publishNotify } from './bus.js';
import { invokeClaudeForTask } from './invoker.js';
import { listProjects, getProject } from './projects.js';
import { readTask } from './phase.js';

export interface Dispatch {
  id: string;
  agent: string;
  project: string;
  taskId: string;
  phase: string;
  prompt: string;
  createdAt: string;
  createdBy: string;
}

function dispatchDir(projectSlug: string, taskId: string): string {
  return path.join(config.specsDir, projectSlug, taskId, '.dispatch');
}

function dispatchRel(projectSlug: string, taskId: string, kind: 'pending' | 'taken' | 'done', id: string): string {
  return path.posix.join('specs', projectSlug, taskId, '.dispatch', kind, `${id}.json`);
}

export async function writePendingDispatch(d: Omit<Dispatch, 'id' | 'createdAt' | 'createdBy'>): Promise<string> {
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const full: Dispatch = {
    ...d,
    id,
    createdAt: new Date().toISOString(),
    createdBy: process.env.HOSTNAME ?? 'leader',
  };
  await commitAndPush(`dispatch: ${d.agent} ← ${d.taskId} (${d.phase})`, async () => {
    const dir = path.join(dispatchDir(d.project, d.taskId), 'pending');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), 'utf8');
  });
  broadcast('dispatch.pending', { dispatchId: id, ...full });
  return id;
}

async function listPendingForLocalAgents(): Promise<{ rel: string; data: Dispatch }[]> {
  const result: { rel: string; data: Dispatch }[] = [];
  let projects: string[];
  try {
    projects = (await fs.readdir(config.specsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }
  for (const proj of projects) {
    const projDir = path.join(config.specsDir, proj);
    let tasks: string[] = [];
    try {
      tasks = (await fs.readdir(projDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^TASK_\d{4}_\d{3}$/.test(e.name))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const taskId of tasks) {
      const pending = path.join(dispatchDir(proj, taskId), 'pending');
      let files: string[] = [];
      try {
        files = await fs.readdir(pending);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(pending, f), 'utf8');
          const data = JSON.parse(raw) as Dispatch;
          if (config.localAgentIds.length === 0 || config.localAgentIds.includes(data.agent)) {
            result.push({
              rel: dispatchRel(proj, taskId, 'pending', data.id),
              data,
            });
          }
        } catch {}
      }
    }
  }
  return result;
}

export async function processOneDispatch(): Promise<{ processed: boolean; dispatchId?: string }> {
  if (config.localAgentIds.length === 0) return { processed: false };

  await pullOnce();
  const pending = await listPendingForLocalAgents();
  if (pending.length === 0) return { processed: false };

  const next = pending[0];
  const takenRel = dispatchRel(next.data.project, next.data.taskId, 'taken', next.data.id);

  const won = await atomicRenameAndPush(
    next.rel,
    takenRel,
    `dispatch-take: ${next.data.agent} → ${next.data.taskId}`,
  ).catch(() => false);

  if (!won) return { processed: false };

  broadcast('dispatch.taken', { dispatchId: next.data.id, agent: next.data.agent });

  const project = await getProject(next.data.project);
  if (!project) return { processed: false, dispatchId: next.data.id };
  const task = await readTask(project, next.data.taskId);
  if (!task) return { processed: false, dispatchId: next.data.id };

  if (task.channelId) {
    await publishNotify({
      agentId: next.data.agent,
      channelId: task.channelId,
      text: `🛠 picked up **${next.data.taskId}** (phase: **${next.data.phase}**) — running via ptah-cli, will report when done.`,
    }).catch((err) => console.warn('[dispatch] notify (taken) failed', err));
  }

  const result = await invokeClaudeForTask({
    project,
    task,
    agentId: next.data.agent,
    prompt: next.data.prompt,
  });

  if (task.channelId) {
    const status = result.ok
      ? '✅ done'
      : result.exitCode === null
        ? '⚠️ no exit code (invocation may not have run)'
        : `❌ failed (exit=${result.exitCode})`;
    await publishNotify({
      agentId: next.data.agent,
      channelId: task.channelId,
      text: `${status} **${next.data.taskId}** (phase: **${next.data.phase}**) — ${result.durationMs}ms`,
    }).catch((err) => console.warn('[dispatch] notify (done) failed', err));
  }

  // After the invocation, commit any artifact changes the agent made and move
  // the dispatch to .done.
  const doneRel = dispatchRel(next.data.project, next.data.taskId, 'done', next.data.id);
  await commitAndPush(
    `dispatch-done: ${next.data.agent} ← ${next.data.taskId} (exit=${result.exitCode})`,
    async () => {
      const takenAbs = path.join(config.sharedSpecsRoot, takenRel);
      const doneAbs = path.join(config.sharedSpecsRoot, doneRel);
      await fs.mkdir(path.dirname(doneAbs), { recursive: true });
      try {
        await fs.rename(takenAbs, doneAbs);
      } catch {}
    },
  );
  broadcast('dispatch.done', { dispatchId: next.data.id, ok: result.ok, exitCode: result.exitCode });
  return { processed: true, dispatchId: next.data.id };
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

export function startDispatchWorker(intervalMs = 10_000): void {
  if (timer || config.localAgentIds.length === 0) return;
  const tick = async () => {
    if (stopping) return;
    try {
      while ((await processOneDispatch()).processed) {
        // drain
      }
    } catch (err) {
      console.error('[dispatch] worker error', err);
    } finally {
      if (!stopping) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  console.log(`[dispatch] worker started for local agents: ${config.localAgentIds.join(', ')}`);
}

export function stopDispatchWorker(): void {
  stopping = true;
  if (timer) clearTimeout(timer);
}
