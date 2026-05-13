// Tests for `src/tools/daemonCrud.ts` — the six daemon-CRUD tool factories.
//
// Uses undici's MockAgent to stub daemon HTTP round-trips (same pattern as
// tools.invokePtah.test.ts). The ESM hoisting gotcha — env must be set
// BEFORE the SUT modules load — is handled via dynamic import inside
// `before()`.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import type { AgentToolResult } from "../src/sdk/agent-runtime.ts";
import type {
  OpenClawPluginToolFactory,
  OpenClawPluginToolContext,
} from "../src/sdk/plugin-entry.ts";

// Populated in before() once env is wired up.
let listProjectsFactory: OpenClawPluginToolFactory;
let listTasksFactory: OpenClawPluginToolFactory;
let getTaskFactory: OpenClawPluginToolFactory;
let createTaskFactory: OpenClawPluginToolFactory;
let approveTaskFactory: OpenClawPluginToolFactory;
let handoffTaskFactory: OpenClawPluginToolFactory;

let mockAgent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

const DAEMON_ORIGIN = "http://daemon.test:7878";
const CTX: OpenClawPluginToolContext = {
  agentId: "anubis",
  sessionKey: "test-session",
  requesterSenderId: "discord:user:123",
  messageChannel: "discord:channel:456",
  agentAccountId: "anubis",
};

before(async () => {
  process.env.OPENCLAW_INTERNAL_TOKEN = "test-token-xyz";
  process.env.OPENCLAW_DAEMON_URL = DAEMON_ORIGIN;

  // Dynamic import AFTER env is set so config.ts doesn't throw on load.
  const mod = await import("../src/tools/daemonCrud.ts");
  listProjectsFactory = mod.listProjectsFactory;
  listTasksFactory = mod.listTasksFactory;
  getTaskFactory = mod.getTaskFactory;
  createTaskFactory = mod.createTaskFactory;
  approveTaskFactory = mod.approveTaskFactory;
  handoffTaskFactory = mod.handoffTaskFactory;

  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

function extractText(result: AgentToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

function pool() {
  return mockAgent.get(DAEMON_ORIGIN);
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

describe("list_projects", () => {
  it("happy path: renders a markdown table", async () => {
    pool()
      .intercept({ path: "/api/projects", method: "GET" })
      .reply(
        200,
        [
          { slug: "openclaw-control", openTaskCount: 3, taskCount: 12 },
          { slug: "fixing-openclaw", openTaskCount: 1, taskCount: 7 },
        ],
        { headers: { "content-type": "application/json" } },
      );

    const tool = listProjectsFactory(CTX);
    const result = await tool.execute("c1", {});
    assert.notEqual(result.isError, true);
    const text = extractText(result);
    assert.match(text, /\| slug \| open \| total \|/);
    assert.match(text, /openclaw-control/);
    assert.match(text, /fixing-openclaw/);
    assert.equal(result.metadata?.count, 2);
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({ path: "/api/projects", method: "GET" })
      .reply(500, "boom", { headers: { "content-type": "text/plain" } });

    const tool = listProjectsFactory(CTX);
    const result = await tool.execute("c2", {});
    assert.equal(result.isError, true);
    assert.match(extractText(result), /list_projects failed/);
    assert.match(extractText(result), /500/);
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe("list_tasks", () => {
  it("happy path: renders bullet list", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks",
        method: "GET",
      })
      .reply(
        200,
        [
          {
            id: "TASK_2026_001",
            phase: "PLAN",
            assignedAgent: "anubis",
            description: "first task",
          },
        ],
        { headers: { "content-type": "application/json" } },
      );

    const tool = listTasksFactory(CTX);
    const result = await tool.execute("c1", { project: "openclaw-control" });
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /\*\*TASK_2026_001\*\* \[PLAN\]/);
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({ path: "/api/projects/openclaw-control/tasks", method: "GET" })
      .reply(503, "unavailable", {
        headers: { "content-type": "text/plain" },
      });

    const tool = listTasksFactory(CTX);
    const result = await tool.execute("c2", { project: "openclaw-control" });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /list_tasks failed/);
  });

  it("rejects project='..' (path-traversal, no daemon call)", async () => {
    const tool = listTasksFactory(CTX);
    const result = await tool.execute("c3", { project: ".." });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /list_tasks rejected/);
    assert.match(extractText(result), /must not contain/);
  });

  it("rejects project='a/b' (slash, no daemon call)", async () => {
    const tool = listTasksFactory(CTX);
    const result = await tool.execute("c4", { project: "a/b" });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /must not contain/);
  });
});

// ---------------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------------

describe("get_task", () => {
  it("happy path: renders summary", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_001",
        method: "GET",
      })
      .reply(
        200,
        {
          id: "TASK_2026_001",
          phase: "DESCRIPTION",
          assignedAgent: "anubis",
          description: "the description body",
          artifacts: [{ filename: "spec.md", sizeBytes: 1024 }],
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = getTaskFactory(CTX);
    const result = await tool.execute("c1", {
      project: "openclaw-control",
      taskId: "TASK_2026_001",
    });
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /TASK_2026_001/);
    assert.match(extractText(result), /phase \*\*DESCRIPTION\*\*/);
    assert.match(extractText(result), /spec\.md/);
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_999",
        method: "GET",
      })
      .reply(404, "not found", { headers: { "content-type": "text/plain" } });

    const tool = getTaskFactory(CTX);
    const result = await tool.execute("c2", {
      project: "openclaw-control",
      taskId: "TASK_2026_999",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /get_task failed/);
    assert.match(extractText(result), /404/);
  });

  it("rejects taskId that doesn't match ^TASK_\\d{4}_\\d{3}$", async () => {
    const tool = getTaskFactory(CTX);
    const result = await tool.execute("c3", {
      project: "openclaw-control",
      taskId: "task-1",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /taskId must match/);
  });

  it("rejects bad project slug before bad taskId", async () => {
    const tool = getTaskFactory(CTX);
    const result = await tool.execute("c4", {
      project: "../etc",
      taskId: "TASK_2026_001",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /must not contain/);
  });
});

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

