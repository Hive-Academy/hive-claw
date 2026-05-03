# TASK_2026_002 — Closed

**Closed:** 2026-05-03
**Total Batches:** 9 | **Status:** 9/9 complete

## Final commit ledger

| Batch | Commit | Subject |
|---|---|---|
| B1 | `221d096` | tool-calling loop + harness types + agentRegistry harness wiring |
| B2 | `325597b` | daemon-CRUD tool registry + chat.ts branching |
| B3 | `f3fc072` | native skill loading + harness/sync hot-reload |
| B4 | `cfe3d66` | native MCP client manager + chat tool registry integration |
| B5 | `cac67ef` | openclaw-native subagent runtime + delegate_to_subagent |
| B6 | `e62a396` | ptahLauncher + harness materialize + per-agent ptah scope |
| B7 | `1c5de5c` | harness-authoring chat tools + project-files write |
| B8 track A | `e1df121` | pilot Horus persona + chat-tier docs |
| B8 track B | `87c14d0` | community-tier guard + Horus AT sweep |
| B8 specs   | `3eadc8f` | bookkeeping |
| B9 | `066c265` | rollback playbook + AT demo walkthrough + troubleshooting |

## Final test status

- daemon: 70/70 pass
- bot-bridge: 85 pass + 1 pre-existing gated MCP skip (`mcp-everything: round-trip add(a:1, b:2)` — runs only with `OPENCLAW_TEST_REAL_MCP=1` and `@modelcontextprotocol/server-everything` installed)
- `npx tsc --noEmit`: 0 errors in both packages
- `grep -rnE 'wizard:[a-z-]+|harness:analyze-intent' openclaw-control/{daemon,bot-bridge}/src/`: 6 enforcement-only matches (guard constants, doc comments, system-prompt forbid clauses). Zero invocations.

## Acceptance tests covered

- AT#1 (list_projects tool-call → assistant text contains project names) — `bot-bridge/test/integration/horus-end-to-end.test.ts`
- AT#2 (security-review skill body present in system prompt) — same file
- AT#3 (delegate_to_subagent → invoker SSE events) — same file
- AT#4 (mocked stdio MCP returns a tool result) — same file
- AT#5 (harness-authoring dialog writes `.claude/harness.yaml`) — same file
- AT#6 (`spawnPtahForAgent` produces correct bridge body; `~/.ptah/plugins/openclaw-horus-harness/agents/security-review.md` exists post-materialize) — `daemon/test/horus-spawn.test.ts` (split out for `better-sqlite3` dep boundary)
- AT#7 (no Pro-tier RPCs) — `daemon/test/community-tier-only.test.ts`

## Privacy invariant — five enforcement layers (was four)

1. `daemon/src/memory.ts:resolveBackend()` routes private filenames to `local-memory/`
2. `daemon/src/api.ts` HTTP gate — 403 on PUT/DELETE, 404 on GET (deliberately indistinguishable from "not found")
3. `daemon/src/db/memory.ts:MemoryRepo.{write,delete}` — synchronous throw on private filenames at the DB chokepoint
4. `daemon/src/harness/materialize.ts:assertMaterializedPathSafety` — refuses materialization writes that resolve under `localMemoryRoot`
5. `.gitignore:local-memory/` (added in B8 track A) — closes the git-staging vector

## Dashboard (Phase 6) — explicitly out of scope

`openclaw-control/dashboard/` was not touched. Phase 6 deferred to v2 per the original plan.

## Operator references for the new behavior

- Rollback: `docs/OPERATIONS.md §7` (set `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0`)
- Harness resync: `docs/OPERATIONS.md §8`
- MCP integration smoke: `docs/OPERATIONS.md §9`
- AT demo walkthrough: `.ptah/specs/TASK_2026_002/demo-walkthrough.md`
- Tool-calling-chat troubleshooting: `docs/TROUBLESHOOTING.md` "Tool-calling chat and harness materialization" category
