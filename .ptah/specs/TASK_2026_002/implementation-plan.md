# TASK_2026_002 — Implementation Plan

**Author:** software-architect
**Date:** 2026-05-02
**Status:** Ready for team-leader MODE 1
**Inputs:** `task-description.md` (acceptance criteria 1–8), `context.md` (D1–D5, A1–A8), `spike-findings.md` (R1, R2, R3, R4 facts), `CLAUDE.md` (multi-tier privacy invariant).

> No `## Clarifications Needed`. Every decision below is grounded in either a locked `Aₙ`/`Dₙ`, a verified spike fact, or a citation into the existing repo.

---

## Architecture summary

The system after this work is a **two-tier persona runtime**, splitting along a single seam — `daemon/src/harness/ptahLauncher.ts` — that nothing else in the codebase needs to know about.

**Chat tier** lives entirely in `openclaw-control/bot-bridge/`. When a Discord user @-mentions Horus (or any persona), `chat.ts` builds a per-persona system prompt assembled from three sources: the public bio (`shared-specs/memory/agents/horus/identity.md` via daemon HTTP), the private persona (`local-memory/agents/horus/persona.md` direct FS read — never traverses HTTP, per `daemon/src/memory.ts:97-100`), and any **skill bodies** loaded natively from `skills/<name>/SKILL.md` files referenced by the persona's `harness.yaml`. With `OPENCLAW_BOT_TOOL_CALLS_ENABLED=1`, the chat handler calls a new `chatCompleteWithTools(...)` in `llm.ts` that drives the OpenAI-compatible tool-calling loop against `kimi-k2.6:cloud` — already smoke-tested for `finish_reason:'tool_calls'` (`context.md` validated foundations row 1). The persona's effective tool registry is the union of: hardcoded daemon-CRUD tools (`start_harness_setup`, `dispatch_orchestration_task`, project/task helpers per A2), MCP tools surfaced by the bot-bridge-owned `mcpManager` (per-persona stdio clients via `@modelcontextprotocol/sdk`), and openclaw-native subagents (synchronous sub-chats spawned via `subagentRunner.run()`, NOT `ptah --profile <name>` — refuted by spike R2). When the flag is `0` or the loop fails, `chat.ts` falls through to the existing `chatComplete()` path and the legacy `<<oc:...>>` directive flow (D5).

**Orchestration tier** lives in the daemon. The dispatch worker (`daemon/src/dispatch.ts`) is unchanged at its layer; it still calls `invoker.ts:invokeClaudeForTask`. What changes is that `invoker.ts` no longer hand-builds the ptah arg list — it delegates to `daemon/src/harness/ptahLauncher.ts:spawnPtahForAgent({ agentId, cwd, prompt, taskId, dispatchId })`. The launcher reads a cached ptah-version probe and branches: on **0.1.3 (today)** it produces `--config <~/.ptah/agents/<id>/settings.json>` plus a per-persona Claude plugin under `~/.ptah/plugins/openclaw-<id>-harness/` (the only shape that actually loads workspace subagents — spike R2 + R4); on **a future fixed branch** (gated by `PTAH_MIN_VERSION` advancing past the version that lands `--config-dir` / `--subagent` / workspace `.claude/agents/`) it produces the cleaner shape. Migration to v2 = swap one branch in `ptahLauncher.ts` and bump `PTAH_MIN_VERSION`; nothing else moves (A7).

**Three filesystem trees** are touched, each with a different residency posture:

| Tree | Where (host) | Where (container) | Sync posture | Privacy |
|---|---|---|---|---|
| **harness.yaml** (per-agent) | `~/.claude/shared-specs/memory/agents/<id>/harness.yaml` | mounted at `/home/agent/.claude/shared-specs/memory/agents/<id>/harness.yaml` | shared via daemon HTTP API → SQLite `memory_files` row | **public** (skills/MCP/subagent declarations) |
| **persona.md** (per-agent) | `~/.claude/local-memory/agents/<id>/persona.md` | bind-mounted at `/home/agent/.claude/local-memory/...` | **never synced**, **never HTTP** (PRIVATE_AGENT_FILES — `daemon/src/db/memory.ts`) | **private** |
| **Materialized config** (per-agent) | `~/.ptah/agents/<id>/settings.json` + `~/.ptah/plugins/openclaw-<id>-harness/` | host-only — bridge runs ptah on host, so container does not need them | regenerated from harness.yaml on `harness/sync` | **config, NOT memory** — outside the privacy invariant by design |

**The harness-authoring chat** (Phase 3) is bot-bridge-native. Operator says "set up the harness for this disposable test repo"; persona's tool-registry includes a `start_harness_setup` tool that flips a per-(channel, project) state into "harness-authoring mode" and re-runs the LLM with a different system prompt and a different tool subset (`probe_project`, `read_file`, `propose_harness`, `confirm_harness`, `write_harness_file`). Final tool call writes `<project>/.claude/harness.yaml` via a new daemon endpoint (`POST /api/projects/:slug/files`). No `ptah setup`, no Pro RPCs (R1, A8).

**The peer model is permanent.** The chat tier never depends on ptah being healthy or even installed (A3). When ptah is broken, Horus still answers questions, calls subagents, and surfaces MCP tools. Only the `dispatch_orchestration_task` tool — which queues a row for the dispatch worker — touches ptah, and even that hop is asynchronous and survives transient bridge errors (the existing `invokeViaBridge` already returns failed-state on bridge unreachable, dispatch worker still records it, dispatch SSE stream still fires).

---

## Module / file breakdown

### Bot-bridge (`openclaw-control/bot-bridge/src/`)

#### `llm.ts` — extended

**Purpose:** add OpenAI-compatible tool-calling loop alongside existing single-shot chat.

**New exports (preserves existing):**

```typescript
// Existing (unchanged):
export async function chatComplete(
  systemPrompt: string,
  userMessage: string,
  opts?: { timeoutMs?: number }
): Promise<string | null>;

// NEW: tool-calling loop. Drives /chat/completions until finish_reason !== 'tool_calls'.
export interface ToolDef {
  name: string;                          // e.g. "start_harness_setup"
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema (object schema)
  /** Local resolver. Returns string content (markdown) appended as `tool` role message. */
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
}

export interface ToolCallContext {
  agentId: string;
  userId: string;       // Discord user id
  channelId: string;
  /** Free-form scratch the registry can populate (e.g. harness-authoring state). */
  state: Map<string, unknown>;
  /** Bound writer so handlers can stream observability lines (SSE on the daemon, or local logger). */
  emit: (event: string, data: unknown) => void;
}

export interface ChatWithToolsOptions {
  timeoutMs?: number;
  /** Hard depth cap; default 8. Each tool round counts as one. */
  maxDepth?: number;
  /** Wallclock cap across the whole loop; default 120_000. */
  maxWallclockMs?: number;
  /** When true (the default), MCP/subagent tool calls run in parallel within one round. */
  parallelToolCalls?: boolean;
}

export interface ChatWithToolsResult {
  /** Final assistant text (after all tool rounds resolved). */
  content: string | null;
  /** Per-round tool-call audit (for SSE, debugging, and acceptance test #3). */
  trace: Array<{
    round: number;
    calls: Array<{ name: string; argsPreview: string; durationMs: number; ok: boolean }>;
  }>;
  /** True when the loop hit maxDepth/maxWallclock without a clean finish. */
  truncated: boolean;
}

export async function chatCompleteWithTools(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  tools: ToolDef[],
  ctx: ToolCallContext,
  opts?: ChatWithToolsOptions,
): Promise<ChatWithToolsResult>;
```

**Imports from:** `undici`, `./config.js`. **Depended-on by:** `chat.ts`, `harnessAuthor.ts`, `subagents/subagentRunner.ts`.

**Test surface:**
- Unit (mocked `request`): two-round loop succeeds, resolves tool calls, returns assistant text; malformed `tool_calls` JSON → recover by appending an error tool message and continuing; `maxDepth` reached → `truncated:true`; provider 5xx → returns `content:null` (caller falls through).
- Real-LLM smoke: hit `kimi-k2.6:cloud` with the validated parallel-tool-call prompt from the spike; assert `finish_reason==='tool_calls'` after round 1, exactly two `tool` messages appended, `finish_reason==='stop'` after round 2.

#### `chat.ts` — extended

**Purpose:** branch chat path on `OPENCLAW_BOT_TOOL_CALLS_ENABLED`; assemble per-persona tool registry; surface tool-call results inline.

**Public exports:** unchanged signature `handleChat(agent: AgentDef, msg: Message): Promise<void>`.

**New private:**
```typescript
async function buildToolRegistry(agent: AgentDef, ctx: ToolCallContext): Promise<ToolDef[]>;
```
The registry is the merge of: `daemonTools.list()` + `mcpTools.listForAgent(agent.id)` + `subagentTools.list(agent)` + (when in harness-authoring mode) `harnessAuthorTools.list(ctx)`. Name collisions resolved by namespacing — see "Tool registry & dispatch loop" below.

