# TASK_2026_002 — context

## User intent

Build per-agent **harness composition** (skills + subagents + MCP servers) for the multi-agent
bot-bridge personas (Anubis, Horus, …) and expose it through tool-calling Discord chat. The
harness is composed at three tiers:

1. **Agent harness** — what a persona always brings (versioned in `shared-specs/memory/agents/<id>/harness.yaml`).
2. **Project harness** — what a project needs, **authored interactively by ptah's `setup` command**, never by daemon-side detection rules. Lives in `<project>/.claude/harness.yaml` (committed to project repo).
3. **Effective harness** — per `(agent, project)` ptah session: `union(skills) ∪ union(subagents) ∪ union(mcp_servers, key=id)` materialized at `~/.ptah/agents/<id>/projects/<slug>/`.

Anubis-on-Discord becomes a properly composed agent: chat reasoning + structured tools + the
ability to dispatch heavy work to ptah orchestration. Each persona can synchronously invoke its
own subagents for fast review tasks, and asynchronously dispatch full continuation-loop runs for
multi-day work.

## Workflow classification

| Field | Value |
|---|---|
| Task type | FEATURE |
| Workflow depth | Full |
| Strategy | PM → spike (researcher-expert) → software-architect → team-leader (MODE 1/2/3) → backend-developer cycles → code-logic-reviewer + senior-tester → MODE 3 |
| CLI delegation mode | **auto** — team-leader recommends executor + execution-mode per batch in `tasks.md`; orchestrator (Claude) is sole spawner |
| Spike timing | **sequential** — runs before PM, output feeds the plan |
| Commit cadence | **per artifact** — each major deliverable is its own commit |

## Locked architectural decisions (do NOT re-derive)

These were arrived at via extensive operator dialogue prior to task creation. They are inputs to PM and architect, not open questions.

| ID | Decision | Locked answer |
|---|---|---|
| **D1** | Setup-session subprocess owner | **bot-bridge** (Discord-adjacent; daemon path is v2) |
| **D2** | Pilot persona | **Horus** (narrow security focus; smaller surface = cleaner success/failure signal) |
| **D3** | Pilot project | **Brand-new disposable test repo** (pro-estate is the second project, after pattern is proven) |
| **D4** | Multi-machine in v1 | **Leader-only project clones**; followers auto-clone is a follow-up PR |
| **D5** | Plain-chat fallback | **Keep `chatComplete` as fallback**; tool calls behind `OPENCLAW_BOT_TOOL_CALLS_ENABLED` feature flag |
| **A1** | Detection engine on the daemon side | **Removed** — no `RULES = [...]` table; ptah's interactive setup harness owns project intent gathering |
| **A2** | Tool surface for chat | **Subagent calls + dashboard CRUD + `start_harness_setup` + `dispatch_orchestration_task`** — no raw `gh_query` / `web_fetch` (those live inside subagents and MCP servers, where the security boundary is structured) |

## Validated foundations (no work needed)

| Fact | Evidence |
|---|---|
| `kimi-k2.6:cloud` via Ollama OpenAI-compat endpoint supports parallel tool-calls cleanly | smoke test 2026-05-02 returned `finish_reason: "tool_calls"` with two structured calls and a `reasoning` field |
| `@hive-academy/ptah-cli@0.1.3` headless `session start --task` actually drives a turn end-to-end | verified 2026-05-02 through `scripts/ptah-bridge.mjs`; bridge `/health` reports 0.1.3 |
| Container `gh` is authenticated as `Abdallah-khalil` (PAT + host-bind-mounted hosts.yml) | `gh auth status` inside container, 2026-05-02 |
| `bot-bridge` chat path bypasses ptah by design (LLM_PROVIDER → Ollama directly) | `openclaw-control/bot-bridge/src/llm.ts:7-9` |
| Persona privacy invariant enforced at three layers | `daemon/src/memory.ts` `resolveBackend()`, `daemon/src/api.ts` HTTP gate, `daemon/src/db/memory.ts` `MemoryRepo.write/delete` |

## Phases (revised after spike + scope-shift to peer-model 2026-05-02)

The peer model: openclaw-control owns the **chat tier** (LLM tool-calling, native subagents,
native skill loading, native MCP client) so Discord chat is resilient to ptah's state.
ptah owns the **orchestration tier** (multi-turn agentic loops with file edits, continuation-
phase runs, exec approvals, trajectory tracking) — that's its real value-add. Both paths ship.

