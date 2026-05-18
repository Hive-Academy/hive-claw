# Troubleshooting

Every alpha-software gotcha hit during initial setup, with the symptom, root cause, and exact fix. Each entry is independent — jump to whichever matches your problem.

---

## Container won't reach `ready`

### Symptom: log shows plugins installing forever, no `[gateway] ready`

**First-run plugin installs are slow.** The `browser` plugin pulls Playwright + Chromium (~150 MB), `discord` pulls discord.js + @buape/carbon, etc. Total ~90 seconds on a decent connection. Be patient on first start.

```bash
docker compose logs -f openclaw
# Look for: [plugins] <name> installed bundled runtime deps in <ms>ms
# After all plugins install, [gateway] starting HTTP server... → [gateway] ready
```

If it's been > 5 min and still installing, check internet from inside container:

```bash
docker compose exec openclaw curl -fsS https://registry.npmjs.org/openclaw/latest -o /dev/null -w "%{http_code}\n"
```

### Symptom: container in crashloop, `openclaw exited with code 1` every ~30s

Check for unhandled rejections:

```bash
docker compose logs openclaw 2>&1 | grep -A2 "Unhandled promise rejection"
```

Most common cause: **bonjour plugin crashing** with `CIAO PROBING CANCELLED`. mDNS multicast doesn't work on Docker bridge networks. Disabled by default in our config (`plugins.entries.bonjour.enabled: false`). If you removed that, put it back.

### Symptom: gateway `ready`, then `openclaw exited with code 1` after ~60s

Likely the bonjour issue (see above) — the watchdog fires after 30s and cancels the probe, throwing the unhandled rejection slightly later.

---

## Auth and config errors

### Symptom: `[entrypoint] FATAL: OPENCLAW_AUTH_TOKEN is empty`

`.env` doesn't have a value for `OPENCLAW_AUTH_TOKEN`. Run:

```bash
./setup.sh
```

It generates one with `openssl rand -hex 32`. Or set it manually:

```bash
echo "OPENCLAW_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
```

### Symptom: `[gateway] auth token was missing. Generated a new token` on every restart

OpenClaw self-generated a token but it's not persisting. Cause: our entrypoint re-renders `openclaw.json` on every start, which would overwrite the auto-generated token. The fix is to set `OPENCLAW_AUTH_TOKEN` in `.env` so the rendered config always has a stable token. Already done in current setup.

If you see this happening despite `OPENCLAW_AUTH_TOKEN` being set, check that `entrypoint.sh` includes `${OPENCLAW_AUTH_TOKEN}` in the envsubst allow-list.

### Symptom: `Config invalid ... must NOT have additional properties`

You added a key to `openclaw.json.tmpl` at the wrong level. OpenClaw's schema is strict. Common mistake: putting `commands` under `channels.discord` instead of at the top level.

```bash
docker compose logs openclaw 2>&1 | grep -B2 -A4 "Config invalid"
```

Read the path the error gives you, move the offending key to a different level, rebuild:

```bash
docker compose up -d --build
```

### Symptom: `Config auto-restored from backup ... missing-meta-vs-last-good`

The rendered `openclaw.json` is missing the `meta` block, so openclaw declared it tampered and reverted to `.bak`. Make sure your template has:

```json
"meta": {
  "lastTouchedVersion": "${OPENCLAW_VERSION}",
  "lastTouchedAt": "${OPENCLAW_NOW}"
}
```

…and that `entrypoint.sh` exports those variables before `envsubst`.

---

## Networking

### Symptom: `[entrypoint] WARNING: cannot reach http://host.docker.internal:11434/v1/models`

The container can't see Ollama on the host. Two checks:

```bash
# 1. Is Ollama listening on all interfaces (not just loopback)?
ss -tlnp | grep 11434
# Should show: 0.0.0.0:11434  or  *:11434
# If it shows 127.0.0.1:11434, run setup.sh again — it'll write the systemd override.
```

```bash
# 2. Manual override (if setup.sh's didn't take):
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

### Symptom: dashboard at `http://127.0.0.1:18789/?token=...` doesn't load (timeout)

Check the gateway is bound to all interfaces *inside* the container (not just localhost):

```bash
docker compose logs openclaw 2>&1 | grep "binding to"
# Should see: "Gateway is binding to a non-loopback address"
```

If it says "loopback" or "localhost", the `bind: "lan"` config didn't take. Check `gateway.bind` is in `openclaw.json.tmpl` and the entrypoint passes `--bind lan` to `openclaw gateway`.

### Symptom: bot online in Discord but ignores all `@mentions`

