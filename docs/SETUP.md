# Setup — new-machine bootstrap

One linear flow. Same script on every host. Differs only in a couple of `.env` lines per role.

- **Leader** — exactly one machine in the fleet. Owns `/data/specs.db`, runs the continuation loop, hosts the user-facing dashboard.
- **Followers** — every other machine. HTTP-only clients of the leader. Run only the dispatch worker for their own local agents.

Tested on Linux Mint 22.3 / Ubuntu 24.04. Should work on any systemd-based distro with Docker Engine and the Ollama installer.

If you only want the original single-machine OpenClaw + Ollama + Discord setup with no control plane, set `OPENCLAW_CONTROL_DISABLE=1` in `.env` and stop after the prereq + image-build steps — everything below is control-plane work.

---

## Prereqs (every host)

| Requirement | Why |
|---|---|
| Docker Engine ≥ 24 | runs the containers |
| Docker Compose plugin v2 | `docker compose` |
| systemd | hosts Ollama (and the optional ptah-bridge user service) |
| `curl`, `openssl`, `jq` | used by setup.sh + entrypoint |
| `sudo` | only for the Ollama systemd drop-in |
| Internet | model + npm + Discord |
| ~3 GB disk, ~2 GB RAM free | container + plugin runtime |

If `docker` isn't installed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

**Find your docker GID** (needed in `.env` for the daemon):

```bash
stat -c '%g' /var/run/docker.sock
# → 985 (Debian/Ubuntu) or 999 (some distros)
```

---

## Step 1 — Ollama (every host that runs an agent)

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

The fleet currently has three active agents. Create one bot per agent on whichever machine owns it:

| Agent | Env var | Role | Notes |
|---|---|---|---|
| `anubis` | `DISCORD_TOKEN_ANUBIS` | Orchestrator / infra | Typically runs on the leader machine |
| `horus` | `DISCORD_TOKEN_HORUS` | General-purpose assistant | Any follower machine |
| `chappie` | `DISCORD_TOKEN_CHAPPIE` | Social media / content publisher | Needs `ZERNIO_API_KEY` on its machine |

Repeat the four steps above for each bot you plan to run on this machine. Machines that don't host an agent leave its token empty — openclaw logs a sign-in failure for the empty token but the other personas are unaffected.

---

## Step 4 — The four-step provision (every host)

The same four steps run on every host. The only thing that changes between leader and followers is a few `.env` lines.

### 4a. Clone the repo and copy the env template

```bash
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw
cp .env.example .env
chmod 600 .env
```

### 4b. Edit `.env` — leader vs follower

Open `.env` in your editor. The deltas you must set:

**On the leader (exactly one machine):**

```bash
OPENCLAW_LEADER=1
OPENCLAW_LOCAL_AGENT_IDS=anubis              # or whichever agent(s) this host owns
OPENCLAW_SPECS_DB_PATH=/data/specs.db        # default; rarely changed
DISCORD_TOKEN_ANUBIS=...                     # one per local agent
DOCKER_GID=985                               # from `stat -c '%g' /var/run/docker.sock`
GEMINI_API_KEY=...                           # for Veo video generation (optional)
WEB_SEARCH_PROVIDER=tavily                   # optional; leave blank to disable web search
WEB_SEARCH_API_KEY=...                       # required when WEB_SEARCH_PROVIDER is set
```

`setup.sh` will auto-generate `OPENCLAW_JWT_SECRET` and `OPENCLAW_INTERNAL_TOKEN` if you leave them empty. Note the generated `OPENCLAW_INTERNAL_TOKEN` value — you'll need to copy it to every follower's `.env`.

**On every follower:**

```bash
OPENCLAW_LEADER=0
OPENCLAW_LEADER_URL=https://leader.tailnet.ts.net    # or http://leader.lan:7878
OPENCLAW_LOCAL_AGENT_IDS=horus                       # disjoint from the leader's
OPENCLAW_INTERNAL_TOKEN=<paste the leader's value>   # MUST match
DISCORD_TOKEN_HORUS=...                              # one per local agent
DOCKER_GID=985                                       # same check as leader
# Chappie-specific (only on the machine that hosts chappie):
DISCORD_TOKEN_CHAPPIE=...
ZERNIO_API_KEY=...
```