**Branching logic:**
```typescript
if (config.toolCallsEnabled) {
  const ctx: ToolCallContext = { agentId, userId, channelId, state: new Map(), emit: bridgedEmit };
  const tools = await buildToolRegistry(agent, ctx);
  const result = await chatCompleteWithTools(sys, [{role:'user', content:text}], tools, ctx, {
    maxDepth: Number(process.env.OPENCLAW_TOOL_CALL_DEPTH_LIMIT ?? 8),
  });
  if (result.content) {
    // Render reply; the tool calls already mutated daemon state, so no
    // <<oc:...>> directive layer needed in this branch.
    return await postReply(msg, result.content);
  }
  // Fall through to the legacy path on null content.
}
return await legacyHandleChat(agent, msg); // The existing buildSystemPrompt + chatComplete + parseDirectives flow.
```

**Imports from:** `./llm.js`, `./tools/*`, `./agentRegistry.js`, `./config.js`, `./mcp/mcpManager.js`. **Depended-on by:** `commandRouter.ts`.

**Test surface:** integration with mocked LLM — flag-on path issues exactly the tools that the persona's harness declared; flag-off path is byte-identical to today's behavior.

#### `agentRegistry.ts` — extended

**Purpose:** parse `harness.yaml` from shared memory and surface it on `AgentDef`.

**Extended interface:**
```typescript
export interface AgentDef {
  id: string;
  name: string;
  identityMd?: string;
  personaMd?: string;
  tokenEnvVar: string;
  token: string | null;
  clientId?: string;
  channelAllowList?: string[];

  // NEW:
  harness?: HarnessConfig;            // null/undefined when no harness.yaml exists
  harnessVersion?: string | null;     // sha-256 of yaml bytes for harness/sync de-dup
}
```
**New exports:**
```typescript
export async function reloadAgent(id: string): Promise<AgentDef | null>;     // hot-reload single persona on harness/sync
export async function reloadAllAgents(): Promise<AgentDef[]>;
```
**Imports from:** new `./harness/types.js` (HarnessConfig + parser), `js-yaml`. **Depended-on by:** `chat.ts`, `mcp/mcpManager.ts` (subscribes to "harness changed for X" events to spin servers up/down), `subagents/subagentRunner.ts`.

**Test surface:** Yaml parse (valid → typed config); missing harness → `harness:undefined` (no error); invalid yaml → log + `harness:undefined`; `reloadAgent` returns the same id with updated `harnessVersion` when bytes change.

#### `tools/daemonTools.ts` — NEW

**Purpose:** the structured-CRUD tool surface for chat (per A2: project/task CRUD + `start_harness_setup` + `dispatch_orchestration_task`; **no raw `gh_query` / `web_fetch`** — those live behind subagents and MCP).

**Exports:**
```typescript
export function list(): ToolDef[];
// Tools registered:
//   list_projects()                                   → markdown table of projects
//   list_tasks(project: string)                       → markdown task list
//   get_task(project: string, taskId: string)         → markdown task summary + artifacts
//   create_task(project: string, description: string, agent?: string)
//                                                     → { taskId } JSON
//   approve_task(project, taskId, decision: 'APPROVED'|'REJECTED', feedback?)
//   handoff_task(project, taskId, toAgent, reason?)
//   tick_continuation()                                → counts JSON
//   start_harness_setup(project: string)               → flips ctx.state.harnessSetup = { project }
//                                                     and announces "Now in harness-authoring mode"
//   dispatch_orchestration_task(project, description, agent?)
//                                                     → calls daemon/createTask + daemon/tick;
//                                                       returns { taskId, dispatchId | null }
```
**Imports from:** `../daemonClient.js`. **Depended-on by:** `tools/index.ts` aggregator → `chat.ts`. **Test surface:** mocked daemon HTTP per tool, including the `start_harness_setup` state mutation.

#### `tools/subagentTools.ts` — NEW

**Purpose:** surface the persona's declared subagents as a single dispatch tool `delegate_to_subagent(name, prompt)` (and optionally per-subagent direct tools `delegate_to_security_review(prompt)` for nicer LLM affordance — chosen at registry-build time).

**Exports:**
```typescript
export function listForAgent(agent: AgentDef): ToolDef[];
//   delegate_to_subagent(name: string, prompt: string)         → markdown subagent reply
//   (when policy=expand) delegate_to_<subagent_name>(prompt)   → same, name fixed
```
**Imports from:** `../subagents/subagentRunner.js`, `../agentRegistry.js`. **Test surface:** registry contains exactly the subagents declared in `agent.harness.subagents`; calling the tool delegates to `subagentRunner.run`.

#### `tools/mcpTools.ts` — NEW

**Purpose:** surface every MCP-server tool the persona has open into the chat tool registry, prefixed `mcp__<server-id>__<tool-name>` to avoid collisions with native tools.

**Exports:**
```typescript
export function listForAgent(agentId: string): ToolDef[];   // pulled live from mcpManager.getOpenServers(agentId)
```
**Imports from:** `../mcp/mcpManager.js`. **Depended-on by:** chat tool registry. **Test surface:** integration with a mock MCP server (stdio echo): tool list reflects server's `tools/list` response; calling tool round-trips a `tools/call` JSON-RPC; server crash → tool removed from registry within one harness/sync cycle.

#### `tools/index.ts` — NEW

**Purpose:** small aggregator/`merge(...registries)` with name-collision policy: throw on collision unless one of the providers is namespaced (mcp__ prefix). All registries are pure functions so `chat.ts` can rebuild on every message cheaply.

#### `mcp/mcpManager.ts` — NEW

**Purpose:** own per-persona MCP server processes. See "MCP client architecture" section for full lifecycle.

**Exports:**
```typescript
export interface McpServerHandle {
  serverId: string;          // matches HarnessConfig.chatTier.mcpServers[*].id
  agentId: string;
  client: McpClient;         // @modelcontextprotocol/sdk Client
  tools: McpTool[];          // cached from tools/list at startup
  startedAt: number;
  lastErrorAt?: number;
  errorCount: number;
}
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; }

export async function startServersForAgent(agent: AgentDef): Promise<void>;
export async function stopServersForAgent(agentId: string): Promise<void>;
export async function reconcileForAgent(agent: AgentDef): Promise<void>; // diff old vs new harness, start/stop deltas
export function getOpenServers(agentId: string): McpServerHandle[];
export async function callTool(agentId: string, serverId: string, toolName: string, args: unknown): Promise<{ content: string; isError: boolean }>;
export async function shutdownAll(): Promise<void>;
```

**Imports from:** `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/client/stdio.js`. **Depended-on by:** `tools/mcpTools.ts`, `index.ts` (lifecycle). **Test surface:** see MCP section.

#### `subagents/subagentRunner.ts` — NEW

**Purpose:** synchronous sub-chats. See "Native subagent runtime" section.

**Exports:**
```typescript
export interface SubagentResult {
  name: string;
  reply: string;            // final assistant text
  durationMs: number;
  trace: ChatWithToolsResult['trace'];
  truncated: boolean;
}

export async function run(args: {
  agent: AgentDef;          // parent persona
  subagentName: string;     // must be ∈ agent.harness.chatTier.subagents
  prompt: string;
  parentCtx: ToolCallContext;   // depth comes from this
}): Promise<SubagentResult>;
```
**Imports from:** `../llm.js`, `../skills/skillLoader.js` (subagent system prompts may compose skill bodies). **Test surface:** integration with mocked LLM — system prompt assembled correctly; tool subset filtered correctly; `parentCtx.state.depth` increments; depth > `OPENCLAW_SUBAGENT_DEPTH_LIMIT` → throws.

#### `skills/skillLoader.ts` — NEW

**Purpose:** read `skills/<name>/SKILL.md`, parse frontmatter + body. See "Native skill loading" section.

**Exports:**
```typescript
export interface LoadedSkill {
  name: string;            // from frontmatter `name`
  description?: string;
  body: string;            // markdown body sans frontmatter
  source: string;          // absolute path for diagnostics
}

export async function loadSkill(name: string, opts?: { skillsRoot?: string }): Promise<LoadedSkill | null>;
export async function loadSkills(names: string[], opts?: { skillsRoot?: string }): Promise<LoadedSkill[]>;
```
**Imports from:** `gray-matter` (already in deps), `node:fs/promises`. **Default `skillsRoot`:** `process.env.OPENCLAW_SKILLS_ROOT ?? path.resolve(repoRoot, 'skills')`. **Test surface:** known good skill loads; missing skill → returns null; malformed frontmatter → returns null + warns.

#### `skills/harnessSync.ts` — NEW

**Purpose:** subscribe to Redis `harness/sync` topic; trigger `agentRegistry.reloadAgent(id)` + `mcpManager.reconcileForAgent(...)` in-process.

**Exports:**
```typescript
export async function startHarnessSync(handlers: {
  onAgentChanged: (agentId: string) => Promise<void>;
}): Promise<() => void>;   // returns stop()
```
**Imports from:** `ioredis`, `../config.js`. **Test surface:** mock Redis; publish a `harness/sync` event for `id=horus`; assert handler fires once.

#### `harnessAuthor.ts` — NEW

**Purpose:** Phase 3 chat loop. See "Harness-authoring chat" section.

**Exports:**
```typescript
export function tools(state: Map<string, unknown>): ToolDef[];   // probe_project, read_file, propose_harness, confirm_harness, write_harness_file
export const HARNESS_AUTHOR_SYSTEM_PROMPT: string;
```
**Imports from:** `./llm.js` (re-uses chatCompleteWithTools), `./daemonClient.js` (extended with `writeProjectFile`), `js-yaml`. **Depended-on by:** `tools/daemonTools.ts` (the `start_harness_setup` tool flips state to enable these), `chat.ts`. **Test surface:** unit per tool; an integration that drives the full dialog against a mocked LLM that emits a known sequence of tool calls.

