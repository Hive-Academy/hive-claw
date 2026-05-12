#!/usr/bin/env bash
# scripts/cutover-rollback.sh — TASK_2026_006 Batch 9 deliverable.
#
# Operator escape hatch for the Batch 10 cutover. Restores the gateway
# container's /home/agent/.openclaw/openclaw.json from a pre-cutover
# snapshot (`openclaw.json.bak.*`), restarts openclaw, waits for the
# gateway healthcheck, and reports.
#
# This script is NON-DESTRUCTIVE except for the act of overwriting the
# currently-running openclaw.json with the snapshot you choose. It refuses
# to run if no snapshot is available.
#
# Usage:
#   scripts/cutover-rollback.sh                 # interactive, latest snapshot
#   scripts/cutover-rollback.sh --yes           # latest snapshot, no prompt
#   scripts/cutover-rollback.sh --auto          # non-interactive (alias for --yes)
#   scripts/cutover-rollback.sh --snapshot openclaw.json.bak.20260512-141200
#   scripts/cutover-rollback.sh --help
#
# Exit codes:
#   0   rollback completed, gateway healthy
#   1   usage / arg error
#   2   no snapshot available (refuse to run)
#   3   restore copy failed
#   4   gateway restart failed
#   5   gateway did not become healthy within timeout

set -euo pipefail

GATEWAY_CONTAINER="${OPENCLAW_GATEWAY_CONTAINER:-openclaw-gateway}"
CONFIG_DIR_IN_CONTAINER="/home/agent/.openclaw"
CONFIG_PATH_IN_CONTAINER="${CONFIG_DIR_IN_CONTAINER}/openclaw.json"
HEALTH_URL_IN_CONTAINER="http://127.0.0.1:18789/health"
HEALTH_TIMEOUT_SECONDS=60

SNAPSHOT=""
ASSUME_YES=0

usage() {
    cat <<'EOF'
cutover-rollback.sh — restore openclaw.json from a pre-cutover snapshot and restart the gateway.

USAGE:
    scripts/cutover-rollback.sh [OPTIONS]

OPTIONS:
    --snapshot <name>   Use a specific snapshot file inside the gateway container.
                        Name only (e.g. openclaw.json.bak.20260512-141200), located in
                        /home/agent/.openclaw/. If omitted, the most recent
                        openclaw.json.bak.* in that directory is used.
    --yes               Skip the confirmation prompt and proceed.
    --auto              Alias for --yes (for non-interactive callers / cron).
    -h, --help          Show this help and exit.

ENVIRONMENT:
    OPENCLAW_GATEWAY_CONTAINER   Override the gateway container name
                                 (default: openclaw-gateway).

WHAT IT DOES:
    1. Discover the chosen snapshot inside ${GATEWAY_CONTAINER:-openclaw-gateway}.
    2. Print the planned actions; prompt unless --yes/--auto.
    3. cp the snapshot over /home/agent/.openclaw/openclaw.json in the container.
    4. docker exec ${GATEWAY_CONTAINER:-openclaw-gateway} openclaw gateway restart
       (falls back to `docker restart` if the CLI restart fails).
    5. Poll http://127.0.0.1:18789/health from inside the container until it
       returns 200, up to 60s.
    6. Report status and exit.

SAFETY:
    - Refuses to run if no openclaw.json.bak.* snapshot exists.
    - set -euo pipefail throughout; a failure at any step exits non-zero.
    - Does NOT touch ~/.env, docker-compose.yml, the daemon, or the
      bot-bridge process. The operator handles those separately per the
      runbook (docs/CUTOVER_RUNBOOK.md).

EXIT CODES:
    0   rollback completed, gateway healthy
    1   usage / arg error
    2   no snapshot available
    3   restore copy failed
    4   gateway restart failed
    5   gateway did not become healthy within timeout
EOF
}

# ---- parse args ----
while [ $# -gt 0 ]; do
    case "$1" in
        --snapshot)
            [ $# -ge 2 ] || { echo "error: --snapshot requires a value" >&2; exit 1; }
            SNAPSHOT="$2"
            shift 2
            ;;
        --yes|--auto)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            echo "run: $0 --help" >&2
            exit 1
            ;;
    esac
done

# ---- preflight: container must be running ----
if ! docker inspect -f '{{.State.Running}}' "$GATEWAY_CONTAINER" 2>/dev/null | grep -q true; then
    echo "error: container '$GATEWAY_CONTAINER' is not running." >&2
    echo "  Start it first (docker compose up -d openclaw-gateway) or set OPENCLAW_GATEWAY_CONTAINER." >&2
    exit 1
fi

# ---- discover snapshot ----
if [ -z "$SNAPSHOT" ]; then
    # List backups, newest first by name (timestamps are lexicographically sortable).
    SNAPSHOT="$(docker exec "$GATEWAY_CONTAINER" sh -c \
        "ls -1 ${CONFIG_DIR_IN_CONTAINER}/openclaw.json.bak.* 2>/dev/null | sort -r | head -n 1" \
        || true)"
    SNAPSHOT="$(basename "${SNAPSHOT:-}")"
fi

if [ -z "$SNAPSHOT" ]; then
    cat >&2 <<EOF
