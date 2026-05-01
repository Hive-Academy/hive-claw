# CLAUDE.md — architecture context for future agents

This repo is **openclaw-control**: a multi-machine, multi-agent control plane built on top of the OpenClaw gateway and ptah-cli. Future agents working in this codebase should understand:

## Two tiers, one container

- **Gateway tier** (`:18789`) — original OpenClaw gateway. Single agent, single workspace, plugins (canvas, browser, talk-voice). Code lives in `openclaw` npm package; we configure it via `config/openclaw.json.tmpl` rendered by `entrypoint.sh`.
- **Control plane tier** (`:7878`) — Fastify daemon + Angular dashboard + multi-agent Discord bot-bridge. Code lives in `openclaw-control/{daemon,dashboard,bot-bridge}/`. Started by `entrypoint-control.sh`, which `entrypoint.sh` execs after the gateway is up. The daemon owns a SQLite database at `/data/specs.db` **on the leader only**; followers run the same daemon binary in HTTP-client mode pointed at `OPENCLAW_LEADER_URL` and authenticated with `OPENCLAW_INTERNAL_TOKEN`.

Both run inside the same Docker container. `docker-compose.yml` is the composition.

## Multi-machine topology

Each physical machine runs the same image. They differ only in `.env`:

- Exactly **one** machine sets `OPENCLAW_LEADER=1`. That machine opens `/data/specs.db` (better-sqlite3, WAL mode) and runs the **continuation loop** (`daemon/src/continuation.ts`) which walks tasks through phases (`CONTEXT → DESCRIPTION → PLAN → … → DONE`) and inserts new dispatch rows. The leader also runs the **dispatch worker** (`daemon/src/dispatch.ts`) for any agents in its own `OPENCLAW_LOCAL_AGENT_IDS` — calling the repo directly on the local DB.
- **Followers** (every other machine) set `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL=https://leader…`. The follower's daemon never opens a DB. It runs only the dispatch worker, which:
  - subscribes to `GET /api/stream?topics=dispatch` on the leader (SSE) for `dispatch.pending` push notifications,
  - lists candidates via `GET /api/dispatches/pending?agentId=…`,
  - claims via `POST /api/dispatches/:id/claim` (the atomic linearization point — see `docs/ARCHITECTURE.md`),
  - reports completion via `POST /api/dispatches/:id/done`.
- All HTTP calls between follower and leader carry `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`.

There is no shared filesystem, no git clone, and no periodic sync. The leader's DB is the single source of truth for projects, tasks, task files, dispatches, dispatch logs, and shared memory.

## Persona privacy rule

There are two storage backends in `daemon/src/memory.ts`:

- **shared** = SQLite `memory_files` table on the leader, served via `/api/memories/:scope/:id/:file`. Holds public agent bios (`agents/<id>/identity.md`), Discord user profiles, thread context, project notes. Followers read/write via HTTP.
- **local** = `~/.claude/local-memory/...` → bind-mounted, NEVER synced, NEVER sent over HTTP.

`PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}` are routed to the local backend whenever `scope=agents`; everything else goes to shared. Writes under `agents/<id>/*` are 403'd unless `<id> ∈ OPENCLAW_LOCAL_AGENT_IDS` (ownership check).

The privacy invariant is enforced at three layers — defense in depth:

1. **`resolveBackend()` in `daemon/src/memory.ts`** routes any `(scope='agents', file ∈ PRIVATE_AGENT_FILES)` to `localAgentDir(id)` on the local FS. The DB never sees these filenames.
2. **HTTP gate in `daemon/src/api.ts`** runs *before* any DB call: PUT/DELETE on `/api/memories/agents/:id/<private-file>` returns 403; GET on the same URL returns **404 (not 403)** — deliberately, so an attacker cannot distinguish "persona exists, you can't have it" from "no such file".
3. **`MemoryRepo.write` / `MemoryRepo.delete` in `daemon/src/db/memory.ts`** synchronously throws if any caller smuggles a private filename past the chokepoint. This is belt-and-braces: a programming error becomes a hard crash, not a silent leak.

The bot-bridge skips any agent whose `local-memory/agents/<id>/persona.md` is missing.

## Auth

Three doors into the daemon:

- Browser: Discord OAuth → JWT cookie (`OPENCLAW_JWT_SECRET` signs).
- Bot-bridge / dispatched agents / followers calling the leader: `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`.
- localhost dev fallback when `DISCORD_CLIENT_ID` is empty: anonymous `local-dev` user. Loopback only.

## Where to look

- Operational doc: `docs/OPENCLAW_CONTROL.md` (the canonical landing).
- Operations playbook: `docs/OPERATIONS.md` (daily SQL one-liners, backups, schema, disaster recovery, SSE event taxonomy).
- Architecture: `docs/ARCHITECTURE.md` (multi-machine topology + container internals + linearization point).
- Setup: `docs/SETUP.md` (linear flow — leader picks `OPENCLAW_LEADER=1`, followers point `OPENCLAW_LEADER_URL` at it).
- Config: `docs/CONFIGURATION.md` (every env var; gateway and control plane in separate sections).
- Persona: `docs/SKILLS-AND-PERSONA.md` (workspace persona vs registered-agent persona).
- Security: `docs/SECURITY.md` (threat model, persona privacy invariant, DB-at-rest caveat).
- Troubleshooting: `docs/TROUBLESHOOTING.md`.

When code disagrees with docs, code wins — open a PR. When making non-trivial changes to architecture, update both `docs/OPENCLAW_CONTROL.md` and this file.
