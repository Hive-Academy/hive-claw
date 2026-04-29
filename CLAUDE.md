# CLAUDE.md — architecture context for future agents

This repo is **openclaw-control**: a multi-machine, multi-agent control plane built on top of the OpenClaw gateway and ptah-cli. Future agents working in this codebase should understand:

## Two tiers, one container

- **Gateway tier** (`:18789`) — original OpenClaw gateway. Single agent, single workspace, plugins (canvas, browser, talk-voice). Code lives in `openclaw` npm package; we configure it via `config/openclaw.json.tmpl` rendered by `entrypoint.sh`.
- **Control plane tier** (`:7878`) — Fastify daemon + Angular dashboard + multi-agent Discord bot-bridge. Code lives in `openclaw-control/{daemon,dashboard,bot-bridge}/`. Started by `entrypoint-control.sh`, which `entrypoint.sh` execs after the gateway is up.

Both run inside the same Docker container. `docker-compose.yml` is the composition.

## Multi-machine topology

Each physical machine runs the same image. They differ only in `.env`:

- Exactly one machine sets `OPENCLAW_LEADER=1`. That machine runs the **continuation loop** (`daemon/src/continuation.ts`) which walks tasks through phases (`CONTEXT → DESCRIPTION → PLAN → … → DONE`) and writes new dispatches.
- All machines run the **dispatch worker** (`daemon/src/dispatch.ts`) which claims dispatches addressed to its `OPENCLAW_LOCAL_AGENT_IDS` via atomic git rename + push.

Inter-machine state lives in a **private GitHub repo** (`OPENCLAW_SPECS_REPO_URL`), cloned to `~/.claude/shared-specs/` and synced every 15s. Layout:

```
shared-specs/
├── specs/<project>/TASK_YYYY_NNN/
│   ├── context.md (YAML frontmatter)
│   ├── task-description.md, implementation-plan.md, tasks.md
│   └── .dispatch/{pending,taken,done}/<id>.json   ← the queue
└── memory/{agents,users,threads,projects}/<id>/   ← shared context
```

## Persona privacy rule

There are two storage backends in `daemon/src/memory.ts`:

- **shared** = `~/.claude/shared-specs/memory/...` → committed + pushed
- **local** = `~/.claude/local-memory/...` → bind-mounted, NEVER synced

`PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}` are routed to local; everything else goes to shared. Writes under `agents/<id>/*` are 403'd unless `<id> ∈ OPENCLAW_LOCAL_AGENT_IDS` (ownership check).

The bot-bridge skips any agent whose `local-memory/agents/<id>/persona.md` is missing.

## Auth

Three doors into the daemon:

- Browser: Discord OAuth → JWT cookie (`OPENCLAW_JWT_SECRET` signs).
- Bot-bridge / dispatched agents: `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`.
- localhost dev fallback when `DISCORD_CLIENT_ID` is empty: anonymous `local-dev` user. Loopback only.

## Where to look

- Operational doc: `docs/OPENCLAW_CONTROL.md` (the canonical landing).
- Architecture: `docs/ARCHITECTURE.md` (multi-machine topology + container internals).
- Setup: `docs/SETUP.md` (forks into leader vs follower).
- Config: `docs/CONFIGURATION.md` (every env var; gateway and control plane in separate sections).
- Persona: `docs/SKILLS-AND-PERSONA.md` (workspace persona vs registered-agent persona).
- Security: `docs/SECURITY.md` (threat model + persona privacy invariant).
- Troubleshooting: `docs/TROUBLESHOOTING.md`.

When code disagrees with docs, code wins — open a PR. When making non-trivial changes to architecture, update both `docs/OPENCLAW_CONTROL.md` and this file.
