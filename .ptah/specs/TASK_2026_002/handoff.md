# TASK_2026_002 — Session Handoff

**Last session ended:** 2026-05-03 (B8 closed)
**Total Batches:** 9 | **Status:** 8/9 complete

## Batch state

| Batch | Status | Commit | Notes |
|---|---|---|---|
| B1 — tool-calling loop + harness types | COMPLETE | `221d096` | foundation |
| B2 — daemon-CRUD tool registry + chat.ts branching | COMPLETE | `325597b` | 9-tool registry |
| B3 — native skill loading + harness/sync hot-reload | COMPLETE | `f3fc072` | Redis pub/sub |
| B4 — native MCP client (mcpManager) + mcpTools | COMPLETE | `cfe3d66` | backoff + concurrency budget |
| B5 — native subagent runtime + delegate_to_subagent | COMPLETE | `cac67ef` | parent registry plumbed cycle-free |
| B6 — ptahLauncher + materialize + invoker rewire | COMPLETE | `e62a396` | privacy 4th defense layer |
| B7 — harness-authoring chat + project-files | COMPLETE | `1c5de5c` | 5-tool state machine |
| B8 — pilot Horus + integration sweep + community-tier | COMPLETE | `e1df121` (track A) + `87c14d0` (track B) | Sub-tasks 10/11 deferred to B9 |
| **B9 — E2E demo polish + rollback rehearsal** | **PENDING** | — | next batch |

## What B8 produced

**Track A (commit `e1df121`):**
- `local-memory/agents/horus/persona.md` (private; gitignored)
- `shared-specs/memory/agents/horus/{identity.md, harness.yaml}`
- `skills/{security-review, simplify}/SKILL.md` (frontmatter-only stubs)
- 5 doc updates: `CLAUDE.md`, `docs/{ARCHITECTURE,CONFIGURATION,SECURITY,SKILLS-AND-PERSONA}.md`
- `.gitignore` now excludes `local-memory/` (privacy invariant at git layer)

**Track B (commit `87c14d0`):**
- `daemon/src/harness/outboundGuard.ts` — JSON-RPC body inspection; throws on `wizard:*` / `harness:analyze-intent` when `NODE_ENV=test` or `OPENCLAW_REQUIRE_COMMUNITY_TIER=1`. Wired into `ptahBridge.invokeViaBridge` and `leaderClient` outbound calls.
- `daemon/src/harness/licenseGuard.ts:assertCommunityTier()` — boot-time probe via bridge `/health`; refuses to listen if tier ≠ `community`. Wired into `daemon/src/index.ts`.
- `scripts/ptah-bridge.mjs` — `/health` now reports `ptahLicenseTier` via `ptah --json license status`.
- `daemon/test/community-tier-only.test.ts` — guard pass/throw matrix + licenseGuard contract via undici MockAgent.
- `bot-bridge/test/integration/horus-end-to-end.test.ts` — AT#1–#5.
- `daemon/test/horus-spawn.test.ts` — AT#6 (split out because `materializeAgent` pulls in `better-sqlite3`, not a bot-bridge dep).
- `daemon/test/api-harness-materialize-follower.test.ts` — extended with `harness/sync` 405 case (forwarded from B3).

**Test status at end of B8:** daemon 70/70, bot-bridge 85 + 1 pre-existing gated MCP skip. `npx tsc --noEmit` 0 errors in both packages.

## Items deferred from B8 → B9

Both have minimal scope and fit B9's docs surface naturally:

- **B8 sub-task 10** (security audit note): `safeFile` `.yaml` extension scope-narrowing analysis. Document finding in `docs/SECURITY.md`. ~15 min.
- **B8 sub-task 11** (MCP smoke-test runbook entry): `npm i -D @modelcontextprotocol/server-everything` precondition for `OPENCLAW_TEST_REAL_MCP=1 npm test -- --test-name-pattern mcp-everything`. Add to `docs/TROUBLESHOOTING.md` (or `docs/OPERATIONS.md`). ~10 min.

## How to resume — next session

B9 is sequential, ~190 min. Single `backend-developer` per `tasks.md:376`. Sub-tasks at `tasks.md:379–384`:

1. `docs/OPERATIONS.md` — add "Rollback: turn off tool-calling chat" + "Harness-resync runbook" sections.
2. `.ptah/specs/TASK_2026_002/demo-walkthrough.md` — operator-runnable AT#1–#6 demo.
3. (Optional) `scripts/smoke-horus-tool-calls.sh`.
4. `docs/TROUBLESHOOTING.md` — 4 entries (MCP failure, harness/sync miss, materialize stuck, host/container path mismatch).
5. End-to-end demo run on dev host.

Plus the two deferred items above (#10 and #11 from B8).

Commit message stem: `docs: rollback playbook + AT demo walkthrough + troubleshooting (TASK_2026_002 B9)`.

## Invariants to preserve (unchanged from prior handoff)

1. **Persona privacy** — `PRIVATE_AGENT_FILES` route to `local-memory/`, never traverse HTTP. Four enforcement layers; `.gitignore` is now the fifth (B8 track A).
2. **Legacy `<<oc:>>` directive flow** — chat.ts byte-equivalent on flag-off path.
3. **Pro-tier ptah RPCs forbidden** — `outboundGuard.ts` enforces (B8 track B).
4. **Backwards compat** — personas without `harness.yaml` get default `settings.json`.
5. **Hot-reload contract** — Redis `harness/sync` triggers `reloadAgent` (bot-bridge) AND `materializeAgent` (daemon).

## Key files and references (unchanged)

- `tasks.md`, `implementation-plan.md`, `context.md`, `spike-findings.md`, `source-dive.md`
- `CLAUDE.md` (privacy invariant)
- `docs/OPENCLAW_CONTROL.md` (canonical operational landing)