#### `daemonClient.ts` — extended

**New methods:**
```typescript
writeProjectFile: (slug: string, relativePath: string, content: string) =>
  Promise<{ ok: true; sizeBytes: number }>;
//   POST /api/projects/:slug/files  body: { path: ".claude/harness.yaml", content: "..." }
readProjectFile: (slug: string, relativePath: string) =>
  Promise<{ content: string } | null>;
//   GET  /api/projects/:slug/files?path=.claude/harness.yaml
listProjectFiles: (slug: string, prefix?: string) => Promise<Array<{ path: string; size: number }>>;
//   GET  /api/projects/:slug/files?prefix=
```
Plus a tiny helper `getAgentHarness(agentId)` that fetches `agents/<id>/harness.yaml` via the existing `readMemory('agents', id, 'harness.yaml')` route — for Phase-1 use before the agentRegistry rewrite lands. **Test surface:** mocked HTTP per call.

#### `index.ts` — extended

Wire MCP manager startup/shutdown and harness/sync into the persona lifecycle:
```typescript
// After loadAgents + before client.login:
for (const def of agents) await mcpManager.startServersForAgent(def);
await startHarnessSync({
  onAgentChanged: async (id) => {
    const next = await reloadAgent(id);
    if (!next) return;
    running.get(id)!.def = next;             // hot-swap on the running map
    await mcpManager.reconcileForAgent(next);
  },
});
// On SIGTERM, call mcpManager.shutdownAll() before client.destroy().
```

#### `package.json` — extended

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0",
  "discord.js": "^14.16.3",
  "gray-matter": "^4.0.3",
  "ioredis": "^5.4.1",
  "js-yaml": "^4.1.1",
  "undici": "^6.20.1"
},
"devDependencies": {
  "@types/js-yaml": "^4.0.9",
  ...
}
```

#### `config.ts` — extended

```typescript
toolCallsEnabled: (process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED ?? '0') === '1',
toolCallDepthLimit: Number(process.env.OPENCLAW_TOOL_CALL_DEPTH_LIMIT ?? 8),
subagentDepthLimit: Number(process.env.OPENCLAW_SUBAGENT_DEPTH_LIMIT ?? 2),
mcpDefaultTimeoutMs: Number(process.env.OPENCLAW_MCP_DEFAULT_TIMEOUT_MS ?? 30_000),
skillsRoot: process.env.OPENCLAW_SKILLS_ROOT ?? '/home/anubis/Desktop/fixing-openclaw/skills',  // dev default; prod sets via env
```

### Daemon (`openclaw-control/daemon/src/`)

#### `harness/ptahLauncher.ts` — NEW

**Purpose:** the version-detect + spawn-arg seam. See "Per-tier ptah invocation" section.

**Exports:**
```typescript
export interface SpawnPtahOptions {
  agentId: string;
  cwd: string;            // container path; bridge translates
  prompt: string;
  taskId: string;
  dispatchId?: string;
}

export interface SpawnPtahResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function spawnPtahForAgent(opts: SpawnPtahOptions): Promise<SpawnPtahResult>;

/** Inspect ptah on the host (or local PATH) and cache the version + capability flags. */
export async function probePtahVersion(): Promise<{ version: string | null; configDirSupported: boolean; subagentFlagSupported: boolean }>;

/** Test/diagnostic seam — force a version branch in tests without spawning. */
export function __setProbedVersionForTests(p: { version: string; configDirSupported: boolean; subagentFlagSupported: boolean } | null): void;
```

**Imports from:** `node:child_process` (only in fallback path), `./materialize.js` (calls `materializeAgent(agentId)` once before first spawn for the agent if a stamp file is missing — defense in depth, the daemon-startup pass usually got there first), `../config.js`, `../ptahBridge.js` (preferred path: bridge), `../db/index.js` (`DispatchRepo.appendLog`). **Depended-on by:** `invoker.ts` only. **Test surface:** unit — mocked `probePtahVersion`, assert produced arg list per branch; mocked `invokeViaBridge`, assert `configFile` field is set on bridge requests.

#### `harness/materialize.ts` — NEW

**Purpose:** materialize harness.yaml → on-disk ptah config. See "Materialization (Phase 2)" section.

**Exports:**
```typescript
export interface MaterializeResult {
  agentId: string;
  settingsPath: string;        // ~/.ptah/agents/<id>/settings.json
  pluginDir: string;           // ~/.ptah/plugins/openclaw-<id>-harness/
  changed: boolean;            // true iff any file was rewritten
  summary: { settingsBytes: number; pluginAgentsCount: number };
}

export async function materializeAgent(agentId: string): Promise<MaterializeResult>;
export async function materializeAll(): Promise<MaterializeResult[]>;
/** Hard assertion that no materialized path lives under config.localMemoryRoot. */
export function assertMaterializedPathSafety(p: string): void;
```

**Imports from:** `js-yaml`, `node:fs/promises`, `../db/memory.js` (read harness.yaml shared row directly on the leader), `../config.js`. **Depended-on by:** `index.ts` (boot-time call), `bus.ts` (consumer of `harness/sync`), `harness/ptahLauncher.ts` (defensive call). **Test surface:** unit — fixture harness.yaml → exact bytes of settings.json + plugin.json + agents/*.md; idempotent (second run returns `changed:false`); privacy-invariant assertion fires if path under `local-memory/`.

#### `harness/types.ts` — NEW

**Purpose:** the `HarnessConfig` type + parser (used by daemon and by bot-bridge — copied via the same disciplined cross-package convention as `PRIVATE_AGENT_FILES`).

**Exports:**
```typescript
export interface HarnessConfig {
  version: 1;
  chatTier: {
    skills: string[];                                    // names → resolved against skillsRoot
    subagents: SubagentDef[];
    mcpServers: McpServerSpec[];
  };
  orchestrationTier: {
    skills: string[];                                    // ptah-loaded skill names
    subagents: SubagentDef[];                            // materialized into plugin/agents/*.md
    mcpServers: McpServerSpec[];                         // materialized into settings.json mcpServers
    enabledPluginIds?: string[];                         // extra plugins; openclaw-<id>-harness is added automatically
    modelTier?: 'claude_code' | 'enhanced';              // → settings.json profile (R2 allowlist)
  };
}

export interface SubagentDef {
  name: string;                          // matches Claude Plugin agent file basename
  description: string;
  systemPrompt: string;                  // markdown body for the sub-chat / agents/<name>.md body
  tools?: string[];                      // subset filter — must be ⊆ parent persona's effective tools
}

export interface McpServerSpec {
  id: string;                            // unique within the persona; safe regex /^[a-z0-9_-]+$/
  command: string;                       // e.g. "npx" or absolute path
  args?: string[];
  env?: Record<string, string>;          // ${ENV_VAR} interpolation against process.env
  timeoutMs?: number;                    // overrides OPENCLAW_MCP_DEFAULT_TIMEOUT_MS
}

export function parseHarnessYaml(yaml: string): HarnessConfig;     // throws on shape errors
export function harnessHash(yaml: string): string;                 // sha256 of bytes — for harness/sync de-dup
```

The parser is hand-rolled (matches the existing repo style — no Zod elsewhere; see `daemon/src/api.ts` for the bare-bones validators). Test surface: golden fixture round-trips, every required field validated, every optional field defaults documented in the test.

#### `invoker.ts` — modified

Replace lines 76-104 (bridge path) and 106-110 (in-container path) with a single call:

```typescript
const result = await spawnPtahForAgent({
  agentId: opts.agentId,
  cwd: opts.project.path,
  prompt: opts.prompt,
  taskId: opts.task.id,
  dispatchId: opts.dispatchId,
});
broadcast('invoker.finished', {
  taskId: opts.task.id,
  ok: result.ok,
  exitCode: result.exitCode,
});
logToDispatch(opts.dispatchId, `invoker finished agent=${opts.agentId} exit=${result.exitCode} duration=${result.durationMs}ms`,
  result.ok ? 'info' : 'warn');
return result;
```

`config.ptah.profile` is no longer read here — the launcher reads it from the per-agent settings.json (orchestration-tier `modelTier`). **Backwards compat:** if no harness.yaml exists for an agent, materialize emits a default settings.json with `enabledPluginIds:[]` and `profile:'claude_code'`, so dispatch keeps working byte-equivalent for unconfigured personas.

#### `ptahBridge.ts` — modified

Add `configFile?: string` to `BridgeInvokeOptions`; forward it in `invokeViaBridge` to the bridge:

```typescript
export interface BridgeInvokeOptions {
  cwd: string;
  prompt: string;
  taskId: string;
  agentId: string;
  profile: string;
  autoApprove?: boolean;
  configFile?: string;          // NEW: passes through as request body field
}
```

The change is a one-line body addition. Test surface: `invokeViaBridge({ ..., configFile: '/home/anubis/.ptah/agents/horus/settings.json' })` produces a request body whose JSON contains that field.

#### `api.ts` — extended

**New endpoints (auth via existing `guard`, which accepts the internal-token bearer):**

```typescript
// Project-files routes (for harness-authoring chat to write .claude/harness.yaml).
// Path validation: relativePath must be a normalized POSIX subpath of the project workspace,
// no '..' segments, no leading '/'. Filesize cap: 1 MB (same as task files).
GET    /api/projects/:slug/files?path=<relativePath>          → { content: string } | 404
GET    /api/projects/:slug/files?prefix=<dir>                 → Array<{ path, size, mtime }>
POST   /api/projects/:slug/files
       body: { path: string, content: string }                → { ok: true, sizeBytes }
