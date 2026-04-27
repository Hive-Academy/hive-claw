#!/usr/bin/env bash
# openclaw-init-project.sh — scaffold per-project openclaw config under <project-dir>/.openclaw/
#
# Usage:
#   bin/openclaw-init-project.sh <project-name>
#   bin/openclaw-init-project.sh ~/projects/foo
#
# Creates:
#   <dir>/.openclaw/
#     persona.md         — project-specific persona override (optional, prepended to global SOUL.md)
#     HEARTBEAT.md       — project-specific recurring tasks (read every heartbeat tick)
#     skills/            — project-only skills (markdown files, same format as global skills)
#     agents/            — project-only sub-agents (markdown definitions)
#     README.md          — what this folder does

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <project-name | absolute-path>"
    echo
    echo "Examples:"
    echo "  $0 my-app                  # creates \$WORKSPACE_DIR/my-app/.openclaw/"
    echo "  $0 ~/projects/foo          # creates ~/projects/foo/.openclaw/"
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
    echo "Project dir does not exist: $PROJ_DIR"
    echo "Create it first (e.g. clone a repo into it), then re-run."
    exit 1
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
