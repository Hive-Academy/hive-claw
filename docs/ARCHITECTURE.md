# Architecture

The stack is two tiers stacked on the same container, optionally federated across machines.

- **Tier 1 — gateway**: openclaw running an HTTP server on `:18789`. Loads `~/.openclaw/openclaw.json`, talks to your inference provider, drives the legacy openclaw plugins (browser, talk-voice, etc.). Single-machine, single-agent. This is the original openclaw stack.
- **Tier 2 — control plane**: a Node daemon on `:7878`, the Angular dashboard it serves, and a multi-agent Discord bot-bridge — all sharing the gateway's image + entrypoint. Multi-machine, multi-agent. Built on top of the gateway, doesn't replace it.

If you're a single-user-on-a-single-laptop case, you can disable tier 2 with `OPENCLAW_CONTROL_DISABLE=1` and the rest of this doc collapses to the "gateway internals" section.

For the operational view of tier 2 — leader/follower split, SQLite spec store, persona privacy, dispatch flow — see [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md). For daily operations recipes (SQL one-liners, backups, schema dump, disaster recovery) see [OPERATIONS.md](OPERATIONS.md). This file covers the architectural shape: what runs where, what talks to what, and why.

---

## Multi-machine topology (tier 2)

```
┌─────────────────────────────  LEADER (single host)  ─────────────────────────────┐
│                                                                                  │
│  ┌─────────────────  openclaw  container  ──────────────────────────┐            │
│  │                                                                  │            │
│  │  daemon (Fastify on :7878)                                       │            │
│  │  ┌──────────────────────────────────────────────────────────┐    │            │
│  │  │  HTTP API  ─── auth: cookie-JWT (browser) | bearer (svc) │    │            │
│  │  │    /api/projects, /api/tasks, /api/tasks/:p/:t/files/... │    │            │
│  │  │    /api/dispatches/pending, /:id/claim, /:id/done        │    │            │
│  │  │    /api/memories/:scope/:id/:file                        │    │            │
│  │  │    /api/stream  (SSE)                                    │    │            │
│  │  └──────────────────────────────────────────────────────────┘    │            │
│  │  ┌──────────────────────────────────────────────────────────┐    │            │
│  │  │  Storage seam:  daemon/src/db/*  (better-sqlite3)        │    │            │
│  │  │    client.ts   schema.ts   tasks.ts   dispatches.ts      │    │            │
│  │  │    memory.ts   migrations.ts                             │    │            │
│  │  └──────────────────────────────────────────────────────────┘    │            │
│  │           │                                                      │            │
│  │           ▼                                                      │            │
│  │  ┌──────────────────┐    ┌─────────────────┐                     │            │
│  │  │  Continuation    │    │  Dispatch       │  ← runs only here   │            │
│  │  │  loop (LEADER)   │    │  worker (loc.   │     when leader's   │            │
│  │  │  every TICK_MS   │    │  agentIds set)  │     bot-bridge      │            │
│  │  │                  │    │  push-driven    │     also owns local │            │
│  │  └─────────┬────────┘    └────────┬────────┘     agents          │            │
│  │            │ INSERT ON CONFLICT   │ UPDATE state                 │            │
│  │            ▼                      ▼                              │            │
│  │  ┌────────────────────────────────────────────┐                  │            │
│  │  │  /data/specs.db   (SQLite, WAL mode)       │  ← only writer   │            │
│  │  └────────────────────────────────────────────┘                  │            │
│  │                                                                  │            │
│  │  bot-bridge (Discord) ── HTTP-only client of localhost:7878      │            │
│  │  Persona files:   /home/agent/.claude/local-memory/agents/<id>/  │            │
│  │                   ↑ filesystem only, NEVER in DB                 │            │
│  │                                                                  │            │
│  │  Redis (pub/sub bus) — already there, used for in-container     │            │
│  │  fan-out (handoff inbox, agent status). NOT used cross-machine. │            │
│  └──────────────────────────────────────────────────────────────────┘            │
│                                                                                  │
│  Volumes:    /data  (SQLite file)         leader-only                            │
│              /home/agent/.claude/local-memory/   (PRIVATE_AGENT_FILES)           │
└──────────────────────────────────────────────────────────────────────────────────┘

                 │ HTTPS (Tailscale Funnel) or LAN
                 │ Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}
                 │ + SSE subscription on /api/stream?topics=dispatch
                 ▼
┌─────────────────────────────  FOLLOWER (N hosts)  ──────────────────────────────┐
│                                                                                 │
│  ┌─────────────────  openclaw  container  ──────────────────────────┐           │
│  │  daemon (Fastify on :7878) — runs in HTTP-CLIENT mode            │           │
│  │     • does not open any local DB                                 │           │
│  │     • dispatch worker subscribes to leader's SSE                 │           │
│  │       /api/stream?topics=dispatch and POSTs /:id/claim           │           │
│  │     • shared memory reads/writes → leader HTTP                   │           │
│  │     • PRIVATE_AGENT_FILES stay in local-memory/                  │           │
│  │     • own /api/health, own SSE for the local dashboard           │           │
│  │                                                                  │           │
│  │  bot-bridge (Discord) — same as leader, HTTP-only against        │           │
│  │     OPENCLAW_LEADER_URL                                          │           │
│  └──────────────────────────────────────────────────────────────────┘           │
│                                                                                 │
│  Volumes:    /home/agent/.claude/local-memory/   (PRIVATE_AGENT_FILES)          │
│              NO /data, NO local DB, NO clone, NO sync timer                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Followers and the leader talk only through the leader's HTTP API. There is no direct daemon-to-daemon protocol other than HTTP. Push notification of new dispatches is delivered via SSE on `/api/stream?topics=dispatch`; the follower also calls `GET /api/dispatches/pending` once at startup and after any reconnect, so a brief partition just delays a claim — it does not lose one.

The dashboard runs everywhere, but only the leader's is the user-facing one (it is the only one with a populated DB). Followers' loopback dashboards are useful for local-memory editing (the follower's own agent persona) and for tailing the follower's own SSE feed.

### Linearization point

The atomic claim that prevents two followers from running the same dispatch lives in `daemon/src/db/dispatches.ts:DispatchRepo.claim`. It is a single prepared statement:

```sql
UPDATE dispatches
   SET state='taken', claimed_by=?, claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id=? AND state='pending'
