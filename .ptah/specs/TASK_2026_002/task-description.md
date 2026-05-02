# TASK_2026_002 — Task Description

## Problem statement

The Discord chat path in `openclaw-control/bot-bridge` is, by design, a single-shot LLM call: `chat.ts` builds a system prompt, hits `chatComplete` in `llm.ts`, and lets the model emit `<<oc:...>>` directives that get executed after the fact. There are no real tool calls, no subagents, and no MCP servers — so when an operator asks Anubis "what GitHub issues are open on `pro-estate`?" the model has no way to actually fetch them. In the most recent demo it confidently hallucinated "`gh` isn't authenticated", even though the container's `gh` is logged in as `Abdallah-khalil` and the answer was one shell call away. Anubis sounds capable; in practice it can't reach into a project at all.

At the same time, the orchestration path (`daemon/src/dispatch.ts` → `daemon/src/invoker.ts` → `scripts/ptah-bridge.mjs`) ships a single hard-coded ptah profile (`config.ptah.profile`, default `claude_code`) for every dispatched run. Every persona — Anubis, Horus, the next one — gets the same system prompt, the same tool set, the same skill surface. There is no per-agent harness composition, no way to say "Horus has the `security-review` skill loaded but not the `angular-3d` one", no way to scope which MCP servers a given persona's dispatched runs can talk to. The product story we have been telling — multi-agent, each persona with its own brain — is currently a registry of bot tokens with one shared backend.

Success looks like this: each persona has a versioned harness that names its skills, subagents, and MCP servers. On Discord, that persona can answer questions and take actions inline using real tool calls (subagent invocations, MCP tools, structured daemon CRUD). When the operator asks for heavy work, the same persona dispatches an orchestration run that boots ptah scoped to its harness — same skills, same subagents, same MCP servers — and ptah does the file-touching agentic loop. The operator should feel the persona; the operator should never feel the plumbing underneath.

## Goals

- Anubis on Discord (and any other persona) can answer questions that require live data — open GitHub issues on a project, file contents, MCP-backed knowledge — using real OpenAI-compatible **tool calls** against `kimi-k2.6:cloud`, gated behind `OPENCLAW_BOT_TOOL_CALLS_ENABLED` (D5).
- Each persona's chat tier loads its **own** skills, subagents, and MCP servers from a `harness.yaml` it owns; chat tier never depends on ptah being installed (A3).
- Skills are loaded **natively** in bot-bridge by reading `skills/<name>/SKILL.md` and injecting them into the persona system prompt, with hot-reload on a `harness/sync` signal (A4, Phase 4.5).
- Subagents are **synchronous sub-chats** spawned from bot-bridge against the same LLM with a curated system prompt and tool subset — not `ptah --profile <name>` (A5, refuted by spike R2).
- MCP servers are managed as **first-class clients** inside bot-bridge using `@modelcontextprotocol/sdk`, with per-persona lifecycle and per-persona tool surfacing (A6, Phase 4.6).
- A persona on Discord can author a project's harness by walking a chat-driven setup conversation (no ptah `setup` subprocess), and the resulting `<project>/.claude/harness.yaml` is committed to the project repo (Phase 3, refuted by spike R1).
- Dispatched orchestration runs use a `daemon/src/harness/ptahLauncher.ts` abstraction that detects the running ptah version and produces the right invocation. Today, on ptah 0.1.3, that means `--config <per-agent-settings.json>` plus a per-persona Claude plugin under `~/.ptah/plugins/openclaw-<id>-harness/` (A7). The launcher is the single seam; nothing else in the dispatch path knows about ptah versions.
- The whole system runs on **community-tier** ptah. No code path calls a Pro-gated wizard RPC (A8, R3).
- Plain-chat fallback is preserved: when the feature flag is off or tool calls fail, `chatComplete` still serves a one-shot reply (D5).

## Non-goals

- **Reimplementing Claude Agent SDK's file-editing/agentic loop in bot-bridge.** Heavy file-touching agentic work stays with ptah, scoped per agent. Chat tier is for fast tool calls and subagent fan-out, not for multi-turn refactor sessions.
- **A full ACP migration to the upstream openclaw gateway.** The gateway tier (`:18789`) is unchanged in this task.
- **Followers auto-cloning project repos on first dispatch.** Leader-only project clones (D4); followers picking up dispatches against projects they don't have on disk is a v2 PR.
- **Daemon-side detection rules / RULES table.** Project intent gathering is operator-authored via the harness-authoring chat (A1); we do not infer harness from package.json patterns server-side.
- **Driving ptah's `setup` command from a subprocess.** Refuted by spike R1 — non-interactive AND Pro-gated. Bot-bridge runs the harness-authoring dialog itself.
- **`ptah --profile <subagent>` as a subagent loader.** Refuted by spike R2 — the allowlist is `claude_code|enhanced` only. Subagents are openclaw-native sub-chats at chat tier; at orchestration tier they ride in via per-persona Claude plugins.
- **A Phase 6 dashboard surface in this task.** Deferred until phases 1–5 ship and we know what telemetry operators actually want.
- **Adding Anthropic Messages API support to `llm.ts`.** Out of scope for this task; the validated foundation is `kimi-k2.6:cloud` via the OpenAI-compatible Ollama endpoint.

