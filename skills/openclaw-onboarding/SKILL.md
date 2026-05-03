---
name: openclaw-onboarding
description: Compressed working memory of docs/SETUP.md, docs/CONFIGURATION.md, and docs/OPERATIONS.md. Use when an operator is bringing up hive-claw from zero, adding a follower machine, or diagnosing first-boot failure. Anchors every step to a file path or endpoint the operator can verify.
---

# openclaw-onboarding skill

This skill is the persona's compressed working memory of how openclaw-control
comes up from cold. Every claim here is anchored to a file path the persona
can re-read at runtime. When the operator is in setup, route through this
skill first; when an answer is uncertain, re-read the cited file before
speaking.

## The two tiers in one container

The Docker image runs two HTTP servers:

- **Gateway tier** on `:18789`. Original OpenClaw gateway. Single-agent,
  single-workspace, plugins (canvas, browser, talk-voice). Configured by
  `config/openclaw.json.tmpl` rendered by `entrypoint.sh`.
- **Control plane tier** on `:7878`. Fastify daemon + Angular dashboard +
  multi-agent Discord bot-bridge. Started by `entrypoint-control.sh`,
  which `entrypoint.sh` exec's after the gateway is up.

When the operator says "openclaw is down," disambiguate which tier. The
gateway can be healthy while the control plane is broken, and the reverse.
Health checks: gateway exposes its own; control plane exposes
`GET /api/health` (daemon) and `GET /health` (bot-bridge, host port).

## The three control-plane packages

Source under `openclaw-control/`:

- `daemon/` — Fastify HTTP server. Owns the SQLite database
  (`/data/specs.db`, better-sqlite3, WAL mode) **on the leader only**. Runs
  the continuation loop (`daemon/src/continuation.ts`) and dispatch worker
  (`daemon/src/dispatch.ts`). The follower's daemon never opens a DB.
- `bot-bridge/` — Discord client + chat-tier persona runtime. Drives the
  OpenAI-compatible tool-calling loop. Spawns sub-chats via
  `subagentRunner.run()` (NOT `ptah --profile`). Hot-reloads on Redis
  `harness/sync` events.
- `dashboard/` — Angular UI. Talks to the daemon over HTTP + SSE.

All three run in every container. Their roles diverge based on
`OPENCLAW_LEADER`.

## Leader vs follower topology

Every machine runs the same image. Configuration distinguishes them:

| Env var | Leader | Follower |
|---|---|---|
| `OPENCLAW_LEADER` | `1` | `0` |
| `OPENCLAW_LEADER_URL` | unset / self | `https://leader.example.com` |
| `OPENCLAW_INTERNAL_TOKEN` | required (signs internal HTTP) | required (matches leader) |
| `OPENCLAW_LOCAL_AGENT_IDS` | comma-sep list of agent ids on this host | comma-sep list of agent ids on this host |
| DB path `/data/specs.db` | opened, WAL mode | never opened |

Exactly one machine sets `OPENCLAW_LEADER=1`. There is no shared filesystem,
no git clone, no periodic sync. The leader's DB is the single source of
truth for projects, tasks, task files, dispatches, dispatch logs, and
shared memory.

Internal HTTP between follower and leader carries
`Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`. The atomic linearization
point is `POST /api/dispatches/:id/claim` — see `docs/ARCHITECTURE.md` for
the multi-claimant race semantics.

## Where to look first when something is broken

In order, by likely root cause:

1. **Container logs.** `docker compose logs openclaw --tail=200`. The
   gateway logs and the control-plane logs interleave; both go to stdout.
2. **Daemon health.** `curl localhost:7878/api/health`. If 5xx, the daemon
   is alive but degraded; the response body names the failing subsystem.
3. **Bot-bridge health.** `curl localhost:7879/health` (or whichever host
   port `BOT_BRIDGE_PORT` maps to). If unreachable, the bot-bridge crashed
   on startup — usually a missing persona file (the bot-bridge skips any
   agent whose `local-memory/agents/<id>/persona.md` is missing, which is
   not an error, but skipping every agent leaves it idle).
4. **Leader DB.** On the leader only, `sqlite3 /data/specs.db
   '.tables'`. If `dispatches` and `tasks` are missing, migrations did not
   run; check daemon startup logs.
5. **Dashboard 401.** Discord OAuth not configured. Either set
   `DISCORD_CLIENT_ID` etc. or, for loopback dev, leave them empty and the
   daemon falls back to the anonymous `local-dev` user.

The full SQL one-liner playbook lives in `docs/OPERATIONS.md`. When the
operator describes a state question ("how many dispatches are pending?",
"which agents are claimed right now?"), reach for that file first.

## The persona-privacy invariant in plain English

Two storage backends in `daemon/src/memory.ts`:

- **Shared.** SQLite `memory_files` table on the leader, served via
  `/api/memories/:scope/:id/:file`. Holds public agent bios
  (`agents/<id>/identity.md`), Discord user profiles, thread context,
  project notes. Followers read/write via HTTP.
- **Local.** `~/.claude/local-memory/...` on the host, bind-mounted into
  the container. Never synced. Never sent over HTTP.

The set `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json,
secrets.json}` always routes to local backend when `scope=agents`.
Everything else goes to shared. Writes under `agents/<id>/*` are 403'd
unless `<id>` is in `OPENCLAW_LOCAL_AGENT_IDS` on the writing machine.

The defense is in four layers (`docs/SECURITY.md` enumerates them):
`resolveBackend` routes; the HTTP gate in `daemon/src/api.ts` returns 404
on private-file reads (deliberately not 403, to deny existence
oracle); `MemoryRepo.write/delete` throws on private filenames as
belt-and-braces; `assertMaterializedPathSafety` refuses any
materialization output under the local-memory root.

When an operator asks "show me agent X's persona," refuse and cite the
layer that would block it. Identity files are public; personas are not,
even between machines on the same fleet.

## First-boot checklist

For a new leader machine:

1. `.env` has `OPENCLAW_LEADER=1`, `OPENCLAW_INTERNAL_TOKEN` set to a fresh
   random value, `DISCORD_*` configured (or empty for loopback dev).
2. `docker compose up -d`. Wait for both health endpoints.
3. Hit `/api/health` from the host — must be 200.
4. Author a registered agent: write
   `local-memory/agents/<id>/persona.md` (private) and
   `shared-specs/memory/agents/<id>/identity.md` + `harness.yaml` (public).
   Set `OPENCLAW_LOCAL_AGENT_IDS=<id>` and restart.
5. Verify the bot-bridge picked it up: `GET /api/agents` lists the new id.

For a new follower machine:

1. `.env` has `OPENCLAW_LEADER=0`, `OPENCLAW_LEADER_URL=<leader>`,
   `OPENCLAW_INTERNAL_TOKEN` matching the leader's token.
2. `OPENCLAW_LOCAL_AGENT_IDS` lists the agents this follower owns. The
   matching `local-memory/agents/<id>/persona.md` files must exist on this
   host.
3. `docker compose up -d`. The follower's daemon connects to the leader's
   SSE stream at `/api/stream?topics=dispatch` for dispatch push.
4. Verify: `curl -H "Authorization: Bearer $TOKEN"
   $LEADER_URL/api/dispatches/pending?agentId=<id>` returns an array.

When a step fails, name the file or env var that controls it. Do not
proceed past a failure; surface it.
