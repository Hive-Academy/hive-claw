# TASK_2026_002 — Tasks

**Total Batches:** 9 | **Status:** 5/9 complete | **Plan source of truth:** `implementation-plan.md` §"Sequencing and batching" (lines 794–820)

This task decomposes a two-tier persona runtime: chat-tier (bot-bridge — tool-calling LLM, native skills, native MCP, native subagents) + orchestration-tier (daemon — `ptahLauncher`, materialize, per-agent ptah scope). The architect's plan is APPROVED by the operator with no open clarifications. Batches B1–B9 below mirror the architect's sequencing 1:1 — sub-tasks, verification, and executor heuristics are this document's contribution.

## Status legend

- **PENDING** — not yet assigned
- **IN PROGRESS** — orchestrator has spawned the executor
- **IMPLEMENTED** — executor returned; awaiting team-leader (MODE 2) verification + commit
- **COMPLETE** — verified and committed

## Plan validation summary

**Status:** PASSED.

The architect's plan is internally consistent and grounded in spike findings (R1, R2, R4, R5 all closed in §"Risks & mitigations"). Key assumptions team-leader cross-checked:

- ✅ `kimi-k2.6:cloud` parallel tool-calls validated 2026-05-02 (`context.md` foundations row 1) → B1 unit test surface concrete.
- ✅ `--profile` allowlist enforcement is hard-coded in ptah `M$()` validator (spike findings) → B5 (subagents) correctly avoids `--profile <name>` smuggling; B6 (orchestration) correctly uses plugin-manifest path.
- ✅ Privacy invariant defense-in-depth (`CLAUDE.md` "Persona privacy rule") is preserved — `assertMaterializedPathSafety` adds a 4th layer outside `local-memory/`.
- ✅ Three filesystem trees (harness.yaml shared, persona.md private, materialized config host-only) have non-overlapping residency posture per architect's "Three filesystem trees" table (impl-plan lines 22–26).
- ✅ Backwards compat: B6's invoker rewrite emits a default `settings.json` for personas without harness.yaml, so dispatch keeps working byte-equivalent for unconfigured personas (impl-plan line 494).

**Risks tracked from spike → mitigated in batches:**

| Risk | Severity | Mitigation batch |
|---|---|---|
| R3 — Pro-gated wizard RPCs accidentally invoked | HIGH | B8 — community-tier assertion + outbound-HTTP wrapper guard + AT#7 |
| R4 — `~/.ptah/plugins/` global namespace collisions | MED | B6 — per-persona plugin id `openclaw-<id>-harness`; idempotent materialize |
| R5 — host/container path translation for materialized files | MED | B6 — `OPENCLAW_HOST_HOME` env + identity bind-mount in docker-compose |
| R6 — feature-flag rollback leaving half-init MCP fleet | MED | B4 — `mcpManager.shutdownAll()` on SIGTERM; B8 — AT#8 fallback test |
| R8 — flapping MCP server hangs Discord chat | MED | B4 — per-tool timeout + backoff; failed servers filtered from registry |
| R11 — `HarnessConfig` type drift between bot-bridge and daemon copies | LOW | B1 — pinned-contract comment + CI grep (mirror of `PRIVATE_AGENT_FILES` pattern) |

**Edge cases that need explicit handling per batch:**

- B1: malformed `tool_calls` JSON from LLM → recover, append error tool message, continue; depth-limit prevents runaway.
- B3: missing skill file (referenced in harness.yaml but not on disk) → log warn, skip; do NOT take persona offline.
- B4: MCP server crash during chat → mark failed, filter from registry, next harness/sync respawns.
- B5: subagent recursion at `OPENCLAW_SUBAGENT_DEPTH_LIMIT` → tool returns "limit reached"; parent loop continues.
- B6: persona with no `harness.yaml` → materialize emits default settings; dispatch path byte-equivalent.
- B7: harness-authoring conversation abandoned → 30 min timeout auto-clears state.

---

## Batches

### B1 — Tool-calling loop in `llm.ts` + harness types + agentRegistry harness wiring

- **Status:** COMPLETE
- **Phase:** 1 (per `context.md` phase table)
- **Files (in/out):**
  - NEW `openclaw-control/daemon/src/harness/types.ts` (HarnessConfig, SubagentDef, McpServerSpec, `parseHarnessYaml`, `harnessHash`)
  - NEW `openclaw-control/bot-bridge/src/harness/types.ts` (mirror of daemon types — same disciplined cross-package convention as `PRIVATE_AGENT_FILES`)
  - MODIFIED `openclaw-control/bot-bridge/src/llm.ts` (add `chatCompleteWithTools`, `ToolDef`, `ToolCallContext`, `ChatWithToolsOptions`, `ChatWithToolsResult`)
  - MODIFIED `openclaw-control/bot-bridge/src/agentRegistry.ts` (extend `AgentDef.harness`, add `reloadAgent`/`reloadAllAgents`)
  - MODIFIED `openclaw-control/bot-bridge/src/config.ts` (`toolCallsEnabled`, `toolCallDepthLimit`, `subagentDepthLimit`, `mcpDefaultTimeoutMs`, `skillsRoot`)
  - MODIFIED `openclaw-control/bot-bridge/package.json` (add `@modelcontextprotocol/sdk@^1.29.0`, `js-yaml@^4.1.1`, `@types/js-yaml@^4.0.9`)
  - MODIFIED `.env.example` (TASK_2026_002 env block)
- **Dependencies:** none (foundational batch)
- **Acceptance ties:** AT#1 (foundation), AT#2 (harness parsing pieces)
- **Recommended Executor:** `backend-developer` — synthesis-heavy: new public API surface, cross-package type contract, hand-rolled validator. Not a CLI-agent fit.
- **Execution Mode:** sequential
- **Size:** M
- **Sub-tasks:**
  1. Create `daemon/src/harness/types.ts` with `HarnessConfig` interface (chatTier + orchestrationTier sub-objects), `SubagentDef`, `McpServerSpec` (regex `^[a-z0-9_-]+$` for `id`), `parseHarnessYaml(yaml: string): HarnessConfig` (hand-rolled — match repo style, no Zod), `harnessHash(yaml: string): string` (sha256 hex). Throw on missing required field with message that names the field path. ~60 min.
  2. Mirror the file at `bot-bridge/src/harness/types.ts`. Add the pinned-contract comment block matching the style at `bot-bridge/src/agentRegistry.ts:8-12` (PRIVATE_AGENT_FILES pattern). The comment names both source paths and explains why both copies exist. ~20 min.
  3. Extend `bot-bridge/src/llm.ts`: add types (`ToolDef`, `ToolCallContext`, `ChatWithToolsOptions`, `ChatWithToolsResult`) and `chatCompleteWithTools(systemPrompt, messages, tools, ctx, opts)` that drives the OpenAI-compatible `/chat/completions` loop using `undici` (already in deps). Loop bounds: `maxDepth` (default 8), `maxWallclockMs` (default 120_000). Per-round audit assembled into `trace`. Malformed `tool_calls` JSON → append error tool message and continue. Depth/wallclock exceeded → return `{ content: <partial>, truncated: true }`. ~80 min.
  4. Extend `bot-bridge/src/agentRegistry.ts`: add `harness?: HarnessConfig` and `harnessVersion?: string | null` to `AgentDef`; in the existing `loadAgents` flow, fetch `agents/<id>/harness.yaml` via the existing `readMemory(...)` helper (per `daemon/src/memory.ts` shared-memory path), parse via `parseHarnessYaml`, set `harnessVersion = harnessHash(rawBytes)`. Missing yaml → `harness: undefined` (silent — not every persona has one yet). Invalid yaml → log + `undefined` (do not throw — see edge cases). Add `reloadAgent(id)` and `reloadAllAgents()`. ~60 min.
  5. Extend `bot-bridge/src/config.ts` with the five new env-driven fields and update `.env.example` with the TASK_2026_002 env block (see impl-plan §Configuration lines 1153–1182). ~20 min.
  6. Add deps to `bot-bridge/package.json`: `@modelcontextprotocol/sdk@^1.29.0`, `js-yaml@^4.1.1`, `@types/js-yaml@^4.0.9`. Run `npm install` in `bot-bridge/`. ~10 min.
  7. Unit tests in `bot-bridge/test/llm-tool-call.test.ts` (mocked `request`): two-round loop succeeds; malformed JSON recovered; `maxDepth` → `truncated:true`; provider 5xx → `content:null`. Unit tests in `bot-bridge/test/harness-types.test.ts` (golden fixture round-trip + invalid-shape rejection). ~70 min.