## Success criteria (acceptance tests)

Each criterion below is observable from the operator's seat — not "the code compiles" but "I can demo this".

1. **Inline tool-call chat.** With `OPENCLAW_BOT_TOOL_CALLS_ENABLED=1`, Horus on Discord, given a fresh disposable test repo with a few open GitHub issues, can answer "what are the open issues in this repo?" inline within ~30s by emitting and resolving a real tool call, returning the issue titles in the chat reply. With the flag off, the same prompt falls through to `chatComplete` and Horus says it can't actually reach the repo (no false claims of capability).
2. **Per-persona system prompt is composed from its harness.** Horus's chat replies include behavioral cues from the `security-review` skill (loaded because `harness.yaml` lists it). A second persona without that skill, given the same prompt, does not exhibit those cues. Switching skills in `harness.yaml` and triggering a `harness/sync` updates the live persona without restarting the bot process.
3. **Subagent invocation is synchronous and visible.** Horus, asked to "run a quick security review of this PR diff", invokes a `security-review` subagent via tool call. The subagent's reply is returned inline in the same Discord message thread, and the operator can see in the daemon SSE stream which subagent fired.
4. **MCP tool surfaced into chat.** Horus's `harness.yaml` includes one MCP server (e.g., a filesystem or `gh`-flavored MCP). On startup, that server is launched, its tools are surfaced into the persona's tool registry, and the operator can ask Horus to use one of them inline. The MCP process lifecycle is owned by bot-bridge (started on persona load, stopped on persona unload).
5. **Harness-authoring chat writes a real file.** From Discord, the operator asks Horus to "set up the harness for this disposable test repo". Horus walks the operator through a short tool-driven dialog (probe project, propose skills/subagents/MCP, ask for approval), then writes `<project>/.claude/harness.yaml` and runs `ptah harness apply --preset <id>` (community-tier, free). The yaml is committed to the project repo by the operator after review.
6. **Dispatched orchestration uses the per-agent ptah scope.** Operator dispatches a heavy task to Horus on the disposable test repo. The dispatch worker, via `ptahLauncher.spawnPtahForAgent({ agentId: "horus", ... })`, invokes ptah with `--config ~/.ptah/agents/horus/settings.json`. The plugin `~/.ptah/plugins/openclaw-horus-harness/` is on disk with `agents/security-review.md` and a `.claude-plugin/plugin.json`. The settings file's `enabledPluginIds` references that plugin. The orchestration run completes and the result lands as the persona's commit on the test repo.
7. **Community-tier-only.** The full pilot — chat tool calls, harness-authoring chat, dispatched orchestration — runs end-to-end on a host where `ptah --json license status` reports `tier: community`. No Pro-gated RPC (`wizard:deep-analyze`, `wizard:recommend-agents`, `wizard:submit-selection`, `harness:analyze-intent`) is invoked anywhere in the new code paths.
8. **Plain-chat fallback survives.** With `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0` or when the LLM's tool-calling loop fails (timeout, malformed tool call, provider error), Horus still replies in plain text via `chatComplete`. No regression in the existing `<<oc:...>>` directive path during fallback.

## User stories

- **As an operator**, I want to ask Horus on Discord to fetch the open issues from a brand-new test repo and have him return them in the next message, so that I stop catching the bot hallucinating "`gh` isn't authenticated" when it actually is.
- **As an operator**, I want to bootstrap a project's harness from inside Discord by chatting with Horus — he probes the repo, proposes skills/subagents/MCP, gets my approval, and writes `<project>/.claude/harness.yaml` for me to commit — so that project setup never requires running the Pro-gated `ptah setup` wizard.
- **As Horus (persona)**, I want to call my `security-review` subagent inline during a chat to triage a PR diff without dispatching a full orchestration run, so that fast review questions get fast answers.
- **As Horus (persona)**, I want to use a `gh`-flavored MCP server's tools through my normal chat tool registry, so that I don't need a per-tool bespoke wrapper for every external integration.
- **As an operator**, I want to author Horus's `shared-specs/memory/agents/horus/harness.yaml` declaratively (skills, subagents, MCP servers, both chat-tier and orchestration-tier), then run `harness/sync` and have both tiers pick it up, so that personas are version-controlled and reviewable.
- **As an operator**, I want to dispatch a heavy refactor on the test repo to Horus and watch the dispatch worker boot ptah scoped to Horus's settings — same skills as chat-tier, same subagents available — so that the persona feels coherent across the chat/orchestration boundary.
- **As an operator on community-tier ptah**, I want this whole feature to work without ever upgrading to Pro, so that license tier stays an optimization choice rather than a deployment prerequisite.