If `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL` is empty, the daemon refuses to start (config-load hard-fail at `daemon/src/config.ts`).

Followers do not need `DISCORD_CLIENT_ID/SECRET` — only the leader's dashboard is the user-facing one. Their loopback dashboard works in `local-dev` fallback for debugging.

### 4c. Run `setup.sh` (or `docker compose up -d` directly)

```bash
./setup.sh
```

The script (idempotently):

1. Verifies Docker / Compose / Ollama.
2. Writes the Ollama systemd drop-in if needed.
3. Generates `OPENCLAW_AUTH_TOKEN`, `OPENCLAW_JWT_SECRET`, `OPENCLAW_INTERNAL_TOKEN` if any are empty.
4. Asks for `OPENCLAW_LEADER` if missing; asks for `OPENCLAW_LEADER_URL` if you said follower.
5. Asks for `OPENCLAW_LOCAL_AGENT_IDS`.
6. Scaffolds `~/.claude/local-memory/agents/<id>/persona.md` from `templates/agent-persona.md.tmpl` for each id.
7. Builds the image and runs `docker compose up -d`.
8. Installs the optional host-side `ptah-bridge` systemd user service.

If you'd rather skip the prompts and go straight to compose:

```bash
docker compose up -d
```

…after editing `.env` by hand. The first boot of the leader's container creates `/data/specs.db` automatically (the `entrypoint-control.sh` runs the schema migrations idempotently on every boot).

### 4d. Migrating from the git-era only — run `cutover.sh` once on the leader

Skip this step if this is a fresh install with no prior git-cloned spec tree under `~/.claude/`. Otherwise:

```bash
cd ~/Desktop/fixing-openclaw
./scripts/cutover.sh
```

The script prompts for explicit `YES` confirmation, then:

1. Stops the container stack.
2. Removes the legacy git clone under `~/.claude/` (if present).
3. Drops the legacy named docker volume `openclaw_specs-db` (idempotent).
4. Clears any leftover `.invoker/` debug-log directories under `WORKSPACE_DIR`.
5. Rebuilds + starts the new image.
6. Probes `http://127.0.0.1:7878/api/health` to confirm the leader came up cleanly.

This is destructive: in-flight tasks are lost. The user accepted this trade as part of TASK_2026_001.

---

## Step 5 — Edit the agent persona and provision agent files

The bot won't be useful — and on a strict reading of the bot-bridge, won't even register — until the agent has a persona. The scaffold is full of placeholders.

```bash
$EDITOR ~/.claude/local-memory/agents/anubis/persona.md   # or whichever id is yours
```

Fill in name, role, voice, scope, do, don't. **This file is never sent over HTTP and is never written to the leader's DB.** It lives only on this machine. See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for guidance.

The bot-bridge re-reads the persona on every message, so no restart is needed.

On every boot, the gateway's entrypoint copies `local-memory/agents/<id>/persona.md` into `<workspace>/<id>/IDENTITY.md` so openclaw's context-file loader picks it up. This means:

- Your persona edits take effect on the next message (bot-bridge) **and** on the next container restart (gateway context files).
- The workspace copy is re-materialized from the local-memory source on every boot — edit the source, not the workspace copy.

### Setting up Horus

On the machine hosting Horus:

```bash
mkdir -p ~/.claude/local-memory/agents/horus
cp templates/agent-persona.md.tmpl ~/.claude/local-memory/agents/horus/persona.md
$EDITOR ~/.claude/local-memory/agents/horus/persona.md
```

Horus's public `identity.md` is seeded at `shared-specs/memory/agents/horus/identity.md` and is served to all machines via the leader's API. The `harness.yaml` at `shared-specs/memory/agents/horus/harness.yaml` configures Horus's chat tier and orchestration tier.

### Setting up Chappie

On the machine hosting Chappie:

