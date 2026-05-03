# TASK_2026_002 — Session Handoff

**Last session ended:** 2026-05-03
**Total Batches:** 9 | **Status:** 7/9 complete

## Scope clarification — what this task touches

`openclaw-control/` is **not** a single application — it's the umbrella for three sibling Node packages that together form the control-plane tier:

| Path | Role | TASK_2026_002 changes |
|------|------|------------------------|
| `openclaw-control/daemon/` | Fastify HTTP API on `:7878` (leader DB, continuation loop, dispatch worker) | Heavy (B1, B3, B6) |
| `openclaw-control/bot-bridge/` | Multi-agent Discord bridge (LLM tool-calling, MCP, subagents) | Heavy (B1–B5, B7) |
| `openclaw-control/dashboard/` | Angular 19 operator UI | Untouched (Phase 6 deferred to v2) |

The other tier in this repo — the **gateway** at `:18789` (configured by `config/openclaw.json.tmpl` + the upstream `openclaw` npm package) — is also untouched.

## Batch state

| Batch | Status | Commit | Notes |
|---|---|---|---|
| B1 — tool-calling loop + harness types | COMPLETE | `221d096` | foundation |
| B2 — daemon-CRUD tool registry + chat.ts branching | COMPLETE | `325597b` | 9-tool registry; legacy `<<oc:>>` directives untouched |
| B3 — native skill loading + harness/sync hot-reload | COMPLETE | `f3fc072` | Redis pub/sub; `safeFile` regex extended for `.yaml` (security audit forwarded → B8 sub-task #10) |
| B4 — native MCP client (mcpManager) + mcpTools | COMPLETE | `cfe3d66` | backoff `[1000, 2000, 4000, 8000, 16000, 30000]`; concurrency budget=8 |
| B5 — native subagent runtime + delegate_to_subagent | COMPLETE | `cac67ef` | parent registry plumbed via `ctx.state.parentToolRegistry` (cycle-free) |
| B6 — ptahLauncher + materialize + invoker rewire | COMPLETE | `e62a396` | privacy-invariant 4th defense layer (`assertMaterializedPathSafety`); `dispatchedIds: string[]` extension; `/api/sse/emit` allowlist |
| B7 — harness-authoring chat + project-files | COMPLETE | `1c5de5c` | 5-tool state machine; ".." rejection; 30-min idle timeout |
| **B8 — pilot Horus + integration sweep + community-tier** | **IN PROGRESS** | — | track A (writer) work uncommitted in working tree |
| B9 — E2E demo polish + rollback rehearsal | PENDING | — | depends on B8 |

## Working tree at handoff

Tracked modifications (all part of B8 track A — technical-content-writer):
- `CLAUDE.md` (+5/-0) — chat-tier peer-model bullet
- `docs/ARCHITECTURE.md` (+58) — ptahLauncher seam + per-persona plugin layout
- `docs/CONFIGURATION.md` (+14) — new env vars
- `docs/SECURITY.md` (+11/-0) — privacy-invariant 4th defense layer note
- `docs/SKILLS-AND-PERSONA.md` (+78) — chat-tier vs orchestration-tier split
- `.gitignore` (+4) — likely `local-memory/` exclusion
- `.ptah/specs/TASK_2026_002/tasks.md` — sub-task tick updates

Untracked (also B8 track A):
- `local-memory/agents/horus/persona.md` (private; never committed per privacy invariant — but do verify it's gitignored before staging)
- `shared-specs/memory/agents/horus/identity.md`
- `shared-specs/memory/agents/horus/harness.yaml`
- `skills/security-review/` (SKILL.md stub)
- `skills/simplify/` (SKILL.md stub)

Untracked pre-existing (do **NOT** touch — investigate before staging):
- `.github/`
- `.ptah/specs/TASK_2026_001/`
- `docs/.vitepress/`
- `docs/index.md`
- `package.json` (root-level — confirm what this is before assuming)

> **CAUTION** — `local-memory/agents/horus/persona.md` MUST NOT be committed. The privacy invariant routes `persona.md` to `local-memory/` precisely so it is never synced. Check `.gitignore` excludes `local-memory/**` before any `git add`.

## How to resume — next session checklist

1. **Verify the untracked roots are gitignored or pre-existing.** Specifically: confirm `local-memory/` is in `.gitignore` (the working-tree diff suggests this is what the +4 lines added). If not, add it before any staging.
2. **Decide B8 execution mode** before spawning more agents. Two options on the table:
   - **Sequential (architect default):** writer track lands first, then dev track. Safe but ~110 min slower.
   - **Parallel-tracks-then-converge (recommended last session):** spawn `technical-content-writer` (sub-tasks 1, 2, 3, 4, 10, 11) and `backend-developer` track B (sub-tasks 5, 6, 7, 9) concurrently; gate sub-task 8 (`horus-end-to-end.test.ts`) on track A's `harness.yaml` fixture. Saves ~110 min off the critical path. Files are disjoint between the two tracks — only the test files in sub-task 8 cross the boundary.
   The writer track already has uncommitted progress; check whether sub-tasks 1–4 are actually done in the working tree before re-spawning the writer.
3. **Resume B8 by invoking team-leader MODE 2** to inventory what track A has produced, decide whether to commit it as-is or send the writer back for revisions, and then formally assign track B to backend-developer. The orchestration loop says: when a batch is `IN PROGRESS` with uncommitted developer output, MODE 2 verifies + commits before reassigning.
4. **B9 is sequential** — single backend-developer; no parallelism win (5 small docs sub-tasks, ~190 min total).

## Open items forwarded into B8 from earlier batches

These are tracked inside `tasks.md` under B8's sub-task list but called out here for visibility:

| ID | Source | Sub-task # | Action required |
|---|---|---|---|
| Q2 from B3 | safeFile `.yaml` audit | B8 #10 | Document in `docs/SECURITY.md` whether the regex should be scope-narrowed to `harness.yaml` only |
| D3 from B3 | followers-405 test | B8 #9 | Add automated test for the leader-only `if (!config.leader)` guards introduced in B3/B6 |
| D1 from B4 | MCP integration test pkg | B8 #11 | Operator runbook entry: `npm i -D @modelcontextprotocol/server-everything` before `OPENCLAW_TEST_REAL_MCP=1 npm test` |

## Key files and references

- `tasks.md` — batch decomposition, sub-tasks, verification criteria (locked source of truth for execution)
- `implementation-plan.md` — architect's design (locked source of truth for behavior)
- `context.md` — locked decisions A1–A8, foundations validated by spike, phase table
- `spike-findings.md` — R1–R6 closed
- `source-dive.md` — ptah-cli reverse-engineering notes
- `CLAUDE.md` (repo root) — privacy invariant, three-layer enforcement (B6 added the 4th)

## Invariants to preserve

1. **Persona privacy** — `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}` route to `local-memory/` and never traverse HTTP. Enforced at four layers: `resolveBackend()`, HTTP gate (`api.ts`), `MemoryRepo.write/delete`, and (new in B6) `assertMaterializedPathSafety`. Don't smuggle private filenames past any of them.
2. **Legacy `<<oc:>>` directive flow** — chat.ts must keep the `parseDirectives → executeDirective` path byte-equivalent. The new tool-calling branch is additive and feature-flag-gated by `OPENCLAW_BOT_TOOL_CALLS_ENABLED`.
3. **Pro-tier ptah RPCs forbidden** — no `wizard:*` or `harness:analyze-intent` invocations anywhere. B8 sub-task 5 adds the outbound HTTP wrapper guard; sub-task 6 adds the boot-time license-tier check (`OPENCLAW_REQUIRE_COMMUNITY_TIER=1` on the dev host).
4. **Backwards compat** — personas without `harness.yaml` still get a default `settings.json` from materialize so dispatch behavior is byte-equivalent (B6).
5. **Hot-reload contract** — Redis `harness/sync` topic with `{ agentId }` payload triggers `reloadAgent(id)` in bot-bridge AND `materializeAgent(id)` in daemon. Both must stay subscribed.
