import matter from 'gray-matter';
import type { Project } from './projects.js';
import { discoverProjects, ensureProject } from './projects.js';
import { listTasks, type TaskSummary } from './phase.js';
import { invokeClaudeForTask, isInflight } from './invoker.js';
import { buildContextForMessage } from './memory.js';
import { broadcast } from './sse.js';
import { config } from './config.js';
import {
  DispatchRepo,
  TasksRepo,
  type Phase,
} from './db/index.js';

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

**Task id:** ${task.id}
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
  /**
   * Real dispatch row ids inserted during this tick (TASK_2026_002 B6
   * forwarded sub-task #13). The B2 `dispatch_orchestration_task` tool
   * surfaces this list so the calling LLM can track the specific row.
   *
   * Local-fast-path invocations (where the leader is the owner of the
   * agent and `invokeClaudeForTask` runs synchronously without a dispatch
   * row) do not produce ids; they are still counted in `dispatched`.
   */
  dispatchedIds: string[];
}> {
  if (!config.leader) {
    return { dispatched: 0, pending: 0, checkpoints: 0, skipped: 0, dispatchedIds: [] };
  }
  const projects = await discoverProjects();
  let dispatched = 0;
  let pending = 0;
  let checkpoints = 0;
  let skipped = 0;
  const dispatchedIds: string[] = [];
  for (const project of projects) {
    const tasks = await listTasks(project);
    for (const task of tasks) {
      // Skip-criterion stays `task.phase === 'DONE'` per
      // implementation-plan.md §6 line 636. The dedup is now in the
      // schema (partial UNIQUE index `dispatches_unique_open`), not in
      // this guard.
      if (task.phase === 'DONE') continue;
      if (task.checkpointPending && !isApproved(task)) {
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
        continue;
      }

      // Otherwise, queue a pending dispatch for the owning machine to claim.
      // The partial UNIQUE index `dispatches_unique_open` makes a duplicate
      // (project, task, phase) row unrepresentable while one is open — so
      // when `insertPending` returns null, that's a dedup hit, not an error.
      try {
        const inserted = DispatchRepo.insertPending({
          agentId,
          projectSlug: project.slug,
          taskId: task.id,
          phase: task.phase,
          prompt: next.prompt,
          createdBy: process.env.HOSTNAME ?? 'leader',
        });
        if (inserted) {
          dispatched++;
          dispatchedIds.push(inserted);
          broadcast('dispatch.pending', {
            dispatchId: inserted,
            agent: agentId,
            project: project.slug,
            taskId: task.id,
            phase: task.phase,
          });
        } else {
          // Duplicate already open — the partial UNIQUE index suppressed
          // the insert. No broadcast, no log noise; just count the skip.
          skipped++;
        }
      } catch (err) {
        console.error('[continuation] insertPending failed', err);
      }
    }
  }
  if (dispatched || checkpoints) {
    broadcast('continuation.tick', { dispatched, checkpoints, pending });
  }
  return { dispatched, pending, checkpoints, skipped, dispatchedIds };
}

function isApproved(task: TaskSummary): boolean {
  const row = TasksRepo.get(task.project, task.id);
  if (!row) return false;
  return row.approvals[task.phase] === true;
}

export async function recordApproval(
  project: Project,
  taskId: string,
  phase: Phase,
  by: string,
  feedback?: string,
): Promise<boolean> {
  const cur = TasksRepo.get(project.slug, taskId);
  if (!cur) return false;

  // Update the canonical approvals + log columns.
  TasksRepo.recordApproval(project.slug, taskId, phase, by);

  // Keep the YAML frontmatter on context.md coherent for the dashboard's
  // markdown viewer. Read existing → mutate frontmatter → write back. Both
  // updates run in independent transactions; this is fine because
  // `tasks.approvals_json` is the canonical store and the file is a view.
  const existing = TasksRepo.readFile(project.slug, taskId, 'context.md');
  if (existing) {
    try {
      const parsed = matter(existing.content);
      const data = (parsed.data ?? {}) as Record<string, unknown>;
      const approvals = (data.approvals as Record<string, boolean> | undefined) ?? {};
      approvals[phase] = true;
      data.approvals = approvals;
      const log = (data.approval_log as Array<Record<string, unknown>> | undefined) ?? [];
      log.push({
        phase,
        by,
        at: new Date().toISOString(),
        feedback: feedback ?? null,
      });
      data.approval_log = log;
      TasksRepo.writeFile(
        project.slug,
        taskId,
        'context.md',
        matter.stringify(parsed.content, data),
        by,
      );
    } catch (err) {
      // Frontmatter-rewrite failure is non-fatal — the canonical approval
      // is already recorded in `tasks.approvals_json`. Surface the warning
      // so a misshapen context.md does not get silently ignored forever.
      console.warn('[continuation] context.md frontmatter update skipped:', err);
    }
  }

  broadcast('checkpoint.approved', { taskId, phase, by });
  return true;
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
  await ensureProject(opts.projectSlug);
  const year = new Date().getFullYear();

  // Find the next free TASK_<year>_NNN id by scanning existing rows.
  const existingTasks = TasksRepo.list(opts.projectSlug);
  const ids = existingTasks
    .map((t) => t.id)
    .filter((id) => id.startsWith(`TASK_${year}_`))
    .map((id) => Number(id.split('_')[2]))
    .filter((n) => Number.isFinite(n));
  const nextSeq = (ids.length ? Math.max(...ids) : 0) + 1;
  const taskId = `TASK_${year}_${String(nextSeq).padStart(3, '0')}`;

  const title = opts.description;
  const ctx = matter.stringify(`# ${opts.description}\n\nCreated by openclaw-control daemon.\n`, {
    task_id: taskId,
    task_type: opts.taskType ?? 'FEATURE',
    assigned_agent: opts.agentId ?? 'anubis',
    discord_user_id: opts.discordUserId ?? null,
    channel_id: opts.channelId ?? null,
    created_at: new Date().toISOString(),
    approvals: {},
  });

  TasksRepo.insert({
    projectSlug: opts.projectSlug,
    id: taskId,
    title,
    taskType: opts.taskType ?? 'FEATURE',
    assignedAgent: opts.agentId ?? 'anubis',
    discordUserId: opts.discordUserId ?? null,
    channelId: opts.channelId ?? null,
    currentPhase: 'CONTEXT',
  });
  TasksRepo.writeFile(opts.projectSlug, taskId, 'context.md', ctx, opts.agentId ?? null);

  broadcast('task.created', { taskId, project: opts.projectSlug });
  // `folder` is preserved in the return shape for compatibility with the
  // existing API consumer (api.ts /api/tasks). The DB-backed world has no
  // filesystem folder; we surface a logical id-form path for display only.
  return { taskId, folder: `${opts.projectSlug}/${taskId}` };
}
