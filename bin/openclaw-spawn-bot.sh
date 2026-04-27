#!/usr/bin/env bash
# openclaw-spawn-bot.sh — promote a project into a peer-of-Anubis OpenClaw bot.
#
# Drops a docker-compose.yml + workspace seed files into <project-dir> so the
# project becomes a self-contained OpenClaw stack: same image as Anubis,
# different port, different Discord token, shared ~/.ptah and gh auth.
#
# Usage:
#   bin/openclaw-spawn-bot.sh <project-name | absolute-path> <port> <bot-name>
#
# Examples:
#   bin/openclaw-spawn-bot.sh social-buddy 18790 chappie
#   bin/openclaw-spawn-bot.sh ~/projects/marketing-bot 18791 wendy

set -euo pipefail

if [ $# -lt 3 ]; then
    echo "Usage: $0 <project-name | absolute-path> <port> <bot-name>"
    echo
    echo "Example:"
    echo "  $0 social-buddy 18790 chappie"
    exit 1
fi

ARG="$1"
PORT="$2"
BOT_NAME="$3"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/projects}"

if [[ "$ARG" == /* ]] || [[ "$ARG" == ~* ]]; then
    PROJ_DIR="${ARG/#\~/$HOME}"
else
    PROJ_DIR="$WORKSPACE_DIR/$ARG"
fi

if [ ! -d "$PROJ_DIR" ]; then
    echo "Project dir does not exist: $PROJ_DIR"
    exit 1
fi

# 1. docker-compose.yml — uses the openclaw-local image, project as workspace
COMPOSE="$PROJ_DIR/docker-compose.yml"
if [ -e "$COMPOSE" ]; then
    echo "  · skipping $COMPOSE (exists)"
else
    cat > "$COMPOSE" <<EOF
# ${BOT_NAME^} — OpenClaw bot peer of Anubis. Built from openclaw-local:latest
# (run \`docker compose build\` in fixing-openclaw first if image missing).
services:
  ${BOT_NAME}:
    image: openclaw-local:latest
    container_name: ${BOT_NAME}
    restart: unless-stopped
    env_file:
      - .env
    environment:
      GH_CONFIG_DIR: /home/agent/.config/gh
      PTAH_CONFIG_DIR: /home/agent/.ptah
    extra_hosts:
      - "host.docker.internal:host-gateway"
    security_opt:
      - no-new-privileges:true
    mem_limit: 2g
    pids_limit: 512
    ports:
      - "127.0.0.1:${PORT}:18789"
    volumes:
      - \${WORKSPACE_DIR:-.}:/home/agent/.openclaw/workspace:rw
      - \${SKILLS_DIR:-${HOME}/Desktop/fixing-openclaw/skills}:/home/agent/.openclaw/skills:rw
      - ${BOT_NAME}-state:/home/agent/.openclaw
      - \${PTAH_CONFIG_DIR:-\${HOME}/.ptah}:/home/agent/.ptah:rw
      - \${GH_CONFIG_DIR:-\${HOME}/.config/gh}:/home/agent/.config/gh:rw
    healthcheck:
      test: ["CMD-SHELL", "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/ | grep -qE '^(200|301|302|401|403|404)\$' || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 120s

volumes:
  ${BOT_NAME}-state:
EOF
    echo "  ✓ wrote $COMPOSE (port ${PORT})"
fi

# 2. .env scaffolding — append OpenClaw vars if missing
ENV_FILE="$PROJ_DIR/.env"
touch "$ENV_FILE"
if ! grep -qE '^OPENCLAW_AUTH_TOKEN=' "$ENV_FILE"; then
    TOKEN="$(openssl rand -hex 32)"
    cat >> "$ENV_FILE" <<EOF

# --- OpenClaw stack (${BOT_NAME^} peer-of-Anubis) ---
OPENCLAW_AUTH_TOKEN=${TOKEN}
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
LLM_PROVIDER=ollama
LLM_MODEL=kimi-k2.6:cloud
OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
WORKSPACE_DIR=.
PTAH_CONFIG_DIR=\${HOME}/.ptah
GH_CONFIG_DIR=\${HOME}/.config/gh
GH_AUTH_MODE=file
SKILLS_DIR=${HOME}/Desktop/fixing-openclaw/skills
EOF
    chmod 600 "$ENV_FILE"
    echo "  ✓ appended OpenClaw vars to .env (set DISCORD_BOT_TOKEN before starting)"
else
    echo "  · .env already has OpenClaw vars"
fi

# 3. Workspace seed — copy template files only if absent
SEED_DIR="$(dirname "$0")/../templates/workspace-seed"
for f in "$SEED_DIR"/*.md; do
    name=$(basename "$f")
    if [ ! -f "$PROJ_DIR/$name" ]; then
        cp "$f" "$PROJ_DIR/$name"
        echo "  ✓ seeded $name"
    fi
done

# 4. .openclaw/ overlay if missing
if [ ! -d "$PROJ_DIR/.openclaw" ]; then
    "$(dirname "$0")/openclaw-init-project.sh" "$PROJ_DIR" >/dev/null
    echo "  ✓ wrote .openclaw/ overlay"
fi

echo
echo "✓ ${BOT_NAME^} stack ready at $PROJ_DIR"
echo
echo "Next steps:"
echo "  1. Edit ${ENV_FILE}:"
echo "     - Set DISCORD_BOT_TOKEN (Chappie's bot token from Discord Developer Portal)"
echo "     - Set DISCORD_GUILD_ID"
echo "  2. Edit $PROJ_DIR/IDENTITY.md to describe ${BOT_NAME^}"
echo "  3. Build the openclaw image (once per machine):"
echo "       cd ~/Desktop/fixing-openclaw && docker compose build"
echo "  4. Start the bot:"
echo "       cd $PROJ_DIR && docker compose up -d"
echo "  5. Dashboard: http://127.0.0.1:${PORT}/?token=\$(grep OPENCLAW_AUTH_TOKEN ${ENV_FILE} | cut -d= -f2)"