RETURNING *;
```

`better-sqlite3.prepare(sql).get(params)` returns the row on success or `undefined` on miss.

Why this is the linearization point:

- SQLite serializes writers via a single-writer WAL lock. At any instant, only one `UPDATE` is mutating the `dispatches` table.
- The `WHERE state='pending'` guard means that **exactly one** of N concurrent claimers gets a non-`undefined` `RETURNING` result. Every loser observes `state != 'pending'` (because the winner already flipped it) and the UPDATE matches zero rows, returning `undefined`.
- There is no SELECT-then-UPDATE chain: this is one statement, one round-trip, one transaction at the SQLite engine layer. The window during which a race could exist is the duration of a single prepared statement execution, which is bounded by the WAL lock.

This is verified by `openclaw-control/daemon/test/dispatch-claim.test.ts`, which spins up 8 worker_threads × 10 attempts = 80 concurrent `claim()` calls against the same row in a real on-disk SQLite file. The test asserts exactly one winner.

### Single-machine collapse

If only one machine is in the picture: `OPENCLAW_LEADER=1`, `OPENCLAW_LOCAL_AGENT_IDS=anubis`, no follower exists. The continuation loop and the dispatch worker run in the same process against the same local DB. The `OPENCLAW_LEADER_URL` env var is unused. All the same code paths run.

---

## Inside the container — process tree

```
tini (PID 1)
└── entrypoint.sh
    ├── (renders ~/.openclaw/openclaw.json, runs Ptah/gh bootstrap)
    ├── exec: entrypoint-control.sh   ← only if OPENCLAW_CONTROL_DISABLE!=1
    │       │
    │       ├── (universal) smoke check: better-sqlite3 native binary loads
    │       │
    │       ├── (leader only) node dist/db/migrations.js /data/specs.db
    │       │     • creates the file on first boot, idempotent on reboot
    │       │     • exit non-zero aborts the daemon launch
    │       │
    │       ├── node /opt/openclaw-control/daemon/dist/index.js   (background)
    │       │     • Fastify on :7878
    │       │     • leader: opens /data/specs.db (WAL), runs continuation
    │       │       loop every TICK_MS, runs dispatch worker for local agents
    │       │     • follower: NO local DB; dispatch worker subscribes to
    │       │       leader's SSE and claims via HTTP
    │       │     • spawns ptah CLI subprocesses (or delegates to host bridge)
    │       │
    │       └── node /opt/openclaw-control/bot-bridge/dist/index.js (background, only if any DISCORD_TOKEN_* set)
    │             • discord.js client per agent
    │             • calls daemon API with OPENCLAW_INTERNAL_TOKEN
    │
    └── exec: openclaw --log-level debug gateway --port 18789 --bind lan --verbose
              • the original gateway, untouched
