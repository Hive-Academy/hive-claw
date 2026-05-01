# Configuration reference

Every knob you can turn, where it lives, and what's safe to change.

The configuration surface splits cleanly into two tiers:

- **Gateway tier** — env vars and `openclaw.json.tmpl` fields that drive the openclaw gateway on `:18789`. Sections: Inference, Workspace + skills, Discord-gateway-adapter, `openclaw.json` template fields.
- **Control-plane tier** — env vars consumed by the `openclaw-control` daemon, dashboard, and bot-bridge on `:7878`. Sections: Control-plane core, Leader/follower, Specs repo, Local memory, Discord OAuth, Per-agent bot tokens.

If you only run the gateway (`OPENCLAW_CONTROL_DISABLE=1`), skip the control-plane sections.

---

## `.env` — environment variables

Loaded by docker-compose at container start. **Gitignored.** `chmod 600` recommended.

### Gateway tier — Inference

| Variable | Default | What it does |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | Inference backend: `ollama`, `openai`, `anthropic`, `openrouter`, `groq`, or `custom`. |
| `LLM_MODEL` | `kimi-k2.6:cloud` | Model id as the chosen provider expects it (e.g. `gpt-4o`, `claude-sonnet-4-6`). |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434/v1` | Used only when `LLM_PROVIDER=ollama`. |
| `OPENAI_API_KEY` | (empty) | Required when `LLM_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | (empty) | Required when `LLM_PROVIDER=anthropic`. |
| `OPENROUTER_API_KEY` | (empty) | Required when `LLM_PROVIDER=openrouter`. |
| `GROQ_API_KEY` | (empty) | Required when `LLM_PROVIDER=groq`. |
| `CUSTOM_BASE_URL` / `CUSTOM_API_KEY` | (empty) | Required when `LLM_PROVIDER=custom`. |

The entrypoint reads `LLM_PROVIDER`, builds the matching provider block via `jq`, and substitutes it into the rendered config. Only the API key matching the chosen provider needs a value.

### Gateway tier — Workspace, skills, and dashboard auth

| Variable | Default | What it does |
|---|---|---|
| `WORKSPACE_DIR` | `${HOME}/projects` | Host directory bind-mounted as the gateway's workspace. |
| `SKILLS_DIR` | `./skills` | Host skills dir, bind-mounted into `~/.openclaw/skills/`. |
| `OPENCLAW_AUTH_TOKEN` | (auto by setup.sh) | Bearer token gating the **gateway** dashboard on `:18789`. 32-byte hex. |

### Gateway tier — Legacy Discord adapter

