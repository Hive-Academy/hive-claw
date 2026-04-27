# Setup — new machine bootstrap

End-to-end instructions to get the bot running on a fresh Linux machine. Tested on Linux Mint 22.3 / Ubuntu 24.04. Should work on any systemd-based distro that runs Docker Engine and the Ollama installer script.

---

## Prerequisites

| Requirement | Why | How to check |
|---|---|---|
| Docker Engine ≥ 24 | runs the agent container | `docker --version` |
| Docker Compose plugin v2 | orchestrates the service | `docker compose version` |
| systemd | hosts the Ollama service | `systemctl --version` |
| `curl`, `openssl`, `jq` | used by setup.sh and entrypoint | `which curl openssl jq` |
| `sudo` access | only used to write the Ollama systemd drop-in | — |
| Internet | downloads model + npm plugin deps | — |
| ~2 GB free RAM and ~3 GB disk | container + plugin runtime deps | `free -h && df -h` |

If `docker` isn't installed:

```bash
# Ubuntu/Debian/Mint
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker          # or log out and back in
```

---

## Step 1 — Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

This installs Ollama as a systemd service at `/etc/systemd/system/ollama.service` and starts it on `127.0.0.1:11434` by default. `setup.sh` will later add a drop-in override to bind it to all interfaces so the container can reach it.

Pull at least one model. For CPU-only machines, **cloud-routed models are the only practical option**:

```bash
ollama pull kimi-k2.6:cloud         # 1T-param reasoning model, free tier OK for personal use
# or any other model, e.g.:
# ollama pull qwen3.5:cloud
# ollama pull glm-4.7-flash
```

If you have a GPU with ≥16 GB VRAM, you can pull a local model instead and skip the cloud round-trip entirely:

```bash
ollama pull qwen3:14b               # ~9 GB VRAM, runs locally
```

Verify Ollama responds:

```bash
curl http://127.0.0.1:11434/api/version
# => {"version":"0.x.x"}
```

---

## Step 2 — Create the Discord bot

Skip this step if you already have a bot you want to reuse.

