#!/usr/bin/env bash
# Wrapper around `docker` that reads DOCKERHUB_USERNAME / DOCKERHUB_TOKEN from
# .env and uses a repo-local DOCKER_CONFIG. Bypasses your global credsStore
# (which requires gnome-keyring to be unlocked) so pulls don't time out.
#
# Use exactly like `docker`:
#   ./scripts/dc.sh compose up -d --build
#   ./scripts/dc.sh compose logs -f openclaw
#   ./scripts/dc.sh compose down
#   ./scripts/dc.sh ps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DOCKER_CONFIG="${REPO_ROOT}/.docker-config"

# Initialize a config dir with NO credsStore — that's the whole point.
mkdir -p "$DOCKER_CONFIG"
if [ ! -f "$DOCKER_CONFIG/config.json" ]; then
    echo '{"auths":{}}' > "$DOCKER_CONFIG/config.json"
fi

# Extract just the two vars we care about from .env (full sourcing breaks on
# values like `KEY=foo (bar)` that aren't bash-safe — docker-compose handles
# those fine, but `source` doesn't).
read_env() {
    local key="$1"
    [ -f "${REPO_ROOT}/.env" ] || return
    grep -E "^${key}=" "${REPO_ROOT}/.env" 2>/dev/null \
        | tail -1 \
        | sed -E "s/^${key}=//; s/^[\"']//; s/[\"']$//"
}
DOCKERHUB_USERNAME="${DOCKERHUB_USERNAME:-$(read_env DOCKERHUB_USERNAME)}"
DOCKERHUB_TOKEN="${DOCKERHUB_TOKEN:-$(read_env DOCKERHUB_TOKEN)}"

# Log in once per fresh config; subsequent calls reuse the stored auth blob.
if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
    if ! grep -q '"https://index.docker.io/v1/"' "$DOCKER_CONFIG/config.json" 2>/dev/null; then
        echo "[dc] logging in to docker hub as ${DOCKERHUB_USERNAME}"
        echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
    fi
fi

exec docker "$@"