- **Verification (MODE 2 will check):**
  - [ ] `daemon/src/harness/types.ts` and `bot-bridge/src/harness/types.ts` exist; `diff` of the two files (after stripping the path-comment header) is zero — types are byte-identical save for the comment block.
  - [ ] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes.
  - [ ] `cd openclaw-control/daemon && npx tsc --noEmit` passes.
  - [ ] `cd openclaw-control/bot-bridge && npm test -- --grep llm-tool-call` passes (4+ assertions).
  - [ ] `cd openclaw-control/bot-bridge && npm test -- --grep harness-types` passes (golden fixture loads).
  - [ ] `grep -n parseHarnessYaml openclaw-control/{daemon,bot-bridge}/src/harness/types.ts` shows the symbol exported in both files.
  - [ ] `.env.example` contains all five new `OPENCLAW_*` env vars from impl-plan §Configuration.
  - [ ] `package.json` has `@modelcontextprotocol/sdk`, `js-yaml`, `@types/js-yaml` listed; `package-lock.json` updated.
  - [ ] No code path in this batch reads `tool_calls` arguments without a try/catch (grep `JSON.parse.*arguments` in `llm.ts` → all wrapped).
- **Commit message stem:** `feat(bot-bridge,daemon): tool-calling loop + harness types foundation (TASK_2026_002 B1)`

---

### B2 — Daemon-CRUD tool registry + chat.ts branching + plain-chat fallback test

- **Status:** COMPLETE
- **Phase:** 1
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/tools/daemonTools.ts`
  - NEW `openclaw-control/bot-bridge/src/tools/index.ts` (registry aggregator + collision policy)
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` (branch on `OPENCLAW_BOT_TOOL_CALLS_ENABLED`; build registry; fall through on `null` content)
  - NEW `openclaw-control/bot-bridge/test/tool-call-fallback.test.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/daemonClient.ts` (any new helpers used by daemonTools — `listProjects`, `listTasks`, `getTask`, `createTask`, `approveTask`, `handoffTask`, `tickContinuation`)
- **Dependencies:** B1
- **Acceptance ties:** AT#1 (basic — list_projects round-trips), AT#8 (plain-chat fallback)
- **Recommended Executor:** `backend-developer` — touches the chat lifecycle and existing legacy directive flow; needs synthesis to avoid regression. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** M
- **Sub-tasks:**
  1. Create `bot-bridge/src/tools/daemonTools.ts` with `list(): ToolDef[]` returning the 9 tools from impl-plan §`tools/daemonTools.ts` lines 178–193. Each tool's handler calls a `daemonClient.<method>` helper and returns markdown. The two state-mutating tools (`start_harness_setup`, `dispatch_orchestration_task`) follow the contracts in impl-plan; `start_harness_setup` writes `ctx.state.set('harnessSetup', { project, stage: 'probing', startedAt: Date.now() })` and returns the `HARNESS_AUTHOR_SYSTEM_PROMPT` body (B7 will add the body — for now use a placeholder string with a `// HARNESS_AUTHOR: replaced by B7` comment). ~80 min.
  2. Create `bot-bridge/src/tools/index.ts`: `merge(...registries: ToolDef[][]): ToolDef[]` with collision policy from impl-plan §"Tool registry & dispatch loop" lines 1064–1068 — throw on collision unless one provider is `mcp__`-namespaced. Pure function. ~30 min.
  3. Extend `bot-bridge/src/daemonClient.ts` with the helper methods enumerated in sub-task 1. Each method follows existing `daemonClient` style (HTTP via `undici`, internal-token bearer auth). ~60 min.
  4. Modify `bot-bridge/src/chat.ts`: add `buildToolRegistry(agent, ctx)` private helper and the branching logic from impl-plan lines 121–135. When `config.toolCallsEnabled && result.content` truthy → `postReply(msg, result.content)`; else fall through to `legacyHandleChat`. The legacy path must remain byte-identical (do NOT refactor `buildSystemPrompt` in this batch — B3 owns that). ~50 min.
  5. Write `bot-bridge/test/tool-call-fallback.test.ts`: mock the LLM to return `null`; assert legacy directive path executed (golden assertion on `parseDirectives` invocation count). Mock the LLM to return assistant text with `finish_reason:'stop'` and no tools fired; assert `postReply` called with that text. Mock the LLM to fire `list_projects` tool call; assert `daemonClient.listProjects` was hit and assistant reply contains the project names. ~50 min.
- **Verification (MODE 2 will check):**
  - [ ] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes.
  - [ ] `cd openclaw-control/bot-bridge && npm test -- --grep tool-call-fallback` passes (3+ assertions: null fallthrough, no-tools happy path, list_projects round-trip).
  - [ ] `grep -n 'config.toolCallsEnabled' openclaw-control/bot-bridge/src/chat.ts` shows exactly one branching point.
  - [ ] `grep -nE '<<oc:' openclaw-control/bot-bridge/src/chat.ts` still shows the legacy directive parsing call (untouched).
  - [ ] `tools/daemonTools.ts:list()` returns exactly 9 tools (assertion in test file).
  - [ ] Setting `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0` and running the test suite: every assertion passes (fallback survives).
- **Commit message stem:** `feat(bot-bridge): daemon-CRUD tool registry + chat.ts branching with plain-chat fallback (TASK_2026_002 B2)`

---

### B3 — Native skill loading + persona system-prompt assembly + harness/sync wiring

