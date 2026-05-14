// `tools/daemonCrud.ts` — the six daemon-CRUD tool factories.
//
// Ports `bot-bridge/src/tools/daemonTools.ts` per arch §3.10, with three
// adaptations:
//
//   1. Context-field renames (arch §3.10):
//        - `ctx.userId`    → `ctx.requesterSenderId`
//        - `ctx.channelId` → `ctx.messageChannel`
//        - `ctx.agentId` stays the same.
//
//   2. Return shape: every tool returns `AgentToolResult` via `textResult`
//      / `failedTextResult`. Raw markdown strings (the bot-bridge shape)
//      are wrapped, not bare-returned.
//
//   3. Input validation (arch §7.1 layer 6):
//        - `project`: reject `..`, `/`, `\`, ASCII control chars.
//        - `taskId`: must match `^TASK_\d{4}_\d{3}$`.
//        - `description` / `prompt` / `reason`: trim, reject empty, cap at
//          50_000 chars.
//        - `decision`: typebox enum already enforces 'APPROVED' | 'REJECTED'.
//
// EXPLICIT DROPS (per Batch 5 spec):
//   - `tick_continuation`       — orchestration tier going away.
//   - `start_harness_setup`     — removed entirely (amendment §3.10).
//   - `dispatch_orchestration_task` — orchestration tier going away.
//
// After Batch 5, the plugin registers 7 tools total: `invoke_ptah` (Batch 4)
// plus the six tools here.

import { Type, type Static } from "@sinclair/typebox";
import type {
  OpenClawPluginToolFactory,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  AnyAgentTool,
  AgentToolResult,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  textResult,
  failedTextResult,
} from "openclaw/plugin-sdk/agent-runtime";

import { daemon } from "../daemonClient.js";
import {
  validateProjectSlug,
  validateTaskId,
  validateText,
} from "../validators.js";

// ---------------------------------------------------------------------------
// Markdown rendering helpers — kept tiny and inline so the tool registry is
// trivially auditable. Ported verbatim from bot-bridge daemonTools.ts:38-73.
// ---------------------------------------------------------------------------

interface ProjectRow {
  slug?: string;
  openTaskCount?: number;
  taskCount?: number;
}

interface TaskRow {
  id?: string;
  phase?: string;
  currentPhase?: string;
  assignedAgent?: string;
  agentId?: string;
  description?: string;
  title?: string;
}

interface TaskSummary extends TaskRow {
  artifacts?: Array<{
    filename?: string;
    name?: string;
    sizeBytes?: number;
  }>;
}

function renderProjectTable(projects: ProjectRow[]): string {
  if (!projects.length) return "_(no projects)_";
  const header = "| slug | open | total |\n|---|---:|---:|";
  const rows = projects
    .map(
      (p) =>
        `| ${p.slug ?? "?"} | ${p.openTaskCount ?? 0} | ${p.taskCount ?? 0} |`,
    )
    .join("\n");
  return `${header}\n${rows}`;
}

function renderTaskList(slug: string, tasks: TaskRow[]): string {
  if (!tasks.length) return `_(no tasks in **${slug}**)_`;
  return tasks
    .map((t) => {
      const phase = t.phase ?? t.currentPhase ?? "?";
      const agent = t.assignedAgent ?? t.agentId ?? "—";
      const desc = t.description ?? t.title ?? "";
      return `- **${t.id}** [${phase}] (${agent}) — ${desc}`;
    })
    .join("\n");
}

function renderTaskSummary(slug: string, summary: TaskSummary): string {
  const head =
    `**${summary.id ?? "?"}** in **${slug}** — phase **${
      summary.phase ?? summary.currentPhase ?? "?"
    }** — agent **${summary.assignedAgent ?? "—"}**`;
  const desc = summary.description ? `\n\n${summary.description}` : "";
  const artifacts =
    Array.isArray(summary.artifacts) && summary.artifacts.length
      ? `\n\n**Artifacts:**\n${summary.artifacts
          .map(
            (a) =>
              `- ${a.filename ?? a.name ?? "?"} (${a.sizeBytes ?? "?"} bytes)`,
          )
          .join("\n")}`
      : "";
  return `${head}${desc}${artifacts}`;
}

// ---------------------------------------------------------------------------
// Small helper: wrap a tool's body in the standard try/catch → failedTextResult
// envelope so every CRUD tool has identical error semantics (HTTP failures
// from `daemonClient.call` throw; we surface the message verbatim).
// ---------------------------------------------------------------------------

async function runTool(
  toolName: string,
  body: () => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failedTextResult(`${toolName} failed: ${message}`, {
      status: "failed",
      error: message,
    });
  }
}

