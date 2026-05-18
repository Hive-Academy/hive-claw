// openclaw-control-plugin — entry point.
//
// Batch 4 wired `invoke_ptah`. Batch 5 added the six daemon-CRUD tools.
// Batch 8c adds the 5 extension-install / clawhub tools per amendment §16.4.
// Batch 12: MCP bridge — exposes gateway-tier MCP servers (Zernio, GitHub,
// etc.) to Discord chat via `mcp__<server>__<tool>` namespaced tools.
//
// SDK imports resolve through tsconfig path aliases in the dev tree (see
// `src/sdk/README.md`). Batch 7's Dockerfile drops the aliases and the
// shims; the bare specifiers then resolve against the openclaw peer
// installed at `/usr/lib/node_modules/openclaw/`.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { invokePtahFactory } from "./tools/invokePtah.js";
import {
  listProjectsFactory,
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
import { buildMcpBridge } from "./tools/mcpBridge.js";

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description:
    "Daemon CRUD tools + invoke_ptah + extension install/ClawHub + MCP bridge for openclaw-control.",
  register(api) {
    api.registerTool(invokePtahFactory, { name: "invoke_ptah" });
    api.registerTool(listProjectsFactory, { name: "list_projects" });
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
      "[openclaw-control-plugin] registered 12 tools (invoke_ptah + 6 daemon CRUD + 5 install/clawhub)",
    );

    // Batch 12: asynchronously discover and register gateway MCP tools.
    // The gateway's internal MCP runtime is not exposed to plugins, so we
    // spawn our own MCP clients from the same openclaw.json config.
    buildMcpBridge()
      .then(({ factories, cleanup }) => {
        for (const { name, factory } of factories) {
          api.registerTool(factory, { name });
        }
        api.logger.info(
          `[openclaw-control-plugin] registered ${factories.length} MCP bridge tool(s)`,
        );

        // Hook graceful cleanup into process signals.
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
