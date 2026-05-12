// openclaw-control-plugin — entry point.
//
// Batch 4 wired `invoke_ptah`. Batch 5 adds the six daemon-CRUD tools below.
// The 5 install/clawhub tools land in Batch 8c.
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

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description: "Daemon CRUD tools + invoke_ptah for openclaw-control.",
  register(api) {
    api.registerTool(invokePtahFactory, { name: "invoke_ptah" });
    api.registerTool(listProjectsFactory, { name: "list_projects" });
    api.registerTool(listTasksFactory, { name: "list_tasks" });
    api.registerTool(getTaskFactory, { name: "get_task" });
    api.registerTool(createTaskFactory, { name: "create_task" });
    api.registerTool(approveTaskFactory, { name: "approve_task" });
    api.registerTool(handoffTaskFactory, { name: "handoff_task" });

    api.logger.info(
      "[openclaw-control-plugin] registered 7 tools (invoke_ptah + 6 daemon CRUD)",
    );
  },
});
