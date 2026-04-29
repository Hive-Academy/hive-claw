# openclaw-control

A multi-machine, multi-agent control plane on top of [OpenClaw](https://github.com/openclaw/openclaw) and [ptah-cli](https://www.npmjs.com/package/@hive-academy/ptah-cli). Each machine runs the same Docker container, owns one or more named agents, and shares a single global task tree via a private GitHub repo. The leader exposes one dashboard publicly; followers pick up work addressed to them and push results back. Discord is the primary interface (one bot per agent).

This repo started life as a single-laptop OpenClaw + Ollama + Discord bot setup. That tier still ships and still works — see [docs/SETUP.md](docs/SETUP.md). The control plane is built on top of it, in the same image, with `OPENCLAW_CONTROL_DISABLE=0` (default).

---

## Two ways to use this

**Single-machine, gateway-only.** One bot, one Ollama, one shared `~/projects/` workspace. The OG OpenClaw experience. Set `OPENCLAW_CONTROL_DISABLE=1` and stop reading after [docs/SETUP.md](docs/SETUP.md).

**Multi-machine control plane (default).** N machines, N agents, one private specs repo, one public dashboard. Tasks flow through phases (`CONTEXT → DESCRIPTION → PLAN → … → DONE`); each phase dispatches a headless `ptah` invocation to whichever machine owns the assigned agent. Audit log = git log. Atomic claim = git push with rebase. Backup = `git clone`. Read [docs/OPENCLAW_CONTROL.md](docs/OPENCLAW_CONTROL.md).

---

## Quick start (the leader on a fresh machine)

```bash
# 1. Prereqs (one-time)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
curl -fsSL https://ollama.com/install.sh | sh
ollama pull kimi-k2.6:cloud   # or any *:cloud / local model

# 2. Clone + provision
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw
./scripts/provision-machine.sh \
    --agent anubis \
    --role leader \
    --repo https://github.com/<you>/openclaw-specs   # private repo, create it first

# 3. Edit secrets that the script can't generate
$EDITOR .env                  # set OPENCLAW_GIT_TOKEN, DISCORD_CLIENT_ID/SECRET,
                              # DISCORD_TOKEN_ANUBIS, DISCORD_ALLOWED_USER_IDS
$EDITOR ~/.claude/local-memory/agents/anubis/persona.md   # the bot's voice

# 4. Restart with the new env
./scripts/dc.sh compose up -d

# 5. (Optional) expose the dashboard publicly
tailscale up --ssh
tailscale funnel --bg --https=443 7878
```

Dashboard at `http://127.0.0.1:7878` (or your Tailscale Funnel URL). Mention the bot in Discord.

## Quick start (a follower on a second machine)

```bash
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw
./scripts/provision-machine.sh \
    --agent amun \
    --role follower \
    --repo https://github.com/<you>/openclaw-specs

$EDITOR .env                  # OPENCLAW_GIT_TOKEN, DISCORD_TOKEN_AMUN
$EDITOR ~/.claude/local-memory/agents/amun/persona.md

./scripts/dc.sh compose up -d
```

`amun`'s persona stays on this machine forever. The leader can't read it, dispatched tasks pick it up automatically when this machine claims them.

---

## Architecture in 60 seconds

- **Gateway tier** — `openclaw gateway` on `:18789`. The original OpenClaw stack: plugins, canvas, model providers. One per machine.
- **Daemon** — Fastify on `:7878`. Serves the dashboard, the REST + SSE API, the Discord OAuth, and the continuation loop. One per machine; only the leader's runs the loop.
- **Bot-bridge** — One `discord.js` client per agent registered locally. Routes `!commands` and free-form `@mention` chat into the daemon. Generates `<<oc:create_task …>>` directives.
- **Specs repo** — Private GitHub repo cloned at `~/.claude/shared-specs/`. Holds `specs/<project>/TASK_*` (the orchestration task tree) and `memory/{agents,users,threads,projects}/` (shared context). Every write is a commit. Daemon pulls every 15s.
- **Local memory** — `~/.claude/local-memory/`. Holds private agent personas. **Never** synced. Each machine has its own.
- **Dispatch queue** — `specs/<project>/<task>/.dispatch/{pending,taken,done}/<id>.json`. Atomic claim by git push with rebase. Followers pick up dispatches addressed to their `OPENCLAW_LOCAL_AGENT_IDS`.

ASCII diagram + flow walk-through: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Operational details: [docs/OPENCLAW_CONTROL.md](docs/OPENCLAW_CONTROL.md).

---

## Documentation

| File | What it covers |
|---|---|
| [docs/OPENCLAW_CONTROL.md](docs/OPENCLAW_CONTROL.md) | **Canonical** control-plane doc — leader/follower, specs repo, dispatch queue, persona privacy, chat handler, Tailscale Funnel, end-to-end task flow |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Multi-machine topology, container process tree, bind mounts, networking, gateway internals |
| [docs/SETUP.md](docs/SETUP.md) | New-machine bootstrap (leader vs follower fork), Discord OAuth app, Ollama, gh + Ptah auth |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every env var and `openclaw.json.tmpl` field |
| [docs/SKILLS-AND-PERSONA.md](docs/SKILLS-AND-PERSONA.md) | The two persona systems (workspace vs registered agent) reconciled |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, what's hardened, persona privacy invariant, hardening recipes |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom-to-fix table, gateway + control plane |
| [docs/archive/vision.md](docs/archive/vision.md) | Pre-implementation design notes (kept for historical context) |

---

## Repo layout

```
.
├── README.md, CLAUDE.md                # this file + the architecture summary for future agents
├── Dockerfile, docker-compose.yml      # one image, both tiers
├── entrypoint.sh                       # gateway tier launcher
├── setup.sh                            # idempotent host bootstrap (12 phases)
├── .env.example                        # grouped, commented; copy to .env and edit
│
├── scripts/
│   ├── dc.sh                           # docker wrapper bypassing global credsStore
│   ├── provision-machine.sh            # fresh-machine bootstrap (calls setup.sh)
│   └── update-machine.sh               # git pull + compose up + health check
│
├── config/openclaw.json.tmpl           # gateway config template
├── skills/, commands/                  # gateway-era skills + slash command defs
├── bin/openclaw-init-project.sh        # scaffold .openclaw/ in any project folder
├── bin/sync-ptah-skills.sh             # refresh skills from local Ptah
│
├── templates/
│   ├── workspace-seed/                 # IDENTITY.md/SOUL.md/etc. for the gateway workspace
│   └── agent-persona.md.tmpl           # control-plane agent persona scaffold
│
├── openclaw-control/
│   ├── README.md                       # pointer → docs/OPENCLAW_CONTROL.md
│   ├── entrypoint-control.sh           # daemon + bot-bridge launcher
│   ├── daemon/                         # Fastify daemon (TS, ESM)
│   ├── dashboard/                      # Angular 19 SPA
│   └── bot-bridge/                     # discord.js bot per agent
│
└── docs/                               # the docs in the table above
```

On every machine, outside the repo:

```
~/.claude/
├── shared-specs/             # ← bind-mounted, cloned from OPENCLAW_SPECS_REPO_URL, every write is a commit
├── local-memory/             # ← bind-mounted, NEVER synced — agent personas live here
└── projects/                 # ← bind-mounted read-only — claude code session JSONLs (live-feed UI)

~/projects/                   # ← gateway-tier workspace (only used if you also run the gateway)
~/.ptah/                      # ← bind-mounted, shared with the host's ptah CLI
~/.config/gh/                 # ← bind-mounted, shared with the host's gh CLI
```

---

## Common operations

```bash
# Restart on .env change (no rebuild)
./scripts/dc.sh compose up -d

# Restart on code change (rebuild image)
./scripts/dc.sh compose up -d --build

# Logs
./scripts/dc.sh compose logs -f openclaw
./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-daemon.log
./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log

# Update this machine after a release
./scripts/update-machine.sh

# Provision a new follower
scp scripts/provision-machine.sh user@new-host:
ssh user@new-host './provision-machine.sh --agent <id> --role follower --repo <url>'

# Edit your agent's persona (private to this machine)
$EDITOR ~/.claude/local-memory/agents/<id>/persona.md
# (no restart needed — the bot-bridge re-reads on next message)

# Watch the specs tree live
git -C ~/.claude/shared-specs log --oneline -20
```

---

## Hardware reality

The control plane itself is light (a Fastify daemon, an Angular SPA, a few `discord.js` clients). Each agent's actual *work* is done by `ptah --json session start` subprocesses, which call out to whatever inference provider you have configured — that's where the cost and latency live.

For CPU-only machines, default to `*:cloud` Ollama models or hosted providers (Anthropic, OpenAI, OpenRouter). For GPU machines, you can run local models and stay offline. The control plane doesn't care which.

What this stack **doesn't** give you:

- Voice / video / phone (gateway has plugins for this; control plane doesn't wire them up)
- Strong sandboxing (containers are not VMs; the agent has the same trust as your shell)
- Production multi-tenancy (single-operator-with-multiple-bots is the design point, not multi-customer SaaS)

---

## License

MIT for what we wrote here. OpenClaw, Ollama, Node, Debian, Discord, Angular, Fastify each carry their own.
