// tools/daemonTools.ts — the structured-CRUD tool surface for chat.
//
// TASK_2026_002 B2 — implements the 9 tools enumerated in
// implementation-plan.md §`tools/daemonTools.ts` (lines 178–193):
//
//   list_projects()                                 → markdown table of projects
//   list_tasks(project)                             → markdown task list
//   get_task(project, taskId)                       → markdown task summary + artifacts
//   create_task(project, description, agent?)       → { taskId } JSON
//   approve_task(project, taskId, decision, fb?)    → ok JSON
//   handoff_task(project, taskId, toAgent, reason?) → ok JSON
//   tick_continuation()                              → counts JSON
//   start_harness_setup(project)                     → flips ctx.state.harnessSetup
//   dispatch_orchestration_task(project, desc, ag?)  → { taskId, dispatchId|null }
//
// Per the impl-plan: NO raw `gh_query` / `web_fetch` here — those live behind
// subagents (subagentTools.ts) and MCP (mcpTools.ts). This file is the daemon
// CRUD surface only.
//
// All handlers return strings (markdown for read tools, JSON for mutations)
// because the OpenAI tool protocol expects string content for the `tool`
// role response.

import { daemon } from '../daemonClient.js';
import type { ToolDef } from '../llm.js';
import {
  HARNESS_AUTHOR_SYSTEM_PROMPT,
  entryModeMessage,
  type HarnessAuthorState,
  HARNESS_SETUP_STATE_KEY,
} from '../harnessAuthor.js';

// ---------------------------------------------------------------------------
// Markdown rendering helpers — kept tiny and inline so the tool registry is
// trivially auditable.
// ---------------------------------------------------------------------------

function renderProjectTable(projects: any[]): string {
  if (!projects.length) return '_(no projects)_';
  const header = '| slug | open | total |\n|---|---:|---:|';
  const rows = projects
    .map(
      (p) =>
        `| ${p.slug ?? '?'} | ${p.openTaskCount ?? 0} | ${p.taskCount ?? 0} |`,
    )
    .join('\n');
  return `${header}\n${rows}`;
}

function renderTaskList(slug: string, tasks: any[]): string {
  if (!tasks.length) return `_(no tasks in **${slug}**)_`;
  return tasks
    .map((t) => {
      const phase = t.phase ?? t.currentPhase ?? '?';
      const agent = t.assignedAgent ?? t.agentId ?? '—';
      const desc = t.description ?? t.title ?? '';
      return `- **${t.id}** [${phase}] (${agent}) — ${desc}`;
    })
    .join('\n');
}

function renderTaskSummary(slug: string, summary: any): string {
  const head = `**${summary.id ?? '?'}** in **${slug}** — phase **${
    summary.phase ?? summary.currentPhase ?? '?'
  }** — agent **${summary.assignedAgent ?? '—'}**`;
  const desc = summary.description ? `\n\n${summary.description}` : '';
  const artifacts = Array.isArray(summary.artifacts) && summary.artifacts.length
    ? `\n\n**Artifacts:**\n${summary.artifacts
        .map((a: any) => `- ${a.filename ?? a.name ?? '?'} (${a.sizeBytes ?? '?'} bytes)`)
        .join('\n')}`
    : '';
  return `${head}${desc}${artifacts}`;
}

