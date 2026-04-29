# Setup — new-machine bootstrap

Two paths through this doc, sharing the same prereqs:

- **Leader install** (one machine in the fleet) — runs the continuation loop, hosts the public dashboard, owns at least one agent.
- **Follower install** (every other machine) — runs only the dispatch worker, owns its own agents, dashboard stays loopback.

Tested on Linux Mint 22.3 / Ubuntu 24.04. Should work on any systemd-based distro with Docker Engine and the Ollama installer.

If you only want the original single-machine OpenClaw + Ollama + Discord setup with no control plane, set `OPENCLAW_CONTROL_DISABLE=1` in `.env` and stop after Step 5 — everything from Step 6 on is control-plane work.

---

## Prereqs (both paths)

| Requirement | Why |
|---|---|
| Docker Engine ≥ 24 | runs the container |
| Docker Compose plugin v2 | `docker compose` |
| systemd | hosts Ollama |
| `curl`, `openssl`, `jq`, `git` | used by setup.sh + entrypoint |
| `sudo` | only for the Ollama systemd drop-in |
| Internet | model + npm + GitHub |
| ~3 GB disk, ~2 GB RAM free | container + plugin runtime |

If `docker` isn't installed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

---

## Step 1 — Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull kimi-k2.6:cloud      # or any *:cloud / local model
curl http://127.0.0.1:11434/api/version    # smoke test
```

`setup.sh` will add a systemd drop-in to bind Ollama on `0.0.0.0:11434` (so the container can reach it via `host.docker.internal`). It only does that if needed and asks for sudo.

If you have a GPU with ≥16 GB VRAM and prefer offline: `ollama pull qwen3:14b` and set `LLM_MODEL=qwen3:14b` in `.env`. The control plane doesn't care.

---

## Step 2 — Discord OAuth app (leader only, optional but strongly recommended)

The dashboard auths via "Login with Discord". Without OAuth, the daemon falls back to a fake `local-dev` user with no auth — fine for localhost-only, **must not be exposed publicly**.

1. https://discord.com/developers/applications → **New Application** (name it whatever — this is the OAuth app, not the bot).
2. **OAuth2 → General** → copy `Client ID` and `Client Secret` for `.env`.
3. **OAuth2 → Redirects** → add the callback URLs you'll use:
   - `http://localhost:7878/auth/discord/callback` (always, for local-dev)
   - `https://<your-host>.<your-tailnet>.ts.net/auth/discord/callback` (only if exposing via Tailscale Funnel)
4. Note your own Discord user ID (right-click yourself in Discord with Developer Mode on → Copy User ID) — goes in `DISCORD_ALLOWED_USER_IDS`.

---

## Step 3 — Per-agent Discord bot (every machine that owns an agent)

One bot per agent. Each bot has its own application, its own token, and shows up in your guild as its own user.

1. https://discord.com/developers/applications → **New Application** named after the agent (e.g. `anubis`).
2. Sidebar → **Bot** → enable `SERVER MEMBERS INTENT` and `MESSAGE CONTENT INTENT`. **Public Bot** off.
3. **Bot → Reset Token** → copy. This is `DISCORD_TOKEN_<UPPER_AGENT_ID>` in `.env` (e.g. `DISCORD_TOKEN_ANUBIS`).
4. **OAuth2 → URL Generator** → scopes: `bot`. Bot permissions: `View Channels`, `Send Messages`, `Read Message History`. Open the generated URL → invite to your server.

