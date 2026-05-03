# Operations playbook

The day-2 doc for operators of an `openclaw-control` deployment. Every recipe assumes the leader is up and you can `docker compose exec openclaw …` on it. All SQL is verified against `openclaw-control/daemon/src/db/schema.ts` — column names match the live tables.

For architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For setup, see [SETUP.md](SETUP.md). For the bigger conceptual picture, [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md).

---

## 1. Daily ops — five `sqlite3` one-liners

Five recipes covering the 95% case. Run them on the leader.

### "What's stuck?" — list every open dispatch

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, agent_id, project_slug, task_id, phase, created_at
     FROM dispatches
    WHERE state IN ('pending','taken')
    ORDER BY created_at;"
```

`pending` rows haven't been claimed yet. `taken` rows are in flight on whichever host owns the agent. If a `taken` row is older than `OPENCLAW_TICK_MS × 2 +` reasonable invocation time, see "Stuck dispatch" in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

### "Show me poison" — list every dispatch the runaway-loop guard refused to retry

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, project_slug, task_id, phase, failure_count
     FROM dispatches
    WHERE state='poisoned';"
```

A `poisoned` row is the K-th consecutive failure for the same `(project, task, phase)` — K is `OPENCLAW_DISPATCH_FAILURE_THRESHOLD` (default 3). The continuation loop refuses to issue a new pending while a poisoned row is open.

### "Tail the logs for one dispatch" — full audit trail

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT ts, level, message
     FROM dispatch_log
    WHERE dispatch_id='<id>'
    ORDER BY ts;"
```

`dispatch_log` rows are written by the daemon at every state transition (`done exit=0 …`, `failed exit=N count=M`, `poisoned after K consecutive failures`, etc.). They cascade-delete with the parent dispatch row.

### "Retry a poisoned task"

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "DELETE FROM dispatches
    WHERE state='poisoned'
      AND project_slug='<slug>'
      AND task_id='<TASK_YYYY_NNN>';"
```

(Continuation tick will issue a fresh pending on its next pass — the partial UNIQUE index `dispatches_unique_open` no longer blocks the insert because the open poisoned row is gone.)

### "Force-fail a stuck taken"

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "UPDATE dispatches
      SET state='failed',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id='<id>';"
```

Use this when a dispatch is in `taken` for an unreasonable duration and you've decided the worker is gone (host crashed, network partition you can't fix). It does not increment `failure_count` against the K-recent-window — it just unblocks the index so the next continuation tick can issue a fresh attempt.

---

## 2. Backups

There is no built-in audit-log to GitHub, no `litestream`, no scheduled snapshot job. Backups are an explicit operator action.

### Hot copy — daemon stays up

`sqlite3`'s `.backup` command takes a consistent snapshot under WAL without blocking writers:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  ".backup '/data/specs.db.snapshot-$(date +%F).db'"
```

The snapshot file lives next to the live DB inside the named volume. To pull it to the host:

```bash
docker compose cp openclaw:/data/specs.db.snapshot-$(date +%F).db ./backup/
```

Take one before any destructive operation (poison cleanup, cutover, schema bump). Disk is cheap.

### Cold copy — daemon stopped (more paranoid)

If you'd rather guarantee no in-flight writer:

```bash
docker compose stop openclaw
HOST_DIR=$(docker volume inspect openclaw_specs-db -f '{{.Mountpoint}}')
sudo cp "$HOST_DIR/specs.db" "$HOME/backup/specs.db.$(date +%F)"
docker compose start openclaw
```

Cold copies also capture the WAL and `-shm` files. For most ops, a hot copy is sufficient.

### Restore from a snapshot

```bash
docker compose stop openclaw
docker compose cp ./backup/specs.db.snapshot-YYYY-MM-DD.db openclaw:/data/specs.db
docker compose start openclaw
```

Followers do not need anything restored — they hold no DB state.

---

## 3. Schema

### Inspect the live schema

```bash
docker compose exec openclaw sqlite3 /data/specs.db .schema
```

Same content as `openclaw-control/daemon/src/db/schema.ts:SCHEMA_V1`: 7 tables (`projects`, `tasks`, `task_files`, `dispatches`, `dispatch_log`, `memory_files`, `schema_version`) and 8 indexes including the bug-fix-via-schema partial UNIQUE `dispatches_unique_open`.

