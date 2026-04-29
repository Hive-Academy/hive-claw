# Architecture

The stack is two tiers stacked on the same container, optionally federated across machines.

- **Tier 1 — gateway**: openclaw running an HTTP server on `:18789`. Loads `~/.openclaw/openclaw.json`, talks to your inference provider, drives the legacy openclaw plugins (browser, talk-voice, etc.). Single-machine, single-agent. This is the original openclaw stack.
- **Tier 2 — control plane**: a Node daemon on `:7878`, the Angular dashboard it serves, and a multi-agent Discord bot-bridge — all sharing the gateway's image + entrypoint. Multi-machine, multi-agent. Built on top of the gateway, doesn't replace it.

If you're a single-user-on-a-single-laptop case, you can disable tier 2 with `OPENCLAW_CONTROL_DISABLE=1` and the rest of this doc collapses to the "gateway internals" section.

For the operational view of tier 2 — leader/follower split, specs repo, persona privacy, dispatch flow — see [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md). This file covers the architectural shape: what runs where, what talks to what, and why.

---

## Multi-machine topology (tier 2)

```
                    ┌────────────────────────────────────────────────┐
                    │  github.com/<you>/openclaw-specs   (private)   │
                    │   specs/<project>/TASK_*/.dispatch/{p,t,d}     │
                    │   memory/{agents,users,threads,projects}/      │
                    └────────────────┬──────────────┬────────────────┘
                                     │              │
                                pull/push       pull/push  (every 15s)
                                     │              │
       ┌─────────────────────────────┼──────────────┼────────────────────────────────┐
       │                             │              │                                │
┌──────▼─────── HOST: Anubis (leader) ────────┐   ┌──▼─────── HOST: Amun (follower) ──────────┐
│                                             │   │                                            │
│  ~/.claude/                                 │   │  ~/.claude/                                │
│  ├── shared-specs/    ← clone, bind-mount   │   │  ├── shared-specs/   ← clone, bind-mount   │
│  ├── local-memory/    ← persona, never sync │   │  ├── local-memory/   ← persona, never sync │
│  └── projects/        ← claude session JSONL│   │  └── projects/       ← claude session JSONL│
│                                             │   │                                            │
│  Container `openclaw` (one image, one IP)   │   │  Container `openclaw`                      │
│  ┌─────────────────────────────────────┐    │   │  ┌─────────────────────────────────────┐   │
│  │ entrypoint.sh                       │    │   │  │ entrypoint.sh                       │   │
│  │  ├─ openclaw gateway :18789  ★      │    │   │  │  ├─ openclaw gateway :18789  ★      │   │
│  │  └─ entrypoint-control.sh           │    │   │  │  └─ entrypoint-control.sh           │   │
│  │      ├─ daemon :7878                │    │   │  │      ├─ daemon :7878                │   │
│  │      │   • LEADER mode              │    │   │  │      │   • follower mode            │   │
│  │      │   • continuation loop ON     │    │   │  │      │   • continuation loop OFF    │   │
│  │      │   • dispatch worker ON       │    │   │  │      │   • dispatch worker ON       │   │
│  │      │   • dashboard, REST, SSE     │    │   │  │      │   • dashboard (LAN only)     │   │
│  │      └─ bot-bridge: anubis client   │    │   │  │      └─ bot-bridge: amun client     │   │
│  └─────────────────────────────────────┘    │   │  └─────────────────────────────────────┘   │
│                                             │   │                                            │
│  Tailscale Funnel  →  https://anubis...     │   │  (loopback only)                           │
└─────────────────────────────────────────────┘   └────────────────────────────────────────────┘

★ = the gateway from tier 1, unchanged.
```

The leader and the follower(s) only ever talk through the git repo. There's no direct daemon-to-daemon RPC; the repo's `.dispatch/{pending,taken,done}` directories are the queue, and `git push` with rebase-on-conflict is the lock. This makes the whole control plane partition-tolerant for free — disconnect a follower for an hour, reconnect, it catches up by pulling.