function reject(toolName: string, error: string): AgentToolResult {
  return failedTextResult(`${toolName} rejected: ${error}`, {
    status: "failed",
    error,
  });
}

// ---------------------------------------------------------------------------
// Tool param schemas
// ---------------------------------------------------------------------------

const ListProjectsParams = Type.Object({}, { additionalProperties: false });
type ListProjectsParamsT = Static<typeof ListProjectsParams>;

const CreateProjectParams = Type.Object(
  {
    slug: Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        "Project slug (kebab-case, [a-z0-9][a-z0-9-]{0,63}). Used as the URL key.",
    }),
    name: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Human-friendly project name.",
    }),
    workspace: Type.Optional(
      Type.String({
        description:
          "Optional absolute path on the host this project's work runs in.",
      }),
    ),
  },
  { additionalProperties: false },
);
type CreateProjectParamsT = Static<typeof CreateProjectParams>;

const ListTasksParams = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "Project slug." }),
  },
  { additionalProperties: false },
);
type ListTasksParamsT = Static<typeof ListTasksParams>;

const GetTaskParams = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "Project slug." }),
    taskId: Type.String({
      minLength: 1,
      description: "Task id (e.g. TASK_2026_001).",
    }),
  },
  { additionalProperties: false },
);
type GetTaskParamsT = Static<typeof GetTaskParams>;

const CreateTaskParams = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "Project slug." }),
    description: Type.String({
      minLength: 1,
      description: "Plain-text task description (one paragraph is fine).",
    }),
    agent: Type.Optional(
      Type.String({
        description:
          "Optional agent id to assign the task to. Defaults to the calling persona.",
      }),
    ),
  },
  { additionalProperties: false },
);
type CreateTaskParamsT = Static<typeof CreateTaskParams>;

const ApproveTaskParams = Type.Object(
  {
    project: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    decision: Type.Union([Type.Literal("APPROVED"), Type.Literal("REJECTED")]),
    feedback: Type.Optional(
      Type.String({ description: "Optional reviewer note." }),
    ),
  },
  { additionalProperties: false },
);
type ApproveTaskParamsT = Static<typeof ApproveTaskParams>;

const HandoffTaskParams = Type.Object(
  {
    project: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    toAgent: Type.String({ minLength: 1, description: "Target agent id." }),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type HandoffTaskParamsT = Static<typeof HandoffTaskParams>;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export const listProjectsFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "list_projects",
  label: "List projects",
  description:
    "List all projects with their open and total task counts as a markdown table.",
  parameters: ListProjectsParams,
  async execute(
    _toolCallId: string,
    _params: ListProjectsParamsT,
  ): Promise<AgentToolResult> {
    return runTool("list_projects", async () => {
      const projects = (await daemon.listProjects()) as ProjectRow[];
      return textResult(renderProjectTable(projects), {
        status: "ok",
        count: projects.length,
      });
    });
  },
});

export const createProjectFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "create_project",
  label: "Create project",
  description:
    "Create a new project (the parent container for tasks). Slug is kebab-case ([a-z0-9][a-z0-9-]{0,63}); name is a short human label. Use when the operator says 'start a project' or asks for a brand-new initiative.",
  parameters: CreateProjectParams,
  async execute(
    _toolCallId: string,
    params: CreateProjectParamsT,
  ): Promise<AgentToolResult> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(params.slug)) {
      return reject(
        "create_project",
        "slug must match [a-z0-9][a-z0-9-]{0,63} (kebab-case, ≤64 chars)",
      );
    }
    const name = params.name.trim();
    if (name.length === 0) return reject("create_project", "name must not be empty");
    const workspace =
      typeof params.workspace === "string" && params.workspace.trim().length > 0
        ? params.workspace.trim()
        : undefined;
    if (workspace && !workspace.startsWith("/")) {
      return reject("create_project", "workspace must be an absolute path");
    }

    return runTool("create_project", async () => {
      const row = await daemon.createProject({
        slug: params.slug,
        name,
        workspace: workspace ?? null,
      });
      return textResult(
        JSON.stringify({ ok: true, slug: params.slug, name, workspace: workspace ?? null }),
        { status: "ok", slug: params.slug, row },
      );
    });
  },
});

export const listTasksFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "list_tasks",
  label: "List tasks",
  description:
    "List tasks for a project. Returns a markdown bullet list with task id, phase, assigned agent, and description.",
  parameters: ListTasksParams,
  async execute(
    _toolCallId: string,
    params: ListTasksParamsT,
  ): Promise<AgentToolResult> {
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) return reject("list_tasks", slugError);

    return runTool("list_tasks", async () => {
      const tasks = (await daemon.listTasks(params.project)) as TaskRow[];
      return textResult(renderTaskList(params.project, tasks), {
        status: "ok",
        count: tasks.length,
      });
    });
  },
});

