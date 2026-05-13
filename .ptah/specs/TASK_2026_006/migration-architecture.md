# TASK_2026_006 — Migration architecture: openclaw-native multi-agent

**Author:** software-architect
**Date:** 2026-05-12
**Status:** DRAFT — pending user approval before team-leader decomposition
**Branch:** `ak/fix-internal-calls` (do not merge to main)
**Recovery anchor:** tag `pre-task-2026-006-cleanup`
**Inputs:** `context.md`, `research-findings.md` (the four corrections in §Recommendations and §B4-addendum are treated as ground truth and override context.md where they conflict)

---

## 0. Reading guide

This document tells the team-leader what to build, in what order, and how to verify each step. It is intentionally long. Sections are self-contained — the team-leader can decompose §2 (component inventory) and §10 (migration sequence) into the first wave of batched tasks without needing to re-read the rest, but §7 (persona privacy) and §8 (multi-machine flow) are mandatory reading for any developer touching agent isolation or handoff.

Cross-references use the form `§N.M` for sections of this document, `research §X` for research-findings.md, and `context §Y` for context.md.

---

## 1. Target architecture diagram

### 1.1 Post-migration host topology (single machine)

```
                              HOST OS (the user's laptop / server)
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  PID 2314: openclaw  ─────────────────────────────────────────────────┐         │
│  ┌──────────────────────────────────────────────────────────────────┐ │         │
│  │ openclaw gateway @ :18789                                        │ │         │
│  │                                                                  │ │         │
│  │  agents.list:                                                    │ │         │
│  │     anubis  (workspace=/home/agent/.openclaw/workspace/anubis)   │ │         │
│  │     horus   (workspace=/home/agent/.openclaw/workspace/horus)    │ │         │
│  │                                                                  │ │         │
│  │  channels.discord.accounts:                                      │ │         │
│  │     anubis → DISCORD_TOKEN_ANUBIS   (Anubis bot user)            │ │         │
│  │     horus  → DISCORD_TOKEN_HORUS    (Horus bot user)             │ │         │
│  │                                                                  │ │         │
│  │  bindings:                                                       │ │         │
│  │     { channel:"discord", accountId:"anubis" } → agentId:"anubis" │ │         │
│  │     { channel:"discord", accountId:"horus"  } → agentId:"horus"  │ │         │
│  │                                                                  │ │         │
│  │  ┌────────────────────────────────────────────────────────────┐  │ │         │
│  │  │ Plugin: openclaw-control-plugin (in-process module)        │  │ │         │
│  │  │   registerTool("invoke_ptah", …)                           │  │ │         │
│  │  │   registerTool("list_projects" / "list_tasks" / …)         │  │ │         │
│  │  │   registerTool("create_task" / "approve_task" / …)         │  │ │         │
│  │  │   registerTool("handoff_task" / "start_harness_setup")     │  │ │         │
│  │  │                                                            │  │ │         │
│  │  │   daemonClient (HTTP undici)  ─────────► to daemon @ :7878 │  │ │         │
│  │  │   ptahLauncher (spawn or bridge HTTP) ─► to ptah-bridge    │  │ │         │
│  │  └────────────────────────────────────────────────────────────┘  │ │         │
│  └──────────────────────────────────────────────────────────────────┘ │         │
│                                                                       │         │
│  PID 2572: daemon  ────────────────────────────────────────────────┐  │         │
│  ┌─────────────────────────────────────────────────────────────┐   │  │         │
│  │ openclaw-control daemon @ :7878                             │◄──┼──┘         │
│  │   /api/projects, /api/tasks, /api/memories/* …              │   │            │
│  │   leader: opens /data/specs.db (SQLite v4)                  │   │            │
│  │   follower: HTTP-client to leader                           │   │            │
│  │   dashboard SPA served at /                                 │   │            │
│  │   SSE /api/stream for live UI updates                       │   │            │
│  └─────────────────────────────────────────────────────────────┘   │            │
│                                                                    │            │
│  PID 1092: ptah-bridge ────────────────────────────────────────┐   │            │
│  ┌──────────────────────────────────────────────────────────┐  │   │            │
│  │ scripts/ptah-bridge.mjs                                  │◄─┼───┤            │
│  │   spawns `ptah` on host on behalf of plugin or daemon    │  │   │            │
│  │   identity path translation for ~/.ptah/...              │  │   │            │
│  └──────────────────────────────────────────────────────────┘  │   │            │
│                                                                │   │            │
│  PID 2598: OLD bot-bridge — STOPPED AND REMOVED post-cutover  ─┘   │            │
│                                                                    │            │
└────────────────────────────────────────────────────────────────────┼────────────┘
                                                                     │
                                  HTTP (only for cross-machine work) │
                                                                     ▼
                              FOLLOWER MACHINE (different host, same layout)
                              openclaw-control daemon @ :7878 in follower mode
                              connects back to leader's daemon for project state
```

**Process count post-migration:** 3 (openclaw + daemon + ptah-bridge) versus today's 4 (the four PIDs above). One fewer Node process to manage.

### 1.2 Logical layers per machine

```
   ┌─────────────────────────────────────────┐
   │ Discord (external)                      │
   └────────────┬────────────────────────────┘
                │ websocket: openclaw owns the gateway connection
                ▼
   ┌─────────────────────────────────────────┐
   │ openclaw gateway (PID 2314)             │
   │   • channels.discord.accounts.*         │
   │   • bindings[] resolves agent           │
   │   • per-agent tool policy + LLM call    │
   │   • plugin: openclaw-control-plugin     │
   └────────────┬────────────────────────────┘
                │ HTTP (undici) over localhost
                ▼
   ┌─────────────────────────────────────────┐
   │ daemon (PID 2572)                       │
   │   • /api/projects, /api/tasks           │
   │   • /api/memories/* (privacy gate)      │
   │   • SQLite specs.db on leader           │
   │   • SSE /api/stream → dashboard         │
   └────────────┬────────────────────────────┘
                │ HTTP fallback when invoke_ptah is requested
                ▼ (only on invoke_ptah; daemon is NOT required for chat)
   ┌─────────────────────────────────────────┐
   │ ptah-bridge (PID 1092)                  │
   │   • spawns ptah on host, streams stdout │
   └─────────────────────────────────────────┘
```

### 1.3 Multi-machine topology

```
   ┌─────── LEADER machine ───────┐         ┌─────── FOLLOWER machine ───────┐
   │ openclaw (anubis bot)        │         │ openclaw (horus bot)           │
   │   + openclaw-control-plugin  │         │   + openclaw-control-plugin    │
   │   listens for DISCORD_TOKEN  │         │   listens for DISCORD_TOKEN    │
   │   _ANUBIS                    │         │   _HORUS                       │
   │                              │         │                                │
   │ daemon (leader)              │◄────────┤ daemon (follower)              │
   │   /data/specs.db (SQLite v4) │  HTTP   │   no local DB                  │
   │   dashboard, SSE             │  Bearer │   relays to leader             │
   │                              │  token  │                                │
   │ ptah-bridge                  │         │ ptah-bridge                    │
   └──────────────────────────────┘         └────────────────────────────────┘
```

Each machine binds its own personas via `OPENCLAW_LOCAL_AGENT_IDS`. Cross-machine handoff lives at the daemon layer (project + task state), not the openclaw layer. **There is no openclaw-to-openclaw RPC.** See §8 for the concrete handoff flow.

---

## 2. Component inventory (the cut list)

Legend:

- **KEEP** — file/dir stays unchanged post-migration.
- **MOVE** — file/dir relocates into the plugin package (verbatim or near-verbatim).
- **DELETE** — file/dir gets removed; functionality lives in openclaw config or openclaw built-ins.
- **MERGE-PLUGIN** — file/dir's content gets folded into one of the plugin's new modules.
- **MERGE-CONFIG** — file/dir's content moves into `config/openclaw.json.tmpl`.
- **REWRITE** — file stays but is substantially rewritten as part of this migration.

### 2.1 `openclaw-control/bot-bridge/src/` (current 13 source files + 4 subdirs)

