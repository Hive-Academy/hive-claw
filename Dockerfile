# OpenClaw agent — runs the long-lived gateway daemon on :18789.
# Talks to host Ollama via host.docker.internal (host-gateway add-host).
# Base image pinned by digest for reproducible builds.
FROM debian:trixie-slim@sha256:cedb1ef40439206b673ee8b33a46a03a0c9fa90bf3732f54704f99cb061d2c5a

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gh jq gettext-base tini gnupg \
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

RUN useradd --create-home --shell /bin/bash --uid 1000 agent \
    && mkdir -p /workspace /home/agent/.openclaw /home/agent/.ptah \
    && chown -R agent:agent /workspace /home/agent/.openclaw /home/agent/.ptah

COPY --chown=root:root config/openclaw.json.tmpl /etc/openclaw/openclaw.json.tmpl
COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /workspace

EXPOSE 18789

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
