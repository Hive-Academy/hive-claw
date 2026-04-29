import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Project } from './projects.js';
import { discoverProjects, ensureProject } from './projects.js';
import { listTasks, readTask, type TaskSummary, type Phase } from './phase.js';
import { invokeClaudeForTask, isInflight } from './invoker.js';
import { buildContextForMessage } from './memory.js';
import { broadcast } from './sse.js';
import { config } from './config.js';
import { commitAndPush } from './gitSync.js';
import { writePendingDispatch } from './dispatch.js';

interface NextStep {
  agentRole: string;
  prompt: string;
}

function buildPromptFor(
  phase: Phase,
  task: TaskSummary,
  projectPath: string,
  memory: string,
): NextStep | null {
  const header = `You are an OpenClaw orchestration agent working on **${task.id}** in project **${task.project}**.

**Task folder:** ${task.folder}
**Project working dir:** ${projectPath}
**Assigned agent:** ${task.assignedAgent ?? 'unassigned'}
**Discord user:** ${task.discordUserId ?? 'n/a'}
**Channel:** ${task.channelId ?? 'n/a'}

${memory ? `## Shared memory context\n${memory}\n\n` : ''}Read \`context.md\` first. Then perform exactly the next phase below — do not jump ahead. When done, write the deliverable file in the task folder and exit.`;

  switch (phase) {
    case 'CONTEXT':
      return {
        agentRole: 'project-manager',
        prompt: `${header}

## Your phase: PRODUCT MANAGER

Produce \`task-description.md\` with: problem statement, scope, acceptance criteria, out-of-scope items. Then stop.`,
      };
    case 'DESCRIPTION':
      return {
        agentRole: 'software-architect',
        prompt: `${header}

## Your phase: ARCHITECT

Read \`task-description.md\`. Produce \`implementation-plan.md\` with: file changes, new modules, data model, sequence/flow. Then stop.`,
      };
    case 'PLAN':
      return {
        agentRole: 'team-leader',
        prompt: `${header}

## Your phase: TEAM-LEADER MODE 1

Read \`implementation-plan.md\`. Produce \`tasks.md\` with batched checklist items as \`- [ ] PENDING task description (file: path)\`. 3-5 tasks per batch. Then stop.`,
      };
    case 'PENDING':
    case 'IN_PROGRESS':
      return {
        agentRole: 'developer',
        prompt: `${header}

## Your phase: DEVELOPER

Read \`tasks.md\`. Pick the next batch of PENDING items. Implement them. Update \`tasks.md\` to mark each \`IMPLEMENTED\` once done. Then stop.`,
      };
    case 'IMPLEMENTED':
      return {
        agentRole: 'senior-tester',
        prompt: `${header}

## Your phase: QA

Read \`tasks.md\`. For each IMPLEMENTED item: verify, run tests if applicable, mark \`COMPLETE\` if good or revert to \`PENDING\` with a note. Then stop.`,
      };
    case 'QA_DONE':
      return {
        agentRole: 'modernization-detector',
        prompt: `${header}

## Your phase: MODERNIZATION-DETECTOR

Review what was implemented. Produce \`future-enhancements.md\` with tech-debt notes and follow-up opportunities. Then stop.`,
      };
    default:
      return null;
  }
}

export async function tickOnce(): Promise<{
  dispatched: number;
  pending: number;
  checkpoints: number;
  skipped: number;
}> {
  if (!config.leader) {
    return { dispatched: 0, pending: 0, checkpoints: 0, skipped: 0 };
  }
  const projects = await discoverProjects();
  let dispatched = 0;
  let pending = 0;
  let checkpoints = 0;
  let skipped = 0;
  for (const project of projects) {
    const tasks = await listTasks(project);
    for (const task of tasks) {
      if (task.phase === 'DONE') continue;
      if (task.checkpointPending && !(await isApproved(task))) {
        checkpoints++;
        broadcast('checkpoint.pending', {
          taskId: task.id,
          project: project.slug,
          phase: task.phase,
        });
        continue;
      }
      pending++;
      const agentId = task.assignedAgent ?? 'anubis';
      const next = buildPromptFor(
        task.phase,
        task,
        project.path,
        await buildContextForMessage({
          agentId,
          discordUserId: task.discordUserId,
          channelId: task.channelId,
          projectSlug: project.slug,
        }),
      );
      if (!next) continue;

      // If the assigned agent runs on THIS machine, invoke directly (fast path).
      if (config.localAgentIds.includes(agentId)) {
        if (isInflight(`${project.slug}:${task.id}`)) {
          skipped++;
          continue;
        }
        void invokeClaudeForTask({ project, task, agentId, prompt: next.prompt });
        dispatched++;
      } else {
        // Otherwise, write a pending dispatch into the git repo for the
        // owning machine to pick up.
        try {
          await writePendingDispatch({
            agent: agentId,
            project: project.slug,
            taskId: task.id,
            phase: task.phase,
            prompt: next.prompt,
          });
          dispatched++;
        } catch (err) {
          console.error('[continuation] writePendingDispatch failed', err);
        }
      }
    }
  }
  if (dispatched || checkpoints) broadcast('continuation.tick', { dispatched, checkpoints, pending });
  return { dispatched, pending, checkpoints, skipped };
}

