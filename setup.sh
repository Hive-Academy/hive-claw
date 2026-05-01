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

bold "[1/13] Host preflight"
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

bold "[2/13] Ollama systemd override (so the container can reach it)"
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

bold "[3/13] .env"
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

bold "[4/13] Workspace folder"
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

bold "[5/13] Skills directory"
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

bold "[6/13] openclaw-control: leader/follower mode"
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

bold "[7/13] openclaw-control: agent ownership"
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

bold "[8/13] openclaw-control: SQLite spec store + follower → leader URL"
# Storage is a single SQLite file on the leader (/data/specs.db inside the
# container, persisted via the named docker volume `specs-db`). Followers go
# HTTP-only via OPENCLAW_LEADER_URL.

# OPENCLAW_SPECS_DB_PATH (path inside the container) — only meaningful on the
# leader, but it's harmless to record on followers too.
DB_PATH_VAL=$(grep -E '^OPENCLAW_SPECS_DB_PATH=' .env | tail -1 | cut -d= -f2- || true)
if [ -z "${DB_PATH_VAL:-}" ]; then
    DEFAULT_DB_PATH="/data/specs.db"
    if [ -t 0 ]; then
        read -r -p "  SQLite spec DB path inside the container [${DEFAULT_DB_PATH}]: " ans
        DB_PATH_VAL="${ans:-$DEFAULT_DB_PATH}"
    else
        DB_PATH_VAL="$DEFAULT_DB_PATH"
        info "non-interactive — defaulting OPENCLAW_SPECS_DB_PATH=${DB_PATH_VAL}"
    fi
    if grep -qE '^OPENCLAW_SPECS_DB_PATH=' .env; then
        sed -i "s|^OPENCLAW_SPECS_DB_PATH=.*|OPENCLAW_SPECS_DB_PATH=${DB_PATH_VAL}|" .env
    else
        echo "OPENCLAW_SPECS_DB_PATH=${DB_PATH_VAL}" >> .env
    fi
    ok "OPENCLAW_SPECS_DB_PATH=${DB_PATH_VAL}"
else
    ok "OPENCLAW_SPECS_DB_PATH already set: ${DB_PATH_VAL}"
fi

# OPENCLAW_LEADER_URL — only prompted on followers (OPENCLAW_LEADER=0).
IS_LEADER_NOW=$(grep -E '^OPENCLAW_LEADER=' .env | tail -1 | cut -d= -f2- || echo 0)
if [ "${IS_LEADER_NOW}" = "1" ]; then
    info "this machine is the leader — OPENCLAW_LEADER_URL not needed here"
else
    LEADER_URL_VAL=$(grep -E '^OPENCLAW_LEADER_URL=' .env | tail -1 | cut -d= -f2- || true)
    if [ -z "${LEADER_URL_VAL:-}" ]; then
        if [ -t 0 ]; then
            while :; do
                read -r -p "  Leader's daemon URL (e.g. http://leader.lan:7878 or https://leader.tailnet.ts.net): " ans
                ans="${ans:-}"
                if [ -z "$ans" ]; then
                    warn "OPENCLAW_LEADER_URL is required on followers — try again"
                    continue
                fi
                if node -e "new URL(process.argv[1])" "$ans" >/dev/null 2>&1; then
                    LEADER_URL_VAL="$ans"
                    break
                else
                    warn "'$ans' did not parse as a URL — example: http://leader.lan:7878"
                fi
            done
        else
            fail "OPENCLAW_LEADER_URL is empty and shell is non-interactive — set it in .env before re-running"
        fi
        if grep -qE '^OPENCLAW_LEADER_URL=' .env; then
            sed -i "s|^OPENCLAW_LEADER_URL=.*|OPENCLAW_LEADER_URL=${LEADER_URL_VAL}|" .env
        else
            echo "OPENCLAW_LEADER_URL=${LEADER_URL_VAL}" >> .env
        fi
        ok "OPENCLAW_LEADER_URL=${LEADER_URL_VAL}"
    else
        # Validate an existing value too — typos in .env are common.
        if node -e "new URL(process.argv[1])" "$LEADER_URL_VAL" >/dev/null 2>&1; then
            ok "OPENCLAW_LEADER_URL already set: ${LEADER_URL_VAL}"
        else
            fail "OPENCLAW_LEADER_URL='${LEADER_URL_VAL}' in .env does not parse as a URL — fix it before continuing"
        fi
    fi
fi

bold "[9/13] openclaw-control: secrets"
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

bold "[10/13] openclaw-control: agent persona scaffolding"
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

bold "[11/13] Build image"
docker compose build
ok "image built: openclaw-local:latest"

bold "[12/13] Start container"
docker compose up -d
ok "container started"

