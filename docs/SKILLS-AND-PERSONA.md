# Skills and persona

How to shape the agent's behavior with markdown files — globally, per-project, and via reusable skills.

---

## The three layers

When the agent processes a message, it assembles context from three layers, in order:

1. **Built-in OpenClaw system prompt** (~28 KB) — describes the agent's tools and protocol. Not user-editable.
2. **Global persona** — files in `~/projects/` (the workspace root). Define the bot's enduring "self".
3. **Per-project persona** — files in `<project>/.openclaw/` if the agent's cwd is inside a project.

Skills come in alongside layers 2 and 3 — they're invokable instructions the agent can pull into its context on demand (or that you can trigger explicitly via slash commands).

---

## Layer 2: global persona (the bot's self)

Lives at `~/projects/`:

| File | Purpose | Edit when |
|---|---|---|
| `IDENTITY.md` | Name, vibe, signature emoji | Renaming the bot, changing its tone broadly |
| `SOUL.md` | Core behavior rules ("be helpful not performative", "earn trust through competence") | Adjusting how the bot acts across all projects |
| `AGENTS.md` | Workspace conventions ("treat this folder as home", session startup behavior) | Changing how the agent organizes its workspace |
| `USER.md` | What the bot knows about you (name, timezone, preferences) | Onboarding the bot, or letting it write to this file over time |
| `TOOLS.md` | Local environment notes (devices, SSH hosts, etc.) | Adding new infrastructure |
| `HEARTBEAT.md` | Global recurring tasks the agent checks every tick | Adding ongoing observation tasks |
| `memory/` | Bot-managed daily memory dumps | Don't edit by hand — the bot owns this |

These files are **seeded from `templates/workspace-seed/`** on first `setup.sh` run when `${WORKSPACE_DIR}` is empty. After that they live on the host and you (or the bot) edit them freely.

### Editing the global persona

```bash
nano ~/projects/IDENTITY.md     # change the bot's name, vibe, emoji
nano ~/projects/SOUL.md         # tweak personality
nano ~/projects/USER.md         # tell it about yourself
```

The agent re-reads these when a session starts (next mention or new TUI invocation). No restart needed.

### Resetting to baseline

If you want to revert to the templates:

```bash
cp templates/workspace-seed/IDENTITY.md ~/projects/IDENTITY.md
# etc.
```

---

## Layer 3: per-project persona override

Each project under `~/projects/<name>/` can have its own `.openclaw/` directory. When the agent's cwd is that project, files there are layered on top of layer 2.

### Initialize a new project

```bash
cd ~/projects && git clone <repo> myapp
~/Desktop/fixing-openclaw/bin/openclaw-init-project.sh myapp
```

Creates:

```
~/projects/myapp/.openclaw/
├── persona.md         # project-specific persona override
├── HEARTBEAT.md       # project-specific recurring tasks
├── skills/            # project-only skills
├── agents/            # project-only sub-agents
└── README.md          # explains the folder
```

### What to put in `persona.md`

Use it for context that's specific to *this* project — tech stack, conventions, gotchas, command conventions. Example:

```markdown
# Anubis in pro-estate

You are working in an Nx monorepo:
- NestJS backend in `apps/api/`
- Angular frontend in `apps/web/`
- Shared types/utilities in `libs/`

Conventions:
- Use `pnpm` not `npm`.
- Run tests via `nx affected --target=test`.
- Never add a dependency without first checking if it duplicates something
  already in `package.json`. Ask before adding.
- All API endpoints must have a corresponding e2e test.

Tone for this project: pragmatic, code-first. Skip pleasantries when
discussing implementation. Always cite file paths in `apps/api/src/...` form.
```

### Commit it with the project

`.openclaw/` is just files. Commit them with your project's git so the team (humans and agent) share the same instructions:

```bash
cd ~/projects/myapp
git add .openclaw/
git commit -m "agent config: persona, conventions, project skills"
```

When a teammate clones the repo and runs the OpenClaw stack on their machine, they get the same persona automatically.

### Per-project HEARTBEAT.md

The agent reads `HEARTBEAT.md` on every heartbeat tick (every few minutes during active conversation). Use it for:

