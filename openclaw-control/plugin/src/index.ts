// openclaw-control-plugin — entry point.
//
// Batch 4 wires in the first real tool (`invoke_ptah`). The 6 daemon-CRUD
// tools land in Batch 5; the 5 install/clawhub tools land in Batch 8c.
//
// SDK imports resolve through tsconfig path aliases in the dev tree (see
// `src/sdk/README.md`). Batch 7's Dockerfile drops the aliases and the
// shims; the bare specifiers then resolve against the openclaw peer
// installed at `/usr/lib/node_modules/openclaw/`.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { invokePtahFactory } from "./tools/invokePtah.js";

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description: "Daemon CRUD tools + invoke_ptah for openclaw-control.",
  register(api) {
    api.registerTool(invokePtahFactory, { name: "invoke_ptah" });

    api.logger.info(
      "[openclaw-control-plugin] registered 1 tool (invoke_ptah)",
    );
  },
});