| Path | Decision | Rationale |
|------|----------|-----------|
| `index.ts` (211 lines) | **DELETE** | Discord client lifecycle is openclaw's job now. The harness/sync subscriber moves to the daemon (already publishes on Redis `harness/sync`; with the plugin in-process, sync hot-reload is replaced by openclaw's plugin reload — see §6.2). |
| `chat.ts` (548 lines) | **DELETE** | Openclaw drives the chat loop natively from the Discord channel adapter. |
| `llm.ts` (428 lines) | **DELETE** | Openclaw owns LLM provider connections via its `models.providers` config. |
| `commandRouter.ts` (120 lines) | **DELETE** | Openclaw has its own command surface; we don't use it for v1. Operator commands (`!ping`, `!skip`, etc.) become Discord messages routed via the standard bindings. |
| `agentRegistry.ts` (172 lines) | **DELETE** | Discord token + persona loading is openclaw's job. The plugin reads `process.env.OPENCLAW_INTERNAL_TOKEN` directly; persona content is no longer rendered into a system prompt by us — openclaw uses its own per-agent system-prompt assembly (driven by `agents.list[].instructions` or persona memory files mounted under the agent workspace). |
| `harnessAuthor.ts` (668 lines) | **DELETE** | The "harness setup" tool just opens a guided edit flow against `<project>/.claude/harness.yaml`. In the new world the operator edits the file directly via project-files daemon endpoints, or we re-implement as a thin plugin tool in Phase 2. Out of scope for v1 cutover. |
| `daemonClient.ts` (310 lines) | **MOVE → plugin/src/daemonClient.ts** | Verbatim; the plugin needs exactly this HTTP client. Drops the `emitSseHint` helper (openclaw's own observability replaces it). Drops `tickContinuation`-related code paths (removed in TASK_004 already). |
| `config.ts` (71 lines) | **MOVE-AND-PRUNE → plugin/src/config.ts** | Keep `daemonUrl`, `internalToken`. Drop everything else (LLM provider config, Redis URL, attachment caps, vision model, command prefix, harness-author timeout). |
| `harness/types.ts` | **DELETE** | The plugin no longer parses harness.yaml; openclaw's per-agent config does the persona-shape work. The daemon's mirror copy (`daemon/src/harness/types.ts`) stays — daemon still materializes per-agent ptah scope. |
| `tools/daemonTools.ts` (348 lines, 7 active tools after TASK_004 + 2 dead names) | **REWRITE → plugin/src/tools/daemonCrud.ts** | The 7 daemon CRUD tools survive as openclaw plugin tool factories. The two dead names (`tick_continuation`, `dispatch_orchestration_task`) do NOT come over — TASK_004 already removed their daemon backends. |
| `tools/discordTools.ts` (757 lines: `read_channel_history`, `upload_attachment`) | **DELETE** | Openclaw's Discord channel adapter has its own primitives for reading channel history and posting files. We migrate behavior to openclaw built-ins if missing — but not in v1. v1 cutover ships without these two tools and re-introduces them via a follow-up batch only if the operator misses them. |
| `tools/subagentTools.ts` (162 lines) | **DELETE** | Subagents are now openclaw's `subagents` config or its built-in `subagents`/`sessions_*` tools. |
| `tools/mcpTools.ts` (65 lines) | **DELETE** | Replaced by openclaw's bundled-MCP runtime + `config.mcp.servers` (see §5). |
| `tools/index.ts` (64 lines) | **DELETE** | Plugin tool registration is per-tool via `api.registerTool()`, not via a meta-registry. |
| `mcp/mcpManager.ts` (808 lines) | **DELETE** | See §5. Openclaw's bundled-MCP runtime owns this lifecycle. |
| `subagents/subagentRunner.ts` (290 lines) | **DELETE** | Openclaw's subagent system replaces it. |
| `skills/skillLoader.ts` (122 lines) | **DELETE** | Skills move into the openclaw plugin loader (`config.plugins` + claude-format bundles). |
| `skills/harnessSync.ts` (123 lines) | **DELETE** | Hot-reload subscriber is no longer needed: the openclaw gateway reloads its own plugin if the config changes, and persona changes propagate via openclaw's config-reload path. Daemon's `publishHarnessSync` Redis publisher stays for now but its only consumer disappears (Phase 2 candidate for full removal). |

### 2.2 `openclaw-control/bot-bridge/` package level

| Path | Decision |
|------|----------|
| `package.json` | **REWRITE** — see §3.2. New name (§12), new deps (drop discord.js, ioredis, MCP SDK, gray-matter; add nothing — undici is in openclaw's deps already, typebox comes via openclaw plugin SDK re-exports). |
| `tsconfig.json` | **KEEP** — should still compile to `dist/`. Adjust `outDir` if we relocate the package. |
| `test/` | **REWRITE** — current tests cover the deleted chat tier. Replace with the smoke tests in §13. |
| `dist/` | **DELETE** — rebuild artifact. |
| `node_modules/`, `package-lock.json` | **REGENERATE** — fewer deps. |

### 2.3 `openclaw-control/daemon/src/` (mostly survives)

| Path | Decision | Notes |
|------|----------|-------|
| `api.ts` (997 lines) | **REWRITE — surgical** | See §6.3 for the route-by-route survival matrix. |
| `auth.ts` (203 lines) | **KEEP** | The three doors stay: cookie-JWT for the dashboard, internal-token Bearer for the plugin, anonymous local-dev. |
| `bus.ts` (171 lines) | **KEEP, but `publishHarnessSync` becomes dormant** | Redis pub/sub still used for cross-machine handoff notifications and dashboard SSE bridging. `publishHarnessSync` survives in case Phase 2 wants it back. |
| `config.ts` (108 lines) | **KEEP** | Adds nothing; loses nothing. |
| `continuation.ts` (342 lines) | **KEEP (dormant — no caller)** | Phase 2/3 deletion candidate (context §6). Stays on disk through Phase 1 so the team-leader doesn't have to thread a removal into the cutover. |
| `dispatch.ts` (331 lines) | **KEEP (dormant — no caller)** | Same logic as continuation.ts: Phase 2/3 removal. |
| `invoker.ts` (104 lines) | **KEEP (dormant)** | Used only by the now-dormant dispatch worker. |
| `db/dispatches.ts` (556 lines) | **KEEP (dormant data)** | Schema v4 already contains the table. Leaving rows untouched is harmless. |
| `db/{client,index,memory,migrations,projects,schema,tasks}.ts` | **KEEP** | All actively used. |
| `harness/licenseGuard.ts` (62 lines) | **KEEP** | Guards orchestration-tier license usage during materialize. Still relevant: the plugin's `invoke_ptah` runs ptah, which the licenseGuard inspects. |
| `harness/materialize.ts` (378 lines) | **KEEP** | Still materializes per-agent ptah settings the plugin reads. |
| `harness/outboundGuard.ts` (115 lines) | **KEEP** | Still gates outbound ptah JSON-RPC. |
| `harness/ptahLauncher.ts` (291 lines) | **KEEP** | The plugin's `invoke_ptah` tool delegates to this via the daemon's `ptahBridge` HTTP surface, OR (alternative we'll discuss) imports it directly. v1 decision: **call through daemon HTTP** to preserve the trust boundary. See §3.4. |
| `harness/types.ts` (233 lines) | **KEEP** | The daemon still parses harness.yaml for materialize. |
| `memory.ts` (323 lines) | **KEEP** | Layers 1-4 of persona privacy live here unchanged. |
| `leaderClient.ts` (847 lines) | **KEEP** | Follower → leader HTTP relay. Still needed for multi-machine. |
| `phase.ts` (104 lines) | **KEEP** | Used by approve/handoff routes. |
| `projects.ts` (101 lines) | **KEEP**. |
| `ptahBridge.ts` (222 lines) | **KEEP** | The plugin reaches ptah via this daemon-side wrapper (preserves the trust boundary; see §3.4). |
| `sessions.ts`, `sse.ts`, `storage.ts`, `watcher.ts`, `agents.ts`, `index.ts`, `types/fastify.d.ts` | **KEEP**. |
| `db/dispatches.ts`-using routes in `api.ts` (`/api/dispatches/*`) | **KEEP (dormant)** | No caller in the new world. Stay because removing them is mechanical and out of scope for cutover. Dashboard may still render them for historical inspection. |

### 2.4 `config/openclaw.json.tmpl`

**REWRITE** — see §4. This is the single biggest config change in the migration.

### 2.5 Infrastructure

| Path | Decision |
|------|----------|
| `Dockerfile` | **REWRITE** — stages 3 (`bot-builder`) and the runtime COPY of bot-bridge get reshaped to install the plugin into `/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/` (Option A from research §B5). |
| `entrypoint.sh` | **MODIFY** — drop the `bot-bridge` env vars no longer needed; add `DISCORD_TOKEN_ANUBIS`, `DISCORD_TOKEN_HORUS` interpolation. |
| `entrypoint-control.sh` | **MODIFY** — drop the bot-bridge spawn line; daemon and dashboard continue. |
| `docker-compose.yml` | **MODIFY** — drop the no-longer-needed env vars. New ones added. Same single container topology. |
| `scripts/ptah-bridge.mjs` | **KEEP**. |
| Whatever launches the host stack today (systemd? script?) | **CLARIFICATION NEEDED** — see §9. |

### 2.6 Dashboard

| Path | Decision |
|------|----------|
| `openclaw-control/dashboard/**` | **KEEP**, with **cleanup pass** for dead UI surfaces that referenced HITL/continuation flows the cancelled TASK_004 work introduced. Final state: the dashboard reads daemon state via the surviving daemon HTTP routes, no orchestration-tier UI changes required for v1 cutover. |

---

## 3. The plugin in detail: `openclaw-control-plugin`

### 3.1 File layout

```
openclaw-control/plugin/                         # renamed from bot-bridge/ — see §12
├── package.json                                 # see §3.2
├── openclaw.plugin.json                         # plugin manifest — see §3.3
├── tsconfig.json                                # output dist/, target ES2022, module ESM
├── README.md                                    # one-paragraph: what this is, how to build
├── src/
│   ├── index.ts                                 # plugin entry — definePluginEntry, register() — see §3.5
│   ├── config.ts                                # reads OPENCLAW_INTERNAL_TOKEN, OPENCLAW_DAEMON_URL — see §3.6
│   ├── daemonClient.ts                          # HTTP client to daemon @ :7878 (the surviving MOVE from bot-bridge) — see §3.7
│   ├── ptahLauncher.ts                          # invokes ptah via daemon's /api/ptah/invoke (NEW thin route) — see §3.8
│   └── tools/
│       ├── invokePtah.ts                        # AnyAgentTool: invoke_ptah(project, prompt) — see §3.9
│       └── daemonCrud.ts                        # 7 AnyAgentTool factories: list_projects, list_tasks, get_task, create_task, approve_task, handoff_task, start_harness_setup — see §3.10
└── test/
    ├── tools.invokePtah.test.ts                 # unit: param schema, daemon HTTP fault → failedTextResult
    ├── tools.daemonCrud.test.ts                 # unit: each tool's daemon stub round-trip
    ├── config.test.ts                           # unit: env-var fallback
    └── smoke.plugin.test.ts                     # integration: register() emits 8 tool registrations
```

### 3.2 `package.json` — concrete shape

```json
{
  "name": "@openclaw-control/plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "peerDependencies": {
    "openclaw": ">=2026.4.24"
  },
  "dependencies": {
    "undici": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Pinning notes:**

- `peerDependencies.openclaw: ">=2026.4.24"` — research §B1 confirms this is the lower bound that has the issue-59047 fix. Use range, not exact pin, because the gateway dependency is installed globally and we don't want a refusal to load on a patch bump.
- `dependencies.undici: "^6.0.0"` — matches the version openclaw itself uses internally (`/usr/lib/node_modules/openclaw/node_modules/undici/package.json`). One-arrow protocol against drift.
- No `typebox` direct dep. Use `import { Type } from "openclaw/plugin-sdk/typebox"` — openclaw re-exports typebox so we don't need a second copy in node_modules.
- No `discord.js`, no `ioredis`, no `@modelcontextprotocol/sdk`, no `gray-matter`. All deleted.

### 3.3 `openclaw.plugin.json` — manifest

```json
{
  "id": "openclaw-control-plugin",
  "name": "OpenClaw Control Plugin",
  "description": "Daemon CRUD tools + invoke_ptah custom tool for the openclaw-control fleet.",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "daemonUrl":     { "type": "string", "description": "Override OPENCLAW_DAEMON_URL." },
      "ptahTimeoutMs": { "type": "number", "description": "Max ptah subprocess runtime in ms (default 1800000)." }
    }
  }
}
```

**`pluginApi` version note:** there is no separate `pluginApi` version key in openclaw's plugin manifest at v2026.4.24 (research §B1 shows no such field in `OpenClawPluginApi`). The peerDependency on `openclaw >=2026.4.24` is the SDK pin.

### 3.4 Boundary decision: how the plugin reaches ptah

Two viable shapes. We pick the second.

| Shape | Pros | Cons |
|-------|------|------|
| **A. Plugin imports daemon's `ptahLauncher` directly** | Zero extra HTTP hop; faster path | Plugin depends on daemon internals; trust boundary blurred; daemon and plugin must ship in lockstep |
| **B. Plugin POSTs to a new daemon route `/api/ptah/invoke` that wraps `ptahLauncher`** | Trust boundary preserved (the plugin authenticates with the same internal token it uses for CRUD); plugin and daemon can evolve independently; matches the existing pattern (`emitSseHint`, project-files, etc) | One extra HTTP hop; daemon route is new |

**Decision: B.** The migration explicitly preserves the daemon-as-trust-boundary model. A new route `POST /api/ptah/invoke` lands in §6.1.

### 3.5 `src/index.ts` — the entry point (concrete TS)

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { invokePtahFactory } from "./tools/invokePtah.js";
import {
  listProjectsFactory,
  listTasksFactory,
  getTaskFactory,
  createTaskFactory,
  approveTaskFactory,
  handoffTaskFactory,
  startHarnessSetupFactory,
} from "./tools/daemonCrud.js";

export default definePluginEntry({
  id: "openclaw-control-plugin",
  name: "OpenClaw Control Plugin",
  description: "Daemon CRUD tools + invoke_ptah for openclaw-control.",
  register(api) {
    api.registerTool(invokePtahFactory,        { name: "invoke_ptah" });
    api.registerTool(listProjectsFactory,      { name: "list_projects" });
    api.registerTool(listTasksFactory,         { name: "list_tasks" });
    api.registerTool(getTaskFactory,           { name: "get_task" });
    api.registerTool(createTaskFactory,        { name: "create_task" });
    api.registerTool(approveTaskFactory,       { name: "approve_task" });
    api.registerTool(handoffTaskFactory,       { name: "handoff_task" });
    api.registerTool(startHarnessSetupFactory, { name: "start_harness_setup" });

    api.logger.info(
      "[openclaw-control-plugin] registered 8 tools (invoke_ptah + 7 daemon CRUD)",
    );
  },
});
```

### 3.6 `src/config.ts` — concrete TS

```typescript
const internalToken = process.env.OPENCLAW_INTERNAL_TOKEN ?? "";
if (!internalToken) {
  // Match the bot-bridge invariant from config.ts:7-12.
  throw new Error(
    "[openclaw-control-plugin] OPENCLAW_INTERNAL_TOKEN is required " +
    "(daemon Bearer auth has no anonymous fallback for plugin callers).",
  );
}

export const config = {
  daemonUrl: process.env.OPENCLAW_DAEMON_URL ?? "http://127.0.0.1:7878",
  internalToken,
  ptahTimeoutMs: Number(process.env.PTAH_INVOKER_TIMEOUT_MS ?? 1_800_000),
};
```

**Failure shape:** the throw happens at plugin module load. Openclaw catches plugin-init exceptions and logs them, but the plugin's tools never register. The startup smoke test (§13.1) catches this — `curl /tools/invoke list_projects` returns 404 "Tool not available" if registration didn't run.

### 3.7 `src/daemonClient.ts` — almost-verbatim MOVE

Copies `bot-bridge/src/daemonClient.ts` with the following deltas:

- **Drop:** `emitSseHint` (lines 295-310 in the current file) — observability hints now ride openclaw's own event system.
- **Drop:** `tickContinuation`-mentioning comments (lines 242-247, 265-269) — clean up the dead-code referenced names; the helper itself is already gone.
- **Drop:** `readHarnessYaml`, `readDiscordJson`, `readAgentIdentity` (lines 71-96) — the plugin doesn't render persona system prompts; openclaw does that.
- **Keep:** the `call<T>()` core, the project-files helpers, `listProjects`, `listAgents`, `listTasks`, `getTask`, `createTask`, `approve`, `handoff`, `approveTask`, `handoffTask`, `readMemory`, `readProjectFile`, `listProjectFiles`, `writeProjectFile`.
- **Add:** `invokePtah` method that POSTs to the new `/api/ptah/invoke` daemon route (§6.1).

```typescript
// new shape addition:
invokePtah: (body: {
  project: string;
  prompt: string;
  agentId?: string;
  sessionKey?: string;
  timeoutMs?: number;
}) => call<{
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}>("POST", "/api/ptah/invoke", body),
```

### 3.8 `src/ptahLauncher.ts` — thin shim

```typescript
import { daemon } from "./daemonClient.js";
import { config } from "./config.js";

export interface InvokePtahOptions {
  project: string;
  prompt: string;
  agentId?: string;
  sessionKey?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface InvokePtahResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Resolves the project slug to a workspace via the daemon, dispatches the
 * ptah-bridge HTTP wrapper, and returns the consolidated result.
 *
 * v1: synchronous from the chat-loop perspective. No streaming surface
 * forwarded back to onChunk — the daemon-side ptah-bridge call is a single
 * round trip. (Streaming via SSE is a Phase 2 enhancement; the AnyAgentTool
 * onUpdate callback simply isn't fed in v1.)
 */
export async function resolveAndInvokePtah(
  opts: InvokePtahOptions,
): Promise<InvokePtahResult> {
  const result = await daemon.invokePtah({
    project: opts.project,
    prompt: opts.prompt,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    timeoutMs: config.ptahTimeoutMs,
  });
  if (!result.ok) {
    throw new Error(`ptah failed (exitCode=${result.exitCode}): see daemon logs`);
  }
  return {
    output: result.output,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
```

### 3.9 `src/tools/invokePtah.ts` — concrete shape

```typescript
import { Type, type Static } from "openclaw/plugin-sdk/typebox";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { textResult, failedTextResult } from "openclaw/plugin-sdk/agent-runtime";

import { resolveAndInvokePtah } from "../ptahLauncher.js";

const InvokePtahParams = Type.Object(
  {
    project: Type.String({
      description: "Project slug as registered in the daemon (see list_projects).",
      minLength: 1,
    }),
    prompt: Type.String({
      description: "Prompt forwarded verbatim to ptah-cli. Be explicit — ptah is non-interactive.",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

type InvokePtahParams = Static<typeof InvokePtahParams>;

export const invokePtahFactory: OpenClawPluginToolFactory = (ctx): AnyAgentTool => ({
  name: "invoke_ptah",
  label: "Invoke ptah-cli",
  description:
    "Dispatch a workspace-scoped ptah-cli invocation. Synchronous — chat blocks " +
    "until ptah returns. Use ONLY when the operator says so, or when the task " +
    "obviously needs claude-code (long context, multi-file refactor). Default to " +
    "openclaw's built-in tools for everything else.",
  parameters: InvokePtahParams,
  async execute(_toolCallId, params: InvokePtahParams, _signal, _onUpdate) {
    try {
      const result = await resolveAndInvokePtah({
        project: params.project,
        prompt: params.prompt,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });
      return textResult(result.output, {
        status: "ok",
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failedTextResult(`invoke_ptah failed: ${message}`, {
        status: "failed",
        error: message,
      });
    }
  },
});
```

### 3.10 `src/tools/daemonCrud.ts` — 7 tools

The 7 tools port verbatim from `bot-bridge/src/tools/daemonTools.ts:104-348`, with these adaptations:

- Return shape becomes `AgentToolResult` (use `textResult` / `failedTextResult`), not raw strings.
- Drop `tick_continuation` (TASK_004 already removed the daemon backend) — already gone.
- Drop `dispatch_orchestration_task` (TASK_004) — already gone.
- Replace `ctx.agentId`/`ctx.userId`/`ctx.channelId` access pattern: the plugin tool context has `ctx.agentId`, `ctx.sessionKey`, `ctx.requesterSenderId`, `ctx.messageChannel`, `ctx.agentAccountId` (research §B1) — adapt the `create_task` body construction:

  ```typescript
  // before (bot-bridge):
  // const result = await daemon.createTask({
  //   project, description, agentId: agent,
  //   discordUserId: ctx.userId, channelId: ctx.channelId,
  // });
  //
  // after (plugin):
  const result = await daemon.createTask({
    project,
    description,
    agentId: agent,
    discordUserId: ctx.requesterSenderId,
    channelId: ctx.messageChannel,
  });
  ```

- `start_harness_setup` is the only stateful tool — it currently flips `ctx.state.set(HARNESS_SETUP_STATE_KEY, …)` in the bot-bridge chat loop. **For v1 cutover, the tool becomes a no-op stub that returns an explanatory message** ("Harness authoring is being rebuilt for v1; edit `<project>/.claude/harness.yaml` directly or use the dashboard."). Full harness-author flow becomes a Phase 2 follow-up. This is consistent with the `harnessAuthor.ts` DELETE in §2.1.

---

## 4. `config/openclaw.json.tmpl` — new shape

### 4.1 Goals

1. Replace single `default` Discord account with per-persona accounts (`anubis`, `horus`).
2. Add `agents.list[]` with one entry per persona.
3. Add `bindings[]` to route each Discord account to its agent.
4. Configure `tools.fs.workspaceOnly: true` per agent (persona-privacy layer 5; see §7).
5. Allow the new plugin: leave `plugins.enabled` default-true and don't restrict via `plugins.allow`.
6. Add `mcp.servers.gh` block (moved from harness.yaml; see §5).
7. Stay extensibility-friendly: structure that lets a third persona drop in by adding three lines.

### 4.2 New template (annotated)

```jsonc
{
  // ─── Agents ──────────────────────────────────────────────────────────────
  // Each persona is one entry. Defaults factor out the uniform-baseline-tools
  // policy (context §1 — every persona gets the same baseline, differentiation
  // is by system prompt / persona).
  "agents": {
    "defaults": {
      "model": { "primary": "${LLM_PROVIDER}/${LLM_MODEL}" },
      "timeoutSeconds": 600,
      "tools": {
        // workspaceOnly: agents can read/write/edit/apply_patch ONLY under
        // their workspace dir. Persona-privacy layer 5 (see §7). Equivalent
        // to "tools.fs.workspaceOnly: true" per research §B3.
        "fs": { "workspaceOnly": true }
        // No allow/deny — uniform baseline. Future per-persona restrictions
        // go in `agents.list[<id>].tools.deny` not here.
      }
    },
    "list": [
      {
        "id": "anubis",
        "default": true,
        "workspace": "/home/agent/.openclaw/workspace/anubis"
        // No `tools` override → inherits defaults. Persona differentiation
        // is by persona.md + identity.md, not by tool removal.
      },
      {
        "id": "horus",
        "workspace": "/home/agent/.openclaw/workspace/horus"
      }
      // To add `amun`: append { "id":"amun", "workspace":"...amun" }, add an
      // entry under channels.discord.accounts.amun, add a binding row, and
      // declare DISCORD_TOKEN_AMUN in .env. Three places, three lines each.
    ]
  },

  // ─── Models ─ unchanged ──────────────────────────────────────────────────
  "models": {
    "mode": "merge",
    "providers": ${LLM_PROVIDERS_JSON}
  },

  // ─── Channels: Discord per-persona accounts ──────────────────────────────
  "channels": {
    "defaults": {},
    "discord": {
      "enabled": true,
      "accounts": {
        // One entry per persona. Each connects to Discord with its own bot
        // token; Discord platform routes @mentions to the targeted bot only,
        // so per-persona accounts give us per-persona inboxes for free.
        "anubis": {
          "token":   "${DISCORD_TOKEN_ANUBIS}",
          "enabled": true,
          "name":    "Anubis",
          "healthMonitor": { "enabled": true }
        },
        "horus": {
          "token":   "${DISCORD_TOKEN_HORUS}",
          "enabled": true,
          "name":    "Horus",
          "healthMonitor": { "enabled": true }
        }
      },
      "groupPolicy": "allowlist",
      "guilds": {
        "${DISCORD_GUILD_ID}": { "requireMention": true }
      }
    }
  },

  // ─── Routing: per-account → agent ────────────────────────────────────────
  // `bindings[]` lives at the top level (research §B2). Each binding ties a
  // discord account to one of the agents declared above.
  "bindings": [
    { "agentId": "anubis", "match": { "channel": "discord", "accountId": "anubis" } },
    { "agentId": "horus",  "match": { "channel": "discord", "accountId": "horus"  } }
  ],

  // ─── MCP servers (moved here from harness.yaml — see §5) ─────────────────
  "mcp": {
    "servers": {
      "gh": {
        "command": "npx",
        "args":    ["-y", "@modelcontextprotocol/server-github"],
        "env":     { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
        "connectionTimeoutMs": 30000
      }
    },
    "sessionIdleTtlMs": 600000
  },

  // ─── Gateway (mostly unchanged) ──────────────────────────────────────────
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode":  "token",
      "token": "${OPENCLAW_AUTH_TOKEN}"
    },
    "controlUi": {
      "allowInsecureAuth": true,
      "allowedOrigins": [
        "http://127.0.0.1:18789", "http://localhost:18789",
        "http://127.0.0.1:18790", "http://localhost:18790",
        "http://127.0.0.1:18791", "http://localhost:18791",
        "http://127.0.0.1:18792", "http://localhost:18792"
      ]
    },
    "trustedProxies": ["127.0.0.1", "::1"]
  },

  // ─── Plugins ─────────────────────────────────────────────────────────────
  // Default behavior: openclaw auto-discovers every plugin in
  // /usr/lib/node_modules/openclaw/dist/extensions/*. Our plugin lives there
  // (Dockerfile change in §10 batch 9). No `allow` list — we trust everything
  // we ship; `bonjour` stays disabled.
  "plugins": {
    "entries": {
      "bonjour": { "enabled": false }
    }
  },

  "commands":      { "useAccessGroups": false },
  "update":        { "checkOnStart": false },
  "meta": {
    "lastTouchedVersion": "${OPENCLAW_VERSION}",
    "lastTouchedAt":      "${OPENCLAW_NOW}"
  }
}
```

### 4.3 Diff against current template

```diff
 {
   "agents": {
     "defaults": {
       "model": { "primary": "${LLM_PROVIDER}/${LLM_MODEL}" },
-      "timeoutSeconds": 600
+      "timeoutSeconds": 600,
+      "tools": { "fs": { "workspaceOnly": true } }
-    }
+    },
+    "list": [
+      { "id": "anubis", "default": true,
+        "workspace": "/home/agent/.openclaw/workspace/anubis" },
+      { "id": "horus",
+        "workspace": "/home/agent/.openclaw/workspace/horus" }
+    ]
   },
   ...
   "channels": {
     "defaults": {},
     "discord": {
       "enabled": true,
       "accounts": {
-        "default": {
-          "token": "${DISCORD_BOT_TOKEN}",
+        "anubis": {
+          "token": "${DISCORD_TOKEN_ANUBIS}",
           "enabled": true,
+          "name": "Anubis",
           "healthMonitor": { "enabled": true }
-        }
+        },
+        "horus": {
+          "token": "${DISCORD_TOKEN_HORUS}",
+          "enabled": true,
+          "name": "Horus",
+          "healthMonitor": { "enabled": true }
+        }
       },
       ...
     }
   },
+  "bindings": [
+    { "agentId": "anubis", "match": { "channel": "discord", "accountId": "anubis" } },
+    { "agentId": "horus",  "match": { "channel": "discord", "accountId": "horus" } }
+  ],
+  "mcp": {
+    "servers": {
+      "gh": {
+        "command": "npx",
+        "args": ["-y", "@modelcontextprotocol/server-github"],
+        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
+        "connectionTimeoutMs": 30000
+      }
+    },
+    "sessionIdleTtlMs": 600000
+  },
   ...
 }
```

### 4.4 `.env` additions

```
# .env (host)
DISCORD_TOKEN_ANUBIS=...    # was DISCORD_BOT_TOKEN
DISCORD_TOKEN_HORUS=...     # new
GITHUB_TOKEN=...            # was previously read by bot-bridge MCP; now read by openclaw MCP runtime
```

`DISCORD_BOT_TOKEN` can be deleted from `.env` after cutover. Document the migration step in `docs/SETUP.md` Phase 1 cutover instructions.

---

## 5. MCP migration plan

### 5.1 Current state

- `openclaw-control/bot-bridge/src/mcp/mcpManager.ts` (808 lines) — per-persona stdio MCP client lifecycle, backoff curve, tools cache.
- `openclaw-control/bot-bridge/src/tools/mcpTools.ts` (65 lines) — exposes MCP-server tools to the bot-bridge LLM dispatcher.
- `shared-specs/memory/agents/<id>/harness.yaml` `chatTier.mcpServers[*]` — config source. Today anubis has one server: `gh` (GitHub MCP server via `npx -y @modelcontextprotocol/server-github`, with `GITHUB_PERSONAL_ACCESS_TOKEN` env).

### 5.2 New state — openclaw's bundled-MCP runtime

Openclaw v2026.4.24 has a first-class MCP runtime at `dist/pi-bundle-mcp-runtime-B_SrebwR.js`. Config shape (verified at `.openclaw-extract/dist/plugin-sdk/src/config/types.mcp.d.ts`):

```typescript
export type McpConfig = {
    servers?: Record<string, McpServerConfig>;
    sessionIdleTtlMs?: number;   // default 10 minutes
};
export type McpServerConfig = {
    // stdio
    command?: string;
    args?: string[];
    env?: Record<string, string | number | boolean>;
    cwd?: string;
    // http
    url?: string;
    transport?: "sse" | "streamable-http";
    headers?: Record<string, string | number | boolean>;
    connectionTimeoutMs?: number;
    [key: string]: unknown;
};
```

Two important deltas from our current shape:

1. **Field name is `command`/`args` not `id`/`command`.** Server name is the map key, not a field.
2. **`timeoutMs` becomes `connectionTimeoutMs`.**

### 5.3 The migration

**Delete:**

- `openclaw-control/bot-bridge/src/mcp/mcpManager.ts` (808 lines)
- `openclaw-control/bot-bridge/src/tools/mcpTools.ts` (65 lines)
- The `chatTier.mcpServers[]` block from each persona's `shared-specs/memory/agents/<id>/harness.yaml` (drop the lines for `gh` from anubis; horus has none).

**Add** to `config/openclaw.json.tmpl`:

```jsonc
"mcp": {
  "servers": {
    "gh": {
      "command": "npx",
      "args":    ["-y", "@modelcontextprotocol/server-github"],
      "env":     { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "connectionTimeoutMs": 30000
    }
  },
  "sessionIdleTtlMs": 600000
}
```

**Verification:**

1. Run openclaw with the new config.
2. POST `/tools/invoke` with `{"tool": "gh__list_repos"}` (or whatever a `tool_search` confirms is registered from the gh MCP server). Confirm 200 + result.
3. Watch `openclaw` stderr for `bundle-mcp: server "gh"` startup line.

**Per-persona MCP servers:** v1 ships with a single shared `gh` server. Per-persona MCP gating (e.g. "horus does not get gh access") is a Phase 2 enhancement via `agents.list[<id>].tools.deny: ["gh__*"]` (the `tools.deny` syntax in `AgentToolsConfig` supports glob — research §B1 line 264-294). Out of scope for cutover.

**`harness.yaml.chatTier.mcpServers`:** the per-persona harness keeps the YAML shape but `mcpServers` becomes informational-only in v1 (the field stays in `HarnessConfig` so daemon `materialize.ts` doesn't break, but nothing reads it from the chat tier anymore). Phase 2 cleanup: remove the field from the schema entirely if we never re-introduce per-persona MCP gating.

---

## 6. Daemon-side changes

### 6.1 New route: `POST /api/ptah/invoke`

Lands in `daemon/src/api.ts`. Body schema:

```typescript
{
  project: string;        // project slug
  prompt: string;
  agentId?: string;       // optional — derives from x-openclaw-agent-id header if absent
  sessionKey?: string;
  timeoutMs?: number;     // bounded by the daemon's PTAH_INVOKER_TIMEOUT_MS env
}
```

Response:

```typescript
{
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;         // captured stdout
  stderr?: string;        // captured stderr (only on !ok)
}
```

Implementation: thin wrapper around `daemon/src/harness/ptahLauncher.ts:spawnPtahForAgent({...})`, resolving project slug → `project.path` via `storage.readProject(slug)`. Auth: `guard` preHandler (same as every other daemon route). Leader-only: same `405` shape as the other project routes (followers redirect to leader).

This route is the ONLY new daemon endpoint added by this migration.

### 6.2 Routes that change behavior

| Route | Current state | Post-migration state |
|-------|---------------|----------------------|
| `POST /api/agents/:id/harness/sync` | Publishes Redis `harness/sync`; bot-bridge subscribes and hot-reloads the persona's prompt. | **Becomes orphaned.** No subscriber after cutover. Route stays (cheap to leave; future caller may want it). Document as "no consumer in v1; reserved for Phase 2 hot-reload via openclaw plugin reload." |
| `POST /api/sse/emit` | The bot-bridge POSTs observability events here. | **Becomes orphaned.** No bot-bridge to call it. Route stays (it's still callable from a future client). |

### 6.3 Routes that survive vs. need surgical removal

Read of `daemon/src/api.ts` confirms current routes:

| Route | Verdict | Reason |
|-------|---------|--------|
| `GET /api/health` (147) | **KEEP** | Live runtime probe shows it returning leader/dbVersion. Used by dashboards, smoke tests. |
| `GET /api/projects` (183) | **KEEP** | Plugin's `list_projects` calls it. |
| `GET /api/projects/:slug/tasks` (185) | **KEEP** | Plugin's `list_tasks`. |
| `GET /api/projects/:slug/tasks/:taskId` (195) | **KEEP** | Plugin's `get_task`. |
| `POST /api/tasks` (208) | **KEEP** | Plugin's `create_task`. |
| `POST /api/projects/:slug/tasks/:taskId/approve` (223) | **KEEP** | Plugin's `approve_task`. |
| `POST /api/projects/:slug/tasks/:taskId/handoff` (241) | **KEEP** | Plugin's `handoff_task`. |
| `POST /api/continuation/tick` (261) | **KEEP (dormant)** | No caller post-migration; can be removed in Phase 2. Cheap to leave. |
| Task-files block (267-359) | **KEEP** | Dashboard reads task artifacts; daemon writes them on phase completion. |
| `/api/dispatches/*` block (364-527) | **KEEP (dormant)** | Continuation/dispatch dormant. Dashboard may still render historical rows. |
| `GET /api/agents` (530) | **KEEP** | Dashboard. |
| `POST /api/agents/:id/harness/sync` (543) | **KEEP (orphaned)** | No bot-bridge subscriber post-cutover. See §6.2. |
| Sessions routes (562-573) | **KEEP**. |
| Memories routes (577-657) | **KEEP** | Persona privacy layers 1-4 live here unchanged. |
| `POST /api/sse/emit` (672) | **KEEP (orphaned)**. |
| Project files (760-917) | **KEEP** | Future harness-author rebuild relies on this. |
| `POST /api/agents/:id/harness/materialize` (925), `POST /api/harness/materialize` (950) | **KEEP** | Operator/dashboard surface. |
| `GET /api/stream` (976) | **KEEP** | Dashboard SSE. |
| Static dashboard (986) | **KEEP**. |
| **NEW** `POST /api/ptah/invoke` (§6.1) | **ADD** | The only new route this migration introduces. |

**HITL endpoints `/advance`, `/cancel-pending`, `DELETE /api/dispatches/:id`** — per the context prompt these are in the stash and the working-tree edits stayed out of the stash. `grep -n` of the current `api.ts` confirms **they do not exist on disk** — there is no `/advance` and no `/cancel-pending` route registered today. Conclusion: no surgical removal needed; the stash carries them and we never apply that stash. The team-leader can verify by running `grep -n "advance\\|cancel-pending" openclaw-control/daemon/src/api.ts` and getting no hits.

### 6.4 Daemon-internal callers that disappear

- Daemon's `publishHandoff` on `bus.ts` is currently consumed by bot-bridge's Redis subscriber. After cutover, no subscriber. The publishing call site (`api.ts:249-257` in the `/handoff` route) stays — its job is now to mark the daemon-side handoff event for dashboard SSE; the cross-machine notify-the-other-bot logic disappears with bot-bridge. The handoff itself works because the task row's `assignedAgent` flips in the DB; the next time the new agent's persona is messaged on Discord, openclaw picks the conversation up against the now-correct task. See §8 for the full flow.

### 6.5 Continuation / dispatch / invoker — Phase 2/3 plan (not in scope for cutover)

The dormant code in `daemon/src/{continuation,dispatch,invoker}.ts` plus `daemon/src/db/dispatches.ts` plus the `/api/dispatches/*` routes are Phase 2/3 deletion targets. Per the cutover plan they stay in tree, are never reached by any code path, and the team-leader should NOT include their removal in the v1 batches.

Phase 2 batch (deferred): delete dormant continuation/dispatch code, drop dispatch routes, drop `dispatches` table (migration v5).

Phase 3 batch (deferred): if `harness.yaml.chatTier.mcpServers` field is gone, drop the field from `HarnessConfig` schema and from materialize.

---

## 7. Persona privacy — concrete enforcement

### 7.1 Layer-by-layer mapping (in the post-migration world)

From CLAUDE.md the six historical layers were:

1. `resolveBackend()` in `daemon/src/memory.ts` — routes private files to local-FS, never to DB.
2. HTTP gate in `daemon/src/api.ts` — `/api/memories/agents/:id/<private-file>` returns 404 GET, 403 PUT/DELETE.
3. `MemoryRepo.write` / `MemoryRepo.delete` in `daemon/src/db/memory.ts` — synchronous throw if a private filename smuggles through.
4. `assertMaterializedPathSafety` in `daemon/src/harness/materialize.ts` — throws if materialized output path lands under `localMemoryRoot`.
5. (Historical) bot-bridge tool handlers' input validation.
6. (Historical) bot-bridge persona-write path's input validation.

Post-migration enforcement:

| Layer | Where | What |
|-------|-------|------|
| **1** | `daemon/src/memory.ts:resolveBackend()` | Unchanged. Any `(scope='agents', file ∈ PRIVATE_AGENT_FILES)` writes to local FS, never DB. |
| **2** | `daemon/src/api.ts` GET/PUT/DELETE `/api/memories/:scope/:id/:file` | Unchanged. The plugin's `daemonClient.readMemory(…)` hits this surface, so the gate runs on every read. |
| **3** | `daemon/src/db/memory.ts:MemoryRepo.write|delete` | Unchanged. Defense-in-depth crash if a programming error smuggles a private file past the chokepoint. |
| **4** | `daemon/src/harness/materialize.ts:assertMaterializedPathSafety` | Unchanged. The plugin's `invoke_ptah` triggers `materializeAgent(agentId)` via `ptahLauncher`; the materialization writer is still gated. |
| **5 (new shape)** | `config/openclaw.json.tmpl` `agents.defaults.tools.fs.workspaceOnly: true` | **NEW location.** Openclaw's `read`/`write`/`edit`/`apply_patch` built-in tools refuse paths outside the agent's workspace. The agent's workspace is `/home/agent/.openclaw/workspace/<id>` — distinct from `~/.claude/local-memory/agents/<id>/` where personas live. |
| **6 (new shape)** | Plugin's `tools/invokePtah.ts` and `tools/daemonCrud.ts` factories | **NEW location.** Input validation on `project`, `taskId`, `description`, `prompt` happens in the typebox parameter schemas plus a defensive runtime check at the start of each `execute()`. Specifically: reject any `project` slug containing `..`, `/`, or `\` (path traversal); reject any non-ASCII control char. These checks belt-and-brace the daemon's own `safeProjectPath` validator. |

### 7.2 Per-machine filesystem isolation (free additional layer)

Each machine bind-mounts ONLY its own personas' `local-memory/agents/<owned-id>/` into the daemon. Followers cannot read other machines' personas because the FS isn't there. With openclaw running on host (research §B4-addendum), the gateway process directly reads `~/.claude/local-memory/...` for its own personas only — the machine's `OPENCLAW_LOCAL_AGENT_IDS` env caps which directories openclaw sees.

### 7.3 Bind-mount discipline (Docker path — for when we re-introduce containers)

When openclaw eventually moves back into the Dockerfile sandbox, the rule is:

- The openclaw gateway container's `binds[]` MUST include the workspace dir but MUST NOT include `~/.claude/local-memory/`, `~/.ptah/`, or `~/.claude/`.
- The agent sandbox `agents.list[<id>].sandbox.docker.binds[]` likewise.

This is encoded as the unit test in §7.5.

### 7.4 What the plugin code is allowed to read

The plugin runs in-process with openclaw on the host — same privileges as the openclaw process. Three rules that the team-leader must verify in code review:

1. The plugin's `daemonClient` only reaches the daemon over HTTP with the internal Bearer token. It does NOT directly read the FS for memory files. (The bot-bridge currently does direct-FS reads at `agentRegistry.ts:78` for persona.md — that code does NOT come over to the plugin. Personas are openclaw's concern now.)
2. The plugin's `invoke_ptah` tool does NOT shell out itself; it goes through the daemon's `/api/ptah/invoke` → `ptahBridge.ts` → host ptah-bridge HTTP. The trust boundary stays at the daemon.
3. The plugin reads `process.env.OPENCLAW_INTERNAL_TOKEN`. It does not read any other env that mentions persona paths. Code review: grep the plugin source for `local-memory`, `.claude`, `.ptah` — should be zero hits.

### 7.5 Unit test specification: bind-mount config

**Test name:** `bind-mounts-do-not-leak-persona-paths.test.ts`
**Location:** `test/security/` (new directory in the daemon package, or root-level if cross-package)
**Shape:**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN_SEGMENTS = [
  "local-memory",
  ".claude",
  ".ptah",
] as const;

const FILES_TO_SCAN = [
  "docker-compose.yml",
  "config/openclaw.json.tmpl",
  // Add Dockerfile if/when we re-introduce per-agent sandbox binds.
] as const;

describe("persona-privacy bind-mount discipline", () => {
  for (const file of FILES_TO_SCAN) {
    it(`${file}: no openclaw bind-mount references private persona paths`, () => {
      const content = readFileSync(resolve(__dirname, "../..", file), "utf8");

      // Coarse-grained scan: find every `binds`/`bind`/`volumes` line and
      // assert no forbidden segment appears on it. Misses creative whitespace;
      // tighten if false-negatives appear in code review.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isBindLine = /\b(binds?|volumes?)\b\s*[:=]/i.test(line);
        if (!isBindLine) continue;
        // Allow workspace mounts. Disallow personas.
        for (const seg of FORBIDDEN_SEGMENTS) {
          if (line.includes(seg)) {
            throw new Error(
              `${file}:${i + 1}: bind-mount line contains forbidden segment "${seg}":\n` +
              `  ${line.trim()}\n` +
              `Personas live in ~/.claude/local-memory and must NEVER traverse a sandbox bind.`,
            );
          }
        }
      }
    });
  }

  it("openclaw config: agents.defaults.tools.fs.workspaceOnly is true", () => {
    const tmpl = readFileSync(
      resolve(__dirname, "../../config/openclaw.json.tmpl"),
      "utf8",
    );
    // Strip JSONC comments before parsing.
    const stripped = tmpl.replace(/^\s*\/\/.*$/gm, "");
    // Replace ${VAR} substitutions with stub values so JSON.parse succeeds.
    const stubbed = stripped.replace(/\$\{[^}]+\}/g, '"STUB"');
    const cfg = JSON.parse(stubbed);
    expect(cfg.agents.defaults.tools.fs.workspaceOnly).toBe(true);
  });
});
```

This test must pass in CI on every PR that touches docker-compose, the openclaw template, or any Dockerfile that introduces sandbox binds. The team-leader should land this test in the SAME batch that ships the new template (batch 6, §10).

---

## 8. Multi-machine topology — concrete flow

### 8.1 Setup

- **Leader machine** runs: openclaw (anubis bot) + daemon (leader) + ptah-bridge.
  - `OPENCLAW_LOCAL_AGENT_IDS=anubis`
  - `config.agents.list = [anubis]` (or `[anubis]` + `default:true`; `horus` not declared)
  - `channels.discord.accounts.anubis` = present; `horus` = NOT present
  - `bindings[]` includes only the `anubis` binding
- **Follower machine** runs: openclaw (horus bot) + daemon (follower) + ptah-bridge.
  - `OPENCLAW_LOCAL_AGENT_IDS=horus`
  - `config.agents.list = [horus]`
  - `channels.discord.accounts.horus` = present
  - `bindings[]` includes only the `horus` binding
  - `OPENCLAW_LEADER_URL=https://leader…` for the daemon

