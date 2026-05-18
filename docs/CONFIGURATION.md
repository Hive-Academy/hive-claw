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

### Gateway tier — Discord (per-persona accounts)

The gateway's openclaw config (`config/openclaw.json.tmpl`) declares **three active personas** — `anubis` (default), `horus`, and `chappie` — each with its own Discord bot account under `channels.discord.accounts.<id>`. Each persona connects to Discord with its own bot token; @-mentions are routed per-bot by `bindings[]` matching on `(channel: "discord", accountId: "<id>")`.

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN_ANUBIS` | (empty → that bot disabled) | Bot token for the Anubis persona; substituted into `channels.discord.accounts.anubis.token`. Typically set on the leader machine. |
| `DISCORD_TOKEN_HORUS` | (empty → that bot disabled) | Bot token for the Horus persona; substituted into `channels.discord.accounts.horus.token`. Set on the follower machine that hosts Horus. |
| `DISCORD_TOKEN_CHAPPIE` | (empty → that bot disabled) | Bot token for the Chappie persona; substituted into `channels.discord.accounts.chappie.token`. Set on the machine hosting Chappie; also requires `ZERNIO_API_KEY`. |
| `GITHUB_TOKEN` | (empty) | Substituted into `mcp.servers.gh.env.GITHUB_PERSONAL_ACCESS_TOKEN`. Also used as the `gh auth` fallback when no `gh auth login` state is bind-mounted from the host. Used by `setupWorktree()` for auto-clone via `GIT_CONFIG_COUNT` env (token never stored in `.git/config`). |
| `DISCORD_GUILD_ID` | (empty → channel disabled) | Server ID. If empty, the entrypoint disables the gateway's discord channel entirely. |
| `DISCORD_BOT_TOKEN` | (empty — **deprecated**) | Legacy single-bot token used by the pre-Batch-6 template. **Removal lands in TASK_2026_006 Batch 11**; the variable still flows through `entrypoint.sh`'s `envsubst` for transitional compatibility during the cutover window. New deployments should leave it empty and set the per-persona tokens above. |

If both `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN` are empty, the entrypoint disables the gateway's discord channel automatically (legacy jq path — kept until Batch 11 reworks it for per-persona).

Single-machine deployments where only one persona is bound locally (per `OPENCLAW_LOCAL_AGENT_IDS`) can leave the other personas' tokens empty; openclaw will fail to sign those bots in and log it, but the rendered config still validates and the bound persona works normally.

### Gateway tier — Web tools and search

| Variable | Default | What it does |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | `tavily` | Search provider for the gateway's `web_search` tool. Supported values: `tavily`, `brave`, `perplexity`, `exa`, `duckduckgo`, `searxng`. Leave empty to disable web search entirely. |
| `WEB_SEARCH_API_KEY` | (empty → web search disabled) | API key for the chosen provider. If either this or `WEB_SEARCH_PROVIDER` is empty, `entrypoint.sh` disables the `tools.web.search` block in the rendered config via a `jq` step. |

`web_fetch` (URL fetching, readability mode, 50 KB cap) and the `browser` tool (headless Chromium at `/usr/bin/chromium`, no-sandbox mode) are always enabled regardless of the search key. The Dockerfile installs the `chromium` package.

### Gateway tier — Video generation

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | (auto-detected from container env) | Google Gemini API key used by openclaw's Veo video generation. Set it in `.env`; openclaw picks it up automatically from the container environment. No explicit openclaw config field is needed. |

The template sets `agents.defaults.videoGenerationModel: "google/veo-3.1-fast-generate-preview"` and `mediaGenerationAutoProviderFallback: true`. All three agents (anubis, horus, chappie) get the `generate_video` tool when `GEMINI_API_KEY` is present. Available models: `veo-3.1-fast-generate-preview` (default), `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview`, `veo-3.0-generate-001`, `veo-2.0-generate-001`. To override the model per-agent, edit `agents.defaults.videoGenerationModel` in `openclaw.json.tmpl`.

### Gateway tier — Canva MCP

The Canva MCP server (`mcp.servers.canva` in `openclaw.json.tmpl`) is configured as `npx mcp-remote@latest https://mcp.canva.com/mcp` and requires **no env var**. Authentication is handled by a one-time browser OAuth flow via `mcp-remote` on the host:

```bash
npx -y mcp-remote@latest https://mcp.canva.com/mcp
# Complete the Canva OAuth flow in the browser, then Ctrl+C.
```

Tokens are cached in `~/.mcp-auth/` on the host. `docker-compose.yml` bind-mounts that directory into the gateway container at `/home/agent/.mcp-auth:rw`. The `mcp-remote` process inside the container reads and refreshes the tokens automatically. If you run multiple machines, each machine's host needs its own one-time OAuth step.