- **Status:** COMPLETE
- **Phase:** 4.5
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/skills/skillLoader.ts`
  - NEW `openclaw-control/bot-bridge/src/skills/harnessSync.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` (extend `buildSystemPrompt` to inject loaded skill bodies in the prescribed order)
  - MODIFIED `openclaw-control/bot-bridge/src/index.ts` (call `startHarnessSync(...)` on boot; stop on SIGTERM)
  - MODIFIED `openclaw-control/daemon/src/bus.ts` (add `publishHarnessSync({ agentId, harnessHash })`)
  - MODIFIED `openclaw-control/daemon/src/api.ts` (add `POST /api/agents/:id/harness/sync` → calls `publishHarnessSync` + recomputes hash)
- **Dependencies:** B1
- **Acceptance ties:** AT#2
- **Recommended Executor:** `backend-developer` — touches both packages, needs Redis pub/sub knowledge and lifecycle wiring. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** M
- **Sub-tasks:**
  1. [x] Create `bot-bridge/src/skills/skillLoader.ts` with `loadSkill(name, opts?)` and `loadSkills(names, opts?)`. Reads `<skillsRoot>/<name>/SKILL.md`, parses frontmatter via `gray-matter` (already in deps), returns `{ name, description?, body, source }`. Missing file → return `null`, log warning. Malformed frontmatter → return `null`, log warning. Default skillsRoot from `config.skillsRoot`. ~50 min.
  2. [x] Create `bot-bridge/src/skills/harnessSync.ts` with `startHarnessSync(handlers): Promise<() => void>`. Subscribes to Redis `harness/sync` topic via `ioredis` (already in deps); decodes `{ agentId }` payload; calls `handlers.onAgentChanged(agentId)`. Returns a `stop()` thunk. ~40 min.
  3. [x] Extend `chat.ts:buildSystemPrompt` (or its equivalent) to assemble the system prompt in the precise order from impl-plan §"Native skill loading" lines 964–982: bio → persona → loaded skills (one `### <name>` block per skill, body verbatim) → tool descriptions (placeholder until B4/B5 fill registry) → discord context. Skills are loaded once per call via `loadSkills(agent.harness?.chatTier?.skills ?? [])` — cheap because the file system is fast. ~50 min.
  4. [x] Wire `index.ts`: after `loadAgents`, call `startHarnessSync({ onAgentChanged: async (id) => { const next = await reloadAgent(id); if (next) running.get(id).def = next; } })`. Capture the returned `stop()` and call it in the SIGTERM handler before `client.destroy()`. ~30 min.
  5. [x] Add `daemon/src/bus.ts:publishHarnessSync({ agentId, harnessHash })` — publishes to `harness/sync` topic via the existing Redis publisher; payload is JSON-stringified. ~30 min.
  6. [x] Add `POST /api/agents/:id/harness/sync` to `daemon/src/api.ts`: re-reads the persona's harness.yaml from shared memory, computes `harnessHash`, calls `publishHarnessSync({ agentId, harnessHash })`. Auth via existing `guard` (internal-token). Leader-only; followers 405. ~30 min.
  7. [x] Tests: `bot-bridge/test/skill-loader.test.ts` (known good loads, missing returns null, malformed warns + returns null). `bot-bridge/test/harness-sync.test.ts` (mock Redis; publish for `id=horus`; assert handler fires once with `'horus'`). `daemon/test/api-harness-sync.test.ts` (POST endpoint fires bus publish — mocked). ~70 min.
  8. [x] **(forwarded from B2)** Wire chat-tier `ctx.emit` to `daemonClient.emitSseHint` so `invoker.tool_call` / `invoker.subagent_started` / `invoker.subagent_finished` events surface on the SSE stream. New helper `daemon.emitSseHint(event, data)` POSTs to a placeholder `/api/sse/emit` route — B6 will replace the daemon endpoint with validation + rate limiting.
