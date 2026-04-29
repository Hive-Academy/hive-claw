# openclaw-control — multi-machine, multi-agent control plane

The canonical doc for everything sitting on top of the openclaw gateway. If you only have one machine and one bot and you're happy with `@<bot> hello` in Discord, you don't need this — read [SETUP.md](SETUP.md) and stop. If you want a fleet of bots, each running on its own machine, sharing one task tree, picking up work from each other, and reachable from a single dashboard, read on.

---

## What it is

Three TypeScript processes shipped inside the same container as the openclaw gateway:

| Process | Port | Role |
|---|---|---|
| **daemon** | `:7878` | Fastify server. Owns the orchestration tasks, the git-backed shared specs repo, the dispatch queue, the dashboard, the REST + SSE API, and Discord OAuth. |
| **dashboard** | (served by the daemon) | Angular 19 SPA. Projects → tasks → kanban → approve / reject / handoff. Live agent status. Memory editor. |
| **bot-bridge** | none | Spawns one Discord client per agent registered locally. Routes `!commands` and free-form `@mention` chat into the daemon. |

Plus, on the network:

- A **private GitHub repo** holding the global task tree and shared memory (`OPENCLAW_SPECS_REPO_URL`).
- An optional **Redis** for cross-agent online/busy presence and the inbox bus.
- An optional **Tailscale Funnel** so the leader's dashboard is reachable from anywhere over TLS.

The whole thing runs inside the container `openclaw` started by `docker-compose.yml`. Same image as the gateway, same `entrypoint.sh`, same bind mounts. If the gateway runs, this runs.

---

## Topology — one leader, N followers

Each physical machine in the fleet runs the same image. They differ only in `.env`:

```
┌─ Anubis (leader) ─────────────────┐  ┌─ Amun (follower) ─────────────┐
│  OPENCLAW_LEADER=1                │  │  OPENCLAW_LEADER=0            │
│  OPENCLAW_LOCAL_AGENT_IDS=anubis  │  │  OPENCLAW_LOCAL_AGENT_IDS=amun│
│  DISCORD_TOKEN_ANUBIS=...         │  │  DISCORD_TOKEN_AMUN=...       │
│                                   │  │                               │
│  daemon → continuation loop ON    │  │  daemon → continuation loop   │
│         → dispatch worker ON      │  │            disabled (follower)│
│         → dashboard ON            │  │         → dispatch worker ON  │
│         → bot-bridge: anubis      │  │         → dashboard ON (LAN)  │
│                                   │  │         → bot-bridge: amun    │
└─────────────────┬─────────────────┘  └────────────────┬──────────────┘
                  │                                     │
                  └──────────── git fetch/push ─────────┘
                              github.com/<you>/openclaw-specs   (private)
```

Exactly one machine sets `OPENCLAW_LEADER=1`. That machine is the only one running the **continuation loop** (the thing that walks each task through `CONTEXT → DESCRIPTION → PLAN → … → DONE` and writes new dispatches). Followers run only the **dispatch worker**: they pull from git, claim dispatches addressed to their local agents via an atomic git rename + push, run the work locally, and push the result.

Both leaders and followers serve the dashboard locally on `127.0.0.1:7878`. Only the leader needs to be reachable publicly.

`OPENCLAW_LOCAL_AGENT_IDS` is the disjoint partition: `anubis` runs only on the leader, `amun` only on Amun, etc. If two machines list the same agent, one of them will lose every dispatch race; behavior is technically safe (atomic git rename) but the loser wastes pulls.

---

## The shared specs repo — the single source of truth

`OPENCLAW_SPECS_REPO_URL` points at a **private** GitHub repo. The daemon clones it on first boot to `~/.claude/shared-specs/` (bind-mounted from `OPENCLAW_SHARED_SPECS_DIR` on the host) and keeps it synced: `pullOnce()` runs every `OPENCLAW_GIT_PULL_MS` (default 15s); writes go through a serialized `commitAndPush()` that retries up to 3 times with rebase-on-conflict.

### Layout

```
shared-specs/
├── specs/
│   └── <project>/
│       ├── TASK_2026_001/
│       │   ├── context.md            # YAML frontmatter: assigned_agent, approvals, ...
│       │   ├── task-description.md   # written at CONTEXT phase
│       │   ├── implementation-plan.md
│       │   ├── tasks.md
│       │   ├── future-enhancements.md
│       │   ├── .invoker/             # gitignored — per-run logs
│       │   └── .dispatch/
│       │       ├── pending/<id>.json # committed by the leader
│       │       ├── taken/<id>.json   # atomic rename by the winning follower
│       │       └── done/<id>.json    # second rename after invocation finishes
│       └── TASK_2026_002/...
└── memory/
    ├── agents/<id>/identity.md       # PUBLIC bio. Visible to every machine.
    ├── users/<discord_id>/profile.md
    ├── threads/<channel_id>/recent.md
    └── projects/<slug>/notes.md
```

