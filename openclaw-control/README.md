# openclaw-control

Multi-device, multi-agent control plane for OpenClaw. Wraps the orchestration skill into a dashboard + daemon + Discord bot bridge so any registered agent (Anubis, Chappie, …) can pick up tasks, juggle projects, share per-user memory, and hand work to each other.

## What you get

| Component | Path | Role |
|---|---|---|
| **Daemon** | `daemon/` | Fastify on `:7878`. Watches `.ptah/specs/**`, parses orchestration phases, runs the continuation loop, exposes REST + SSE, serves the dashboard, handles Discord OAuth. |
| **Dashboard** | `dashboard/` | Angular 19 standalone-component SPA. Projects → tasks → kanban → task detail with approve/reject buttons. Live sessions feed. Shared-memory editor. Agent panel. |
| **Bot bridge** | `bot-bridge/` | Generic multi-agent Discord process. Spins up one Discord client per agent registered under `~/.claude/shared-memory/agents/`. Routes `!task`, `!approve`, `!handoff`, etc. |
| **Bus** | (Redis) | Cross-agent handoff via `agent:<id>:inbox` pub/sub. Optional — falls back to in-process events if `REDIS_URL` is unset. |
| **TLS proxy** | `Caddyfile` | Caddy on `:80/443` for multi-device access over TLS. |

## How memory works

Three orthogonal axes of memory live under `~/.claude/shared-memory/`:

```
shared-memory/
├── agents/<agent_id>/identity.md          # who the bot is
├── users/<discord_user_id>/profile.md     # who the user is — shared across all bots
├── threads/<channel_id>/recent.md         # what's been said in this thread
└── projects/<project_slug>/notes.md       # what's known about this project
```

When any agent answers a Discord message, the daemon's `buildContextForMessage()` joins all four axes and prepends them to the Claude prompt. That's how Anubis "remembers every Discord user *and* juggles projects."

## How orchestration ties in

Each task lives at `<project>/.ptah/specs/TASK_YYYY_NNN/` (the same layout the orchestration skill produces). The daemon's phase parser reads that directory and decides what's next:

```
CONTEXT → DESCRIPTION → PLAN → PENDING → IN_PROGRESS → IMPLEMENTED → QA_DONE → DONE
```

The **continuation loop** ticks every 30s, finds tasks not at a checkpoint, and dispatches a headless `claude -p` invocation in the project's working directory with the right phase prompt. Checkpoints (`task-description.md`, `implementation-plan.md`, `tasks.md@IMPLEMENTED`) pause the loop until a human or another agent posts an APPROVE through the dashboard or `!approve TASK_X` in Discord.

## How cross-agent handoff works

```
User in Discord ──▶ Anubis classifies ──▶ daemon.createTask() ──▶ TASK_2026_001
Continuation loop dispatches CONTEXT → DESCRIPTION
Anubis hits approval checkpoint
User: "@anubis hand off to chappie"
Anubis: POST /api/tasks/.../handoff { toAgent: 'chappie' }
   → Redis publish agent:chappie:inbox
   → Bot bridge updates chappie status, posts to Discord channel
   → Continuation loop now dispatches with assigned_agent=chappie
```

Adding a new agent = drop a folder under `shared-memory/agents/<id>/` with `identity.md` + `discord.json` + set its token env var. No code changes.

## How it ships

The daemon, dashboard, and bot-bridge are baked into the **same image as the openclaw gateway** and started by the same `entrypoint.sh`. Every agent you register goes through the same container, sees the same shared-memory tree, talks to the same Redis bus.

That means: a future bot you build only needs (a) a folder under `shared-memory/agents/<id>/` and (b) a `DISCORD_TOKEN_<ID>` env var. No new code. No new container.

## Quick start

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env                       # set OPENCLAW_JWT_SECRET, DISCORD_CLIENT_ID/SECRET, DISCORD_TOKEN_*

# 2. Build + bring up the stack (openclaw + openclaw-control + redis)
docker compose up -d --build

