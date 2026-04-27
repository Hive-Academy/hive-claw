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
    info ".env created from .env.example — edit it to set LLM_PROVIDER + matching API key, and DISCORD_BOT_TOKEN/DISCORD_GUILD_ID before talking to the bot"
else
    ok ".env exists"
    chmod 600 .env 2>/dev/null || true
fi

# Refuse to continue if .env is tracked by git — it likely contains live secrets.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git ls-files --error-unmatch .env >/dev/null 2>&1; then
        fail ".env is tracked by git! Remove it from the index before continuing: 'git rm --cached .env && git commit -m \"untrack .env\"'. Then rotate any tokens that were ever committed."
    fi
    if [ -d secrets ] && git ls-files --error-unmatch secrets >/dev/null 2>&1; then
        warn "secrets/ directory is tracked by git — review and untrack if it holds live secrets."
    fi
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

# Ptah CLI config dir — bind-mounted into the container so a single
# `ptah auth login` works for both host and agent.
if ! grep -qE '^PTAH_CONFIG_DIR=' .env; then
    echo "PTAH_CONFIG_DIR=${HOME}/.ptah" >> .env
    ok "set PTAH_CONFIG_DIR=${HOME}/.ptah"
fi
PTAH_CONFIG_DIR=$(grep -E '^PTAH_CONFIG_DIR=' .env | tail -1 | cut -d= -f2- | sed "s|\${HOME}|$HOME|;s|^~|$HOME|")
PTAH_CONFIG_DIR=${PTAH_CONFIG_DIR:-$HOME/.ptah}
mkdir -p "$PTAH_CONFIG_DIR"
ok "ptah config dir: $PTAH_CONFIG_DIR (shared with container)"

# ---------- gh CLI auth (so the agent inherits GitHub access) ----------
# Modern gh stores OAuth tokens in the OS keyring by default, which the
# container can't reach. We detect that and offer to re-login with file
# storage so the bind mount actually carries the token across.
if ! grep -qE '^GH_CONFIG_DIR=' .env; then
    echo 'GH_CONFIG_DIR=${HOME}/.config/gh' >> .env
fi
if ! grep -qE '^GH_AUTH_MODE=' .env; then
    echo 'GH_AUTH_MODE=file' >> .env
fi
GH_CONFIG_DIR=$(grep -E '^GH_CONFIG_DIR=' .env | tail -1 | cut -d= -f2- | sed "s|\${HOME}|$HOME|;s|^~|$HOME|")
GH_CONFIG_DIR=${GH_CONFIG_DIR:-$HOME/.config/gh}
GH_AUTH_MODE=$(grep -E '^GH_AUTH_MODE=' .env | tail -1 | cut -d= -f2-)
GH_AUTH_MODE=${GH_AUTH_MODE:-file}
mkdir -p "$GH_CONFIG_DIR"

if ! command -v gh >/dev/null 2>&1; then
    warn "gh CLI not installed on host — skipping GitHub auth"
    info "install: https://cli.github.com/  (then re-run setup.sh)"
elif [ "$GH_AUTH_MODE" = "skip" ]; then
    info "GH_AUTH_MODE=skip — leaving gh auth alone"
elif [ "$GH_AUTH_MODE" = "token" ]; then
    if grep -qE '^GITHUB_TOKEN=.+$' .env; then
        ok "GH_AUTH_MODE=token — agent will use GITHUB_TOKEN from .env"
    else
        warn "GH_AUTH_MODE=token but GITHUB_TOKEN is empty in .env"
        info "either fill it in, or switch to GH_AUTH_MODE=file"
    fi
else
    # GH_AUTH_MODE=file (or anything else default-y) — make sure the token
    # actually lives in hosts.yml, not in the keyring.
    HOSTS_YML="$GH_CONFIG_DIR/hosts.yml"
    if [ -f "$HOSTS_YML" ] && grep -qE '^[[:space:]]+oauth_token:' "$HOSTS_YML"; then
        ok "gh auth: token already in $HOSTS_YML (agent can read it)"
    elif gh auth status >/dev/null 2>&1; then
        warn "gh is logged in but token is in the OS keyring — agent can't read it"
        if [ -t 0 ]; then
            read -r -p "  Re-login with file storage now? (one browser OAuth) [Y/n] " ans
            case "${ans:-Y}" in
                [Yy]*)
                    gh auth logout -h github.com >/dev/null 2>&1 || true
                    if gh auth login --hostname github.com --git-protocol https --web --insecure-storage; then
                        ok "gh re-logged in with file storage — $HOSTS_YML now has oauth_token"
                    else
                        warn "gh login failed — falling back to GITHUB_TOKEN if set"
                    fi
                    ;;
                *)  info "skipped — set GITHUB_TOKEN in .env, or re-run: gh auth login --insecure-storage" ;;
            esac
        else
            info "non-interactive shell — skipping prompt; run later: gh auth login --insecure-storage"
        fi
    else
        info "gh not authenticated yet"
        if [ -t 0 ]; then
            read -r -p "  Run 'gh auth login --insecure-storage' now? [Y/n] " ans
            case "${ans:-Y}" in
                [Yy]*)
                    if gh auth login --hostname github.com --git-protocol https --web --insecure-storage; then
                        ok "gh authenticated — agent will inherit it via bind mount"
                    else
                        warn "gh login failed — set GITHUB_TOKEN in .env as a fallback"
                    fi
                    ;;
                *)  info "skipped — agent will need GITHUB_TOKEN in .env to use GitHub" ;;
            esac
        fi
    fi
fi

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
  New project (Ptah wizard):  bin/openclaw-init-project.sh --with-ptah <name>
  GitHub auth (one-time):     docker compose exec openclaw ptah auth login github
                              (or run on host: ptah auth login github)
  Discover projects:          docker compose exec openclaw ptah harness scan
  Refresh skills:    bin/sync-ptah-skills.sh   (only if Ptah is installed)

If Discord credentials are set in .env, the bot will appear online in your guild
within ~1 minute. Mention it in any channel where it has Send Messages.
──────────────────────────────────────────────────────────────────────
EOF