```

`tini` reaps the children. `entrypoint.sh` ends with `exec openclaw …`, so the gateway becomes PID 2 (or whatever) and signals propagate cleanly to all three Node processes when the container stops.

---

## Bind mounts (host ↔ container)

```
HOST                                              CONTAINER
~/projects/                                  →    /home/agent/.openclaw/workspace/    rw   (gateway workspace + per-project ptah specs)
./skills/                                    →    /home/agent/.openclaw/skills/       rw   (global skills, gateway-era)
~/.ptah/                                     →    /home/agent/.ptah/                  rw   (shared ptah CLI config — auth, providers)
~/.config/gh/                                →    /home/agent/.config/gh/             rw   (shared gh CLI auth)
~/.claude/local-memory/                      →    /home/agent/.claude/local-memory/   rw   (control plane: persona/secrets, NEVER synced)
~/.claude/projects/                          →    /home/agent/.claude/projects/       ro   (claude code session JSONLs, for live-feed UI)
named volume: openclaw-state                 →    /home/agent/.openclaw/              rw   (gateway runtime: plugin deps, sessions, state)
named volume: specs-db (LEADER ONLY)         →    /data/                              rw   (control plane: SQLite spec store)
```

The named volume `openclaw-state` parents `workspace/` and `skills/`, but those two are sub-mounted from the host — host wins for files inside them, the named volume keeps everything else (plugin-runtime-deps, agent state, canvas, credentials.json).

The `specs-db` named volume is mounted at `/data/` only on the leader. Followers do not need it (they never open the DB), and `entrypoint-control.sh` skips the migration step on followers.

---

## Networking

```
HOST                     CONTAINER                         INTERNET
                                                          
:18789 (loopback)  ←──── openclaw gateway :18789           ─────► api.openai.com / api.anthropic.com
                          (controlled by OPENCLAW_         ─────► ollama.com (when *:cloud models)
                           CONTROL_BIND, default 127.0.0.1) ────► host.docker.internal:11434 → host Ollama
                                                          
:7878 (loopback by         openclaw-control daemon :7878   ─────► leader's :7878 (followers only, HTTP+SSE)
default; 0.0.0.0 if you    + dashboard SPA                 ─────► discord.com (OAuth + bot gateway WS)
opt in)                                                    ─────► ollama.com / model providers (via ptah subprocess)
                                                          
                          openclaw-redis :6379             (container-internal only, never published)
