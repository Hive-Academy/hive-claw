# openclaw-control (subpackage)

The multi-machine control plane that ships in the same Docker image as the openclaw gateway. This README is a pointer — the canonical operational doc lives at [`../docs/OPENCLAW_CONTROL.md`](../docs/OPENCLAW_CONTROL.md), the architectural shape at [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## What's here

```
openclaw-control/
├── entrypoint-control.sh   # launcher: daemon + (optional) bot-bridge
├── daemon/                 # Fastify TS daemon — :7878
│   └── src/
│       ├── index.ts        # entry, Fastify wiring
│       ├── api.ts          # REST routes (/api/projects, /api/tasks, ...)
│       ├── auth.ts         # Discord OAuth + JWT + service-token bypass
│       ├── config.ts       # env → config object
│       ├── continuation.ts # leader's continuation loop (phase machine)
│       ├── dispatch.ts     # follower's dispatch worker (atomic claim)
│       ├── gitSync.ts      # clone, pull-loop, commit+push with rebase retries
│       ├── invoker.ts      # spawns ptah-cli for headless agent invocations
│       ├── memory.ts       # shared (git) vs local (per-machine) backends
│       ├── phase.ts        # parses TASK_*/ folders into Phase summaries
│       ├── projects.ts     # discovers projects under specs/
│       ├── sessions.ts     # claude code session JSONL feed
│       ├── sse.ts          # /api/stream broadcast bus
│       ├── watcher.ts      # filesystem change → SSE
│       ├── agents.ts       # /api/agents — registered agent listing
│       └── bus.ts          # Redis pub/sub for cross-agent presence (optional)
├── dashboard/              # Angular 19 SPA — built into ../dashboard/dist/dashboard/browser
└── bot-bridge/             # discord.js multi-agent bot — :no port
    └── src/
        ├── index.ts        # spawns one client per registered agent
        ├── agentRegistry.ts # loads agents from local-memory + shared-specs
        ├── chat.ts         # free-form @mention → ptah → directives
        ├── commandRouter.ts # !task / !approve / !reject / !handoff / !tick
        ├── daemonClient.ts # HTTP client to the daemon (uses internal token)
        └── config.ts       # env → config object
```

## Dev mode (no Docker)

```bash
cd openclaw-control/daemon && npm install
OPENCLAW_DISABLE_CONTINUATION=1 npm run dev   # avoid spawning ptah while iterating

# separately:
cd openclaw-control/dashboard && npm install && npm start
```

Without `DISCORD_CLIENT_ID` set, the daemon falls back to a `local-dev` user — fine for localhost dev, **never expose this mode to a network**.

## Production mode

It's just `docker compose up -d --build` from the repo root. The daemon and bot-bridge are baked into the same image as the gateway, started by [`entrypoint-control.sh`](entrypoint-control.sh) which is invoked by the main [`../entrypoint.sh`](../entrypoint.sh).

## Where to read next

- New to this? **[`../docs/OPENCLAW_CONTROL.md`](../docs/OPENCLAW_CONTROL.md)** — what the control plane is, what each piece does, how a task flows.
- Trying to install? **[`../docs/SETUP.md`](../docs/SETUP.md)** — leader and follower bootstrap.
- Trying to configure? **[`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md)** — every env var.
- Trying to understand the pieces? **[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)** — diagrams + process tree.
- Something's broken? **[`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md)** — symptom-to-fix table.