Each machine's openclaw connects to Discord independently with its own bot token. Discord routes @mentions of the Anubis user to the leader's openclaw (only it has the token); @mentions of Horus go to the follower's openclaw.

### 8.2 In-machine flow (operator chats with Anubis on the leader)

```
Discord user → "@Anubis create_task in openclaw-control: refactor X"
   │
   ▼
[Leader openclaw]
   • channels.discord.accounts.anubis receives the message
   • bindings[] resolves: matchedBy="binding.account", agentId="anubis"
   • Routes to agent "anubis" — loads its persona, runs LLM turn
   • LLM emits tool_call: create_task(project="openclaw-control", description="refactor X")
   │
   ▼
[Plugin runs in-process inside openclaw]
   • createTaskFactory's execute() builds body
   • daemonClient.createTask({ project, description, agentId: "anubis", discordUserId, channelId })
   │
   ▼
[Leader daemon @ :7878]
   • POST /api/tasks → storage.createTask(...) → SQLite INSERT
   • Returns { taskId }
   │
   ▼
[Plugin formats result, returns AgentToolResult to openclaw]
   • textResult(`{ taskId, project, agent }`, …)
   │
   ▼
[Leader openclaw] runs next LLM turn with the tool result, posts assistant reply to Discord
```

### 8.3 Cross-machine handoff flow