async function isApproved(task: TaskSummary): Promise<boolean> {
  try {
    const ctxPath = path.join(task.folder, 'context.md');
    const raw = await fs.readFile(ctxPath, 'utf8');
    const parsed = matter(raw);
    const approvals = (parsed.data?.approvals ?? {}) as Record<string, boolean>;
    return approvals[task.phase] === true;
  } catch {
    return false;
  }
}

export async function recordApproval(
  project: Project,
  taskId: string,
  phase: Phase,
  by: string,
  feedback?: string,
): Promise<boolean> {
  const ctxPath = path.join(project.specsDir, taskId, 'context.md');
  let exists = true;
  try {
    await fs.access(ctxPath);
  } catch {
    exists = false;
  }
  if (!exists) return false;

  const result = await commitAndPush(`approve: ${taskId} (${phase}) by ${by}`, async () => {
    const raw = await fs.readFile(ctxPath, 'utf8');
    const parsed = matter(raw);
    const data = (parsed.data ?? {}) as any;
    data.approvals ??= {};
    data.approvals[phase] = true;
    data.approval_log ??= [];
    data.approval_log.push({
      phase,
      by,
      at: new Date().toISOString(),
      feedback: feedback ?? null,
    });
    await fs.writeFile(ctxPath, matter.stringify(parsed.content, data), 'utf8');
  });
  if (result.ok) broadcast('checkpoint.approved', { taskId, phase, by });
  return result.ok;
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

export function startContinuationLoop(intervalMs = 30_000): void {
  if (timer) return;
  if (!config.leader) {
    console.log('[continuation] not leader — loop disabled');
    return;
  }
  console.log(`[continuation] leader mode — loop running every ${intervalMs}ms`);
  const tick = async () => {
    if (stopping) return;
    try {
      await tickOnce();
    } catch (err) {
      console.error('[continuation] tick error', err);
    } finally {
      if (!stopping) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
}

export function stopContinuationLoop(): void {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function createTask(opts: {
  projectSlug: string;
  description: string;
  taskType?: string;
  agentId?: string;
  discordUserId?: string;
  channelId?: string;
}): Promise<{ taskId: string; folder: string }> {
  const project = await ensureProject(opts.projectSlug);
  const year = new Date().getFullYear();
  const entries = await fs.readdir(project.specsDir, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(`TASK_${year}_`))
    .map((e) => Number(e.name.split('_')[2]))
    .filter((n) => Number.isFinite(n));
  const next = (ids.length ? Math.max(...ids) : 0) + 1;
  const taskId = `TASK_${year}_${String(next).padStart(3, '0')}`;
  const folder = path.join(project.specsDir, taskId);

  await commitAndPush(`new task: ${taskId} (${opts.projectSlug}) — ${opts.description.slice(0, 60)}`, async () => {
    await fs.mkdir(folder, { recursive: true });
    const ctx = matter.stringify(`# ${opts.description}\n\nCreated by openclaw-control daemon.\n`, {
      task_id: taskId,
      task_type: opts.taskType ?? 'FEATURE',
      assigned_agent: opts.agentId ?? 'anubis',
      discord_user_id: opts.discordUserId ?? null,
      channel_id: opts.channelId ?? null,
      created_at: new Date().toISOString(),
      approvals: {},
    });
    await fs.writeFile(path.join(folder, 'context.md'), ctx, 'utf8');
  });

  broadcast('task.created', { taskId, project: opts.projectSlug });
  return { taskId, folder };
}
