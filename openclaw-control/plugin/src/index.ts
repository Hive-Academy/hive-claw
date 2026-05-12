// openclaw-control-plugin — entry point (Batch 2 skeleton)
//
// Batch 2 ships build-only boilerplate. No tools are registered yet:
//   - Batch 4 adds invoke_ptah
//   - Batch 5 adds the 6 daemon-CRUD tools
//   - Batch 8c adds the 5 install/clawhub tools
//
// Once openclaw/plugin-sdk is resolvable (peerDep on openclaw >=2026.4.24
// satisfied at runtime by the host install), this file will switch to:
//
//   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
//
// For now we expose a structurally-compatible default export so the bundled
// dist/index.js is loadable and the plugin loader sees a no-op register().

type PluginApi = {
  logger: { info: (msg: string) => void };
};

type PluginEntry = {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi) => void;
};

// Local shim of openclaw/plugin-sdk's definePluginEntry — identity function
// that pins the return shape. Replaced by the real import in Batch 4.
function definePluginEntry(entry: PluginEntry): PluginEntry {
  return entry;
}

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description:
    "Daemon CRUD tools + invoke_ptah for openclaw-control. (Skeleton — no tools registered yet.)",
  register(api) {
    api.logger.info(
      "[openclaw-control-plugin] stub online — no tools registered yet",
    );
  },
});