Every write to this tree results in a commit + push. Every read pulls first. Every machine sees the same data within ~15s of any change.

### What's NOT in the repo

`.gitignore` excludes `.invoker/` (run logs) and a few dotfiles. Nothing else there is private — if you wouldn't put it in the repo, don't put it under `shared-specs/memory/`.

For genuinely private state, the daemon has a separate **local memory** path.

---

## The persona privacy rule (slice 10)

The agent registry has two storage backends with intentionally different sync semantics:

| Backend | Path inside container | Synced to git? | What it holds |
|---|---|---|---|
| **shared** | `~/.claude/shared-specs/memory/agents/<id>/identity.md` | Yes (commit+push) | Public bio. Name, vibe, signature emoji. Anything you'd put on the agent's "about" page. |
| **local** | `~/.claude/local-memory/agents/<id>/persona.md` | **Never** | Private system prompt. Tone, idiosyncrasies, anything operationally sensitive. |

The split is enforced in `daemon/src/memory.ts` by `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}`. Writes to those filenames are routed to the local-only backend regardless of caller. There is no API path — internal or external — that can leak a persona over the network.

### Implications

- Anubis's persona lives **only** on the Anubis machine. Amun has no way to read it. Same in reverse.
- The bot-bridge's `loadAgents()` only registers an agent if `local-memory/agents/<id>/persona.md` exists. **An agent without a local persona is invisible to the bot-bridge.** This is why `setup.sh` scaffolds a stub from `templates/agent-persona.md.tmpl` — without it the bot won't come online.
- If you move an agent to a new machine, you copy the local persona file out-of-band (scp, password manager, whatever). Don't push it to the repo.

### Ownership check on writes

`memory.ts:assertAgentOwnership()`: writes to `agents/<id>/*` (any file, public or private) are rejected with HTTP 403 unless `<id>` is in this machine's `OPENCLAW_LOCAL_AGENT_IDS`. Reads have no such check — every machine can read every public bio. (Personas can't even be read remotely; they're not in the repo.)

If `OPENCLAW_LOCAL_AGENT_IDS` is empty, the ownership check is bypassed (single-machine / dev mode).

---

## The continuation loop and the dispatch queue

The leader's daemon runs `tickOnce()` every `OPENCLAW_TICK_MS` (default 30s). For each open task in the specs tree:

1. Skip if at a checkpoint and not yet approved (`task-description.md`, `implementation-plan.md`, `tasks.md@IMPLEMENTED`).
2. Look up the next phase prompt from `continuation.ts:buildPromptFor()` (one prompt per phase, with the right agent role baked in).
3. **If the assigned agent is local** (`agentId ∈ localAgentIds`): invoke `ptah --json session start --task <prompt>` directly. Fast path.
4. **If the assigned agent is remote**: write a `Dispatch` JSON into `specs/<project>/<task>/.dispatch/pending/<id>.json` and `commitAndPush()`. The owning machine sees the new file on its next pull (≤15s).

Followers run `processOneDispatch()` every 10s:

1. `pullOnce()`.
2. List `pending/*.json` filtered by `localAgentIds`.
3. Pick first; attempt `atomicRenameAndPush(pending → taken)`. If the source vanished mid-rename (someone else won), skip.
4. Invoke `ptah --json session start --task <prompt>` in the project's working dir. Same headless invocation as the leader's fast path.
5. After exit, rename `taken → done` and push.

**The continuation loop is leader-only.** Followers don't try to advance task phases themselves — they only execute work already-dispatched. This keeps the phase machine single-writer.

---

## Discord, the bot bridge, and the chat handler

### One bot, one token, per agent

Each agent registered under `local-memory/agents/<id>/` (with a non-empty `persona.md`) gets a Discord client in the bot-bridge. The token comes from `DISCORD_TOKEN_<UPPER_ID>` (e.g. `DISCORD_TOKEN_ANUBIS`) by default; overridable via `shared-specs/memory/agents/<id>/discord.json#tokenEnvVar`.