The dashboard runs everywhere, but only the leader's is reachable from outside its own loopback. Followers' dashboards are useful for local debugging and for editing local-memory (their own agent's persona) without SSH'ing in.

### Single-machine collapse

If only one machine is in the picture: `OPENCLAW_LEADER=1`, `OPENCLAW_LOCAL_AGENT_IDS=anubis`, `OPENCLAW_SPECS_REPO_URL` either points at a private repo (you still get a full audit log + remote backup) or is left empty (local-only). All the same code paths run; the dispatch worker just never finds remote dispatches because there's no other machine writing them.

---

## Inside the container — process tree

```
tini (PID 1)
└── entrypoint.sh
    ├── (renders ~/.openclaw/openclaw.json, runs Ptah/gh bootstrap)
    ├── exec: entrypoint-control.sh   ← only if OPENCLAW_CONTROL_DISABLE!=1
    │       │
    │       ├── node /opt/openclaw-control/daemon/dist/index.js   (background)
    │       │     • Fastify on :7878
    │       │     • clone shared-specs on first boot, pull every 15s
    │       │     • leader: continuation loop every 30s
    │       │     • all: dispatch worker every 10s (no-op if localAgentIds empty)
    │       │     • spawns ptah CLI subprocesses for each invocation
    │       │
    │       └── node /opt/openclaw-control/bot-bridge/dist/index.js (background, only if any DISCORD_TOKEN_* set)
    │             • discord.js client per agent
    │             • spawns ptah CLI subprocesses for free-form chat
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
~/.claude/shared-specs/                      →    /home/agent/.claude/shared-specs/   rw   (control plane: git clone, both directions)
~/.claude/local-memory/                      →    /home/agent/.claude/local-memory/   rw   (control plane: persona, NEVER synced)
~/.claude/projects/                          →    /home/agent/.claude/projects/       ro   (claude code session JSONLs, for live-feed UI)
named volume: openclaw-state                 →    /home/agent/.openclaw/              rw   (gateway runtime: plugin deps, sessions, state)
```

The named volume `openclaw-state` parents `workspace/` and `skills/`, but those two are sub-mounted from the host — host wins for files inside them, the named volume keeps everything else (plugin-runtime-deps, agent state, canvas, credentials.json).

---

## Networking

```
HOST                     CONTAINER                         INTERNET
                                                          
:18789 (loopback)  ←──── openclaw gateway :18789           ─────► api.openai.com / api.anthropic.com
                          (controlled by OPENCLAW_         ─────► ollama.com (when *:cloud models)
                           CONTROL_BIND, default 127.0.0.1) ────► host.docker.internal:11434 → host Ollama
                                                          
:7878 (loopback by         openclaw-control daemon :7878   ─────► github.com (git push/pull)
default; 0.0.0.0 if you    + dashboard SPA                 ─────► discord.com (OAuth + bot gateway WS)
opt in)                                                    ─────► ollama.com / model providers (via ptah subprocess)
                                                          
                          openclaw-redis :6379             (container-internal only, never published)
```

**Public exposure path** (leader only): Tailscale Funnel terminates TLS on `:443` and proxies to `127.0.0.1:7878`. The daemon doesn't speak HTTPS itself; it relies on whatever TLS terminator sits in front. See [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md) for the Funnel setup recipe.

---

## How a Discord mention becomes a dispatched task

1. **You**: `@anubis !task fixing-openclaw add a /api/whoami endpoint` in your Discord guild.
2. **Bot-bridge** (Anubis machine) — discord.js fires `messageCreate`. `commandRouter` parses `!task`, calls `daemon.createTask({project, description, agentId: 'anubis', discordUserId, channelId})` over loopback HTTP with `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`.
3. **Daemon** — `createTask()` writes `specs/fixing-openclaw/TASK_2026_NNN/context.md` (with YAML frontmatter holding `assigned_agent`, `discord_user_id`, `channel_id`, `approvals: {}`), then `commitAndPush()` — one commit, one push to GitHub.
4. **Dashboard** — every browser with the SSE stream open receives `task.created` and re-renders.
5. **Continuation loop tick (leader)** — within 30s, `tickOnce()` discovers the new task, sees `phase=CONTEXT`, no checkpoint pending. Looks up `agentId='anubis'` — local. Skips git, fast-paths into `invokeClaudeForTask({…})`.
6. **Invoker** — `spawn('ptah', ['--json', '--cwd', '/home/agent/.openclaw/workspace/fixing-openclaw', '--auto-approve', 'session', 'start', '--profile', 'claude_code', '--task', '<the project-manager prompt>'])`. NDJSON of JSON-RPC events streams to the daemon's SSE. The ptah subprocess writes `task-description.md` and exits 0.
7. **Next tick** — phase advances to `DESCRIPTION`. That's a checkpoint. Daemon broadcasts `checkpoint.pending`. Dashboard shows an "Approve / Reject" button for that phase.
8. **You click Approve** (or reply `!approve TASK_2026_NNN`). YAML frontmatter gets `approvals: { CONTEXT: true }`. Push.
9. **Loop continues** through `PLAN → PENDING → … → DONE`, each step a commit.

If at step 5 the agent had been `chappie` instead, step 5 would have written `pending/<id>.json` to the dispatch dir + pushed. Chappie's machine would pull within 15s, atomically rename to `taken/`, run the prompt locally, push the result, then rename to `done/`. The leader picks up the file changes on its next pull and continues.

---

## Why git as the queue

Three things git gives us that we'd otherwise have to build:

- **Atomic claim**: `git mv pending/X.json taken/X.json && git push --rebase` either succeeds (we own the dispatch) or fails because someone else got there first. No central lock service required.
- **Audit log**: every state change is a commit. `git log specs/<project>/<task>/` is the task's full history including who dispatched what to whom.
- **Backup + portability**: a brand-new machine can be brought up by `git clone`, no state migration. Lose a follower, replace it, it pulls and is current.

The cost is latency (~15s for a follower to see a new dispatch) and the requirement that every machine has push access to the same private repo. Both have been acceptable in practice.

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

This is **separate** from the control-plane agent registry's persona system (`shared-specs/memory/agents/<id>/identity.md` + `local-memory/agents/<id>/persona.md`). Same word, different scope: the workspace persona shapes the gateway's single agent; the control-plane persona shapes a specific registered bot. See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for the reconciliation.

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
    ├── shared-specs/                        # ← BIND MOUNT, control-plane git clone
    ├── local-memory/                        # ← BIND MOUNT, NEVER synced
    └── projects/                            # ← BIND MOUNT (read-only), claude session JSONLs
```

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
| Git as the dispatch queue (vs Redis) | Atomic claim + audit log + backup + multi-machine all for free. Latency cost (~15s) is acceptable for orchestration timescales. |
| Persona stored locally, never synced | The persona is the agent's voice — the operator decides what's in it; sharing it across machines is the operator's call, not the system's. |
| One bot token per agent (vs one shared bot) | Easier to revoke, no Discord rate-limit collisions, presence is per-agent. |

These were all learned empirically. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for symptom-to-fix mapping.