error: no openclaw.json.bak.* snapshot found in ${CONFIG_DIR_IN_CONTAINER}/
       inside container '$GATEWAY_CONTAINER'.

The cutover runbook (docs/CUTOVER_RUNBOOK.md, pre-cutover step 3) requires
the operator to take a snapshot BEFORE running the cutover, e.g.:

    docker exec $GATEWAY_CONTAINER sh -c \\
        'cp ${CONFIG_PATH_IN_CONTAINER} ${CONFIG_PATH_IN_CONTAINER}.bak.\$(date -u +%Y%m%d-%H%M%S)'

Refusing to roll back: nothing to restore from.
EOF
    exit 2
fi

SNAPSHOT_PATH="${CONFIG_DIR_IN_CONTAINER}/${SNAPSHOT}"

# Verify snapshot exists + is valid JSON.
if ! docker exec "$GATEWAY_CONTAINER" sh -c "[ -f '$SNAPSHOT_PATH' ]" 2>/dev/null; then
    echo "error: snapshot '$SNAPSHOT_PATH' does not exist in container '$GATEWAY_CONTAINER'." >&2
    exit 2
fi
if ! docker exec "$GATEWAY_CONTAINER" jq empty "$SNAPSHOT_PATH" >/dev/null 2>&1; then
    echo "error: snapshot '$SNAPSHOT_PATH' is not valid JSON. Refusing to install garbage." >&2
    exit 2
fi

# ---- plan + confirm ----
cat <<EOF
==> cutover-rollback plan
    Gateway container:  $GATEWAY_CONTAINER
    Snapshot to restore: $SNAPSHOT_PATH
    Restoring to:       $CONFIG_PATH_IN_CONTAINER
    Restart method:     openclaw gateway restart (fallback: docker restart)
    Health check:       $HEALTH_URL_IN_CONTAINER  (timeout ${HEALTH_TIMEOUT_SECONDS}s)
EOF

if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Proceed with rollback? [y/N] " REPLY
    case "${REPLY:-}" in
        y|Y|yes|YES) : ;;
        *) echo "Aborted by operator — no changes made."; exit 0 ;;
    esac
fi

# ---- step 1: stash the current openclaw.json (the broken / cut-over one) ----
FAIL_BACKUP_NAME="openclaw.json.failed.$(date -u +%Y%m%d-%H%M%S)"
echo "==> Stashing current $CONFIG_PATH_IN_CONTAINER → ${CONFIG_DIR_IN_CONTAINER}/${FAIL_BACKUP_NAME}"
if ! docker exec "$GATEWAY_CONTAINER" sh -c \
        "[ -f '$CONFIG_PATH_IN_CONTAINER' ] && cp '$CONFIG_PATH_IN_CONTAINER' '${CONFIG_DIR_IN_CONTAINER}/${FAIL_BACKUP_NAME}' || true" \
        2>/dev/null; then
    echo "warning: could not stash current config (continuing anyway)" >&2
fi

# ---- step 2: restore the snapshot ----
echo "==> Restoring $SNAPSHOT_PATH → $CONFIG_PATH_IN_CONTAINER"
if ! docker exec "$GATEWAY_CONTAINER" cp "$SNAPSHOT_PATH" "$CONFIG_PATH_IN_CONTAINER"; then
    echo "error: failed to copy snapshot back to $CONFIG_PATH_IN_CONTAINER." >&2
    exit 3
fi

# ---- step 3: restart openclaw ----
echo "==> Restarting openclaw via 'openclaw gateway restart' inside the container"
RESTART_OK=0
if docker exec "$GATEWAY_CONTAINER" timeout 30 openclaw gateway restart >/dev/null 2>&1; then
    RESTART_OK=1
else
    echo "    'openclaw gateway restart' failed or timed out — falling back to 'docker restart $GATEWAY_CONTAINER'"
    if docker restart "$GATEWAY_CONTAINER" >/dev/null 2>&1; then
        RESTART_OK=1
    fi
fi
if [ "$RESTART_OK" -ne 1 ]; then
    echo "error: gateway restart failed by both methods." >&2
    exit 4
fi

# ---- step 4: poll health ----
echo "==> Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for gateway healthcheck"
HEALTH_OK=0
ELAPSED=0
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if docker exec "$GATEWAY_CONTAINER" curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL_IN_CONTAINER" 2>/dev/null; then
        HEALTH_OK=1
        break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
done

if [ "$HEALTH_OK" -ne 1 ]; then
    echo "error: gateway did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s." >&2
    echo "  Inspect logs:  docker logs --tail 100 $GATEWAY_CONTAINER" >&2
    exit 5
fi

cat <<EOF
==> Rollback complete.
    Restored:           $SNAPSHOT_PATH
    Previous (broken):  ${CONFIG_DIR_IN_CONTAINER}/${FAIL_BACKUP_NAME}
    Gateway:            healthy on :18789

Next steps (per docs/CUTOVER_RUNBOOK.md, Rollback section):
  - Restart the OLD bot-bridge process if it was stopped during cutover.
  - Verify Anubis (and any other old-config agents) responds on Discord.
  - File a post-mortem; do NOT retry batch 10 until root cause is understood.
EOF
exit 0