Most likely: `accessGroups` is on. Check the runtime config log:

```bash
docker compose logs openclaw | grep "discord:.*config"
# Look for: accessGroups=on  ← bad
#       or: accessGroups=off ← good
```

Fix: ensure `commands.useAccessGroups: false` is at the **top level** of `openclaw.json.tmpl` (NOT under `channels.discord` — the schema rejects it there).

Other possible causes:

- **Bot lacks View Channel permission** in the channel where you're mentioning. Try `#general`. To grant per-channel: right-click channel → Edit Channel → Permissions → Add `@<bot-role>` → enable View Channel + Send Messages + Read Message History.
- **`requireMention: true` and you're not actually mentioning.** Make sure you're using the @mention picker, not just typing the name.
- **Wrong guild ID.** Verify with the API:
  ```bash
  docker compose exec openclaw bash -c '
    curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      https://discord.com/api/v10/users/@me/guilds | jq ".[].id"
  '
  ```
  Compare against `DISCORD_GUILD_ID` in `.env`.

### Symptom: bot replies once, then stops responding

Likely the agent run is stuck on Ollama. Check:

```bash
docker compose logs openclaw 2>&1 | grep -E "stuck session|aborted|isError"
```

If `[diagnostic] stuck session: ... state=processing age=NNNs`, the run is hung. Wait — the `timeoutSeconds: 600` config aborts at 10 min. Or force-clear:

```bash
docker compose down
docker compose up -d
```

Common causes for sticking:

- Cloud model overloaded (`*:cloud` routes through ollama.com which can rate-limit)
- Streaming chunk dropped without TCP reset (rare)
- Massive system prompt + long history → real model thinking time, not stuck

---

## Discord-specific

### Symptom: `Discord Message Content Intent is limited; bots under 100 servers can use it without verification`

This is informational, not an error. Discord's Message Content intent needs verification for bots in 100+ servers. Personal bots in a single guild are fine.

### Symptom: `[discord] startup ... gatewayConnected=false`

Initial connection state — within a few seconds you should see `gatewayConnected=true`. If it stays false:

- Token wrong or expired — regenerate in Developer Portal.
- Required intents not enabled — Developer Portal → Bot → Privileged Gateway Intents → enable both `SERVER MEMBERS` and `MESSAGE CONTENT`.
- Discord API outage — check https://discordstatus.com.

### Symptom: bot user shows offline despite logs saying connected

Try restarting the container — sometimes Discord caches stale presence:

```bash
docker compose down
docker compose up -d
```

If still offline after 2 min, regenerate the bot token in Developer Portal and update `.env`.

---

## Mounts and permissions

### Symptom: `entrypoint.sh: line N: /home/agent/.openclaw/openclaw.json: Permission denied`

The named volume was created with root ownership before the `agent` user (uid 1000) existed inside the container. Drop and recreate:

```bash
docker compose down -v   # ⚠️ -v deletes the named volume
docker compose up -d --build
```

`-v` removes openclaw-state. Plugin runtime deps will re-install (~90 s on first startup after this).

### Symptom: files I create in `~/projects/<x>/` aren't visible inside the container

Verify the mount:

```bash
docker compose exec openclaw ls -la /home/agent/.openclaw/workspace/
```

If empty or wrong, check `WORKSPACE_DIR` in `.env`:

```bash
grep WORKSPACE_DIR .env
# Must point to a real directory on the host
```

Then `docker compose up -d --force-recreate` to apply the mount change.

### Symptom: can't write files from container (`agent` permission denied)

UID mismatch between container's `agent` user and host's user. The image creates `agent` with uid 1000. If your host user is uid 1001 or higher, you'll see permission issues on bind mounts.

Check:
```bash
id              # host user — should be uid=1000
docker compose exec openclaw id agent   # should also be uid=1000
```

If they differ, edit `Dockerfile`:

```dockerfile
RUN useradd --create-home --shell /bin/bash --uid <YOUR_UID> agent
```

Replace `<YOUR_UID>` with the output of `id -u` on the host. Rebuild.

---

## Performance

### Symptom: very slow first response (>30 s)

Normal for `*:cloud` models with large system prompts. The 28 KB system prompt + history can add 5–10 s of network upload alone.

To speed up:

- Switch to a smaller cloud model: `OLLAMA_MODEL=qwen3.5:cloud` (if available)
- Run a local model if you have a GPU: `ollama pull qwen3:14b && OLLAMA_MODEL=qwen3:14b`
- Disable plugins you don't use (browser is heavy):
  ```json
  "plugins": {
    "entries": {
      "bonjour": { "enabled": false },
      "browser": { "enabled": false }
    }
  }
  ```

