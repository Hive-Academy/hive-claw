# CUTOVER RUNBOOK — TASK_2026_006 Batch 10

> **Audience:** the human operator executing the bot-bridge → openclaw-plugin cutover.
>
> **Prerequisites:** Batch 9 has shipped (this runbook + `scripts/cutover-rollback.sh` + dual-write entrypoint + dual env vars). The leader machine's image is built from the post-Batch-9 commit. `.env` carries valid `DISCORD_TOKEN_ANUBIS` and `DISCORD_TOKEN_HORUS` in addition to the legacy `DISCORD_BOT_TOKEN`.
>
> **What this runbook does:** flips the running gateway from the OLD single-agent `openclaw.json` (driven by the host-native bot-bridge process) to the NEW multi-agent `openclaw.json` (driven by the openclaw-control plugin loaded into openclaw itself). After cutover, Anubis and Horus speak Discord directly from the gateway container — no `bot-bridge` process anywhere.
>
> **Reversibility:** until smoke tests pass, fully reversible via `scripts/cutover-rollback.sh`. Once smoke tests pass and live Discord users have started new conversations on the new agents, rollback becomes increasingly visible — practical recovery is the `pre-task-2026-006-cleanup` git tag + redeploy.

---

## Table of contents

1. [Pre-cutover checks](#1-pre-cutover-checks)
2. [Cutover sequence](#2-cutover-sequence)
3. [Smoke tests](#3-smoke-tests)
4. [Rollback](#4-rollback)
5. [Post-cutover monitoring](#5-post-cutover-monitoring)
6. [Failure decision tree](#6-failure-decision-tree)

---

## 1. Pre-cutover checks

**Every box must be ticked before you advance to §2.** Tick them in order — each depends on the previous.

### 1.1 Recovery anchor tag exists

```bash
git tag -l | grep '^pre-task-2026-006-cleanup$'
```

Expected: prints `pre-task-2026-006-cleanup`. If empty, **stop**. The team-leader needs to create the anchor (`git tag pre-task-2026-006-cleanup <pre-migration-sha>`) before any cutover.

### 1.2 SQLite spec store backed up

```bash
docker exec openclaw-daemon sqlite3 /data/specs.db ".backup /data/specs.db.bak"
docker exec openclaw-daemon ls -lh /data/specs.db.bak
```

Expected: the `.bak` file is present and approximately the same size as `specs.db`. If the daemon container is not running, the cutover is unsafe — start it first.

### 1.3 `openclaw.json` snapshot inside the gateway container

```bash
docker exec openclaw-gateway sh -c \
    'cp /home/agent/.openclaw/openclaw.json /home/agent/.openclaw/openclaw.json.bak.$(date -u +%Y%m%d-%H%M%S)'
docker exec openclaw-gateway ls -lh /home/agent/.openclaw/openclaw.json.bak.*
```

Expected: at least one `openclaw.json.bak.<timestamp>` file. **`scripts/cutover-rollback.sh` requires this** — without it, rollback refuses to run.

### 1.4 `.env` carries the new tokens

```bash
grep -E '^DISCORD_TOKEN_(ANUBIS|HORUS)=' .env
```

Expected: both lines present, both with non-empty values. Verify the tokens by spot-checking the Discord developer portal application IDs match the running personas.

### 1.5 Image builds clean

```bash
docker compose build
```

Expected: exits 0, no warnings about missing build context or stale layers. If the build is dirty, fix it before cutover — you do not want to debug a build during the cutover window.

### 1.6 Bind-mount unit test passes

```bash
# Verifies the host-side .ptah dir is visible inside the container at the
# identity-mapped path the daemon will emit when dispatching subagents.
docker exec openclaw-gateway ls -la "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/agents" 2>/dev/null
```

Expected: directory listing succeeds. If `ls` reports "No such file or directory", the bind-mount is broken — the new plugin will fail to materialize per-agent ptah configs. Stop, debug `docker-compose.yml`'s `volumes:` block, retry.

### 1.7 Operator confirms low-traffic window

A subjective check: scan recent activity in the relevant Discord channels and DMs. The cutover budgets up to **2 minutes** of Anubis offline time (per Batch 10 acceptance criterion). If there are active conversations in flight, **postpone**.

### 1.8 Session-resume smoke test was rehearsed

The session-resume smoke test (`.ptah/specs/TASK_2026_006/session-resume-smoke-test.md`, run during Batch 8d) must have passed at least once on this leader machine. If you did not personally run it, ask the team-leader to confirm. If unconfirmed, **stop** — there is no point cutting over if sessions don't survive the restart.

### 1.9 `openclaw.json.new` exists and parses

```bash
docker exec openclaw-gateway ls -lh /home/agent/.openclaw/openclaw.json.new
docker exec openclaw-gateway jq '.agents.list[0].id' /home/agent/.openclaw/openclaw.json.new
```

Expected: file present; first agent id is `"anubis"`. This is what you're about to activate in §2 step 3. If it is missing or the agent list is wrong, the entrypoint did not render correctly — inspect `docker logs openclaw-gateway` for `[entrypoint]` lines.

---

## 2. Cutover sequence

Eight steps. Run them in order. Do not skip step verification.

### Step 1 — Stop the OLD bot-bridge process

The pre-migration deployment ran a host-native bot-bridge under PID 2598 (or similar). If it is still running:

```bash
pgrep -af 'bot-bridge|openclaw-control/bot-bridge' || echo "no bot-bridge process found"
# If a PID is listed:
kill <PID>
# Wait 5 seconds, then verify it stayed down:
sleep 5 && pgrep -af 'bot-bridge|openclaw-control/bot-bridge' || echo "bot-bridge stopped"
```

If bot-bridge was containerized (it is not, per amendment §1), skip this step.

**On failure:** if `kill <PID>` hangs or the process restarts (systemd unit, supervisor), find and disable the supervisor first (`systemctl --user stop ptah-bridge` is NOT the right one — that is the host ptah-bridge, leave it alone). Search for `openclaw-bot-bridge` unit files.

### Step 2 — Confirm Anubis appears offline on Discord

Open the Discord server / DM. Look at Anubis's avatar — it should show **offline** within 10-30 seconds of step 1.

**If Anubis is still online after 60s:** another bot-bridge process is running somewhere. Find it before proceeding (`ps auxf | grep -i bot`).

### Step 3 — Activate the new openclaw.json

```bash
docker exec openclaw-gateway cp \
    /home/agent/.openclaw/openclaw.json.new \
    /home/agent/.openclaw/openclaw.json

# Verify the activation
docker exec openclaw-gateway jq '.agents.list | length' /home/agent/.openclaw/openclaw.json
```

Expected: prints `2` (anubis + horus).

**On failure:** the `.new` file is missing or unreadable. Run `docker exec openclaw-gateway ls -la /home/agent/.openclaw/`. If `.new` is absent, the entrypoint did not render it — restart the container (`docker restart openclaw-gateway`), wait for the entrypoint to re-run, retry step 3.

### Step 4 — Restart the gateway

Try the graceful CLI restart first:

```bash
docker exec openclaw-gateway openclaw gateway restart
```

Expected: prints a restart confirmation line and exits 0.

**Fallback** (if the CLI command hangs >30s or exits non-zero):

```bash
docker restart openclaw-gateway
```

This is a SIGTERM + SIGKILL — in-flight tool calls in the gateway will be cut off, but openclaw's session store should recover them on next message.

### Step 5 — Wait for gateway healthcheck

```bash
for attempt in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:18789/health 2>/dev/null; then
        echo "gateway healthy on attempt ${attempt} ($((attempt * 2))s elapsed)"
        break
    fi
    sleep 2
done
```

Expected: prints `gateway healthy on attempt N` within 30 seconds.

**On failure:** if 30s elapse without a 200, run `docker logs --tail 200 openclaw-gateway`. Common causes:
- Invalid JSON in `openclaw.json` → entrypoint exited (see `[entrypoint] FATAL` lines).
- Plugin failed to register → check for `Tool not available` / plugin load errors.
- LLM provider probe failed → cosmetic, gateway should still come up.

If logs are not actionable within 5 minutes, **go to §4 Rollback**.

### Step 6 — Run the smoke tests

Proceed to **§3 Smoke tests** below. Each test has its own pass/fail criterion. Do NOT skip ahead until §3 is fully green.

### Step 7 — Declare cutover green (if §3 green)

Mark the cutover successful. Note the timestamp and the operator's name in the PR comment thread for TASK_2026_006:

```
Cutover declared green at <UTC timestamp> by <operator name>.
All 7 smoke tests passed. Monitoring window: 24h. Batch 11 deferred until <UTC timestamp + 24h>.
```

### Step 8 — If any smoke test failed, go to §4 Rollback

Do not attempt to "fix forward" inside the cutover window — see §4.

---

## 3. Smoke tests

All 7 must pass before declaring cutover green. Run them in order; later tests depend on earlier ones.

### 3.1 `list_projects` tool invokable

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:18789/tools/invoke \
     -d '{"tool":"list_projects"}'
```

**Pass criterion:** HTTP 200 with a JSON body containing `"result"` and `"content"`.

**Fail criterion:** HTTP 404 with `Tool not available` — the plugin did not load. Inspect `docker logs openclaw-gateway 2>&1 | grep -iE 'plugin|registered'`. **Roll back** if you cannot resolve in 5 minutes.

### 3.2 `list_installed_plugins` tool invokable

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:18789/tools/invoke \
     -d '{"tool":"list_installed_plugins"}'
```

**Pass criterion:** HTTP 200 with a JSON body. The body's `content` may be empty initially (no plugins installed yet) — that is still PASS.

**Fail criterion:** HTTP 404. Same diagnostic as §3.1.

### 3.3 Plugin registered the expected tool count

```bash
docker logs openclaw-gateway 2>&1 | grep -c "registered 12 tools"
```

**Pass criterion:** prints `1` or higher.

**Fail criterion:** prints `0`. The plugin loaded a different number of tools (or failed to load entirely). Inspect:

```bash
docker logs openclaw-gateway 2>&1 | grep -iE 'tools|plugin' | tail -50
```

If the actual count is 10 or 11 (close to 12), it may be a count-drift — file a follow-up but accept the cutover. If the count is 0 or 1, **roll back**.

### 3.4 Anubis answers a Discord DM

Open a DM with Anubis on Discord and send: `@Anubis ping`.

**Pass criterion:** Anubis replies within 30 seconds. The reply text content is not strictly checked — any coherent response from the Anubis persona counts.

**Fail criterion:** No reply within 60 seconds, OR Horus answers instead. Check `docker logs openclaw-gateway 2>&1 | grep -iE 'discord|anubis'` for connection errors. **Roll back** if no clear path to fix in 5 minutes.

### 3.5 Horus answers a Discord DM

Open a DM with Horus and send: `@Horus ping`.

**Pass criterion:** Horus replies within 30 seconds, from the Horus persona (not Anubis).

**Fail criterion:** Same as §3.4 but for Horus. Most likely cause if §3.4 passed and §3.5 failed: `DISCORD_TOKEN_HORUS` is missing or invalid. Verify with `docker exec openclaw-gateway env | grep DISCORD_TOKEN_HORUS` (token will be present; value redacted by the entrypoint's logs but `env` shows it raw — be careful where you run this). **Roll back** if the token is wrong.

### 3.6 Daemon SSE stream emits `session.created` with correct `agentId`

In a separate terminal:

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
     -N "http://127.0.0.1:7878/api/stream?topics=sessions" &
SSE_PID=$!
```

Now in Discord, DM Anubis again (`@Anubis status`). Watch the SSE stream for an event like:

```
event: session.created
data: {"agentId":"anubis", ...}
```

**Pass criterion:** within 30 seconds, you see a `session.created` event with `"agentId":"anubis"` AND a separate event with `"agentId":"horus"` after DMing Horus.

**Fail criterion:** no event, or the `agentId` is wrong/empty/swapped. Kill the SSE stream (`kill $SSE_PID`). **Roll back** — the persona attribution is broken.

Clean up: `kill $SSE_PID 2>/dev/null`.

### 3.7 Daemon `/api/health` still returns `{"ok":true}`

```bash
curl -sS http://127.0.0.1:7878/api/health | jq .
```

**Pass criterion:** body contains `"ok": true`. The `dbVersion` field should be `4` (no schema migration was part of this cutover — TASK_2026_006 stays on v4 throughout, per amendment §11.4).

**Fail criterion:** non-200, `"ok": false`, or `dbVersion` ≠ 4. **Roll back** — something cascaded into the daemon.

---

## 4. Rollback

### 4.1 When to invoke

Invoke rollback **immediately** if any §3 smoke test fails and the cause is not obvious + fixable within 5 minutes. The cutover window's downtime budget is 2 minutes of Anubis-offline-time; spending 30 minutes "debugging forward" violates that budget and irritates real users.

Invoke rollback **also** if:
- Step 5 (healthcheck wait) times out and logs are not actionable.
- Discord users start reporting offline / wrong-persona behavior during the cutover window.
- You discover a pre-cutover check (§1) was actually false after you started step 2.

### 4.2 How to invoke

```bash
scripts/cutover-rollback.sh
# or, non-interactive (CI / one-shot scripts):
scripts/cutover-rollback.sh --auto
```

The script:
1. Verifies `openclaw-gateway` is running and a `openclaw.json.bak.*` snapshot exists.
2. Picks the most recent snapshot unless you pass `--snapshot <name>`.
3. Prompts for confirmation (skipped with `--yes`/`--auto`).
4. Copies the current (broken) `openclaw.json` aside as `openclaw.json.failed.<UTC-ts>`.
5. Restores the snapshot to `openclaw.json`.
6. Restarts openclaw via `openclaw gateway restart`, falling back to `docker restart`.
7. Polls `http://127.0.0.1:18789/health` for up to 60s.
8. Reports `Rollback complete.` on success, or a non-zero exit code on any failure.

See `scripts/cutover-rollback.sh --help` for exit codes.

### 4.3 State expected after rollback

- `openclaw-gateway` is running with the OLD single-agent `openclaw.json` restored from the snapshot.
- The OLD bot-bridge process is **not** running (you stopped it in §2 step 1). You must restart it manually if your pre-migration deployment relied on it for Discord traffic — find the supervisor unit or startup script that originally launched it. Common location: a systemd `--user` unit in `~/.config/systemd/user/openclaw-bot-bridge.service`, or a pm2 entry, or a manual `tmux` session.
- `openclaw.json.failed.<UTC-ts>` is sitting next to the snapshot in `/home/agent/.openclaw/` for post-mortem analysis. Capture it (`docker cp openclaw-gateway:/home/agent/.openclaw/openclaw.json.failed.* /tmp/`) before the next attempt — it is the smoking gun.
- The daemon and Redis containers are unchanged (rollback never touches them).
- The schema is still v4 (rollback never touches the DB).

### 4.4 Post-rollback steps

1. File a post-mortem note in the TASK_2026_006 PR comment thread: timestamp, which smoke test failed, what the diagnostic showed, what you suspect was wrong.
2. Do **not** retry the cutover until the root cause is understood and a code-level fix has been merged into `ak/fix-internal-calls` (or a successor branch). Retrying with the same code will fail the same way.
3. The recovery anchor `pre-task-2026-006-cleanup` remains untouched — it is your global "abandon the migration" escape if a retry also fails.

---

## 5. Post-cutover monitoring

Once §3 is green and you have declared the cutover successful in step 7, the **24-hour monitoring window** begins. Batch 11 (delete the dead bot-bridge code) is blocked until this window expires with no regressions.

### 5.1 What to watch

| Source | Command | Healthy signal | Warning signal |
|---|---|---|---|
| Gateway logs | `docker logs --since 1h openclaw-gateway 2>&1 \| grep -iE 'error\|warn\|fatal'` | <5 ERRORs/hour | spikes, repeated identical errors |
| Daemon logs | `docker logs --since 1h openclaw-daemon 2>&1 \| grep -iE 'error\|warn\|fatal'` | <5 ERRORs/hour | install pipeline errors, SSE disconnects |
| Daemon health | `curl -sS http://127.0.0.1:7878/api/health \| jq .` | `{"ok":true,"dbVersion":4}` | `ok:false`, dbVersion change |
| Discord activity | Manual: send `ping` to each persona once/hour | both reply within 5s | timeout or wrong persona answers |
| Container restarts | `docker inspect -f '{{.RestartCount}}' openclaw-gateway` | unchanged over 24h | counter increments |
| Session resume | DM a persona, restart gateway, send follow-up | continues thread context | persona starts from scratch |

### 5.2 Cutover dashboard checklist (every 2-4h for 24h)

```bash
# One-liner snapshot of the four most important signals.
echo "==> gateway health" && curl -fsS http://127.0.0.1:18789/health && \
echo "==> daemon health"  && curl -sS http://127.0.0.1:7878/api/health | jq -c . && \
echo "==> gateway errors (1h)" && docker logs --since 1h openclaw-gateway 2>&1 | grep -ciE 'error|fatal' && \
echo "==> gateway restarts (lifetime)" && docker inspect -f '{{.RestartCount}}' openclaw-gateway
```

### 5.3 When to abort the monitoring window

If at any point during the 24h window:
- A persona stops responding for >5 minutes,
- The gateway container restarts more than twice unprompted,
- The daemon's `/api/health` returns `ok:false`,
- The SQLite schema version (`dbVersion`) changes,

…treat it as a cutover regression. Roll back per §4 (the `openclaw.json.bak.*` snapshot from §1.3 is still valid), file the post-mortem, defer Batch 11.

If the 24h window completes clean, sign off on the PR thread:

```
Cutover stable for 24h+ (from <UTC-start> to <UTC-end>). Batch 11 (delete bot-bridge) cleared to proceed.
```

---

## 6. Failure decision tree

A flat lookup table from "smoke test N failed" to "do this":

| Failed test | Most likely cause | First diagnostic | Action |
|---|---|---|---|
| §3.1 `list_projects` 404 | Plugin failed to register | `docker logs openclaw-gateway 2>&1 \| grep -iE 'plugin\|register'` | Roll back; investigate plugin install path |
| §3.1 `list_projects` 5xx | Daemon unreachable from plugin | `docker exec openclaw-gateway curl -sS http://openclaw-daemon:7878/api/health` | If daemon healthy → plugin config wrong; roll back |
| §3.2 `list_installed_plugins` 404 | Plugin partial-registered (some tools missing) | `docker logs openclaw-gateway 2>&1 \| grep -i 'registered.*tools'` | Roll back; investigate tool registration code |
| §3.3 tool count != 12 | Plugin loaded wrong version / count-drift | `docker exec openclaw-gateway sh -c 'ls /home/agent/.openclaw/extensions/ 2>/dev/null && cat /home/agent/.openclaw/openclaw.json \| jq .agents.defaults.plugins'` | If count is 10-11, file follow-up + accept. If 0-1, roll back. |
| §3.4 Anubis silent | `DISCORD_TOKEN_ANUBIS` invalid / bot not invited to guild | `docker exec openclaw-gateway env \| grep DISCORD_TOKEN_ANUBIS` (token raw — handle carefully) | Verify token + guild membership; roll back if either wrong |
| §3.4 Horus answers as Anubis | Token/persona swap in `openclaw.json` | `docker exec openclaw-gateway jq '.channels.discord.accounts' /home/agent/.openclaw/openclaw.json` | Confirm token-to-persona mapping; roll back |
| §3.5 Horus silent (but §3.4 passed) | `DISCORD_TOKEN_HORUS` invalid | Same as §3.4 but for Horus | Same |
| §3.6 SSE no event | Daemon not receiving session-created callbacks from plugin | `docker logs --tail 100 openclaw-daemon \| grep -i 'session'` | Roll back; plugin→daemon callback path broken |
| §3.6 SSE wrong `agentId` | Plugin reports persona id incorrectly | Inspect SSE event body (`data: ...`) | Roll back; persona-attribution bug |
| §3.7 daemon `ok:false` | Cascading failure into the daemon (rare) | `docker logs --tail 200 openclaw-daemon` | Roll back; investigate daemon-side error |
| §3.7 `dbVersion` != 4 | A migration ran unexpectedly | `docker exec openclaw-daemon sqlite3 /data/specs.db 'SELECT * FROM schema_version'` | **Stop. This is a serious bug.** Roll back, restore DB from §1.2 backup, escalate. |

> **General principle:** when in doubt, roll back. The rollback is fast (~60s), reversible (you can re-cut over once the bug is fixed), and bounded (the `openclaw.json.failed.*` snapshot preserves the broken state for post-mortem). The cost of a wrong "fix-forward" attempt is unbounded.

---

**End of CUTOVER_RUNBOOK.md.**