Operator says: "@Anubis hand off TASK_2026_007 to Horus."

```
Discord → Anubis on leader
   │
   ▼
[Leader openclaw] → anubis LLM → tool_call: handoff_task(taskId, toAgent="horus", reason)
   │
   ▼
[Plugin] daemonClient.handoffTask("openclaw-control", "TASK_2026_007", "horus", "…")
   │
   ▼
[Leader daemon] POST /api/projects/.../handoff
   • Sets tasks.assigned_agent = 'horus' in SQLite
   • publishHandoff() emits the Redis event (no subscriber post-migration; harmless)
   • broadcast('task.updated', …) on the SSE bus
   │
   ▼
[Leader plugin] returns { ok:true, taskId, toAgent:"horus" } to anubis turn
[Leader openclaw] anubis posts "Handed off to Horus." to Discord
   │
   │  (no automatic notification to horus's machine — see §8.4)
   ▼
Operator (when ready) → "@Horus you got TASK_2026_007 — start"
   │
   ▼
[Follower openclaw] receives @Horus mention, routes to "horus"
   • horus's LLM turn invokes get_task("openclaw-control", "TASK_2026_007")
   │
   ▼
[Follower plugin] daemonClient.getTask(...)
   │
   ▼
[Follower daemon — FOLLOWER MODE]
   • storage facade detects follower mode, relays via leaderClient
   • GET https://leader…:7878/api/projects/.../tasks/... with Bearer token
   │
   ▼
[Leader daemon] returns task summary
   │
   ▼
[Follower plugin] formats, returns to horus's LLM turn
[Follower openclaw] horus replies on Discord
```