### Symptom: container using >2 GB RAM

Browser plugin (Playwright + Chromium) is the usual culprit. If you don't use browser automation:

1. Disable in config: `"plugins": { "entries": { "browser": { "enabled": false } } }`
2. Rebuild: `docker compose up -d --build`

Add resource limits to compose if you want hard caps:

```yaml
services:
  openclaw:
    mem_limit: 1g
    cpus: 2.0
```

---

## Control plane (`:7878`)

### Symptom: daemon never starts; `[control]` never logs

```bash
./scripts/dc.sh compose exec openclaw cat /tmp/openclaw-control-daemon.log | tail -30
```

Common causes:

- `OPENCLAW_JWT_SECRET` left as the literal default `change-me-…` in `.env` while `DISCORD_CLIENT_ID` is set → daemon refuses to start. Re-run `setup.sh` (it generates a real secret) or set one manually: `OPENCLAW_JWT_SECRET=$(openssl rand -hex 32)`.
- Port `:7878` already in use on the host. Check `ss -tln | grep 7878`. Either kill the conflicting process or change `OPENCLAW_PORT` (and the matching ports forward in `docker-compose.yml`).
- `OPENCLAW_CONTROL_DISABLE=1` in `.env`. The launcher exits early in that case.

### Symptom: stuck dispatch — `taken` for hours, no `dispatch.done` event