The legacy gateway-era variable `DISCORD_BOT_TOKEN` (used by the openclaw gateway's discord adapter) is kept in `.env.example` for backward compatibility but should be left empty when running the bot-bridge — otherwise you have two clients trying to log in as the same bot, which Discord will reject.

### `!commands`

The bot-bridge `commandRouter` handles a fixed set of commands: `!help`, `!projects`, `!tasks <slug>`, `!task <slug> <description>`, `!approve <id> [feedback]`, `!reject <id> [feedback]`, `!handoff <id> <agent>`, `!tick`. These map 1:1 to daemon REST calls authenticated via the `OPENCLAW_INTERNAL_TOKEN` service token.

### Free-form `@mention` chat (slice 11)

Mentioning the bot without `!` triggers `chat.ts:handleChat()`:

1. Build a system prompt: agent's public bio + private persona + Discord user profile + thread context + a "TOOLBELT" section listing available `<<oc:…>>` directives.
2. Pipe to `ptah --json session start --task <fullTask>` with a 180-second timeout.
3. Parse the model's reply. Strip any `<<oc:create_task project="…" description="…" agent="…">>`, `<<oc:approve task_id="…">>`, `<<oc:reject task_id="…">>`, `<<oc:handoff task_id="…" to_agent="…">>`, `<<oc:tick>>` directives from the tail.
4. Execute each directive against the daemon API (using the internal service token). Results get appended as a `— actions —` footer.
5. Reply in chunks of ≤1900 chars to satisfy Discord's message limit.

The tool is intentionally narrow. Pure questions stay as text answers; only action-shaped requests emit directives. There's no MCP/RPC roundtrip — directives are an agreed text format the bridge parses directly.

---

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
2. **Bot-bridge** parses the command, posts `POST /api/tasks` with internal token. Daemon writes `specs/openclaw-control/TASK_2026_007/context.md` + `commitAndPush`.
3. **Continuation tick (leader)**: task is at `CONTEXT`, assigned to `anubis`, no approval needed yet — invoke `project-manager` prompt locally. The ptah CLI runs in `/home/agent/.openclaw/workspace/openclaw-control/`, writes `task-description.md`, exits.
4. **Loop detects `task-description.md` exists** → phase advances to `DESCRIPTION`. This is a checkpoint. Daemon broadcasts `checkpoint.pending`.
5. **You, in Discord** (or the dashboard): `@anubis !approve TASK_2026_007`. Daemon updates the YAML frontmatter `approvals: { CONTEXT: true }` and `commitAndPush`.
6. **Loop dispatches `software-architect`** → writes `implementation-plan.md`. New checkpoint.
7. … continues through `PLAN → PENDING → IMPLEMENTED → QA_DONE → DONE`. Each step is a commit. Every commit pushes.
8. **If you handed off to `chappie`** at any phase: the next dispatch is written into `pending/`. Chappie's machine pulls within 15s, races to claim it, runs the prompt locally, pushes results. The leader sees the changes on its next pull and continues the loop.

You can watch the whole thing in the dashboard's SSE feed (`task.created`, `task.updated`, `dispatch.pending`, `dispatch.taken`, `dispatch.done`, `invoker.started`, `invoker.finished`, `git.pulled`, `git.pushed`, `checkpoint.pending`, `checkpoint.approved`).

---

## Configuration index

For the full env reference see [CONFIGURATION.md](CONFIGURATION.md). Highest-impact knobs:

| Var | Default | Effect |
|---|---|---|
| `OPENCLAW_LEADER` | `0` | Set to `1` on exactly one machine. Enables the continuation loop and is where the dashboard lives publicly. |
| `OPENCLAW_LOCAL_AGENT_IDS` | (empty) | CSV list of agents this machine owns. Empty = ownership checks bypassed (dev mode). |
| `OPENCLAW_SPECS_REPO_URL` | (empty) | HTTPS URL of the private GitHub repo. Empty = local-only, no sync. |
| `OPENCLAW_GIT_TOKEN` | (empty) | GitHub PAT with `repo` scope. Required when `OPENCLAW_SPECS_REPO_URL` is HTTPS. |
| `OPENCLAW_JWT_SECRET` | (auto-generated by setup.sh) | JWT signing secret. Rotate to invalidate sessions. |
| `OPENCLAW_INTERNAL_TOKEN` | (auto-generated on first boot) | Service token for bot-bridge ↔ daemon. Copy from logs into `.env` to pin. |
| `OPENCLAW_TICK_MS` | `30000` | Continuation loop interval (ms). Leader only. |
| `OPENCLAW_GIT_PULL_MS` | `15000` | Git pull interval (ms). |
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
| Daemon won't start | `docker compose logs openclaw 2>&1 \| grep '\[control\]\|\[git-sync\]'` — usually clone failure or port conflict |
| "git not initialized" errors | `OPENCLAW_SPECS_REPO_URL` / `OPENCLAW_GIT_TOKEN` mismatch or repo doesn't exist |
| Bot-bridge skips an agent (`no local persona`) | `~/.claude/local-memory/agents/<id>/persona.md` missing — re-run `setup.sh` or copy from another machine |
| Dispatch sits in `pending/` forever | No follower lists the agent in `OPENCLAW_LOCAL_AGENT_IDS`, or the follower isn't pulling |
| Two leaders racing | Two machines have `OPENCLAW_LEADER=1`. Pick one. |
| Dashboard 401 from a phone | Discord OAuth redirect URI mismatch, or your user ID isn't in `DISCORD_ALLOWED_USER_IDS` |

Full table in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## What's next

This doc covers what shipped through slice 11 (free-form `@mention` chat with operational directives). Roadmap items intentionally out-of-scope here:

- Direct A2A calls (machine-to-machine without going through the git repo)
- Per-task budgets / rate limits per agent
- A web flow for adding a new follower (currently it's `provision-machine.sh`)

If something in this doc disagrees with the code, the code is the source of truth — open a PR.