### 8.4 Why the follower openclaw is NOT auto-notified

In the OLD architecture, bot-bridge subscribed to Redis `agent:<id>:inbox` and the daemon's `publishHandoff` triggered a notification post on Discord. With bot-bridge gone:

- There is no subscriber on Redis `agent:horus:inbox`.
- Openclaw has no built-in cross-machine "tickle" mechanism.
- **Operator-initiated re-engagement is the v1 design** (consistent with context §7 — "ptah is reserved for user-initiated requests; agents don't reach for it automatically"). The operator @-mentions Horus when ready; horus picks up the now-assigned task on next turn.

If future operators find this manual step annoying, a Phase 2 enhancement can:

- Re-introduce a thin Redis subscriber as a daemon-side feature (not bot-bridge), or
- Have the daemon POST to a registered webhook on each machine that triggers an `x-openclaw-message-channel` Discord post via the local openclaw's `/v1/responses` endpoint with a synthetic "system" message.

**Both are deferred.** v1 ships with operator-initiated re-engagement.

### 8.5 Daemon storage facade unchanged

The follower's daemon already proxies all storage calls to the leader via `leaderClient.ts` (847 lines, all surviving). The plugin doesn't know or care whether it's talking to a leader or follower — it just talks to `localhost:7878`.

---