```

**Public exposure path** (leader only): Tailscale Funnel terminates TLS on `:443` and proxies to `127.0.0.1:7878`. The daemon doesn't speak HTTPS itself; it relies on whatever TLS terminator sits in front. See [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md) for the Funnel setup recipe.

---

## How a Discord mention becomes a dispatched task

1. **You**: `@anubis !task fixing-openclaw add a /api/whoami endpoint` in your Discord guild.
2. **Bot-bridge** (Anubis machine) — discord.js fires `messageCreate`. `commandRouter` parses `!task`, calls `daemon.createTask({project, description, agentId: 'anubis', discordUserId, channelId})` over loopback HTTP with `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`. On a follower, the bot-bridge calls the *leader's* daemon at `OPENCLAW_LEADER_URL`.
3. **Daemon (leader)** — `createTask()` performs `ProjectsRepo.upsert + TasksRepo.insert + TasksRepo.writeFile('context.md', …)` in a single `BEGIN IMMEDIATE … COMMIT` transaction so the dashboard never sees a half-created task. Broadcasts `task.created` over `/api/stream`.
4. **Dashboard** — every browser with the SSE stream open receives `task.created` and re-renders.
5. **Continuation loop tick (leader)** — within `OPENCLAW_TICK_MS`, `tickOnce()` reads from `TasksRepo`, sees `current_phase=CONTEXT`, no checkpoint pending. Calls `DispatchRepo.insertPending({agentId: 'anubis', projectSlug, taskId, phase: 'CONTEXT', prompt, …})`. The partial UNIQUE index `dispatches_unique_open` (on `(project_slug, task_id, phase) WHERE state IN ('pending','taken')`) guarantees no duplicate row.
6. **Local fast path (agent owned by leader)** — same process invokes `invokeClaudeForTask({…})`. The dispatch row goes `pending → taken → done` via direct `DispatchRepo` calls.
7. **Remote agent (follower owns the agent)** — leader broadcasts `dispatch.pending` on `/api/stream`. The follower's dispatch worker, subscribed via `GET /api/stream?topics=dispatch`, wakes up. It calls `GET /api/dispatches/pending?agentId=…`, picks the oldest, and `POST /api/dispatches/:id/claim` (the linearization point above). On a 200, it runs ptah, then `POST /api/dispatches/:id/done` with the result.
8. **Loop continues** through `PLAN → PENDING → … → DONE`. Each phase advance is a `TasksRepo.writeFile + UPDATE tasks.current_phase` transaction. The leader broadcasts `task.updated`, `checkpoint.pending`, `checkpoint.approved`, `dispatch.pending`, `dispatch.taken`, `dispatch.done` as appropriate.

The full SSE event taxonomy lives in `docs/OPERATIONS.md`.

---

## Why SQLite-on-leader (vs the original git-as-queue)

Three things this design gets us:

- **Atomic claim**: a single `UPDATE … WHERE state='pending' RETURNING *` under WAL is the linearization point. No external lock service, no rebase loop.
- **Sub-second latency**: SSE push notification + HTTP claim is ~10–100 ms in a healthy LAN, vs the ~15 s polling floor of a git-based setup.
- **Single source of truth**: every dashboard read is a SELECT against the same DB the writer just committed to. WAL gives readers a consistent snapshot without blocking the writer.

The cost is that the leader is a SPOF for dispatch progress (it always was — only the leader runs the continuation loop) and that the DB file lives on one host. Backups are manual (`docs/OPERATIONS.md` covers the `.backup` recipe).

---

## Inside the gateway (tier 1, unchanged)

The gateway tier is the original openclaw stack — preserved verbatim. If you've read this file before slice 1 of the control plane, this section is exactly what was here.

### OpenClaw gateway daemon

`openclaw gateway --port 18789 --bind lan --verbose`

A Node 22 process that:

- Loads `~/.openclaw/openclaw.json` (rendered from our template).
- Auto-enables a model provider plugin based on config (`ollama/<model>` → loads `openclaw-provider-ollama`).
- Bootstraps bundled plugins on first run: `acpx`, `browser`, `device-pair`, `discord`, `phone-control`, `talk-voice`. Plugin runtime deps install into `~/.openclaw/plugin-runtime-deps/` on first run.
- Starts an HTTP server on `:18789` for the gateway's own dashboard, the canvas, and inbound webhooks.
- Starts the channels-and-sidecars subsystem ~3 minutes after `gateway ready` — that's where the gateway's own discord adapter would connect, if you re-enabled it.

In practice we run with `DISCORD_BOT_TOKEN` empty so the gateway's discord adapter is disabled — the bot-bridge in tier 2 owns Discord. The gateway is still useful for the canvas, the agent runtime, and as the inference target for ad-hoc chat from the gateway dashboard.

### Persona / skills layering (gateway-era)

Three layers of agent context, evaluated in order:

1. **Built-in OpenClaw system prompt** — describes the agent's tools. ~28 KB. Comes from openclaw itself, not configurable.
2. **Workspace persona** — `~/projects/SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`. Read on session start.
3. **Per-project persona override** — `~/projects/<project>/.openclaw/persona.md`, etc. Layered when the agent's cwd is that project.

This is **separate** from the control-plane agent registry's persona system (the leader's `memory_files` table for `identity.md` + `local-memory/agents/<id>/persona.md`). Same word, different scope: the workspace persona shapes the gateway's single agent; the control-plane persona shapes a specific registered bot. See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for the reconciliation.

### File layout in the running container

```
/usr/local/bin/openclaw                      # CLI binary
/usr/lib/node_modules/openclaw/              # openclaw source
/etc/openclaw/openclaw.json.tmpl             # config template
/usr/local/bin/entrypoint.sh                 # what tini exec's
/usr/local/bin/entrypoint-control.sh         # control-plane launcher
/opt/openclaw-control/daemon/dist/           # compiled daemon
/opt/openclaw-control/bot-bridge/dist/       # compiled bot-bridge
/opt/openclaw-control/dashboard/browser/     # built Angular SPA

