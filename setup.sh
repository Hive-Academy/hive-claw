#!/usr/bin/env bash
# setup.sh — bootstrap the OpenClaw + Ollama + Discord stack on any Ubuntu/Debian machine.
# Idempotent: safe to re-run after edits to .env or repo updates.

set -euo pipefail

cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36mi\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

bold "[1/7] Host preflight"
command -v docker >/dev/null || fail "docker not found — install Docker Engine first"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not available"
ok "docker compose $(docker compose version --short)"
command -v curl >/dev/null || fail "curl not found"
command -v openssl >/dev/null || fail "openssl not found"

if command -v ollama >/dev/null 2>&1; then
    ok "ollama installed ($(ollama --version 2>&1 | head -1))"
else
    warn "ollama not found"
    info "install with: curl -fsSL https://ollama.com/install.sh | sh"
    info "then re-run this script"
    exit 1
fi

bold "[2/7] Ollama systemd override (so the container can reach it)"
if curl -fsS --max-time 3 http://127.0.0.1:11434/api/version >/dev/null; then
    ok "ollama responding on :11434"
else
    fail "ollama not responding — start it: sudo systemctl start ollama"
fi

if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*):11434$'; then
    ok "ollama already listening on all interfaces"
else
    warn "ollama is loopback-only — fixing now (needs sudo)"
    sudo mkdir -p /etc/systemd/system/ollama.service.d
    sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
    sudo systemctl daemon-reload
    sudo systemctl restart ollama
    sleep 2
    if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*):11434$'; then
        ok "ollama now listening on 0.0.0.0:11434"
    else
        fail "ollama still loopback-only after restart — check /etc/systemd/system/ollama.service.d/override.conf"
    fi
fi

bold "[3/7] .env"
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    info ".env created from .env.example — edit it to set DISCORD_BOT_TOKEN/DISCORD_GUILD_ID before talking to the bot"
else
    ok ".env exists"
fi

if ! grep -qE '^OPENCLAW_AUTH_TOKEN=.+$' .env; then
    TOKEN="$(openssl rand -hex 32)"
    if grep -qE '^OPENCLAW_AUTH_TOKEN=' .env; then
        sed -i "s|^OPENCLAW_AUTH_TOKEN=.*|OPENCLAW_AUTH_TOKEN=${TOKEN}|" .env
    else
        echo "OPENCLAW_AUTH_TOKEN=${TOKEN}" >> .env
    fi
    ok "generated OPENCLAW_AUTH_TOKEN in .env"
else
    ok "OPENCLAW_AUTH_TOKEN already set"
fi

# Default WORKSPACE_DIR if missing
if ! grep -qE '^WORKSPACE_DIR=' .env; then
    echo "WORKSPACE_DIR=${HOME}/projects" >> .env
    ok "set WORKSPACE_DIR=${HOME}/projects"
fi
WORKSPACE_DIR=$(grep -E '^WORKSPACE_DIR=' .env | tail -1 | cut -d= -f2- | sed "s|\${HOME}|$HOME|;s|^~|$HOME|")
WORKSPACE_DIR=${WORKSPACE_DIR:-$HOME/projects}

bold "[4/7] Workspace folder"
mkdir -p "$WORKSPACE_DIR"
ok "workspace ready: $WORKSPACE_DIR"

# Seed empty workspace with persona templates so the bot has the same starting point on any machine
if [ -z "$(ls -A "$WORKSPACE_DIR" 2>/dev/null)" ]; then
    info "workspace is empty — seeding with template persona files"
    cp -a templates/workspace-seed/. "$WORKSPACE_DIR/"
    rm -f "$WORKSPACE_DIR/README.md"
    ok "seeded $WORKSPACE_DIR with IDENTITY.md, SOUL.md, AGENTS.md, USER.md, TOOLS.md, HEARTBEAT.md"
else
    ok "workspace already populated — leaving existing files alone"
fi

bold "[5/7] Skills directory"
mkdir -p skills commands
ok "skills/ + commands/ present"

bold "[6/7] Build image"
docker compose build
ok "image built: openclaw-local:latest"

bold "[7/7] Start container"
docker compose up -d
ok "container started"

cat <<EOF

──────────────────────────────────────────────────────────────────────
🦞  OpenClaw stack is up.

  Dashboard:  http://127.0.0.1:18789/?token=$(grep '^OPENCLAW_AUTH_TOKEN=' .env | cut -d= -f2-)
  Workspace:  $WORKSPACE_DIR  (mounted as /home/agent/.openclaw/workspace inside the container)
  Skills:     $(pwd)/skills/  (mounted as /home/agent/.openclaw/skills)

  Logs:        docker compose logs -f openclaw
  Shell in:    docker compose exec openclaw bash
  TUI chat:    docker compose exec openclaw openclaw tui
  Stop:        docker compose down

  New project init:  bin/openclaw-init-project.sh <name>
  Refresh skills:    bin/sync-ptah-skills.sh   (only if Ptah is installed)

If Discord credentials are set in .env, the bot will appear online in your guild
within ~1 minute. Mention it in any channel where it has Send Messages.
──────────────────────────────────────────────────────────────────────
EOF