## 9. Deployment

### 9.1 What we know

- Stack runs on host (research §B4-addendum): PIDs 2314, 2572, 2598, 1092 are user-launched processes, NOT containers spawned by `docker compose up`.
- `openclaw` was installed somehow into `/opt/openclaw-control/` (the daemon and bot-bridge `dist/` paths confirm this) AND globally via npm into wherever `which openclaw` reports.
- The Dockerfile builds an image, and the entrypoint scripts assume container layout (`/etc/openclaw/openclaw.json.tmpl`, `/home/agent/...`). The host stack is bypassing the container entirely.

### 9.2 Risk for the migration

**MED.** The migration plan in §10 assumes we can stop the bot-bridge process and start the openclaw process loading the new plugin. **We don't know what launches openclaw today** — systemd unit, terminal session, tmux pane, manual `node …`? Without that knowledge, the cutover batch in §10 cannot be precise.

### 9.3 Clarifications Needed

**Surface this to the user before Phase 2 begins (does NOT block this architecture doc):**

> The migration will replace `node /opt/openclaw-control/bot-bridge/dist/index.js` (PID 2598) with an openclaw plugin loaded into the gateway process (PID 2314). To write the cutover script we need to know:
>
> 1. How is openclaw (PID 2314) launched today? Systemd unit (`/etc/systemd/system/openclaw.service`)? Terminal command in a tmux/screen session? Some shell alias?
> 2. How is the daemon (PID 2572) launched? Same mechanism, different?
> 3. How is bot-bridge (PID 2598) launched? Same mechanism?
> 4. How is ptah-bridge (PID 1092) launched?
> 5. Is there a `~/.openclaw/openclaw.json` config file in use today, or does openclaw read from somewhere else? (Research found the template at `/etc/openclaw/openclaw.json.tmpl` is container-side; the host install must have its own resolved JSON somewhere.)
>
> Please paste the answer here as a follow-up comment; the team-leader will turn it into the cutover script in batch 12 (§10).