bold "[13/13] ptah-bridge user service (host-side ptah for orchestration)"
# Why this exists: the daemon delegates orchestration runs to a host-side ptah
# so ptah uses the operator's desktop config (claudeCli / Copilot / Anthropic key)
# without duplicating binaries or credentials into the container. See
# docs/OPENCLAW_CONTROL.md → "Orchestration runs via the host-side ptah-bridge".
#
# Idempotent: re-runs of setup.sh re-render the unit (picks up token rotations
# and node path changes), then restart the service if it's already running.
# Skipped on machines that don't own any agents (OPENCLAW_LOCAL_AGENT_IDS empty)
# and on machines that explicitly opt out via OPENCLAW_PTAH_BRIDGE_DISABLE=1.

LOCAL_AGENTS_FOR_BRIDGE=$(grep -E '^OPENCLAW_LOCAL_AGENT_IDS=' .env | tail -1 | cut -d= -f2- | tr -d ' ')
if [ -z "${LOCAL_AGENTS_FOR_BRIDGE}" ]; then
    info "OPENCLAW_LOCAL_AGENT_IDS empty — this machine doesn't run agents locally; skipping bridge"
elif [ "${OPENCLAW_PTAH_BRIDGE_DISABLE:-0}" = "1" ]; then
    info "OPENCLAW_PTAH_BRIDGE_DISABLE=1 — skipping bridge install"
elif ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not available — bridge cannot be installed as a user service here"
    info "to run the bridge manually: node $(pwd)/scripts/ptah-bridge.mjs"
else
    PTAH_BIN_PATH=""
    NODE_BIN_PATH=""
    if command -v ptah >/dev/null 2>&1; then
        PTAH_BIN_PATH="$(command -v ptah)"
        NODE_BIN_PATH="$(command -v node || true)"
    fi
    # Source nvm (common case on dev hosts) if ptah / node aren't on bare PATH yet.
    if { [ -z "$PTAH_BIN_PATH" ] || [ -z "$NODE_BIN_PATH" ]; } && [ -f "$HOME/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
        [ -z "$PTAH_BIN_PATH" ] && PTAH_BIN_PATH="$(command -v ptah || true)"
        [ -z "$NODE_BIN_PATH" ] && NODE_BIN_PATH="$(command -v node || true)"
    fi
    # Auto-install ptah if we have npm but not ptah.
    if [ -z "$PTAH_BIN_PATH" ] && command -v npm >/dev/null 2>&1; then
        info "ptah-cli not found — installing @hive-academy/ptah-cli globally"
        if npm install -g @hive-academy/ptah-cli 2>&1 | tail -3; then
            PTAH_BIN_PATH="$(command -v ptah || true)"
            [ -z "$NODE_BIN_PATH" ] && NODE_BIN_PATH="$(command -v node || true)"
        fi
    fi

    if [ -z "$PTAH_BIN_PATH" ] || [ -z "$NODE_BIN_PATH" ]; then
        warn "node or ptah not found on host — skipping bridge install"
        info "install Node.js 22+ (https://nodejs.org or via nvm), then re-run ./setup.sh"
        info "or, manually: npm install -g @hive-academy/ptah-cli && ./setup.sh"
    else
        ok "node: $NODE_BIN_PATH"
        ok "ptah: $PTAH_BIN_PATH ($($PTAH_BIN_PATH --version 2>&1 | head -1))"

        TOKEN_FOR_BRIDGE="$(grep -E '^OPENCLAW_INTERNAL_TOKEN=' .env | tail -1 | cut -d= -f2-)"
        if [ -z "$TOKEN_FOR_BRIDGE" ]; then
            warn "OPENCLAW_INTERNAL_TOKEN missing from .env — bridge cannot authenticate the daemon"
            info "this should have been generated in phase 9; re-run ./setup.sh from a clean state"
        else
            UNIT_DIR="$HOME/.config/systemd/user"
            UNIT_FILE="$UNIT_DIR/ptah-bridge.service"
            mkdir -p "$UNIT_DIR"

            REPO_DIR_FOR_BRIDGE="$(pwd)"
            NODE_DIR_FOR_BRIDGE="$(dirname "$NODE_BIN_PATH")"

            # Render the unit. We escape the substitution values so | and / inside
            # paths don't trip up sed; use a uncommon delimiter (|).
            sed \
                -e "s|{{REPO_DIR}}|${REPO_DIR_FOR_BRIDGE}|g" \
                -e "s|{{TOKEN}}|${TOKEN_FOR_BRIDGE}|g" \
                -e "s|{{NODE_BIN}}|${NODE_BIN_PATH}|g" \
                -e "s|{{NODE_DIR}}|${NODE_DIR_FOR_BRIDGE}|g" \
                -e "s|{{PTAH_BIN}}|${PTAH_BIN_PATH}|g" \
                scripts/ptah-bridge.service.tmpl > "$UNIT_FILE"
            chmod 600 "$UNIT_FILE"   # contains the internal token
            ok "rendered $UNIT_FILE"

            systemctl --user daemon-reload

            if systemctl --user is-active --quiet ptah-bridge.service; then
                systemctl --user restart ptah-bridge.service
                ok "ptah-bridge.service restarted (token + paths refreshed)"
            else
                systemctl --user enable --now ptah-bridge.service
                ok "ptah-bridge.service enabled and started"
            fi

            # Health check.
            sleep 2
            if curl -fsS --max-time 3 http://127.0.0.1:8744/health >/dev/null 2>&1; then
                ok "bridge responding at http://127.0.0.1:8744/health"
            else
                warn "bridge not responding — check: journalctl --user -u ptah-bridge.service -n 30"
            fi

            # Probe ptah's host-side auth state and surface the most common gaps.
            AUTH_BLOB="$($PTAH_BIN_PATH auth status 2>&1 || true)"
            HAS_CLAUDE_BIN="$(command -v claude >/dev/null 2>&1 && echo yes || echo no)"
            # Claude CLI stores OAuth state at ~/.claude/.credentials.json (note
            # the leading dot — it is a hidden file, mode 0600). Don't check
            # ~/.claude/credentials.json (no dot); that path never exists.
            HAS_CLAUDE_CREDS="$([ -f "$HOME/.claude/.credentials.json" ] && echo yes || echo no)"
            AUTH_METHOD="$(echo "$AUTH_BLOB" | grep -oE '"authMethod":"[^"]+"' | head -1 | cut -d'"' -f4)"
            COPILOT_AUTH="$(echo "$AUTH_BLOB" | grep -oE '"copilotAuthenticated":(true|false)' | head -1 | cut -d: -f2)"

            case "$AUTH_METHOD" in
                claudeCli)
                    if [ "$HAS_CLAUDE_BIN" = "no" ]; then
                        warn "ptah authMethod=claudeCli but \`claude\` is not on host PATH"
                        info "install Claude Code CLI on this host, then run: claude /login"
                    elif [ "$HAS_CLAUDE_CREDS" = "no" ]; then
                        warn "Claude CLI installed but no credentials.json — run: claude /login"
                    else
                        ok "ptah auth: claudeCli (creds present)"
                    fi
                    ;;
                apiKey)
                    ok "ptah auth: apiKey (verify your provider key is set: \`ptah provider status\`)"
                    ;;
                "")
                    warn "could not parse \`ptah auth status\` — bridge will start but orchestration may fail"
                    ;;
                *)
                    ok "ptah auth: $AUTH_METHOD"
                    if [ "${COPILOT_AUTH:-false}" = "false" ] && [ "$AUTH_METHOD" != "claudeCli" ]; then
                        info "if using Copilot/Codex OAuth: \`gh auth login\` and complete the flow in your desktop ptah"
                    fi
                    ;;
            esac
        fi
    fi