The openclaw gateway has its own `discord` plugin. When the control plane is in use, the bot-bridge owns Discord and these stay empty. Setting them while the bot-bridge is also running causes Discord to reject one of the two clients (same bot can't be online twice).

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_BOT_TOKEN` | (empty → channel disabled) | Gateway adapter's bot token. Leave empty when running the bot-bridge. |
| `DISCORD_GUILD_ID` | (empty → channel disabled) | Server ID. Same caveat. |

If both are empty, the entrypoint disables the gateway's discord adapter automatically.

### Gateway tier — Ptah / gh

| Variable | Default | What it does |
|---|---|---|
| `PTAH_CONFIG_DIR` | `${HOME}/.ptah` | Host path; bind-mounted so host + container share Ptah auth + settings. |
| `PTAH_WORKSPACE_NAME` | basename of `WORKSPACE_DIR` | Workspace label registered with `ptah` on first boot. |
| `GH_CONFIG_DIR` | `${HOME}/.config/gh` | Host path; bind-mounted so a single `gh auth login` works for both. |
| `GH_AUTH_MODE` | `file` | `file` / `keyring` / `token` / `skip` — controls how `gh` stores tokens (only `file` works with the bind mount). |
| `GITHUB_TOKEN` | (empty) | Optional fallback when `gh auth login` isn't an option. |

### Control plane tier — Core

Defaults below are read in `openclaw-control/daemon/src/config.ts` (the cited line numbers refer to that file).

| Variable | Default | Required when | Tier | What it does |
|---|---|---|---|---|
| `OPENCLAW_CONTROL_DISABLE` | `0` | always optional | both | Set to `1` to skip starting the daemon and bot-bridge entirely. Read by `entrypoint-control.sh`, not the daemon. |
| `OPENCLAW_CONTROL_BIND` | `127.0.0.1` | always optional | both | Host bind for `:7878`. Set to `0.0.0.0` only with TLS in front. (Compose-side, not the daemon.) |
| `OPENCLAW_PORT` | `7878` (`config.ts:21`) | always optional | both | Daemon port inside the container. Rarely changed. |
| `OPENCLAW_HOST` | `127.0.0.1` (`config.ts:22`) | always optional | both | Daemon bind inside the container. |
| `OPENCLAW_PUBLIC_URL` | `http://localhost:7878` (`config.ts:23`) | always optional | both | Self-referencing URL used in OAuth redirects. |
| `OPENCLAW_JWT_SECRET` | `dev-secret-change-me` (`config.ts:67`) | always set in production | both | JWT signing secret for browser sessions. Rotate to invalidate every session. setup.sh auto-generates a real value if empty. |
| `OPENCLAW_INTERNAL_TOKEN` | empty (`config.ts:70`) | required for follower↔leader and bot-bridge↔daemon calls | both | Bearer token for service-to-service. **Must match exactly between the leader and every follower.** Copy from logs or pin in `.env`. |
| `OPENCLAW_TICK_MS` | `30000` (compose-side; not in `config.ts`) | always optional | leader-only | Continuation loop interval. The follower does not run the loop. |
| `OPENCLAW_DEFAULT_PROJECT` | empty (compose-side; not in `config.ts`) | always optional | both | Used by `!task <description>` when no project is supplied. |
| `OPENCLAW_PTAH_BRIDGE_URL` | empty → fallback (`config.ts:102`) | always optional | both | URL of the host-side ptah-bridge. Empty = spawn ptah inside the container. See [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md#orchestration-runs-via-the-host-side-ptah-bridge). |

### Control plane tier — Leader / follower mode

| Variable | Default | Required when | Tier | What it does |
|---|---|---|---|---|
| `OPENCLAW_LEADER` | `0` (`config.ts:6`) | always | both | Exactly one machine in the fleet should set `1`. Enables the continuation loop, opens the SQLite spec store, and is where the public dashboard lives. |
| `OPENCLAW_LOCAL_AGENT_IDS` | empty (`config.ts:35`) | required to dispatch local agents | both | CSV of agent ids this machine owns. Empty = ownership checks bypassed (single-machine dev mode). On a real fleet, must be **disjoint** between machines. |
| `OPENCLAW_LEADER_URL` | empty (`config.ts:7`) | **required when `OPENCLAW_LEADER=0`** (hard-fail at config-load: `config.ts:9-13`) | follower-only | Leader's daemon base URL. Examples: `http://leader.lan:7878`, `https://leader.tailnet.ts.net`. Ignored on the leader. |

### Control plane tier — Storage (leader-only)

| Variable | Default | Required when | Tier | What it does |
|---|---|---|---|---|
| `OPENCLAW_SPECS_DB_PATH` | `/data/specs.db` (`config.ts:46`) | leader-only | leader-only | Absolute path to the SQLite database file inside the container. The directory must be writable by uid 1000. The compose file mounts the named docker volume `specs-db` at `/data` so the DB persists across container recreates. Followers do not open this file; the value is harmless on followers. |
| `OPENCLAW_DISPATCH_FAILURE_THRESHOLD` | `3` (`config.ts:15-18` and `db/dispatches.ts:288-293`) | both tiers (consumed only on the leader) | both (effective leader-only) | Integer. K consecutive failures (per `(project_slug, task_id, phase)`) before a dispatch is poisoned. The K-recent-window query lives in `db/dispatches.ts`. Values < 1 fall back to 3. |

### Control plane tier — Local memory (NEVER synced, NEVER over HTTP)

| Variable | Default | Required when | Tier | What it does |
|---|---|---|---|---|
| `OPENCLAW_LOCAL_MEMORY` | `${HOME}/.claude/local-memory` (`config.ts:58-59`) | always optional | both | Container-side root for `PRIVATE_AGENT_FILES` (persona.md, secrets.md, persona.json, secrets.json). Bind-mounted from `OPENCLAW_LOCAL_MEMORY_DIR` on the host. Never written to the leader's DB; never sent over HTTP. |
| `OPENCLAW_LOCAL_AGENTS_ROOT` | `${OPENCLAW_LOCAL_MEMORY}/agents` (`config.ts:60-62`) | always optional | both | Override of where per-agent local files live. Defaults under `OPENCLAW_LOCAL_MEMORY`. |
| `OPENCLAW_LOCAL_MEMORY_DIR` | `${HOME}/.claude/local-memory` | always optional | both | Host path that compose bind-mounts to `OPENCLAW_LOCAL_MEMORY`. Edited in `.env`, not read by the daemon directly. |

### Control plane — Discord OAuth (dashboard auth, leader-facing)

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_CLIENT_ID` | (empty) | OAuth app client id. Empty → daemon falls back to a `local-dev` user (loopback only). |
| `DISCORD_CLIENT_SECRET` | (empty) | OAuth app client secret. |
| `DISCORD_REDIRECT_URI` | `http://localhost:7878/auth/discord/callback` | Must match the Developer Portal's "Redirects" entry **exactly**. |
| `DISCORD_ALLOWED_USER_IDS` | (empty) | CSV of Discord user IDs allowed to log in. Set this. |
| `DISCORD_ALLOWED_GUILD_ID` | (empty) | Optional alternative: any member of this guild can log in. Used only when `DISCORD_ALLOWED_USER_IDS` is empty. |

If both `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_GUILD_ID` are empty, the daemon refuses remote logins entirely.

### Control plane — Per-agent bot tokens

One env var per agent dir under `local-memory/agents/<id>/`. Default name is `DISCORD_TOKEN_<UPPER_ID>`. Override the env var name via the leader's shared memory at `agents/<id>/discord.json#tokenEnvVar` (served by `GET /api/memories/agents/<id>/discord.json`).

```
DISCORD_TOKEN_ANUBIS=...
DISCORD_TOKEN_AMUN=...
DISCORD_TOKEN_CHAPPIE=...
```

The bot-bridge skips any agent whose token env var is unset or whose `local-memory/agents/<id>/persona.md` is missing. (Agents on *other* machines don't need a token here.)

### Optional — Redis (cross-agent presence + handoff bus)

| Variable | Default | What it does |
|---|---|---|
| `REDIS_URL` | `redis://openclaw-redis:6379` (set by docker-compose) | Enables cross-agent online/busy presence pub/sub. Falls back to in-process events when unset. |

### Optional — Docker Hub

| Variable | Default | What it does |
|---|---|---|
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | (empty) | Used by `./scripts/dc.sh` to bypass a misbehaving credsStore. Public-Repo-Read-only PAT is enough. |

---

## `docker-compose.yml`

Don't edit unless you know why. The values to know:

- **`ports: 127.0.0.1:18789:18789`** — dashboard is loopback-only. Change to `:18789:18789` (no leading `127.0.0.1`) to expose to LAN, but **only if** you've also set `OPENCLAW_AUTH_TOKEN` to a strong value and trust your network.
- **`extra_hosts: ["host.docker.internal:host-gateway"]`** — required on Linux for the container to reach host Ollama. Already there.
- **`restart: unless-stopped`** — container auto-restarts unless you `docker compose down`. Change to `"no"` while debugging crashloops.
- **`healthcheck`** — checks the dashboard responds. The 120s `start_period` accounts for slow first-run plugin install.

---

## `config/openclaw.json.tmpl`

The canonical OpenClaw config, rendered through `envsubst` at container start. Everything in `${...}` is substituted from environment variables.

### Top-level structure

```json
{
  "agents": { ... },         // default model + timeouts
  "models": { ... },         // provider configurations
  "channels": { ... },       // discord, telegram, slack, etc.
  "gateway": { ... },        // auth, bind address, controlUi
  "plugins": { ... },        // per-plugin enable/disable
  "commands": { ... },       // command-execution policies
  "update": { ... },         // self-update behavior
  "meta": { ... }            // version stamps (REQUIRED — see below)
}
```

### `agents.defaults`

```json
"agents": {
  "defaults": {
    "model": { "primary": "${LLM_PROVIDER}/${LLM_MODEL}" },
    "timeoutSeconds": 600
  }
}
```

- `model.primary`: rendered as `<LLM_PROVIDER>/<LLM_MODEL>`. The provider name must match the single key produced in `models.providers` (the entrypoint guarantees this).
- `timeoutSeconds`: hard cap on a single agent run. Default 600 (10 min). Increase for long tool chains.

### `models.providers` — assembled at runtime

The template contains `"providers": ${LLM_PROVIDERS_JSON}` — `entrypoint.sh` builds that JSON object from `LLM_PROVIDER` and the matching `*_API_KEY` (or `OLLAMA_BASE_URL` / `CUSTOM_BASE_URL`).

Built-in providers handled by `entrypoint.sh`:

| `LLM_PROVIDER` | Endpoint | Auth env | Notes |
|---|---|---|---|
| `ollama` | `${OLLAMA_BASE_URL}` | none (apiKey=`not-needed`) | Local or `*:cloud` models. |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | OpenAI-compat (`api: openai-completions`). |
| `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Native Messages API (`api: anthropic-messages`). |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Any OpenRouter model id. |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | OpenAI-compat. |
| `custom` | `${CUSTOM_BASE_URL}` | `CUSTOM_API_KEY` (optional) | Any OpenAI-compat endpoint. |

To add a brand-new provider (not in the list above), edit the `provider_block()` function in `entrypoint.sh` — add a new `case` arm that emits its `{baseUrl, apiKey, api, models}` block via `jq -n`, and add the key to `.env.example`.

If you want **multiple providers configured simultaneously** (e.g. Ollama as default + Anthropic as fallback), edit `provider_block()` to merge several blocks instead of returning one — `jq` makes this trivial: `jq -n '$a + $b' --argjson a '{...}' --argjson b '{...}'`. OpenClaw's primary/fallback selection happens in `agents.defaults.model`.

### `channels.discord`

```json
"channels": {
  "discord": {
    "enabled": true,
    "accounts": {
      "default": {
        "token": "${DISCORD_BOT_TOKEN}",
        "enabled": true,
        "healthMonitor": { "enabled": false }
      }
    },
    "groupPolicy": "allowlist",
    "guilds": {
      "${DISCORD_GUILD_ID}": { "requireMention": true }
    }
  }
}
```

| Key | Effect |
|---|---|
| `enabled: false` | Disables Discord without removing config. |
| `accounts.<name>.healthMonitor.enabled` | Periodic Discord API self-check. Off because it's chatty. |
| `groupPolicy` | `allowlist` (only listed guilds), `open` (any guild), `disabled` (no group messages at all). |
| `guilds.<id>.requireMention` | If true (recommended), bot only responds when @mentioned. |

To allow DMs:
```json
"dmPolicy": "open",     // or "pairing" (require /pair first)
"allowFrom": ["*"]      // or specific user IDs
```

### `gateway`

```json
"gateway": {
  "mode": "local",
  "bind": "lan",
  "auth": {
    "mode": "token",
    "token": "${OPENCLAW_AUTH_TOKEN}"
  },
  "controlUi": {
    "allowInsecureAuth": true,
    "allowedOrigins": ["http://127.0.0.1:18789", "http://localhost:18789"]
  },
  "trustedProxies": ["127.0.0.1", "::1"]
}
```

| Key | Effect |
|---|---|
| `mode: "local"` | Auth tier — assumes single trusted user. Don't change. |
| `bind: "lan"` | Binds to all interfaces inside the container. Required for the port-forward to work. Other options: `loopback`, `tailnet`, `auto`, `custom`. |
| `auth.mode: "token"` | Bearer token required for dashboard. Other: `none`, `password`, `trusted-proxy`. |
| `auth.token` | The actual token (matched against `?token=...` query param or `Authorization: Bearer ...` header). |
| `controlUi.allowInsecureAuth: true` | Allows token-via-query-param (needed for `?token=...` URLs). Without it, only header auth works. |

### `plugins.entries`

```json
"plugins": {
  "entries": {
    "bonjour": { "enabled": false }
  }
}
```

Disable specific bundled plugins by name. Currently we disable `bonjour` because mDNS multicast doesn't work in Docker bridge networks (it crashes openclaw with `CIAO PROBING CANCELLED`).

To disable more plugins (e.g. `browser` if you don't need playwright):

```json
"entries": {
  "bonjour": { "enabled": false },
  "browser": { "enabled": false }
}
```

This will also slim down startup time and image size on rebuild.

### `commands.useAccessGroups`

```json
"commands": {
  "useAccessGroups": false
}
```

**Critical for Discord guild responses.** When true (default), only paired users can interact via slash commands and (transitively) mentions. Setting to false lets anyone in the allowed guild mention the bot. Schema requires this at the **top level**, not under `channels.discord`.

### `meta`

```json
"meta": {
  "lastTouchedVersion": "${OPENCLAW_VERSION}",
  "lastTouchedAt": "${OPENCLAW_NOW}"
}
```

**Required.** Without it, openclaw's integrity check declares the file "missing-meta-vs-last-good" and auto-restores from `.bak`, discarding our changes. The entrypoint populates these from `openclaw --version` and the current UTC timestamp.

---

## `entrypoint.sh`

Container init. Don't edit unless you know what you're doing. Key behaviors:

1. Validates `OPENCLAW_AUTH_TOKEN` is set (fatal if empty).
2. Resolves `OPENCLAW_VERSION` from `openclaw --version` and `OPENCLAW_NOW` from `date -u`.
3. Renders `openclaw.json.tmpl` → `~/.openclaw/openclaw.json` via envsubst.
4. If `DISCORD_BOT_TOKEN` or `DISCORD_GUILD_ID` is empty, disables the discord channel via jq.
5. Logs the rendered config (with tokens redacted) for debug visibility.
6. Probes Ollama at `${OLLAMA_BASE_URL}/models` — warns but does not fail if unreachable.
7. Execs `openclaw gateway --port 18789 --bind lan --verbose`.

To add new env vars to envsubst, update the allow-list:

```bash
envsubst '${LLM_PROVIDER} ${LLM_MODEL} ${LLM_PROVIDERS_JSON} ${DISCORD_GUILD_ID} ${DISCORD_BOT_TOKEN} ${OPENCLAW_AUTH_TOKEN} ${OPENCLAW_VERSION} ${OPENCLAW_NOW} ${YOUR_NEW_VAR}' \
    < "$TEMPLATE" > "$CONFIG_FILE"
```

Otherwise envsubst will leave the `${YOUR_NEW_VAR}` literal in the output.

---

## Per-project `.openclaw/`

Created by `bin/openclaw-init-project.sh <name>`. Files inside override or supplement global config when the agent's working directory is that project.

```
<project>/.openclaw/
├── persona.md       # prepended to global SOUL.md when working here
├── HEARTBEAT.md     # project-specific recurring tasks (read every heartbeat tick)
├── skills/          # project-only skills (markdown, same format as global)
├── agents/          # project-only sub-agents
└── README.md        # explains the folder (commit this with the project)
```

Project-specific skills override globals when names collide. Commit `.openclaw/` with your project so the team (human and agent) shares the same instructions.

See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for authoring guidance.

---

## Testing config changes safely

Before committing a change to `openclaw.json.tmpl`:

```bash
# Render the template manually with current env (re-runs the entrypoint up to the render step).
docker compose exec openclaw bash -c '
    /usr/local/bin/entrypoint.sh 2>&1 | head -40
    cat ~/.openclaw/openclaw.json | jq .
'
```

If it parses as valid JSON and looks right, restart:

```bash
docker compose up -d --build
docker compose logs -f openclaw
```

If openclaw rejects the new config you'll see one of:

- `Config invalid ... must NOT have additional properties` — wrong key name or wrong nesting level
- `Config auto-restored from backup ... missing-meta` — `meta` block missing or malformed
- `auth token was missing` — token didn't make it to the rendered config

Refer to [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for fixes.
