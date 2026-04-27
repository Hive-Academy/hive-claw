# OpenClaw agent — runs the long-lived gateway daemon on :18789.
# Talks to host Ollama via host.docker.internal (host-gateway add-host).
FROM debian:trixie-slim

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

RUN useradd --create-home --shell /bin/bash --uid 1000 agent \
    && mkdir -p /workspace /home/agent/.openclaw \
    && chown -R agent:agent /workspace /home/agent/.openclaw

COPY --chown=root:root config/openclaw.json.tmpl /etc/openclaw/openclaw.json.tmpl
COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /workspace

EXPOSE 18789

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
