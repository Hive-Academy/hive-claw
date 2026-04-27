# Architecture

How the pieces fit together.

---

## High-level diagram

```
┌─ HOST (Linux) ────────────────────────────────────────────────────┐
│                                                                   │
│   ~/projects/                  ←  shared workspace (you + bot)    │
│   ├── IDENTITY.md, SOUL.md     ←  global persona files            │
│   ├── memory/, state/                                             │
│   └── <project>/                                                  │
│       ├── .git/, src/, ...                                        │
│       └── .openclaw/           ←  per-project config              │
│           ├── persona.md                                          │
│           ├── skills/, agents/                                    │
│           └── HEARTBEAT.md                                        │
│                                                                   │
│   ~/Desktop/fixing-openclaw/                                      │
│   ├── skills/                  ←  global skills (bind-mounted)    │
│   ├── config/openclaw.json.tmpl  envsubst template                │
│   └── ...                                                         │
│                                                                   │
│   Ollama systemd service       0.0.0.0:11434  →  ollama.com       │
│                                                  (cloud models)   │
│                                                                   │
│   ┌─ Docker container `openclaw` ───────────────────────────────┐ │
│   │                                                             │ │
│   │   tini → entrypoint.sh → openclaw gateway --bind lan        │ │
│   │                                  ↓                          │ │
│   │   HTTP server :18789  ←──── port-forward 127.0.0.1:18789    │ │
│   │   ↓                                                         │ │
│   │   ┌─ plugins ──────────────────────────────────────────┐    │ │
│   │   │  acpx, browser, device-pair, phone-control,        │    │ │
│   │   │  talk-voice, discord                               │    │ │
│   │   │     ↓                                              │    │ │
│   │   │  discord plugin → discord.com gateway WS           │    │ │
│   │   │                   discord.com REST                 │    │ │
│   │   └────────────────────────────────────────────────────┘    │ │
│   │                                                             │ │
│   │   /home/agent/.openclaw/                                    │ │
│   │   ├── workspace/  ←  bind-mount ~/projects/                 │ │
│   │   ├── skills/     ←  bind-mount ./skills/                   │ │
│   │   └── (rest)      ←  named volume openclaw-state            │ │
│   │                                                             │ │
│   │   Outbound to host: http://host.docker.internal:11434/v1    │ │
│   │                     (Ollama OpenAI-compatible shim)         │ │
│   └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

---

## Components

### OpenClaw gateway (the daemon)

`openclaw gateway --port 18789 --bind lan --verbose`

A Node 22 process that:

- Loads `~/.openclaw/openclaw.json` (rendered from our template).
- Auto-enables a model provider plugin based on config (`ollama/<model>` → loads the `openclaw-provider-ollama` plugin).
- Bootstraps bundled plugins on first run: `acpx`, `browser`, `device-pair`, `discord`, `phone-control`, `talk-voice`. Plugin runtime deps (npm packages) install into `~/.openclaw/plugin-runtime-deps/` on first run; cached afterward.
- Starts an HTTP server on `:18789` for the dashboard, the canvas (`/__openclaw__/canvas/`), and inbound webhooks.
- Starts a "channels and sidecars" subsystem ~3 minutes after `gateway ready` — that's where Discord connects via WebSocket.

### Discord plugin

Inside the container, the `discord` plugin:

1. Reads `DISCORD_BOT_TOKEN` from env (resolved at config time via `envsubst`).
2. Connects to `gateway.discord.gg` (WSS) and authenticates as the bot.
3. Deploys 52 application commands via `PUT /applications/{app_id}/commands`.
4. Listens for `MessageCreate` events filtered by `groupPolicy=allowlist + guilds={configured-guild-id} + requireMention=true`.
5. On a matching mention, enqueues an agent run on a per-channel "lane" (`session:agent:main:discord:channel:<channel-id>`).
6. The agent calls Ollama via `host.docker.internal:11434/v1/chat/completions`, gets the response, and posts back to the Discord channel.

### Ollama on the host

Runs as a regular systemd service. Bound to `0.0.0.0:11434` via the drop-in override at `/etc/systemd/system/ollama.service.d/override.conf` (so the container can reach it through Docker's bridge gateway).

For `*:cloud` models, Ollama acts as a thin proxy: it accepts the OpenAI-compatible request and forwards it to `ollama.com` over HTTPS, streaming the response back. The actual model runs on Ollama's servers.

For local models (e.g. `qwen3:14b`), Ollama loads the model into RAM/VRAM and runs it locally.

### Persona / skills layering

Three layers of agent context, evaluated in order:

1. **Built-in OpenClaw system prompt** — describes the agent's tools (web search, file operations, channel management, etc.). ~28 KB. Comes from openclaw itself, not configurable.
2. **Global persona** — files at `~/projects/SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`. The agent reads these on session start.
3. **Per-project persona override** — when the agent's working directory is `~/projects/<project>/`, files in that project's `.openclaw/` directory override or supplement layer 2.

Skills are surfaced as slash commands. Each skill's `SKILL.md` defines its name, description, and instructions; when the agent recognizes a relevant query (or the user invokes the skill explicitly), the SKILL.md content is injected into the agent's context for that turn.

---

## Data flow: Discord mention → reply

1. **You type** `@anubis-bot hello` in `#general`.
2. **Discord delivers** `MessageCreate` event to the bot's gateway WS connection.
3. **discord plugin** validates: guild allowed? mention required? user not blocked? → enqueue.
4. **Lane queue** picks up the message, marks session `processing`, starts an embedded agent run.
5. **Agent assembles context**:
   - System prompt (28 KB)
   - Global persona files
   - Per-project persona (if cwd is set inside a project)
   - Conversation history (last N messages from same channel)
   - Skill definitions for skills the agent might invoke
   - Your message
