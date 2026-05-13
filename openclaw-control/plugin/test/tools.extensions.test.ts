// Tests for `src/tools/extensions.ts` — the five extension-install / clawhub
// tool factories (Batch 8c, amendment §16.4).
//
// Uses undici's MockAgent to stub daemon HTTP round-trips (same pattern as
// tools.daemonCrud.test.ts). The ESM hoisting gotcha — env must be set
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

let requestPluginInstallFactory: OpenClawPluginToolFactory;
let requestMcpSkillInstallFactory: OpenClawPluginToolFactory;
let listInstalledPluginsFactory: OpenClawPluginToolFactory;
let listInstalledMcpSkillsFactory: OpenClawPluginToolFactory;
let searchClawhubFactory: OpenClawPluginToolFactory;

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

  const mod = await import("../src/tools/extensions.ts");
  requestPluginInstallFactory = mod.requestPluginInstallFactory;
  requestMcpSkillInstallFactory = mod.requestMcpSkillInstallFactory;
  listInstalledPluginsFactory = mod.listInstalledPluginsFactory;
  listInstalledMcpSkillsFactory = mod.listInstalledMcpSkillsFactory;
  searchClawhubFactory = mod.searchClawhubFactory;

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
// request_plugin_install
// ---------------------------------------------------------------------------

describe("request_plugin_install", () => {
  it("happy path: returns markdown with requestId and pending status", async () => {
    let capturedBody: unknown;
    pool()
      .intercept({
        path: "/api/extensions/install-requests",
        method: "POST",
      })
      .reply(
        201,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return {
            requestId: 42,
            status: "pending",
            createdAt: "2026-05-12T10:00:00.000Z",
          };
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = requestPluginInstallFactory(CTX);
    const result = await tool.execute("c1", {
      slug: "clawhub:dbalve/fast-io",
      reason: "need cloud storage tools",
    });
    assert.notEqual(result.isError, true);
    const text = extractText(result);
    assert.match(text, /Filed \*\*plugin\*\* install request/);
    assert.match(text, /clawhub:dbalve\/fast-io/);
    assert.match(text, /requestId: 42/);
    assert.match(text, /status: \*\*pending\*\*/);

    const body = capturedBody as Record<string, unknown>;
    assert.equal(body.kind, "plugin");
    assert.equal(body.slug, "clawhub:dbalve/fast-io");
    assert.equal(body.requestingAgentId, "anubis");
    assert.equal(body.reason, "need cloud storage tools");
    assert.equal(result.metadata?.requestId, 42);
    assert.equal(result.metadata?.requestStatus, "pending");
  });

  it("happy path without reason: omits reason field (null)", async () => {
    let capturedBody: unknown;
    pool()
      .intercept({
        path: "/api/extensions/install-requests",
        method: "POST",
      })
      .reply(
        201,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { requestId: 7, status: "pending" };
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = requestPluginInstallFactory(CTX);
    const result = await tool.execute("c2", {
      slug: "npm:@scope/pkg",
    });
    assert.notEqual(result.isError, true);
    const body = capturedBody as Record<string, unknown>;
    assert.equal(body.reason, null);
  });

  it("rejects empty slug", async () => {
    const tool = requestPluginInstallFactory(CTX);
    const result = await tool.execute("c3", { slug: "   " });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /request_plugin_install rejected/);
    assert.match(extractText(result), /slug must not be empty/);
  });

  it("rejects slug over 200 chars", async () => {
    const tool = requestPluginInstallFactory(CTX);
    const huge = "x".repeat(201);
    const result = await tool.execute("c4", { slug: huge });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /slug exceeds maximum length/);
  });

  it("rejects slug with control characters", async () => {
    const tool = requestPluginInstallFactory(CTX);
    const result = await tool.execute("c5", { slug: "bad\x01slug" });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /control characters/);
  });

  it("rejects reason over 50_000 chars", async () => {
    const tool = requestPluginInstallFactory(CTX);
    const huge = "x".repeat(50_001);
    const result = await tool.execute("c6", {
      slug: "clawhub:x/y",
      reason: huge,
    });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /exceeds maximum length/);
  });

  it("daemon failure: returns failedTextResult", async () => {
    pool()
      .intercept({
        path: "/api/extensions/install-requests",
        method: "POST",
      })
      .reply(500, "boom", { headers: { "content-type": "text/plain" } });

    const tool = requestPluginInstallFactory(CTX);
    const result = await tool.execute("c7", { slug: "clawhub:x/y" });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /request_plugin_install failed/);
    assert.match(extractText(result), /500/);
  });
});

// ---------------------------------------------------------------------------
// request_mcp_skill_install
// ---------------------------------------------------------------------------

describe("request_mcp_skill_install", () => {
  it("happy path: forwards kind=mcp_skill", async () => {
    let capturedBody: unknown;
    pool()
      .intercept({
        path: "/api/extensions/install-requests",
        method: "POST",
      })
      .reply(
        201,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { requestId: 99, status: "pending" };
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = requestMcpSkillInstallFactory(CTX);
    const result = await tool.execute("c1", {
      slug: "clawhub:org/skill",
      reason: "trying this out",
    });
    assert.notEqual(result.isError, true);
    const text = extractText(result);
    assert.match(text, /Filed \*\*MCP skill\*\* install request/);
    assert.match(text, /requestId: 99/);

    const body = capturedBody as Record<string, unknown>;
    assert.equal(body.kind, "mcp_skill");
    assert.equal(body.slug, "clawhub:org/skill");
    assert.equal(body.requestingAgentId, "anubis");
    assert.equal(body.reason, "trying this out");
  });

  it("rejects empty slug", async () => {
    const tool = requestMcpSkillInstallFactory(CTX);
    const result = await tool.execute("c2", { slug: "" });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /request_mcp_skill_install rejected/);
  });
});

