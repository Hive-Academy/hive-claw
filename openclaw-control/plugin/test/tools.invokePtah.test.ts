// Tests for `src/tools/invokePtah.ts`. Uses undici's MockAgent to stub the
// `POST /api/ptah/invoke` round-trip without standing up a real daemon.
//
// IMPORTANT: `src/config.ts` reads env at module load and throws on a
// missing internal token. Because ESM static imports are hoisted above
// any statements, we must set `OPENCLAW_INTERNAL_TOKEN` BEFORE the SUT
// modules load — done via dynamic import inside `before()`.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import type { AgentToolResult } from "../src/sdk/agent-runtime.ts";
import type {
  OpenClawPluginToolFactory,
} from "../src/sdk/plugin-entry.ts";

// Populated in before() once env is wired up.
let invokePtahFactory: OpenClawPluginToolFactory;
let validateProjectSlug: (slug: string) => string | null;

let mockAgent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

before(async () => {
  process.env.OPENCLAW_INTERNAL_TOKEN = "test-token-xyz";
  process.env.OPENCLAW_DAEMON_URL = "http://daemon.test:7878";

  // Dynamic import AFTER env is set so config.ts doesn't throw on load.
  const mod = await import("../src/tools/invokePtah.ts");
  invokePtahFactory = mod.invokePtahFactory;
  validateProjectSlug = mod.validateProjectSlug;

  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

function buildTool() {
  return invokePtahFactory({ agentId: "anubis", sessionKey: "test-session" });
}

function extractText(result: AgentToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("validateProjectSlug — unit", () => {
  it("accepts a clean slug", () => {
    assert.equal(validateProjectSlug("openclaw-control"), null);
  });
  it("rejects empty", () => {
    assert.match(validateProjectSlug("") ?? "", /non-empty/);
  });
  it("rejects '..'", () => {
    assert.match(validateProjectSlug("..") ?? "", /must not contain/);
  });
  it("rejects a slash", () => {
    assert.match(validateProjectSlug("a/b") ?? "", /must not contain/);
  });
  it("rejects a backslash", () => {
    assert.match(validateProjectSlug("a\\b") ?? "", /must not contain/);
  });
  it("rejects control chars", () => {
    assert.match(
      validateProjectSlug("foo\x01bar") ?? "",
      /control character/,
    );
  });
});

describe("invoke_ptah tool — execute()", () => {
  it("rejects project='..' with failedTextResult (no daemon call)", async () => {
    const tool = buildTool();
    const result = await tool.execute("call-1", {
      project: "..",
      prompt: "do something",
    });
    assert.equal(result.isError, true, "must be flagged as error");
    assert.match(extractText(result), /invoke_ptah rejected/);
    assert.match(extractText(result), /must not contain/);
    // No interceptor was installed — if the tool had called the daemon
    // MockAgent would have thrown "no interceptor found". Reaching here
    // proves the tool short-circuited before the HTTP call.
  });

  it("rejects project='a/b' with failedTextResult (no daemon call)", async () => {
    const tool = buildTool();
    const result = await tool.execute("call-2", {
      project: "a/b",
      prompt: "do something",
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /must not contain/);
  });

  it("happy path: returns textResult with the daemon's output", async () => {
    const pool = mockAgent.get("http://daemon.test:7878");
    pool
      .intercept({ path: "/api/ptah/invoke", method: "POST" })
      .reply(
        200,
        {
          ok: true,
          exitCode: 0,
          durationMs: 1234,
          output: "ptah ran fine\nresult here",
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = buildTool();
    const result = await tool.execute("call-3", {
      project: "openclaw-control",
      prompt: "refactor the thing",
    });

    assert.notEqual(
      result.isError,
      true,
      "happy path must NOT be flagged as error",
    );
    assert.equal(extractText(result), "ptah ran fine\nresult here");
    assert.equal(result.metadata?.status, "ok");
    assert.equal(result.metadata?.exitCode, 0);
    assert.equal(result.metadata?.durationMs, 1234);
  });

  it("daemon HTTP 500: returns failedTextResult", async () => {
    const pool = mockAgent.get("http://daemon.test:7878");
    pool
      .intercept({ path: "/api/ptah/invoke", method: "POST" })
      .reply(500, "internal error", {
        headers: { "content-type": "text/plain" },
      });

    const tool = buildTool();
    const result = await tool.execute("call-4", {
      project: "openclaw-control",
      prompt: "do something",
    });

    assert.equal(result.isError, true);
    assert.match(extractText(result), /invoke_ptah failed/);
    assert.match(extractText(result), /500/);
    assert.equal(result.metadata?.status, "failed");
  });

  it("daemon {ok:false}: wraps as failedTextResult", async () => {
    const pool = mockAgent.get("http://daemon.test:7878");
    pool
      .intercept({ path: "/api/ptah/invoke", method: "POST" })
      .reply(
        200,
        {
          ok: false,
          exitCode: 137,
          durationMs: 250,
          output: "",
          stderr: "killed by signal",
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = buildTool();
    const result = await tool.execute("call-5", {
      project: "openclaw-control",
      prompt: "do something",
    });

    assert.equal(result.isError, true);
    assert.match(extractText(result), /ptah failed/);
    assert.match(extractText(result), /137/);
  });
});