6. **Agent calls Ollama**: `POST host.docker.internal:11434/v1/chat/completions` with the assembled prompt and `stream: true`.
7. **Ollama proxies** the request to `ollama.com` for cloud models, or runs locally for local models.
8. **Response streams back** as Server-Sent Events. The agent may invoke tools (file read, web search, exec command) mid-stream — each tool call is a synchronous round-trip.
9. **Final response** posts back to the Discord channel via `POST /channels/<id>/messages` REST call.
10. **Reaction emoji** shifts: 👀 (working) → ✅ removed (done). If errored: 😟.

Total wall-clock: typically 5–60 seconds depending on model, prompt size, and tool calls.

---

## File layout in the running container

```
/usr/local/bin/openclaw           # CLI binary (npm-installed)
/usr/lib/node_modules/openclaw/   # openclaw source
/etc/openclaw/openclaw.json.tmpl  # config template (baked into image)
/usr/local/bin/entrypoint.sh      # what tini exec's

/home/agent/                      # non-root user (uid 1000, matches host's anubis uid)
└── .openclaw/                    # most files in named volume openclaw-state
    ├── openclaw.json             # rendered from template at startup
    ├── plugin-runtime-deps/      # cached npm deps from first plugin install
    ├── agents/main/              # agent state, sessions
    ├── canvas/                   # canvas plugin state
    ├── credentials.json          # encrypted token store
    ├── workspace/                # ← BIND MOUNT to host's ${WORKSPACE_DIR}
    └── skills/                   # ← BIND MOUNT to host's ${SKILLS_DIR}
```

The `workspace/` and `skills/` bind mounts are sub-mounts that override the parent named-volume. This is intentional: openclaw state (sessions, plugin deps) persists in the named volume across container recreates, while project files and skills live on the host where you can edit them directly.

---

## Networking

- **Container network**: Docker's default bridge (`172.18.0.0/16`).
- **Container reaches host Ollama**: `host.docker.internal:11434` via `extra_hosts: ["host.docker.internal:host-gateway"]` in compose.
- **Host reaches container dashboard**: Docker port-forward `127.0.0.1:18789:18789` (loopback only, not exposed beyond your host).
- **Container reaches Discord**: outbound HTTPS to `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com`. No inbound port needed for Discord — it's all over the bot's outbound WebSocket.
- **Container reaches the internet**: full outbound (no egress firewall by default; see [SECURITY.md](SECURITY.md) for hardening notes).

---

## Why these specific choices

| Decision | Reason |
|---|---|
| Plain Docker, not NemoClaw / k3s | NemoClaw is alpha, has Landlock-related crashes, and its main value (NIM, OPA policy) isn't useful on a CPU-only personal box |
| Bind ~/projects to `~/.openclaw/workspace` (not `/workspace`) | OpenClaw's plugins assume their default workspace path; redirecting via mount is more compatible than custom cwd config |
| `bind: "lan"` instead of `HOST=0.0.0.0` env var | The env var has no effect — only the openclaw config / CLI flag does |
| `commands.useAccessGroups: false` at top level | Required for the bot to reply to anyone other than paired users; the schema rejects this key under `channels.discord` |
| Auth token in `.env`, not auto-generated by openclaw | Auto-generation conflicts with re-rendering the template each restart |
| `meta.lastTouchedVersion` + `meta.lastTouchedAt` in template | Without them, openclaw "auto-restores from backup" on every start, discarding our config |
| `bonjour` plugin disabled | mDNS multicast doesn't work on Docker bridge networks; the `@homebridge/ciao` lib throws an unhandled rejection that kills openclaw |
| Skills as bind mount, not baked into image | Lets you edit skills without rebuilding; rebuild only when Dockerfile/template changes |
| Persona seed in `templates/workspace-seed/`, copied on first run | Keeps the bot's identity portable across machines while letting it evolve on each host |

These were all learned empirically during initial setup — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the symptom-to-fix mapping.