fi

IS_LEADER=$(grep -E '^OPENCLAW_LEADER=' .env | cut -d= -f2- || echo 0)
ROLE_LABEL="follower"
[ "${IS_LEADER}" = "1" ] && ROLE_LABEL="leader"

cat <<EOF

──────────────────────────────────────────────────────────────────────
🦞  OpenClaw stack is up — this machine is a ${ROLE_LABEL}.

  Gateway dashboard:   http://127.0.0.1:18789/?token=$(grep '^OPENCLAW_AUTH_TOKEN=' .env | cut -d= -f2-)
  Control dashboard:   http://127.0.0.1:7878
  Workspace:           $WORKSPACE_DIR  (→ /home/agent/.openclaw/workspace)
  Spec DB (leader):    $(grep '^OPENCLAW_SPECS_DB_PATH=' .env 2>/dev/null | cut -d= -f2- || echo "/data/specs.db")  (named volume: specs-db)
  Local memory:        $LOCAL_MEMORY_DIR  (NEVER synced)

  Logs:                ./scripts/dc.sh compose logs -f openclaw
  Shell in:            ./scripts/dc.sh compose exec openclaw bash
  Daemon logs:         ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-daemon.log
  Bot-bridge logs:     ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log
  Bridge logs:         journalctl --user -u ptah-bridge.service -f
  Stop:                ./scripts/dc.sh compose down
  Restart on env edit: ./scripts/dc.sh compose up -d
  Restart on code edit:./scripts/dc.sh compose up -d --build

  Update this machine: ./scripts/update-machine.sh
  Provision a new one: scp scripts/provision-machine.sh <host>: && ssh <host> ./provision-machine.sh

For the agents this machine owns, edit each persona before talking to them:
$(for id in "${AGENT_IDS_ARRAY[@]}"; do id=$(echo "$id" | tr -d ' '); [ -n "$id" ] && echo "  \$EDITOR $LOCAL_MEMORY_DIR/agents/$id/persona.md"; done)

If ptah-bridge said your host's ptah auth is not configured, run ONE of:
  claude /login                                    # Claude Code subscription
  ptah config set authMethod apiKey && ptah provider set-key anthropic <key>
  gh auth login   # then complete Copilot OAuth in your desktop ptah

If you're the leader and want the dashboard reachable from anywhere:
  tailscale up --ssh
  tailscale funnel --bg --https=443 7878
  # then update DISCORD_REDIRECT_URI in .env to https://<host>.<tailnet>.ts.net/auth/discord/callback
──────────────────────────────────────────────────────────────────────
EOF
