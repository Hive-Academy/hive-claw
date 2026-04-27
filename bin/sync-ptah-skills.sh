#!/usr/bin/env bash
# sync-ptah-skills.sh — refresh ./skills and ./commands from your local Ptah harness.
#
# Run this whenever you update Ptah skills locally and want to bring the
# changes into this OpenClaw setup.
#
# Resolves all symlinks and copies real files (so the repo stays portable).
# Skills/commands you don't want re-synced should be removed from the
# WHITELIST below or kept in a separate folder.

set -euo pipefail

cd "$(dirname "$0")/.."

PTAH_CORE="$HOME/.ptah/plugins/ptah-core"
PTAH_ANGULAR="$HOME/.ptah/plugins/ptah-angular"

if [ ! -d "$PTAH_CORE" ]; then
    echo "Ptah not installed at $PTAH_CORE — nothing to sync."
    echo "Skills/commands already in ./skills and ./commands remain untouched."
    exit 0
fi

# Customize these to match what you want available inside OpenClaw.
SKILLS_FROM_CORE=(orchestration ddd-architecture ui-ux-designer technical-content-writer skill-creator)
SKILLS_FROM_ANGULAR=(angular-frontend-patterns angular-3d-scene-crafter angular-gsap-animation-crafter)
COMMANDS=(orchestrate orchestrate-help review-code review-logic review-security)

mkdir -p skills commands

echo "Syncing skills from Ptah → ./skills/"
for name in "${SKILLS_FROM_CORE[@]}"; do
    src="$PTAH_CORE/skills/$name"
    [ -d "$src" ] || { echo "  - $name (missing in Ptah, skipped)"; continue; }
    rm -rf "skills/$name"
    cp -aL "$src" "skills/$name"
    echo "  ✓ $name"
done

if [ -d "$PTAH_ANGULAR" ]; then
    for name in "${SKILLS_FROM_ANGULAR[@]}"; do
        src="$PTAH_ANGULAR/skills/$name"
        [ -d "$src" ] || { echo "  - $name (missing in Ptah, skipped)"; continue; }
        rm -rf "skills/$name"
        cp -aL "$src" "skills/$name"
        echo "  ✓ $name"
    done
fi

echo
echo "Syncing commands from Ptah → ./commands/"
for name in "${COMMANDS[@]}"; do
    src="$PTAH_CORE/commands/$name.md"
    [ -f "$src" ] || { echo "  - $name (missing in Ptah, skipped)"; continue; }
    cp -aL "$src" "commands/$name.md"
    echo "  ✓ $name.md"
done

echo
echo "Sync complete. Commit the changes if you want them shared:"
echo "  git add skills commands && git commit -m 'refresh skills from ptah'"