DELETE /api/projects/:slug/files?path=<relativePath>          → { ok: true }

// Operator/diagnostic: trigger materialization for one agent or all.
// Both leader-only; followers 405.
POST   /api/agents/:id/harness/materialize                    → MaterializeResult
POST   /api/harness/materialize                               → MaterializeResult[]
```

The project-files route is a thin wrapper over `Project.path` + `node:fs/promises`. Mandatory guard: `await readProject(slug)` first; reject if `!project.path.startsWith('/')`. The `daemon/src/projects.ts:resolveWorkspace` resolution (existing) already rejects relative project paths.

**SSE event additions** (broadcast from `materialize.ts` and from the new endpoints):
- `harness.materialized` `{ agentId, changed, settingsPath, pluginDir }`
- `harness.synced` `{ agentId, source: 'redis' | 'http' }`
- `invoker.tool_call` `{ taskId, agentId, name, ok, durationMs }` — emitted from `chatCompleteWithTools` via `ctx.emit` for acceptance test #3

**Test surface:** `node:test` integration against a real on-disk tempdir + `inject()`-style Fastify req; identical pattern to `daemon/test/persona-privacy.test.ts`.

#### `bus.ts` — extended

**New publisher:**
```typescript
export async function publishHarnessSync(payload: { agentId: string; harnessHash: string }): Promise<void>;
// publishes to topic 'harness/sync'; bot-bridge subscribes via skills/harnessSync.ts
```

**New subscription on the daemon side:** in `startBus`, `psubscribe('harness/sync')` so when bot-bridge or a CLI emits the event, the daemon also re-runs `materializeAgent(id)`. (Bot-bridge re-loading the harness in-memory + daemon re-materializing for next dispatch are both required.) Test surface: publish on one connection, assert the subscriber callback fires.

#### `index.ts` (daemon boot) — extended

Add: after `runMigrations`, before `buildApp`:
```typescript
if (config.leader) {
  await materializeAll();             // catches up after restart
}
```

### Scripts (`scripts/ptah-bridge.mjs`)

#### Modified

1. Accept and forward optional `configFile`:
```javascript
const { cwd, prompt, taskId, agentId, profile, autoApprove, configFile } = body ?? {};
// ...
const args = ['--json', '--cwd', hostCwd];
if (configFile) {
  // configFile is a host-side path. ~/.ptah/agents/... is host-only,
  // so identity translation is the right behavior — but we still pass it
  // through translatePath() so a future config dir under the workspace
  // tree (test path?) gets mapped correctly.
  args.push('--config', translatePath(configFile));
}
if (autoApprove !== false) args.push('--auto-approve');
args.push('session', 'start', '--profile', String(profile ?? 'claude_code'), '--task', hostPrompt);
```

2. `/health` surfaces `ptahConfigDirExists`:
```javascript
import { existsSync } from 'node:fs';
const PTAH_HOME = path.join(HOME, '.ptah');
// ...
return jsonResponse(res, 200, {
  ok: true, ptahVersion: getPtahVersion(), hostUser: os.userInfo().username,
  pathMap: { workspace: { container: WS_C, host: WS_H }, specs: { container: SP_C, host: SP_H } },
  ptahConfigDirExists: existsSync(PTAH_HOME),
  ptahPluginsDirExists: existsSync(path.join(PTAH_HOME, 'plugins')),
});
```

3. **No regex extension required.** The `~/.ptah/` tree is host-side only (verified: docker-compose has no `~/.ptah` bind-mount; ptah is installed on host; bridge runs on host). Container-side daemon constructs the **path it expects on the host** because `os.homedir()` in the container is `/home/agent`, but the bridge re-roots via `os.homedir()` on the host — which means **the daemon must build settings paths using the bridge-host's home, not its own**. Solution: a new env `OPENCLAW_HOST_HOME` (default `process.env.HOME`) read by `materialize.ts` to compute the path string the daemon hands the bridge. The bridge then uses `translatePath` on it (passthrough for `~/.ptah/...`) and spawns ptah with the host path. R5 closed: regex coverage NOT extended; the path daemon emits is already a host path.

> **R5 alternate path** if the operator's host home != container `/home/agent` (which is currently the case — host home is `/home/anubis`): `materialize.ts` writes to `/home/anubis/.ptah/agents/<id>/settings.json` directly via the host bind-mount, **not** to a container-internal `~/.ptah` path. The bind-mount needed: `~/.ptah:/host-ptah:rw` in `docker-compose.yml`. The daemon writes through `/host-ptah/...`; the path string it emits to the bridge is `/home/anubis/.ptah/agents/<id>/settings.json`. **Spelled out in the materialization section below.**

### Configuration

#### `.env.example` — extended

```bash
# Tool-calling chat (chat tier feature flag — Phase 1).
# Default OFF for safe rollout. Flip to 1 after operator confirms a per-persona
# harness.yaml is in shared memory and at least one MCP server is healthy.
OPENCLAW_BOT_TOOL_CALLS_ENABLED=0

# Tool-calling loop bounds.
OPENCLAW_TOOL_CALL_DEPTH_LIMIT=8
OPENCLAW_SUBAGENT_DEPTH_LIMIT=2
OPENCLAW_MCP_DEFAULT_TIMEOUT_MS=30000

# Skills root (dev default; prod sets to the container/host path).
OPENCLAW_SKILLS_ROOT=/home/agent/skills

# Where the bridge expects ptah's home dir on the HOST (not the container's $HOME).
# Materialize.ts emits paths under this prefix.
OPENCLAW_HOST_HOME=/home/anubis

