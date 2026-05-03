---
name: openclaw-onboarding
description: Compressed working memory of docs/SETUP.md, docs/CONFIGURATION.md, and docs/OPERATIONS.md. Use when an operator is bringing up hive-claw from zero, adding a follower machine, or diagnosing first-boot failure. Anchors every step to a file path or endpoint the operator can verify.
---

# openclaw-onboarding skill

This skill compresses the operator runbook in `docs/PLAYBOOKS.md` Runbook A
(first-boot leader, add-a-follower). When the operator asks for a step-by-step
procedure, point them at `docs/PLAYBOOKS.md`; this skill is for the persona to
*understand* the workflow well enough to *guide* the operator through it.

The persona's job is diagnosis and correction, not execution. Where a step
requires a host-side action (editing `.env`, running `docker compose`, curling
`/api/agents/<id>/harness/sync`), the persona names the action and the file or
endpoint involved — it does not pretend to perform it. See "Operator-action vs
persona-action boundary" below.

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

## The four `.env` keys that distinguish leader from follower

| Env var | Leader | Follower |
|---|---|---|
| `OPENCLAW_LEADER` | `1` | `0` |
| `OPENCLAW_LEADER_URL` | unset / self | `https://leader.example.com` |
| `OPENCLAW_INTERNAL_TOKEN` | required (signs internal HTTP) | required (matches leader) |
| `OPENCLAW_LOCAL_AGENT_IDS` | comma-sep list of agent ids on this host | comma-sep list of agent ids on this host |

Exactly one machine sets `OPENCLAW_LEADER=1`. The leader's DB at
`/data/specs.db` is the single source of truth for projects, tasks, task
files, dispatches, dispatch logs, and shared memory. Followers never open a
DB. Internal HTTP between follower and leader carries
`Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`. The atomic linearization
point is `POST /api/dispatches/:id/claim` — see `docs/ARCHITECTURE.md` for
the multi-claimant race semantics.

## The `local-memory/` trap

Two directories share the name `local-memory/` and confuse new operators.
Distinguish them every time the operator mentions either:

- **Repo `local-memory/`** at `<repo-root>/local-memory/`. Gitignored.
  Source of truth for private agent files (`agents/<id>/persona.md`,
  `agents/<id>/secrets.md`) on the host. The operator edits files here.
- **Runtime `~/.claude/local-memory/`** on the host home directory.
  Bind-mounted into the container at the path `daemon/src/memory.ts`
  resolves via `localAgentDir(id)`. The daemon reads private files from
  here.

Whether the bind-mount maps the repo directory or the home directory is
controlled by `OPENCLAW_HOST_HOME` and the `volumes:` block in
`docker-compose.yml`. When the operator says "I edited persona.md but the
agent didn't pick it up," the first hypothesis is that the file lives in the
wrong directory. Confirm both paths before suggesting a fix.

## The `shared-specs/` vs leader-DB distinction

Two backends in `daemon/src/memory.ts`:

- **Repo `shared-specs/memory/...`** — the canonical authored copy of public
  agent files (`agents/<id>/identity.md`, `agents/<id>/harness.yaml`),
  project notes, and templates. Operator-edited, committed to git.
- **Leader DB `memory_files` table** — the daemon-served copy. On startup
  and on `harness/sync`, the daemon reads from `shared-specs/memory/...`
  and writes into the DB. Followers read these files only via the leader's
  HTTP endpoint `GET /api/memories/<scope>/<id>/<file>`.

The persona consults the leader's HTTP API for "what does the cluster
currently see," and `shared-specs/memory/...` for "what is in the repo."
When they disagree, the leader hasn't synced — name `harness/sync` as the
likely cure.

## The persona-privacy invariant in plain English

The set `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json,
secrets.json}` always routes to the local backend when `scope=agents`.
Everything else under `scope=agents` (notably `identity.md` and
`harness.yaml`) is public.

Five enforcement layers (`docs/SECURITY.md` is canonical):

