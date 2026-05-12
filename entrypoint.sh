#!/usr/bin/env bash
# Role-aware entrypoint. Both compose services (openclaw-gateway and
# openclaw-daemon) run the SAME image; they differ only in
# OPENCLAW_CONTAINER_ROLE which selects the boot path here.
#
#   OPENCLAW_CONTAINER_ROLE=gateway → render openclaw.json, probe provider, exec
#                                     `openclaw gateway` (the original behavior).
#   OPENCLAW_CONTAINER_ROLE=daemon  → skip openclaw setup; hand off to
#                                     /usr/local/bin/entrypoint-control.sh in
#                                     foreground mode.
#
# Legacy single-container deployments (no OPENCLAW_CONTAINER_ROLE set) fall back
# to the historical behavior: render config, then exec
# /usr/local/bin/entrypoint-control.sh in background mode and finally exec the
# gateway. Honors OPENCLAW_CONTROL_DISABLE=1 for gateway-only runs.

set -euo pipefail

ROLE="${OPENCLAW_CONTAINER_ROLE:-legacy}"

# ---------- DAEMON-ONLY ROLE ----------
# When the daemon runs in its own container, no openclaw.json rendering, no
# provider probe, no gh/ptah bootstrap. The daemon doesn't speak to an LLM
# directly; the gateway does that. Hand off to the control launcher in
# foreground mode (it'll exec the daemon process so tini sees PID 2 = daemon).
if [ "$ROLE" = "daemon" ]; then
    if [ ! -x /usr/local/bin/entrypoint-control.sh ]; then
        echo "[entrypoint] FATAL: role=daemon but entrypoint-control.sh missing or not executable" >&2
        exit 1
    fi
    exec /usr/local/bin/entrypoint-control.sh foreground
fi

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
: "${DISCORD_TOKEN_ANUBIS:=}"
: "${DISCORD_TOKEN_HORUS:=}"
: "${GITHUB_TOKEN:=}"
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
       DISCORD_TOKEN_ANUBIS DISCORD_TOKEN_HORUS GITHUB_TOKEN \
       OPENCLAW_AUTH_TOKEN OPENCLAW_VERSION OPENCLAW_NOW

mkdir -p "$CONFIG_DIR"

# ---------- TASK_2026_006 Batch 9: dual-write rendering ----------
# The template at $TEMPLATE was updated in Batch 6 to render the NEW
# multi-agent shape (per-persona Discord accounts: anubis, horus). The
# config currently running inside the gateway (in the openclaw-state docker
# volume at $CONFIG_FILE) is still the OLD single-agent shape from before
# Batch 6.
#
# Cutover policy:
#   - If $CONFIG_FILE already exists, leave it untouched. The operator's
#     current openclaw.json keeps running unchanged.
#   - If $CONFIG_FILE does not exist (fresh volume / first boot), render
#     the new template into it — there's nothing to preserve.
#   - ALWAYS (re-)render the new template to $CONFIG_FILE.new so the
#     operator can `diff` old vs new and cut over by `cp`-ing the .new file
#     onto openclaw.json when ready (see docs/CUTOVER_RUNBOOK.md).
#
# Batch 10 will flip this so the rendering goes straight to $CONFIG_FILE.
CONFIG_FILE_NEW="${CONFIG_FILE}.new"

render_template() {
    local out="$1"
    envsubst '${LLM_PROVIDER} ${LLM_MODEL} ${LLM_PROVIDERS_JSON} ${DISCORD_GUILD_ID} ${DISCORD_BOT_TOKEN} ${DISCORD_TOKEN_ANUBIS} ${DISCORD_TOKEN_HORUS} ${GITHUB_TOKEN} ${OPENCLAW_AUTH_TOKEN} ${OPENCLAW_VERSION} ${OPENCLAW_NOW}' \
        < "$TEMPLATE" > "$out"

    # Mirror the historical "discord disabled when tokens missing" behavior
    # on the rendered output. Detect which shape we rendered (old: default
    # account; new: anubis/horus accounts) and disable accordingly.
    if [ -z "$DISCORD_BOT_TOKEN" ] && [ -z "$DISCORD_TOKEN_ANUBIS" ] && [ -z "$DISCORD_TOKEN_HORUS" ]; then
        echo "[entrypoint] No Discord tokens configured — disabling discord channel in $out"
        jq '.channels.discord.enabled = false
            | (.channels.discord.accounts // {}) |= with_entries(.value.enabled = false)' \
           "$out" > "${out}.tmp" && mv "${out}.tmp" "$out"
    elif [ -z "$DISCORD_GUILD_ID" ]; then
        echo "[entrypoint] DISCORD_GUILD_ID missing — disabling discord channel in $out"
        jq '.channels.discord.enabled = false
            | (.channels.discord.accounts // {}) |= with_entries(.value.enabled = false)' \
           "$out" > "${out}.tmp" && mv "${out}.tmp" "$out"
    fi

    if ! jq empty "$out" 2>/dev/null; then
        echo "[entrypoint] FATAL: rendered config $out is not valid JSON. Aborting before openclaw mangles it."
        cat "$out"
        exit 1
    fi
}

if [ -f "$CONFIG_FILE" ]; then
    echo "[entrypoint] Existing $CONFIG_FILE found — leaving it in place (cutover pending)."
else
    echo "[entrypoint] No existing $CONFIG_FILE — rendering new template into it (fresh boot)."
    render_template "$CONFIG_FILE"
fi

# Always (re-)render the new-shape template to a side-by-side file so the
# operator can preview / diff / cp it during the Batch 10 cutover.
echo "[entrypoint] Rendering side-by-side cutover preview to $CONFIG_FILE_NEW"
render_template "$CONFIG_FILE_NEW"

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
    # them without ENOENT.
    mkdir -p "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/agents" \
             "${OPENCLAW_HOST_HOME:-${HOME}}/.ptah/plugins" 2>/dev/null || true

    if [ ! -f "$PTAH_STAMP" ]; then
        echo "[entrypoint] Ptah CLI: first-run bootstrap"

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

# ---------- GATEWAY-ONLY ROLE ----------
# Multi-container deployment: gateway is its own service; the daemon runs in a
# sibling container. Do NOT start the control launcher here.
if [ "$ROLE" = "gateway" ]; then
    echo "[entrypoint] role=gateway — starting openclaw gateway only (daemon runs in sibling container)"
    echo "[entrypoint] Starting openclaw gateway on :18789 (bind=lan, log=debug)"
    exec openclaw --log-level debug gateway --port 18789 --bind lan --verbose
fi

# ---------- LEGACY SINGLE-CONTAINER ROLE ----------
# Boots the control launcher in background mode, then execs the gateway. This
# is the historical pre-Batch-5b behavior, preserved for one-container deploys.
if [ "${OPENCLAW_CONTROL_DISABLE:-0}" != "1" ] && [ -x /usr/local/bin/entrypoint-control.sh ]; then
    /usr/local/bin/entrypoint-control.sh background || echo "[entrypoint] WARNING: openclaw-control launcher returned non-zero"
fi

echo "[entrypoint] Starting openclaw gateway on :18789 (bind=lan, log=debug)"
exec openclaw --log-level debug gateway --port 18789 --bind lan --verbose
