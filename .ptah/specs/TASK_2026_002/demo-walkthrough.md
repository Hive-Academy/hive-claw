# TASK_2026_002 — operator demo walkthrough

A sequenced, copy-pasteable run-through of acceptance tests AT#1 → AT#6 against a disposable test repo. The 7 ATs from `task-description.md` lines 38–44 boil down to "an operator on community-tier ptah can drive Horus end-to-end on a fresh repo without any Pro RPC firing". This doc walks through that exact path.

> [!NOTE]
> Source of truth for each AT's setup and observable signal is the integration test, not this doc. AT#1–#5 live in `openclaw-control/bot-bridge/test/integration/horus-end-to-end.test.ts`; AT#6 lives in `openclaw-control/daemon/test/horus-spawn.test.ts`. When this doc and a test disagree, the test wins — open a PR against this file.

## Prerequisites

- A running openclaw-control deployment with the leader on `localhost:7878`. If you're on a follower host, swap `http://localhost:7878` for `$OPENCLAW_LEADER_URL` everywhere below and run the curl commands from a host that can reach the leader.
- `OPENCLAW_INTERNAL_TOKEN` exported in your shell, matching the value baked into the leader's container env.
- `OPENCLAW_BOT_TOOL_CALLS_ENABLED=1` in `.env` and the container restarted since that flip. Verify:

  ```bash
  docker compose exec openclaw printenv OPENCLAW_BOT_TOOL_CALLS_ENABLED
  ```