### Gateway tier — Zernio MCP (Chappie)

| Variable | Default | What it does |
|---|---|---|
| `ZERNIO_API_KEY` | (empty → Zernio MCP disabled) | API key for the Zernio social media MCP server (`mcp.servers.zernio`). Required on the machine hosting Chappie. Get a key at https://zernio.com/agents. |

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
| `OPENCLAW_BOT_TOOL_CALLS_ENABLED` | `0` | always optional | bot-bridge | Master flag for the chat-tier tool-calling loop. `0` = legacy `<<oc:...>>` directive flow only. `1` = `chat.ts` calls `chatCompleteWithTools()` against the configured model with the per-persona tool registry (daemon-CRUD + MCP + native subagents). Roll out per-machine; flip to `0` to fall back without redeploy. |
| `OPENCLAW_TOOL_CALL_DEPTH_LIMIT` | `8` | always optional | bot-bridge | Max round-trips through the tool-calling loop before the bot-bridge truncates with `truncated:true` and posts a partial reply. Increase only if a persona legitimately needs longer chains. |
| `OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS` | `1800000` (30 min) | always optional | bot-bridge | Idle-timeout for harness-authoring mode. If `Date.now() - ctx.state.harnessSetup.startedAt` exceeds this, the next message clears the state and posts a friendly cancel reply. Bump up for longer interactive sessions. |
| `OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB` | `25` | always optional | bot-bridge | Per-attachment size cap for the `upload_attachment` chat tool (TASK_2026_003). Discord's free / Nitro-Basic per-message limit is 25 MB; bump only if your Discord server is configured for higher. The cap applies uniformly to all three source modes (`url`, `path`, `data`). Negative or non-numeric values fall back to the 25 MB default. |
| `OPENCLAW_HOST_HOME` | `${HOME}` | always optional | leader-only (daemon) | Host-side `$HOME` for path translation. The daemon writes materialized ptah configs to `${OPENCLAW_HOST_HOME}/.ptah/agents/<id>/settings.json` and `${OPENCLAW_HOST_HOME}/.ptah/plugins/openclaw-<id>-harness/`. Must be identity-bind-mounted (host path = container path) so the host-side ptah-bridge sees the same bytes the daemon wrote. See [ARCHITECTURE.md](ARCHITECTURE.md) for the bind-mount and [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md) for the materialization output paths. |
| `PTAH_MIN_VERSION` | `0.1.5` | always optional | leader-only (daemon) | Minimum supported ptah CLI version. Probed at daemon boot; below this, `ptahLauncher.ts` takes the 0.1.3 branch (per-agent settings.json + per-persona Claude plugin). Above the version that lands `--config-dir` / `--subagent` / workspace `.claude/agents/` upstream, the launcher swaps branches — bumping this var is the migration. |
| `OPENCLAW_REQUIRE_COMMUNITY_TIER` | `0` | always optional | both | Hard-asserts the operator runs only ptah's community-tier RPCs. When `1`: (a) the daemon's outbound HTTP wrapper throws on any JSON body whose `method` matches `^wizard:` or `^harness:analyze-intent$`; (b) on boot, the daemon probes `ptah --json license status` via the bridge and refuses to start unless tier is `community`. Default off. Flip to `1` on a host where you want belt-and-braces enforcement that no Pro RPC ever fires. |

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

Three active agents in the fleet:

```
DISCORD_TOKEN_ANUBIS=...    # leader machine (orchestrator)
DISCORD_TOKEN_HORUS=...     # follower machine (general-purpose)
DISCORD_TOKEN_CHAPPIE=...   # follower machine (social/content; also needs ZERNIO_API_KEY)
```