## Scope

**IN-scope** (covered by phases 1, 3, 4, 4.5, 4.6, 2, 5 from `context.md`):

- Phase 1: Tool-calling chat loop in `bot-bridge` — registry, dispatch loop, daemon-API tools (`start_harness_setup`, `dispatch_orchestration_task`, dashboard CRUD; per A2, no raw `gh_query` / `web_fetch`).
- Phase 3: Harness-authoring chat — bot-bridge runs the dialog natively against `kimi-k2.6:cloud`, writes `<project>/.claude/harness.yaml`, optionally calls free community-tier RPCs (`harness init`, `harness scan`, `harness apply --preset`).
- Phase 4: Openclaw-native subagents — sub-chat against the same LLM with curated system prompt + tool subset; tool `delegate_to_subagent`.
- Phase 4.5: Native skill loading from `skills/<name>/SKILL.md` into the persona system prompt; hot-reload on `harness/sync`.
- Phase 4.6: Native MCP client via `@modelcontextprotocol/sdk`; per-persona MCP server lifecycle; MCP tools merged into the chat tool registry.
- Phase 2: Orchestration-tier `daemon/src/harness/ptahLauncher.ts` — version-detect ptah, branch on 0.1.3 (`--config` + plugin) vs future fixed surface (`--config-dir` + workspace `.claude/agents/` + `--subagent`); `spawnPtahForAgent()` is the single API the dispatch worker uses.
- Phase 5: Persona docs + initial harness authoring for Horus on a brand-new disposable test repo (`persona.md`, `harness.yaml`, the per-persona plugin under `~/.ptah/plugins/openclaw-horus-harness/`, the per-persona `~/.ptah/agents/horus/settings.json`).

**OUT-of-scope**:

- Phase 6 (dashboard surfaces).
- Followers auto-cloning project repos on first dispatch (D4 v2).
- Migrating chat tier to ptah after a future upstream fix — peer model is permanent (per A3).
- Daemon-side detection rule engine (A1).
- Anthropic Messages API support in `llm.ts`.
- Driving `ptah setup` or `ptah harness analyze-intent` (Pro-gated; we reimplement the dialog natively).

## Affected packages and files

### `openclaw-control/bot-bridge/`

- **`src/llm.ts`** — extend with a `chatCompleteWithTools(systemPrompt, messages, tools, opts)` that drives the OpenAI-compatible tool-calling loop (parse `tool_calls`, dispatch to a tool-handler registry, append tool messages, loop until `finish_reason !== 'tool_calls'`). Keep the existing single-shot `chatComplete` as the documented fallback (D5).
- **`src/chat.ts`** — branch on `OPENCLAW_BOT_TOOL_CALLS_ENABLED`. When on, build the tool registry for the persona and call `chatCompleteWithTools`. When off, keep the current `<<oc:...>>` directive flow. Surface tool-call results inline in the Discord reply.
- **`src/tools/` (NEW)** — tool registry split by category: `daemonTools.ts` (project/task CRUD against the daemon HTTP API; `start_harness_setup`, `dispatch_orchestration_task` per A2), `subagentTools.ts` (`delegate_to_subagent`), `mcpTools.ts` (dynamically populated from per-persona MCP servers).
- **`src/skills/` (NEW)** — `skillLoader.ts` reads `skills/<name>/SKILL.md`, parses frontmatter, returns markdown body. `harnessSync.ts` wires it to a `harness/sync` Redis pub/sub topic so a fresh `harness.yaml` triggers in-process reload of system prompts and the MCP server fleet.
- **`src/mcp/` (NEW)** — `mcpManager.ts` owns per-persona MCP server processes via `@modelcontextprotocol/sdk` (StdioClientTransport for command-line servers; lifecycle: start on persona load, stop on persona unload, respawn on `harness/sync` if the server set changed). Surfaces tools into a registry consumed by `tools/`.
- **`src/subagents/` (NEW)** — `subagentRunner.ts` spawns a synchronous sub-chat against `chatComplete[WithTools]` with a subagent-specific system prompt + tool subset, returns the final assistant message; called from `tools/subagentTools.ts`.
- **`src/agentRegistry.ts`** — extend `AgentDef` with `harness: HarnessConfig` (skills list, subagent defs, MCP server specs, both chat-tier and orchestration-tier entries) loaded from `shared-specs/memory/agents/<id>/harness.yaml` via the existing daemon shared-memory HTTP API. Persona privacy invariant unchanged: `persona.md`/`secrets.md` continue to come from local-memory only.
- **`src/index.ts`** — wire the MCP manager and harness-sync Redis subscription into the persona startup/shutdown lifecycle.
- **`src/harnessAuthor.ts` (NEW)** — the Phase 3 chat loop. Driven from a `start_harness_setup` tool call; uses `chatCompleteWithTools` against a small purpose-built tool surface (`probe_project`, `read_file`, `propose_harness`, `confirm_harness`, `write_harness_file`). Final step writes `<project>/.claude/harness.yaml` via `daemonClient.writeProjectFile` and optionally calls `ptah harness apply --preset` via the bridge.
- **`package.json`** — add `@modelcontextprotocol/sdk`, `js-yaml` (for harness parsing), keep `gray-matter` for skill frontmatter.

