# OpenClaw on Docker — portable AI bot stack

A self-contained Docker setup that runs an [OpenClaw](https://github.com/openclaw/openclaw) AI agent connected to your local [Ollama](https://ollama.com) instance and a Discord bot, with a shared workspace for human + agent collaboration on real project files.

This repo packages everything needed to spin the same agent up on any machine: Dockerfile, compose, persona templates, skill library, and an idempotent bootstrap script.

---

## What it gives you

- **A Discord bot** that responds to `@mentions` in your guild, runs inference through Ollama, and posts replies back.
- **A web dashboard** at `http://127.0.0.1:18789` for direct chat.
- **A shared workspace** at `~/projects/` — bot writes there, you see the changes in your editor, and vice versa.
- **A skill + persona system** (markdown files) so you can shape the agent's behavior globally and per-project.
- **Reproducible setup** — `git clone && ./setup.sh` works on a fresh Ubuntu/Debian/Mint machine with Docker installed.

## Quick start (existing machine, already configured)

```bash
docker compose up -d
docker compose logs -f openclaw
```

Then in your Discord server: `@<your-bot> hello`

## Bootstrap on a new machine

```bash
git clone <this-repo> ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw

# Install Ollama (one-liner)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull kimi-k2.6:cloud      # or any *:cloud / local model

# Configure secrets
cp .env.example .env
nano .env                        # set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID

# Bootstrap
./setup.sh
```

`setup.sh` is idempotent: it verifies prereqs, writes the Ollama systemd override, generates the gateway auth token, creates `~/projects/` if missing, seeds it with persona templates, builds the Docker image, and starts the container. Re-runnable safely.

Detailed walkthrough: [docs/SETUP.md](docs/SETUP.md).

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — full new-machine bootstrap including Ollama install, Discord bot creation, and verification
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the container, mounts, OpenClaw gateway, Ollama, and Discord fit together
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every env var, every `openclaw.json` field, and which knobs are safe to turn
- [docs/SKILLS-AND-PERSONA.md](docs/SKILLS-AND-PERSONA.md) — how to author skills, layer persona globally and per-project, and import from Ptah
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — every alpha-software gotcha we hit during setup and the exact fix
- [docs/SECURITY.md](docs/SECURITY.md) — current security posture, what's deliberately *not* hardened, and planned improvements
- [docs/vision.md](docs/vision.md) — original architectural vision (agent-first CLI, A2A pipeline)

## Repo layout

```
.
├── Dockerfile                       # Debian + Node 22 + openclaw 2026.4.24
├── docker-compose.yml               # service, mounts, port forward, healthcheck
├── entrypoint.sh                    # renders config from template, exec gateway
├── setup.sh                         # host bootstrap (idempotent)
├── config/
│   └── openclaw.json.tmpl           # canonical openclaw config (envsubst template)
├── bin/
│   ├── openclaw-init-project.sh     # scaffold .openclaw/ in any project folder
│   └── sync-ptah-skills.sh          # refresh skills/commands from local Ptah harness
├── skills/                          # global skills (markdown), bind-mounted into container
│   ├── orchestration/
│   ├── ddd-architecture/
│   ├── ui-ux-designer/
│   ├── technical-content-writer/
│   ├── skill-creator/
│   ├── angular-frontend-patterns/
│   ├── angular-3d-scene-crafter/
│   └── angular-gsap-animation-crafter/
├── commands/                        # Ptah-style slash command definitions (reference)
│   └── orchestrate, review-code, review-logic, review-security, ...
├── templates/
│   └── workspace-seed/              # persona files copied to ~/projects/ on first run
│       ├── IDENTITY.md
│       ├── SOUL.md
│       ├── AGENTS.md
│       ├── USER.md
│       ├── TOOLS.md
│       └── HEARTBEAT.md
├── .env.example                     # copy to .env and fill in
└── docs/                            # detailed guides
```

Outside the repo, on the host:

```
~/projects/                          # shared workspace (bind-mounted into container)
├── IDENTITY.md, SOUL.md, ...        # global persona, copied from templates/workspace-seed/
├── memory/, state/                  # bot's session memory
└── <project-name>/                  # one folder per project
    ├── .git/
    ├── ...                          # actual project files
    └── .openclaw/                   # per-project agent config (created by openclaw-init-project.sh)
        ├── persona.md               # project-specific persona override
        ├── HEARTBEAT.md             # project-specific recurring tasks
        ├── skills/                  # project-only skills
        └── agents/                  # project-only sub-agents
```

## Common operations

```bash
# View logs
docker compose logs -f openclaw

# Open a shell in the container
docker compose exec openclaw bash

# Chat via TUI inside the container
docker compose exec openclaw openclaw tui

# Stop / restart
docker compose down
docker compose up -d

# Rebuild after editing Dockerfile or config template
docker compose up -d --build

# Initialize a new project's .openclaw/ folder
bin/openclaw-init-project.sh my-app

# Refresh skills from your local Ptah install
bin/sync-ptah-skills.sh
```

## Hardware reality

This stack is designed for **CPU-only machines** doing **cloud-routed inference**. Ollama Cloud (`*:cloud` models) sends requests to ollama.com which actually runs the model. If you have an NVIDIA GPU with ≥16 GB VRAM you can switch `OLLAMA_MODEL` to a local model like `qwen3:14b` for offline operation; the rest of the stack doesn't change.

What this **doesn't** give you:

- Local inference without internet (unless you have a GPU and pull a local model)
- Voice/video features (would need additional plugins + media access)
- Strong sandboxing (the agent runs in a Docker container; it's not a hardware-isolated VM)

## License

MIT for what we wrote here. OpenClaw, Ollama, Node, Debian, Discord libs each carry their own licenses — see their respective projects.