| # | Phase | Specialist | Tier | Depends on ptah? |
|---|---|---|---|---|
| 1 | Tool-calling chat loop in bot-bridge (registry, dispatch loop, daemon-API tools) | backend-developer | chat | No |
| 3 | Harness-authoring chat (bot-bridge runs the dialog natively against kimi-k2.6; writes `<project>/.claude/harness.yaml`) | backend-developer | chat | No |
| 4 | **openclaw-native subagents** (sub-chat against same LLM with curated system-prompt + tool subset; NOT `ptah --profile`) | backend-developer | chat | No |
| 4.5 | **Native skill loading** — read `skills/<name>/SKILL.md` referenced by `harness.yaml`, inject into persona system prompt; hot-reload on `harness/sync` | backend-developer | chat | No |
| 4.6 | **Native MCP client** — add `@modelcontextprotocol/sdk` to bot-bridge, per-persona MCP server lifecycle, MCP tools surfaced into the chat tool registry | backend-developer | chat | No |
| 2 | **Orchestration-tier per-agent ptah scoping** — `ptahLauncher.ts` abstraction, branches on detected ptah version: 0.1.3 surface uses `--config <settings.json>` + per-persona Claude plugin under `~/.ptah/plugins/openclaw-<id>-harness/`; future fixed surface (`--config-dir`, workspace `.claude/agents/`, `--subagent` flag) is the v2 branch. Used ONLY by dispatch worker for heavy agentic runs. | backend-developer | orchestration | Yes (current 0.1.3 + future fixed) |
| 5 | Persona docs + initial harness authoring — `persona.md` describes the two-tier model; `harness.yaml` declares both chat-tier (skills/subagents/MCP openclaw loads natively) and orchestration-tier (skills ptah loads when dispatched). Pilot: Horus on a brand-new test repo. | technical-content-writer + operator | both | — |
| 6 | Dashboard surfaces | frontend-developer | both | — |

**Deferred to v2:**
- Followers auto-clone projects on first dispatch (multi-machine project work; D4)
- Phase 6 dashboard surfaces (until phases 1-5 ship and we have telemetry on what operators need to see)

**Dropped from plan entirely:**
- Daemon-side detection rule engine (`A1` — ptah's `harness scan`/operator authoring covers it)
- Spawning `ptah setup` as a subprocess and bridging to Discord (refuted by spike R1 — non-interactive AND Pro-gated; harness-authoring runs natively in bot-bridge instead)
- "Migrate chat-tier to ptah after upstream fixes" — chat-tier stays native permanently; that's the resilience point of the peer model
- `--profile <subagent>` as the subagent loader (refuted by spike R2 — hard-allowlisted to `claude_code|enhanced`)

## Locked decisions appended after spike + peer-model shift (2026-05-02)

| ID | Decision | Locked answer |
|---|---|---|
| **A3** | openclaw-control's relationship to ptah | **Scoped peer runtime.** Chat tier is openclaw-native (no ptah dependency). Orchestration tier delegates to ptah (heavy file-touching agentic loops). Each tier uses the right tool. |
| **A4** | Skill loading at chat tier | **openclaw reads markdown files directly** from `skills/<name>/SKILL.md`, injects body into persona system prompt. No ptah skill runtime involved at chat tier. |
| **A5** | Subagent runtime at chat tier | **openclaw spawns sub-chats against the same LLM** with subagent-specific system prompt + tool subset. No `ptah --profile` smuggling. |
| **A6** | MCP client at chat tier | **openclaw is a first-class MCP client** via `@modelcontextprotocol/sdk`. Per-persona MCP server lifecycle managed in bot-bridge. MCP tools surfaced into the same tool registry as native tools. |
| **A7** | ptah surface targeted by orchestration tier | **Both 0.1.3 (current) and the future fixed surface.** A `daemon/src/harness/ptahLauncher.ts` abstraction detects the running ptah version at startup and branches: 0.1.3 uses `--config <file>` + plugin dance; fixed surface uses `--config-dir <dir>` + workspace-local `.claude/agents/` + `--subagent <name>`. Phases 3/4/5 consume `spawnPtahForAgent()` and don't care which branch is active. Migration to v2 = swap the launcher's branch + bump `PTAH_MIN_VERSION`, no other code changes. |
| **A8** | Pro-gated ptah RPCs | **Avoided entirely.** No part of our design calls `wizard:deep-analyze`, `harness:analyze-intent`, or any wizard backend. Community-tier ptah is sufficient forever. Pro is never a deployment prerequisite. |

## Open risks the spike must resolve before architect plans Phase 3-4

| ID | Risk | Spike action |
|---|---|---|
| R1 | ptah 0.1.3's actual `setup` CLI surface — does it emit interactive JSON-RPC dialog with discrete completion event, or do we need to drive setup as a custom prompt over `ptah interact`? | Read `~/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/main.mjs`; trace command registration; run `ptah setup --help` and a real interactive session to capture the event taxonomy |
| R2 | `--profile <subagent>` semantics — does ptah load harness subagents from per-agent config dir, or do we need a different hook (system-prompt injection, custom session profile)? | Same source dive; experimentally invoke ptah with a planted subagent definition under `~/.ptah/agents/<id>/subagents/` and confirm it loads |

Spike output: short markdown note in this folder (`spike-findings.md`), plus updates to risks register if the answers differ from assumptions.

## Available CLI agents (for delegation in `auto` mode)

| Agent | Status |
|---|---|
| gemini | installed |
| codex | installed |
| copilot | installed |
| cursor | not installed |

Priority for selection: `ptah-cli > gemini > codex > copilot` (per orchestration skill defaults).
