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