# 3. Open the dashboard
open http://127.0.0.1:7878         # local only by default; set OPENCLAW_CONTROL_BIND=0.0.0.0 + TLS for LAN
```

The container exposes:
- `127.0.0.1:18789` — the openclaw gateway (existing)
- `127.0.0.1:7878` — the openclaw-control dashboard + REST + SSE

## Dev mode (no Docker)

```bash
cd openclaw-control/daemon && npm install && OPENCLAW_DISABLE_CONTINUATION=1 npm run dev
# separately:
cd openclaw-control/dashboard && npm install && npm start
```

When `DISCORD_CLIENT_ID` is unset the daemon falls back to a `local-dev` user — fine for localhost-only dev, do not expose to a network.

## Environment

| Var | Purpose |
|-----|---------|
| `OPENCLAW_HOST` / `OPENCLAW_PORT` | bind address for the daemon |
| `OPENCLAW_PROJECT_ROOTS` | colon-separated dirs to scan for `.ptah/specs/` |
| `OPENCLAW_SHARED_MEMORY` | shared-memory tree root |
| `OPENCLAW_AGENTS_ROOT` | where agent identity dirs live |
| `OPENCLAW_JWT_SECRET` | JWT signing secret |
| `OPENCLAW_TICK_MS` | continuation loop interval (default 30000) |
| `OPENCLAW_DISABLE_CONTINUATION` | set to `1` to disable headless dispatching |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_REDIRECT_URI` | OAuth |
| `DISCORD_ALLOWED_USER_IDS` | CSV allowlist; empty = allow any Discord user |
| `DISCORD_TOKEN_<AGENT_ID>` | bot token per agent (override via `discord.json#tokenEnvVar`) |
| `REDIS_URL` | enables cross-agent bus |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | headless invoker config |

## Endpoints (daemon)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | unauthenticated |
| GET | `/auth/discord/login` | redirect to Discord |
| GET | `/auth/discord/callback` | exchanges code, sets JWT cookie |
| GET | `/api/auth/me` | current session user |
| GET | `/api/projects` | list projects with task counts |
| GET | `/api/projects/:slug/tasks` | task summaries |
| GET | `/api/projects/:slug/tasks/:taskId` | full task incl. artifact markdown |
| POST | `/api/tasks` | create task (`{project, description, agentId?, discordUserId?, channelId?}`) |
| POST | `/api/projects/:slug/tasks/:taskId/approve` | record APPROVED/REJECTED for a phase |
| POST | `/api/projects/:slug/tasks/:taskId/handoff` | publish handoff to another agent |
| POST | `/api/continuation/tick` | force one continuation tick |
| GET | `/api/agents` | registered agents |
| GET | `/api/sessions` / `/api/sessions/:projectKey/latest` | live Claude Code session feed |
| `*` | `/api/memories/:scope[/:id[/:file]]` | shared-memory CRUD |
| GET | `/api/stream` | SSE — `task.updated`, `checkpoint.pending`, `agent.handoff`, `session.message`, `invoker.*` |

## Discord commands

```
!help
!projects
!tasks <slug>
!task <slug> <description>
!approve <task-id> [feedback]
!reject <task-id> [feedback]
!handoff <task-id> <agent>
!tick
```

`@<bot>` in any message also triggers the router. Bots only respond in channels listed in `discord.json#channelAllowList` (empty = all channels).

## Status

| Slice | Status |
|-------|--------|
| 1. Read-only daemon (watcher, phase parser, REST, SSE) | ✅ |
| 2. Angular 19 dashboard | ✅ |
| 3. Discord OAuth + JWT | ✅ |
| 4. Continuation loop + headless `claude -p` invoker | ✅ |
| 5. Generic multi-agent Discord bot bridge | ✅ |
| 6. Shared-memory tree + memory editor UI | ✅ |
| 7. Redis bus for cross-agent handoff | ✅ |
| 8. Docker compose + Caddy TLS | ✅ |

End-to-end smoke-tested on the host: daemon serves dashboard, all read endpoints respond, dashboard builds production bundle. Discord OAuth + headless invoker need real tokens / a Claude Code login to fully exercise — both fail gracefully without.
