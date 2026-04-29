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

bold "[6/12] openclaw-control: leader/follower mode"
# Exactly one machine in the fleet should be OPENCLAW_LEADER=1.
# We don't change an already-set value; we only prompt when it's missing.
if ! grep -qE '^OPENCLAW_LEADER=' .env; then
    if [ -t 0 ]; then
        read -r -p "  Is THIS machine the leader (runs continuation loop + public dashboard)? [y/N] " ans
        case "${ans:-N}" in
            [Yy]*) echo "OPENCLAW_LEADER=1" >> .env; ok "OPENCLAW_LEADER=1" ;;
            *)     echo "OPENCLAW_LEADER=0" >> .env; ok "OPENCLAW_LEADER=0 (follower)" ;;
        esac
    else
        echo "OPENCLAW_LEADER=0" >> .env
        info "non-interactive — defaulted to follower (OPENCLAW_LEADER=0)"
    fi
else
    ok "OPENCLAW_LEADER already set: $(grep -E '^OPENCLAW_LEADER=' .env | cut -d= -f2-)"
fi

bold "[7/12] openclaw-control: agent ownership"
# CSV of agent ids this machine owns (matches local-memory/agents/<id>/ + DISCORD_TOKEN_<ID>).
LOCAL_AGENT_IDS_VALUE=$(grep -E '^OPENCLAW_LOCAL_AGENT_IDS=' .env | tail -1 | cut -d= -f2- || true)
if [ -z "${LOCAL_AGENT_IDS_VALUE:-}" ]; then
    if [ -t 0 ]; then
        DEFAULT_AGENT_ID="$(hostname | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
        read -r -p "  Agent ids this machine owns (CSV, lowercase, e.g. anubis,amun) [${DEFAULT_AGENT_ID}]: " ans
        AGENT_IDS="${ans:-$DEFAULT_AGENT_ID}"
    else
        AGENT_IDS="$(hostname | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
        info "non-interactive — defaulting OPENCLAW_LOCAL_AGENT_IDS=${AGENT_IDS}"
    fi
    if grep -qE '^OPENCLAW_LOCAL_AGENT_IDS=' .env; then
        sed -i "s|^OPENCLAW_LOCAL_AGENT_IDS=.*|OPENCLAW_LOCAL_AGENT_IDS=${AGENT_IDS}|" .env
    else
        echo "OPENCLAW_LOCAL_AGENT_IDS=${AGENT_IDS}" >> .env
    fi
    ok "OPENCLAW_LOCAL_AGENT_IDS=${AGENT_IDS}"
    LOCAL_AGENT_IDS_VALUE="${AGENT_IDS}"
else
    ok "OPENCLAW_LOCAL_AGENT_IDS=${LOCAL_AGENT_IDS_VALUE}"
fi