- Horus is registered: `local-memory/agents/horus/persona.md` exists on this host AND `<this host>` is in `OPENCLAW_LOCAL_AGENT_IDS=...,horus,...`.
- A disposable test repo on GitHub (e.g. `your-username/openclaw-disposable-test`) with 3 open issues. The exact number doesn't matter — the ATs check that ALL of them appear in the reply.
- `gh` CLI authenticated on the host where the ptah-bridge runs (for AT#4's `gh` MCP server).

## Open the SSE stream first

Every AT below has an SSE-side observable signal. Open one terminal that stays put for the whole walkthrough:

```bash
curl -N -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/stream?topics=invoker,harness,mcp" | jq
```

The topic names (`invoker`, `harness`, `mcp`, `dispatch`, `task`, `checkpoint`, `continuation`, `memory`, `agent`, `session`) are the literal first segments of the event names in the daemon's SSE registry — see `daemon/src/api.ts` (the `SSE_EMIT_ALLOWED_EVENTS` set lists `invoker.tool_call`, `invoker.subagent_started`, `invoker.subagent_finished`, `mcp.server_failed`, `harness.materialized`, `harness.synced`) and `daemon/src/sse.ts` for the topic-prefix filter logic.

If any AT below fails, the rollback is one env flag — see [OPERATIONS.md §7](../../docs/OPERATIONS.md#7-rollback-turn-off-tool-calling-chat). After fixing the root cause, restart and re-run from the failing AT.

---

## AT#1 — Inline tool-call chat

**What it proves:** with the flag on, Horus can answer a project-state question by emitting a tool call to `list_projects` (or a similar daemon-CRUD tool), the bot-bridge dispatches the tool, appends the result, loops once more, and returns final text. Without the flag, the same prompt falls through to plain `chatComplete`.

**Setup:**

```bash
# Make sure the disposable test repo is registered as a project on the leader.
curl -fsS -X POST \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"openclaw-disposable-test","name":"Disposable test","workspace":"/home/anubis/projects/openclaw-disposable-test"}' \
  "http://localhost:7878/api/projects"
```

**Drive:** in Discord, in a channel where Horus is listening:

```
@Horus what projects do I have registered?
```

**Expected Discord behavior:** within ~30s, Horus replies with a message that lists `openclaw-disposable-test` (and any other projects in the leader's DB). The reply is plain prose — the tool-call round-trip is invisible to the chat user.

**Expected SSE observation:** the SSE stream from "Open the SSE stream first" emits one or more `invoker.tool_call` events with `name: "list_projects"` (or whichever daemon-CRUD tool matched the prompt) and `ok: true`. The integration test asserts this exact event shape — see `bot-bridge/test/tool-call-fallback.test.ts` for the event payload contract.

**Negative control:** flip `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0`, restart, ask the same question. Horus should reply in plain text and explicitly disclaim ability to look things up; no `invoker.tool_call` event fires. Flip the flag back to `1` and restart before continuing.

---

## AT#2 — Per-persona harness composes the system prompt

**What it proves:** `harness.yaml` is the single source of truth for an agent's chat-tier behavior. Adding a skill via the YAML and triggering `harness/sync` updates the live persona without restarting the bot process.

**Setup:** confirm Horus's harness lists `security-review` as a chat-tier skill:

```bash
curl -fsS \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/memories/agents/horus/harness.yaml"
# Look for `chatTier.skills: [security-review, simplify]` in the YAML body.
```

**Drive:** ask Horus a question whose answer the `security-review` skill changes — e.g.:

```
@Horus what's your approach to reviewing a PR for security issues?
```

The reply should mention OWASP-style triage cues that come from `skills/security-review/SKILL.md`. Save the reply text — this is the baseline.

**Test the hot-reload:** add a new skill to the YAML (e.g. duplicate `simplify` to a new name, or scaffold a stub `skills/<new-name>/SKILL.md`), PUT the modified YAML back, and trigger sync per [OPERATIONS.md §8](../../docs/OPERATIONS.md#8-harness-resync-runbook):

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/agents/horus/harness/sync"
```

**Expected SSE observation:** the SSE stream emits `harness.synced` (always) and, on the leader, `harness.materialized` with `changed: true` because the YAML actually altered the materialized tree.

**Expected Discord behavior:** ask the same security-review question again — the reply should now reflect the new skill's content. The integration test asserts the `harnessVersion` field on the cached `AgentDef` ticks forward and `buildSystemPrompt` includes the new skill's body.

**Cleanup:** revert the harness back to the canonical `[security-review, simplify]` set and re-sync, OR leave the experiment in place if the new skill is something you actually want.

---

## AT#3 — Subagent invocation is synchronous and visible

**What it proves:** Horus's `delegate_to_subagent` tool fires a sub-chat against the same LLM with a curated system prompt + tool subset, returns the subagent's final reply inline, and emits matched `invoker.subagent_started` / `invoker.subagent_finished` SSE events.

**Setup:** confirm Horus's harness lists `pr-diff-triage` as a chat-tier subagent (it does, per the canonical fixture committed in B8). No additional setup needed.

**Drive:** ask Horus to triage a PR diff. Pick any open PR on the disposable test repo:

```
@Horus run a quick security review of PR #1 in openclaw-disposable-test
```

**Expected Discord behavior:** Horus replies with a message that includes the subagent's triage summary — verbatim or paraphrased. The reply lands in the same Discord thread; there is no separate "subagent message". This is the test's `replyLength > 0` assertion at `horus-end-to-end.test.ts:467`.

**Expected SSE observation:** exactly one `invoker.subagent_started` event (with `name: "pr-diff-triage"`, `parentAgentId: "horus"`, `depth: 1`) and exactly one `invoker.subagent_finished` event (with the same `name` and a non-zero `replyLength`). The test asserts `startedEvents.length === 1` and `finishedEvents.length === 1` at lines 457–458.

> [!NOTE]
> `depth: 1` is the contract — first-level subagent invocation. If you see `depth: 2` or higher, the subagent was itself invoked by another subagent (recursion). The depth limit is `OPENCLAW_SUBAGENT_DEPTH_LIMIT` (default 2); above that, `delegate_to_subagent` returns an error to the caller.

---

## AT#4 — MCP tool surfaced into chat

**What it proves:** Horus's harness lists an MCP server (`gh`); on agent load, the bot-bridge spawns it via `@modelcontextprotocol/sdk`'s `StdioClientTransport`; its tools are surfaced into the persona's tool registry as `mcp__gh__*`; and Horus can call one inline.

**Setup:**

- The `gh` MCP server binary must be installed and on PATH inside the container. If you're following a community deployment, this is `npx -y @github/mcp-server-github` or similar.
- `GH_TOKEN` (or the appropriate auth env var for the chosen `gh` MCP package) must be set in the container's env.

**Drive:** ask Horus to fetch a real PR diff:

```
@Horus pull the diff for PR #1 in openclaw-disposable-test and tell me what changed
```

**Expected Discord behavior:** Horus replies with a summary of the diff. The summary is generated by Horus from the MCP tool's text output — the verbatim diff is not pasted into Discord (would be too long).

**Expected SSE observation:** at least one `invoker.tool_call` event with `name: "mcp__gh__get_pull_request_diff"` (or the equivalent tool name from your chosen `gh` MCP package — the exact name varies). `ok: true` and `durationMs` reasonable (< 5000 typically).

**Failure mode to watch for:** if `mcp.server_failed` fires on the SSE stream during this AT, the MCP server crashed during startup or during the call. See [TROUBLESHOOTING.md — MCP server failed and tools missing from chat](../../docs/TROUBLESHOOTING.md#symptom-mcp-server-failed-and-tools-missing-from-chat).

> [!NOTE]
> The integration test for AT#4 uses a mocked stdio MCP server (see `horus-end-to-end.test.ts:483–509`) because spinning up a real one in the test would require an outbound network call. The real-MCP smoke test is gated behind `OPENCLAW_TEST_REAL_MCP=1` — see [OPERATIONS.md §9](../../docs/OPERATIONS.md#9-mcp-integration-smoke-test).

---

## AT#5 — Harness-authoring chat writes a real file

**What it proves:** the operator can bootstrap a project's `harness.yaml` from inside Discord. Horus walks through a tool-driven dialog (probe project, propose, confirm, write) and the final tool call writes `<project>/.claude/harness.yaml` via the daemon's project-files API.

**Setup:** the disposable test repo must be a registered project on the leader (done in AT#1's setup) AND it must NOT already have a `.claude/harness.yaml` (otherwise the dialog converges to "you already have one, want me to update it?" — a different code path).

**Drive:**

```
@Horus set up the harness for openclaw-disposable-test
```

**Expected Discord behavior:** Horus walks the operator through ~3–5 messages:

1. "Probing the repo…" — emits a `probe_project` tool call.
2. "Here's what I propose…" — lists skills, subagents, MCP servers; asks for approval.
3. (Operator: "yes" or "looks good")
4. "Wrote `.claude/harness.yaml`. Commit it when you're ready." — emits the `write_harness_file` tool call.

**Expected SSE observation:** several `invoker.tool_call` events for the harness-authoring tool surface (`probe_project`, `read_file`, `propose_harness`, `confirm_harness`, `write_harness_file`). The full tool registry for the authoring path is in `bot-bridge/src/harnessAuthor.ts`.

**Verify the artifact:**

```bash
ls -la /home/anubis/projects/openclaw-disposable-test/.claude/harness.yaml
cat /home/anubis/projects/openclaw-disposable-test/.claude/harness.yaml | head -20
```

The YAML must round-trip through `parseHarnessYaml` (the bot-bridge does this implicitly on the next `harness/sync` if you decide to register the test repo as an agent).

> [!NOTE]
> AT#5's "optionally calls `ptah harness apply --preset <id>`" step from `task-description.md:42` is community-tier-free per the spec, but the canonical implementation only writes the YAML; the operator runs `ptah harness apply` manually if they want. The test fixture asserts the YAML write only — `harnessAuthor.test.ts` does not invoke ptah.

---

## AT#6 — Dispatched orchestration uses the per-agent ptah scope

**What it proves:** when a task is dispatched to Horus, `ptahLauncher.spawnPtahForAgent` produces a bridge invocation with `configFile` pointing at `~/.ptah/agents/horus/settings.json`, and the materialized plugin tree at `~/.ptah/plugins/openclaw-horus-harness/` is on disk.

**Setup:**

- Horus's harness must already be materialized. If you ran AT#2's resync, the materialization happened then. Otherwise, force it:

  ```bash
  curl -fsS -X POST \
    -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
    "http://localhost:7878/api/agents/horus/harness/materialize"
  ```

  Confirm the on-disk artifacts (host paths, NOT container paths — the bind-mount is identity-mapped):

  ```bash
  ls -la "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/agents/horus/"
  # Expect: settings.json
  ls -la "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/plugins/openclaw-horus-harness/"
  # Expect: .claude-plugin/  agents/
  ls -la "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/plugins/openclaw-horus-harness/agents/"
  # Expect: security-review.md (or whichever subagents are in the orchestration tier)
  ```

- A task on the leader, addressed to Horus and ready to dispatch. The simplest path is to hand-craft one:

  ```bash
  curl -fsS -X POST \
    -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"projectSlug":"openclaw-disposable-test","title":"Demo dispatch for AT#6","agentId":"horus"}' \
    "http://localhost:7878/api/tasks"
  ```

  The continuation loop will pick it up on its next tick and insert a `dispatches` row.

**Drive:** wait for the dispatch to fire (max ~`OPENCLAW_TICK_MS`, default 30s) or trigger a tick manually:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/continuation/tick"
```

**Expected SSE observation:** a `dispatch.pending` then `dispatch.taken` then `invoker.started` / `invoker.stdout` / `invoker.finished` sequence. (Open a second SSE stream with `?topics=dispatch,invoker` if your first stream filtered them out.)

**Verify the bridge call shape:** tail the host-side ptah-bridge log:

```bash
journalctl --user -u ptah-bridge.service -n 200 | grep -E '/invoke|--config|configFile'
# Expect a line containing: --config /home/anubis/.ptah/agents/horus/settings.json
```

**Verify the dispatch completed:**

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, agent_id, state, exit_code FROM dispatches ORDER BY created_at DESC LIMIT 5;"
```

The most recent row for `horus` should be `state='done', exit_code=0`. If `state='failed'`, read `dispatch_log` for that id (see [OPERATIONS.md §1](../../docs/OPERATIONS.md#1-daily-ops--five-sqlite3-one-liners) "Tail the logs for one dispatch").

> [!NOTE]
> The integration test for AT#6 (`daemon/test/horus-spawn.test.ts`) mocks the bridge with undici and asserts the request body contains `configFile: ".../horus/settings.json"`. It does not actually spawn ptah. The end-to-end spawn-against-real-ptah verification is this walkthrough's job.

---

## AT#7 — Community-tier-only

**What it proves:** the full AT#1–#6 sweep above ran on a host where `ptah --json license status` reports `tier: community`, and no Pro-gated RPC fired anywhere.

**Verify the host's tier:**

```bash
ptah --json license status | jq '.params'
# Expect: {"tier": "community", ...}
```

**Verify no Pro RPC was attempted:** the daemon's `outboundGuard.ts` (B8 track B) inspects every JSON-RPC body sent through the bridge or the leader-client and throws on any `wizard:*` or `harness:analyze-intent` method. If any AT above fired one, the bridge call would have failed loudly and the corresponding `invoker.finished` would carry `ok: false` plus a guard-tripped error message in `dispatch_log`. Grep for it as a final sanity:

```bash
docker compose exec openclaw grep -E 'outboundGuard|community-tier|wizard:|harness:analyze-intent' \
  /tmp/openclaw-control-daemon.log | tail -20
# Expect: empty (or only the harmless boot-time license-probe line).
```

**Boot-time gate (paranoid mode):** if you want the daemon to refuse to start on a non-community host:

```bash
echo 'OPENCLAW_REQUIRE_COMMUNITY_TIER=1' >> .env
docker compose restart openclaw
```

The daemon's `assertCommunityTier()` runs before `app.listen()`. If the bridge's `/health` reports `ptahLicenseTier !== 'community'`, the process exits with an error. Default off — operator opts in.

---

## AT#8 — Plain-chat fallback

**What it proves:** the rollback path works. With the flag off OR when the tool-call loop fails (timeout, malformed tool call, provider error), Horus still replies via `chatComplete`.

**Drive:** flip the flag and re-run AT#1's question:

```bash
sed -i 's|^OPENCLAW_BOT_TOOL_CALLS_ENABLED=.*|OPENCLAW_BOT_TOOL_CALLS_ENABLED=0|' .env
docker compose restart openclaw
# Then in Discord:
#   @Horus what projects do I have registered?
```

**Expected Discord behavior:** Horus replies in plain text. The reply does NOT claim to know the answer — Horus correctly disclaims ability to query the daemon when the tool path is off. No `invoker.tool_call` events on the SSE stream.

**Restore:** flip the flag back, restart.

---

## Wrap-up checklist

- [ ] AT#1 reply contained the project list
- [ ] AT#2 reply changed after `harness/sync`; `harness.materialized` fired
- [ ] AT#3 SSE showed exactly 1× `invoker.subagent_started` + 1× `invoker.subagent_finished`
- [ ] AT#4 reply summarized a real GitHub PR diff; `mcp__gh__*` tool call fired
- [ ] AT#5 produced `<project>/.claude/harness.yaml` on disk and it parses
- [ ] AT#6 dispatch landed `state='done', exit_code=0`; bridge log shows `--config .../horus/settings.json`
- [ ] AT#7 `ptah --json license status` reports `community`; no `outboundGuard` log lines
- [ ] AT#8 flag-off path replied in plain text; no tool-call events

If any box is unchecked, see [OPERATIONS.md §7 (rollback)](../../docs/OPERATIONS.md#7-rollback-turn-off-tool-calling-chat) before continuing — get back to a known-good state, then re-run the failing AT.