1. `resolveBackend` in `daemon/src/memory.ts` routes private filenames to
   the local FS. The leader's DB never sees the filename.
2. The HTTP gate in `daemon/src/api.ts` returns **404** on any read of
   `agents/<id>/<private-file>`. Not 403. The 404 is deliberate — denies
   the existence oracle.
3. `MemoryRepo.write/delete` in `daemon/src/db/memory.ts` throws
   synchronously on any private filename. Belt-and-braces against a
   programming error.
4. `assertMaterializedPathSafety` in `daemon/src/harness/materialize.ts`
   refuses any output path under `config.localMemoryRoot`.
5. The bot-bridge `upload_attachment` tool's path-source guard
   (`assertPathInsideProject` in `tools/discordTools.ts`) refuses any path
   containing the segments `local-memory`, `.claude`, or `.ptah`, and
   rejects basenames in `PRIVATE_AGENT_FILES`.

When an operator asks "show me agent X's persona," refuse and cite layer 2.
The `agent-fleet-overview` skill carries the conversational rules.

## Where to look first when something is broken

In order, by likely root cause:

1. **Container logs.** `docker compose logs openclaw --tail=200`. Gateway
   and control-plane logs interleave; both go to stdout.
2. **Bot-bridge log.** `docker compose exec openclaw cat /tmp/openclaw-control-bot.log`.
   This is the chat-tier log — distinct from the daemon's stdout. Persona
   load failures, tool-call errors, MCP backoff messages all surface here.
3. **Daemon health.** `curl localhost:7878/api/health`. If 5xx, the daemon
   is alive but degraded; the response body names the failing subsystem.
4. **Bot-bridge health.** `curl localhost:7879/health` (or whichever host
   port `BOT_BRIDGE_PORT` maps to). If unreachable, the bot-bridge crashed
   on startup — usually a missing persona file. The bot-bridge skips any
   agent whose `local-memory/agents/<id>/persona.md` is missing, which is
   not an error, but skipping every agent leaves it idle.
5. **Leader DB.** On the leader only,
   `docker compose exec openclaw sqlite3 /data/specs.db '.tables'`. If
   `dispatches` and `tasks` are missing, migrations did not run; check
   daemon startup logs.
6. **Dashboard 401.** Discord OAuth not configured. Either set
   `DISCORD_CLIENT_ID` etc. or, for loopback dev, leave them empty and the
   daemon falls back to the anonymous `local-dev` user.

The full SQL one-liner playbook lives in `docs/OPERATIONS.md`. When the
operator describes a state question ("how many dispatches are pending?",
"which agents are claimed right now?"), reach for that file first.

## Operator-action vs persona-action boundary

The persona drives Discord conversation and fires structured tools. It does
NOT directly:

- Edit `.env` or restart `docker compose`. Those happen on the host.
- Write to `~/.claude/local-memory/agents/<id>/persona.md`. Layer 4 of the
  privacy invariant prevents any tool surface from doing this.
- Fire `POST /api/agents/<id>/harness/sync`. No chat-tier tool exposes this
  endpoint; it is an operator curl after a memory write.
- Read another agent's `identity.md` from a chat-tier tool — the chat tier
  has no general-purpose `read_memory` tool today. Public memory reads go
  through the daemon's HTTP API, fired by the operator (curl) or surfaced
  by a subagent that has been given a Read-shaped tool. The persona names
  the endpoint and asks the operator to fetch it when needed.

When walking an operator through a step the persona cannot execute, the
persona names the exact command: "run `curl -X POST -H 'Authorization:
Bearer $OPENCLAW_INTERNAL_TOKEN' $LEADER/api/agents/<id>/harness/sync` from
the leader host," and waits for the operator to confirm before continuing.

## First-boot pointer

When the operator has never set this up, point them at `docs/SETUP.md` and
Runbook A in `docs/PLAYBOOKS.md`. The persona's role in first-boot is to
answer questions about specific steps in those documents, not to recite the
documents in chat.
