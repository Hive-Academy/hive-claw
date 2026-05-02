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

## Phases (high-level — detail in `implementation-plan.md` once architect produces it)

1. Tool-calling chat loop in bot-bridge (`backend-developer`)
2. Per-agent ptah config dir + dispatch wiring (`backend-developer`)
3. Setup-session subsystem with Discord-thread bridging (`backend-developer` + `senior-tester`)
4. Subagent tools / synchronous chat path (`backend-developer`)
5. Persona docs + initial harness authoring (`technical-content-writer` + operator)
6. Dashboard surfaces — **deferred to v2**

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