### 9.4 Container-side deployment (Dockerfile path)

The Dockerfile path remains supported. The migration changes:

- Drop the `bot-builder` stage 3.
- After installing openclaw globally, COPY the built plugin into `/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/`:

  ```dockerfile
  # ---------- stage 3: compile the openclaw-control-plugin ----------
  FROM node:22-bookworm-slim AS plugin-builder
  WORKDIR /build/plugin
  COPY openclaw-control/plugin/package.json openclaw-control/plugin/package-lock.json* ./
  RUN npm ci --include=dev || npm install
  COPY openclaw-control/plugin/ ./
  RUN npm run build
  # Bundled output ends up in /build/plugin/dist/index.js

  # ... in stage 4 runtime ...
  COPY --from=plugin-builder /build/plugin/dist \
       /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin
  COPY --from=plugin-builder /build/plugin/package.json \
       /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/package.json
  ```

- `entrypoint-control.sh` drops the `node /opt/openclaw-control/bot-bridge/dist/index.js &` line. Only daemon + dashboard remain.

### 9.5 Host-native deployment

Mirror what the Dockerfile does on the host: copy the built plugin into wherever `npm root -g`/openclaw is installed (likely `/usr/lib/node_modules/openclaw/dist/extensions/`), with appropriate ownership. The team-leader's cutover script (batch 12) will encode the exact path once the user surfaces it.

---

## 10. Migration sequence — batched, dependency-ordered

Each batch is independently testable and reversible (see §11). Numbers are batch order, not severity.

### Batch 1 — Doc-rot fix (independent, can land standalone)

- **Touch:** `openclaw-control/bot-bridge/src/tools/daemonTools.ts:1` and `:99` — change "9 tools" comment to "7 tools" (TASK_004 removed two).
- **Verify:** `npm test` in bot-bridge package still passes.
- **Rollback:** `git revert <sha>`.

### Batch 2 — Plugin package skeleton (no behavior)

- **Create:** `openclaw-control/plugin/` (new directory) with `package.json` (§3.2), `openclaw.plugin.json` (§3.3), `tsconfig.json`, empty `src/index.ts` returning `definePluginEntry` that registers ZERO tools but logs "stub plugin online".
- **Verify:** `cd openclaw-control/plugin && npm install && npm run build` produces `dist/index.js`.
- **Verify:** smoke build only — plugin not yet loaded into openclaw.
- **Rollback:** delete the new directory.

### Batch 3 — Daemon's new `/api/ptah/invoke` route

- **Touch:** `daemon/src/api.ts` — add the route from §6.1.
- **Touch:** `daemon/src/harness/ptahLauncher.ts` — confirm the existing `spawnPtahForAgent` signature is the integration point.
- **Tests:** new daemon test asserting `/api/ptah/invoke` 400s on missing body, 401s without Bearer token, 404 on unknown project slug.
- **Rollback:** `git revert <sha>`. Route addition is additive; no caller yet.

### Batch 4 — Plugin: stub `invoke_ptah` tool

- **Touch:** `openclaw-control/plugin/src/tools/invokePtah.ts` (per §3.9), `src/index.ts` registers it.
- **Touch:** `src/config.ts`, `src/daemonClient.ts` (subset — only `invokePtah` method), `src/ptahLauncher.ts`.
- **Test:** unit test stubs the daemon HTTP and asserts param validation + happy-path round trip.
- **Verify:** plugin builds; openclaw still NOT yet loading it.
- **Rollback:** `git revert`. Daemon route from Batch 3 stays — no caller.

### Batch 5 — Plugin: 7 daemon-CRUD tools

- **Touch:** `openclaw-control/plugin/src/tools/daemonCrud.ts` — port from `bot-bridge/src/tools/daemonTools.ts:104-348` minus the two dead tools.
- **Touch:** `src/daemonClient.ts` — port full set of CRUD methods.
- **Touch:** `src/index.ts` — register all 7 + `invoke_ptah`.
- **Test:** unit tests per tool, stubbing daemon HTTP.
- **Verify:** plugin builds; still not loaded into openclaw.
- **Rollback:** `git revert`.

### Batch 6 — New `config/openclaw.json.tmpl`

- **Touch:** `config/openclaw.json.tmpl` (§4.2).
- **Touch:** `entrypoint.sh` — add `DISCORD_TOKEN_ANUBIS`, `DISCORD_TOKEN_HORUS`, `GITHUB_TOKEN` to the interpolation list, remove `DISCORD_BOT_TOKEN` default.
- **Touch:** `.env.example` (if present) or `docs/CONFIGURATION.md` — document the new env vars.
- **Add:** `test/security/bind-mounts-do-not-leak-persona-paths.test.ts` (§7.5).
- **Verify:** the new test passes; envsubst on the template produces valid JSON.
- **Verify:** openclaw still uses the OLD template (deployment NOT yet switched). This batch is a TEMPLATE-ONLY change; the running gateway is unchanged until batch 9/10.
- **Rollback:** `git revert`.

### Batch 7 — Plugin Dockerfile integration

- **Touch:** `Dockerfile` stage 3 → rename to `plugin-builder`, COPY into openclaw extensions dir.
- **Touch:** `entrypoint-control.sh` — drop the bot-bridge spawn line.
- **Verify:** `docker compose build` succeeds; the resulting image has `/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/index.js`.
- **Note:** does NOT touch the host install — that comes in batch 12 (§9.3 clarifications).
- **Rollback:** `git revert`.

### Batch 8 — MCP migration

- **Delete:** `openclaw-control/bot-bridge/src/mcp/mcpManager.ts`, `tools/mcpTools.ts`.
- **Edit:** `shared-specs/memory/agents/anubis/harness.yaml` — remove `chatTier.mcpServers` block.
- **Edit:** `config/openclaw.json.tmpl` — add the `mcp.servers.gh` block from §5.3.
- **Verify:** `bind-mounts` test still passes; harness yaml still parses.
- **Verify (smoke, requires container or running gateway):** restart openclaw with the new config; `/tools/invoke` lists at least one `gh__*` tool; `bundle-mcp: server "gh"` startup line appears in stderr.
- **Rollback:** revert; bot-bridge MCP code stays available; harness yaml block restored.

### Batch 9 — Cutover preparation: dual-write

