#!/usr/bin/env bash
# openclaw-control launcher — runs the daemon and (if any DISCORD_TOKEN_* is set)
# the multi-agent bot bridge as siblings to the openclaw gateway.
# Sourced/exec'd by the main entrypoint.sh after the gateway is up.
set -euo pipefail

CONTROL_DIR=/opt/openclaw-control
DAEMON_LOG=/tmp/openclaw-control-daemon.log
BOT_LOG=/tmp/openclaw-control-bot.log

# Defensive default — also set in the Dockerfile, but reasserting so `set -u`
# doesn't blow up if someone overrides only one env var.
: "${OPENCLAW_LOCAL_MEMORY:=/home/agent/.claude/local-memory}"
mkdir -p "$OPENCLAW_LOCAL_MEMORY" 2>/dev/null || true

# Auto-generate the internal service token if the user hasn't set one.
# Daemon and bot-bridge both read OPENCLAW_INTERNAL_TOKEN — we export it here
# so both children of this shell inherit it.
if [ -z "${OPENCLAW_INTERNAL_TOKEN:-}" ]; then
    OPENCLAW_INTERNAL_TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
    echo "[control] generated OPENCLAW_INTERNAL_TOKEN (first run; add to .env to pin)"
fi
export OPENCLAW_INTERNAL_TOKEN

# Universal smoke check: better-sqlite3's native binary must load on every host
# (leader AND follower). The daemon's module graph imports `./db/index.js` at
# boot regardless of role, so a missing prebuilt binary would crash the daemon
# at startup. Fail loudly NOW with a useful message instead.
# We resolve from the daemon dir so `require('better-sqlite3')` finds the local
# install; the inline `node -e` cwd would otherwise be /workspace and miss it.
if ! ( cd "$CONTROL_DIR/daemon" && node -e "require('better-sqlite3')(':memory:').close()" ) 2>/tmp/sqlite-smoke.err; then
    echo "[control] FATAL: better-sqlite3 native binary failed to load" >&2
    echo "[control] node error follows:" >&2
    cat /tmp/sqlite-smoke.err >&2 || true
    echo "[control] hint: rebuild the image, or check the runtime base ships glibc compatible with the prebuilt binary" >&2
    exit 1
fi

# Leader-only: ensure the DB directory exists and run schema migrations.
# Migrations are idempotent; first boot creates the file, subsequent boots are no-ops.
# Followers skip this entirely — they never open /data/specs.db.
if [ "${OPENCLAW_LEADER:-0}" = "1" ]; then
    DB_PATH="${OPENCLAW_SPECS_DB_PATH:-/data/specs.db}"
    DB_DIR="$(dirname "$DB_PATH")"
    mkdir -p "$DB_DIR" 2>/dev/null || true
    echo "[control] leader: running db migrations on $DB_PATH"
    if ! node "$CONTROL_DIR/daemon/dist/db/migrations.js" "$DB_PATH"; then
        echo "[control] FATAL: db migration failed for $DB_PATH" >&2
        exit 1
    fi
fi

echo "[control] starting daemon on ${OPENCLAW_HOST:-0.0.0.0}:${OPENCLAW_PORT:-7878}"
node "$CONTROL_DIR/daemon/dist/index.js" >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "[control] daemon pid=$DAEMON_PID (log: $DAEMON_LOG)"

# Bot-bridge is opt-in: only starts when at least one DISCORD_TOKEN_* env var is set
START_BOT=0
while IFS='=' read -r name _; do
    case "$name" in
        DISCORD_TOKEN_*) START_BOT=1; break ;;
    esac
done < <(env)

if [ "$START_BOT" = "1" ]; then
    echo "[control] starting bot-bridge"
    sleep 2
    node "$CONTROL_DIR/bot-bridge/dist/index.js" >"$BOT_LOG" 2>&1 &
    BOT_PID=$!
    echo "[control] bot-bridge pid=$BOT_PID (log: $BOT_LOG)"
else
    echo "[control] no DISCORD_TOKEN_* env vars present — bot-bridge disabled"
fi

# Returns immediately; PIDs are children of the parent shell so they
# inherit tini's signal handling on container shutdown.
