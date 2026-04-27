#!/usr/bin/env bash
# openclaw-init-project.sh — scaffold per-project openclaw config under <project-dir>/.openclaw/
#
# Usage:
#   bin/openclaw-init-project.sh <project-name>
#   bin/openclaw-init-project.sh ~/projects/foo
#   bin/openclaw-init-project.sh --with-ptah <project-name>   # also runs `ptah new-project` wizard inside the container
#
# Creates:
#   <dir>/.openclaw/
#     persona.md         — project-specific persona override (optional, prepended to global SOUL.md)
#     HEARTBEAT.md       — project-specific recurring tasks (read every heartbeat tick)
#     skills/            — project-only skills (markdown files, same format as global skills)
#     agents/            — project-only sub-agents (markdown definitions)
#     README.md          — what this folder does

set -euo pipefail

WITH_PTAH=0
if [ "${1:-}" = "--with-ptah" ]; then
    WITH_PTAH=1
    shift
fi

if [ $# -lt 1 ]; then
    echo "Usage: $0 [--with-ptah] <project-name | absolute-path>"
    echo
    echo "Examples:"
    echo "  $0 my-app                       # creates \$WORKSPACE_DIR/my-app/.openclaw/"
    echo "  $0 ~/projects/foo               # creates ~/projects/foo/.openclaw/"
    echo "  $0 --with-ptah my-app           # runs Ptah wizard, then drops .openclaw/ on top"
    exit 1
fi

ARG="$1"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/projects}"

if [[ "$ARG" == /* ]] || [[ "$ARG" == ~* ]]; then
    PROJ_DIR="${ARG/#\~/$HOME}"
else
    PROJ_DIR="$WORKSPACE_DIR/$ARG"
fi

if [ ! -d "$PROJ_DIR" ]; then
    if [ "$WITH_PTAH" -eq 1 ]; then
        echo "Project dir does not exist: $PROJ_DIR — creating (Ptah wizard will populate it)."
        mkdir -p "$PROJ_DIR"
    else
        echo "Project dir does not exist: $PROJ_DIR"
        echo "Create it first (e.g. clone a repo into it), then re-run."
        echo "Or pass --with-ptah to scaffold from scratch via the Ptah wizard."
        exit 1
    fi
fi

# --- Optional: scaffold a full Ptah harness before laying down .openclaw/ ----
# This is the agent's path: ptah-cli generates the harness (subagents, skills,
# MCP servers) inside the project directory using the SAME ~/.ptah config the
# host's desktop app uses.
if [ "$WITH_PTAH" -eq 1 ]; then
    if docker compose ps --status running --services 2>/dev/null | grep -q '^openclaw$'; then
        IN_CONTAINER_PATH="/home/agent/.openclaw/workspace/$(basename "$PROJ_DIR")"

        echo "→ Step 1/3: ptah harness init  (creates .ptah/ with subagents + skills)"
        docker compose exec -w "$IN_CONTAINER_PATH" openclaw \
            ptah harness init --dir . || true

        echo "→ Step 2/3: ptah new-project select-type  (stack discovery wizard)"
        echo "  (Anubis or you will answer the prompts; output written to answers.json)"
        docker compose exec -w "$IN_CONTAINER_PATH" openclaw \
            ptah new-project select-type --human || true

        echo
        echo "  Step 3/3 — finish the wizard from inside the container:"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah new-project submit-answers --file answers.json"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah new-project get-plan"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah new-project approve-plan"
        echo
        echo "  After the plan is approved, install skills & MCP servers as needed:"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah harness install-skill <name>"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah plugin enable <mcp-server>"
        echo "    docker compose exec -w '$IN_CONTAINER_PATH' openclaw ptah agent packs install <pack>"
        echo
    else
        echo "WARN: openclaw container not running — skipping Ptah harness scaffold."
        echo "      Start the stack (docker compose up -d) and re-run with --with-ptah."
    fi
fi

OC_DIR="$PROJ_DIR/.openclaw"

if [ -e "$OC_DIR" ]; then
    echo "Already initialized: $OC_DIR"
    echo "Skipping. Edit files inside that folder to customize."
    exit 0
fi

mkdir -p "$OC_DIR/skills" "$OC_DIR/agents"

cat > "$OC_DIR/persona.md" <<'EOF'
# Project persona override

This file is OPTIONAL. If present, it is prepended to the global persona for
this project. Use it to give the agent a different voice, focus, or constraints
when working in this specific project.

Example:

> When working in this project (a NestJS backend), be concise and pragmatic.
> Always check `package.json` before suggesting dependencies. Run tests via
> `pnpm test` not `npm test`.
EOF

cat > "$OC_DIR/HEARTBEAT.md" <<'EOF'
# Project HEARTBEAT

Tasks the agent should check on every heartbeat tick while working in this
project. Keep it short — long lists waste tokens on every cycle.

Reply `HEARTBEAT_OK` if nothing here needs attention.

## Active tasks

(none)
EOF

cat > "$OC_DIR/README.md" <<'EOF'
# .openclaw/ — per-project agent config

Files here override or supplement the global agent config when the agent's
working directory is this project.

- `persona.md`     — project-specific persona (optional)
- `HEARTBEAT.md`   — periodic tasks the agent should track in this project
- `skills/`        — markdown skill definitions only loaded inside this project
- `agents/`        — sub-agent definitions for project-specific personas

Files here are version-controlled with the project (commit them to git so the
team — human and agent — share the same instructions).
EOF

echo "✓ Initialized $OC_DIR"
echo
echo "Next steps:"
echo "  1. Edit $OC_DIR/persona.md  — describe how the agent should behave here"
echo "  2. Add skills under $OC_DIR/skills/  (markdown files)"
echo "  3. Commit .openclaw/ to git so it travels with the project"