- **Touch:** `docker-compose.yml` — add `DISCORD_TOKEN_ANUBIS`, `DISCORD_TOKEN_HORUS` to `environment:`; keep `DISCORD_BOT_TOKEN` for now (dual-config).
- **Add:** secondary openclaw config target (e.g. `/etc/openclaw/openclaw.json.new`) rendered alongside the current one — this lets us load the new config without committing the cutover.
- **Verify:** both old (bot-bridge) and new (openclaw plugin) configs render valid JSON.
- **Rollback:** drop the dual rendering.

### Batch 10 — Cutover: openclaw loads the plugin (canary)

This is the irreversible-in-the-moment step. Sequencing:

1. Stop the OLD bot-bridge process (PID 2598). Confirm Anubis goes offline on Discord.
2. Update openclaw's config in place to the new template's output. The new accounts (anubis, horus) and bindings get loaded.
3. Restart openclaw (PID 2314). Plugin discovery picks up `openclaw-control-plugin`.
4. Smoke tests (§13) run.
5. If anything fails, restart OLD bot-bridge and roll openclaw config back. (Reversible at this stage if backup is in place.)

**This batch IS the cutover.** Once smoke-tested it's complete and reversal becomes more expensive (still possible via the recovery anchor tag, but operator-visible if Discord users were active).

### Batch 11 — Delete the dead chat-tier code

After batch 10 is green for some agreed duration (24h or operator-declared "looks fine"):

- **Delete:** `openclaw-control/bot-bridge/` directory entirely (after renaming/migration in §12 we may have already moved the surviving files out).
- **Delete:** docker-compose env vars no longer needed (`DISCORD_BOT_TOKEN`).
- **Touch:** `docs/OPENCLAW_CONTROL.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` — update prose to reflect the new architecture.
- **Rollback:** revert the deletion + restore config. The recovery anchor `pre-task-2026-006-cleanup` is the global escape hatch.

### Batch 12 — Host-stack launchers (requires user clarification §9.3)

Surface the §9.3 questions to the user BEFORE this batch. Once answered:

- Update systemd unit / launch script / tmux config / whatever the user uses.
- Validate manually with the user.
- **Rollback:** restore the previous launcher.

### Batch 13 — Documentation and follow-up

- Update `README.md`, `docs/*` to reflect the new shape.
- Note the Phase 2/3 cleanup candidates (continuation, dispatch, dispatches table, harness mcpServers field).
- Close TASK_2026_006.

---

## 11. Rollback plan

### 11.1 Per-batch rollback (encoded in §10)

Each batch has an explicit rollback step. Batches 1-9 are pure `git revert`. Batch 10 (the cutover) is reversible by restarting the old bot-bridge process AND reverting the openclaw config; backups of the old config must be in place before batch 10 begins (operator step, not code).

### 11.2 Global escape hatch

The tag `pre-task-2026-006-cleanup` is the canonical "we want to be back at the pre-migration code" anchor. `git reset --hard pre-task-2026-006-cleanup` restores the entire repo state.

### 11.3 What NOT to do

- **Do NOT recommend reverting to `refs/stash@{0}`.** The stash holds cancelled TASK_004/005 work; the schema there is behind current live state (the live DB is v4 already per research §B4-addendum #4). Stashed code referencing a v3 schema would fail to apply.
- **Do NOT mix rollback with forward migration.** If batch 10 needs to be undone, revert batch 10 cleanly, regroup, then plan the next attempt. Do not try to "fix forward" mid-cutover.

### 11.4 Data implications

- SQLite (`/data/specs.db`) is schema-v4 throughout this migration. **No schema changes are introduced by this task.** Rolling back any batch leaves the DB unchanged.
- Persona files in `~/.claude/local-memory/agents/<id>/` are unchanged by this migration. Rollback leaves them in place.

---

## 12. Naming

**Proposed name:** `openclaw-control-plugin`. Repo path: `openclaw-control/plugin/`. Package name: `@openclaw-control/plugin`. Plugin id: `openclaw-control-plugin`.

**Justification (one paragraph):** The current name `bot-bridge` is now actively misleading — the migration removes the only "bridge" the package owned (Discord ↔ chat-loop ↔ daemon). The remaining surface is "plugin that exposes openclaw-control's daemon CRUD + invoke_ptah as openclaw tools," and the natural name follows: `openclaw-control-plugin`. It pairs cleanly with the existing repository slug `openclaw-control/`, signals the relationship to `openclaw` without claiming to be PART of openclaw, and matches the convention openclaw's own packages follow (`openclaw-sandbox`, `openclaw-bundle-mcp`). Alternatives considered and rejected: `openclaw-plugin-host` (misleading — we're a plugin, not a host of plugins); `bot-bridge-plugin` (carries the legacy misnomer forward); `openclaw-control-tools` (too narrow — implies just tools, not the full plugin lifecycle). The user can veto if they have a strong preference; otherwise this is the name the team-leader uses.

---

## 13. Test strategy

### 13.1 Plugin smoke test (startup gate)

**Location:** `entrypoint-control.sh` or a separate `scripts/healthcheck-plugin.sh` invoked after the openclaw process is up.

**Check:** `curl -sS -H "Authorization: Bearer ${OPENCLAW_AUTH_TOKEN}" -X POST http://127.0.0.1:18789/tools/invoke -d '{"tool":"list_projects"}'` returns HTTP 200 with a `result.content` array.

**Failure mode:** if the call returns 404 "Tool not available", the plugin did not register. The container exits unhealthy. The startup script logs the response body to stderr.

### 13.2 Discord routing smoke test (post-cutover, manual + scripted)

**Scripted part (no Discord required):** unit test on the openclaw runtime config: render the template with stub env, parse the result, assert `bindings[]` has exactly two entries with the expected `accountId`s.

**Manual part (one-time post-cutover):** operator DMs each bot ("@Anubis ping", "@Horus ping") and verifies:

- Anubis replies (not Horus, not silence).
- Horus replies (not Anubis, not silence).
- Daemon SSE stream shows the two distinct `session.created` events with the right `agentId`.

The CHANGELOG references `matchedBy` in the resolved-route shape; if openclaw logs it at info level we can grep for `matchedBy=binding.account` after each DM. If openclaw doesn't log it, add it via the plugin's `registerHook("on_message")` post-cutover (Phase 2).

### 13.3 Persona-privacy bind-mount unit test

Per §7.5. Lives in the daemon package's `test/security/`. Runs on every PR.

### 13.4 Existing daemon tests survive

The daemon test suite (`daemon/test/**`) covers project routes, task routes, memory routes, dispatch routes. None of them touch the chat tier; they remain green throughout the migration.

### 13.5 Tests that go away

`bot-bridge/test/**` — every test file in the bot-bridge package gets deleted with the package. Examples:

- `tool-call-fallback.test.ts` — tests the LLM dispatcher's fallback shape; LLM dispatcher is deleted.
- `mcp.test.ts` — tests `mcpManager`; manager is deleted.
- `subagent.test.ts` — tests `subagentRunner`; runner is deleted.
- `chatState.test.ts` (if present in stash) — chatState is stash-only; not relevant.

Net test footprint after migration: smaller package, smaller surface, but the surviving daemon tests cover the critical path and the new bind-mount test covers the privacy invariant.

### 13.6 Integration test (deferred to Phase 2)

A true end-to-end test (Discord-up → openclaw → plugin → daemon → ptah-bridge → ptah) is operator-driven for v1 because it requires real Discord credentials and a real ptah workspace. The team-leader documents this as a known gap in the QA pass; the senior-tester agent flags it in the Phase 1 acceptance review.

---

## 14. Open questions for user checkpoint

Only true blockers; the user has delegated naming and low-level decisions to me.

1. **Deployment-mechanism (BLOCKING for batch 12, NOT for this doc):** how are the four host-native processes launched today (systemd / terminal / tmux / script)? See §9.3. The team-leader needs this before writing the cutover script. The architecture doc is approvable without this answer.

2. **MCP scope (informational, default reasonable):** v1 ships with a single shared `gh` MCP server (config-wide, all agents see it). Per-persona MCP gating is Phase 2. If the user wants per-persona gating in v1, that adds ~100 lines of `tools.deny` glob config + a per-persona-resolution unit test. **Default: stay shared.** Confirm or override.

3. **Phase 1 "harness setup" tool stub vs. delete:** §3.10 plans `start_harness_setup` as a stub returning "rebuild pending." The alternative is to drop the tool name entirely from the registered set. Stub preserves the operator's muscle memory; delete is cleaner. **Default: stub.** Confirm or override.

---

## 15. Architecture delivery checklist

- [x] Target architecture diagram with PIDs from research §B4-addendum
- [x] Component inventory: keep/move/delete/merge per file
- [x] Plugin file-level layout + concrete TS for every public entry
- [x] `config/openclaw.json.tmpl` new shape with annotated diff
- [x] MCP migration: delete-target paths, add-target config, verification step
- [x] Daemon surgical changes documented route-by-route
- [x] Persona privacy: 6-layer mapping post-migration + bind-mount unit test spec
- [x] Multi-machine flow: in-machine + cross-machine + why no auto-notify
- [x] Deployment uncertainty surfaced as §9.3 Clarifications Needed (non-blocking)
- [x] Migration sequence: 13 batches, dependency-ordered, each reversible
- [x] Rollback: per-batch + global anchor + data-impact-zero
- [x] Naming: one proposal with rationale; user can veto
- [x] Test strategy: smoke / unit / integration / what dies / what survives
- [x] Open questions: only true blockers

---

**End of migration-architecture.md.**