# ptah min version (validated at daemon boot; below this, ptahLauncher uses 0.1.3 branch).
PTAH_MIN_VERSION=0.1.3
```

#### `docker-compose.yml` — extended

Add bind-mount: `${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:rw`. Yes, the same path on both sides — the daemon uses absolute host paths because the bridge expects them. **No regex change in `ptah-bridge.mjs` because the path is identity-translated.**

#### `entrypoint.sh` — minor

Ensure `~/.ptah/agents/` and `~/.ptah/plugins/` exist on first boot when materialization writes:
```bash
mkdir -p "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/agents" \
         "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/plugins"
```
The daemon-side `materialize.ts` also calls `mkdir -p` defensively — this is belt-and-braces.

---

## Data shapes & schemas

### `HarnessConfig` (yaml on disk → typed object)

```yaml
# shared-specs/memory/agents/horus/harness.yaml
# (also exposed via daemon HTTP at /api/memories/agents/horus/harness.yaml)
version: 1

chatTier:
  skills:
    - security-review
    - simplify
  subagents:
    - name: pr-diff-triage
      description: Quick triage of PR diffs against OWASP Top 10.
      systemPrompt: |
        You are pr-diff-triage. ...
      tools:
        - mcp__gh__get_pull_request_diff   # subset filter — must ⊆ parent's effective tools
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
      timeoutMs: 30000

orchestrationTier:
  skills:
    - security-review
  subagents:
    - name: security-review
      description: Deep security review for orchestration runs.
      systemPrompt: |
        You are security-review. ...
      tools: ["Read", "Grep", "Edit"]
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
  enabledPluginIds: []                      # plus auto-added: openclaw-horus-harness
  modelTier: claude_code
```

### Per-persona Claude Plugin manifest

```json
{
  "name": "openclaw-horus-harness",
  "version": "1.0.0",
  "description": "openclaw-control persona harness for agent: horus",
  "agents": ["./agents/security-review.md"]
}
```

Per Claude Plugin spec (verified in spike R2 — `~/.ptah/plugins/ptah-core/.claude-plugin/plugin.json` follows the same shape). Path: `~/.ptah/plugins/openclaw-horus-harness/.claude-plugin/plugin.json`. Subagent file: `~/.ptah/plugins/openclaw-horus-harness/agents/security-review.md`:

```markdown
---
name: security-review
description: Deep security review for orchestration runs.
tools: [Read, Grep, Edit]
---
You are security-review. ...
```

### Per-agent `settings.json`

```json
{
  "$schema": "https://hiveacademy.dev/ptah/settings.schema.json",
  "profile": "claude_code",
  "enabledPluginIds": ["openclaw-horus-harness"],
  "mcpServers": {
    "gh": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

Path: `~/.ptah/agents/horus/settings.json`. Field shape verified in spike R2 (the SDK's `Gn` settings class consumes `enabledPluginIds`; mcpServers is the standard Claude Agent SDK shape).

### OpenAI-compatible tool-call message shape

(Validated via the smoke test in `context.md`; the existing `kimi-k2.6:cloud` Ollama endpoint follows the spec exactly.)

```typescript
// Outbound: /chat/completions request body when tools are present
{
  model: "kimi-k2.6:cloud",
  messages: [...],
  tools: [
    { type: "function", function: { name: "list_tasks", description: "...", parameters: {...} } },
    ...
  ],
  tool_choice: "auto",
  stream: false,
}

// Inbound: assistant turn with tool calls
{
  choices: [{
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_abc", type: "function", function: { name: "list_tasks", arguments: "{\"project\":\"foo\"}" } }
      ]
    }
  }]
}

// Loop response — append one tool-role message per call:
{ role: "tool", tool_call_id: "call_abc", content: "<markdown body>" }
```

### Daemon HTTP — new shapes

```typescript
// POST /api/projects/:slug/files
Request:  { path: string; content: string }
Response: { ok: true; sizeBytes: number } | 400 | 404 | 413

// GET /api/projects/:slug/files?path=...
Response: { content: string } | 404

// POST /api/agents/:id/harness/materialize
Request:  (empty body)
Response: { agentId, settingsPath, pluginDir, changed, summary } | 404 (unknown agent) | 405 (follower)
```

### SSE event additions

```typescript
'harness.materialized'  → { agentId: string; changed: boolean; settingsPath: string; pluginDir: string }
'harness.synced'        → { agentId: string; source: 'redis' | 'http' }
'invoker.tool_call'     → { taskId: string; agentId: string; name: string; ok: boolean; durationMs: number }
```

All consumed by the future Phase 6 dashboard; for v1 they show up in `/api/stream` and feed the acceptance-test-#3 visibility requirement.

### Validation

**Hand-rolled, matching existing repo style.** No Zod (verified against `daemon/src/api.ts` — the codebase uses bare TypeScript guards + `MemoryError` / typed Fastify validators). The `parseHarnessYaml` function in `daemon/src/harness/types.ts` is a typed validator that throws on any shape violation; bot-bridge calls the same exported function via a tiny ts-source-shared module pattern (the same way `agentRegistry.ts` already maintains a hand-mirrored `PRIVATE_AGENT_FILES` set — see comment at line 8-12 of `agentRegistry.ts`). Cross-package import isn't allowed (separate packages with separate `tsconfig.json`); we copy the parser into both packages with a CLAUDE.md note pinning the contract.

---

## Sequencing and batching

Nine batches. Every batch ships independently behind `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0`; flipping the flag activates them. **Sequential dependencies are explicit.** Batches B2/B3/B4 (chat-tier-only) can theoretically parallelize against B5/B6 (orchestration-tier-only), but the team-leader should run them sequential to keep merge surface manageable.

| ID | Title | Phase (context.md) | Files | Dependencies | Executor | Mode | Size | Success → AT# |
|---|---|---|---|---|---|---|---|---|
| **B1** | Tool-calling loop in `llm.ts` + harness types + agentRegistry harness wiring | 1 | `bot-bridge/src/llm.ts`, `daemon/src/harness/types.ts`, `bot-bridge/src/harness/types.ts` (mirror), `bot-bridge/src/agentRegistry.ts`, `bot-bridge/src/config.ts`, `.env.example`, package.json | none | backend-developer | sequential | M | foundation for AT#1, AT#2 |
| **B2** | Daemon-CRUD tool registry + chat.ts branching + plain-chat fallback test | 1 | `bot-bridge/src/tools/{daemonTools,index}.ts`, `bot-bridge/src/chat.ts`, `bot-bridge/test/tool-call-fallback.test.ts` | B1 | backend-developer | sequential | M | AT#1 (basic), AT#8 |
| **B3** | Native skill loading + persona system-prompt assembly + harness/sync wiring | 4.5 | `bot-bridge/src/skills/{skillLoader,harnessSync}.ts`, `bot-bridge/src/chat.ts` (assemble skill bodies into systemPrompt), `daemon/src/bus.ts` (publishHarnessSync), `daemon/src/api.ts` (POST `/api/agents/:id/harness/sync` to fire bus) | B1 | backend-developer | sequential | M | AT#2 |
| **B4** | Native MCP client (mcpManager) + mcpTools registry | 4.6 | `bot-bridge/src/mcp/mcpManager.ts`, `bot-bridge/src/tools/mcpTools.ts`, `bot-bridge/src/index.ts` (lifecycle), package.json (`@modelcontextprotocol/sdk`) | B1, B3 | backend-developer | sequential | L | AT#4 |
| **B5** | Native subagent runtime + subagentTools | 4 | `bot-bridge/src/subagents/subagentRunner.ts`, `bot-bridge/src/tools/subagentTools.ts` | B1, B3 | backend-developer | sequential | M | AT#3 |
| **B6** | ptahLauncher + materialize + invoker rewire | 2 | `daemon/src/harness/{ptahLauncher,materialize}.ts`, `daemon/src/invoker.ts`, `daemon/src/ptahBridge.ts`, `scripts/ptah-bridge.mjs`, `daemon/src/api.ts` (materialize endpoints + project-files route), docker-compose.yml, entrypoint.sh | B1 | backend-developer | sequential | L | AT#6 |
| **B7** | Harness-authoring chat (`harnessAuthor.ts`) + start_harness_setup state machine + project-files daemon route consumed | 3 | `bot-bridge/src/harnessAuthor.ts`, `bot-bridge/src/tools/daemonTools.ts` (`start_harness_setup`), `bot-bridge/src/daemonClient.ts` (writeProjectFile) | B2, B6 | backend-developer | sequential | M | AT#5 |
| **B8** | Pilot persona + Horus harness + integration sweep + community-tier assertion | 5 | `local-memory/agents/horus/persona.md`, `shared-specs/memory/agents/horus/{identity.md,harness.yaml}`, `daemon/test/community-tier-only.test.ts`, `bot-bridge/test/integration/horus-end-to-end.test.ts`, `docs/{ARCHITECTURE,SECURITY,SKILLS-AND-PERSONA,CONFIGURATION}.md` | B2-B7 | technical-content-writer + backend-developer | sequential | M | AT#7 ties off; full AT#1-#6 demo |
| **B9** | E2E demo polish + rollback rehearsal + ops doc | 5 | `docs/OPERATIONS.md` (rollback playbook), smoke scripts, `.ptah/specs/TASK_2026_002/demo-walkthrough.md` | B8 | backend-developer | sequential | S | acceptance-test packaging |

**Why this order:**
- B1 lands the dependency-free foundation (types + loop) so every later batch has a typed contract to land against.
- B2 ships the cheapest possible win — daemon-CRUD tool calls that already validate the entire path — and proves AT#8 (fallback) immediately.
- B3 (skills) before B4 (MCP) because the system-prompt assembly is simpler than MCP lifecycle and de-risks AT#2.
- B5 (subagents) after B3 because subagent system prompts compose skills.
- B6 (orchestration tier) is parallel-able with B3-B5 in principle but it touches a different set of files and a different test suite, so team-leader can run it as a separate sequential gate.
- B7 (harness-authoring) needs both B2 (tool registry) and B6 (project-files route).
- B8 wires the pilot persona and runs the full AT#1-#7 sweep including the community-tier assertion (`expect(no Pro RPC ever called) — implemented as a startup-time grep over the daemon's outbound HTTP fetch wrapper plus a CI smoke that runs `ptah --json license status` and refuses non-`community` results in test mode).
- B9 is buffer + operator-facing rollback runbook.

**Parallel candidates** (team-leader's call): {B3, B5} are file-disjoint and could ship in parallel. B6 is partially file-disjoint from {B3, B5} too. We recommend keeping team-leader to one-batch-at-a-time unless schedule pressure demands fanning out.

---

## Per-tier ptah invocation (concrete shapes)

### 0.1.3 branch (today — what `spawnPtahForAgent` produces)

**Bridge call body** (POST `OPENCLAW_PTAH_BRIDGE_URL/invoke`):
```json
{
  "cwd": "/home/agent/.openclaw/workspace/disposable-test-repo",
  "prompt": "<task prompt>",
  "taskId": "TASK_2026_010",
  "agentId": "horus",
  "profile": "claude_code",
  "autoApprove": true,
  "configFile": "/home/anubis/.ptah/agents/horus/settings.json"
}
```

**Resulting host-side ptah arg list** (after `scripts/ptah-bridge.mjs` translation):
```bash
ptah \
  --json \
  --cwd /home/anubis/projects/disposable-test-repo \
  --config /home/anubis/.ptah/agents/horus/settings.json \
  --auto-approve \
  session start \
    --profile claude_code \
    --task "<host-translated prompt>"
```

**Environment:** existing bridge env (OPENCLAW_TASK_ID, OPENCLAW_AGENT_ID), unchanged.

**Path translation:** workspace path `WS_C → WS_H` (existing); configFile path `/home/anubis/.ptah/...` is host-already so identity-passthrough through `translatePath()`.

### Future fixed branch (ptah ≥ X.Y.Z that adds `--config-dir`, workspace `.claude/agents/`, `--subagent`)

**Resulting host-side arg list:**
```bash
ptah \
  --json \
  --cwd /home/anubis/projects/disposable-test-repo \
  --config-dir /home/anubis/.ptah/agents/horus \
  --auto-approve \
  session start \
    --profile claude_code \
    --task "<host-translated prompt>"
```
Subagents would live at `<workspace>/.claude/agents/<name>.md` (workspace-local) and ptah would auto-discover them. The `--subagent <name>` flag would be available on a per-call basis if invoked through `chat.ts` future evolution — not required for v1 dispatch.

### Version detection

`probePtahVersion()` runs once at daemon boot:
1. If bridge enabled, `GET <bridge>/health` → reads `ptahVersion` field.
2. Else, runs `${PTAH_BIN} --version` in container (only used in dev/test).
3. Parses semver. If unparseable, default to "0.1.3 branch" (safer).
4. Caches in module-scope; `__setProbedVersionForTests` swaps for unit tests.
5. **No refresh window in v1.** Operators bumping ptah restart the daemon (existing pattern; `entrypoint.sh` is short).

---

## MCP client architecture

**Library:** `@modelcontextprotocol/sdk` v1.29.0 (latest stable), pinned in `bot-bridge/package.json`.

**Transports supported:** **stdio only in v1.** This matches the harness.yaml `command/args/env` shape and matches the `~/.ptah/agents/<id>/settings.json` `mcpServers` shape (which is also stdio-only by convention). HTTP/SSE MCP transports are out of scope; harness.yaml schema is forward-compatible (could add `transport: 'stdio'|'http'` later).

**Per-persona lifecycle** (managed in `mcpManager.ts`):
- **Start** on persona load (`index.ts:startServersForAgent`). Reads `agent.harness.chatTier.mcpServers`, spawns one `StdioClientTransport` per spec, calls `client.initialize()`, then `client.listTools()` to populate `McpServerHandle.tools`.
- **Reconcile** on every `harness/sync` event (`mcpManager.reconcileForAgent`): diff old vs new server set by id. For added: start. For removed: stop. For changed (same id, different command/args/env/timeoutMs): stop + start. Equality via deep-equal of the spec.
- **Stop** on persona unload (SIGTERM, `mcpManager.shutdownAll`): client.close(); transport.close(); kill child if it doesn't exit within 5 s.
- **Crash recovery:** if a server's transport emits `close` unexpectedly, mark `errorCount++` and respawn after exponential backoff (1s, 2s, 4s, capped at 30 s, max 6 attempts). On exhaustion, emit `mcp.server_failed` SSE; operator must `harness/sync` to retry.

**Tool merging into chat registry:** namespaced as `mcp__<server-id>__<tool-name>`. `<server-id>` matches `McpServerSpec.id` (regex-validated to `[a-z0-9_-]+`). Collision handling: if any two MCP servers expose the same tool name, the prefix disambiguates them; if any MCP tool's namespaced name collides with a native tool (extremely unlikely — natives are `snake_case` without `mcp__` prefix), `tools/index.ts` throws at registry build time.

**Concurrency budget per host:** `OPENCLAW_MCP_MAX_CONCURRENT_SERVERS` (default `8`). When exceeded at startup, log + skip excess servers. Multi-persona hosts share the budget; the manager warns when one persona starves another.

**Error handling — "flapping MCP must not break chat":**
- Tool calls have a per-server timeout (`McpServerSpec.timeoutMs ?? OPENCLAW_MCP_DEFAULT_TIMEOUT_MS`, default 30 s).
- A timeout returns `{ content: "<MCP server '<id>' tool '<n>' timed out after <ms>ms>", isError: true }` as the tool message — the chat loop continues. The model sees the error and either retries (within depth limit) or apologizes to the user.
- If a server is in backoff, its tools are filtered out of `tools/list` until it recovers — no half-broken affordances offered to the LLM.

**Per-server timeout / retry policy:**
- Tool call: 30 s default, configurable per server.
- Initialization (`client.initialize` + `listTools`): 10 s.
- Backoff curve: 1, 2, 4, 8, 16, 30 s caps; max 6 attempts.

**Test surface:** mock `StdioClientTransport`; assert lifecycle (start, list, call, stop); assert reconcile diff; assert flapping recovery; integration test with the `@modelcontextprotocol/server-everything` reference server (bundled in the SDK examples).

---

## Native subagent runtime

**Subagent definition shape (`SubagentDef`):** declared inline in `harness.yaml.chatTier.subagents`. Loaded once at agentRegistry parse time (NOT per-invocation — keeps subagent system prompts in memory; cheap and avoids race with hot-reload).

**System-prompt composition for the sub-chat:**
```
You are <subagent.name> (a subagent of <parent.name>).

<subagent.systemPrompt body>

You have access to a curated tool subset. Stay focused on the task you've been given;
return your final answer when done.

[CALLER CONTEXT]
- Parent agent: <parent.name>
- Original user message: <prompt arg>
```
The parent persona's `personaMd` is **NOT** included — subagents are scoped, not full persona-of-personas.

**Tool subset selection:**
- The subagent's `tools` field (string[] of tool names) intersects with the parent's effective tool registry.
- If `tools` is empty/missing → subagent gets ZERO tools (read-only reasoning subagent).
- If a name in `tools` doesn't exist in the parent's registry → log + skip silently. (The model would have ignored it anyway; the `harnessAuthor` confirm step warns the operator.)
- The intersection is computed fresh on every `delegate_to_subagent` call (cheap; the parent registry is already a Map).

**Loop semantics:**
- `OPENCLAW_SUBAGENT_DEPTH_LIMIT` (default `2`) caps recursion. Counter lives on `parentCtx.state.get('subagentDepth') ?? 0`.
- Each `subagentRunner.run` increments and passes a fresh `ToolCallContext` with the incremented counter.
- At depth limit, `delegate_to_subagent` rejects: tool returns `"Subagent recursion limit reached (depth=<n>); declining."` and the parent loop continues.
- **Recursive sub-sub-chats are allowed up to the depth limit** (a security-review subagent calling a more-specialized cve-lookup subagent is a legitimate pattern). Banned only at the limit.

**Result return shape:** plain markdown text (`SubagentResult.reply`). Structured returns are out of scope; the parent LLM parses the markdown if it wants structured data.

**Cost / observability:**
- Every `subagentRunner.run` emits `'invoker.subagent_started'` and `'invoker.subagent_finished'` SSE events (same channel as orchestration-tier `invoker.*`, prefix-disambiguated).
- Token count is not surfaced in v1 (the OpenAI-compat endpoint returns `usage`, but plumbing it through is Phase 6).
- Duration is recorded in `SubagentResult.durationMs` and surfaced in SSE.

**Test surface:** described in B5 above.

---

## Native skill loading

**Source path resolution:**
- Default `OPENCLAW_SKILLS_ROOT=/home/agent/skills` (container) or `<repoRoot>/skills` (dev).
- Verified existing layout: `/home/anubis/Desktop/fixing-openclaw/skills/orchestration/SKILL.md` is the canonical shape (frontmatter + body).
- For each skill name in `harness.yaml.chatTier.skills`, read `<skillsRoot>/<name>/SKILL.md`. Missing file → log warning, skip (do NOT fail persona load — a busted skill must not take Horus offline).

**Frontmatter parsing:** `gray-matter` (already a dep, line 16 of `bot-bridge/package.json`). Frontmatter is documentation-only in v1 (we don't enforce schema); body is what gets injected.

**System-prompt composition order** (in `chat.ts:buildSystemPrompt`):
```
# You are <agent.name> (id: <agent.id>)
## Public bio
<identityMd>
## Persona / system prompt
<personaMd>
## Loaded skills
### <skill1.name>
<skill1.body>
### <skill2.name>
<skill2.body>
## Available tools
<tool descriptions auto-generated from registry>
## Discord context
<channel/user info>
```

The skills section sits BETWEEN persona and tool descriptions because skills shape behavior (the model needs persona first to know "who am I", skills next to know "how do I behave", tools last for "what can I touch").

**Hot-reload via `harness/sync`:**
- Redis `harness/sync` event with `{ agentId }` → `agentRegistry.reloadAgent(id)` re-reads harness.yaml + re-loads skill bodies.
- Stored on the running `AgentDef` in the `running` Map in `index.ts`. Next inbound message rebuilds the system prompt from the fresh def — no in-flight chat is interrupted.
- `mcpManager.reconcileForAgent(next)` runs in the same tick to align MCP processes.

**Skill collision / precedence:** skills are listed by name, no hierarchy — duplicate names in the same harness.yaml are warned (deduped, first wins). Skills can't override each other; they're concatenated.

---

## Harness-authoring chat (Phase 3)

**Trigger:** operator says "set up the harness for this disposable-test-repo project". Persona's `daemonTools` registry exposes `start_harness_setup(project)` which:
1. Writes `ctx.state.set('harnessSetup', { project, stage: 'probing' })`.
2. Returns the markdown body of `HARNESS_AUTHOR_SYSTEM_PROMPT` to the LLM as the tool's response, prefixed with `"You are now in harness-authoring mode for project '<slug>'. Use the harness-authoring tools to compose a harness, then ask the operator to confirm before writing."`.
3. Causes `chat.ts` to swap the tool registry on the next round to `harnessAuthor.tools(ctx.state)` (a *replacement*, not a merge — keeps the LLM focused).

**Tool surface (from `harnessAuthor.ts`):**

```typescript
probe_project()
  → markdown summary: ls -la of project root, package.json digest if present,
    detected framework markers (angular.json / nx.json / next.config / etc.),
    open .git/config remote URL, README.md first 80 lines
  // Bounded: max 200 directory entries, no descent into node_modules/.git/dist.

read_file(relativePath: string)
  → bounded read (max 100 KB) of <project.path>/<relativePath>;
    rejects '..' segments and absolute paths.

propose_harness(yaml: string)
  → parses yaml via parseHarnessYaml; if invalid, returns the error string for the LLM to retry.
    if valid, stores in ctx.state.set('harnessSetup.proposed', config) and returns
    a markdown digest of the proposal for the operator to read in chat.

confirm_harness()
  → moves ctx.state.harnessSetup.stage = 'awaiting-operator-confirmation'.
    The LLM is instructed to STOP and end its reply asking the operator to type "yes" or "no".
    The next user message is interpreted by chat.ts as a confirmation: on "yes", flips stage to
    'writing'; on "no", clears proposed and stage='probing'.

write_harness_file()
  → only callable when stage === 'writing'. Writes <project>/.claude/harness.yaml via
    daemon's POST /api/projects/:slug/files. Optionally calls `ptah harness apply --preset <id>`
    via the bridge if the operator opted into it (community-tier-safe; verified in spike).
```

**Persona system prompt for harness-authoring mode** (`HARNESS_AUTHOR_SYSTEM_PROMPT`, lives in `harnessAuthor.ts`):

```
You are <agent.name> in HARNESS-AUTHORING MODE for project '<slug>' (path: <project.path>).

Your goal: compose a <project>/.claude/harness.yaml that captures the skills, subagents,
and MCP servers this project needs. The harness has two tiers (chat-tier loaded by
openclaw-control's bot-bridge; orchestration-tier loaded by ptah for dispatch).

Process (strict):
1. Use `probe_project` and `read_file` to understand the project.
2. Use `propose_harness` to draft a harness.yaml. The schema is HarnessConfig — see
   shared-specs/memory/templates/harness-template.yaml for the canonical shape.
3. Show the operator your proposal and explain your choices.
4. Use `confirm_harness` to ask the operator to approve.
5. After "yes", use `write_harness_file` to commit it.

If the operator says "no" or asks you to revise, go back to step 2.

Constraints:
- ONLY use community-tier ptah RPCs. Do not call wizard:* or harness:analyze-intent.
- Subagent tool subsets must reference real tools from the parent persona's effective registry.
- MCP server commands must be runnable on this host (assume container env).
```

**Cancellation / timeout / abandoned conversation:**
- `ctx.state.harnessSetup.startedAt` is set on `start_harness_setup`. On every subsequent message, if `Date.now() - startedAt > OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS` (default 30 min), state is auto-cleared with a friendly chat message.
- Operator can cancel by saying "cancel harness setup" — `chat.ts` watches for this string when state is non-null.
- Crash safety: state lives in-process. A bot-bridge restart drops the conversation; operator restarts via `start_harness_setup` again. (Phase 6 could persist this in shared memory; v1 keeps it ephemeral to avoid stale-state bugs.)

---

## Tool registry & dispatch loop

**Registration order** (in `chat.ts:buildToolRegistry`):
1. `daemonTools.list()` — always present (eight tools).
2. `subagentTools.listForAgent(agent)` — one per subagent + one umbrella `delegate_to_subagent`.
3. `mcpTools.listForAgent(agent.id)` — one per MCP-exposed tool, namespaced.
4. (When in harness-authoring mode) replace 1-3 with `harnessAuthor.tools(ctx.state)`.

**Loop bounds** (in `chatCompleteWithTools`):
- `maxDepth` rounds (default 8). One round = one assistant turn that returns `tool_calls` (zero or more) → all calls resolved → next assistant turn.
- `maxWallclockMs` (default 120_000). Tracks across all rounds; cancels in-flight via AbortController. On timeout, returns the partial assistant text we have so far + `truncated: true`.

**Error handling for malformed tool args:**
- JSON.parse failure on `function.arguments` → append `{ role:'tool', tool_call_id:..., content: "<arguments JSON parse failed: ...>" }`. Loop continues; the model usually retries with a corrected call.
- Tool handler throws → same shape, content `"<tool '<n>' failed: <err.message>>" `. Counts as a "round" for depth purposes.

**Logging — every tool call observable in daemon SSE:**
- After each tool resolves, `ctx.emit('invoker.tool_call', { taskId: <ephemeral synth>, agentId, name, ok, durationMs })` fires.
- `ctx.emit` is bound in `chat.ts` to `daemonClient.emitSseHint` — a tiny new helper that POSTs to a new `POST /api/sse/emit` daemon endpoint (internal-token only; daemon then `broadcast()`s). Keeps bot-bridge SSE-decoupled from the daemon's process.
- Acceptance test #3 verifies the operator sees `invoker.tool_call` events on the SSE stream when `delegate_to_subagent` fires.

---

## Materialization (Phase 2)

**When does it run:**
1. **Daemon startup (leader-only):** `materializeAll()` after migrations. Idempotent so a clean run is a no-op.
2. **`harness/sync` event** (Redis topic): daemon-side subscriber in `bus.ts` calls `materializeAgent(id)` for the affected persona.
3. **Explicit operator trigger:** `POST /api/agents/:id/harness/materialize` (leader-only; followers 405). Useful for "I just edited harness.yaml in DB and want it on disk now".

**Idempotency:**
- For each output file (settings.json, plugin.json, agents/*.md), compute the new content; read existing file (if present); compare bytes; rewrite only on diff.
- Returns `changed: boolean` so the caller (or the `harness.materialized` SSE event) knows whether downstream hot-reload is necessary.

**Privacy invariant (mandatory hard assertion):**
- `assertMaterializedPathSafety(absPath: string)` is called for every output path before any write.
- Implementation:
  ```typescript
  export function assertMaterializedPathSafety(p: string): void {
    const resolved = path.resolve(p);
    if (resolved.startsWith(path.resolve(config.localMemoryRoot) + path.sep) ||
        resolved === path.resolve(config.localMemoryRoot)) {
      throw new Error(
        `materialize: refusing to write inside local-memory tree: ${resolved}. ` +
        `Materialized files are CONFIG, not persona memory; the privacy invariant in ` +
        `daemon/src/memory.ts forbids configuration files from sharing the local-memory namespace.`
      );
    }
  }
  ```
- Test: feed it a path under `config.localMemoryRoot` and assert it throws. Defense in depth on top of the 3 layers in `daemon/src/memory.ts` — the invariant is now four layers deep.

**Failure modes:**
- Invalid harness.yaml (missing required field, malformed yaml) → `parseHarnessYaml` throws; `materializeAgent` rethrows with a wrapped message; `MaterializeResult.changed: false`; SSE event `harness.materialize_failed` `{ agentId, error }`. The persona keeps running on its previously-materialized config (or no config if first-time).
- Filesystem error (ENOENT on `~/.ptah/agents/`, EACCES) → wrapped + surfaced same way; daemon does NOT crash.
- Plugin manifest write succeeds but agents/*.md write fails → log + leave the partial state; next materialize will fix or surface again. (No transactional guarantee; the alternative — write to tmp + atomic rename — is overkill for a dev tool and complicates the changed-detection.)

**Output file paths (using `OPENCLAW_HOST_HOME=/home/anubis`):**
- `/home/anubis/.ptah/agents/horus/settings.json`
- `/home/anubis/.ptah/plugins/openclaw-horus-harness/.claude-plugin/plugin.json`
- `/home/anubis/.ptah/plugins/openclaw-horus-harness/agents/<subagent>.md` (one file per subagent in `orchestrationTier.subagents`)

---

## Test plan

| AT# | Mapping |
|---|---|
| **AT#1 (inline tool-call chat)** | **Unit:** `chatCompleteWithTools` with mocked LLM returning a `gh.list_issues` tool call → handler returns canned issue list → assertion on final assistant text. **Integration (real LLM):** spike-style test against `kimi-k2.6:cloud` with one daemon-CRUD tool registered (`list_projects`); assert `finish_reason==='tool_calls'` then `'stop'`, project list appears in final reply. **E2E demo:** disposable test repo with 3 open GitHub issues; flag on; @Horus "what are the open issues?"; reply contains all 3 titles within 30 s. |
| **AT#2 (per-persona harness)** | **Unit:** `agentRegistry.loadAgents` parses two harness.yaml fixtures; one with `security-review`, one without; `buildSystemPrompt` outputs include/exclude the skill body. **Integration:** `harnessSync` triggers `reloadAgent`; assert `harnessVersion` changes; next chat call includes new skill body. **E2E demo:** edit `shared-specs/memory/agents/horus/harness.yaml` to add a skill; `POST /api/agents/horus/harness/sync`; @Horus a question whose answer the skill changes; observe new behavior. |
| **AT#3 (subagent visible)** | **Unit:** `subagentRunner.run` with mocked LLM; assert tool subset filter applied. **Integration:** SSE stream shows `invoker.subagent_started` + `invoker.tool_call` for the subagent's tool calls + `invoker.subagent_finished` in order. **E2E demo:** @Horus "run a quick security review of <PR diff>"; subagent fires; reply includes its summary; SSE stream visible to operator confirms it. |
| **AT#4 (MCP tool)** | **Unit:** mcpManager mock-stdio test (start, list, call, stop). **Integration (real MCP):** spawn `@modelcontextprotocol/server-everything` (bundled in SDK); harness.yaml lists it; `mcp__everything__add(a:1,b:2)` returns `3`. **E2E demo:** Horus's harness lists `gh` MCP server; operator asks Horus to use it; `mcp__gh__*` tool fires. |
| **AT#5 (harness-authoring writes file)** | **Unit:** `harnessAuthor.tools` per-tool tests (probe/read/propose/confirm/write). **Integration:** drive the full dialog with a scripted mock LLM that emits the canonical 4-tool-call sequence; assert `<project>/.claude/harness.yaml` exists on disk + parses + matches expected. **E2E demo:** "@Horus set up harness for disposable-test-repo"; full dialog completes; operator commits the resulting yaml. |
| **AT#6 (orchestration uses per-agent ptah scope)** | **Unit:** `ptahLauncher.spawnPtahForAgent` produces the expected bridge body with `configFile` set. **Integration (real-DB pattern):** seed a dispatch row for `horus` on the leader test fixture; mock the bridge; assert it received `configFile: ".../horus/settings.json"`. **E2E demo:** dispatch a real task; tail bridge log; verify `--config /home/anubis/.ptah/agents/horus/settings.json` in the spawned ptah arg list; verify `~/.ptah/plugins/openclaw-horus-harness/agents/security-review.md` exists. |
| **AT#7 (community-tier-only)** | **Unit:** undici-mock test for the global outbound HTTP wrapper that tags every JSON-RPC call; CI assertion fails if any call's `method` matches `^wizard:` or `^harness:analyze-intent$`. **Startup assertion:** daemon boot probes `ptah --json license status` (via bridge `/health` extension); if the operator opted into `OPENCLAW_REQUIRE_COMMUNITY_TIER=1`, refuse to boot when tier !== 'community'. (Default off — operator chooses.) **E2E:** the disposable-host's `ptah --json license status` is verified `community` in the test setup; the full AT#1-#6 demo passes; CI assertion never fires. |
| **AT#8 (plain-chat fallback)** | **Unit:** `chat.ts` with flag off uses byte-identical legacy path (golden test against the existing chat.ts behavior — record + replay the buildSystemPrompt output). **Unit:** `chat.ts` with flag on but `chatCompleteWithTools` returns `null` falls through to legacy path. **Integration:** flip flag at runtime via env reload (manual restart); chat keeps working in both modes. |

**Test patterns reused:**
- Real-DB integration tests: same scaffold as `daemon/test/persona-privacy.test.ts` (env-stamp.ts → setupTestDb → buildApp → inject).
- Concurrent claim pattern from `daemon/test/dispatch-claim.test.ts` is not directly applicable here (no new shared mutex), but the `worker_threads`-vs-on-disk-DB pattern is the model for the harness/sync race test if needed.
- New patterns:
  1. **Real-LLM tool-call test** — pinned to `kimi-k2.6:cloud`, gated on `OPENCLAW_TEST_REAL_LLM=1`. Living in `bot-bridge/test/integration/` (new dir). CI doesn't run it; operator does locally.
  2. **MCP integration test** — spawns `@modelcontextprotocol/server-everything` (bundled in SDK as a known-stable demo server) as the test fixture.

---

## Configuration

### `.env` additions (`.env.example`)

```bash
# === TASK_2026_002 additions ===

# Tool-calling chat (chat tier feature flag — Phase 1).
# Default OFF; flip on after a per-persona harness is in shared memory.
# Rollback: set to 0 and restart bot-bridge — chat falls through to chatComplete.
OPENCLAW_BOT_TOOL_CALLS_ENABLED=0

# Tool-calling loop bounds.
OPENCLAW_TOOL_CALL_DEPTH_LIMIT=8        # max rounds in chatCompleteWithTools
OPENCLAW_SUBAGENT_DEPTH_LIMIT=2         # max recursion in subagentRunner
OPENCLAW_MCP_DEFAULT_TIMEOUT_MS=30000   # per-tool-call timeout for MCP servers
OPENCLAW_MCP_MAX_CONCURRENT_SERVERS=8   # per-host MCP process budget

# Harness-authoring chat timeout (auto-cancel idle sessions).
OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS=1800000   # 30 min

# Community-tier-only assertion (CI / paranoid operator).
# When 1, daemon refuses to boot if `ptah license status` reports !== 'community'.
OPENCLAW_REQUIRE_COMMUNITY_TIER=0

# Skills root (where SKILL.md files live; persona's harness references by name).
OPENCLAW_SKILLS_ROOT=/home/agent/skills

# Where the bridge expects ptah's home dir on the HOST.
# materialize.ts emits paths under this prefix.
OPENCLAW_HOST_HOME=/home/anubis

# ptah min version (already added in setup.sh — no change here, just keep documented).
PTAH_MIN_VERSION=0.1.3
```

**Rollout posture:** every flag defaults to "off" or to the safest value; operators flip the chat-side ones in `.env` after Horus's harness lands and a real MCP server is healthy. The orchestration-tier changes (B6) are not gated by a flag — they're a refactor that produces byte-equivalent ptah invocations for unconfigured personas.

### Files / dirs to create at boot (`entrypoint.sh`)

```bash
# After existing mkdir lines:
mkdir -p "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/agents" \
         "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/plugins" \
         "${OPENCLAW_LOCAL_MEMORY:-${HOME}/.claude/local-memory}/agents"
```

### `docker-compose.yml`

Add bind-mount line to the openclaw service:
```yaml
volumes:
  - ${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:rw
```

Same path on both sides — daemon emits host-path strings; bridge runs on host; container-side process has identity access via the bind-mount for materialization writes.

---

## Risks & mitigations (final)

| ID | Risk | Mitigation in this design |
|---|---|---|
| **R1** | `ptah setup` is non-interactive AND Pro-gated. | Bot-bridge owns harness-authoring chat (Phase 3 / `harnessAuthor.ts`); ptah's `setup` never invoked. Documented in B7 + AT#7. |
| **R2** | `ptah --profile <subagent>` does not load workspace subagents (silently coerced to `claude_code|enhanced`). | Chat-tier subagents are openclaw-native sub-chats (`subagentRunner.ts`). Orchestration-tier subagents materialize into `~/.ptah/plugins/openclaw-<id>-harness/agents/<n>.md` referenced by `enabledPluginIds` in the per-agent `settings.json`; `--profile` is left at `claude_code|enhanced` (the orchestration `modelTier` field). |
| **R3** | Pro license gating (`wizard:*`, `harness:analyze-intent`). | Hard-locked by A8. AT#7 asserts via outbound-HTTP-wrapper guard + optional startup assertion. CI grep over the daemon's HTTP wrapper. |
| **R4** | `~/.ptah/plugins/` is global, not per-agent. | Per-persona plugin id `openclaw-<id>-harness` (regex-validated). Materialize is idempotent and only touches its own subdir, so multiple personas coexist. Documented in materialize.ts. |
| **R5** | Host/container path translation for `~/.ptah/agents/<id>/settings.json`. | Resolved by emitting host paths from the daemon (computed against `OPENCLAW_HOST_HOME`). Bridge identity-translates them. New bind-mount in docker-compose makes the host's `~/.ptah` identity-visible inside the container. `/health` surfaces `ptahConfigDirExists` for diagnostics. |
| **R6** | Feature-flag rollback path. | `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0` plus restart returns chat to byte-equivalent legacy behavior. `mcpManager.shutdownAll()` + `harnessSync.stop()` are part of the SIGTERM path so a half-init MCP fleet can't linger. AT#8 covers the regression test. |
| **R7 (NEW)** | LLM hallucinates tool calls or returns malformed `tool_calls` JSON. | Loop's error handling appends an error tool message and continues; depth limit prevents runaway loops. AT#1 unit tests assert recovery. |
| **R8 (NEW)** | A misbehaving MCP server hangs a Discord chat thread. | Per-tool-call timeout (30 s) + per-server backoff. Servers in backoff don't appear in the registry — the LLM never even sees them. |
| **R9 (NEW)** | Bot-bridge process growth from many MCP children across many personas. | `OPENCLAW_MCP_MAX_CONCURRENT_SERVERS=8` budget; reconcile diffs old/new spec sets so harness/sync doesn't double-spawn. |
| **R10 (NEW)** | Stale harness.yaml on disk after partial materialize failure. | Materialize is per-file idempotent; `MaterializeResult.changed` lets operators see what shifted; SSE `harness.materialize_failed` surfaces problems immediately. The previously-materialized files remain valid. |
| **R11 (NEW)** | Cross-package `HarnessConfig` drift between bot-bridge and daemon copies. | Same defense-in-depth pattern as `PRIVATE_AGENT_FILES` (`agentRegistry.ts:8-12`): a comment in both copies pins the contract; CI grep ensures both files declare the same exported symbol set. |

---

## Open questions for operator (if any)

**None — design is concrete and ready for team-leader MODE 1.**

The locked decisions D1–D5, A1–A8, the spike findings R1–R5 (with R3 elevated by A8), and the codebase verification above closed every architectural fork. The only operator-facing knob left for v1 is the rollout posture of `OPENCLAW_BOT_TOOL_CALLS_ENABLED` (default off) and `OPENCLAW_REQUIRE_COMMUNITY_TIER` (default off) — both deliberately conservative. The team-leader can decompose this directly into the nine-batch sequence in §"Sequencing and batching".