### `openclaw-control/daemon/`

- **`src/harness/ptahLauncher.ts` (NEW)** — the single seam for orchestration-tier ptah invocation. Detects ptah version at startup (`ptah --version` via the bridge or the in-container binary), exposes `spawnPtahForAgent({ agentId, cwd, prompt, taskId, dispatchId })`. On 0.1.3 (current branch), produces `ptah --json --cwd <cwd> --auto-approve --config <~/.ptah/agents/<id>/settings.json> session start --profile claude_code --task <prompt>`. On the future fixed branch (gated by `PTAH_MIN_VERSION`), produces the `--config-dir` + workspace `.claude/agents/` + `--subagent` shape. The launcher is the only file that knows about ptah version branches.
- **`src/harness/materialize.ts` (NEW)** — given an agent's `harness.yaml`, materializes:
  - `~/.ptah/agents/<id>/settings.json` with `mcpServers`, `enabledPluginIds`, model tier.
  - `~/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json` (per Claude plugin spec).
  - `~/.ptah/plugins/openclaw-<id>-harness/agents/*.md` (subagent defs, frontmatter `name`, `description`, `tools`).
  Idempotent; runs at daemon startup and on `harness/sync`. Materialized files live OUTSIDE the local-memory tree — they are configuration, not persona memory, so the privacy invariant in `daemon/src/memory.ts` is unchanged.
- **`src/invoker.ts`** — replace the inline `args` construction (lines ~107–110) with a call to `ptahLauncher.spawnPtahForAgent(...)`. The fallback in-container spawn path also routes through the launcher.
- **`src/ptahBridge.ts`** — update `BridgeInvokeOptions` to optionally accept a `configFile` field, and pass it through to `scripts/ptah-bridge.mjs`. Existing single-`profile` callers stay backwards-compatible (configFile optional).
- **`src/api.ts`** — new endpoint or sub-route for `POST /api/projects/:slug/files` so the harness-authoring chat can write `<project>/.claude/harness.yaml` server-side. Auth via the existing internal-token path (so only bot-bridge / dispatched agents can call it).
- **`src/bus.ts`** — add a `harness/sync` Redis topic publisher; daemon emits it after materialization completes so bot-bridge in-process reload picks up changes.

### `scripts/`

- **`scripts/ptah-bridge.mjs`** — extend `handleInvoke` to accept and forward an optional `configFile` field in the request body; if set, prepend `--config <configFile>` (host-translated path) to the ptah arg list. Path translation must extend to the `~/.ptah/` tree if container/host home dirs differ — for current bind-mount setup `~/.ptah` is host-side already, so the translation is mostly a passthrough but the regex coverage needs review. Update `/health` to surface `ptahConfigDirExists` for diagnostics.

### `.env.example` and configuration

- **`.env.example`** — add `OPENCLAW_BOT_TOOL_CALLS_ENABLED` (default `0`), `PTAH_MIN_VERSION` (default `0.1.3`), document the per-agent settings paths.
- **`config/`** — no changes to `openclaw.json.tmpl` (gateway-tier untouched).

### Documentation (Phase 5 deliverables)

