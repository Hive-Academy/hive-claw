#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
TEMPLATE="/etc/openclaw/openclaw.json.tmpl"

: "${OLLAMA_BASE_URL:=http://host.docker.internal:11434/v1}"
: "${OLLAMA_MODEL:=kimi-k2.6:cloud}"
: "${DISCORD_GUILD_ID:=}"
: "${DISCORD_BOT_TOKEN:=}"
: "${OPENCLAW_AUTH_TOKEN:=}"

if [ -z "$OPENCLAW_AUTH_TOKEN" ]; then
    echo "[entrypoint] FATAL: OPENCLAW_AUTH_TOKEN is empty. Set it in .env (run setup.sh once to auto-generate)."
    exit 1
fi

OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | awk '{print $2}' || echo unknown)"
OPENCLAW_NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
export OLLAMA_BASE_URL OLLAMA_MODEL DISCORD_GUILD_ID DISCORD_BOT_TOKEN \
       OPENCLAW_AUTH_TOKEN OPENCLAW_VERSION OPENCLAW_NOW

mkdir -p "$CONFIG_DIR"

envsubst '${OLLAMA_BASE_URL} ${OLLAMA_MODEL} ${DISCORD_GUILD_ID} ${DISCORD_BOT_TOKEN} ${OPENCLAW_AUTH_TOKEN} ${OPENCLAW_VERSION} ${OPENCLAW_NOW}' \
    < "$TEMPLATE" > "$CONFIG_FILE"

if [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_GUILD_ID" ]; then
    echo "[entrypoint] Discord token or guild missing — disabling discord channel"
    jq '.channels.discord.enabled = false
        | .channels.discord.accounts.default.enabled = false' \
       "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
fi

echo "[entrypoint] Rendered ${CONFIG_FILE} (secrets redacted):"
jq 'walk(if type == "object" and has("token") then .token = (if .token == "" then "" else "***" end) else . end)' \
   "$CONFIG_FILE" || cat "$CONFIG_FILE"

echo "[entrypoint] Probing Ollama at ${OLLAMA_BASE_URL}"
if ! curl -fsS --max-time 5 "${OLLAMA_BASE_URL}/models" >/dev/null; then
    echo "[entrypoint] WARNING: cannot reach ${OLLAMA_BASE_URL}/models — check Ollama is bound to 0.0.0.0:11434 on the host"
fi

echo "[entrypoint] Dashboard:  http://127.0.0.1:18789/?token=${OPENCLAW_AUTH_TOKEN}"
echo "[entrypoint] Starting openclaw gateway on :18789 (bind=lan, log=debug)"
exec openclaw --log-level debug gateway --port 18789 --bind lan --verbose