Repeat for each agent (anubis on the leader, amun on Amun's machine, etc.).

---

## Step 4 — Shared specs repo (leader only — done once for the whole fleet)

1. On GitHub: create a **private** repo named e.g. `<you>/openclaw-specs`. Empty is fine; the daemon initializes it on first boot.
2. Create a fine-grained PAT with `repo` scope on this one repo: https://github.com/settings/tokens?type=beta. Save it for `.env`.
3. Every follower will use the **same** repo URL and **its own** PAT (or the same PAT — it just needs push access).

You can do this later — `OPENCLAW_SPECS_REPO_URL` empty is fine for single-machine local-only mode. Adding the URL later just turns sync on.

---

## Step 5 — Provision (leader)

```bash
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw

./scripts/provision-machine.sh \
    --agent anubis \
    --role leader \
    --repo https://github.com/<you>/openclaw-specs
```

The script verifies prereqs, sets the leader/agent flags in `.env`, and hands off to `setup.sh` which (idempotently):

1. Verifies Docker / Compose / Ollama
2. Writes the Ollama systemd drop-in if needed
3. `cp .env.example .env` if absent + chmod 600
4. Generates `OPENCLAW_AUTH_TOKEN`
5. Creates `${WORKSPACE_DIR}` and seeds it with persona templates
6. Asks if this machine is leader / follower (already answered by provision script)
7. Asks for `OPENCLAW_LOCAL_AGENT_IDS` (already filled)
8. Asks for `OPENCLAW_SPECS_REPO_URL` and the PAT (already filled if `--repo` passed; PAT is still prompted interactively)
9. Generates `OPENCLAW_JWT_SECRET` and `OPENCLAW_INTERNAL_TOKEN`
10. Scaffolds `~/.claude/local-memory/agents/<id>/persona.md` from `templates/agent-persona.md.tmpl`
11. Builds the image
12. `docker compose up -d`

---

## Step 5' — Provision (follower)

```bash
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw

./scripts/provision-machine.sh \
    --agent amun \
    --role follower \
    --repo https://github.com/<you>/openclaw-specs
```

Same script, different flags. Set `--agent` to the id this follower owns. Same specs repo URL.

A few extra rules for followers:

- `OPENCLAW_LOCAL_AGENT_IDS` should be **disjoint** from the leader's. (`anubis` runs only on the leader; `amun` only on Amun.)
- The follower's dashboard binds to `127.0.0.1:7878` and stays there. No Tailscale Funnel.
- The follower's `DISCORD_CLIENT_ID/SECRET` can be left empty — only the leader's dashboard is the user-facing one. The follower's local dashboard works in `local-dev` fallback mode for debugging.

---

## Step 6 — Edit the `.env` secrets the script can't generate

Open `.env`. Required values to fill in (skip a section if it's already filled by an earlier step):

```bash
# Inference (or your provider's equivalent)
LLM_PROVIDER=ollama
LLM_MODEL=kimi-k2.6:cloud

# Specs repo PAT (leader + every follower)
OPENCLAW_GIT_TOKEN=ghp_...

# Discord OAuth (leader only — leave empty on followers if you don't need their dashboards public)
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=http://localhost:7878/auth/discord/callback   # change after Tailscale step
DISCORD_ALLOWED_USER_IDS=<your_discord_user_id>

# This machine's bot token (one per agent it owns)
DISCORD_TOKEN_ANUBIS=...    # or DISCORD_TOKEN_AMUN, etc.
```

Apply changes:

```bash
./scripts/dc.sh compose up -d
```

(`compose up -d` re-reads `.env` without rebuilding. Use `up -d --build` if you also changed code.)

---

## Step 7 — Edit the agent persona

The bot won't be useful — and on a strict reading of the bot-bridge, won't even register — until the agent has a persona. The scaffold is full of placeholders.

```bash
$EDITOR ~/.claude/local-memory/agents/anubis/persona.md   # or whichever id is yours
```

Fill in name, role, voice, scope, do, don't. This file is **never** committed to the specs repo; it lives only on this machine. See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for guidance.

The bot-bridge re-reads the persona on every message, so no restart is needed.

---

## Step 8 — Verify

### Daemon

```bash
curl -fsS http://127.0.0.1:7878/api/health
# => {"ok":true,...}
```

### Dashboard

Open `http://127.0.0.1:7878` in a browser on the same host. If `DISCORD_CLIENT_ID` is set, you'll be redirected to Discord; if your user ID is in the allowlist, you land back on the dashboard. If `DISCORD_CLIENT_ID` is empty, you're auto-logged-in as `local-dev`.

### Bot-bridge

```bash
./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log
# Look for: "[bot-bridge] agent <id> logged in as <bot-name>#NNNN"
```

Then in your Discord guild:

```
@anubis hello
```

The bot should reply within ~10s (cloud model latency).

### Specs repo sync

```bash
ls ~/.claude/shared-specs/
# .git/  .gitignore  specs/  memory/

git -C ~/.claude/shared-specs log --oneline -5
# Should show recent commits if anything's been written.
```

If the daemon failed to clone, you'll see it in:

```bash
./scripts/dc.sh compose exec openclaw tail /tmp/openclaw-control-daemon.log | grep '\[git-sync\]'
```

---

## Step 9 — Expose the leader's dashboard publicly (optional, leader only)

The simplest path is Tailscale Funnel:

```bash
sudo tailscale up --ssh
sudo tailscale funnel --bg --https=443 7878
# → https://<host>.<tailnet>.ts.net is now reachable from anywhere
```

After Funnel is up:

1. Add `https://<host>.<tailnet>.ts.net/auth/discord/callback` to your Discord OAuth app's Redirects.
2. Update `DISCORD_REDIRECT_URI` in `.env` to that URL.
3. `./scripts/dc.sh compose up -d` to apply.
4. Visit the public URL from your phone. Login with Discord. Your user ID had better be in `DISCORD_ALLOWED_USER_IDS` or you'll get a 403.

If you don't want Tailscale, anything that does TLS termination + reverse proxy to `127.0.0.1:7878` works (Caddy, Traefik, Cloudflare Tunnel). Update the redirect URI to match.

---

## Step 10 — Updating later

After pulling new commits or editing `skills/`:

```bash
./scripts/update-machine.sh
```

That runs `git pull --ff-only && ./scripts/dc.sh compose up -d --build` and waits for `/api/health` to respond.

After editing only `.env`:

```bash
./scripts/dc.sh compose up -d
```

After editing only persona / shared-memory: nothing to restart. The daemon re-reads files on every request.

---

## Step 11 — Migrating between machines

A Discord bot token can only be used by one running instance at a time. Two options:

**Move (replace machine A with machine B).** Stop A's container; copy `~/.claude/local-memory/agents/<id>/persona.md` to B (scp, password manager); on B run `provision-machine.sh` with the same `--agent` id. The specs repo is unchanged — B will pull and pick up where A left off.

**Run on both A and B with different agents.** Create a second Discord bot in the Developer Portal. Each machine sets its own `OPENCLAW_LOCAL_AGENT_IDS` and its own `DISCORD_TOKEN_<id>`. They appear as two separate users in your guild and own different work.

---

## Common pitfalls on first install

| Symptom | Cause | Fix |
|---|---|---|
| `setup.sh: ollama not responding on :11434` | Ollama service not started | `sudo systemctl start ollama` |
| Container is `(unhealthy)` for >2 min | First-run plugin install slow | Wait — total ~2-3 min on a fresh image |
| `[entrypoint] WARNING: cannot reach OLLAMA_BASE_URL` | systemd override didn't apply | `sudo systemctl daemon-reload && sudo systemctl restart ollama` |
| Daemon starts, no `[git-sync]` clone log | `OPENCLAW_SPECS_REPO_URL` empty | Set it (or accept local-only mode) |
| `[git-sync] pull failed: not allowed to push` | `OPENCLAW_GIT_TOKEN` missing/invalid scope | Issue a PAT with `repo` scope; update `.env`; restart |
| `[bot-bridge] agent "<id>" has no local persona — skipping` | Persona file missing | Re-run `setup.sh` (it scaffolds it) or copy from another machine |
| `403` on dashboard from a phone | User ID not in `DISCORD_ALLOWED_USER_IDS` or guild not in `DISCORD_ALLOWED_GUILD_ID` | Add it; restart |
| `503 discord oauth not configured` | `DISCORD_CLIENT_ID` empty | Either set it or stop trying to expose publicly |
| Two leaders racing in git | Both machines have `OPENCLAW_LEADER=1` | Pick one; flip the other to `0` |
| Discord token leaked | Pasted in chat / committed `.env` | Regenerate the token in Developer Portal; update `.env`; restart |

Full table: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## What's NOT in this setup

- **Ptah CLI auth** — handled by `setup.sh` / `entrypoint.sh` via the bind-mounted `~/.ptah`. If `ptah` works on your host, the agent can use it. See the original gateway-era walkthrough at the bottom of [CONFIGURATION.md](CONFIGURATION.md) for details.
- **Skills** — the gateway tier supports `~/Desktop/fixing-openclaw/skills/` (bind-mounted). The control plane uses ptah-cli's own skill system. They coexist.
- **Webhooks / inbound integrations** — the daemon doesn't accept inbound webhooks. Add a route in `daemon/src/api.ts` if you want one.
