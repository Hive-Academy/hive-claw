# OpenClaw image — runs EITHER the gateway daemon on :18789 OR the
# openclaw-control daemon (+ dashboard static files) on :7878. The compose
# file selects which one via the OPENCLAW_CONTAINER_ROLE env var read by
# /usr/local/bin/entrypoint.sh.
#
# Talks to host Ollama via host.docker.internal (host-gateway add-host).
# Base image pinned by digest for reproducible builds.

# ---------- stage 1: build the Angular dashboard ----------
FROM node:22-bookworm-slim AS dashboard-builder
WORKDIR /build/dashboard
COPY openclaw-control/dashboard/package.json openclaw-control/dashboard/package-lock.json* ./
RUN npm ci || npm install
COPY openclaw-control/dashboard/ ./
RUN npm run build

# ---------- stage 2: compile the control daemon ----------
FROM node:22-bookworm-slim AS daemon-builder
WORKDIR /build/daemon
COPY openclaw-control/daemon/package.json openclaw-control/daemon/package-lock.json* ./
RUN npm ci --include=dev || npm install
COPY openclaw-control/daemon/ ./
RUN npm run build

# ---------- stage 3: plugin builder (TASK_2026_006 Batch 7) ----------
# Compiles openclaw-control/plugin/ → /build/plugin/dist. The runtime stage
# then drops the artifact into openclaw's bundled-extension auto-discovery
# path (/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/).
# The plugin's tsconfig path aliases for the `openclaw/plugin-sdk/*` shims
# erase at emit time, so the dist artifact imports the real bare specifiers
# verbatim — they resolve against openclaw's own package tree at runtime.
FROM node:22-bookworm-slim AS plugin-builder
WORKDIR /build/plugin
COPY openclaw-control/plugin/package.json openclaw-control/plugin/package-lock.json* ./
RUN npm ci --include=dev || npm install
COPY openclaw-control/plugin/ ./
RUN npm run build

# ---------- stage 4: runtime image ----------
FROM debian:trixie-slim@sha256:cedb1ef40439206b673ee8b33a46a03a0c9fa90bf3732f54704f99cb061d2c5a

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gh jq gettext-base tini gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

RUN npm install -g openclaw@2026.4.24 \
    && openclaw --version

# Ptah CLI — first-class project orchestration (discover, scaffold, GitHub auth).
# Shares ~/.ptah with the host so a single `ptah auth login` works for both sides.
RUN npm install -g @hive-academy/ptah-cli@^0.1.5 \
    && ptah --version || true

# Note: the openclaw-control headless invoker uses ptah-cli (installed above)
# via `ptah --json session start --task ...` — same harness as interactive use.

RUN useradd --create-home --shell /bin/bash --uid 1000 agent \
    && mkdir -p /workspace /home/agent/.openclaw /home/agent/.openclaw/extensions \
                /home/agent/.openclaw/skills /home/agent/.ptah /home/agent/.claude \
                /opt/openclaw-control/daemon /opt/openclaw-control/dashboard \
                /data \
    && chown -R agent:agent /workspace /home/agent/.openclaw /home/agent/.ptah /home/agent/.claude /data

# ---------- install openclaw-control runtime ----------
# Daemon — production deps + compiled JS
COPY --chown=agent:agent openclaw-control/daemon/package.json openclaw-control/daemon/package-lock.json* /opt/openclaw-control/daemon/
RUN cd /opt/openclaw-control/daemon \
    && (npm ci --omit=dev || npm install --omit=dev) \
    && chown -R agent:agent /opt/openclaw-control/daemon \
    && node -e "require('better-sqlite3')(':memory:').close()" \
        || { echo "[build] FATAL: better-sqlite3 native binary failed to load — check prebuilt support for the runtime base image" >&2; exit 1; }
COPY --from=daemon-builder --chown=agent:agent /build/daemon/dist /opt/openclaw-control/daemon/dist

# TASK_2026_006 Batch 7: plugin runtime install.
# Bundled-extension layout (research §B5 Option A) — openclaw auto-discovers
# any directory under its own dist/extensions/ that has an index.js + the
# plugin manifest. We drop the compiled plugin alongside its package.json
# (loader reads `openclaw.extensions` + `peerDependencies`) and the
# openclaw.plugin.json manifest. The plugin's only runtime dep (undici) is
# already present in openclaw's own node_modules, so no second `npm install`
# step is needed here. Batch 10 is the cutover that restarts the gateway and
# makes openclaw actually discover this directory.
# Preserve the dist/ subdirectory so package.json's "main": "dist/index.js"
# and "openclaw.extensions": ["./dist/index.js"] resolve correctly. Without
# the trailing /dist on the destination, Docker COPY flattens dist's
# CONTENTS into openclaw-control-plugin/ — silently broken (plugin not
# discovered, "Plugin not found" from `openclaw plugins inspect`).
COPY --from=plugin-builder /build/plugin/dist /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/dist
COPY --from=plugin-builder /build/plugin/package.json /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/package.json
COPY --from=plugin-builder /build/plugin/openclaw.plugin.json /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/openclaw.plugin.json

# Static dashboard (served by daemon when role=daemon, by gateway-side static
# server otherwise).
COPY --from=dashboard-builder --chown=agent:agent /build/dashboard/dist/dashboard /opt/openclaw-control/dashboard

# ---------- gateway templates + entrypoints ----------
COPY --chown=root:root config/openclaw.json.tmpl /etc/openclaw/openclaw.json.tmpl
COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=root:root openclaw-control/entrypoint-control.sh /usr/local/bin/entrypoint-control.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/entrypoint-control.sh

USER agent
WORKDIR /workspace

# Sensible defaults — overridable via .env
ENV OPENCLAW_HOST=0.0.0.0 \
    OPENCLAW_PORT=7878 \
    OPENCLAW_DASHBOARD_DIR=/opt/openclaw-control/dashboard/browser \
    OPENCLAW_PROJECT_ROOTS=/workspace \
    OPENCLAW_LOCAL_MEMORY=/home/agent/.claude/local-memory \
    OPENCLAW_TICK_MS=30000 \
    OPENCLAW_SPECS_DB_PATH=/data/specs.db \
    OPENCLAW_DISPATCH_MS=8000 \
    PTAH_BIN=ptah \
    PTAH_INVOKER_PROFILE=claude_code \
    PTAH_INVOKER_AUTO_APPROVE=1

EXPOSE 18789 7878

# OPENCLAW_CONTAINER_ROLE selects the boot path:
#   gateway → exec openclaw gateway
#   daemon  → exec node /opt/openclaw-control/daemon/dist/index.js
#   <unset> → legacy single-container (run both, gateway in foreground)
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
