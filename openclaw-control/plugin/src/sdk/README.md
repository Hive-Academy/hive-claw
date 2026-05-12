# `src/sdk/` — temporary openclaw plugin-sdk shim

## Why this exists

The openclaw runtime ships its plugin-sdk under the bare-specifier subpaths
`openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/typebox`, and
`openclaw/plugin-sdk/agent-runtime`. Those modules are only resolvable inside
the openclaw container image where `openclaw` is installed as a node_module
under `/usr/lib/node_modules/openclaw/`.

In this dev tree, `openclaw` is **only** a `peerDependency` of the plugin
package — not an installed dep — so the bare specifiers cannot be resolved
by `tsc` or `tsx`. To keep the build/test loop self-contained we use
**Strategy (c)** from TASK_2026_006 Batch 4: **tsconfig path aliases** that
point each `openclaw/plugin-sdk/*` subpath at a local shim file in this
directory.

## What each shim provides

- `typebox.ts` — re-exports `@sinclair/typebox`. The plugin-sdk's `typebox`
  subpath is itself a re-export of upstream typebox, so this is API-compatible
  for the surface we use (`Type`, `Static`).
- `plugin-entry.ts` — local definitions of `definePluginEntry`,
  `OpenClawPluginToolFactory`, and the `PluginApi` shape used by `register()`.
  Identity-style runtime implementation that pins the type contract.
- `agent-runtime.ts` — local implementations of `textResult` / `failedTextResult`
  plus the `AnyAgentTool` / `AgentToolResult` types. These are trivial (≤10 LOC
  helpers that wrap a `{ content: [{ type: "text", text }] }` envelope).

## What Batch 7 needs to do

When the Dockerfile gains a `plugin-builder` stage with openclaw installed,
the real bare-specifier imports will resolve. Then:

1. Delete this directory.
2. Remove the `paths` block from `tsconfig.json`.
3. Remove `@sinclair/typebox` from `devDependencies` (the real
   `openclaw/plugin-sdk/typebox` re-exports its own copy).

No imports in `src/**/*.ts` need to change — they already write
`openclaw/plugin-sdk/...` style imports. With the paths block gone, the
resolver falls through to `node_modules/openclaw/plugin-sdk/...` provided
by the openclaw peer.