describe("create_task", () => {
  it("happy path: forwards ctx context fields and returns taskId", async () => {
    let capturedBody: unknown;
    pool()
      .intercept({ path: "/api/tasks", method: "POST" })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { taskId: "TASK_2026_077" };
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = createTaskFactory(CTX);
    const result = await tool.execute("c1", {
      project: "openclaw-control",
      description: "refactor X",
    });
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /TASK_2026_077/);

    // Verify per-amendment context-field rename:
    //   ctx.userId    → discordUserId field via ctx.requesterSenderId
    //   ctx.channelId → channelId      field via ctx.messageChannel
    const body = capturedBody as Record<string, unknown>;
    assert.equal(body.project, "openclaw-control");
    assert.equal(body.description, "refactor X");
    assert.equal(body.agentId, "anubis");
    assert.equal(body.discordUserId, "discord:user:123");
    assert.equal(body.channelId, "discord:channel:456");
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({ path: "/api/tasks", method: "POST" })
      .reply(500, "internal error", {
        headers: { "content-type": "text/plain" },
      });

    const tool = createTaskFactory(CTX);
    const result = await tool.execute("c2", {
      project: "openclaw-control",
      description: "second try",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /create_task failed/);
  });

  it("rejects empty description (after trim)", async () => {
    const tool = createTaskFactory(CTX);
    const result = await tool.execute("c3", {
      project: "openclaw-control",
      description: "   \n  ",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /description must not be empty/);
  });

  it("rejects description over 50_000 chars", async () => {
    const tool = createTaskFactory(CTX);
    const huge = "x".repeat(50_001);
    const result = await tool.execute("c4", {
      project: "openclaw-control",
      description: huge,
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /exceeds maximum length/);
  });

  it("rejects bad project slug (path-traversal)", async () => {
    const tool = createTaskFactory(CTX);
    const result = await tool.execute("c5", {
      project: "..",
      description: "valid",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /must not contain/);
  });
});

// ---------------------------------------------------------------------------
// approve_task
// ---------------------------------------------------------------------------

describe("approve_task", () => {
  it("happy path: probes get_task for phase then POSTs approve", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_001",
        method: "GET",
      })
      .reply(
        200,
        { id: "TASK_2026_001", phase: "PLAN" },
        { headers: { "content-type": "application/json" } },
      );
    let approveBody: unknown;
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_001/approve",
        method: "POST",
      })
      .reply(
        200,
        (opts) => {
          approveBody = JSON.parse(opts.body as string);
          return {};
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = approveTaskFactory(CTX);
    const result = await tool.execute("c1", {
      project: "openclaw-control",
      taskId: "TASK_2026_001",
      decision: "APPROVED",
      feedback: "looks good",
    });
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /"decision":"APPROVED"/);
    const body = approveBody as Record<string, unknown>;
    assert.equal(body.phase, "PLAN");
    assert.equal(body.decision, "APPROVED");
    assert.equal(body.feedback, "looks good");
  });

  it("daemon failure on getTask: returns failedTextResult", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_002",
        method: "GET",
      })
      .reply(500, "boom", { headers: { "content-type": "text/plain" } });

    const tool = approveTaskFactory(CTX);
    const result = await tool.execute("c2", {
      project: "openclaw-control",
      taskId: "TASK_2026_002",
      decision: "REJECTED",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /approve_task failed/);
  });

  it("rejects taskId not matching pattern", async () => {
    const tool = approveTaskFactory(CTX);
    const result = await tool.execute("c3", {
      project: "openclaw-control",
      taskId: "not-a-task",
      decision: "APPROVED",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /taskId must match/);
  });

  it("surfaces missing-phase summary as a clean failure", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_003",
        method: "GET",
      })
      .reply(
        200,
        { id: "TASK_2026_003" },
        { headers: { "content-type": "application/json" } },
      );

    const tool = approveTaskFactory(CTX);
    const result = await tool.execute("c4", {
      project: "openclaw-control",
      taskId: "TASK_2026_003",
      decision: "APPROVED",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /could not determine current phase/);
  });
});