### Current schema version

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT * FROM schema_version ORDER BY version DESC;"
```

Each migration step inserts a row with `version` and `applied_at`. The daemon refuses to start (or runs the missing migrations idempotently) when the live version doesn't match `CURRENT_VERSION` in `schema.ts`.

### Run the migrator manually

The migrator is also exposed as a CLI; it's what `entrypoint-control.sh` invokes on the leader at every boot. Idempotent — running on an already-current DB is a no-op.

```bash
docker compose exec openclaw \
  node /opt/openclaw-control/daemon/dist/db/migrations.js /data/specs.db
```

This is the recipe to use after a manual restore from an old snapshot, or after pulling a release that added a new migration step. (At the time of writing, `CURRENT_VERSION = 1`; future versions add their own `SCHEMA_V<N>` array and bump `CURRENT_VERSION`.)

---

## 4. Disaster recovery

### "DB looks corrupted" — `.recover`

If `sqlite3 /data/specs.db .schema` errors out with "database disk image is malformed", the recovery path is sqlite3's `.recover` command:

```bash
docker compose stop openclaw
HOST_DIR=$(docker volume inspect openclaw_specs-db -f '{{.Mountpoint}}')

# Dump everything that's still readable to SQL:
sudo sqlite3 "$HOST_DIR/specs.db" ".recover" > /tmp/recovered.sql

# Build a fresh DB from the recovered SQL:
sudo sqlite3 "$HOST_DIR/specs.db.new" < /tmp/recovered.sql

