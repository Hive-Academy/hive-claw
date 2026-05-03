#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
TEMPLATE="/etc/openclaw/openclaw.json.tmpl"

: "${LLM_PROVIDER:=ollama}"
: "${LLM_MODEL:=kimi-k2.6:cloud}"
: "${OLLAMA_BASE_URL:=http://host.docker.internal:11434/v1}"
: "${OPENAI_API_KEY:=}"
: "${ANTHROPIC_API_KEY:=}"
: "${OPENROUTER_API_KEY:=}"
: "${GROQ_API_KEY:=}"
: "${CUSTOM_BASE_URL:=}"
: "${CUSTOM_API_KEY:=}"
: "${DISCORD_GUILD_ID:=}"
: "${DISCORD_BOT_TOKEN:=}"
: "${OPENCLAW_AUTH_TOKEN:=}"

if [ -z "$OPENCLAW_AUTH_TOKEN" ]; then
    echo "[entrypoint] FATAL: OPENCLAW_AUTH_TOKEN is empty. Set it in .env (run setup.sh once to auto-generate)."
    exit 1
fi

# ---------- Build the providers block for the chosen LLM_PROVIDER ----------
# We assemble a single-provider JSON object via jq so the template stays generic.
provider_block() {
    local provider="$1" model="$2"
    case "$provider" in
        ollama)
            jq -n --arg url "$OLLAMA_BASE_URL" --arg model "$model" '{
              ollama: {
                baseUrl: $url, apiKey: "not-needed", api: "openai-completions",
                models: [{ id: $model, name: ("ollama/" + $model), reasoning: false,
                           input: ["text"],
                           cost: { input:0, output:0, cacheRead:0, cacheWrite:0 },
                           contextWindow: 131072, maxTokens: 4096 }]
              }}'
            ;;
        openai)
            [ -n "$OPENAI_API_KEY" ] || { echo "[entrypoint] FATAL: LLM_PROVIDER=openai but OPENAI_API_KEY is empty."; exit 1; }
            jq -n --arg key "$OPENAI_API_KEY" --arg model "$model" '{
              openai: {
                baseUrl: "https://api.openai.com/v1", apiKey: $key, api: "openai-completions",
                models: [{ id: $model, name: ("openai/" + $model), reasoning: false,
                           input: ["text"], contextWindow: 128000, maxTokens: 4096 }]
              }}'
            ;;
        anthropic)
            [ -n "$ANTHROPIC_API_KEY" ] || { echo "[entrypoint] FATAL: LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty."; exit 1; }
            jq -n --arg key "$ANTHROPIC_API_KEY" --arg model "$model" '{
              anthropic: {
                baseUrl: "https://api.anthropic.com/v1", apiKey: $key, api: "anthropic-messages",
                models: [{ id: $model, name: ("anthropic/" + $model), reasoning: true,
                           input: ["text"], contextWindow: 200000, maxTokens: 8192 }]
              }}'
            ;;
        openrouter)
            [ -n "$OPENROUTER_API_KEY" ] || { echo "[entrypoint] FATAL: LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is empty."; exit 1; }
            jq -n --arg key "$OPENROUTER_API_KEY" --arg model "$model" '{
              openrouter: {
                baseUrl: "https://openrouter.ai/api/v1", apiKey: $key, api: "openai-completions",
                models: [{ id: $model, name: ("openrouter/" + $model), reasoning: false,
                           input: ["text"], contextWindow: 131072, maxTokens: 4096 }]
              }}'
            ;;
        groq)
            [ -n "$GROQ_API_KEY" ] || { echo "[entrypoint] FATAL: LLM_PROVIDER=groq but GROQ_API_KEY is empty."; exit 1; }
            jq -n --arg key "$GROQ_API_KEY" --arg model "$model" '{
              groq: {
                baseUrl: "https://api.groq.com/openai/v1", apiKey: $key, api: "openai-completions",
                models: [{ id: $model, name: ("groq/" + $model), reasoning: false,
                           input: ["text"], contextWindow: 131072, maxTokens: 4096 }]
              }}'
            ;;
        custom)
            [ -n "$CUSTOM_BASE_URL" ] || { echo "[entrypoint] FATAL: LLM_PROVIDER=custom but CUSTOM_BASE_URL is empty."; exit 1; }
            jq -n --arg url "$CUSTOM_BASE_URL" --arg key "${CUSTOM_API_KEY:-not-needed}" --arg model "$model" '{
              custom: {
                baseUrl: $url, apiKey: $key, api: "openai-completions",
                models: [{ id: $model, name: ("custom/" + $model), reasoning: false,
                           input: ["text"], contextWindow: 131072, maxTokens: 4096 }]
              }}'
            ;;
        *)
            echo "[entrypoint] FATAL: unknown LLM_PROVIDER='${provider}'. Use one of: ollama, openai, anthropic, openrouter, groq, custom."
            exit 1
            ;;
    esac
}

