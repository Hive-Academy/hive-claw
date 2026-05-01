# openclaw-control — multi-machine, multi-agent control plane

The canonical doc for everything sitting on top of the openclaw gateway. If you only have one machine and one bot and you're happy with `@<bot> hello` in Discord, you don't need this — read [SETUP.md](SETUP.md) and stop. If you want a fleet of bots, each running on its own machine, sharing one task tree, picking up work from each other, and reachable from a single dashboard, read on.

---

## What it is

Three TypeScript processes shipped inside the same container as the openclaw gateway:

| Process | Port | Role |
|---|---|---|
| **daemon** | `:7878` | Fastify server. On the leader: owns the SQLite spec store at `/data/specs.db` (tasks, dispatches, shared memory, dispatch logs), the dashboard, the REST + SSE API, and Discord OAuth. On a follower: HTTP-only client of the leader, no local DB. |
| **dashboard** | (served by the daemon) | Angular 19 SPA. Projects → tasks → kanban → approve / reject / handoff. Live agent status. Memory editor. |
| **bot-bridge** | none | Spawns one Discord client per agent registered locally. Routes `!commands` and free-form `@mention` chat into the daemon (its own daemon if leader, or the leader's daemon if follower). |

Plus, on the network:

- An optional **Redis** for in-container handoff inbox and agent-status fan-out (per-container; not used cross-machine).
- An optional **Tailscale Funnel** so the leader's dashboard is reachable from anywhere over TLS.

The whole thing runs inside the container `openclaw` started by `docker-compose.yml`. Same image as the gateway, same `entrypoint.sh`, same bind mounts. If the gateway runs, this runs.

---

## Topology — one leader, N followers

Each physical machine in the fleet runs the same image. They differ only in `.env`:

```
┌─ Anubis (leader) ─────────────────┐  ┌─ Amun (follower) ─────────────────────┐
│  OPENCLAW_LEADER=1                │  │  OPENCLAW_LEADER=0                    │
│  OPENCLAW_LOCAL_AGENT_IDS=anubis  │  │  OPENCLAW_LOCAL_AGENT_IDS=amun        │
│  /data/specs.db (SQLite, WAL)     │  │  OPENCLAW_LEADER_URL=https://anubis…  │
│  DISCORD_TOKEN_ANUBIS=...         │  │  DISCORD_TOKEN_AMUN=...               │
│                                   │  │                                       │
│  daemon → continuation loop ON    │  │  daemon → continuation loop OFF       │
│         → dispatch worker ON      │  │         → dispatch worker ON          │
│         → owns the spec DB        │  │         → HTTP client of the leader   │
│         → dashboard (public)      │  │         → dashboard (loopback only)   │
│         → bot-bridge: anubis      │  │         → bot-bridge: amun            │
└─────────────────┬─────────────────┘  └─────────────────┬─────────────────────┘
                  │                                       │
                  │  Bearer ${OPENCLAW_INTERNAL_TOKEN}    │
                  │  HTTPS or LAN  →  /api/dispatches/*   │
                  │                   /api/memories/*     │
                  │                   /api/stream         │
                  └───────────────────────────────────────┘
```

Exactly one machine sets `OPENCLAW_LEADER=1`. That machine is the only one running the **continuation loop** (the thing that walks each task through `CONTEXT → DESCRIPTION → PLAN → … → DONE` and inserts new dispatches into the DB). The leader also opens the SQLite database at `/data/specs.db`. Followers do **not** open any local DB — they run only the **dispatch worker**, which subscribes to the leader's SSE channel `/api/stream?topics=dispatch`, claims dispatches via `POST /api/dispatches/:id/claim`, runs the work locally, and reports completion via `POST /api/dispatches/:id/done`.

Both leaders and followers serve a dashboard locally on `127.0.0.1:7878`. Only the leader's is the user-facing one (only the leader has the populated DB to read from). Follower dashboards are useful for local-memory editing.

`OPENCLAW_LOCAL_AGENT_IDS` is the disjoint partition: `anubis` runs only on the leader, `amun` only on Amun, etc. If two machines list the same agent, one of them will lose every dispatch race; behavior is technically safe (the SQL claim is atomic) but the loser wastes HTTP calls.

---

## Storage — `/data/specs.db` on the leader

The leader's daemon owns a single SQLite file holding every project, task, task-file blob, dispatch row, dispatch log line, and shared-memory entry. It lives at the path in `OPENCLAW_SPECS_DB_PATH` (default `/data/specs.db`, persisted via the named docker volume `specs-db`).

Connection settings (`daemon/src/db/client.ts`):

- **Mode**: WAL (`PRAGMA journal_mode=WAL`) — multiple readers concurrent with a single writer.
- **Synchronous**: NORMAL — ~1 ms commit latency.
- **busy_timeout**: 5000 ms — tolerate a WAL checkpoint stall.
- **foreign_keys**: ON — enforces `ON DELETE CASCADE` between projects/tasks/dispatches.

Every write transaction is `BEGIN IMMEDIATE … COMMIT` and is bounded to a few statements (see `db/client.ts` header comment for the rules). The biggest single write — a `task_files.write` for a `.md` body — is bounded to <1 MB at the API layer.

### Inspect the DB from a running leader

`sqlite3` is available inside the container. Three sample queries copy-pasteable as-is:

```bash
# Open dispatches (pending or taken) — "what's stuck?"
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, agent_id, project_slug, task_id, phase, created_at
     FROM dispatches
    WHERE state IN ('pending','taken')
    ORDER BY created_at;"
```

```bash
# Poisoned dispatches — runaway loop guard tripped
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT id, project_slug, task_id, phase, failure_count
     FROM dispatches
    WHERE state='poisoned';"
```

```bash
# Tail of one dispatch's audit trail
docker compose exec openclaw sqlite3 /data/specs.db \
  "SELECT ts, level, message
     FROM dispatch_log
    WHERE dispatch_id='<id>'
    ORDER BY ts;"
```

The schema is in `openclaw-control/daemon/src/db/schema.ts`. Inspect at runtime: `docker compose exec openclaw sqlite3 /data/specs.db .schema`.

See `docs/OPERATIONS.md` for the full daily-ops playbook (backups, schema dump, disaster recovery).

### Local memory — never in the DB, never over HTTP

Genuinely private state (agent personas, secrets) lives at `~/.claude/local-memory/agents/<id>/<file>` on each machine, bind-mounted into the container. These files NEVER enter `/data/specs.db` and NEVER traverse the daemon's HTTP API. See "The persona privacy rule" below.

---

## The persona privacy rule

The agent registry has two storage backends with intentionally different sync semantics:

| Backend | Path | Stored where? | What it holds |
|---|---|---|---|
| **shared** | `/api/memories/agents/<id>/identity.md` | Leader's `memory_files` table (SQLite) | Public bio. Name, vibe, signature emoji. Anything you'd put on the agent's "about" page. |
| **local** | `~/.claude/local-memory/agents/<id>/persona.md` | Local FS only, on the machine that owns the agent | Private system prompt. Tone, idiosyncrasies, anything operationally sensitive. |

The split is enforced by `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}`. The full three-layer enforcement (FS chokepoint in `memory.ts`, HTTP gate in `api.ts`, defense-in-depth allowlist in `db/memory.ts`) is documented in [SECURITY.md](SECURITY.md). The short version: there is no API path — internal or external — that can leak a private file over the network, and the leader's DB never sees one.

### Implications

- Anubis's persona lives **only** on the Anubis machine. Amun has no way to read it. Same in reverse.
- The bot-bridge's `loadAgents()` only registers an agent if `local-memory/agents/<id>/persona.md` exists. **An agent without a local persona is invisible to the bot-bridge.** This is why `setup.sh` scaffolds a stub from `templates/agent-persona.md.tmpl` — without it the bot won't come online.
- If you move an agent to a new machine, you copy the local persona file out-of-band (scp, password manager, whatever). The leader's DB has no copy.

### Ownership check on writes

`memory.ts:assertAgentOwnership()`: writes to `agents/<id>/*` (any file, public or private) are rejected with HTTP 403 unless `<id>` is in this machine's `OPENCLAW_LOCAL_AGENT_IDS`. Reads of the *public* identity file have no such check — every machine can read every public bio over the leader's HTTP API. Reads of *private* files return 404 over HTTP regardless of identity (deliberately not 403, to avoid leaking the existence of a persona).

If `OPENCLAW_LOCAL_AGENT_IDS` is empty, the ownership check is bypassed (single-machine / dev mode).

---

## The continuation loop and the dispatch queue

The leader's daemon runs `tickOnce()` every `OPENCLAW_TICK_MS` (default 30s). For each open task in the `tasks` table:

1. Skip if at a checkpoint and not yet approved (the `tasks.checkpoint_pending` flag plus `approvals_json`).
2. Look up the next phase prompt from `continuation.ts:buildPromptFor()` (one prompt per phase, with the right agent role baked in).
3. Call `DispatchRepo.insertPending({agentId, projectSlug, taskId, phase, prompt, …})`. The partial UNIQUE index `dispatches_unique_open` on `(project_slug, task_id, phase) WHERE state IN ('pending','taken')` rejects a duplicate row, returning null — which the loop treats as "skipped".
4. Broadcast `dispatch.pending` over `/api/stream`. SSE-subscribed followers wake up immediately; the leader's own dispatch worker (if it owns the agent) picks the row up on its next tick.

Followers run `processOneDispatch()` every `OPENCLAW_DISPATCH_MS` (default 10s); the SSE feed makes it effectively push-driven, polling is the floor:

1. `GET /api/dispatches/pending?agentId=<own-ids>` — list candidates ordered oldest-first.
2. Pick the oldest; `POST /api/dispatches/:id/claim`. Server-side this is the atomic linearization point (single `UPDATE … WHERE state='pending' RETURNING *`). On 200 we own the dispatch; on 409 we lost the race and try the next candidate.
3. Invoke ptah in the project's working dir (locally on the follower; or, in production, delegated to the host-side ptah-bridge — see below).
4. `POST /api/dispatches/:id/done` with `{exitCode, durationMs, stderrSnippet}`. The leader's `DispatchRepo.markDone` decides terminal state: `done` on `exitCode=0`, `failed` otherwise — promoted to `poisoned` if this attempt is the Kth consecutive failure for the same `(project, task, phase)` (K = `OPENCLAW_DISPATCH_FAILURE_THRESHOLD`, default 3).

**The continuation loop is leader-only.** Followers don't try to advance task phases themselves — they only execute work already-dispatched. This keeps the phase machine single-writer.

---

## Discord, the bot bridge, and the chat handler

### One bot, one token, per agent

Each agent registered under `local-memory/agents/<id>/` (with a non-empty `persona.md`) gets a Discord client in the bot-bridge. The token comes from `DISCORD_TOKEN_<UPPER_ID>` (e.g. `DISCORD_TOKEN_ANUBIS`) by default; overridable via the leader's shared memory at `agents/<id>/discord.json#tokenEnvVar` (served by `GET /api/memories/agents/<id>/discord.json`).

The legacy gateway-era variable `DISCORD_BOT_TOKEN` (used by the openclaw gateway's discord adapter) is kept in `.env.example` for backward compatibility but should be left empty when running the bot-bridge — otherwise you have two clients trying to log in as the same bot, which Discord will reject.

### `!commands`

The bot-bridge `commandRouter` handles a fixed set of commands: `!help`, `!projects`, `!tasks <slug>`, `!task <slug> <description>`, `!approve <id> [feedback]`, `!reject <id> [feedback]`, `!handoff <id> <agent>`, `!tick`. These map 1:1 to daemon REST calls authenticated via the `OPENCLAW_INTERNAL_TOKEN` service token.

### Free-form `@mention` chat (slice 11)

Mentioning the bot without `!` triggers `chat.ts:handleChat()`:

1. Build a system prompt: agent's public bio + private persona + Discord user profile + thread context + a "TOOLBELT" section listing available `<<oc:…>>` directives.
2. POST to the configured LLM provider's `/chat/completions` endpoint (OpenAI-compatible). Default is Ollama at `host.docker.internal:11434/v1` with `model = $LLM_MODEL`. Other supported providers: `openai`, `openrouter`, `groq`, `custom` — all via `bot-bridge/src/llm.ts:chatComplete()`.
3. Parse the model's reply. Strip any `<<oc:create_task project="…" description="…" agent="…">>`, `<<oc:approve task_id="…">>`, `<<oc:reject task_id="…">>`, `<<oc:handoff task_id="…" to_agent="…">>`, `<<oc:tick>>` directives from the tail.
4. Execute each directive against the daemon API (using the internal service token). Results get appended as a `— actions —` footer.
5. Reply in chunks of ≤1900 chars to satisfy Discord's message limit.

The tool is intentionally narrow. Pure questions stay as text answers; only action-shaped requests emit directives. There's no MCP/RPC roundtrip — directives are an agreed text format the bridge parses directly.

> [!IMPORTANT]
> Discord chat does **not** go through ptah-cli. Earlier in the project's history it did, but that conflated chat with orchestration: chat needs an LLM and a system prompt, while orchestration needs ptah's full skill/MCP/memory harness. Routing chat through ptah forced the container to depend on ptah's auth state — which is the operator's desktop config, not something the bot needs. The current design hits the LLM provider directly for chat and reserves ptah for the orchestration paths that actually use its skills. See "Orchestration runs via the host-side ptah-bridge" below for how those paths work.

---

## Orchestration runs via the host-side ptah-bridge

The continuation loop and dispatch worker invoke ptah-cli for real agent work — multi-step phases that read the task folder, write artifacts, run commands. ptah uses your desktop's `~/.ptah/settings.json` as its source of truth, including `authMethod` (often `claudeCli` for the Claude Code subscription, or `apiKey` for direct API access).

The container can't easily run those auth paths — the desktop's binaries (`claude`, `codex`, `gh`) and credentials live on the host. So the daemon delegates orchestration to a small **ptah-bridge** process running on the host:

```
container                              host
─────────                              ─────────
daemon/src/invoker.ts                  scripts/ptah-bridge.mjs (systemd user service)
   │  POST /invoke                        │
   │ ─────────────────────────────────►   ├─ translate container path → host path
   │   Authorization: Bearer $TOKEN       ├─ spawn `ptah --json --cwd <hostPath>
   │   { cwd, prompt, taskId, ... }       │     session start --profile <p> --task <prompt>`
   │                                      ├─ stream NDJSON response back
   │  ◄─────────────────────────────────  ├─ append `{"_bridge":"done", exitCode, ...}`
   │     application/x-ndjson             │
```

The bridge exposes:

- `GET /health` — `{ok, ptahVersion, hostUser, pathMap}`. Useful for liveness.
- `POST /invoke` — auth'd, body `{cwd, prompt, taskId, agentId, profile, autoApprove}`. Streams ptah's JSON-RPC events; final line is the bridge envelope with exit code and stderr.

Bearer token is the same `OPENCLAW_INTERNAL_TOKEN` the bot-bridge already shares with the daemon. Set it in `.env` once and both sides use it.

### Path translation

The daemon thinks in container paths (`/home/agent/.openclaw/workspace/<project>`). The bridge knows its own host paths (`${WORKSPACE_DIR}/<project>`) and rewrites both the `cwd` field and any path references inside the prompt before invoking ptah. Configurable via `BRIDGE_WORKSPACE_CONTAINER` / `BRIDGE_WORKSPACE_HOST` / `BRIDGE_SPECS_CONTAINER` / `BRIDGE_SPECS_HOST` in the systemd unit.

### Installation

`scripts/ptah-bridge.service.tmpl` is a systemd user service template. Substitute `{{REPO_DIR}}` and `{{TOKEN}}`, drop into `~/.config/systemd/user/`, then `systemctl --user enable --now ptah-bridge.service`. The bridge listens on `0.0.0.0:8744` (auth via bearer token) so the container can reach it through `host.docker.internal:8744`.

### Fallback mode

If `OPENCLAW_PTAH_BRIDGE_URL` is unset, the daemon falls back to spawning `ptah` inside the container (the original behavior). Useful for dev mode and tests where you don't want a host service. In production deployments, the bridge URL is set in `.env` so the host path is preferred.

### What this gets you

- ptah uses your desktop's actual auth method, including Claude CLI / Copilot OAuth / Anthropic key, without copying secrets into the container.
- The container image stays slim — no extra CLI binaries baked in.
- Adding a new provider = installing it on the host. No container rebuild.
- Each follower runs its own bridge with its own host auth — operators on different machines can use different providers if they want.

## Auth — three doors, one daemon

| Caller | Path | Credential |
|---|---|---|
| Browser (you, on the dashboard) | OAuth → `/auth/discord/callback` → JWT cookie | Discord login + `DISCORD_ALLOWED_USER_IDS` allowlist |
| Bot-bridge / dispatched agents | `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}` | shared service token |
| Localhost dev (no OAuth configured) | none — daemon returns a fake `local-dev` user | only when `DISCORD_CLIENT_ID` is empty |

If `DISCORD_ALLOWED_USER_IDS` is set, that list is the gate (highest priority). Otherwise, `DISCORD_ALLOWED_GUILD_ID` checks guild membership. With neither set, remote logins are rejected and only the local-dev fallback works — which means: don't expose the dashboard publicly without setting at least one allowlist.

The internal token is generated on first boot by `entrypoint-control.sh` if unset; you'll want to copy the generated value into `.env` to pin it across container recreates.

JWT secret is `OPENCLAW_JWT_SECRET`. Sessions last 14 days. Rotate the secret to invalidate every existing session.

---

## Tailscale Funnel — exposing the leader's dashboard

The leader's dashboard is bound to `127.0.0.1:7878` by default. To make it reachable from anywhere (your phone, another laptop, the office) over TLS, the simplest path is Tailscale Funnel:

```bash
# One-time, on the leader machine:
tailscale up --ssh
tailscale funnel --bg --https=443 7878
# → https://<your-machine>.<tailnet>.ts.net is now public
```

Things to know:

- Funnel exposes **whatever's on 7878 on localhost** to the public internet. Auth is enforced entirely by the daemon (Discord OAuth + allowlist). If you misconfigure `DISCORD_ALLOWED_USER_IDS` (leave it empty AND skip `DISCORD_ALLOWED_GUILD_ID`), the public URL becomes a public dashboard. Don't.
- The Discord OAuth `DISCORD_REDIRECT_URI` must match the public URL: `https://<your-machine>.<tailnet>.ts.net/auth/discord/callback`. Update both `.env` and the Discord Developer Portal's "Redirects" list.
- Funnel is leader-only. Followers stay loopback.
- Funnel binds to one node at a time. If you move the leader to a different machine, you re-run `tailscale funnel` there.

If you don't want Tailscale, anything that does TLS termination + reverse proxy to `127.0.0.1:7878` works (Caddy, Traefik, Cloudflare Tunnel). The included `Caddyfile` is the gateway-era LAN setup, not a public-exposure config — adapt or skip.

---

## End-to-end: a task from `!task` to `DONE`

1. **You, in Discord**: `@anubis !task openclaw-control add a /api/whoami endpoint`
2. **Bot-bridge** parses the command, posts `POST /api/tasks` with internal token. The leader's daemon performs `ProjectsRepo.upsert + TasksRepo.insert + TasksRepo.writeFile('context.md', …)` in a single `BEGIN IMMEDIATE … COMMIT`.
3. **Continuation tick (leader)**: task is at `CONTEXT`, assigned to `anubis`, no approval needed yet. `DispatchRepo.insertPending({agent: 'anubis', phase: 'CONTEXT', …})` returns the new id; SSE broadcasts `dispatch.pending`.
4. **Leader's own dispatch worker** (since `anubis ∈ localAgentIds`) claims via the local `DispatchRepo.claim`, invokes ptah, writes `task-description.md` (a `task_files` row), `markDone(exitCode=0)`. Phase advances to `DESCRIPTION`. Checkpoint fires.
5. **You, in Discord** (or the dashboard): `@anubis !approve TASK_2026_007`. Daemon updates `tasks.approvals_json` for that phase and `task_files.context.md` (frontmatter) in the same transaction.
6. **Loop dispatches `software-architect`** → writes `implementation-plan.md`. New checkpoint.
7. … continues through `PLAN → PENDING → IMPLEMENTED → QA_DONE → DONE`. Each step is a transaction; each phase advance broadcasts `task.updated`.
8. **If you handed off to `chappie`** at any phase: the next `insertPending` targets `agent: 'chappie'`. Chappie's machine, which is a follower with an SSE subscription on `?topics=dispatch`, sees `dispatch.pending`, calls `POST /api/dispatches/:id/claim`, runs the prompt locally, posts `POST /api/dispatches/:id/done`. The leader's row transitions to `done` and the continuation loop picks up the new artifact on its next tick.

You can watch the whole thing in the dashboard's SSE feed (`task.created`, `task.updated`, `dispatch.pending`, `dispatch.taken`, `dispatch.done`, `dispatch.failed`, `dispatch.poisoned`, `invoker.started`, `invoker.stdout`, `invoker.finished`, `checkpoint.pending`, `checkpoint.approved`, `continuation.tick`, `memory.updated`, `agent.handoff`, `agent.status`, `session.message`). See `docs/OPERATIONS.md` for the full event taxonomy.

---

## Configuration index

For the full env reference see [CONFIGURATION.md](CONFIGURATION.md). Highest-impact knobs:

| Var | Default | Effect |
|---|---|---|
| `OPENCLAW_LEADER` | `0` | Set to `1` on exactly one machine. Enables the continuation loop, opens `/data/specs.db`, and is where the public dashboard lives. |
| `OPENCLAW_LOCAL_AGENT_IDS` | (empty) | CSV list of agents this machine owns. Empty = ownership checks bypassed (dev mode). |
| `OPENCLAW_LEADER_URL` | (empty) | **Required on followers.** Leader's daemon base URL (e.g. `http://leader.lan:7878` or `https://leader.tailnet.ts.net`). Ignored on the leader. |
| `OPENCLAW_SPECS_DB_PATH` | `/data/specs.db` | Leader-only. SQLite file path inside the container. The `/data` mount comes from the named docker volume `specs-db`. |
| `OPENCLAW_DISPATCH_FAILURE_THRESHOLD` | `3` | K consecutive failures (per `(project, task, phase)`) before a dispatch is poisoned. |
| `OPENCLAW_JWT_SECRET` | (auto-generated by setup.sh) | JWT signing secret. Rotate to invalidate sessions. |
| `OPENCLAW_INTERNAL_TOKEN` | (auto-generated on first boot) | Service token for bot-bridge ↔ daemon, follower ↔ leader, dispatched-agent ↔ daemon. Copy from logs into `.env` to pin. |
| `OPENCLAW_TICK_MS` | `30000` | Continuation loop interval (ms). Leader only. |
| `OPENCLAW_PTAH_BRIDGE_URL` | `http://host.docker.internal:8744` | Where the daemon delegates orchestration runs. Empty = fall back to spawning ptah inside the container. |
| `LLM_PROVIDER` / `LLM_MODEL` / `OLLAMA_BASE_URL` | `ollama` / `kimi-k2.6:cloud` / `host.docker.internal:11434/v1` | Used by `bot-bridge` for free-form Discord chat. Discord chat does NOT go through ptah; it hits the LLM provider directly. |
| `OPENCLAW_CONTROL_BIND` | `127.0.0.1` | Host bind address for `:7878`. Set to `0.0.0.0` only if you have TLS in front. |
| `OPENCLAW_CONTROL_DISABLE` | `0` | Set to `1` to run the gateway only, no control plane. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | (empty) | OAuth app credentials. Empty → local-dev fallback only. |
| `DISCORD_REDIRECT_URI` | `http://localhost:7878/auth/discord/callback` | Must match the Discord Developer Portal exactly. |
| `DISCORD_ALLOWED_USER_IDS` | (empty) | CSV allowlist. **Set this** if exposing publicly. |
| `DISCORD_TOKEN_<ID>` | (none) | Per-agent bot token. Required for any agent the bot-bridge should run. |

---

## Where to look when something goes wrong

| Symptom | First place to look |
|---|---|
| Daemon won't start | `docker compose logs openclaw 2>&1 \| grep '\[control\]'` — usually port conflict, missing `OPENCLAW_LEADER_URL` on a follower, or migration failure |
| "DB migration failed" on the leader | Bind-mount perms on `/data` (must be writable by uid 1000) or stale schema_version row |
| Bot-bridge skips an agent (`no local persona`) | `~/.claude/local-memory/agents/<id>/persona.md` missing — re-run `setup.sh` or copy from another machine |
| Dispatch sits in `pending` forever | No follower lists the agent in `OPENCLAW_LOCAL_AGENT_IDS`, or the follower's SSE/HTTP can't reach the leader |
| Two leaders racing | Two machines have `OPENCLAW_LEADER=1`. Pick one. |
| Dashboard 401 from a phone | Discord OAuth redirect URI mismatch, or your user ID isn't in `DISCORD_ALLOWED_USER_IDS` |
| Poisoned dispatch | `failure_count` hit `OPENCLAW_DISPATCH_FAILURE_THRESHOLD`. See `docs/OPERATIONS.md` for the retry recipe |

Full table in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Multi-machine bootstrap — 4 steps, no fork

The same image and the same `setup.sh` runs on every host. The only difference between leader and follower is a few lines of `.env`.

1. **Clone the repo on every host.**
   ```bash
   git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
   cd ~/Desktop/fixing-openclaw/openclaw-control
   cp .env.example .env
   ```
2. **Edit `.env` per role.**
   - **Leader** — set `OPENCLAW_LEADER=1`. `OPENCLAW_SPECS_DB_PATH` defaults to `/data/specs.db` and is fine. Note the value of `OPENCLAW_INTERNAL_TOKEN` after first boot (or pin it before).
   - **Follower** — set `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL=https://<leader>` (or `http://leader.lan:7878`). Set `OPENCLAW_INTERNAL_TOKEN` to the **same** value the leader has, otherwise its API will reject your bearer.
3. **Run `docker compose up -d` on every host.** The leader's `entrypoint-control.sh` will create `/data/specs.db` and run schema migrations idempotently. Followers skip that step entirely.
4. **(Migrating from the git-era only)** SSH the leader and run `./scripts/cutover.sh` once to drop the old git-cloned spec tree and the legacy named volume. The cutover is destructive and acceptable to lose in-flight work — see `scripts/cutover.sh` for the exact prompts.

After step 3, hit `http://127.0.0.1:7878/api/health` on each host. Then `@<bot> hello` in Discord, or open the leader's dashboard at `http://127.0.0.1:7878`.

---

## What's next

This doc covers what shipped through slice 11 (free-form `@mention` chat with operational directives). Roadmap items intentionally out-of-scope here:

- Direct A2A calls (machine-to-machine without going through the git repo)
- Per-task budgets / rate limits per agent
- A web flow for adding a new follower (currently it's `provision-machine.sh`)

If something in this doc disagrees with the code, the code is the source of truth — open a PR.
