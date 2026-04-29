#!/usr/bin/env bash
# update-machine.sh — pull latest code and apply updates on an existing fleet machine.
#
# Idempotent. Run on each machine after a release/merge to main.
#
# Usage:
#   ./update-machine.sh [--no-build] [--no-pull]
#
# What it does:
#   1. git fetch + pull on the repo (unless --no-pull)
#   2. ./scripts/dc.sh compose up -d --build  (unless --no-build, then plain up -d)
#   3. wait for the daemon to answer /api/health, with a 60s ceiling
#
# What it deliberately does NOT do:
#   - prompt for any .env changes — if .env.example added new keys, you handle that
#   - touch local-memory or shared-specs — those are operator data
#   - migrate anything

set -euo pipefail

BUILD=1
PULL=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36mi\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --no-build) BUILD=0; shift ;;
        --no-pull)  PULL=0; shift ;;
        -h|--help)
            cat <<EOF
Usage: $0 [--no-build] [--no-pull]

  --no-build  Skip docker build, just restart the running container with new env
  --no-pull   Skip git pull, only rebuild from current working tree

Default behavior pulls and rebuilds.
EOF
            exit 0
            ;;
        *) fail "unknown flag: $1 (use --help)" ;;
    esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

bold "[1/3] git pull"
if [ "$PULL" = "1" ]; then
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        fail "not inside a git repo: $REPO_DIR"
    fi
    if [ -n "$(git status --porcelain)" ]; then
        warn "working tree is dirty — pull may fail. Stash first if you want to keep changes."
    fi
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    git fetch --quiet origin
    BEFORE="$(git rev-parse HEAD)"
    git pull --ff-only origin "$BRANCH"
    AFTER="$(git rev-parse HEAD)"
    if [ "$BEFORE" = "$AFTER" ]; then
        ok "already at $AFTER ($BRANCH)"
    else
        ok "$BEFORE → $AFTER ($BRANCH)"
    fi
else
    info "skipping git pull (--no-pull)"
fi

bold "[2/3] docker compose"
DC=./scripts/dc.sh
[ -x "$DC" ] || fail "$DC not found or not executable"
if [ "$BUILD" = "1" ]; then
    info "building image and bringing the stack up…"
    "$DC" compose up -d --build
else
    info "restarting the stack with current image…"
    "$DC" compose up -d
fi
ok "compose up issued"

bold "[3/3] health check"
PORT="$(grep -E '^OPENCLAW_PORT=' .env 2>/dev/null | cut -d= -f2- || echo 7878)"
PORT="${PORT:-7878}"
URL="http://127.0.0.1:${PORT}/api/health"

DEADLINE=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
        ok "$URL responded"
        echo
        info "logs:           ./scripts/dc.sh compose logs -f openclaw"
        info "daemon log:     ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-daemon.log"
        info "bot-bridge log: ./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log"
        exit 0
    fi
    sleep 2
done
warn "$URL did not respond within 60s — check logs:"
warn "  ./scripts/dc.sh compose logs --tail 100 openclaw"
exit 1