LLM_PROVIDERS_JSON="$(provider_block "$LLM_PROVIDER" "$LLM_MODEL")"

OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | awk '{print $2}' || echo unknown)"
OPENCLAW_NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
export LLM_PROVIDER LLM_MODEL LLM_PROVIDERS_JSON \
       DISCORD_GUILD_ID DISCORD_BOT_TOKEN \
       OPENCLAW_AUTH_TOKEN OPENCLAW_VERSION OPENCLAW_NOW

mkdir -p "$CONFIG_DIR"

envsubst '${LLM_PROVIDER} ${LLM_MODEL} ${LLM_PROVIDERS_JSON} ${DISCORD_GUILD_ID} ${DISCORD_BOT_TOKEN} ${OPENCLAW_AUTH_TOKEN} ${OPENCLAW_VERSION} ${OPENCLAW_NOW}' \
    < "$TEMPLATE" > "$CONFIG_FILE"

if [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_GUILD_ID" ]; then
    echo "[entrypoint] Discord token or guild missing — disabling discord channel"
    jq '.channels.discord.enabled = false
        | .channels.discord.accounts.default.enabled = false' \
       "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
fi

# Validate the rendered config is real JSON before openclaw sees it.
if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    echo "[entrypoint] FATAL: rendered config is not valid JSON. Aborting before openclaw mangles it."
    cat "$CONFIG_FILE"
    exit 1
fi

# Redact every key whose name suggests a secret before logging.
echo "[entrypoint] Rendered ${CONFIG_FILE} (secrets redacted):"
jq 'walk(
      if type == "object" then
        with_entries(
          if (.key | ascii_downcase | test("token|apikey|api_key|secret|password|authorization"))
          then .value = (if (.value | type) == "string" and .value != "" then "***" else .value end)
          else .
          end
        )
      else . end
    )' "$CONFIG_FILE" || cat "$CONFIG_FILE"

# Probe whichever provider endpoint we ended up with.
case "$LLM_PROVIDER" in
    ollama)     PROBE_URL="${OLLAMA_BASE_URL%/}/models" ;;
    openai)     PROBE_URL="https://api.openai.com/v1/models" ;;
    anthropic)  PROBE_URL="https://api.anthropic.com/v1/models" ;;
    openrouter) PROBE_URL="https://openrouter.ai/api/v1/models" ;;
    groq)       PROBE_URL="https://api.groq.com/openai/v1/models" ;;
    custom)     PROBE_URL="${CUSTOM_BASE_URL%/}/models" ;;
esac
echo "[entrypoint] Probing ${LLM_PROVIDER} at ${PROBE_URL}"
if ! curl -fsS --max-time 5 "${PROBE_URL}" >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: cannot reach ${PROBE_URL} — provider unreachable or auth-rejected at startup; openclaw will retry on demand."
fi