A follower (or the leader's own worker) claimed a dispatch and then died, lost its network, or the ptah subprocess hung past the timeout. The row sits in `state='taken'` and the partial UNIQUE index `dispatches_unique_open` blocks the continuation loop from inserting a fresh `pending` for the same `(project, task, phase)` until it terminates.

**Diagnose** (run on the leader):

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, project_slug, task_id, phase, agent_id, claimed_by, claimed_at, failure_count
     FROM dispatches
    WHERE state='taken'
    ORDER BY claimed_at;"
```

Compare `claimed_at` against now. Anything older than `OPENCLAW_TICK_MS × 2` plus reasonable invocation time is suspect. Check the dispatch's audit trail:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT ts, level, message FROM dispatch_log WHERE dispatch_id='<id>' ORDER BY ts;"
```

**Fix** — force the row to a terminal state so the continuation loop can issue a fresh attempt:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "UPDATE dispatches
      SET state='failed',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id='<id>';"
```

Note that this does **not** increment `failure_count` on the K-recent-window check — it just unblocks the unique index. The next continuation tick will issue a new pending row with a fresh id.

### Symptom: poisoned dispatch — runaway-loop guard tripped

`OPENCLAW_DISPATCH_FAILURE_THRESHOLD` (default 3) consecutive failures for the same `(project_slug, task_id, phase)` flip the row to `state='poisoned'`. The continuation loop refuses to issue a new pending while a poisoned row is open, so the task halts.

**Diagnose**:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, project_slug, task_id, phase, failure_count, exit_code, stderr_snippet
     FROM dispatches
    WHERE state='poisoned';"
```

The `stderr_snippet` is the last 4 KB of stderr from the final attempt. Read it. Common causes: missing API key (ptah `authMethod` mismatch), persona missing, network hiccup x N.

**Fix** — once you've addressed the root cause, clear the poisoned row so the next continuation tick can issue a fresh attempt:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "DELETE FROM dispatches
    WHERE state='poisoned'
      AND project_slug='<slug>'
      AND task_id='<TASK_YYYY_NNN>'
      AND phase='<PHASE>';"
```

The cascade also drops the `dispatch_log` rows for that id (FK ON DELETE CASCADE). If you want to keep the log, mark the row `failed` instead:

```bash
docker compose exec openclaw sqlite3 /data/specs.db \
  "UPDATE dispatches SET state='failed' WHERE id='<id>';"
```

### Symptom: follower can't reach the leader — SSE reconnect errors

The follower's dispatch worker logs repeated `[dispatch] SSE error … reconnecting` or `fetch failed` against `OPENCLAW_LEADER_URL`. New `dispatch.pending` events are not flowing.

**Diagnose** — on the follower:

```bash
docker compose exec openclaw curl -fsS \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "$OPENCLAW_LEADER_URL/api/health"
```

Three failure modes:

- **Connection refused / timeout** — leader is down, or the URL/port is wrong, or a firewall sits between you. Verify the leader is up (`curl http://127.0.0.1:7878/api/health` on the leader host) and that `OPENCLAW_LEADER_URL` resolves and routes from the follower's container.
- **`401`** — `OPENCLAW_INTERNAL_TOKEN` differs between leader and follower. They MUST match exactly. Update the follower's `.env` and `docker compose up -d`.
- **`502 / 503`** — TLS terminator (Tailscale Funnel / Caddy / Cloudflare) up but the leader's daemon is not. Check the leader's `/tmp/openclaw-control-daemon.log`.

**Workaround while you fix it**: the follower's worker keeps polling `GET /api/dispatches/pending` on its `OPENCLAW_DISPATCH_MS` interval (default 10s) even with SSE down, so claims will resume on the next successful HTTP call. No state is lost on either side.

### Symptom: `database is locked` (`SQLITE_BUSY`) in the leader's daemon log

Under WAL mode + `busy_timeout=5000`, this is rare. It means a write transaction held the writer lock longer than 5 s — almost always a bug, not a runtime condition.

**Diagnose**:

```bash
docker compose logs openclaw 2>&1 | grep -E 'SQLITE_BUSY|database is locked' | tail -20
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT ts, level, message FROM dispatch_log WHERE level='warn' ORDER BY ts DESC LIMIT 50;"
```

**Mitigation now** — restart the leader so any stuck writer goes away:

```bash
docker compose restart openclaw
```

**Mitigation long-term** — see `daemon/src/db/client.ts` header comment: every write transaction must use `BEGIN IMMEDIATE` and at most 2-3 statements; no I/O inside a transaction; payloads bounded. If you added a write path recently, audit it against that list. If the lock contention is from a long `task_files.write`, reduce the `.md` body or chunk it.

### Symptom: `[bot-bridge] agent "<id>" has no local persona — skipping`

`~/.claude/local-memory/agents/<id>/persona.md` is missing. Either run `./setup.sh` (it scaffolds it from `templates/agent-persona.md.tmpl`) or copy from another machine that owned this agent before.

The bot-bridge re-checks on every restart, so:

```bash
$EDITOR ~/.claude/local-memory/agents/<id>/persona.md
./scripts/dc.sh compose restart openclaw
```

### Symptom: bot replies in Discord but actions never happen

The model emitted text but no `<<oc:create_task …>>` directive. Likely causes:

- The agent's persona doesn't match the user's request (asked about state, not action).
- The model generated the directive in the wrong format. The bridge expects `<<oc:OP arg1="value1" arg2="value2">>` exactly. Quotes must be `"`, args are `\w+`-named, no nesting.
- The TOOLBELT_DOC is missing from the system prompt. Check `bot-bridge/src/chat.ts:buildSystemPrompt()` is being called.

To debug, watch `/tmp/openclaw-control-bot.log` and pipe a known-good directive into a test message; the bridge logs every parsed directive.

### Symptom: dashboard returns `401 unauthenticated` on a phone

You logged in once, the JWT cookie isn't being sent. Two common causes:

- The dashboard is on `https://...` but `DISCORD_REDIRECT_URI` was set to `http://...`. Cookies set on HTTPS aren't sent over HTTP and vice versa. Update both.
- Cross-site cookie blocking (Safari, strict tracking-prevention modes). The cookie is `SameSite=lax`, so this is rare, but if a redirect chain crosses sites it can drop the cookie. Try a different browser to isolate.

### Symptom: dashboard returns `403 user not allowed`

Your Discord user ID isn't in `DISCORD_ALLOWED_USER_IDS`, AND either `DISCORD_ALLOWED_GUILD_ID` is unset or you're not in that guild. Add your ID:

```bash
# In Discord with Dev Mode on: right-click yourself → Copy User ID
sed -i 's|^DISCORD_ALLOWED_USER_IDS=.*|DISCORD_ALLOWED_USER_IDS=123456789012345678|' .env
./scripts/dc.sh compose up -d
```

### Symptom: continuation loop dispatched but task didn't advance

```bash
./scripts/dc.sh compose exec openclaw cat /tmp/openclaw-control-daemon.log | grep '\[continuation\]\|\[invoker\]'
```

Look for `invoker.finished … exitCode=N`:

- `exitCode=0` but task still at the same phase → the agent didn't write the expected artifact (`task-description.md` etc.). The dispatch's audit trail is in `dispatch_log`: `docker compose exec openclaw sqlite3 /data/specs.db "SELECT ts, level, message FROM dispatch_log WHERE dispatch_id='<id>' ORDER BY ts;"`. The host-side ptah-bridge also keeps stdout per invocation in its journal: `journalctl --user -u ptah-bridge.service -n 200`.
- `exitCode!=0` → the ptah subprocess errored. Stderr is in the log file.

### Symptom: the leader's continuation loop "is supposed to be running" but isn't

```bash
./scripts/dc.sh compose exec openclaw grep '\[continuation\]' /tmp/openclaw-control-daemon.log
```

If the line is `[continuation] not leader — loop disabled`, `OPENCLAW_LEADER` isn't `1`. Set it; restart.

If the line is `[continuation] leader mode — loop running every Nms` but no `tick` events follow, no projects were discovered. The loop iterates over `discoverProjects()` which scans `specs/`. An empty `specs/` is a fresh-repo state — create a task to populate it.

### Symptom: bot replies "(no reply — the LLM backend timed out or returned nothing)"

The bot-bridge tried to call your `LLM_PROVIDER` for free-form chat and got nothing back. Discord chat goes direct to the configured provider — it does NOT use ptah. Check:

```bash
# Did Ollama (or your provider) respond?
./scripts/dc.sh compose exec openclaw bash -lc '
  curl -fsS --max-time 30 http://host.docker.internal:11434/v1/chat/completions \
    -H "content-type: application/json" \
    -d "{\"model\":\"$LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}" \
  | head -c 300
'
```

If that errors, your provider is the problem. If it succeeds, the bot-bridge logs (`/tmp/openclaw-control-bot.log`) will show why the response wasn't usable (auth, model name, etc.).

### Symptom: dispatch ran with `exitCode=0` but task didn't advance — bridge logs show only `session.created`

ptah on the host started a session but never produced assistant text. Means ptah-cli got no usable provider:

```bash
# What auth method does the host's ptah think it's using?
ptah auth status 2>&1 | jq -r '.params | "authMethod=\(.authMethod) claudeCliInstalled=\(.claudeCliInstalled) copilotAuthenticated=\(.copilotAuthenticated)"'
```

Common combos:
- `authMethod=claudeCli` + `claudeCliInstalled=false` → `claude` binary not on the bridge service's PATH. Edit `~/.config/systemd/user/ptah-bridge.service` to add `Environment="PATH=..."` including the dir where `claude` lives, then `systemctl --user daemon-reload && systemctl --user restart ptah-bridge`.
- `authMethod=claudeCli` + `claudeCliInstalled=true` + missing `~/.claude/credentials.json` → run `claude /login` once on the host.
- `authMethod=apiKey` + no provider key → `ptah provider set-key <provider> <key>`.

### Symptom: `/api/continuation/tick` works but bridge logs show no `/invoke`

The daemon may have fallen through to in-container `ptah` spawn instead of using the bridge. Check the daemon's resolved config:

```bash
./scripts/dc.sh compose exec openclaw env | grep OPENCLAW_PTAH_BRIDGE_URL
# Should print http://host.docker.internal:8744 (or your override). Empty = fallback mode.
```

If empty, set it in `.env` and `./scripts/dc.sh compose up -d`.

### Symptom: bridge `401 unauthorized` — daemon and bridge tokens disagree

The bot-bridge / daemon use `OPENCLAW_INTERNAL_TOKEN` from the container env (auto-generated if `.env` doesn't pin it). The bridge reads its token from the systemd unit. They drift if you regenerate one without updating the other.

```bash
# Pull the live token from the running container
TOKEN=$(./scripts/dc.sh compose exec -T openclaw bash -c 'echo $OPENCLAW_INTERNAL_TOKEN' | tr -d '\r\n')

# Pin it in .env so it survives recreates
sed -i "s|^OPENCLAW_INTERNAL_TOKEN=.*|OPENCLAW_INTERNAL_TOKEN=${TOKEN}|" .env

# Update the systemd unit
sed -i "s|Environment=\"OPENCLAW_INTERNAL_TOKEN=.*\"|Environment=\"OPENCLAW_INTERNAL_TOKEN=${TOKEN}\"|" ~/.config/systemd/user/ptah-bridge.service
systemctl --user daemon-reload && systemctl --user restart ptah-bridge.service
```

### Symptom: bridge translates path but ptah complains "no such file or directory"

Path translation is prefix-based. If your project lives outside `WORKSPACE_DIR` (e.g. you cloned to `~/code/foo` instead of `~/projects/foo`), the bridge has nothing to map. Override per-deployment via `BRIDGE_WORKSPACE_HOST` in the systemd unit, or set the project's `workspace` field in the leader's `projects` row: `UPDATE projects SET workspace='/abs/host/path' WHERE slug='<slug>';`.

### Symptom: gateway dashboard at `:18789` works, control dashboard at `:7878` doesn't

Two different processes; check each independently. The control dashboard requires the daemon to have started cleanly AND the dashboard build to be present at `/opt/openclaw-control/dashboard/browser/index.html` inside the container. If you're running a custom build:

```bash
./scripts/dc.sh compose exec openclaw ls /opt/openclaw-control/dashboard/browser/
# index.html, main-*.js, polyfills-*.js, styles-*.css
```

If empty, the build step in the Dockerfile failed silently. `docker compose up -d --build` to retry.

---

## Tool-calling chat and harness materialization

Entries below cover the TASK_2026_002 surface: the inline tool-call loop, native skill loading, MCP servers, harness materialization, and the host/container path mapping that backs all of it. If a chat regression appears suddenly and you can't pin it, the rollback is one env flag — see [OPERATIONS.md §7](OPERATIONS.md#7-rollback-turn-off-tool-calling-chat).

### Symptom: MCP server failed and tools missing from chat

A persona's harness lists an MCP server, but `mcp__<server>__*` tools never appear in tool-call output. The bot-bridge log shows `[mcp] <agent>/<server> backoff exhausted after 6 attempts — emitting mcp.server_failed`.

The MCP manager's spawn/respawn loop uses a hard-coded backoff curve `[1000, 2000, 4000, 8000, 16000, 30000]` ms — six attempts total. After the sixth crash the entry flips to `failed=true`, an `mcp.server_failed` SSE event fires, and `getOpenServers()` filters that server out of every subsequent tool list. The chat keeps working without it; the agent just doesn't know the tool exists.

**Diagnose**:

```bash
# Watch the SSE stream for the fail event:
curl -N -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/stream?topics=mcp"

# And read the bot-bridge log for the actual stderr from the dying child:
docker compose exec openclaw grep -E '\[mcp\] .*spawn|exit|backoff' \
  /tmp/openclaw-control-bot.log | tail -30
```

Common root causes: the MCP server's binary isn't on `PATH` inside the container, a required env var (`GH_TOKEN` for `gh`, etc.) is unset, or the package's stdio protocol mismatched the SDK version.

**Fix** — once the underlying issue is resolved, the cleanest recovery is a harness resync (which tears down and respawns the MCP entry from scratch). See [OPERATIONS.md §8](OPERATIONS.md#8-harness-resync-runbook). If you want to skip the YAML edit and just kick the manager, restart the container — the bot-bridge re-instantiates `mcpManager` on boot:

```bash
docker compose restart openclaw
```

There is no `POST /api/agents/<id>/mcp/resync` endpoint (B9 audit confirmed). The harness-sync path is the supported manual reconcile.

Reference: `bot-bridge/src/mcp/mcpManager.ts` (`BACKOFF_CURVE_MS` constant + `respawn` logic).

### Symptom: harness/sync didn't fire — no `harness.materialized` event after `POST /api/agents/<id>/harness/sync`

You PUT a new `harness.yaml` to shared memory and POST'd to `/harness/sync`, but no SSE event arrived on `?topics=harness` and the agent's chat behavior is unchanged. Three things to check, in order.

1. **Redis is reachable from the container.** The harness-sync fanout is a Redis pub/sub. If Redis is down or partitioned, the leader emits the event locally but no follower hears it; on a single-host install the local emit still works, but on a multi-host install only the leader's bot-bridge sees it.

   ```bash
   docker compose exec openclaw redis-cli -h "${REDIS_HOST:-redis}" ping
   # Expect: PONG
   ```

2. **The daemon successfully subscribed.** If the daemon couldn't `psubscribe` at boot (auth failure, DNS hiccup), it logs a one-shot error and silently continues without pub/sub. Grep for it:

   ```bash
   docker compose exec openclaw grep -E 'psubscribe|REDIS|\[bus\]' \
     /tmp/openclaw-control-daemon.log | tail -20
   ```

3. **The agent ID is in `OPENCLAW_LOCAL_AGENT_IDS` on the materializing machine.** `materializeAgent` is leader-only (followers return 405 on `/api/agents/<id>/harness/materialize`). If the leader's `.env` doesn't list `<id>`, the materialize step is correctly skipped and only `harness.synced` fires (no `harness.materialized`). The bot-bridge cache invalidates fine, but no on-disk ptah config is rewritten.

   ```bash
   docker compose exec openclaw printenv OPENCLAW_LOCAL_AGENT_IDS
   docker compose exec openclaw printenv OPENCLAW_LEADER
   # If LEADER=1 and the id is missing from the comma-list, add it and restart.
   ```

### Symptom: materialize failed; persona stuck on old config

`POST /api/agents/<id>/harness/sync` returned 200 and `harness.synced` fired, but `harness.materialized` never arrived OR the next dispatch still uses an old `settings.json`. This means `materializeAgent` threw mid-flight.

There is no `harness.materialize_failed` SSE event in the current daemon — failures surface as a 400 from `POST /api/agents/<id>/harness/materialize` and as a thrown exception inside the Redis-fanout handler in `daemon/src/bus.ts`. Diagnose via the daemon log:

```bash
docker compose exec openclaw grep -E 'materialize|assertMaterializedPathSafety|harness/materialize' \
  /tmp/openclaw-control-daemon.log | tail -30
```

Common failures:

- **`assertMaterializedPathSafety: refusing to write under local-memory`** — the resolved output path landed under `~/.claude/local-memory/`. This is layer 4 of the privacy invariant doing its job (see [SECURITY.md](SECURITY.md#persona-privacy-invariant)). Root cause is almost always a misconfigured `OPENCLAW_HOST_HOME` overlapping with `OPENCLAW_LOCAL_MEMORY` — fix the env, don't bypass the guard.
- **`invalid id` / `invalid filename` from `safeId`/`safeFile`** — the agent id contained characters outside `[A-Za-z0-9_\-.]`. Rename the agent.
- **YAML parse error from `parseHarnessYaml`** — re-PUT a valid YAML body. The validator log line names the offending field.

**Manual retry** once the underlying issue is fixed:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
  "http://localhost:7878/api/agents/<id>/harness/materialize"
# Expect: { agentId, changed, settingsPath, pluginDir }
```

Partial writes from a previous failure live under `~/.ptah/agents/<id>/` and `~/.ptah/plugins/openclaw-<id>-harness/`. The materializer is idempotent — re-running over a partial state converges to the YAML's intent. If you want a clean slate:

```bash
rm -rf "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/agents/<id>"
rm -rf "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/plugins/openclaw-<id>-harness"
# Then POST /harness/materialize again.
```

### Symptom: host/container path mismatch (R5) — `/health.ptahConfigDirExists: false` or ptah can't find its config

The daemon emits absolute host paths (e.g. `/home/anubis/.ptah/agents/horus/settings.json`) and hands them to the host-side ptah-bridge, which spawns ptah with `--config <that path>`. The bind-mount in `docker-compose.yml` is identity-mapped:

```yaml
volumes:
  - ${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:${OPENCLAW_HOST_HOME:-${HOME}}/.ptah:rw
```

so the same path resolves on both sides. When `OPENCLAW_HOST_HOME` is wrong (e.g. set to `/home/agent` because someone copied the container user's home), the bind-mount silently maps the wrong host directory and the materialized files land somewhere ptah doesn't look.

**Diagnose** — three signals, escalating in severity:

```bash
# 1. Bridge-side health surfaces dir existence:
curl -fsS http://host.docker.internal:8744/health \
  | jq '{ptahConfigDirExists, ptahPluginsDirExists, hostUser}'
# Both booleans should be true on a healthy install.

# 2. Container side: confirm the daemon resolves the same path:
docker compose exec openclaw printenv OPENCLAW_HOST_HOME
docker compose exec openclaw ls -la "${OPENCLAW_HOST_HOME:-/home/anubis}/.ptah/agents/" 2>&1

# 3. Host side: confirm ptah-bridge sees the same dir:
ls -la "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/agents/"
```

If `(1)` is `false`, the bind-mount didn't take or the dir was never created. Re-run `entrypoint.sh`'s `mkdir -p` step manually:

```bash
docker compose exec openclaw bash -c \
  'mkdir -p "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/agents" \
            "${OPENCLAW_HOST_HOME:-$HOME}/.ptah/plugins"'
```

If `(2)` and `(3)` show different content for the same path, the bind-mount is mapping the wrong host dir. Fix `.env` (`OPENCLAW_HOST_HOME=/home/<your-actual-host-user>`) and `docker compose up -d` (recreate, not just restart — bind-mounts are baked at create-time).

This was R5 in `.ptah/specs/TASK_2026_002/spike-findings.md` and the bind-mount is its mitigation. The `/health` fields exist specifically so a future `/api/health` aggregator can fail fast on this mismatch instead of letting ptah spawn against a missing config.

---

## Web search, browser, and video generation

### Symptom: web search tool not available or returns "search disabled"

`entrypoint.sh` disables `tools.web.search` when either `WEB_SEARCH_PROVIDER` or `WEB_SEARCH_API_KEY` is unset. Check the rendered config:

```bash
docker compose exec openclaw-gateway cat /home/agent/.openclaw/openclaw.json \
  | jq '.tools.web.search.enabled'
# false → one of the env vars is missing
```

Fix: set both in `.env` and `docker compose up -d`.

```bash
grep 'WEB_SEARCH' .env
# Both lines must be non-empty
```

### Symptom: browser tool fails — "chromium not found" or "no such file"

The Dockerfile installs `chromium` at `/usr/bin/chromium`. If you're running an old image that predates the Chromium addition, rebuild:

```bash
docker compose up -d --build
docker compose exec openclaw-gateway /usr/bin/chromium --version
# Should print the version
```

The template sets `browser.noSandbox: true`. If you've altered this and the container lacks the necessary kernel capabilities, restoring `noSandbox: true` is the fix.

### Symptom: video generation fails — "provider not configured" or empty response

`generate_video` requires `GEMINI_API_KEY`. Check:

```bash
docker compose exec openclaw-gateway printenv GEMINI_API_KEY | wc -c
# 0 → key is missing; add it to .env and docker compose up -d
```

If the key is present but calls still fail, verify the key is valid for the Gemini API (Google AI Studio → API keys). The `mediaGenerationAutoProviderFallback: true` setting means openclaw will try alternative providers before failing, but if no provider has a valid key the call will error.

### Symptom: Canva MCP auth expired — tools return 401 or "not authenticated"

The `mcp-remote` OAuth token cache at `~/.mcp-auth/` on the host has expired. Re-run the one-time auth:

```bash
npx -y mcp-remote@latest https://mcp.canva.com/mcp
# Complete the Canva OAuth flow in the browser, then Ctrl+C.
```

No container restart is needed — the gateway's `mcp-remote` process reads the updated cache. If the MCP server is still failing after re-auth:

```bash
docker compose restart openclaw-gateway
```

To confirm the mount is present:

```bash
docker compose exec openclaw-gateway ls -la /home/agent/.mcp-auth/
# Should list the cached token files
```

If the directory is empty or the mount is missing, check that `${HOME}/.mcp-auth` exists on the host and is bind-mounted in `docker-compose.yml`.

### Symptom: auto-clone fails on first dispatch — "worktree: clone failed"

`setupWorktree()` auto-clones the repo when the workspace path is missing. Common failure causes:

1. **`GITHUB_TOKEN` missing or insufficient** — the token needs at minimum `repo:read` scope. Check `.env`: `grep GITHUB_TOKEN .env`. If it's empty, set it and `docker compose up -d`.
2. **Wrong repo slug in the project record** — check the `projects` table: `docker compose exec openclaw-daemon sqlite3 /data/specs.db "SELECT slug, repo_slug FROM projects;"`. If `repo_slug` is null or malformed, update it via the dashboard or SQL.
3. **Target path not writable** — the daemon runs as uid 1000. Check that `OPENCLAW_PROJECTS_DIR` (default `${HOME}/projects`) is writable by uid 1000 from inside the container.

The dispatch log records the clone attempt:

```bash
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "SELECT ts, level, message FROM dispatch_log
    WHERE dispatch_id='<id>' ORDER BY ts;"
# Look for: [worktree] auto-cloning ... or [worktree] clone failed
```

---

## Last resorts

### Nuclear reset (loses bot memory)

```bash
docker compose down -v                    # destroys named volume
docker rmi openclaw-local:latest          # destroys image
rm -rf ~/projects/memory ~/projects/state # kills bot's session memory
./setup.sh                                # rebuild from scratch
```

This brings you back to first-install state with persona templates re-seeded.

### Total reset (also loses your project work)

```bash
docker compose down -v
docker rmi openclaw-local:latest
rm -rf ~/projects                         # ⚠️ DELETES ALL YOUR PROJECT FILES
./setup.sh
```

Don't run the second `rm` unless you've committed/backed up everything in `~/projects/`.

---

## Getting help

Logs are your friend:

```bash
# All recent
docker compose logs -f --tail 200 openclaw

# Specific subsystems
docker compose logs openclaw 2>&1 | grep -i discord
docker compose logs openclaw 2>&1 | grep "agent/embedded"
docker compose logs openclaw 2>&1 | grep -E "ERROR|FATAL"

# Internal openclaw log file (richer detail than docker logs)
docker compose exec openclaw cat /tmp/openclaw-1000/openclaw-$(date +%Y-%m-%d).log | tail -100
```

For openclaw-specific issues, check upstream: https://github.com/openclaw/openclaw/issues