```bash
mkdir -p ~/.claude/local-memory/agents/chappie
cp templates/agent-persona.md.tmpl ~/.claude/local-memory/agents/chappie/persona.md
$EDITOR ~/.claude/local-memory/agents/chappie/persona.md
```

Chappie also requires `ZERNIO_API_KEY` in `.env` for the social media publishing tools. The public identity and harness are already seeded at `shared-specs/memory/agents/chappie/`.

### Canva MCP one-time OAuth (gateway machine)

The Canva MCP server uses browser OAuth rather than an API key. Run this **on the host machine** (where the gateway container runs) before starting the stack:

```bash
npx -y mcp-remote@latest https://mcp.canva.com/mcp
```

Complete the OAuth flow in the browser that opens, then Ctrl+C. Tokens land in `~/.mcp-auth/` which is bind-mounted into the gateway container at `/home/agent/.mcp-auth`. The `mcp-remote` process inside the container picks them up automatically and refreshes them on expiry. No env var is needed.

If you're running multiple machines, repeat this step on each machine that hosts the gateway container.

### Web search API key

To enable the `web_search` tool, set both variables in `.env`:

```bash
WEB_SEARCH_PROVIDER=tavily        # or brave, perplexity, exa, duckduckgo, searxng
WEB_SEARCH_API_KEY=<your key>
```

Leave either variable empty to disable web search. The `web_fetch` (URL fetching) and `browser` (headless Chromium) tools are always on regardless.

### Gemini API key for video generation

All three agents have the `generate_video` tool available via Google Veo. To enable it, add the key to `.env`:

```bash
GEMINI_API_KEY=<your key from Google AI Studio>
```

The key is auto-detected from the container environment by openclaw. No other config is needed. The default model is `veo-3.1-fast-generate-preview`.

---

## Step 6 — Verify

### Gateway

```bash
docker compose ps
# → openclaw-gateway   healthy
# → openclaw-daemon    healthy
# → openclaw-redis     healthy
```

### Daemon

```bash
curl -fsS http://127.0.0.1:7878/api/health
# => {"ok":true,...}
```

### Dashboard

Open `http://127.0.0.1:7878` in a browser on the same host. If `DISCORD_CLIENT_ID` is set, you'll be redirected to Discord; if your user ID is in the allowlist, you land back on the dashboard. If `DISCORD_CLIENT_ID` is empty, you're auto-logged-in as `local-dev`.

### Bot-bridge

```bash
docker compose logs -f openclaw-daemon | grep bot-bridge
# Look for: "[bot-bridge] agent <id> logged in as <bot-name>#NNNN"
```

Then in your Discord guild:

```
@anubis hello
```

The bot should reply within ~10s (cloud model latency).

### Leader spec DB

```bash
docker compose exec openclaw-daemon sqlite3 /data/specs.db ".tables"
# Should print: dispatch_log  dispatches  memory_files  projects  schema_version  task_files  tasks
```

If you'd like to peek at open dispatches, see `docs/OPERATIONS.md`.

### Follower → leader handshake

On a follower:

```bash
docker compose exec openclaw-daemon curl -fsS \
    -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN" \
    "$OPENCLAW_LEADER_URL/api/health"
# Should return {"ok":true,...}
```

If you get `401`, the follower's `OPENCLAW_INTERNAL_TOKEN` doesn't match the leader's. If you get a connection error, the leader isn't reachable from this host (Tailscale not up, port not exposed, firewall, etc.).

---

## Step 7 — Expose the leader's dashboard publicly (optional, leader only)

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

If you don't want Tailscale, anything that does TLS termination + reverse proxy to `127.0.0.1:7878` works (Caddy, Traefik, Cloudflare Tunnel). Update the redirect URI to match. Followers' `OPENCLAW_LEADER_URL` should point at this public URL.

---

## Step 8 — Updating later

After pulling new commits or editing `skills/`:

```bash
./scripts/update-machine.sh
```

That runs `git pull --ff-only && ./scripts/dc.sh compose up -d --build` and waits for `/api/health` to respond. The leader's schema migrations are idempotent — they re-run on every boot and are no-ops if the schema is already at `CURRENT_VERSION`.