The bot-bridge skips any agent whose token env var is unset or whose `local-memory/agents/<id>/persona.md` is missing. (Agents on *other* machines don't need a token here.) Set only the token(s) for the agent(s) owned by this machine via `OPENCLAW_LOCAL_AGENT_IDS`.

### Per-agent harness — `shared-specs/memory/agents/<id>/harness.yaml`

One file per registered agent declares the chat-tier and orchestration-tier surfaces (skills, openclaw-native subagents, MCP servers, `enabledPluginIds`, `modelTier`). Schema enforced by `parseHarnessYaml` in `openclaw-control/daemon/src/harness/types.ts` (mirrored byte-identically at `bot-bridge/src/harness/types.ts`).

The file lives in the leader's `memory_files` table at `(scope='agents', owner_id=<id>, filename='harness.yaml')` — public config, NOT memory. Reachable via `GET /api/memories/agents/<id>/harness.yaml`. The materialized on-disk output (`~/.ptah/agents/<id>/settings.json` + `~/.ptah/plugins/openclaw-<id>-harness/`) is regenerated from this file on every `harness/sync` event and on daemon boot.

See [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md#harness-yaml--file-format) for the full schema and the materialization output paths. The pilot harness lives at `shared-specs/memory/agents/horus/harness.yaml`.

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
  "agents": { ... },         // default model + timeouts + videoGenerationModel
  "models": { ... },         // provider configurations
  "channels": { ... },       // discord, telegram, slack, etc.
  "bindings": [ ... ],       // per-persona discord account routing
  "mcp": { ... },            // MCP server definitions (gh, zernio, canva)
  "gateway": { ... },        // auth, bind address, controlUi
  "tools": { ... },          // web search + web fetch configuration
  "browser": { ... },        // headless Chromium configuration
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
    "timeoutSeconds": 600,
    "videoGenerationModel": "google/veo-3.1-fast-generate-preview",
    "mediaGenerationAutoProviderFallback": true
  }
}
```

- `model.primary`: rendered as `<LLM_PROVIDER>/<LLM_MODEL>`. The provider name must match the single key produced in `models.providers` (the entrypoint guarantees this).
- `timeoutSeconds`: hard cap on a single agent run. Default 600 (10 min). Increase for long tool chains.
- `videoGenerationModel`: Google Veo model used by the `generate_video` tool. Default `veo-3.1-fast-generate-preview`. Available: `veo-3.1-fast-generate-preview`, `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview`, `veo-3.0-generate-001`, `veo-2.0-generate-001`. `GEMINI_API_KEY` must be in the container environment for Veo to authenticate.
- `mediaGenerationAutoProviderFallback`: when `true`, openclaw tries alternative providers if the primary Veo call fails.

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

### `tools.web` — web search and fetch

```json
"tools": {
  "web": {
    "search": {
      "enabled": true,
      "provider": "${WEB_SEARCH_PROVIDER}",
      "apiKey": "${WEB_SEARCH_API_KEY}",
      "maxResults": 5,
      "timeoutSeconds": 30,
      "cacheTtlMinutes": 15
    },
    "fetch": {
      "enabled": true,
      "readability": true,
      "timeoutSeconds": 30,
      "maxChars": 50000
    }
  }
}
```

`entrypoint.sh` disables `tools.web.search` via a `jq` patch when `WEB_SEARCH_PROVIDER` or `WEB_SEARCH_API_KEY` is empty. `tools.web.fetch` is always on.

### `browser` — headless Chromium

```json
"browser": {
  "enabled": true,
  "headless": true,
  "noSandbox": true,
  "evaluateEnabled": true,
  "executablePath": "/usr/bin/chromium",
  "tabCleanup": {
    "enabled": true,
    "idleMinutes": 60,
    "maxTabsPerSession": 4
  }
}
```

`noSandbox: true` is required in Docker because the container doesn't have the kernel capabilities for Chromium's sandbox. `chromium` is installed in the Dockerfile via `apk add chromium` (or `apt-get install chromium`).

### `mcp.servers` — MCP server definitions

```json
"mcp": {
  "servers": {
    "gh": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "zernio": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://mcp.zernio.com/mcp",
               "--header", "Authorization: Bearer ${ZERNIO_API_KEY}"]
    },
    "canva": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"]
    }
  }
}
```

- **`gh`** — GitHub MCP server. Requires `GITHUB_TOKEN`. Available to all agents.
- **`zernio`** — Zernio social media MCP server. Requires `ZERNIO_API_KEY`. Used by Chappie.
- **`canva`** — Canva design MCP server via `mcp-remote`. No API key; uses OAuth token cache in `/home/agent/.mcp-auth/` (bind-mounted from `~/.mcp-auth/` on the host). Requires the [one-time host OAuth step](SETUP.md#canva-mcp-one-time-oauth-gateway-machine).

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
envsubst '${LLM_PROVIDER} ${LLM_MODEL} ${LLM_PROVIDERS_JSON} ${DISCORD_GUILD_ID} ${DISCORD_BOT_TOKEN} ${DISCORD_TOKEN_ANUBIS} ${DISCORD_TOKEN_HORUS} ${DISCORD_TOKEN_CHAPPIE} ${OPENCLAW_AUTH_TOKEN} ${OPENCLAW_VERSION} ${OPENCLAW_NOW} ${WEB_SEARCH_PROVIDER} ${WEB_SEARCH_API_KEY} ${ZERNIO_API_KEY} ${GITHUB_TOKEN} ${YOUR_NEW_VAR}' \
    < "$TEMPLATE" > "$CONFIG_FILE"
```

Otherwise envsubst will leave the `${YOUR_NEW_VAR}` literal in the output.

`entrypoint.sh` also exports `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY` and runs a `jq` step that disables `tools.web.search` when either is unset or empty — so the rendered config always has a valid (possibly disabled) search block.

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