- **Verification (MODE 2 will check):**
  - [x] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes; daemon side same.
  - [x] `npm test -- --grep skill-loader` passes (5 assertions — known-good, missing, malformed, ordered survivors, dedup).
  - [x] `npm test -- --grep harness-sync` passes (5 assertions — subscribe count, payload routing, stop, malformed JSON, missing agentId).
  - [x] `npm test -- --grep api-harness-sync` (daemon-side) passes (3 assertions — publish, 404, auth gate).
  - [x] Manually inspect `chat.ts:buildSystemPrompt` output for a fixture persona with one skill (e.g., `simplify`): output contains the skill's body verbatim under a `### simplify` header (smoke run captured during implementation; order bio<persona<skills<tools<discord verified).
  - [x] `grep -n 'mcpManager.reconcileForAgent' openclaw-control/bot-bridge/src/index.ts` returns nothing (the `reconcile` wiring is B4's job; this batch only stubs the `onAgentChanged` callback to swap the def).
  - [x] SIGTERM handler in `index.ts` calls `stop()` from `startHarnessSync` (captured as `stopHarnessSync`; awaited before `client.destroy()`).
- **Commit message stem:** `feat(bot-bridge,daemon): native skill loading + harness/sync hot-reload (TASK_2026_002 B3)`

---

### B4 — Native MCP client (mcpManager) + mcpTools registry

- **Status:** COMPLETE
- **Phase:** 4.6
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/mcp/mcpManager.ts`
  - NEW `openclaw-control/bot-bridge/src/tools/mcpTools.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/index.ts` (start/stop/reconcile lifecycle in boot + harness/sync handler + SIGTERM)
  - MODIFIED `openclaw-control/bot-bridge/src/tools/index.ts` (consume `mcpTools.listForAgent` in registry merge)
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` (add `mcpTools` to registry build)
- **Dependencies:** B1, B3
- **Acceptance ties:** AT#4
- **Recommended Executor:** `backend-developer` — full MCP-SDK lifecycle, backoff state machine, cross-cutting registry integration. Senior-level work. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** L
- **Sub-tasks:**
  1. [x] Create `bot-bridge/src/mcp/mcpManager.ts` with `McpServerHandle`, `McpTool` types and the five exports from impl-plan lines 239–245. Lifecycle per impl-plan §"MCP client architecture" lines 889–893: start spawns `StdioClientTransport`, `client.initialize()`, `client.listTools()`. Stop calls `client.close()` then `transport.close()` then SIGKILL after 5s. ~120 min.
  2. [x] Implement reconcile diff (`reconcileForAgent`): compute added/removed/changed by id. Equality of changed → deep-equal of `{command, args, env, timeoutMs}`. Removed → stop. Added → start. Changed → stop+start. ~60 min.
  3. [x] Implement crash recovery: on transport `close` event when not initiated by us, increment `errorCount`, schedule respawn with backoff curve `[1s, 2s, 4s, 8s, 16s, 30s]`, max 6 attempts. On exhaustion, emit SSE `mcp.server_failed` via `daemonClient.emitSseHint` (helper introduced here — see also B8) and leave handle in failed state until next reconcile. ~70 min.
  4. [x] Implement concurrency budget (`OPENCLAW_MCP_MAX_CONCURRENT_SERVERS=8`): on `startServersForAgent`, if total open across all agents would exceed budget, log warn + skip excess. ~30 min.
  5. [x] Create `bot-bridge/src/tools/mcpTools.ts:listForAgent(agentId)`: returns one `ToolDef` per `(server, tool)` pair from `mcpManager.getOpenServers(agentId)`, name-prefixed `mcp__<server-id>__<tool-name>`. Handler calls `mcpManager.callTool(agentId, serverId, toolName, args)`. Failed/backoff servers filtered out (their tools don't appear). Per-tool timeout from spec or default 30 s. ~50 min.
  6. [x] Wire `index.ts`: after `loadAgents`, `for (const def of agents) await mcpManager.startServersForAgent(def);`. In the `harness/sync` handler from B3, add `await mcpManager.reconcileForAgent(next)`. SIGTERM: call `mcpManager.shutdownAll()` BEFORE `client.destroy()`. ~30 min.
  7. [x] Update `chat.ts:buildToolRegistry` to merge in `mcpTools.listForAgent(agent.id)`. Update `tools/index.ts:merge` to recognize the `mcp__` prefix as the namespacing escape hatch (already in B2's policy — verify). ~20 min.
  8. [x] Tests: `bot-bridge/test/mcp-manager.test.ts` mocking `StdioClientTransport`: lifecycle (start, list, call, stop); reconcile diff (add+remove+change); flapping recovery (transport close → backoff → respawn). `bot-bridge/test/integration/mcp-everything.test.ts` (gated on `OPENCLAW_TEST_REAL_MCP=1`): spawn `@modelcontextprotocol/server-everything` (bundled in SDK) and round-trip a tool call. ~120 min.
- **Verification (MODE 2 will check):**
  - [x] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes.
  - [x] `npm test -- --grep mcp-manager` passes — at minimum: lifecycle start/list/call/stop, reconcile diff add+remove+change, flapping recovery hits exponential backoff, exhaustion emits `mcp.server_failed`.
  - [ ] (Local-only, gated) `OPENCLAW_TEST_REAL_MCP=1 npm test -- --grep mcp-everything` round-trips a real `add(a:1,b:2)→3` against the bundled server.
  - [x] `grep -n 'mcp__' openclaw-control/bot-bridge/src/tools/mcpTools.ts` shows the prefix is the namespacing convention.
  - [x] `grep -n 'shutdownAll' openclaw-control/bot-bridge/src/index.ts` shows it's called in the SIGTERM handler BEFORE `client.destroy()`.
  - [x] Concurrency budget enforced: a unit test starts a 9th server with budget=8 and asserts the 9th is skipped + warning logged.
  - [x] Backoff curve is `[1000, 2000, 4000, 8000, 16000, 30000]` (assert in test against the constants).
- **Commit message stem:** `feat(bot-bridge): native MCP client manager + chat tool registry integration (TASK_2026_002 B4)`

---

### B5 — Native subagent runtime + subagentTools

- **Status:** COMPLETE
- **Phase:** 4
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/subagents/subagentRunner.ts`
  - NEW `openclaw-control/bot-bridge/src/tools/subagentTools.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` (add `subagentTools` to registry build)
  - MODIFIED `openclaw-control/bot-bridge/src/tools/index.ts` (verify collision policy still holds)
- **Dependencies:** B1, B3
- **Acceptance ties:** AT#3
- **Recommended Executor:** `backend-developer` — recursive sub-chat semantics + tool-subset filtering + depth tracking on shared `ctx.state` map. Synthesis-heavy. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** M
- **Sub-tasks:**
  1. [x] Create `bot-bridge/src/subagents/subagentRunner.ts:run(args)`: validates `subagentName ∈ agent.harness.chatTier.subagents`, computes `depth = (parentCtx.state.get('subagentDepth') ?? 0) + 1`, throws if `depth > config.subagentDepthLimit`. Composes the sub-chat system prompt per impl-plan §"Native subagent runtime" lines 917–930 (does NOT include `personaMd` — scoped, not nested persona-of-personas). ~50 min.
  2. [x] Implement tool-subset filter: subagent's `tools: string[]` intersects with parent's effective registry (computed fresh per call). Empty/missing → zero tools (read-only reasoning subagent). Names not in parent registry → log + skip silently. ~30 min.
  3. [x] Spawn the sub-chat by calling `chatCompleteWithTools(subagentSystemPrompt, [{role:'user', content:prompt}], filteredTools, childCtx, opts)` where `childCtx.state.set('subagentDepth', depth)`. Return `SubagentResult` with `reply`, `durationMs`, `trace`, `truncated`. ~40 min.
  4. [x] Emit observability events at start and end via `parentCtx.emit('invoker.subagent_started', {...})` and `'invoker.subagent_finished', {...}` so AT#3's SSE visibility test passes. ~20 min.
  5. [x] Create `bot-bridge/src/tools/subagentTools.ts:listForAgent(agent)`: returns the umbrella `delegate_to_subagent(name, prompt)` tool plus optional per-subagent shortcuts `delegate_to_<n>(prompt)` (chosen at registry-build time — for v1 always emit shortcuts as well; LLM affordance is better). Handler dispatches to `subagentRunner.run`. ~40 min.
  6. [x] Wire `chat.ts:buildToolRegistry` to merge in `subagentTools.listForAgent(agent)`. Verify `tools/index.ts:merge` doesn't trip on the new entries (subagent tool names are `snake_case`, no collision with daemon tools or `mcp__` namespace). ~15 min. *Also stashed parent registry on `ctx.state` under `PARENT_TOOL_REGISTRY_STATE_KEY` so the runner can intersect without a circular import (chat → subagentTools → subagentRunner → chat).*
  7. [x] Tests: `bot-bridge/test/subagent-runner.test.ts` with mocked LLM — system prompt assembled correctly; tool subset filter intersects properly; `parentCtx.state.depth` increments; `depth > limit` throws; missing-tool-name in subagent.tools is silently skipped. `bot-bridge/test/subagent-tools.test.ts` — registry contains exactly the agent's declared subagents; calling `delegate_to_<n>` invokes runner with the right prompt. ~60 min.
  8. [x] **(forwarded from B2 → already landed in B3)** Verified `chat.ts:336-338` already wires `ctx.emit` to `daemon.emitSseHint`. No additional work — B3's commit `+ skill loading + ctx.emit wired to daemon.emitSseHint` covers this. AT#3 visibility test depends on this wire being present.
- **Verification (MODE 2 will check):**
  - [x] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes.
  - [x] `npm test -- --grep subagent-runner` passes (7 assertions: prompt composition + no personaMd leak, tool filter intersection + skip + warn, depth=0→1 increment + observability events, depth limit throws, depth=limit-1 allowed + depth=limit rejected, unknown subagent throws, only intersected tools reach LLM body).
  - [x] `npm test -- --grep subagent-tools` passes (13 assertions: empty cases, registry shape + ordering, snake_case shortcut, shortcut+umbrella dispatch end-to-end, missing-arg validation, collision policy clean, duplicate-name detection, schema required-fields).
  - [x] `grep -n 'invoker.subagent_started' openclaw-control/bot-bridge/src/subagents/subagentRunner.ts` shows the event is emitted (line 248).
  - [x] `grep -n 'personaMd' openclaw-control/bot-bridge/src/subagents/subagentRunner.ts` returns NO match (zero matches; comments rephrased to refer to "private persona body" / "parent-body field" indirectly).
  - [x] Recursion test: `subagent-runner: depth=limit-1 is allowed (bumped to limit), depth=limit is rejected (bumped past limit)` asserts both branches against `OPENCLAW_SUBAGENT_DEPTH_LIMIT=2`.
- **Commit message stem:** `feat(bot-bridge): openclaw-native subagent runtime + delegate_to_subagent tool (TASK_2026_002 B5)`

---

### B6 — ptahLauncher + materialize + invoker rewire

- **Status:** IN PROGRESS
- **Phase:** 2
- **Files (in/out):**
  - NEW `openclaw-control/daemon/src/harness/ptahLauncher.ts`
  - NEW `openclaw-control/daemon/src/harness/materialize.ts`
  - MODIFIED `openclaw-control/daemon/src/invoker.ts` (replace lines 76–110 with single `spawnPtahForAgent(...)` call)
  - MODIFIED `openclaw-control/daemon/src/ptahBridge.ts` (`BridgeInvokeOptions.configFile?: string`)
  - MODIFIED `openclaw-control/daemon/src/api.ts` (new project-files routes + `POST /api/agents/:id/harness/materialize` + `POST /api/harness/materialize` + SSE events `harness.materialized`, `harness.synced`, `invoker.tool_call`, plus `POST /api/sse/emit`)
  - MODIFIED `openclaw-control/daemon/src/bus.ts` (subscribe to `harness/sync` server-side; trigger `materializeAgent`)
  - MODIFIED `openclaw-control/daemon/src/index.ts` (call `materializeAll()` on leader after migrations)
  - MODIFIED `scripts/ptah-bridge.mjs` (forward `configFile`; `/health` exposes `ptahConfigDirExists` + `ptahPluginsDirExists`)
  - MODIFIED `docker-compose.yml` (bind-mount `${OPENCLAW_HOST_HOME:-${HOME}}/.ptah` identity-mapped)
  - MODIFIED `entrypoint.sh` (mkdir host-ptah dirs)
  - MODIFIED `.env.example` (`OPENCLAW_HOST_HOME`, `PTAH_MIN_VERSION`, `OPENCLAW_REQUIRE_COMMUNITY_TIER`, `OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS`, `OPENCLAW_MCP_MAX_CONCURRENT_SERVERS`)
- **Dependencies:** B1
- **Acceptance ties:** AT#6 (and the project-files route prerequisite for B7's AT#5)
- **Recommended Executor:** `backend-developer` — orchestration tier seam, version-detect branching, idempotent materialization, host/container path translation (R5), privacy-invariant 4th defense layer. Highest synthesis bar in the task. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** L
- **Sub-tasks:**
  1. Create `daemon/src/harness/ptahLauncher.ts`: `probePtahVersion()` reads bridge `/health.ptahVersion` (preferred) or runs `${PTAH_BIN} --version` (dev fallback); parses semver; caches in module scope. `__setProbedVersionForTests` swaps the cache. `spawnPtahForAgent({agentId, cwd, prompt, taskId, dispatchId})` branches on `configDirSupported`: 0.1.3 path produces bridge call with `configFile` field; future-fixed path uses `--config-dir`. Calls `materializeAgent(agentId)` defensively if the per-agent settings file doesn't exist yet (stamp-file check). ~90 min.
  2. Create `daemon/src/harness/materialize.ts`: reads `agents/<id>/harness.yaml` from `MemoryRepo` shared row; emits `~/.ptah/agents/<id>/settings.json` (using `OPENCLAW_HOST_HOME` to compute the host path), `~/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json`, `~/.ptah/plugins/openclaw-<id>-harness/agents/<sub>.md` (one per `orchestrationTier.subagents` entry, frontmatter `name/description/tools`). Idempotent (read existing → diff bytes → rewrite only on change). Returns `MaterializeResult.changed`. ~100 min.
  3. Implement `assertMaterializedPathSafety(absPath)`: throws with the exact message from impl-plan lines 1100–1109 if the resolved path lies under `config.localMemoryRoot`. Called for every output path before any write. Add unit test feeding it `local-memory/agents/horus/...` and assert it throws (the 4th defense layer beyond `daemon/src/memory.ts`). ~30 min.
  4. Modify `daemon/src/invoker.ts`: replace lines 76–110 (the bridge path AND the in-container fallback) with a single `spawnPtahForAgent(...)` call. The launcher returns `SpawnPtahResult`; broadcast `invoker.finished` with `{taskId, ok, exitCode}`; log to dispatch with duration. `config.ptah.profile` is no longer read here — the launcher reads `modelTier` from per-agent settings. Backwards compat: personas without harness.yaml get a default `settings.json` from materialize so the old behavior is byte-equivalent. ~60 min.
  5. Modify `daemon/src/ptahBridge.ts`: add `configFile?: string` to `BridgeInvokeOptions`; `invokeViaBridge` body includes the field when set. Test: a request with `configFile` set produces a body whose JSON contains it. ~20 min.
  6. Modify `scripts/ptah-bridge.mjs:handleInvoke` to read `configFile` from body; if present, prepend `--config <translatePath(configFile)>` to the `args` list (impl-plan lines 568–579). `/health` adds `ptahConfigDirExists` and `ptahPluginsDirExists` (impl-plan lines 583–593). The `~/.ptah` tree is host-side; identity translation handled by existing `translatePath` (no regex extension required — verified in impl-plan §R5). ~40 min.
  7. Modify `docker-compose.yml`: add `${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:rw` bind-mount to the openclaw service (same path on both sides). Modify `entrypoint.sh` to `mkdir -p` the agents/plugins subdirs at boot. ~20 min.
  8. Add daemon API endpoints (impl-plan lines 519–534, 538–543): the project-files cluster (GET single, GET prefix, POST, DELETE) with path-validation guard rejecting `..` and absolute paths; mtime exposed; 1 MB cap; `await readProject(slug)` + reject if `!project.path.startsWith('/')`. The materialize endpoints `POST /api/agents/:id/harness/materialize` and `POST /api/harness/materialize` (leader-only; followers 405). And `POST /api/sse/emit` for bot-bridge to emit observability hints. SSE event taxonomy additions: `harness.materialized`, `harness.synced`, `invoker.tool_call`. ~80 min.
  9. Wire `daemon/src/bus.ts`: `psubscribe('harness/sync')` server-side; on event, call `materializeAgent(agentId)` then broadcast `harness.materialized`. Bus already has the publisher half from B3. ~30 min.
  10. Wire `daemon/src/index.ts`: `if (config.leader) await materializeAll();` after migrations, before `buildApp`. ~15 min.
  11. Add the missing `.env.example` entries `OPENCLAW_HOST_HOME`, `PTAH_MIN_VERSION`, `OPENCLAW_REQUIRE_COMMUNITY_TIER`, `OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS`, `OPENCLAW_MCP_MAX_CONCURRENT_SERVERS` (only the subset not already added in B1's TASK_2026_002 env block). ~10 min.
  12. Tests: `daemon/test/harness-launcher.test.ts` (`__setProbedVersionForTests` to fix branch; assert produced bridge body shape per branch). `daemon/test/harness-materialize.test.ts` (golden fixture → exact bytes of settings.json + plugin.json + agents/*.md; idempotent second run returns `changed:false`; privacy-invariant assertion fires on `local-memory/` path). `daemon/test/api-project-files.test.ts` (real-DB pattern from `daemon/test/persona-privacy.test.ts`: tempdir + Fastify `inject`; happy path POST/GET/DELETE; rejection of `..` and absolute paths; 1 MB cap). `daemon/test/api-harness-materialize.test.ts` (POST returns `MaterializeResult`; follower returns 405). ~150 min.
  13. **(forwarded from B2)** `POST /api/continuation/tick` currently returns counts only (`{dispatched, checkpoints, pending}`). The B2 `dispatch_orchestration_task` tool synthesizes a `dispatchId="dispatched:<n>"` string because no specific id is exposed. If orchestrator-persona consumers need to track the specific dispatch row created during a tool-driven dispatch, extend the tick endpoint to optionally return `dispatchedIds: string[]` (or a similar shape) and update `daemonClient.tickContinuation` + `dispatch_orchestration_task` to surface the real id. Decide here based on whether B7's harness-author dispatch flow needs it; otherwise keep the synthetic-string contract and document the limitation. ~30 min.
  14. **(forwarded from B3)** Replace the placeholder `POST /api/sse/emit` route added in B3 with proper validation: event-name allowlist (`invoker.tool_call`, `invoker.subagent_started`, `invoker.subagent_finished`, `mcp.server_failed`, `harness.materialized`, `harness.synced`, plus any other taxonomy entries this batch introduces) + payload schema validation per event. Currently the placeholder forwards anything to `broadcast()` so any internal-token holder can broadcast any event. The header comment in `daemon/src/api.ts` flags B6 as the owner. ~30 min.
- **Verification (MODE 2 will check):**
  - [ ] `cd openclaw-control/daemon && npx tsc --noEmit` passes.
  - [ ] `npm test -- --grep harness-launcher` passes (both branches assertable via `__setProbedVersionForTests`).
  - [ ] `npm test -- --grep harness-materialize` passes including the privacy-invariant throw assertion (4th defense layer).
  - [ ] `npm test -- --grep api-project-files` passes including reject `..`, reject absolute, 1 MB cap, mtime in prefix listing.
  - [ ] `npm test -- --grep api-harness-materialize` passes — leader 200, follower 405.
  - [ ] `git diff openclaw-control/daemon/src/invoker.ts` shows lines 76–110 replaced with the single `spawnPtahForAgent` call; `config.ptah.profile` reference removed from this file.
  - [ ] Persona without harness.yaml gets a default `settings.json` via materialize (backwards compat — assertion in materialize test).
  - [ ] `scripts/ptah-bridge.mjs` `/health` returns `ptahConfigDirExists` and `ptahPluginsDirExists` as booleans (manual curl after `node scripts/ptah-bridge.mjs`).
  - [ ] `docker-compose.yml` bind-mount line is present and uses `${OPENCLAW_HOST_HOME:-${HOME}}/.ptah` on both sides.
  - [ ] `entrypoint.sh` creates the host-ptah agents/plugins subdirs.
  - [ ] `assertMaterializedPathSafety` is called BEFORE every `fs.writeFile` in `materialize.ts` (grep `writeFile` and verify each is preceded by the assert).
- **Commit message stem:** `feat(daemon,scripts): ptahLauncher seam + harness materialization + per-agent ptah scope (TASK_2026_002 B6)`

---

### B7 — Harness-authoring chat (`harnessAuthor.ts`) + start_harness_setup state machine + project-files daemon route consumed

- **Status:** PENDING
- **Phase:** 3
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/harnessAuthor.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/tools/daemonTools.ts` (replace `start_harness_setup` placeholder body with real `HARNESS_AUTHOR_SYSTEM_PROMPT` body and stage-machine flip)
  - MODIFIED `openclaw-control/bot-bridge/src/daemonClient.ts` (`writeProjectFile`, `readProjectFile`, `listProjectFiles`)
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` (when `ctx.state.harnessSetup` is set, replace tool registry with `harnessAuthor.tools(ctx.state)` instead of merging; handle "yes"/"no"/"cancel harness setup" string detection on next user message; 30-min idle timeout)
- **Dependencies:** B2 (tool registry plumbing), B6 (project-files daemon route)
- **Acceptance ties:** AT#5
- **Recommended Executor:** `backend-developer` — multi-turn state machine, bounded probe with `..`-rejection, integration with `parseHarnessYaml`. Synthesis-heavy. CLI agents not appropriate.
- **Execution Mode:** sequential
- **Size:** M
- **Sub-tasks:**
  1. Create `bot-bridge/src/harnessAuthor.ts` exporting `HARNESS_AUTHOR_SYSTEM_PROMPT` (the markdown body from impl-plan lines 1032–1053) and `tools(state: Map<string, unknown>): ToolDef[]` returning the 5 tools `probe_project`, `read_file`, `propose_harness`, `confirm_harness`, `write_harness_file`. ~30 min.
  2. Implement `probe_project()`: bounded `ls -la` of project root (max 200 entries; skip `node_modules/.git/dist`), `package.json` digest if present, framework markers (`angular.json`, `nx.json`, `next.config.js`, etc.), `git remote get-url origin`, README first 80 lines. All paths joined off `project.path` resolved at handler-time via `daemonClient.readProject(slug)`. ~50 min.
  3. Implement `read_file(relativePath)`: bounded read (max 100 KB), reject `..` segments and absolute paths, reject any normalized result that escapes `project.path`. ~30 min.
  4. Implement `propose_harness(yaml)`: parses via `parseHarnessYaml`. Invalid → returns the error string for the LLM to retry. Valid → stores in `ctx.state.set('harnessSetup.proposed', config)` and returns a markdown digest of the proposal (skills count, subagents list, MCP servers list, modelTier). ~30 min.
  5. Implement `confirm_harness()`: flips `ctx.state.harnessSetup.stage = 'awaiting-operator-confirmation'`. The LLM is instructed to STOP and end its reply asking the operator to type "yes" or "no". Returns guidance markdown. ~15 min.
  6. Implement `write_harness_file()`: only callable when `stage === 'writing'` (stage flipped by `chat.ts` after operator says "yes"). Calls `daemonClient.writeProjectFile(slug, '.claude/harness.yaml', yaml)`. ~20 min.
  7. Extend `daemonClient.ts` with `writeProjectFile`, `readProjectFile`, `listProjectFiles` (consume B6's daemon endpoints). Internal-token bearer auth. ~30 min.
  8. Replace the `start_harness_setup` placeholder in `tools/daemonTools.ts` with the real one: writes `ctx.state.set('harnessSetup', { project, stage: 'probing', startedAt: Date.now() })` and returns the `HARNESS_AUTHOR_SYSTEM_PROMPT` body prefixed with the entry-mode message (impl-plan §"Harness-authoring chat" lines 996–998). ~20 min.
  9. Modify `chat.ts`: when `ctx.state.has('harnessSetup')`, REPLACE the tool registry with `harnessAuthor.tools(ctx.state)` (not a merge) — keeps the LLM focused per impl-plan line 1068. Detect operator strings on next user message: "yes" / "y" → flip `stage` to `'writing'`; "no" / "n" → clear `proposed`, stage to `'probing'`; "cancel harness setup" (case-insensitive) → clear all `harnessSetup` state and post a "cancelled" reply. Auto-clear if `Date.now() - startedAt > config.harnessAuthorTimeoutMs` (default 1_800_000). ~50 min.
  10. Tests: `bot-bridge/test/harness-author.test.ts` per-tool unit tests (probe bounded, read_file rejects `..`, propose_harness validates, confirm_harness flips stage, write_harness_file gated on stage). Integration test that drives the full dialog with a scripted mock LLM emitting the canonical 4-tool-call sequence (`probe_project` → `propose_harness` → `confirm_harness` → operator says "yes" → `write_harness_file`); assert the file exists at `<project>/.claude/harness.yaml` (via mocked daemon), parses cleanly, matches the expected fixture. ~70 min.
- **Verification (MODE 2 will check):**
  - [ ] `cd openclaw-control/bot-bridge && npx tsc --noEmit` passes.
  - [ ] `npm test -- --grep harness-author` passes; the integration test asserts the final yaml round-trips through `parseHarnessYaml` cleanly.
  - [ ] `grep -n 'harnessSetup.startedAt' openclaw-control/bot-bridge/src/chat.ts` shows the timeout check is wired.
  - [ ] `grep -nE '\bcancel harness setup\b' openclaw-control/bot-bridge/src/chat.ts` shows the cancel detection.
  - [ ] `read_file` handler rejects an input like `'../etc/passwd'` (test assertion).
  - [ ] `write_harness_file` rejects when `stage !== 'writing'` (test assertion).
  - [ ] `start_harness_setup` is no longer the placeholder from B2 (`grep // HARNESS_AUTHOR: replaced by B7` returns nothing).
  - [ ] No `wizard:*` or `harness:analyze-intent` invocation in any new code path (grep confirms; B8's CI assertion will re-verify).
- **Commit message stem:** `feat(bot-bridge): harness-authoring chat tools + project-files write integration (TASK_2026_002 B7)`

---

### B8 — Pilot persona + Horus harness + integration sweep + community-tier assertion

- **Status:** PENDING
- **Phase:** 5
- **Files (in/out):**
  - NEW `local-memory/agents/horus/persona.md`
  - NEW `shared-specs/memory/agents/horus/identity.md`
  - NEW `shared-specs/memory/agents/horus/harness.yaml`
  - NEW `openclaw-control/daemon/test/community-tier-only.test.ts`
  - NEW `openclaw-control/bot-bridge/test/integration/horus-end-to-end.test.ts`
  - MODIFIED `docs/SKILLS-AND-PERSONA.md` (chat-tier vs orchestration-tier split; harness file format; materialization output paths)
  - MODIFIED `docs/CONFIGURATION.md` (`OPENCLAW_BOT_TOOL_CALLS_ENABLED`, `PTAH_MIN_VERSION`, `OPENCLAW_HOST_HOME`, `OPENCLAW_REQUIRE_COMMUNITY_TIER`, harness file format reference)
  - MODIFIED `docs/ARCHITECTURE.md` (ptahLauncher seam section; per-persona plugin layout; peer-model resilience point)
  - MODIFIED `docs/SECURITY.md` (confirm materialized files are config not memory; privacy invariant unchanged + 4th defense layer)
  - MODIFIED `openclaw-control/daemon/src/api.ts` and outbound HTTP wrapper (CI assertion: any HTTP call whose JSON body's `method` matches `^wizard:` or `^harness:analyze-intent$` throws in test mode)
  - MODIFIED `CLAUDE.md` (per repo convention: "When making non-trivial changes to architecture, update both `docs/OPENCLAW_CONTROL.md` and this file" — add a bullet on chat-tier peer model)
- **Dependencies:** B2, B3, B4, B5, B6, B7
- **Acceptance ties:** AT#7 ties off here; full AT#1–#6 demonstrated in integration sweep
- **Recommended Executor:** **`technical-content-writer` for the docs + persona content** (`persona.md`, `identity.md`, `harness.yaml`, doc revisions); **`backend-developer` for the integration test + community-tier wrapper** (`community-tier-only.test.ts`, `horus-end-to-end.test.ts`, outbound-HTTP guard). Two specialists; **the orchestrator should run technical-content-writer first** (no code dependencies) **then backend-developer** (consumes the harness.yaml fixture in tests). State this split explicitly when assigning.
- **Execution Mode:** sequential (the two roles must hand off; not parallelizable because the test suite consumes the writer's harness.yaml fixture)
- **Size:** M
- **Sub-tasks:**
  1. **(technical-content-writer)** Write `local-memory/agents/horus/persona.md` — pilot persona (security focus, narrow surface, voice). Stays in local-memory only (private; never traverses HTTP per `daemon/src/memory.ts:97-100`). ~40 min.
  2. **(technical-content-writer)** Write `shared-specs/memory/agents/horus/identity.md` — public bio (what Horus does, available to operators via daemon HTTP). ~30 min.
  3. **(technical-content-writer)** Write `shared-specs/memory/agents/horus/harness.yaml` — pilot harness exactly per impl-plan §"HarnessConfig" lines 645–683 (chatTier: skills `[security-review, simplify]`, subagent `pr-diff-triage`, MCP server `gh`; orchestrationTier: skills `[security-review]`, subagent `security-review`, MCP server `gh`, `modelTier: claude_code`). Skill names must reference real `skills/<name>/SKILL.md` files (verify `skills/security-review/SKILL.md` and `skills/simplify/SKILL.md` exist; if not, scaffold minimal SKILL.md stubs with frontmatter only — sub-task 3a). ~40 min.
  4. **(technical-content-writer)** Update `docs/SKILLS-AND-PERSONA.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `CLAUDE.md` per impl-plan §Documentation lines 116–122. Doc style follows the existing files (ranger-cinematic prose, fact-grounded, no marketing voice). Confirm the privacy-invariant 4th defense layer is mentioned in `docs/SECURITY.md`. ~80 min.
  5. **(backend-developer)** Implement the outbound HTTP wrapper guard for `wizard:*` and `harness:analyze-intent`: extend the existing daemon `fetch`/`undici` wrapper to inspect JSON bodies and throw in test mode (`process.env.NODE_ENV === 'test' || process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER === '1'`) when method matches the forbidden regex. CI integration: the daemon test boot stamps the env var and runs the AT#1–#6 sweep; any forbidden RPC throws and fails the suite. ~50 min.
  6. **(backend-developer)** Add startup assertion in `daemon/src/index.ts` (or a new `harness/licenseGuard.ts`): if `OPENCLAW_REQUIRE_COMMUNITY_TIER=1`, on boot probe `ptah --json license status` (via bridge `/health` extension; bridge already exposes `ptahVersion` per B6 — extend `/health` to include `ptahLicenseTier`). Refuse to boot when tier !== 'community'. Default off. ~40 min.
  7. **(backend-developer)** Write `daemon/test/community-tier-only.test.ts`: undici-mock test that fires every new daemon code path that COULD reach Pro RPCs and asserts none do; one explicit negative test attempts a `wizard:deep-analyze` POST and asserts the wrapper throws. ~40 min.
  8. **(backend-developer)** Write `bot-bridge/test/integration/horus-end-to-end.test.ts`: orchestrate AT#1–#6 in one suite using the fixtures from sub-tasks 1–3. AT#1 (mocked LLM emits `list_projects` tool call → assistant text contains project names). AT#2 (load Horus harness; assert `security-review` skill body present in system prompt). AT#3 (mocked LLM fires `delegate_to_subagent` → SSE events `invoker.subagent_started/finished` captured). AT#4 (mocked stdio MCP returns a tool result; assistant text includes it). AT#5 (drive harness-authoring dialog from B7's integration test fixture against a temp project; verify `.claude/harness.yaml` written + parses). AT#6 (`spawnPtahForAgent` produces a bridge body with `configFile=.../horus/settings.json`; `~/.ptah/plugins/openclaw-horus-harness/agents/security-review.md` exists on disk). ~120 min.
  9. **(forwarded from B3)** Add a followers-405 test for `POST /api/agents/:id/harness/sync` (and any other leader-only endpoint introduced in B3–B7 — `harness/materialize`, project-files write, etc.). The B3 405 branch is a single `if (!config.leader)` guard but no automated test covers it; add one to the integration sweep. ~20 min.
  10. **(forwarded from B3 — security audit note)** During the security-review sweep at acceptance test #7, audit whether `safeFile`'s `.yaml` extension allowance in `daemon/src/memory.ts` (added in B3 to enable `harness.yaml` shared-memory storage) should be scope-narrowed (e.g., regex restricted to `harness.yaml` only, or extension gated by scope). Persona-privacy invariant is currently intact because `PRIVATE_AGENT_FILES` is the gate (literal-set match — `persona.yaml` is NOT a member and would route to shared, which is documented behavior, not a leak). The audit is forward-looking surface-area minimization, not a fix for a known vulnerability. Document the finding in `docs/SECURITY.md` either way. ~15 min.
  11. **(forwarded from B4)** Document in operator runbook: AT sweep with real MCP requires `npm i -D @modelcontextprotocol/server-everything` in bot-bridge before running `OPENCLAW_TEST_REAL_MCP=1 npm test -- --grep mcp-everything`. The package is intentionally NOT in `package.json` deps (local-only diagnostic; CI never runs the gated test). Add to `docs/TROUBLESHOOTING.md` or `docs/OPERATIONS.md` under an "MCP integration smoke test" subsection. ~10 min.
- **Verification (MODE 2 will check):**
  - [ ] `local-memory/agents/horus/persona.md` exists; the daemon refuses to read it via `GET /api/memories/agents/horus/persona.md` (returns 404 — privacy invariant, layer 2 of the 3-layer enforcement; assertion in test).
  - [ ] `shared-specs/memory/agents/horus/identity.md` is reachable via daemon HTTP (manual curl against running daemon; or assertion in horus-end-to-end test).
  - [ ] `shared-specs/memory/agents/horus/harness.yaml` parses cleanly via `parseHarnessYaml` (assertion in test).
  - [ ] `npm test -- --grep community-tier-only` passes — the negative test confirms the wrapper throws on `wizard:*` or `harness:analyze-intent` invocation.
  - [ ] `npm test -- --grep horus-end-to-end` passes all 6 acceptance-test scenarios (AT#1 through AT#6).
  - [ ] `OPENCLAW_REQUIRE_COMMUNITY_TIER=1 node openclaw-control/daemon/dist/index.js` boots successfully on the dev host (license tier `community` per spike).
  - [ ] `docs/SKILLS-AND-PERSONA.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` updated; cross-link from `docs/OPENCLAW_CONTROL.md` (the canonical landing per `CLAUDE.md`) is consistent.
  - [ ] `CLAUDE.md` mentions the chat-tier peer model in a single bullet.
  - [ ] `grep -rnE 'wizard:[a-z-]+|harness:analyze-intent' openclaw-control/{daemon,bot-bridge}/src/` returns NO matches (empty grep is the success condition).
- **Commit message stem:** `feat(docs,bot-bridge,daemon): pilot Horus persona + community-tier assertion + AT sweep (TASK_2026_002 B8)`

---

### B9 — E2E demo polish + rollback rehearsal + ops doc

- **Status:** PENDING
- **Phase:** 5
- **Files (in/out):**
  - MODIFIED `docs/OPERATIONS.md` (rollback playbook for `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0`; harness-resync runbook)
  - NEW `.ptah/specs/TASK_2026_002/demo-walkthrough.md` (operator-runnable AT#1–#6 demo script)
  - NEW (or modified) smoke scripts under `scripts/` for the demo (`scripts/smoke-horus-tool-calls.sh`, optional)
  - MODIFIED `docs/TROUBLESHOOTING.md` (entries for: MCP server failed-state recovery, harness/sync didn't fire, materialize failed mid-flight, host/container path mismatch with `OPENCLAW_HOST_HOME`)
- **Dependencies:** B8
- **Acceptance ties:** acceptance-test packaging (no new AT)
- **Recommended Executor:** `backend-developer` — operations-focused but light synthesis; smoke scripts + runbook prose. Could split docs sub-tasks to `technical-content-writer` if scheduling pressure exists, but the volume here is small enough that one developer with full context is the cleanest cut.
- **Execution Mode:** sequential
- **Size:** S
- **Sub-tasks:**
  1. Add a "Rollback: turn off tool-calling chat" section to `docs/OPERATIONS.md`: set `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0`, restart bot-bridge (`docker compose restart openclaw`), verify chat falls through to `chatComplete` (Horus replies in plain text). Include a "harness-resync runbook" section: edit `harness.yaml` in shared memory, `POST /api/agents/horus/harness/sync` (curl with internal-token), confirm SSE event `harness.materialized` fires, confirm next chat reflects the change. ~40 min.
  2. Author `.ptah/specs/TASK_2026_002/demo-walkthrough.md`: a step-by-step operator demo for AT#1 → AT#6 against the disposable test repo. Include exact curl commands, expected Discord behaviors, and SSE-stream observations (`curl http://localhost:7878/api/stream?topics=invoker,harness | jq`). ~50 min.
  3. (Optional) Author `scripts/smoke-horus-tool-calls.sh`: invokes the bridge `/health`, the daemon `/api/health`, posts a synthetic chat message via the daemon HTTP test seam, and asserts an `invoker.tool_call` event appears on the SSE stream. Useful for CI smoke + post-deploy verification. ~30 min.
  4. Add 4 entries to `docs/TROUBLESHOOTING.md`: (a) "MCP server failed and tools missing from chat" — explain backoff + resync procedure; (b) "Harness/sync didn't fire" — check Redis, check daemon `psubscribe` health; (c) "Materialize failed; persona stuck on old config" — explain `harness.materialize_failed` SSE + manual `POST /api/agents/:id/harness/materialize`; (d) "Host/container path mismatch (R5)" — explain `OPENCLAW_HOST_HOME` + bind-mount + `/health.ptahConfigDirExists`. ~40 min.
  5. Run the demo end-to-end on the dev host and capture any gaps; loop back to fix or document deviations. ~30 min.
- **Verification (MODE 2 will check):**
  - [ ] `docs/OPERATIONS.md` has a "Rollback: turn off tool-calling chat" section AND a "Harness-resync runbook" section (grep header text).
  - [ ] `.ptah/specs/TASK_2026_002/demo-walkthrough.md` exists and the curl commands listed there are syntactically valid (manual review; or `bash -n` for any shell-block).
  - [ ] (If included) `scripts/smoke-horus-tool-calls.sh` is `chmod +x` and runs cleanly against the dev host.
  - [ ] `docs/TROUBLESHOOTING.md` has 4 new entries matching the topics in sub-task 4 (grep section headers).
  - [ ] Operator can complete the AT#1–#6 walkthrough following only the demo doc, with no out-of-band help (qualitative; team-leader spot-checks 1–2 steps during MODE 2 verification).
- **Commit message stem:** `docs: rollback playbook + AT demo walkthrough + troubleshooting (TASK_2026_002 B9)`

---

## Parallel-candidate map

The architect explicitly named two parallelization opportunities:

| Pair / triple | File-disjoint? | Recommendation |
|---|---|---|
| **{B3, B5}** | YES — B3 touches `bot-bridge/src/skills/*` + `chat.ts` system-prompt assembly + bus + api harness/sync; B5 touches `bot-bridge/src/subagents/*` + `tools/subagentTools.ts` + `chat.ts` registry merge. The only overlap is `chat.ts`, but the lines edited are different (B3 in `buildSystemPrompt`, B5 in `buildToolRegistry`). | Default **sequential** (B3 first, then B5 — B5's subagent system prompts may compose skill bodies via `skillLoader`, so B3 first eliminates an integration-time gotcha). Parallelize ONLY under schedule pressure, and only after B3's `skillLoader` API surface has been merged so B5 can stub-import without conflict. |
| **B6 vs {B3, B5}** | Mostly YES — B6 is daemon + scripts + docker-compose; B3/B5 are bot-bridge. The only shared file is `.env.example` (both add env vars), which is a trivial 3-way merge. | Default **sequential**. The architect's own note (impl-plan line 815): "B6 is parallel-able with B3-B5 in principle but it touches a different set of files and a different test suite, so team-leader can run it as a separate sequential gate." Defer to that. |
| Anything else | No file-disjoint triple available. B7 needs both B2 and B6; B8 needs B2–B7 (the integration sweep). | All other batches must be sequential. |

**Recommendation to orchestrator:** run all 9 batches sequentially. The merge-surface savings from parallelizing {B3, B5} are roughly half a developer-day; the QA cost of a multi-file merge through `chat.ts` exceeds that. If scheduling pressure changes, revisit after B6 lands.

---

## Executor heuristics applied

The orchestration skill's heuristic table reads: "3+ independent file-disjoint tasks → CLI parallel; tightly-coupled cross-file refactoring → sub-agent dev". Applying that honestly to this task:

- **B1, B2, B3, B4, B5, B6, B7 → all `backend-developer`.** Every one of these batches is multi-file synthesis work that depends on shared TypeScript types, lifecycle wiring, and existing repo conventions (hand-rolled validators, tool-registry collision policy, persona privacy invariant). The cost of CLI agents losing shared context (you'd have to re-feed `harness.yaml` schema, the registry-merge contract, and the bridge body shape into every CLI prompt) outweighs the parallelism benefit.
- **B8 → split: `technical-content-writer` first (persona/identity/harness/docs), then `backend-developer` (community-tier wrapper + integration test).** This split is the architect's own recommendation in `context.md` phase 5 ("technical-content-writer + operator"), and it's the right cut — the writer doesn't need TS-compiler context to draft persona prose, and the developer can start the integration test once the harness.yaml fixture is committed.
- **B9 → `backend-developer`.** Operations-doc work is small enough that handing it to a separate writer adds coordination overhead exceeding the gain.

**CLI-delegation opportunities — honestly: none worth it for this task.**

The CLI candidates I considered and rejected:

- *Generating Zod-style schemas in B1?* Plan explicitly chose hand-rolled validators (no Zod elsewhere — see impl-plan line 470). Nothing to mechanize.
- *Generating golden test fixtures (e.g., expected materialize output bytes) in B6?* The fixture must be byte-exact to the actual implementation; generating it independently risks drift. The developer should write fixture + implementation in lock-step.
- *Doc rewrites in B8?* `technical-content-writer` is the right specialist (deep codebase knowledge required for SECURITY.md privacy invariant prose); a CLI agent without that context produces shallow prose.
- *Mechanical grep audit in B8 (`grep -rnE 'wizard:.*'`)?* This is a verification step in MODE 2, not an implementation sub-task. Team-leader runs it directly; no delegation needed.

A future task with a wider mechanical surface (e.g., 30+ MCP server schemas to scaffold from JSON-RPC capability discovery) would be a strong CLI-delegation fit. This task isn't.

---

## Implementation cycle starts at B1

B1 is the only valid starting batch. It introduces the `HarnessConfig` type contract that B2–B7 all consume; the `chatCompleteWithTools` API that B2/B5/B7 all call; and the `agentRegistry` extension that B3 hot-reloads. Every other batch has B1 listed as a hard dependency in the architect's plan. There is no reason to start anywhere else.

After B1 ships and is merged, the orchestrator can assign B2 (cheapest win — first AT demonstrable on real-LLM smoke), proceed through B3 → B4 → B5 → B6 → B7 → B8 → B9 in order. Whenever schedule pressure rises, the only move worth considering is parallelizing {B3, B5} after B1 is in (the parallel-candidate map above).