After editing only `.env`:

```bash
docker compose up -d
```

After editing only persona / shared-memory: nothing to restart. The daemon re-reads files on every request. The gateway re-materializes persona → workspace on its next boot.

---

## Step 9 — Migrating between machines

A Discord bot token can only be used by one running instance at a time. Two options:

**Move (replace machine A with machine B).** Stop A's container; copy `~/.claude/local-memory/agents/<id>/persona.md` to B (scp, password manager); on B follow the four-step provision with the same agent id in `OPENCLAW_LOCAL_AGENT_IDS`. The leader's DB is unchanged — B will start picking up dispatches addressed to that agent on its first SSE connect.

**Run on both A and B with different agents.** Create a second Discord bot in the Developer Portal. Each machine sets its own `OPENCLAW_LOCAL_AGENT_IDS` and its own `DISCORD_TOKEN_<id>`. They appear as two separate users in your guild and own different work.

---

## Common pitfalls on first install

| Symptom | Cause | Fix |
|---|---|---|
| `setup.sh: ollama not responding on :11434` | Ollama service not started | `sudo systemctl start ollama` |
| Container is `(unhealthy)` for >2 min | First-run plugin install slow | Wait — total ~2-3 min on a fresh image |
| `[entrypoint] WARNING: cannot reach OLLAMA_BASE_URL` | systemd override didn't apply | `sudo systemctl daemon-reload && sudo systemctl restart ollama` |
| Daemon throws at boot: `Followers MUST set OPENCLAW_LEADER_URL` | `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL` empty | Set the leader's URL in `.env` |
| Follower hits `401` calling the leader | `OPENCLAW_INTERNAL_TOKEN` mismatch | Copy the leader's value into the follower's `.env`; restart |
| `[control] FATAL: db migration failed` | Bind-mount perms on `/data` (must be owned by uid 1000) | `docker volume rm openclaw_specs-db` then bring up; let entrypoint recreate |
| `[bot-bridge] agent "<id>" has no local persona — skipping` | Persona file missing | Re-run `setup.sh` (it scaffolds it) or copy from another machine |
| `403` on dashboard from a phone | User ID not in `DISCORD_ALLOWED_USER_IDS` or guild not in `DISCORD_ALLOWED_GUILD_ID` | Add it; restart |
| `503 discord oauth not configured` | `DISCORD_CLIENT_ID` empty | Either set it or stop trying to expose publicly |
| Two leaders racing | Both machines have `OPENCLAW_LEADER=1` | Pick one; flip the other to `0` |
| Discord token leaked | Pasted in chat / committed `.env` | Regenerate the token in Developer Portal; update `.env`; restart |
| Daemon can't restart gateway after plugin install | `DOCKER_GID` wrong or missing | Run `stat -c '%g' /var/run/docker.sock` and set `DOCKER_GID` in `.env` |
| Gateway logs `EACCES: permission denied, mkdir /home/agent/.openclaw/workspace/<id>` | First boot on fresh volume | Already fixed — `entrypoint.sh` auto-creates per-agent workspace dirs. If you see this on an old volume: `docker exec --user root openclaw-gateway chown -R agent:agent /home/agent/.openclaw/workspace` |

Full table: [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Daily ops recipes: [OPERATIONS.md](OPERATIONS.md).

---

## What's NOT in this setup

- **Ptah CLI auth** — handled by `setup.sh` / `entrypoint.sh` via the bind-mounted `~/.ptah`. If `ptah` works on your host, the agent can use it. See the original gateway-era walkthrough at the bottom of [CONFIGURATION.md](CONFIGURATION.md) for details.
- **Skills** — the gateway tier supports `~/Desktop/fixing-openclaw/skills/` (bind-mounted). The control plane uses ptah-cli's own skill system. They coexist.
- **Webhooks / inbound integrations** — the daemon doesn't accept inbound webhooks. Add a route in `daemon/src/api.ts` if you want one.
- **Backfill / live migration from a git-era specs repo** — out of scope; the cutover is destructive by design. See `scripts/cutover.sh` and the implementation-plan §16 non-goals.
