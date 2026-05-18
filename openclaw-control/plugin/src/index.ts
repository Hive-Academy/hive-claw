// openclaw-control-plugin — entry point.
//
// Batch 4 wired `invoke_ptah`. Batch 5 added the six daemon-CRUD tools.
// Batch 8c adds the 5 extension-install / clawhub tools per amendment §16.4.
// Follow-up: `create_project` tool + agent-status heartbeat (replaces the
// bot-bridge Redis publish that disappeared at cutover).
// Batch 12: MCP bridge — exposes gateway-tier MCP servers (Zernio, GitHub,
// etc.) to Discord chat via `mcp__<server>__<tool>` namespaced tools.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { invokePtahFactory } from "./tools/invokePtah.js";
import {
  listProjectsFactory,
  createProjectFactory,
  listTasksFactory,
  getTaskFactory,
  createTaskFactory,
  approveTaskFactory,
  handoffTaskFactory,
} from "./tools/daemonCrud.js";
import {
  requestPluginInstallFactory,
  requestMcpSkillInstallFactory,
  listInstalledPluginsFactory,
  listInstalledMcpSkillsFactory,
  searchClawhubFactory,
} from "./tools/extensions.js";
import { daemon } from "./daemonClient.js";
import { buildMcpBridge } from "./tools/mcpBridge.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

function parseLocalAgentIds(): string[] {
  return (process.env.OPENCLAW_LOCAL_AGENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeats(logger: { info(msg: string): void }): void {
  const ids = parseLocalAgentIds();
  if (ids.length === 0) {
    logger.info(
      "[openclaw-control-plugin] OPENCLAW_LOCAL_AGENT_IDS empty — no heartbeats published",
    );
    return;
  }
  const beat = () => {
    for (const id of ids) {
      daemon.agentHeartbeat(id, { status: "online" }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[openclaw-control-plugin] heartbeat ${id} failed: ${msg}`);
      });
    }
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  logger.info(
    `[openclaw-control-plugin] heartbeat started for ${ids.length} agent(s) — every ${HEARTBEAT_INTERVAL_MS / 1000}s`,
  );
}

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description:
    "Daemon CRUD tools + invoke_ptah + extension install/ClawHub + MCP bridge for openclaw-control.",
  register(api) {
    api.registerTool(invokePtahFactory, { name: "invoke_ptah" });
    api.registerTool(listProjectsFactory, { name: "list_projects" });
    api.registerTool(createProjectFactory, { name: "create_project" });
    api.registerTool(listTasksFactory, { name: "list_tasks" });
    api.registerTool(getTaskFactory, { name: "get_task" });
    api.registerTool(createTaskFactory, { name: "create_task" });
    api.registerTool(approveTaskFactory, { name: "approve_task" });
    api.registerTool(handoffTaskFactory, { name: "handoff_task" });

    api.registerTool(requestPluginInstallFactory, {
      name: "request_plugin_install",
    });
    api.registerTool(requestMcpSkillInstallFactory, {
      name: "request_mcp_skill_install",
    });
    api.registerTool(listInstalledPluginsFactory, {
      name: "list_installed_plugins",
    });
    api.registerTool(listInstalledMcpSkillsFactory, {
      name: "list_installed_mcp_skills",
    });
    api.registerTool(searchClawhubFactory, { name: "search_clawhub" });

    api.logger.info(
      "[openclaw-control-plugin] registered 13 tools (invoke_ptah + 7 daemon CRUD + 5 install/clawhub)",
    );

    startHeartbeats(api.logger);

    // Batch 12: asynchronously discover and register gateway MCP tools.
    buildMcpBridge()
      .then(({ factories, cleanup }) => {
        for (const { name, factory } of factories) {
          api.registerTool(factory, { name });
        }
        api.logger.info(
          `[openclaw-control-plugin] registered ${factories.length} MCP bridge tool(s)`,
        );
        const doCleanup = () => {
          cleanup().catch(() => {});
        };
        process.once("SIGTERM", doCleanup);
        process.once("SIGINT", doCleanup);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error?.(
          `[openclaw-control-plugin] MCP bridge failed: ${msg}`,
        );
      });
  },
});