- **`docs/SKILLS-AND-PERSONA.md`** — explain the chat-tier / orchestration-tier split (peer model, A3); explain how `harness.yaml` declares both tiers; document the materialization output paths.
- **`docs/CONFIGURATION.md`** — document `OPENCLAW_BOT_TOOL_CALLS_ENABLED`, `PTAH_MIN_VERSION`, and the harness file format.
- **`docs/ARCHITECTURE.md`** — add a section on the ptahLauncher seam and the per-persona plugin layout. Note explicitly: only orchestration tier depends on ptah; chat tier is openclaw-native (resilience point of the peer model).
- **`docs/SECURITY.md`** — confirm that materialized settings + plugin files are not persona memory and the privacy invariant is unchanged.
- **`shared-specs/memory/agents/horus/harness.yaml`** — the pilot harness, declaratively listing Horus's skills (e.g., `security-review`, `simplify`), subagents, MCP servers, both chat-tier and orchestration-tier entries.
- **`local-memory/agents/horus/persona.md`** — pilot persona description (private; never traverses HTTP).

## Risks (carried forward from spike)

- **R1 — `ptah setup` is non-interactive AND Pro-gated.** *Status: answered, mitigated.* We do not invoke `setup`. The harness-authoring dialog runs natively in bot-bridge against `kimi-k2.6:cloud`. The only ptah commands we drive are community-tier-safe: `harness init`, `harness scan`, `harness apply --preset`, `session start --task` (already validated).
- **R2 — `ptah --profile <subagent>` does not load workspace subagents.** *Status: answered, mitigated.* `--profile` is hard-allowlisted to `claude_code|enhanced`. Subagents at chat tier are openclaw-native sub-chats; subagents at orchestration tier ride in through per-persona Claude plugins under `~/.ptah/plugins/openclaw-<id>-harness/agents/*.md`, referenced by `enabledPluginIds` in the per-agent settings file.
- **R3 — Pro license gating.** *Status: identified, design constraint.* The host's ptah license is `community`. We must avoid `wizard:deep-analyze`, `wizard:recommend-agents`, `wizard:submit-selection`, `harness:analyze-intent` everywhere. A8 locks this in: Pro is never a deployment prerequisite. Architect must add a CI smoke or startup assertion that none of the new code paths reach a Pro-gated RPC.
- **R4 — `~/.ptah` plugin directory is global, not per-agent.** *Status: identified, mitigated.* `--config <file>` chooses a settings file but the plugin directory is `~/.ptah/plugins/`. We use distinct plugin IDs (`openclaw-<id>-harness`) so multiple personas coexist on the same host without colliding. Materialize is idempotent so re-running for one persona doesn't disturb another's plugin.
- **R5 — host/container path translation for `~/.ptah/agents/<id>/settings.json`.** *Status: new.* `scripts/ptah-bridge.mjs` only translates `BRIDGE_WORKSPACE_*` and `BRIDGE_SPECS_*` prefixes today. Settings/plugin paths must either be confirmed identical between container and host (current bind-mount appears to make `~/.ptah` host-only), or a third translation pair must be added. Architect should test this end-to-end and lock it down with a `/health` field exposing the resolved path.
- **R6 — feature-flag rollback path.** *Status: new.* Operators who turn `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0` mid-flight must keep getting clean replies via `chatComplete`. The implementation must not leave a half-initialized MCP client fleet running when the flag flips, and must not regress the existing `<<oc:...>>` directive flow.

## Dependencies

- **External:**
  - `kimi-k2.6:cloud` via Ollama OpenAI-compat endpoint — already validated for parallel tool calls (smoke test 2026-05-02).
  - `@modelcontextprotocol/sdk` — stable npm package; pin a known version in the architect's plan.
  - `@hive-academy/ptah-cli@0.1.3` — current pinned version. Future fix that adds `--config-dir` / workspace `.claude/agents/` / `--subagent <name>` is the v2 launcher branch.
  - `js-yaml` — for parsing `harness.yaml`.
- **Internal:**
  - TASK_2026_001 is COMPLETE (SQLite-on-leader + HTTP-follower architecture). Nothing else blocks this task.
  - Existing `daemon/src/memory.ts` privacy invariant — must be preserved unchanged. Materialized settings/plugin files live outside the memory tree by design.
  - Existing dispatch worker SSE seam — unchanged; only `invoker.ts`'s ptah invocation moves behind the launcher.

## Open questions for the operator

None — all major decisions are locked in `context.md` (D1–D5, A1–A8) and `spike-findings.md`. The spike answered both R1 and R2 with concrete reproductions; R3 (community-tier-only) is locked by A8. The architect can plan the implementation directly against this description.