1. Go to https://discord.com/developers/applications → **New Application**.
2. Name it (e.g. `anubis-bot`). Save.
3. Left sidebar → **Bot**.
4. **Privileged Gateway Intents** → enable:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
5. **Build-A-Bot** → **Reset Token** → copy the token (you'll only see it once).
6. **Public Bot** → toggle **off** (unless you want anyone able to invite the bot).
7. Left sidebar → **OAuth2** → **URL Generator**:
   - Scopes: `bot` + `applications.commands`
   - Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`
   - Copy the generated URL, paste in browser, pick your server, **Authorize**.
8. Get your **Server ID**: in Discord, enable Developer Mode (Settings → Advanced → Developer Mode), right-click your server name → Copy Server ID.

You'll need both the **bot token** and the **server ID** for `.env` in the next step.

---

## Step 3 — Clone and configure

```bash
git clone <this-repo> ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw

cp .env.example .env
chmod 600 .env
nano .env
```

Fill in the secrets — minimum required:

```bash
DISCORD_BOT_TOKEN=<paste-bot-token-here>
DISCORD_GUILD_ID=<paste-server-id-here>

# These have sane defaults but you can override:
# OLLAMA_MODEL=kimi-k2.6:cloud
# WORKSPACE_DIR=${HOME}/projects
# SKILLS_DIR=./skills
```

Leave `OPENCLAW_AUTH_TOKEN` empty — `setup.sh` generates it automatically on first run.

> **Security tip:** `.env` is gitignored and `chmod 600`. Don't paste the bot token into chat windows, screenshots, or commit history. If it leaks, regenerate it in the Developer Portal and update `.env`.

---

## Step 4 — Run setup.sh

```bash
./setup.sh
```

It runs seven phases:

1. **Host preflight** — checks docker, docker compose, curl, openssl, ollama.
2. **Ollama systemd override** — if Ollama is loopback-only, writes `/etc/systemd/system/ollama.service.d/override.conf` (asks for sudo) so the container can reach it via `host.docker.internal:11434`.
3. **`.env` finalize** — generates `OPENCLAW_AUTH_TOKEN` if absent.
4. **Workspace folder** — creates `${WORKSPACE_DIR}` (default `~/projects/`) if missing. Seeds it with persona templates (`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`) if empty.
5. **Skills** — ensures `skills/` and `commands/` directories exist.
6. **Image build** — `docker compose build` (~2 min on first run, cached afterwards).
7. **Container start** — `docker compose up -d`. Prints the dashboard URL with token.

Plugin install on first run takes another ~90 seconds (downloads npm deps for openclaw's bundled plugins). Watch:

```bash
docker compose logs -f openclaw
```

You're ready when you see:

```
[gateway] ready (6 plugins: acpx, browser, device-pair, discord, phone-control, talk-voice; ...)
```

---

## Step 5 — Verify

### Dashboard

Open the URL from `setup.sh`'s final output, or get it manually:

```bash
echo "http://127.0.0.1:18789/?token=$(grep OPENCLAW_AUTH_TOKEN .env | cut -d= -f2)"
```

You should see OpenClaw's web UI. Type a message in the chat. The bot should reply within ~10 seconds (cloud model latency).

### Discord

Wait ~3 minutes after `[gateway] ready` for the Discord channel sidecar to fully connect (you'll see `[discord] logged in to discord as <bot-name>` in logs).

In your Discord server, mention the bot in a public channel:

```
@anubis-bot hello
```

A 👀 reaction appears (working on it), then the bot replies.

### TUI

Direct chat from the host:

```bash
docker compose exec -it openclaw openclaw tui
```

---

## Step 6 — First-time configuration

After verifying the bot works, you'll likely want to:

1. **Personalize `~/projects/USER.md`** — fill in your name, timezone, what you're working on.
2. **Customize `~/projects/IDENTITY.md`** — give the bot a name and vibe that fits you. The seed file ships with placeholder fields; the bot will ask you to fill them in on first chat (driven by `BOOTSTRAP.md`), or you can edit the file directly.
3. **Initialize your first project**:
   ```bash
   cd ~/projects
   git clone <some-repo> myapp
   ~/Desktop/fixing-openclaw/bin/openclaw-init-project.sh myapp
   nano ~/projects/myapp/.openclaw/persona.md   # edit project-specific persona
   ```
4. **Test cross-project memory** — mention the bot, ask it to summarize what's in `~/projects/myapp/`. It should respond using the persona override you set.

---

## Step 7 — Ptah CLI (project orchestration + GitHub auth)

The container ships with [`@hive-academy/ptah-cli`](https://www.npmjs.com/package/@hive-academy/ptah-cli) preinstalled. Its config dir `~/.ptah` is **bind-mounted from the host**, so a single auth login covers both the agent inside the container and your shell on the host.

### One-time GitHub auth

Pick whichever side is convenient — both write the same `~/.ptah/settings.json`:

```bash
# Option A — interactive OAuth on the host (recommended):
ptah auth login github

# Option B — inside the container:
docker compose exec openclaw ptah auth login github

# Option C — drop a token into .env and let entrypoint.sh seed it on first boot:
# (only seeds if no existing auth is detected — never clobbers an interactive login)
echo 'GITHUB_TOKEN=ghp_xxx' >> .env
docker compose up -d --force-recreate
```

Verify with:

```bash
docker compose exec openclaw ptah auth test --provider github
```

### Discover existing projects

```bash
docker compose exec openclaw ptah harness scan
```

This emits JSON describing every project under `$WORKSPACE_DIR` plus the agents and skills available there. The bot will use this automatically when you ask "what projects do I have?".

### Scaffold a new project (Ptah wizard + OpenClaw overlay in one shot)

```bash
~/Desktop/fixing-openclaw/bin/openclaw-init-project.sh --with-ptah myapp
```

This:
1. Runs `ptah new-project select-type` inside the container (interactive).
2. Lays down the `.openclaw/` overlay (persona, HEARTBEAT, project skills).

After the wizard prompts, finish the plan with:

```bash
docker compose exec -w /home/agent/.openclaw/workspace/myapp openclaw \
    ptah new-project submit-answers --file answers.json
docker compose exec -w /home/agent/.openclaw/workspace/myapp openclaw \
    ptah new-project get-plan
docker compose exec -w /home/agent/.openclaw/workspace/myapp openclaw \
    ptah new-project approve-plan
```

> **Security note:** `~/.ptah/settings.json` holds your auth tokens. The bind mount means a token leak on either side compromises both. Don't commit that file or paste its contents anywhere.

---

## Common pitfalls on first install

| Symptom | Likely cause | Fix |
|---|---|---|
| `setup.sh: ollama not responding on :11434` | Ollama service not started | `sudo systemctl start ollama` |
| Container is `(unhealthy)` after 2 min | Plugin install slow on first run | Wait — it can take 2–3 min total before HTTP server binds |
| `[entrypoint] WARNING: cannot reach ${OLLAMA_BASE_URL}` | systemd override didn't apply | `sudo systemctl daemon-reload && sudo systemctl restart ollama` |
| Bot in Discord but doesn't reply to mentions | Probably the `accessGroups` issue or wrong guild | Check `docs/TROUBLESHOOTING.md` |
| Discord token leaked | You typed it in chat or committed `.env` | Regenerate in Developer Portal, update `.env`, restart |

Full troubleshooting guide: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Updating later

After pulling new commits or editing `skills/`:

```bash
cd ~/Desktop/fixing-openclaw
git pull
docker compose up -d --build       # rebuilds image if Dockerfile/entrypoint changed
                                   # bind-mounts pick up skills/commands changes without rebuild
```

After editing `.env`:

```bash
docker compose up -d --force-recreate
```

After editing `templates/workspace-seed/` and you want a clean reset:

```bash
docker compose down
rm -rf ~/projects/*               # ⚠️ destroys all bot memory + project work
./setup.sh                        # re-seeds from templates
```

---

## Migrating between machines

A Discord bot token can only be used by one running instance at a time.

**Move (replace machine A with machine B):**

```bash
# On machine A
docker compose down
# (optionally tar ~/projects/ and copy to machine B if you want to preserve memory)

# On machine B
git clone <repo>
# (extract ~/projects.tar.gz if you brought it)
cp .env.example .env  # set the same DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
./setup.sh
```

**Run on both A and B simultaneously:** create a second Discord application + bot in the Developer Portal. Each machine uses its own bot token. They appear as two separate users in your guild.