export const getTaskFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "get_task",
  label: "Get task",
  description: "Fetch a single task summary plus its artifacts as markdown.",
  parameters: GetTaskParams,
  async execute(
    _toolCallId: string,
    params: GetTaskParamsT,
  ): Promise<AgentToolResult> {
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) return reject("get_task", slugError);
    const idError = validateTaskId(params.taskId);
    if (idError !== null) return reject("get_task", idError);

    return runTool("get_task", async () => {
      const summary = (await daemon.getTask(
        params.project,
        params.taskId,
      )) as TaskSummary;
      return textResult(renderTaskSummary(params.project, summary), {
        status: "ok",
      });
    });
  },
});

export const createTaskFactory: OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "create_task",
  label: "Create task",
  description:
    "Create a new task in a project. Returns the assigned taskId as JSON. Use this when the user asks to start work on something.",
  parameters: CreateTaskParams,
  async execute(
    _toolCallId: string,
    params: CreateTaskParamsT,
  ): Promise<AgentToolResult> {
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) return reject("create_task", slugError);
    const descCheck = validateText(params.description, "description");
    if (descCheck.error !== null) return reject("create_task", descCheck.error);

    const agent =
      typeof params.agent === "string" && params.agent.trim() !== ""
        ? params.agent.trim()
        : ctx.agentId;

    return runTool("create_task", async () => {
      const result = await daemon.createTask({
        project: params.project,
        description: descCheck.value,
        agentId: agent,
        discordUserId: ctx.requesterSenderId,
        channelId: ctx.messageChannel,
      });
      return textResult(
        JSON.stringify({
          taskId: result.taskId,
          project: params.project,
          agent: agent ?? null,
        }),
        { status: "ok", taskId: result.taskId },
      );
    });
  },
});

export const approveTaskFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "approve_task",
  label: "Approve task",
  description:
    "Approve or reject a task at its current phase. `decision` must be 'APPROVED' or 'REJECTED'.",
  parameters: ApproveTaskParams,
  async execute(
    _toolCallId: string,
    params: ApproveTaskParamsT,
  ): Promise<AgentToolResult> {
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) return reject("approve_task", slugError);
    const idError = validateTaskId(params.taskId);
    if (idError !== null) return reject("approve_task", idError);
    let feedback: string | undefined;
    if (typeof params.feedback === "string" && params.feedback.trim() !== "") {
      const fbCheck = validateText(params.feedback, "feedback");
      if (fbCheck.error !== null) return reject("approve_task", fbCheck.error);
      feedback = fbCheck.value;
    }

    return runTool("approve_task", async () => {
      const summary = (await daemon.getTask(
        params.project,
        params.taskId,
      )) as TaskSummary;
      const phase = summary?.phase ?? summary?.currentPhase;
      if (typeof phase !== "string" || phase.length === 0) {
        return failedTextResult(
          `approve_task failed: could not determine current phase for ${params.taskId}`,
          { status: "failed", error: "missing phase" },
        );
      }
      await daemon.approveTask(params.project, params.taskId, {
        phase,
        decision: params.decision,
        feedback,
      });
      return textResult(
        JSON.stringify({
          ok: true,
          taskId: params.taskId,
          phase,
          decision: params.decision,
        }),
        { status: "ok", phase, decision: params.decision },
      );
    });
  },
});

export const handoffTaskFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "handoff_task",
  label: "Handoff task",
  description: "Hand a task off to another agent.",
  parameters: HandoffTaskParams,
  async execute(
    _toolCallId: string,
    params: HandoffTaskParamsT,
  ): Promise<AgentToolResult> {
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) return reject("handoff_task", slugError);
    const idError = validateTaskId(params.taskId);
    if (idError !== null) return reject("handoff_task", idError);
    if (params.toAgent.trim().length === 0) {
      return reject("handoff_task", "toAgent must not be empty");
    }
    let reason: string | undefined;
    if (typeof params.reason === "string" && params.reason.trim() !== "") {
      const rCheck = validateText(params.reason, "reason");
      if (rCheck.error !== null) return reject("handoff_task", rCheck.error);
      reason = rCheck.value;
    }

    return runTool("handoff_task", async () => {
      await daemon.handoffTask(
        params.project,
        params.taskId,
        params.toAgent,
        reason,
      );
      return textResult(
        JSON.stringify({
          ok: true,
          taskId: params.taskId,
          toAgent: params.toAgent,
        }),
        { status: "ok", toAgent: params.toAgent },
      );
    });
  },
});
