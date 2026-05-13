// Plugin smoke test — instantiates the plugin's `register(api)` with a mock
// api that records `registerTool` calls. Asserts exactly 12 tools register
// (invoke_ptah + 6 daemon CRUD + 5 install/clawhub per Batch 8c), with the
// expected names, and that `start_harness_setup` is NOT present (amendment
// §3.10 removes it entirely).

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";

import type {
  OpenClawPluginToolFactory,
  PluginApi,
  PluginEntry,
} from "../src/sdk/plugin-entry.ts";

// Populated in before() after env is wired up so config.ts doesn't throw.
let entry: PluginEntry;

before(async () => {
  process.env.OPENCLAW_INTERNAL_TOKEN = "test-token-xyz";
  process.env.OPENCLAW_DAEMON_URL = "http://daemon.test:7878";

  const mod = await import("../src/index.ts");
  entry = mod.default as PluginEntry;
});

interface RegisteredTool {
  name: string;
  factory: OpenClawPluginToolFactory;
}

function buildMockApi(): { api: PluginApi; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const api: PluginApi = {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: (factory, opts) => {
      registered.push({ name: opts.name, factory });
    },
  };
  return { api, registered };
}

describe("plugin smoke — register()", () => {
  it("registers exactly 12 tools with the expected names", () => {
    const { api, registered } = buildMockApi();
    entry.register(api);

    const names = registered.map((r) => r.name);
    assert.equal(
      registered.length,
      12,
      `expected 12 tools, got ${registered.length}: ${names.join(", ")}`,
    );
    assert.deepEqual(names.sort(), [
      "approve_task",
      "create_task",
      "get_task",
      "handoff_task",
      "invoke_ptah",
      "list_installed_mcp_skills",
      "list_installed_plugins",
      "list_projects",
      "list_tasks",
      "request_mcp_skill_install",
      "request_plugin_install",
      "search_clawhub",
    ]);
  });

  it("does NOT register start_harness_setup", () => {
    const { api, registered } = buildMockApi();
    entry.register(api);
    const names = registered.map((r) => r.name);
    assert.equal(
      names.includes("start_harness_setup"),
      false,
      "start_harness_setup must not be registered (amendment §3.10)",
    );
  });

  it("does NOT register tick_continuation or dispatch_orchestration_task", () => {
    const { api, registered } = buildMockApi();
    entry.register(api);
    const names = registered.map((r) => r.name);
    assert.equal(names.includes("tick_continuation"), false);
    assert.equal(names.includes("dispatch_orchestration_task"), false);
  });

  it("emits a logger.info line announcing 12 tools registered", () => {
    const messages: string[] = [];
    const api: PluginApi = {
      logger: {
        info: (m) => messages.push(m),
      },
      registerTool: () => {},
    };
    entry.register(api);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /registered 12 tools/);
  });

  it("plugin entry has the expected id/name/description shape", () => {
    assert.equal(entry.id, "openclaw-control-plugin");
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.description, "string");
    assert.equal(typeof entry.register, "function");
  });
});
