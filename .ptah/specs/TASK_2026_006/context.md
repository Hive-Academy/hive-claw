# TASK_2026_006 — Architecture migration to openclaw-native multi-agent

**Type:** REFACTOR (architectural pivot with bugfix + audit elements)
**Status:** PLANNED — Track A (stabilization) and Track B (research spike) start in parallel
**Created:** 2026-05-12
**Branch:** `ak/fix-internal-calls` (stay on this branch per user direction; no merge to main yet)
**Recovery anchor:** tag `pre-task-2026-006-cleanup` + stash `refs/stash@{0}`

## User intent (verbatim summary of the conversation that led here)

The user asked how many tools agents have today and how openclaw provides
tools. After auditing the code I described the current state. The user
challenged my framing — I had claimed openclaw is single-agent and that
its plugins are limited to browser/canvas/talk-voice. After a documented
research pass (web search on docs.openclaw.ai/tools, /gateway/config-tools,
/gateway/tools-invoke-http-api, /gateway/openresponses-http-api, /plugins/
sdk-provider-plugins, /tools/multi-agent-sandbox-tools), my prior framing
was confirmed wrong:

- openclaw IS multi-agent (`agents.list[].tools.toolsBySender`)
- openclaw has a rich tool catalog: `exec`, `process`, `code_execution`,
  `read`/`write`/`edit`/`apply_patch`, `web_search`/`web_fetch`/`x_search`,
  `browser`, `message`, `sessions_*`/`subagents`/`agents_list`,
  `cron`/`heartbeat_respond`, `image_generate`/`music_generate`/
  `video_generate`/`tts`, `gateway`/`nodes`, `tool_search`/`tool_describe`
- openclaw has documented HTTP surfaces:
  - `POST /tools/invoke` — direct tool invocation
  - `POST /api/sessions/<id>/messages` — session-driven agent turn
  - `POST /v1/responses` — OpenAI-compatible OpenResponses with SSE
- Bearer-token auth on all of the above
- Per-agent tool policy via allow/deny lists, semantic groups
  (`group:fs`, `group:runtime`), per-provider and per-sender overrides
- Custom tool registration via openclaw plugin SDK (`api.registerTool()`)
- Known bug: `openclaw/openclaw#59047` — external plugin tools register
  in metadata but are not surfaced to the agent. Status at our pinned
  version unknown and must be verified during Track B spike.

## Target architecture

```
LEADER machine                          FOLLOWER machine
─────────────                          ─────────────
openclaw :18789                         openclaw :18789
  agents.list = [anubis, ...]              agents.list = [horus, ...]
  channels.discord.accounts.anubis         channels.discord.accounts.horus
  tools = [exec, files, web, browser,      tools = [same baseline]
    subagents, mcp servers, ...]
       │                                        │
       ▼                                        ▼
bot-bridge sidecar plugin               bot-bridge sidecar plugin
  Custom tools registered with openclaw:    (same shape)
    • invoke_ptah(project, prompt)
    • list_projects, list_tasks, get_task
    • create_task, approve_task, handoff_task
    • start_harness_setup
       │                                        │
       ▼                                        ▼
daemon :7878 (LEADER mode)       ◄─HTTP─    daemon :7878 (FOLLOWER mode)
  /data/specs.db (SQLite)                   HTTP-client to leader
  project registry                          no local DB
  task state                                proxies CRUD to leader
  persona ownership map
  dashboard
```

### Key design decisions (all confirmed by user)

1. **Uniform base tools across personas.** Every persona (anubis, horus,
   future) gets the same baseline. Differentiation is via system prompt
   / persona / identity.md, NOT via removing base tools. The current
   `daemonTools.list()` being unconditional is NOT a bug — it's the
   correct shape.

2. **Bot-bridge becomes a custom openclaw plugin process.** It is no
   longer a Discord chat client. Its only responsibilities are:
   - Register `invoke_ptah(project, prompt)` as an openclaw custom tool
   - Register the 7 daemon CRUD tools (list_projects, list_tasks,
     get_task, create_task, approve_task, handoff_task,
     start_harness_setup) as openclaw custom tools
   - On `invoke_ptah` call: resolve project slug via daemon HTTP, spawn
     ptah-cli scoped to that workspace, stream result back to openclaw
   - On CRUD tool call: proxy to local daemon HTTP API
   The chat loop, LLM dispatcher, MCP client manager, subagent runner,
   skill loader, attachments, and chatState all go away.

3. **openclaw owns the Discord adapter.** Per-persona bot tokens
   migrate from bot-bridge's discord.js connections into openclaw's
   `channels.discord.accounts.<persona>` config. The bot-bridge no
   longer maintains Discord.js connections.

