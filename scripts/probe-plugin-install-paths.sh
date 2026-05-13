#!/usr/bin/env bash
# Probe where `openclaw plugins install` actually writes files inside the
# container filesystem. Used once during TASK_2026_006 Batch 5b to verify
# the named-volume mount targets in docker-compose.yml match reality.
#
# Output is intended to be captured into
# .ptah/specs/TASK_2026_006/plugin-install-paths-probe.md.
#
# Usage:
#   bash scripts/probe-plugin-install-paths.sh
#
# The probe runs in a throwaway container built from a minimal Dockerfile
# (no Angular dashboard / daemon build — those are unnecessary for this
# question and slow the probe down). The container installs the same
# openclaw npm version that the production Dockerfile pins, then runs
# `openclaw plugins install npm:@openclaw/web-search` against a fresh
# $HOME and `find`s everything that changed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROBE_IMAGE="openclaw-probe:latest"
PROBE_DOCKERFILE="$(mktemp -t probe-dockerfile.XXXXXX)"
trap 'rm -f "$PROBE_DOCKERFILE"' EXIT

# Same openclaw version as the production Dockerfile pin (search for the
# `npm install -g openclaw@` line). Update both together if you bump it.
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.4.24}"

cat > "$PROBE_DOCKERFILE" <<DOCKERFILE
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@${OPENCLAW_VERSION}
RUN useradd --create-home --shell /bin/bash --uid 1000 agent
USER agent
WORKDIR /home/agent
DOCKERFILE

echo "[probe] building $PROBE_IMAGE (openclaw@${OPENCLAW_VERSION})..."
docker build -t "$PROBE_IMAGE" -f "$PROBE_DOCKERFILE" "$REPO_ROOT" >/dev/null

PROBE_PLUGIN_SPEC="${PROBE_PLUGIN_SPEC:-@ollama/openclaw-web-search}"
echo "[probe] running 'openclaw plugins install ${PROBE_PLUGIN_SPEC}'..."
docker run --rm -e PROBE_PLUGIN_SPEC="$PROBE_PLUGIN_SPEC" "$PROBE_IMAGE" bash -lc '
  set -e
  touch /tmp/probe-start
  # Force probe-start to be slightly in the past so first-second writes count.
  touch -d "1 second ago" /tmp/probe-start
  # Snapshot home before — scope to /home/agent only; /var/lib is too noisy
  # and not where openclaw writes plugins.
  find /home/agent 2>/dev/null | sort > /tmp/before.txt || true

  echo "--- openclaw plugins install (stdout+stderr) ---"
  openclaw plugins install "$PROBE_PLUGIN_SPEC" 2>&1 || echo "[probe] install returned nonzero"

  echo "--- top-level home dirs touched ---"
  find /home/agent -maxdepth 3 -newer /tmp/probe-start 2>/dev/null | sort || true

  echo "--- plugin destinations (look for *.openclaw.plugin.json + skill.md outside runtime-deps cache) ---"
  find /home/agent -newer /tmp/probe-start \
       \( -name "openclaw.plugin.json" -o -iname "skill.md" -o -iname "*.plugin.yaml" \) \
       -not -path "*/plugin-runtime-deps/*" \
       2>/dev/null | sort || true

  echo "--- everything new under /home/agent EXCLUDING runtime-deps cache ---"
  find /home/agent -newer /tmp/probe-start -not -path "*/plugin-runtime-deps/*" 2>/dev/null | sort || true

  echo "--- $HOME/.openclaw directory listing (depth 2) ---"
  find "$HOME/.openclaw" -maxdepth 2 -type d 2>/dev/null | sort || true

  echo "--- openclaw plugins list (post-install) ---"
  openclaw plugins list 2>&1 | head -200 || true

  echo "--- inspect freshly-installed plugin (if found) ---"
  openclaw plugins inspect openclaw-web-search 2>&1 || \
    openclaw plugins inspect "$PROBE_PLUGIN_SPEC" 2>&1 || true

  echo "--- relevant config file (openclaw.json) ---"
  if [ -f "$HOME/.openclaw/openclaw.json" ]; then
    head -100 "$HOME/.openclaw/openclaw.json" || true
  else
    echo "(no openclaw.json found at $HOME/.openclaw/)"
  fi

  echo "--- environment hints ---"
  echo "HOME=$HOME"
  echo "PWD=$PWD"
  echo "OPENCLAW_HOME=${OPENCLAW_HOME:-<unset>}"
'

echo "[probe] done."