bold "[8/12] openclaw-control: shared specs repo"
SPECS_URL=$(grep -E '^OPENCLAW_SPECS_REPO_URL=' .env | tail -1 | cut -d= -f2- || true)
if [ -z "${SPECS_URL:-}" ]; then
    if [ -t 0 ]; then
        read -r -p "  Shared specs repo URL (HTTPS, private; leave empty for local-only): " ans
        SPECS_URL="${ans:-}"
    fi
    if [ -n "$SPECS_URL" ]; then
        if grep -qE '^OPENCLAW_SPECS_REPO_URL=' .env; then
            sed -i "s|^OPENCLAW_SPECS_REPO_URL=.*|OPENCLAW_SPECS_REPO_URL=${SPECS_URL}|" .env
        else
            echo "OPENCLAW_SPECS_REPO_URL=${SPECS_URL}" >> .env
        fi
        ok "OPENCLAW_SPECS_REPO_URL=${SPECS_URL}"
        # PAT required for HTTPS push
        if [[ "$SPECS_URL" == https://* ]]; then
            if ! grep -qE '^OPENCLAW_GIT_TOKEN=.+$' .env; then
                if [ -t 0 ]; then
                    read -r -s -p "  GitHub PAT (repo scope) for the specs repo: " pat; echo
                    if [ -n "$pat" ]; then
                        if grep -qE '^OPENCLAW_GIT_TOKEN=' .env; then
                            sed -i "s|^OPENCLAW_GIT_TOKEN=.*|OPENCLAW_GIT_TOKEN=${pat}|" .env
                        else
                            echo "OPENCLAW_GIT_TOKEN=${pat}" >> .env
                        fi
                        ok "OPENCLAW_GIT_TOKEN set"
                    else
                        warn "OPENCLAW_GIT_TOKEN left empty — daemon will fail to push"
                    fi
                else
                    warn "OPENCLAW_GIT_TOKEN missing and shell is non-interactive — set it manually"
                fi
            else
                ok "OPENCLAW_GIT_TOKEN already set"
            fi
        fi
    else
        info "no specs repo configured — running in local-only mode"
    fi
else
    ok "OPENCLAW_SPECS_REPO_URL already set"
fi

bold "[9/12] openclaw-control: secrets"
# JWT secret (dashboard sessions) and internal token (bot-bridge ↔ daemon).
# Both are 32-byte hex; auto-generated if empty.
for var in OPENCLAW_JWT_SECRET OPENCLAW_INTERNAL_TOKEN; do
    if ! grep -qE "^${var}=.+$" .env; then
        SECRET="$(openssl rand -hex 32)"
        if grep -qE "^${var}=" .env; then
            sed -i "s|^${var}=.*|${var}=${SECRET}|" .env
        else
            echo "${var}=${SECRET}" >> .env
        fi
        ok "generated ${var}"
    else
        ok "${var} already set"
    fi
done

bold "[10/12] openclaw-control: agent persona scaffolding"
# For each agent id this machine owns, ensure local-memory/agents/<id>/persona.md
# exists. Without it, the bot-bridge silently skips the agent.
LOCAL_MEMORY_DIR=$(grep -E '^OPENCLAW_LOCAL_MEMORY_DIR=' .env | tail -1 | cut -d= -f2- | sed "s|\${HOME}|$HOME|;s|^~|$HOME|")
LOCAL_MEMORY_DIR=${LOCAL_MEMORY_DIR:-$HOME/.claude/local-memory}
mkdir -p "$LOCAL_MEMORY_DIR/agents"
chmod 700 "$LOCAL_MEMORY_DIR" 2>/dev/null || true

PERSONA_TEMPLATE="$(pwd)/templates/agent-persona.md.tmpl"
IFS=',' read -ra AGENT_IDS_ARRAY <<< "${LOCAL_AGENT_IDS_VALUE}"
for id in "${AGENT_IDS_ARRAY[@]}"; do
    id=$(echo "$id" | tr -d ' ')
    [ -z "$id" ] && continue
    AGENT_DIR="$LOCAL_MEMORY_DIR/agents/$id"
    mkdir -p "$AGENT_DIR"
    if [ ! -f "$AGENT_DIR/persona.md" ]; then
        if [ -f "$PERSONA_TEMPLATE" ]; then
            sed "s|{{AGENT_ID}}|$id|g" "$PERSONA_TEMPLATE" > "$AGENT_DIR/persona.md"
            chmod 600 "$AGENT_DIR/persona.md"
            ok "scaffolded persona for '$id' at $AGENT_DIR/persona.md"
            info "edit it before the bot will be useful — defaults are placeholders"
        else
            warn "persona template missing at $PERSONA_TEMPLATE"
        fi
    else
        ok "persona for '$id' exists — leaving alone"
    fi
done

bold "[11/12] Build image"
docker compose build
ok "image built: openclaw-local:latest"

bold "[12/12] Start container"
docker compose up -d
ok "container started"

IS_LEADER=$(grep -E '^OPENCLAW_LEADER=' .env | cut -d= -f2- || echo 0)
ROLE_LABEL="follower"
[ "${IS_LEADER}" = "1" ] && ROLE_LABEL="leader"

cat <<EOF

──────────────────────────────────────────────────────────────────────
🦞  OpenClaw stack is up — this machine is a ${ROLE_LABEL}.

  Gateway dashboard:   http://127.0.0.1:18789/?token=$(grep '^OPENCLAW_AUTH_TOKEN=' .env | cut -d= -f2-)
  Control dashboard:   http://127.0.0.1:7878
  Workspace:           $WORKSPACE_DIR  (→ /home/agent/.openclaw/workspace)
  Shared specs:        $(grep '^OPENCLAW_SHARED_SPECS_DIR=' .env 2>/dev/null | cut -d= -f2- | sed "s|\${HOME}|$HOME|" || echo "$HOME/.claude/shared-specs")
  Local memory:        $LOCAL_MEMORY_DIR  (NEVER synced)

  Logs:                ./scripts/dc.sh compose logs -f openclaw
  Shell in:            ./scripts/dc.sh compose exec openclaw bash
  Daemon logs:         ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-daemon.log
  Bot-bridge logs:     ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log
  Stop:                ./scripts/dc.sh compose down
  Restart on env edit: ./scripts/dc.sh compose up -d
  Restart on code edit:./scripts/dc.sh compose up -d --build

  Update this machine: ./scripts/update-machine.sh
  Provision a new one: scp scripts/provision-machine.sh <host>: && ssh <host> ./provision-machine.sh

For the agents this machine owns, edit each persona before talking to them:
$(for id in "${AGENT_IDS_ARRAY[@]}"; do id=$(echo "$id" | tr -d ' '); [ -n "$id" ] && echo "  \$EDITOR $LOCAL_MEMORY_DIR/agents/$id/persona.md"; done)

If you're the leader and want the dashboard reachable from anywhere:
  tailscale up --ssh
  tailscale funnel --bg --https=443 7878
  # then update DISCORD_REDIRECT_URI in .env to https://<host>.<tailnet>.ts.net/auth/discord/callback
──────────────────────────────────────────────────────────────────────
EOF