4. **openclaw drives the chat loop directly.** No bot-bridge
   intermediary. Tool execution happens inside openclaw with the
   configured per-agent tool policy (allow/deny lists).

5. **Multi-machine: each machine runs its own openclaw with locally-
   bound personas via `OPENCLAW_LOCAL_AGENT_IDS`.** Daemon's
   leader/follower model is preserved for cross-machine coordination
   (project registry, task state, persona ownership). Openclaw
   instances do NOT talk to each other directly — coordination
   happens at the daemon layer.

6. **`invoke_ptah` is synchronous.** Chat blocks until ptah returns.
   No queued dispatch in v1. The dispatch worker and continuation loop
   are candidates for removal in Phase 2/3 after migration lands.

7. **ptah is reserved for user-initiated requests.** Agents don't
   reach for `invoke_ptah` automatically; they call it when the
   operator says "use ptah for X" or when the task obviously needs
   claude-code (long context, complex multi-file refactor).

8. **Persona privacy:** layers 1-4 (in daemon: resolveBackend, HTTP
   gate, MemoryRepo, assertMaterializedPathSafety) survive. Layers 5-6
   (in bot-bridge tool handlers) go away — substituted by openclaw's
   per-agent sandbox + path-restriction policy. Per-machine filesystem
   isolation (local-memory/ bind mount only on the owning machine)
   gives an additional defense layer for free.

### Why we did NOT pick the "thin Discord forwarder" option earlier

Bot-bridge's original purpose was a secure sandbox for openclaw to
operate on — not a chat client. The chat client behavior was an
enhancement that got out of hand. Reverting bot-bridge to its
original "secure tool host" identity is the right architectural
move. The name "bot-bridge" is misleading and may be renamed during
the migration (suggested: `openclaw-plugin-host` or similar; user to
confirm).

## Cancelled tasks

**TASK_2026_004 (HITL refactor — kill continuation loop):** Cancelled.
The continuation loop is going away as part of this migration. There
is nothing to "kill manually" once the orchestration tier is removed.

**TASK_2026_005 (empty-session detection):** Cancelled. Under
synchronous `invoke_ptah` as a tool call, an empty result is just an
empty tool response. The agent handles it in-loop. Dispatch budget
concept might resurface in Phase 2 as `invoke_ptah` rate limiting,
but as a fresh design, not preserving this work.

Their implementation-plan.md and tasks.md files are retained under
`.ptah/specs/TASK_2026_004/` and `_005/` for historical reference.

## Phase 1 plan — TWO PARALLEL TRACKS

### Track A — Stabilize current code

Goal: ensure the existing system stays operational while migration
work proceeds. Reversible. Does not depend on Track B outcome.

A1. Working-tree cleanup — DONE (pre-task cleanup, stash + WIP commit).
A2. Doc-rot fix at `openclaw-control/bot-bridge/src/tools/daemonTools.ts:99`
    — docstring says "9 tools" but the file ships 7 (TASK_2026_004
    removed `tick_continuation` and `dispatch_orchestration_task`).
    Trivial.
A3. End-to-end smoke test of the CHAT tier on current code. **Deferred
    to end of Phase 1 per user direction** — runs as the Phase 1
    acceptance gate, not part of Track A's first deliverables.

### Track B — Openclaw integration spike (research, then design)

Goal: answer the integration questions left open by the docs, design
the migration architecture in detail.

B1. **Verify openclaw plugin SDK at our pinned version.**
    - Run `openclaw --version` against our installed version
    - Check `node_modules/openclaw/` for the plugin SDK shape
    - Verify whether issue `openclaw/openclaw#59047` (external plugin
      tools not surfaced) is fixed at our version. If not fixed: this
      blocks the bot-bridge-as-plugin approach and we need an
      alternative (e.g., bundled plugin, or wait for upstream fix).
B2. **Verify multi-agent Discord adapter.**
    - Confirm `channels.discord.accounts.<persona>` supports separate
      bot tokens per agent
    - Confirm message routing: how does openclaw decide which agent
      receives a given @-mention?
B3. **Verify sandbox path-restrictions.**
    - Confirm openclaw's per-agent sandbox can deny reads/writes under
      `~/.claude/local-memory/`
    - Document the exact config syntax
B4. **Probe runtime HTTP endpoints.**
    - Hit `:18789/tools/invoke`, `/api/sessions/<id>/messages`,
      `/v1/responses` on the running gateway. Document actual response
      shapes and auth requirements.
B5. **Design the bot-bridge plugin shape.**
    - Custom tool registration boilerplate
    - `invoke_ptah` design (project resolution, ptah subprocess
      lifecycle, error handling, streaming)
    - 7 daemon CRUD tools as openclaw custom tools
    - Plugin manifest (`@openclaw/plugin-sdk` versioning)