// ---------------------------------------------------------------------------
// Argument-extraction helpers — fail loud on the contract, not silent.
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${toolName}: required argument "${key}" must be a non-empty string`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return v;
}

// ---------------------------------------------------------------------------
// Tool registry.
// ---------------------------------------------------------------------------

/**
 * Returns the daemon-CRUD tools. Pure function — call on every message.
 *
 * The handlers close over the singleton `daemon` HTTP client. Tests stub
 * `daemon.<method>` directly to assert round-tripping (see
 * test/tool-call-fallback.test.ts).
 */
export function list(): ToolDef[] {
  return [
    {
      name: 'list_projects',
      description: 'List all projects with their open and total task counts as a markdown table.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const projects = await daemon.listProjects();
        return renderProjectTable(projects);
      },
    },
    {
      name: 'list_tasks',
      description:
        'List tasks for a project. Returns a markdown bullet list with task id, phase, assigned agent, and description.',
      parameters: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Project slug.' } },
        required: ['project'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const slug = requireString(args, 'project', 'list_tasks');
        const tasks = await daemon.listTasks(slug);
        return renderTaskList(slug, tasks);
      },
    },
    {
      name: 'get_task',
      description: 'Fetch a single task summary plus its artifacts as markdown.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          taskId: { type: 'string', description: 'Task id (e.g. TASK_2026_001).' },
        },
        required: ['project', 'taskId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const slug = requireString(args, 'project', 'get_task');
        const taskId = requireString(args, 'taskId', 'get_task');
        const summary = await daemon.getTask(slug, taskId);
        return renderTaskSummary(slug, summary);
      },
    },
    {
      name: 'create_task',
      description:
        'Create a new task in a project. Returns the assigned taskId as JSON. Use this when the user asks to start work on something.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          description: {
            type: 'string',
            description: 'Plain-text task description (one paragraph is fine).',
          },
          agent: {
            type: 'string',
            description:
              'Optional agent id to assign the task to. Defaults to the calling persona.',
          },
        },
        required: ['project', 'description'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const project = requireString(args, 'project', 'create_task');
        const description = requireString(args, 'description', 'create_task');
        const agent = optionalString(args, 'agent') ?? ctx.agentId;
        const result = await daemon.createTask({
          project,
          description,
          agentId: agent,
          discordUserId: ctx.userId,
          channelId: ctx.channelId,
        });
        return JSON.stringify({ taskId: result.taskId, project, agent });
      },
    },
    {
      name: 'approve_task',
      description:
        "Approve or reject a task at its current phase. `decision` must be 'APPROVED' or 'REJECTED'.",
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          taskId: { type: 'string' },
          decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
          feedback: { type: 'string', description: 'Optional reviewer note.' },
        },
        required: ['project', 'taskId', 'decision'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = requireString(args, 'project', 'approve_task');
        const taskId = requireString(args, 'taskId', 'approve_task');
        const decisionRaw = requireString(args, 'decision', 'approve_task');
        if (decisionRaw !== 'APPROVED' && decisionRaw !== 'REJECTED') {
          throw new Error(
            `approve_task: decision must be 'APPROVED' or 'REJECTED', got ${decisionRaw}`,
          );
        }
        const summary = await daemon.getTask(project, taskId);
        const phase = summary?.phase ?? summary?.currentPhase;
        if (typeof phase !== 'string') {
          throw new Error(`approve_task: could not determine current phase for ${taskId}`);
        }
        await daemon.approveTask(project, taskId, {
          phase,
          decision: decisionRaw,
          feedback: optionalString(args, 'feedback'),
        });
        return JSON.stringify({ ok: true, taskId, phase, decision: decisionRaw });
      },
    },
    {
      name: 'handoff_task',
      description: 'Hand a task off to another agent.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          taskId: { type: 'string' },
          toAgent: { type: 'string', description: 'Target agent id.' },
          reason: { type: 'string' },
        },
        required: ['project', 'taskId', 'toAgent'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = requireString(args, 'project', 'handoff_task');
        const taskId = requireString(args, 'taskId', 'handoff_task');
        const toAgent = requireString(args, 'toAgent', 'handoff_task');
        await daemon.handoffTask(project, taskId, toAgent, optionalString(args, 'reason'));
        return JSON.stringify({ ok: true, taskId, toAgent });
      },
    },
    {
      name: 'tick_continuation',
      description:
        'Run one tick of the continuation loop. Returns counts: dispatched, pending, checkpoints.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const result = await daemon.tickContinuation();
        return JSON.stringify(result);
      },
    },
    {
      name: 'start_harness_setup',
      description:
        'Flip the conversation into harness-authoring mode for the given project. Subsequent messages are interpreted as harness-author input until the operator says "cancel harness setup" or the timeout expires.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug to author the harness for.' },
        },
        required: ['project'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const project = requireString(args, 'project', 'start_harness_setup');
        // TASK_2026_002 B7 — write the canonical state slot. `chat.ts` swaps
        // the tool registry on the next round when it sees this key, per
        // impl-plan line 1068 (replacement, not merge).
        const state: HarnessAuthorState = {
          project,
          stage: 'probing',
          startedAt: Date.now(),
        };
        ctx.state.set(HARNESS_SETUP_STATE_KEY, state);
        // Return: entry-mode message (impl-plan lines 996–998) + a blank
        // line + the full HARNESS_AUTHOR_SYSTEM_PROMPT body (lines 1032–1053).
        // The model gets this as its `tool` role response on the round it
        // fired start_harness_setup, then chat.ts hot-swaps the registry to
        // harnessAuthor.tools(...) on the next round.
        return `${entryModeMessage(project)}\n\n${HARNESS_AUTHOR_SYSTEM_PROMPT}`;
      },
    },
    {
      name: 'dispatch_orchestration_task',
      description:
        'Convenience: create a task AND immediately tick the continuation loop so it gets dispatched. Returns { taskId, dispatchId } where dispatchId is null if no dispatch row was created in this tick.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          description: { type: 'string' },
          agent: { type: 'string' },
        },
        required: ['project', 'description'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const project = requireString(args, 'project', 'dispatch_orchestration_task');
        const description = requireString(args, 'description', 'dispatch_orchestration_task');
        const agent = optionalString(args, 'agent') ?? ctx.agentId;
        const created = await daemon.createTask({
          project,
          description,
          agentId: agent,
          discordUserId: ctx.userId,
          channelId: ctx.channelId,
        });
        // Best-effort tick. If the tick fails (e.g. follower can't reach the
        // leader transiently), the task is still created — the continuation
        // loop will pick it up on its next cycle. We surface the tick error
        // alongside the taskId so the model can decide whether to retry.
        //
        // TASK_2026_002 B6 forwarded #13: the leader's tick endpoint now
        // returns `dispatchedIds: string[]`. We surface the first id whose
        // taskId matches the task we just created (preferred) or, failing
        // that, the first id in the list. Falls back to null when nothing
        // was dispatched in this tick (the continuation loop will pick it
        // up on its next cycle).
        let dispatchId: string | null = null;
        let dispatchedIds: string[] = [];
        let tickError: string | null = null;
        try {
          const tick = await daemon.tickContinuation();
          dispatchedIds = Array.isArray(tick.dispatchedIds) ? tick.dispatchedIds : [];
          if (dispatchedIds.length > 0) {
            dispatchId = dispatchedIds[0]!;
          } else if (tick.dispatched > 0) {
            // Older leader without `dispatchedIds` — preserve the synthetic
            // string so the model still has a signal that something was
            // dispatched (count, not row id). This branch is the
            // back-compat path documented in B6 task #13.
            dispatchId = `dispatched:${tick.dispatched}`;
          }
        } catch (err) {
          tickError = (err as Error)?.message ?? String(err);
        }
        return JSON.stringify({
          taskId: created.taskId,
          dispatchId,
          dispatchedIds,
          ...(tickError ? { tickError } : {}),
        });
      },
    },
  ];
}