/home/agent/                                 # uid 1000
└── .openclaw/                               # named volume openclaw-state
    ├── openclaw.json                        # rendered at startup
    ├── plugin-runtime-deps/
    ├── agents/main/
    ├── canvas/
    ├── credentials.json
    ├── workspace/                           # ← BIND MOUNT to host's ${WORKSPACE_DIR}
    └── skills/                              # ← BIND MOUNT to host's ${SKILLS_DIR}
└── .claude/
    ├── local-memory/                        # ← BIND MOUNT, NEVER synced (PRIVATE_AGENT_FILES)
    └── projects/                            # ← BIND MOUNT (read-only), claude session JSONLs

/data/                                       # ← LEADER-ONLY named volume specs-db
└── specs.db                                 # SQLite, WAL mode, owner uid 1000, mode 0600
```

---

## Two-tier persona runtime (chat tier + orchestration tier)

A registered agent runs in two tiers from a single per-agent `harness.yaml`. The split is structural, not configurational — every persona has both tiers, and the boundary is one file.

### The `ptahLauncher` seam

`daemon/src/harness/ptahLauncher.ts:spawnPtahForAgent({ agentId, cwd, prompt, taskId, dispatchId })` is the only place in the codebase that knows how to invoke ptah. `invoker.ts:invokeClaudeForTask` no longer hand-builds the ptah arg list — it calls the launcher and consumes the result.

The launcher reads a cached ptah-version probe and branches:

- **Today (ptah 0.1.3)** — emits `--config <~/.ptah/agents/<id>/settings.json>` plus a per-persona Claude plugin under `~/.ptah/plugins/openclaw-<id>-harness/`. This is the only shape that actually loads workspace subagents (spike findings R2 + R4).
- **Future fixed branch** — gated by `PTAH_MIN_VERSION` advancing past the version that lands `--config-dir` / `--subagent` / workspace `.claude/agents/` upstream. Migration is a single branch swap inside `ptahLauncher.ts` + a `PTAH_MIN_VERSION` bump; nothing else moves.

Because every ptah invocation goes through the launcher, the `--profile` flag survives unchanged for unconfigured personas (no `harness.yaml` → default settings.json with `enabledPluginIds:[]` and `profile:'claude_code'`). Backwards compatibility is byte-equivalent.

### Per-persona Claude plugin layout

For each registered agent `<id>`, the daemon's `harness/materialize.ts` writes:

```
~/.ptah/agents/<id>/settings.json                              # ptah --config target; mcpServers + enabledPluginIds + modelTier
~/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json   # Claude Plugin manifest
~/.ptah/plugins/openclaw-<id>-harness/agents/<subagent>.md     # one file per orchestration-tier subagent in harness.yaml
```

Plugin id format: `openclaw-<id>-harness`, regex-validated. `~/.ptah/plugins/` is global, but per-persona subdirs do not collide and `materialize.ts` is idempotent (only touches its own subdir). Multiple personas coexist.

The materialized tree is **config, not memory** — the persona-privacy invariant does not apply. A fourth defense layer (`assertMaterializedPathSafety`) refuses to write any output path that resolves under `OPENCLAW_LOCAL_MEMORY` so a misconfigured `OPENCLAW_HOST_HOME` still cannot leak materialization into the private tree. See [SECURITY.md](SECURITY.md#persona-privacy-invariant).

### Container ↔ host path translation

The daemon emits **host paths** (computed against `OPENCLAW_HOST_HOME`) because the host-side ptah-bridge runs ptah on the host. To make those paths writable from inside the container, `${OPENCLAW_HOST_HOME}/.ptah` is **identity-bind-mounted** (`/home/anubis/.ptah:/home/anubis/.ptah:rw`) — same path on both sides, no regex translation in `ptah-bridge.mjs`. The daemon writes materialized configs through this mount; the bridge runs ptah and reads them back.

`mkdir -p ${OPENCLAW_HOST_HOME}/.ptah/agents ${OPENCLAW_HOST_HOME}/.ptah/plugins` runs in `entrypoint.sh` on first boot and `materialize.ts` calls it again defensively.

### Peer-model resilience

The chat tier never depends on ptah being healthy or even installed. When ptah is broken, every chat-tier code path keeps working:

- `chat.ts` reads the persona's `harness.yaml` from the daemon and assembles its own tool registry (daemon-CRUD tools + per-persona MCP stdio clients via `@modelcontextprotocol/sdk` + openclaw-native subagents spawned by `subagentRunner.run()` — NOT `ptah --profile`).
- The persona answers questions, calls subagents, and surfaces MCP tools without any ptah hop.
- Only the `dispatch_orchestration_task` chat-tool touches ptah, and even that hop is asynchronous: it queues a `dispatches` row, the dispatch worker picks it up, and the existing `invokeViaBridge` returns failed-state on bridge unreachable. Dispatch SSE still fires; the operator sees the failure on the dashboard rather than the chat blocking.

This is the **peer model**: bot-bridge and ptah are peers, not parent/child. Either tier can degrade independently. The team-leader designed it this way deliberately — see `.ptah/specs/TASK_2026_002/implementation-plan.md` §"Architecture summary".

### Harness-authoring chat (Phase 3)

Operator flow for putting a project under harness:

1. Operator says "set up the harness for this disposable test repo" in Discord.
2. The persona's tool registry includes `start_harness_setup`. Calling it flips `ctx.state.harnessSetup` and re-runs the LLM with a **different** system prompt and a **different** tool subset (`probe_project`, `read_file`, `propose_harness`, `confirm_harness`, `write_harness_file`).
3. The persona probes the project, proposes a yaml, asks "does this look right?".
4. Operator says "yes" → `chat.ts` flips `stage` to `'writing'` → `write_harness_file` calls the daemon's `POST /api/projects/:slug/files` with `.claude/harness.yaml`. Operator says "no" → state resets to probing. Operator says "cancel harness setup" (case-insensitive) or 30 min idle → state cleared, friendly reply posted.

No `ptah setup`, no Pro RPCs (`wizard:*` and `harness:analyze-intent` are explicitly forbidden — the daemon's outbound HTTP wrapper throws on those when `OPENCLAW_REQUIRE_COMMUNITY_TIER=1`).

---

## Why these specific choices

| Decision | Reason |
|---|---|
| Plain Docker, not NemoClaw / k3s | NemoClaw is alpha, has Landlock-related crashes; its main value isn't useful on a personal box. |
| Bind `~/projects` to `~/.openclaw/workspace` (not `/workspace`) | OpenClaw's plugins assume the default workspace path. |
| `bind: "lan"` (gateway), not `HOST=0.0.0.0` env var | The env var has no effect on openclaw — only the CLI flag does. |
| `commands.useAccessGroups: false` | Required for the gateway's discord adapter to reply to anyone other than paired users. (We disable that adapter anyway, but the flag is still set in case it gets re-enabled.) |
| `meta.lastTouchedVersion` + `meta.lastTouchedAt` in template | Without them, openclaw "auto-restores from backup" on every start. |
| `bonjour` plugin disabled | mDNS multicast doesn't work on Docker bridge networks. |
| Skills as bind mount, not baked into image | Edit skills without rebuilding. |
| Control plane shares the gateway image | One image, one entrypoint, one volume set — adding a follower machine is `provision-machine.sh`, not a new compose file. |
| SQLite-on-leader as the dispatch queue (vs Redis or git) | Atomic claim via `UPDATE … WHERE state='pending' RETURNING *`. Sub-second latency. Single source of truth for the dashboard's reads. WAL keeps readers off the writer's lock. |
| Persona stored locally, never synced | The persona is the agent's voice — the operator decides what's in it; sharing it across machines is the operator's call, not the system's. |
| One bot token per agent (vs one shared bot) | Easier to revoke, no Discord rate-limit collisions, presence is per-agent. |

These were all learned empirically. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for symptom-to-fix mapping.
