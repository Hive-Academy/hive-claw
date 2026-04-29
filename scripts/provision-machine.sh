#!/usr/bin/env bash
# provision-machine.sh — bootstrap a fresh machine into the openclaw-control fleet.
#
# Idempotent. Safe to re-run after correcting flags or .env values. Skips any
# step whose work is already done.
#
# Usage:
#   ./provision-machine.sh --agent <id> --role {leader|follower} [--repo <https-url>] [--ptah-config <dir>]
#
# What it does (in order):
#   1. Verify Docker, docker compose, curl, openssl are present
#   2. Verify Ollama is installed and reachable on :11434 (host requirement)
#   3. Clone the openclaw repo into ~/Desktop/fixing-openclaw if not present
#   4. Copy .env.example → .env if not present, set OPENCLAW_LEADER and
#      OPENCLAW_LOCAL_AGENT_IDS from the flags, set OPENCLAW_SPECS_REPO_URL
#      if --repo provided
#   5. Run ./setup.sh (which generates the secrets, scaffolds the persona, and
#      starts the container)
#
# What it deliberately does NOT do:
#   - Tailscale Funnel setup (interactive, machine-binding — manual step)
#   - Discord OAuth app creation (manual on developer.discord.com)
#   - Discord bot token retrieval (manual; you paste into .env after)
#   - Pulling models in Ollama (separate decision)

set -euo pipefail

AGENT_ID=""
ROLE=""
REPO_URL=""
REPO_DIR="${HOME}/Desktop/fixing-openclaw"
PTAH_CONFIG_DIR="${HOME}/.ptah"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36mi\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

usage() {
    cat <<EOF
Usage: $0 --agent <id> --role {leader|follower} [--repo <url>] [--ptah-config <dir>]

Required:
  --agent <id>         Agent id this machine owns (e.g. anubis, amun, chappie)
  --role <leader|follower>  Exactly one machine in your fleet should be leader

Optional:
  --repo <url>         Shared specs repo HTTPS URL (private GitHub repo)
  --ptah-config <dir>  Path to ~/.ptah on the host (default: ~/.ptah)
  -h, --help           Show this help
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --agent)        AGENT_ID="$2"; shift 2 ;;
        --role)         ROLE="$2"; shift 2 ;;
        --repo)         REPO_URL="$2"; shift 2 ;;
        --ptah-config)  PTAH_CONFIG_DIR="$2"; shift 2 ;;
        -h|--help)      usage ;;
        *) fail "unknown flag: $1 (use --help)" ;;
    esac
done

[ -n "$AGENT_ID" ] || fail "--agent is required"
[ -n "$ROLE" ]     || fail "--role is required (leader or follower)"
case "$ROLE" in leader|follower) ;; *) fail "--role must be leader or follower" ;; esac
if ! [[ "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]]; then
    fail "agent id must be lowercase alphanumeric with - or _ (got: $AGENT_ID)"
fi

bold "[1/5] Host preflight"
command -v docker >/dev/null || fail "docker not found — install Docker Engine first (https://get.docker.com)"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not available"
ok "docker compose $(docker compose version --short)"
command -v curl >/dev/null || fail "curl not found"
command -v openssl >/dev/null || fail "openssl not found"
command -v git >/dev/null || fail "git not found"

bold "[2/5] Ollama"
if ! command -v ollama >/dev/null 2>&1; then
    fail "ollama not found — install with: curl -fsSL https://ollama.com/install.sh | sh"
fi
ok "ollama installed ($(ollama --version 2>&1 | head -1))"
if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/version >/dev/null; then
    fail "ollama not responding on :11434 — start with: sudo systemctl start ollama"
fi
ok "ollama responding"

bold "[3/5] Repo"
if [ ! -d "$REPO_DIR" ]; then
    if [ -z "$REPO_URL" ]; then
        fail "no repo at $REPO_DIR and --repo not provided — clone manually first or pass --repo"
    fi
    info "cloning $REPO_URL → $REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR"
    ok "cloned"
else
    ok "repo already at $REPO_DIR"
fi

cd "$REPO_DIR"

bold "[4/5] .env"
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    ok ".env created from .env.example"
else
    ok ".env exists — leaving values alone except for the flags below"
    chmod 600 .env 2>/dev/null || true
fi

set_or_update() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
        echo "${key}=${value}" >> .env
    fi
}

case "$ROLE" in
    leader)   set_or_update OPENCLAW_LEADER 1; ok "OPENCLAW_LEADER=1" ;;
    follower) set_or_update OPENCLAW_LEADER 0; ok "OPENCLAW_LEADER=0" ;;
esac

set_or_update OPENCLAW_LOCAL_AGENT_IDS "$AGENT_ID"
ok "OPENCLAW_LOCAL_AGENT_IDS=$AGENT_ID"

if [ -n "$REPO_URL" ]; then
    set_or_update OPENCLAW_SPECS_REPO_URL "$REPO_URL"
    ok "OPENCLAW_SPECS_REPO_URL=$REPO_URL"
fi

if [ "$PTAH_CONFIG_DIR" != "${HOME}/.ptah" ]; then
    set_or_update PTAH_CONFIG_DIR "$PTAH_CONFIG_DIR"
    ok "PTAH_CONFIG_DIR=$PTAH_CONFIG_DIR"
fi

bold "[5/5] Hand off to setup.sh"
info "setup.sh will generate JWT/internal-token secrets, scaffold the agent persona,"
info "build the image, and start the container. It is idempotent."
echo
exec ./setup.sh