B6. **Produce migration architecture doc.** One markdown file under
    `.ptah/specs/TASK_2026_006/migration-architecture.md`. Specific
    TypeScript-level mapping: e.g. "bot-bridge/src/chat.ts:297-302
    becomes openclaw plugin manifest entry X."

### Phase 1 acceptance gate

The end-of-phase smoke test (A3) verifies the system still works on
current code. Phase 2 begins when:
- Track A completed
- Track B's migration architecture doc is approved by the user
- The user authorizes the migration cutover plan

## Open questions for the research spike to resolve

(Listed as B1-B5 above; these were the unresolved items after the
documentation pass.)

## Constraints on execution

- **No CLI agent helpers.** Use only `Task` sub-agents. The user
  explicitly said not to use ptah-cli / gemini / codex / copilot as
  parallel grunt-work helpers during this task.
- **Branch:** stay on `ak/fix-internal-calls`. No merge to main.
- **Communication:** checkpoint/decision questions to the user go as
  numbered plain-text messages, NOT via `AskUserQuestion`. (Project
  memory: `feedback_question_format`.)
- **Token rotation:** don't suggest rotating the Discord bot token
  during this work. (Project memory: `feedback_token_rotation`.)

## Files of interest (current code, pre-migration)

Chat tier (will be removed):
- `openclaw-control/bot-bridge/src/chat.ts` — chat dispatch loop
- `openclaw-control/bot-bridge/src/llm.ts` — LLM provider client
- `openclaw-control/bot-bridge/src/tools/{daemonTools,discordTools,subagentTools,mcpTools,index}.ts`
- `openclaw-control/bot-bridge/src/mcp/mcpManager.ts`
- `openclaw-control/bot-bridge/src/subagents/`
- `openclaw-control/bot-bridge/src/skills/`
- `openclaw-control/bot-bridge/src/harnessAuthor.ts`
- `openclaw-control/bot-bridge/src/chatState.ts` (in stash)
- `openclaw-control/bot-bridge/src/attachments.ts` (in stash)

Survives in plugin form:
- `openclaw-control/bot-bridge/src/daemonClient.ts` — HTTP client to daemon
- `openclaw-control/bot-bridge/src/config.ts` — env config
- `openclaw-control/bot-bridge/src/agentRegistry.ts` — persona loader (will be reduced)

Daemon (mostly survives):
- `openclaw-control/daemon/src/api.ts` — HTTP API (mixed; HITL endpoints
  in stash will be removed during migration)
- `openclaw-control/daemon/src/memory.ts` — persona-privacy routing
  (layers 1-4)
- `openclaw-control/daemon/src/db/{client,tasks,memory,migrations,schema}.ts`
- `openclaw-control/daemon/src/gitSync.ts` — git operations
- `openclaw-control/daemon/src/projects.ts` — project registry
- `openclaw-control/daemon/src/bus.ts` — Redis pub/sub

Daemon (going away in Phase 2/3, currently in stash):
- `openclaw-control/daemon/src/continuation.ts` — continuation loop
- `openclaw-control/daemon/src/dispatch.ts` — dispatch worker
- `openclaw-control/daemon/src/invoker.ts` — ptah invoker
- `openclaw-control/daemon/src/harness/ptahLauncher.ts` — ptah arg builder
- `openclaw-control/daemon/src/db/dispatches.ts` — dispatch state

Infrastructure (survives, may need config updates):
- `Dockerfile`, `entrypoint.sh`, `entrypoint-control.sh`
- `config/openclaw.json.tmpl` — gateway config (will change substantially
  to enable multi-agent + Discord)
- `docker-compose.yml`
- `scripts/ptah-bridge.mjs` — host-side ptah bridge service

Dashboard (survives, some dead UI from TASK_004/005 work to clean up):
- All `openclaw-control/dashboard/` files

## Strategy

Workflow: **Full** (multi-package, architectural, multiple agents needed)

Planned agent sequence:
1. `researcher-expert` — Track B research spike (B1-B5)
2. User checkpoint: review spike findings, decide whether to proceed
3. `software-architect` — produce migration architecture doc (B6) based
   on spike findings
4. User checkpoint: approve migration architecture
5. `project-manager` — turn architecture into concrete task spec
6. `team-leader` (MODE 1) — decompose into batched tasks
7. Developers (`backend-developer` for daemon/bot-bridge, possibly
   `frontend-developer` for dashboard cleanup)
8. `senior-tester` + `code-logic-reviewer` — QA pass before the
   end-of-Phase-1 smoke test

Track A (A2 doc-rot) can be done by a small backend-developer pass
once Track B's spike is underway. A3 (smoke test) runs at the end as
the Phase 1 acceptance gate.