// ---------------------------------------------------------------------------
// handoff_task
// ---------------------------------------------------------------------------

describe("handoff_task", () => {
  it("happy path: POSTs handoff and returns ok JSON", async () => {
    let handoffBody: unknown;
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_001/handoff",
        method: "POST",
      })
      .reply(
        200,
        (opts) => {
          handoffBody = JSON.parse(opts.body as string);
          return {};
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = handoffTaskFactory(CTX);
    const result = await tool.execute("c1", {
      project: "openclaw-control",
      taskId: "TASK_2026_001",
      toAgent: "horus",
      reason: "out-of-scope for anubis",
    });
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /"toAgent":"horus"/);
    const body = handoffBody as Record<string, unknown>;
    assert.equal(body.toAgent, "horus");
    assert.equal(body.reason, "out-of-scope for anubis");
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({
        path: "/api/projects/openclaw-control/tasks/TASK_2026_001/handoff",
        method: "POST",
      })
      .reply(403, "forbidden", {
        headers: { "content-type": "text/plain" },
      });

    const tool = handoffTaskFactory(CTX);
    const result = await tool.execute("c2", {
      project: "openclaw-control",
      taskId: "TASK_2026_001",
      toAgent: "horus",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /handoff_task failed/);
    assert.match(extractText(result), /403/);
  });

  it("rejects reason over 50_000 chars", async () => {
    const tool = handoffTaskFactory(CTX);
    const huge = "x".repeat(50_001);
    const result = await tool.execute("c3", {
      project: "openclaw-control",
      taskId: "TASK_2026_001",
      toAgent: "horus",
      reason: huge,
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /exceeds maximum length/);
  });

  it("rejects bad project slug", async () => {
    const tool = handoffTaskFactory(CTX);
    const result = await tool.execute("c4", {
      project: "a\\b",
      taskId: "TASK_2026_001",
      toAgent: "horus",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /must not contain/);
  });
});