# Atomically swap:
sudo mv "$HOST_DIR/specs.db" "$HOST_DIR/specs.db.broken"
sudo mv "$HOST_DIR/specs.db.new" "$HOST_DIR/specs.db"
docker compose start openclaw
```

`.recover` may surface schema drift (missing indexes, etc.) — re-run the migrator (Section 3) immediately after starting to be safe.

If `.recover` itself fails, restore from the most recent `.backup` snapshot. Lost work since the snapshot is acceptable per implementation-plan.md §15.

### "Leader is down"

Followers do not have a local queue. They hard-fail HTTP calls to the leader and back off. There is no offline mode by design (per user "thin HTTP clients" directive). When the leader comes back, followers' SSE auto-reconnect picks up new events on the next `dispatch.pending`; the worker's polling loop also keeps calling `GET /api/dispatches/pending` on its `OPENCLAW_DISPATCH_MS` interval (default 10s).

If the leader is permanently lost: bring up a new leader from a backup snapshot. Set `OPENCLAW_LEADER=1` on the new host, restore `specs.db` per Section 2, and update every follower's `OPENCLAW_LEADER_URL` to point at it.

### Schema_version mismatch on boot

```
[control] FATAL: db migration failed for /data/specs.db
```

Almost always one of:

- The DB was restored from a snapshot taken on an older release. Re-run the migrator manually (Section 3) — it should bring the version up to `CURRENT_VERSION`.
- The DB file is from a release **newer** than the running image. Downgrade is not supported. Either roll the image forward to a version that knows how to read this `schema_version`, or restore an older snapshot.
- The `/data` mount is read-only or not owned by uid 1000. `chown -R 1000:1000` the host volume directory and retry.

The migrator wraps the whole step in a transaction, so a failed migration leaves the DB unchanged on disk.

---

## 5. SSE event taxonomy

Every event the daemon broadcasts on `/api/stream`. Subscribers can filter with `?topics=<csv>` — the topic is the part of the event name before the first `.`. Followers' dispatch worker subscribes with `?topics=dispatch`. Dashboards subscribe with no filter (everything).

Events are enumerated by grepping `broadcast(` across `daemon/src/`. Payload shapes match the actual call sites — no fields are invented.

| Event | Topic | Payload | Where emitted |
|---|---|---|---|
| `task.created` | `task` | `{taskId, project}` | `continuation.ts:325` after `createTask()` commits |
| `task.updated` | `task` | `{project, taskId, filename, updatedBy}` | `api.ts:290`/`:318` after a task-file PUT |
| `checkpoint.pending` | `checkpoint` | `{taskId, project, ...}` | `continuation.ts:121` when a phase needs approval |
| `checkpoint.approved` | `checkpoint` | `{taskId, phase, by}` | `continuation.ts:246` after `recordApproval` |
| `continuation.tick` | `continuation` | `{dispatched, checkpoints, pending}` | `continuation.ts:187` once per tick (only when there's something to report) |
| `dispatch.pending` | `dispatch` | `{dispatchId, agent, ...}` | `continuation.ts:169` after `insertPending` returns a non-null id |
| `dispatch.taken` | `dispatch` | `{dispatchId, agent, claimedBy?}` | `api.ts:425` after `POST /api/dispatches/:id/claim` succeeds; also `dispatch.ts:117` on the leader's local fast path |
| `dispatch.done` | `dispatch` | `{dispatchId, ok, exitCode}` | `api.ts:458` and `dispatch.ts:187` after `markDone` returns `state='done'` |
| `dispatch.failed` | `dispatch` | `{dispatchId, ok: false, exitCode}` | `api.ts:458` and `dispatch.ts:147`/`:187` when `markDone` returns `state='failed'` |
| `dispatch.poisoned` | `dispatch` | `{dispatchId, ok: false, exitCode}` | `api.ts:458` and `dispatch.ts:187` when `markDone` returns `state='poisoned'` |
| `invoker.started` | `invoker` | `{taskId, agentId}` | `invoker.ts:69` immediately before spawning ptah |
| `invoker.stdout` | `invoker` | `{taskId, chunk}` (chunk truncated to 500 chars) | `invoker.ts:126`; `ptahBridge.ts:99`/`:110` for each ptah JSON-RPC line |
| `invoker.finished` | `invoker` | `{taskId, ok, exitCode?}` | `invoker.ts:92`/`:139`/`:155` once the invocation completes (or aborts) |
| `memory.updated` | `memory` | `{scope, id, file, private}` or `{scope, id, file, deleted: true}` | `api.ts:570`/`:591` after a successful PUT or DELETE on `/api/memories/:scope/:id/:file` |
| `agent.handoff` | `agent` | the inbound handoff payload from `bus.ts:HandoffPayload` | `bus.ts:49`/`:71` for both Redis-fanout and direct local emits |
| `agent.status` | `agent` | `{agentId, ...status}` | `bus.ts:61`/`:89` from Redis status pub/sub or local emit |
| `session.message` | `session` | `{projectKey, sessionId, event}` | `watcher.ts:51` for each new line in a host's `~/.claude/projects/*.jsonl` (live-feed UI) |

To enumerate the events yourself at any time:

```bash
( cd openclaw-control/daemon/src && grep -RInE "broadcast\('[^']+" )
```

The runtime payload is whatever the second arg of each `broadcast()` call evaluates to. When in doubt, read the call site — code wins over docs.

---

## 6. Quick reference — dispatch state machine

```
   INSERT…
      │
      ▼
  ┌─────────┐  POST /api/dispatches/:id/claim
  │ pending │ ───────────────────────────────► ┌─────────┐
  └─────────┘  (UPDATE … WHERE state='pending'  │  taken  │
                RETURNING *)                    └────┬────┘
                                                     │ POST /api/dispatches/:id/done
                                                     │
                            ┌────────────────────────┼──────────────────────────┐
                            ▼                        ▼                          ▼
                       ┌────────┐              ┌─────────┐                ┌───────────┐
                       │  done  │              │ failed  │                │ poisoned  │
                       └────────┘              └─────────┘                └───────────┘
                       exitCode=0              non-zero exit              Kth consecutive
                                                +  failure_count <         failure (K =
                                                   threshold-1            OPENCLAW_DISPATCH_
                                                                          FAILURE_THRESHOLD)
```

`done` / `failed` / `poisoned` are terminal. The partial UNIQUE index `dispatches_unique_open` only enforces uniqueness for `state IN ('pending','taken')`, so the continuation loop can issue a fresh pending row once an open row terminates (or is deleted via the recipes above).

---

## 7. Rollback: turn off tool-calling chat

The tool-calling chat path (TASK_2026_002 B1–B8) is gated by a single env flag. Flipping it back to `0` falls through to the legacy `chatComplete` codepath — byte-equivalent to pre-B2 behavior, including the `<<oc:>>` directive parser. Use this when a misbehaving harness, a flaky MCP server, or a regression in the tool-call loop needs to be neutralized fast.

1. Set the flag in `.env` on every host running a bot-bridge:

   ```bash
   sed -i 's|^OPENCLAW_BOT_TOOL_CALLS_ENABLED=.*|OPENCLAW_BOT_TOOL_CALLS_ENABLED=0|' .env
   ```

2. Restart the container (the bot-bridge boots inside the same image as the daemon and gateway):

   ```bash
   docker compose restart openclaw
   ```

3. Verify chat falls through to the legacy path. @mention an agent that previously had a harness with tools — the reply should be plain text only, no tool-call evidence in the SSE stream:

   ```bash
   curl -N -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
     "http://localhost:7878/api/stream?topics=invoker"
   # While that's open, ping the agent in Discord. No `invoker.tool_call`
   # events should appear. Plain-chat replies do not emit on this topic.
   ```

4. Confirm the bot-bridge log records the flag-off branch:

   ```bash
   docker compose exec openclaw grep 'tool_calls_enabled=0\|chatComplete fallback' /tmp/openclaw-control-bot.log | tail -5
   ```

When the flag is `0`, the legacy `<<oc:>>` directive path is byte-equivalent to pre-B2. Personas that depended on tool calls (Horus's MCP `gh` server, `delegate_to_subagent`, etc.) lose those capabilities and fall back to whatever the directive grammar can express; the agent will still respond, just without tools. Re-enable by reversing step 1 and restarting.

---

## 8. Harness-resync runbook

The `harness.yaml` lives in shared memory at `agents/<id>/harness.yaml`. Edits do NOT auto-apply — the bot-bridge caches a parsed harness per agent at boot and at every Redis `harness/sync` event. To push a change cleanly:

1. PUT the new YAML body to shared memory. The internal-token bearer is the only credential the daemon accepts on this path. The body is the literal YAML; `Content-Type` must be `application/yaml` (or `text/yaml`):

   ```bash
   curl -fsS -X PUT \
     -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
     -H 'Content-Type: application/yaml' \
     --data-binary @./harness.yaml \
     "http://localhost:7878/api/memories/agents/<id>/harness.yaml"
   ```

2. Trigger the resync. This publishes `harness/sync` on Redis (which the bot-bridge consumes to invalidate its cache) AND on the leader runs `materializeAgent` to write the per-agent ptah config tree under `~/.ptah/agents/<id>/`:

   ```bash
   curl -fsS -X POST \
     -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
     "http://localhost:7878/api/agents/<id>/harness/sync"
   ```

3. Confirm the SSE event fires. In a separate terminal, before step 2:

   ```bash
   curl -N -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
     "http://localhost:7878/api/stream?topics=harness"
   # Expect: harness.synced (always) and harness.materialized (leader only,
   # with `changed: true` when the YAML actually altered the materialized tree).
   ```

4. Confirm the next chat with the agent reflects the new harness. A simple smoke is to ask the agent which tools/skills it has — the buildSystemPrompt output enumerates them, and a new skill name will appear in the reply. The bot-bridge log records the cache invalidation:

   ```bash
   docker compose exec openclaw grep 'reloadAgent.*<id>\|harnessVersion=' /tmp/openclaw-control-bot.log | tail -5
   ```

If `harness.materialized` does not fire, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#symptom-harnesssync-didnt-fire-no-harnessmaterialized-event-after-post-apiagentsidharnesssync). If `materializeAgent` fails mid-flight (filesystem error, bad YAML, path-traversal in agent id), see [the materialize-failed entry](TROUBLESHOOTING.md#symptom-materialize-failed-persona-stuck-on-old-config).

---

## 9. MCP integration smoke test

The MCP path has an integration test that spawns a real `@modelcontextprotocol/server-everything` stdio server and exercises start/list/call/stop end-to-end. The package is intentionally NOT in `bot-bridge/package.json` deps — it's a local-only diagnostic, never run in CI — so the test is gated behind `OPENCLAW_TEST_REAL_MCP=1` and otherwise skips silently.

Precondition (one-time per checkout):

```bash
cd openclaw-control/bot-bridge
npm i -D @modelcontextprotocol/server-everything
```

Run:

```bash
OPENCLAW_TEST_REAL_MCP=1 npm test -- --test-name-pattern mcp-everything
```

Expected: `mcp-everything: …` test passes; without the env var the same test shows as `skipped` in `npm test` output (this is normal — the gated test is `t.skip()`-ing itself, not failing).

When to run it: after any change to `bot-bridge/src/mcp/mcpManager.ts`, before flipping `OPENCLAW_BOT_TOOL_CALLS_ENABLED=1` in production for the first time, or when diagnosing "tools missing from chat" against a real MCP server.
