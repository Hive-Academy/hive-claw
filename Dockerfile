# OpenClaw agent — runs the long-lived gateway daemon on :18789
# AND the openclaw-control daemon + dashboard + multi-agent bot bridge on :7878.
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

# ---------- stage 3: compile the bot bridge ----------
FROM node:22-bookworm-slim AS bot-builder
WORKDIR /build/bot-bridge
COPY openclaw-control/bot-bridge/package.json openclaw-control/bot-bridge/package-lock.json* ./
RUN npm ci --include=dev || npm install
COPY openclaw-control/bot-bridge/ ./
RUN npm run build

# ---------- stage 4: runtime image ----------
FROM debian:trixie-slim@sha256:cedb1ef40439206b673ee8b33a46a03a0c9fa90bf3732f54704f99cb061d2c5a

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client gh jq gettext-base tini gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

RUN npm install -g openclaw@2026.4.24 \
    && openclaw --version

# Ptah CLI — first-class project orchestration (discover, scaffold, GitHub auth).
# Shares ~/.ptah with the host so a single `ptah auth login` works for both sides.
RUN npm install -g @hive-academy/ptah-cli \
    && ptah --version || true

# Note: the openclaw-control headless invoker uses ptah-cli (installed above)
# via `ptah --json session start --task ...` — same harness as interactive use.

RUN useradd --create-home --shell /bin/bash --uid 1000 agent \
    && mkdir -p /workspace /home/agent/.openclaw /home/agent/.ptah /home/agent/.claude \
                /opt/openclaw-control/daemon /opt/openclaw-control/bot-bridge /opt/openclaw-control/dashboard \
    && chown -R agent:agent /workspace /home/agent/.openclaw /home/agent/.ptah /home/agent/.claude

# ---------- install openclaw-control runtime ----------
# Daemon — production deps + compiled JS
COPY --chown=agent:agent openclaw-control/daemon/package.json openclaw-control/daemon/package-lock.json* /opt/openclaw-control/daemon/
RUN cd /opt/openclaw-control/daemon \
    && (npm ci --omit=dev || npm install --omit=dev) \
    && chown -R agent:agent /opt/openclaw-control/daemon
COPY --from=daemon-builder --chown=agent:agent /build/daemon/dist /opt/openclaw-control/daemon/dist

# Bot-bridge — production deps + compiled JS
COPY --chown=agent:agent openclaw-control/bot-bridge/package.json openclaw-control/bot-bridge/package-lock.json* /opt/openclaw-control/bot-bridge/
RUN cd /opt/openclaw-control/bot-bridge \
    && (npm ci --omit=dev || npm install --omit=dev) \
    && chown -R agent:agent /opt/openclaw-control/bot-bridge
COPY --from=bot-builder --chown=agent:agent /build/bot-bridge/dist /opt/openclaw-control/bot-bridge/dist

# Static dashboard
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
    OPENCLAW_SHARED_SPECS=/home/agent/.claude/shared-specs \
    OPENCLAW_LOCAL_MEMORY=/home/agent/.claude/local-memory \
    OPENCLAW_TICK_MS=30000 \
    OPENCLAW_GIT_PULL_MS=15000 \
    OPENCLAW_DISPATCH_MS=8000 \
    PTAH_BIN=ptah \
    PTAH_INVOKER_PROFILE=claude_code \
    PTAH_INVOKER_AUTO_APPROVE=1

EXPOSE 18789 7878

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
