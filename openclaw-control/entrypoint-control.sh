#!/usr/bin/env bash
# openclaw-control launcher — runs the daemon and (if any DISCORD_TOKEN_* is set)
# the multi-agent bot bridge as siblings to the openclaw gateway.
# Sourced/exec'd by the main entrypoint.sh after the gateway is up.
set -euo pipefail

CONTROL_DIR=/opt/openclaw-control
DAEMON_LOG=/tmp/openclaw-control-daemon.log
BOT_LOG=/tmp/openclaw-control-bot.log

# Defensive defaults — these are also set in the Dockerfile, but reasserting
# here so `set -u` doesn't blow up if someone overrides only one of them.
: "${OPENCLAW_SHARED_SPECS:=/home/agent/.claude/shared-specs}"
: "${OPENCLAW_LOCAL_MEMORY:=/home/agent/.claude/local-memory}"
mkdir -p "$OPENCLAW_SHARED_SPECS" "$OPENCLAW_LOCAL_MEMORY" 2>/dev/null || true

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
