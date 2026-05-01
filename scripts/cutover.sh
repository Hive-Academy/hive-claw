#!/usr/bin/env bash
# scripts/cutover.sh — drop the git-based shared-specs setup and deploy the
# SQLite-backed image. Run on EVERY machine (leader and followers) once.
#
# DESTRUCTIVE: removes ~/.claude/shared-specs and the docker volume `openclaw_specs-db`.
# In-flight work in those locations is lost — the user has accepted this trade.
# Idempotent: safe to re-run; missing dirs/volumes are tolerated.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- step 0: confirmation prompt (no env-var bypass) ----------------------
echo "==> About to delete ~/.claude/shared-specs AND the docker volume 'openclaw_specs-db'"
echo "    Plus every .invoker/ debug-log directory under WORKSPACE_DIR."
echo "    Then rebuild + start the new SQLite-backed image."
echo
read -r -p "Type YES (uppercase, exactly) to proceed: " CONFIRM
if [ "${CONFIRM:-}" != "YES" ]; then
    echo "Aborted — no changes made."
    exit 1
fi

# --- step 1: stop the existing stack --------------------------------------
echo "==> Stopping container stack"
docker compose down

# --- step 2: remove the legacy git-cloned shared-specs --------------------
SHARED="${OPENCLAW_SHARED_SPECS_DIR:-${HOME}/.claude/shared-specs}"
echo "==> Removing legacy shared-specs clone at $SHARED (if present)"
if [ -d "$SHARED" ]; then
    rm -rf "$SHARED"
    echo "    removed $SHARED"
else
    echo "    not present — skipping"
fi

# --- step 3: drop the named SQLite volume (idempotent) --------------------
echo "==> Removing docker volume openclaw_specs-db (idempotent)"
docker volume rm openclaw_specs-db 2>/dev/null || echo "    volume did not exist — continuing"

# --- step 4: clear leftover .invoker debug logs ---------------------------
WORKSPACE_DIR_VAL="${WORKSPACE_DIR:-${HOME}/projects}"
echo "==> Removing .invoker/ debug log dirs under $WORKSPACE_DIR_VAL"
if [ -d "$WORKSPACE_DIR_VAL" ]; then
    find "$WORKSPACE_DIR_VAL" -type d -name '.invoker' -prune -exec rm -rf {} + 2>/dev/null || true
    echo "    done"
else
    echo "    workspace dir not present — skipping"
fi

# --- step 5: pull + rebuild + start ---------------------------------------
echo "==> Pulling base images"
docker compose pull || true
echo "==> Building + starting the new image"
docker compose up -d --build

# --- step 6: tail logs and probe health ------------------------------------
echo "==> Tailing the last 50 lines of the openclaw container log"
docker compose logs --tail 50 openclaw || true

echo
echo "==> Probing http://127.0.0.1:7878/api/health (sanity check)"
HEALTH_OK=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 http://127.0.0.1:7878/api/health >/dev/null 2>&1; then
        echo "    /api/health responded on attempt ${attempt}"
        HEALTH_OK=1
        break
    fi
    sleep 2
done
if [ "$HEALTH_OK" = "1" ]; then
    if command -v jq >/dev/null 2>&1; then
        curl -fsS http://127.0.0.1:7878/api/health | jq . || true
    else
        curl -fsS http://127.0.0.1:7878/api/health || true
    fi
    echo
    echo "==> Cutover complete."
else
    echo "    /api/health did not respond after 10 attempts — inspect logs:"
    echo "    docker compose logs -f openclaw"
    exit 1
fi