# ---------- Ptah CLI bootstrap (idempotent) ----------
# We share ~/.ptah with the host via bind mount, so this only seeds defaults
# the first time and never clobbers existing settings or auth state.
: "${GITHUB_TOKEN:=}"
: "${PTAH_WORKSPACE_NAME:=}"
PTAH_DIR="${HOME}/.ptah"
PTAH_SETTINGS="${PTAH_DIR}/settings.json"
PTAH_STAMP="${PTAH_DIR}/.openclaw-bootstrapped"

if command -v ptah >/dev/null 2>&1; then
    mkdir -p "$PTAH_DIR"

    # TASK_2026_002 B6: ensure the per-agent + plugin subdirs exist on first
    # boot so the daemon's materializeAll() pass at startup can write into
    # them without ENOENT. Both paths are bind-mount-backed identity-mapped
    # (${OPENCLAW_HOST_HOME:-${HOME}}/.ptah on both sides — see
    # docker-compose.yml). The daemon does its own defensive mkdir -p on
    # write; this is belt-and-braces.
    mkdir -p "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/agents" \
             "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/plugins" 2>/dev/null || true

    if [ ! -f "$PTAH_STAMP" ]; then
        echo "[entrypoint] Ptah CLI: first-run bootstrap"

        # Register the shared workspace so `ptah harness scan` finds projects here.
        WS_NAME="${PTAH_WORKSPACE_NAME:-$(basename "$(readlink -f /home/agent/.openclaw/workspace 2>/dev/null || echo workspace)")}"
        ptah workspace add --path /home/agent/.openclaw/workspace --name "$WS_NAME" >/dev/null 2>&1 \
            && echo "  ✓ workspace registered: $WS_NAME" \
            || echo "  i workspace add skipped (already present or unsupported)"

        touch "$PTAH_STAMP"
    else
        echo "[entrypoint] Ptah CLI: already bootstrapped (delete ${PTAH_STAMP} to re-run)"
    fi
else
    echo "[entrypoint] WARNING: ptah CLI missing from image — rebuild with current Dockerfile"
fi

# ---------- gh CLI auth probe ----------
# ~/.config/gh is bind-mounted from the host (see docker-compose.yml).
# A single `gh auth login` on the host authenticates the agent too.
# IMPORTANT: GH_CONFIG_DIR / PTAH_CONFIG_DIR carry HOST paths from .env which
# don't exist inside the container — unset them so gh falls back to $HOME/.config/gh.
unset GH_CONFIG_DIR PTAH_CONFIG_DIR
if command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
        GH_USER="$(gh api user -q .login 2>/dev/null || echo unknown)"
        echo "[entrypoint] gh CLI: authenticated as ${GH_USER}"
    elif [ -n "${GITHUB_TOKEN:-}" ]; then
        echo "[entrypoint] gh CLI: using GITHUB_TOKEN from .env"
        export GH_TOKEN="$GITHUB_TOKEN"
    else
        echo "[entrypoint] gh CLI: NOT authenticated — run 'gh auth login' on the host (preferred) or set GITHUB_TOKEN in .env"
    fi
fi

echo "[entrypoint] Dashboard:  http://127.0.0.1:18789/?token=${OPENCLAW_AUTH_TOKEN}"

# ---------- openclaw-control: daemon + multi-agent bot bridge ----------
# Boots in background so all agents share the same workspace and shared-memory tree.
# Disable with OPENCLAW_CONTROL_DISABLE=1.
if [ "${OPENCLAW_CONTROL_DISABLE:-0}" != "1" ] && [ -x /usr/local/bin/entrypoint-control.sh ]; then
    /usr/local/bin/entrypoint-control.sh || echo "[entrypoint] WARNING: openclaw-control launcher returned non-zero"
fi

echo "[entrypoint] Starting openclaw gateway on :18789 (bind=lan, log=debug)"
exec openclaw --log-level debug gateway --port 18789 --bind lan --verbose