// ---------------------------------------------------------------------------
// list_installed_plugins
// ---------------------------------------------------------------------------

describe("list_installed_plugins", () => {
  it("happy path: formats markdown table from daemon plugins list", async () => {
    pool()
      .intercept({ path: "/api/extensions/installed", method: "GET" })
      .reply(
        200,
        {
          plugins: [
            { slug: "openclaw-control-plugin" },
            { slug: "clawhub:dbalve/fast-io" },
          ],
          mcpSkills: [{ slug: "should-not-appear-in-plugins" }],
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = listInstalledPluginsFactory(CTX);
    const result = await tool.execute("c1", {});
    assert.notEqual(result.isError, true);
    const text = extractText(result);
    assert.match(text, /\| slug \|/);
    assert.match(text, /openclaw-control-plugin/);
    assert.match(text, /clawhub:dbalve\/fast-io/);
    assert.equal(text.includes("should-not-appear-in-plugins"), false);
    assert.equal(result.metadata?.count, 2);
  });

  it("empty plugins list: shows the empty marker", async () => {
    pool()
      .intercept({ path: "/api/extensions/installed", method: "GET" })
      .reply(
        200,
        { plugins: [], mcpSkills: [] },
        { headers: { "content-type": "application/json" } },
      );

    const tool = listInstalledPluginsFactory(CTX);
    const result = await tool.execute("c2", {});
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /no plugins installed/);
    assert.equal(result.metadata?.count, 0);
  });

  it("daemon failure (503 docker-not-wired): returns failedTextResult", async () => {
    pool()
      .intercept({ path: "/api/extensions/installed", method: "GET" })
      .reply(
        503,
        { error: "installed inventory unavailable: docker handle not injected" },
        { headers: { "content-type": "application/json" } },
      );

    const tool = listInstalledPluginsFactory(CTX);
    const result = await tool.execute("c3", {});
    assert.equal(result.isError, true);
    assert.match(extractText(result), /list_installed_plugins failed/);
    assert.match(extractText(result), /503/);
  });
});

// ---------------------------------------------------------------------------
// list_installed_mcp_skills
// ---------------------------------------------------------------------------

describe("list_installed_mcp_skills", () => {
  it("happy path: formats markdown table from daemon mcpSkills list", async () => {
    pool()
      .intercept({ path: "/api/extensions/installed", method: "GET" })
      .reply(
        200,
        {
          plugins: [{ slug: "should-not-appear" }],
          mcpSkills: [
            { slug: "clawhub:org/skill-a" },
            { slug: "clawhub:org/skill-b" },
          ],
        },
        { headers: { "content-type": "application/json" } },
      );

    const tool = listInstalledMcpSkillsFactory(CTX);
    const result = await tool.execute("c1", {});
    assert.notEqual(result.isError, true);
    const text = extractText(result);
    assert.match(text, /clawhub:org\/skill-a/);
    assert.match(text, /clawhub:org\/skill-b/);
    assert.equal(text.includes("should-not-appear"), false);
    assert.equal(result.metadata?.count, 2);
  });

  it("missing mcpSkills field: tolerates the shape (empty)", async () => {
    pool()
      .intercept({ path: "/api/extensions/installed", method: "GET" })
      .reply(
        200,
        { plugins: [] },
        { headers: { "content-type": "application/json" } },
      );

    const tool = listInstalledMcpSkillsFactory(CTX);
    const result = await tool.execute("c2", {});
    assert.notEqual(result.isError, true);
    assert.match(extractText(result), /no MCP skills installed/);
  });
});

// ---------------------------------------------------------------------------
// search_clawhub  (STUB — daemon route NYI as of Batch 8c)
// ---------------------------------------------------------------------------

describe("search_clawhub", () => {
  it("returns 'not yet available' failure when daemon route is unimplemented", async () => {
    // NO interceptor — the tool must NOT make a daemon HTTP call because the
    // route doesn't exist. MockAgent has `disableNetConnect` set, so any
    // round-trip would fail loudly.
    const tool = searchClawhubFactory(CTX);
    const result = await tool.execute("c1", { query: "browser automation" });
    assert.equal(result.isError, true);
    const text = extractText(result);
    assert.match(text, /search_clawhub is not yet available/);
    assert.match(text, /\/api\/extensions\/clawhub\/search/);
    assert.match(text, /openclaw plugins search/);
    assert.equal(result.metadata?.error, "not_yet_available");
    assert.equal(result.metadata?.query, "browser automation");
  });

  it("validates kind filter is passed through to metadata", async () => {
    const tool = searchClawhubFactory(CTX);
    const result = await tool.execute("c2", {
      query: "io",
      kind: "skill",
    });
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.kind, "skill");
  });

  it("rejects empty query (after trim)", async () => {
    const tool = searchClawhubFactory(CTX);
    const result = await tool.execute("c3", { query: "   " });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /search_clawhub rejected/);
    assert.match(extractText(result), /query must not be empty/);
  });

  it("rejects query over 50_000 chars", async () => {
    const tool = searchClawhubFactory(CTX);
    const huge = "x".repeat(50_001);
    const result = await tool.execute("c4", { query: huge });
    assert.equal(result.isError, true);
    assert.match(extractText(result), /exceeds maximum length/);
  });
});
