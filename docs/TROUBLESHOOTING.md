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