- "Remind me if the test suite has been red for >24h"
- "Check if `package.json` has unmerged changes from main"
- "Watch the deploy log for ERROR lines"

Keep it short — long lists waste tokens on every heartbeat. Empty/comment-only HEARTBEAT.md skips the heartbeat call entirely.

---

## Skills

A skill is a markdown file (or a directory containing `SKILL.md` plus references) that gives the agent reusable, invokable expertise. The agent can recognize when a skill is relevant and pull it into context, or you can invoke it explicitly via a slash command.

### Where skills live

```
~/Desktop/fixing-openclaw/skills/        # ← global skills, bind-mounted into ~/.openclaw/skills/
├── orchestration/
│   ├── SKILL.md
│   └── references/
│       ├── strategies.md
│       ├── agent-catalog.md
│       └── ...
├── ddd-architecture/
├── ui-ux-designer/
├── technical-content-writer/
├── skill-creator/
└── angular-frontend-patterns/

~/projects/<project>/.openclaw/skills/   # ← project-only skills
└── pro-estate-deploy-flow/
    └── SKILL.md
```

Project-specific skills with the same name override globals.

### Skill file format

A simple skill is a single `<name>.md` file. A complex skill is a directory `<name>/` containing `SKILL.md` plus optional `references/` and `assets/` subdirs.

`SKILL.md` minimum format:

```markdown
---
description: One-line description used to decide if this skill is relevant.
---

# <Name> Skill

What this skill does, when to use it, the actual instructions.

## When to use

- Trigger condition 1
- Trigger condition 2

## Instructions

Step-by-step what the agent should do.

## References

(Optional) Links to additional context loaded on demand.
```

The frontmatter `description` is critical — the agent uses it to decide whether to invoke this skill in response to a query.

### Authoring a new skill

You can write skills directly, or use the included `skill-creator` skill to bootstrap one:

```
@anubis-bot use the skill-creator skill to draft a new skill for handling
prisma migrations in the pro-estate project
```

### Importing from Ptah

If you have a Ptah harness installed (skills under `~/.ptah/plugins/ptah-core/skills/`), there's a helper script:

```bash
bin/sync-ptah-skills.sh
```

It copies (not symlinks) the curated set listed in the script's `SKILLS_FROM_CORE` and `SKILLS_FROM_ANGULAR` arrays into `./skills/`. Edit those arrays to choose which skills come across.

After running, commit:

```bash
git add skills commands
git commit -m "refresh skills from ptah"
```

### Disabling a skill

Either delete the file/directory from `skills/` (and `git commit`), or rename it to something openclaw won't load (e.g. `skills/_disabled-foo/`).

---

## Slash commands (future hookup)

The repo includes several Ptah-style commands under `commands/` (orchestrate, review-code, review-logic, review-security). These are reference files for now — wiring them into OpenClaw's slash-command system is a separate piece of work. The `skills/` directory is the active path; commands are kept for future port.

---

## Memory

OpenClaw's memory system writes daily files to `~/projects/memory/YYYY-MM-DD.md`. The agent reads these on session start to remember conversations from prior days.

This is automatic and self-managed. Don't edit memory files by hand — if you do, the agent may notice the inconsistency and act confused. To reset memory completely:

```bash
docker compose down
rm -rf ~/projects/memory/*
docker compose up -d
```

---

## Putting it all together — a typical project flow

1. **Clone a project** into `~/projects/`.
2. **Initialize** its `.openclaw/`:
   ```bash
   bin/openclaw-init-project.sh myproject
   ```
3. **Write the persona** in `~/projects/myproject/.openclaw/persona.md` — what tech stack, what conventions, what tone.
4. **Add project-specific skills** if any: drop `*.md` files in `~/projects/myproject/.openclaw/skills/`.
5. **Commit** `.openclaw/` to the project's git so the team shares it.
6. **Talk to the bot** in Discord or the dashboard:
   ```
   @anubis-bot summarize the architecture in /home/agent/.openclaw/workspace/myproject/
   ```
7. **Iterate** — edit `persona.md` based on how the bot performs, recommit, repeat.

The two-way bind mount means: any file you save in your editor is immediately visible to the bot, and any file the bot writes is immediately visible in your editor. Real human-agent collaboration on the same physical filesystem.
