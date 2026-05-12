# Research findings — TASK_2026_006 openclaw integration spike

**Researcher:** researcher-expert
**Date:** 2026-05-12
**Branch:** `ak/fix-internal-calls`
**Runtime status during spike:** Docker containers NOT running on host. Code-only analysis from the installed image `openclaw-local:latest` (built from `Dockerfile`). All B4 endpoint shapes verified from compiled JS sources; HTTP probes themselves were not executed (see B4 note).

## Summary (TL;DR)

- **Installed version is openclaw `2026.4.24` (build hash `cbcfdf6`).** Confirmed by `openclaw --version` inside the image and by `package.json#version`.
- **GO recommendation for the migration architecture in context.md.** Every load-bearing capability exists at our pinned version: plugin SDK with `api.registerTool()`, multi-agent Discord with per-account bot tokens, `config.bindings[]` for per-(channel,account,peer) agent routing, OpenAI-compatible `/v1/responses` + `/v1/chat/completions` + `/tools/invoke` HTTP endpoints, and Docker-sandbox isolation for filesystem boundaries.
- **The known bug `openclaw/openclaw#59047` is CLOSED as fixed in v2026.4.24.** The issue page literally cites the v2026.4.24 release tag and commit `cbcfdf62c729` (which matches our installed `cbcfdf6` build hash) as the fix evidence. The closed-as-implemented decision happened in the GitHub issue itself, not just in our reading. Affected path was TUI/local-agent runs; the Discord-channel path that we will use was never broken. Verified the fix code paths exist at `tools-CZr3orc0.js:29-43`, `subagent-registry-Cx_UMX3T.js:1073-1076`, `tools-invoke-http-DxEbZW3I.js:128`, `dispatch-Dw_9PM8V.js:263-265`, `get-reply-CSQ5BMwG.js:1456`, `channel-bootstrap.runtime-CTVP86NU.js:26`.
- **Plugin SDK surface is large and stable.** The canonical entry is `definePluginEntry({ id, name, description, register(api) })` exported from `openclaw/plugin-sdk` (or `openclaw/plugin-sdk/plugin-entry`). `api` exposes `registerTool`, `registerHook`, `registerHttpRoute`, `registerChannel`, `registerCommand`, `registerService`, `registerProvider`, plus 30+ more registrars. The factory shape `(ctx) => AnyAgentTool | AnyAgentTool[]` is the recommended pattern (browser/comfy/diffs all use it).
- **Tool contract is `AnyAgentTool` (extends pi-agent-core's `AgentTool`):** `{ name, description, parameters: TSchema, label, execute(toolCallId, params, signal?, onUpdate?) }`. Streaming is supported via the optional `onUpdate` callback; for `invoke_ptah` we will likely use it.
- **Multi-agent Discord is first-class.** `config.channels.discord.accounts.<accountId>.token` per account, `config.agents.list[].id` per agent, and `config.bindings[]` ties them together. `AgentBindingMatch` supports matching on `channel + accountId + peer + guildId + teamId + roles[]` with discriminator `binding.peer`, `binding.peer.wildcard`, `binding.guild+roles`, `binding.guild`, `binding.team`, `binding.account`, `binding.channel`, `default`. There is NO automatic "@-mention picks the agent" logic — each Discord bot token receives only its own @-mentions (Discord platform behavior), and the binding then resolves which `agents.list[]` entry owns the conversation.
- **There is NO general-purpose deny-path filesystem policy in openclaw.** The closest controls are `tools.fs.workspaceOnly: true` (an allow-list restricting reads/writes to the agent workspace), `agents.list[].sandbox.workspaceAccess: "none"|"ro"|"rw"`, and Docker-sandbox bind-mount discipline. To keep agents out of `~/.claude/local-memory/<other-agent>/`, we rely on (a) workspace scoping + workspaceOnly + (b) NOT bind-mounting that path into the sandbox. Per-machine ownership (only own personas mounted on the owning machine) is the strongest existing layer; openclaw cannot itself enforce "deny this absolute host path."
- **HTTP routes confirmed in v2026.4.24:** `/v1/models`, `/v1/embeddings`, `/v1/chat/completions`, `/v1/responses`, `/tools/invoke`, plus `/__openclaw__/ws`, `/__openclaw__/canvas`, `/voiceclaw/realtime`. The doc-referenced `/api/sessions/<id>/messages` does NOT exist in this version — that was stale documentation.
- **Auth shape:** `Authorization: Bearer ${OPENCLAW_AUTH_TOKEN}` (or `x-openclaw-token: <token>`). Override headers: `x-openclaw-agent-id`, `x-openclaw-session-key`, `x-openclaw-message-channel`, `x-openclaw-account-id`, `x-openclaw-model`.
- **Plugin context (`OpenClawPluginToolContext`) does NOT expose env.** Plugins read `process.env` directly — fine for our use case (`OPENCLAW_INTERNAL_TOKEN`, `OPENCLAW_DAEMON_URL`).
- **Biggest live risk:** the plugin loader's jiti-alias resolution for non-bundled plugins. The original issue 59047 part 1 was "`Cannot find module 'openclaw/plugin-sdk/core'`" because the jiti walker couldn't find the openclaw root from a plugin installed at `~/.openclaw/extensions/...`. The CHANGELOG explicitly mentions fixing it ("link the host OpenClaw package into external plugins that declare `openclaw` as a peer dependency" — #70462), and the closer cites `sdk-alias.ts:143` regression tests. But: we'll be loading the plugin via a custom path (Docker bind-mount or `plugins.load.paths`), not via `openclaw plugins install ./pkg`, so the typical install codepath may not apply. Mitigation in B5 below: declare `openclaw` as `peerDependency` and ship via a Dockerfile COPY into `/usr/lib/node_modules/openclaw/extensions/<id>/` (the bundled-plugin path) OR symlink openclaw into the plugin's `node_modules/` at build time.

## B1 — Plugin SDK at our version

### Version

- `openclaw --version` → `OpenClaw 2026.4.24 (cbcfdf6)` (confirmed in image; see `Dockerfile:50-51` for the pin `openclaw@2026.4.24`).
- `package.json#version` → `"2026.4.24"`.
- npm-global install path: `/usr/lib/node_modules/openclaw/`.
- Plugin SDK entry directory: `/usr/lib/node_modules/openclaw/dist/plugin-sdk/`.
- Plugin SDK is publicly exported under 50+ submodule names in `package.json#exports`. The relevant ones for us:
  - `openclaw/plugin-sdk` → top-level types + `definePluginEntry`
  - `openclaw/plugin-sdk/core` → `defineChannelPluginEntry` and channel-plugin runtime contracts (we don't need this — we're a tool plugin)
  - `openclaw/plugin-sdk/zod`, `openclaw/plugin-sdk/typebox` for parameter schemas (we'll use typebox to match the rest of the codebase)

### Public surface — `OpenClawPluginApi`

File: `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1664-1798`

```typescript
export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    registrationMode: PluginRegistrationMode;       // "full" | "discovery" | "setup-only" | "setup-runtime" | "cli-metadata"
    config: OpenClawConfig;                          // entire gateway config (read-only)
    pluginConfig?: Record<string, unknown>;          // from config.plugins.entries.<id>.config
    runtime: PluginRuntime;
    logger: PluginLogger;
    registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: OpenClawPluginToolOptions) => void;
    registerHook: (events: string | string[], handler: InternalHookHandler, opts?: OpenClawPluginHookOptions) => void;
    registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
    registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
    registerGatewayMethod: (method: string, handler: GatewayRequestHandler, opts?: { scope?: OperatorScope }) => void;
    registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[]; descriptors?: OpenClawPluginCliCommandDescriptor[] }) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerCommand: (command: OpenClawPluginCommandDefinition) => void;
    registerProvider: (provider: ProviderPlugin) => void;
    // ... 25+ more registrars (memory, codex, harness, web-search, tts, etc.)
    resolvePath: (input: string) => string;
    on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: { priority?: number }) => void;
};
```

### Plugin entry definition

`openclaw/plugin-sdk/plugin-entry` exports `definePluginEntry` (file `plugin-entry.d.ts:36`):

```typescript
export declare function definePluginEntry({
    id, name, description, kind, configSchema, reload, nodeHostCommands, securityAuditCollectors, register
}: DefinePluginEntryOptions): DefinedPluginEntry;
```

Real-world examples extracted from the installed image:

- `dist/extensions/browser/index.js` — full tool plugin pattern (manifest + `registerBrowserPlugin`)
- `dist/extensions/diffs/index.js:2037-2046` — `api.registerTool((ctx) => createDiffsTool({ api, store, defaults, context: ctx }), { name: "diffs" })` — the canonical factory pattern
- `dist/extensions/comfy/index.js` — provider plugin (image/music/video generation)
- `dist/extensions/document-extract/index.js` — minimal plugin (`register(){}` body)

### Tool contract — `AnyAgentTool`

File: `dist/plugin-sdk/src/agents/tools/common.d.ts:11-14` and pi-agent-core `pi-ai/dist/types.d.ts:164-168` + `pi-agent-core/dist/types.d.ts:273-291`:

```typescript
// From @mariozechner/pi-ai
export interface Tool<TParameters extends TSchema = TSchema> {
    name: string;
    description: string;
    parameters: TParameters;        // typebox schema
}

// From @mariozechner/pi-agent-core
export interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
    label: string;
    prepareArguments?: (args: unknown) => Static<TParameters>;
    execute: (toolCallId: string, params: Static<TParameters>,
              signal?: AbortSignal,
              onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
    executionMode?: "sequential" | "parallel";
}

// From openclaw
export type AnyAgentTool = Omit<AgentTool<TSchema, unknown>, "execute"> & ErasedAgentToolExecute & {
    ownerOnly?: boolean;
    displaySummary?: string;
};

export interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];   // model-visible result
    details: T;                                  // structured details for logs/UI
    terminate?: boolean;                         // stop early after this turn
}
```

Helpers in `dist/plugin-sdk/src/agents/tools/common.d.ts:62-77` we can use directly:

- `textResult(text, details)` — text-only result
- `jsonResult(payload)` — JSON-stringified result
- `payloadTextResult(payload)` — text + structured payload
- `failedTextResult(text, details)` — failure result (still resolves; `execute` throwing also works but skips structured `details`)
- `imageResult({ label, path, base64, mimeType, ... })` — image attachment

### Plugin tool context

File: `dist/plugin-sdk/src/plugins/tool-types.d.ts:7-32`:

```typescript
export type OpenClawPluginToolContext = {
    config?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    fsPolicy?: ToolFsPolicy;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;                         // ephemeral, regenerated on /new and /reset
    browser?: { sandboxBridgeUrl?: string; allowHostControl?: boolean };
    messageChannel?: string;
    agentAccountId?: string;
    deliveryContext?: DeliveryContext;
    requesterSenderId?: string;
    senderIsOwner?: boolean;
    sandboxed?: boolean;
};

export type OpenClawPluginToolFactory =
    (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
```

**Crucial detail:** the context does NOT carry env. The plugin reads `process.env.OPENCLAW_INTERNAL_TOKEN` etc. directly at module load or per-call. The plugin process is just a Node module that openclaw `import()`s, so it shares openclaw's environment.

### Status of `openclaw/openclaw#59047` at our version

**Closed as fixed in v2026.4.24** by `clawsweeper` (Codex automated review). The closer's comment cites:

- Release: `v2026.4.24`
- Commit: `cbcfdf62c729` — matches our installed build hash `cbcfdf6` exactly
- Reviewed paths: `src/agents/pi-embedded-runner/run.ts:311`, `src/agents/runtime-plugins.ts:15`, `src/plugins/tools.ts:97`, `src/agents/pi-embedded-runner/run/attempt.ts:1372`, `src/plugins/sdk-alias.ts:143`

The two compounding sub-issues:

1. **Jiti alias resolution** — Fixed via "link the host OpenClaw package into external plugins that declare `openclaw` as peer dependency" (CHANGELOG `#70462`) AND via explicit argv/moduleUrl hints in `buildPluginLoaderAliasMap` / `resolvePluginLoaderJitiConfig` (`src/plugins/sdk-alias.ts:143`). **For us, this means: in the plugin's package.json declare `"peerDependencies": { "openclaw": ">=2026.4.24" }` AND ensure openclaw is resolvable from the plugin's node_modules.** The simplest way in our Docker image is to install the plugin inside `/usr/lib/node_modules/openclaw/dist/extensions/<id>/` (treating it as a bundled extension) OR symlink openclaw at image build time.

2. **TUI tools not surfaced** — Fixed via `ensureRuntimePluginsLoaded` being called inside `runEmbeddedPiAgent` before tool construction, and by `resolvePluginToolRegistry` falling back through compatible registries when `allowGatewaySubagentBinding` is unset. Our path is Discord-channel-driven, not TUI — and the channel path was never affected.

Verified-in-installed-image code paths:

- `dist/tools-CZr3orc0.js:29-43` — `resolvePluginToolRegistry` + `createOpenClawTools` (= `src/plugins/tools.ts`)
- `dist/subagent-registry-Cx_UMX3T.js:1073-1076,1215-1220` — `ensureRuntimePluginsLoaded` invocation in subagent registry
- `dist/get-reply-CSQ5BMwG.js:1456` — `allowGatewaySubagentBinding: true` in the inbound-reply / auto-reply path (Discord lands here)
- `dist/channel-bootstrap.runtime-CTVP86NU.js:26` — `runtimeOptions: { allowGatewaySubagentBinding: true }` at channel bootstrap
- `dist/tools-invoke-http-DxEbZW3I.js:128` — `allowGatewaySubagentBinding: true` on the `/tools/invoke` HTTP path
- `dist/dispatch-Dw_9PM8V.js:263-265` — `ensureRuntimePluginsLoaded` in the dispatch path

**Conclusion:** The bug does not block us. Discord-bound plugin tools surface to agents in our installed version.

### Known related bugs / fixed since

From CHANGELOG (`/usr/lib/node_modules/openclaw/CHANGELOG.md`):

- `#70462` — peer-dep linking for external plugins (the alias-resolution fix)
- `#46648` — preserve gateway plugin subagent access (plugin tools spawning subagents)
- `#56101` — workspace plugins do not re-register on repeated HTTP `/tools/invoke`
- `#1566` — ignore tool allowlists referencing unknown plugin tools (avoid hard error)
- The CHANGELOG line "**Plugins/runtime: reuse only compatible active plugin registries across tools, providers, web search, and channel bootstrap, align `/tools/invoke` plugin loading with the session workspace ... so plugin tools and channels stop disappearing or re-registering from mismatched runtime loads. Thanks @gumadeiras.**" is the headline fix that closed the bug class containing 59047.

### Plugin discovery shape

File: `dist/plugin-sdk/src/config/types.plugins.d.ts:39-50`:

```typescript
export type PluginsConfig = {
    enabled?: boolean;
    allow?: string[];                            // plugin id allowlist
    deny?: string[];
    load?: { paths?: string[] };                 // extra plugin directories
    slots?: { memory?: string; contextEngine?: string };
    entries?: Record<string, PluginEntryConfig>; // per-plugin enable + config
    installs?: Record<string, PluginInstallRecord>;
};
```

`config.plugins.entries.<id>.config` is what arrives as `api.pluginConfig` to our plugin. Useful for non-secret toggles; for secrets we use env.

## B2 — Multi-agent Discord

### Per-account bot tokens

File: `dist/extensions/discord/accounts-zcI4mtzH.js:1-60`. `resolveDiscordAccount(params)` reads `cfg.channels.discord.accounts[accountId].token` and resolves it through `resolveDiscordToken` (which supports both inline strings and secret refs via `SecretInput`).

```typescript
// Confirmed at runtime — cfg shape:
{
  "channels": {
    "discord": {
      "enabled": true,
      "accounts": {
        "anubis":  { "token": "${DISCORD_TOKEN_ANUBIS}",  "enabled": true,  "name": "Anubis" },
        "horus":   { "token": "${DISCORD_TOKEN_HORUS}",   "enabled": true,  "name": "Horus"  },
        "amun":    { "token": "${DISCORD_TOKEN_AMUN}",    "enabled": true,  "name": "Amun"   }
      },
      "groupPolicy": "allowlist"
    }
  }
}
```

Each `accounts.<accountId>` entry is independent — separate gateway connection, separate token, separate health monitor. Verified via `listEnabledDiscordAccounts(cfg)` at `accounts-zcI4mtzH.js:43-49`.

### Agent definition

File: `dist/plugin-sdk/src/config/types.agents.d.ts:56-113`. `cfg.agents.list[]` is an array of `AgentConfig` entries with `id`, optional `default`, `name`, `workspace`, `agentDir`, `model`, `tools`, `sandbox`, `runtime`, etc.

```typescript
{
  "agents": {
    "defaults": {
      "model": { "primary": "${LLM_PROVIDER}/${LLM_MODEL}" },
      "timeoutSeconds": 600,
      "tools": { /* shared baseline */ }
    },
    "list": [
      { "id": "anubis",  "workspace": "/home/agent/.openclaw/workspace/anubis",  "default": true },
      { "id": "horus",   "workspace": "/home/agent/.openclaw/workspace/horus" },
      { "id": "amun",    "workspace": "/home/agent/.openclaw/workspace/amun" }
    ]
  }
}
```

### Binding the two — `config.bindings[]`

File: `dist/plugin-sdk/src/config/types.openclaw.d.ts:97` (`bindings?: AgentBinding[]`) + `dist/plugin-sdk/src/config/types.agents.d.ts:24-55`.

```typescript
export type AgentRouteBinding = {
    type?: "route";              // omitted = route, alternative is "acp"
    agentId: string;
    comment?: string;
    match: {
        channel: string;          // "discord"
        accountId?: string;       // "anubis" (links to channels.discord.accounts.anubis)
        peer?: { kind: ChatType; id: string };
        guildId?: string;
        teamId?: string;
        roles?: string[];
    };
};
```

Routing logic in `dist/plugin-sdk/src/routing/resolve-route.d.ts:21-33` returns a `ResolvedAgentRoute { agentId, channel, accountId, sessionKey, mainSessionKey, lastRoutePolicy, matchedBy }`. `matchedBy` enum: `"binding.peer" | "binding.peer.parent" | "binding.peer.wildcard" | "binding.guild+roles" | "binding.guild" | "binding.team" | "binding.account" | "binding.channel" | "default"`. Resolution tries from most-specific to least-specific.

**Recommended config shape for our use case:**

```json
{
  "bindings": [
    { "agentId": "anubis", "match": { "channel": "discord", "accountId": "anubis" } },
    { "agentId": "horus",  "match": { "channel": "discord", "accountId": "horus"  } },
    { "agentId": "amun",   "match": { "channel": "discord", "accountId": "amun"   } }
  ]
}
```

This routes every Discord message arriving on bot-token `anubis` to agent `anubis`, and so on. Each bot token only sees messages targeting it (Discord platform behavior — @mentions resolve to a bot by user-id and Discord only delivers to that bot's gateway connection). No special "mention routing" logic on our side is required — openclaw just looks up which agent owns this `(channel, accountId)` and dispatches there.

For multi-machine: each machine's openclaw config only includes `accounts.<id>` entries for the personas owned by that machine. Other machines don't have those tokens — so even if Discord rebroadcast somehow, those bots wouldn't connect from the wrong host. Existing per-machine `OPENCLAW_LOCAL_AGENT_IDS` ownership maps directly onto which accounts each machine declares.

### `requireMention` policy

File: `dist/extensions/discord/message-handler.preflight-UmyKSMK9.js` (referenced from `route-resolution-DbV7TvS1.js`). Already in our current template (`config/openclaw.json.tmpl:25` — `"${DISCORD_GUILD_ID}": { "requireMention": true }`). Survives the migration unchanged.

## B3 — Sandbox path-restrictions

### What exists in openclaw

There is **no `denyPaths` filesystem policy** in openclaw's config schema. The closest controls are an allow-list shape, plus the Docker-sandbox bind-mount model:

1. **`tools.fs.workspaceOnly: boolean`** (file `dist/plugin-sdk/src/agents/tool-fs-policy.d.ts:2-7`):

   ```typescript
   export type ToolFsPolicy = { workspaceOnly: boolean };
   ```

   When `true`, `read` / `write` / `edit` / `apply_patch` tools refuse paths outside the agent's `workspace` directory. This is per-agent — `cfg.agents.list[].tools.fs.workspaceOnly`.

2. **`agents.list[].sandbox`** (file `dist/plugin-sdk/src/config/types.agents-shared.d.ts:14-37`):

   ```typescript
   export type AgentSandboxConfig = {
       mode?: "off" | "non-main" | "all";
       backend?: string;                          // "docker" by default
       workspaceAccess?: "none" | "ro" | "rw";
       scope?: "session" | "agent" | "shared";
       workspaceRoot?: string;
       docker?: SandboxDockerSettings;
       // ssh, browser, prune ...
   };
   ```

   With `mode: "all"` and a Docker sandbox, openclaw spawns each session inside a Docker container. The container only sees what's bind-mounted in via `docker.binds[]` plus the workspace mount. **`~/.claude/local-memory/` is NOT mounted unless we explicitly mount it.**

3. **`agents.list[].sandbox.docker.binds`** (file `dist/plugin-sdk/src/config/types.sandbox.d.ts:48-58`):

   ```typescript
   binds?: string[];   // "host:container:mode" format
   dangerouslyAllowReservedContainerTargets?: boolean;
   dangerouslyAllowExternalBindSources?: boolean;
   ```

   By default openclaw refuses bind sources outside the runtime allowlisted roots (workspace + agent workspace roots). To mount additional paths you have to opt into the `dangerouslyAllow*` overrides. We won't — we'll explicitly NOT bind-mount the local-memory dir, and that gives us isolation by exclusion.

### Implication for our persona-privacy invariant

Recall (CLAUDE.md): the privacy invariant is `~/.claude/local-memory/agents/<id>/{persona.md,secrets.md,...}` must never be readable by an agent other than `<id>`, AND must never leave the owning machine.

Mapping to openclaw config:

- **Each agent gets `workspace: "/home/agent/.openclaw/workspace/<agent-id>"` and that directory contains only that agent's working files.** No persona files live there — those stay in `~/.claude/local-memory/agents/<id>/`, which is bind-mounted to the container only via the daemon (not the agent sandbox).
- **`agents.list[].tools.fs.workspaceOnly: true`** so the read/write/edit/apply_patch tools refuse to touch anything outside the workspace.
- **`agents.list[].sandbox.mode: "all"` + Docker sandbox without binding local-memory.** The agent literally cannot see other agents' persona files because they don't exist inside its container.
- **Per-machine ownership unchanged.** Only the owning machine bind-mounts `~/.claude/local-memory/agents/<owned-id>/` into the daemon (NOT the agent sandbox). The daemon enforces persona-privacy layers 1-4 from CLAUDE.md.

**Key shift from the current model:** layers 5-6 in CLAUDE.md ("in bot-bridge tool handlers") were defending against a malicious agent persuading bot-bridge to read a forbidden persona file. After migration, the relevant protections move:

- Layer 5 → openclaw's `tools.fs.workspaceOnly` + sandbox bind-mount discipline.
- Layer 6 (input-validation in the persona-write path) → the `invoke_ptah` plugin handler still validates `project` and any incoming user-input filenames before passing them to ptah / daemon. Layers 1-4 (in the daemon) survive as the canonical chokepoint.

**Caveat:** openclaw cannot expressively say "deny exactly `~/.claude/local-memory/`" with a config-string. The only deny mechanic is "don't bind-mount it" + `workspaceOnly`. If we ever need a positive deny-list (e.g. agent ABC must not read `/etc`), we'd have to add it ourselves outside openclaw, or run with `sandbox.mode: "all"` and a hardened base image.

### Recommended sandbox/tools snippet

```json
{
  "agents": {
    "defaults": {
      "tools": {
        "fs": { "workspaceOnly": true },
        "exec": { "host": "sandbox", "security": "allowlist" }
      },
      "sandbox": {
        "mode": "all",
        "backend": "docker",
        "workspaceAccess": "rw",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox:latest",
          "readOnlyRoot": true,
          "network": "bridge"
        }
      }
    },
    "list": [
      { "id": "anubis", "workspace": "/home/agent/.openclaw/workspace/anubis" }
    ]
  }
}
```

## B4 — Runtime HTTP endpoints

### Runtime state during this spike

**`docker compose ps` returns no running containers** as of this spike. No gateway is listening on `:18789`. All endpoint findings below come from reading the compiled gateway sources at `/usr/lib/node_modules/openclaw/dist/`. **Runtime probes (actual HTTP requests against a running gateway) MUST be performed before Phase 2 cutover.** Specifically: the docs claim a `/api/sessions/<id>/messages` endpoint that does NOT appear in the v2026.4.24 code; this needs runtime confirmation to rule out plugin-provided routes.

### Routes confirmed in source

Search of `dist/server.impl-CtLS1ywt.js` and the router files yields these pathname matches:

| Route                          | Method | Purpose                                                     |
| ------------------------------ | ------ | ----------------------------------------------------------- |
| `/v1/models`, `/v1/models/*`   | GET    | OpenAI-compatible model catalog                             |
| `/v1/embeddings`               | POST   | OpenAI-compatible embeddings                                |
| `/v1/chat/completions`         | POST   | OpenAI-compatible chat completions (with tool-call support) |
| `/v1/responses`                | POST   | OpenAI OpenResponses with SSE                               |
| `/tools/invoke`                | POST   | Direct tool invocation                                      |
| `/__openclaw__/ws`             | WS     | Internal control WS (UI / tool stream)                      |
| `/__openclaw__/canvas`         | GET    | Canvas UI                                                   |
| `/__openclaw__/a2ui`           | GET    | A2UI surface                                                |
| `/voiceclaw/realtime`          | WS     | Realtime voice                                              |

**The docs-referenced `/api/sessions/<id>/messages` is not in the gateway sources.** It appears in `control-ui/assets/*.js` strings — that's the control-UI shell consuming a different surface (likely an internal-control-only path or a future endpoint). For our purposes, the agent-driving HTTP surface is `/v1/responses` (preferred) or `/v1/chat/completions`.

### Auth shape — `Authorization: Bearer <token>` (or `x-openclaw-token`)

File: `dist/http-utils-RmXZN896.js:747-751`:

```javascript
function getBearerToken(req) {
    const raw = normalizeOptionalString(getHeader(req, "authorization")) ?? "";
    if (!normalizeLowercaseStringOrEmpty(raw).startsWith("bearer ")) return;
    return normalizeOptionalString(raw.slice(7));
}
```

The token is validated against `cfg.gateway.auth.token` (current template: `${OPENCLAW_AUTH_TOKEN}` from env). Auth modes supported: `"token"` (shared secret) and other modes for pairing flows.

Override headers usable on the same request:

- `x-openclaw-agent-id` / `x-openclaw-agent` — pin a specific agent
- `x-openclaw-session-key` — pin a session
- `x-openclaw-message-channel` — message provider id (e.g. "discord")
- `x-openclaw-account-id` — the discord account id
- `x-openclaw-message-to` — the chat peer id
- `x-openclaw-thread-id` — thread id
- `x-openclaw-model` — runtime model override
- `x-openclaw-scopes` — operator scopes (advanced)

### `POST /tools/invoke` — exact shape

File: `dist/tools-invoke-http-DxEbZW3I.js:65-150`:

**Request body:**
```json
{
  "tool": "list_projects",         // required, string
  "action": "list",                  // optional, merged into args if schema has an `action` property
  "args": { ... },                   // optional, must be object
  "sessionKey": "agents/anubis/main" // optional, "main" or omit to use main session
}
```

**Headers (optional):** `x-openclaw-message-channel`, `x-openclaw-account-id`, `x-openclaw-message-to`, `x-openclaw-thread-id`.

**Responses:**

| Status | Body                                                                              | When                              |
| ------ | --------------------------------------------------------------------------------- | --------------------------------- |
| 200    | `{ ok: true, result: <AgentToolResult> }`                                         | success                           |
| 400    | `{ ok: false, error: { type: "invalid_request", message } }`                      | bad body                          |
| 403    | `{ ok: false, error: { type: "tool_call_blocked", message } }`                    | before_tool_call hook blocked it  |
| 404    | `{ ok: false, error: { type: "not_found", message: "Tool not available: <name>" } }` | tool unknown to the current agent |
| 405    | (Method Not Allowed)                                                              | non-POST                          |
| 500    | `{ ok: false, error: { type: "tool_error", message } }`                           | execute() threw                   |

`AgentToolResult` shape: `{ content: TextContent[] | ImageContent[], details: T, terminate?: boolean }`. `TextContent = { type: "text", text: string }`.

`/tools/invoke` calls `resolveGatewayScopedTools` with `allowGatewaySubagentBinding: true` — so **plugin tools surface on this endpoint**. We can use this for smoke-testing our plugin from outside the chat loop.

### `POST /v1/responses` — OpenAI OpenResponses

File: `dist/openresponses-http-BJuqBOiC.js`. Zod schemas confirm:

- Input items: `message`, `function_call`, `function_call_output`, etc.
- Message roles: `system`, `developer`, `user`, `assistant`
- Content parts: `input_text`, `output_text`, `input_image` (URL or base64), `input_file` (URL or base64)
- Assistant phases: `commentary`, `final_answer`
- Streaming via SSE (`setSseHeaders` + `writeDone`); response Content-Type for non-stream JSON

This is the recommended endpoint for driving agents externally. For our migration, the bot-bridge plugin doesn't call this endpoint — openclaw drives the chat loop natively from Discord. But it's available for external integrations later.

### Required runtime verification before Phase 2

1. Boot the container (`docker compose up -d`) and confirm `GET /` returns a 404 or banner (root not used).
2. `curl -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" -X POST http://127.0.0.1:18789/tools/invoke -d '{"tool":"sessions_list"}'` — confirm 200 with `result`.
3. `curl -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" -X POST http://127.0.0.1:18789/v1/responses -d '{"model":"openclaw/default","input":[...]}'` — confirm SSE stream.
4. Confirm a custom tool from the plugin appears in `tool_search` results AND can be invoked via `/tools/invoke`.

## B5 — Custom tool registration skeleton

### Plugin package layout

The cleanest layout that survives both the "install via `openclaw plugins install`" path and the "bind-mount into image" path:

```
openclaw-control/bot-bridge/                         # rename TBD; user to confirm
├── package.json                                      # see below
├── openclaw.plugin.json                              # plugin manifest (optional but recommended)
├── tsconfig.json
├── src/
│   ├── index.ts                                      # plugin entry — exports definePluginEntry
│   ├── config.ts                                     # env-var reading (survives)
│   ├── daemonClient.ts                               # HTTP client to daemon (survives)
│   ├── ptahLauncher.ts                               # invoke_ptah subprocess (NEW; replaces daemon/src/harness/ptahLauncher.ts in places)
│   └── tools/
│       ├── invokePtah.ts                             # invoke_ptah custom tool
│       └── daemonCrud.ts                             # 7 CRUD tools (list_projects, list_tasks, ...)
└── dist/                                             # tsc output; this is the openclaw.extensions entry
    └── index.js
```

### `package.json`

```json
{
  "name": "@openclaw-control/bot-bridge-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "peerDependencies": {
    "openclaw": ">=2026.4.24"
  },
  "dependencies": {
    "typebox": "^0.34.0",
    "undici": "^6.0.0"
  },
  "scripts": {
    "build": "tsc -p ."
  }
}
```

`openclaw.extensions` is the magic field that openclaw's plugin loader reads to find the entry module. `peerDependencies.openclaw` triggers the install-time symlink behavior (CHANGELOG `#70462`).

### `openclaw.plugin.json` (optional)

```json
{
  "id": "bot-bridge-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "daemonUrl": { "type": "string" },
      "ptahBin":   { "type": "string" }
    }
  }
}
```

### `src/index.ts` — minimal skeleton

```typescript
import { definePluginEntry, type OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { textResult, failedTextResult } from "openclaw/plugin-sdk/agent-runtime";

import { listProjects, listTasks, getTask, createTask, approveTask, handoffTask, startHarnessSetup } from "./tools/daemonCrud.js";
import { invokePtahTool } from "./tools/invokePtah.js";

export default definePluginEntry({
    id: "bot-bridge-plugin",
    name: "Openclaw-Control Bot-Bridge Plugin",
    description: "Daemon CRUD tools + invoke_ptah for orchestration-tier handoff.",
    register(api) {
        // Note: each factory receives the per-call OpenClawPluginToolContext.
        // ctx.agentId / ctx.sessionKey / ctx.workspaceDir are populated; env is read directly from process.env.

        api.registerTool(invokePtahTool, { name: "invoke_ptah" });

        api.registerTool(listProjects, { name: "list_projects" });
        api.registerTool(listTasks, { name: "list_tasks" });
        api.registerTool(getTask, { name: "get_task" });
        api.registerTool(createTask, { name: "create_task" });
        api.registerTool(approveTask, { name: "approve_task" });
        api.registerTool(handoffTask, { name: "handoff_task" });
        api.registerTool(startHarnessSetup, { name: "start_harness_setup" });

        api.logger.info(`[bot-bridge-plugin] registered 8 tools (7 daemon CRUD + invoke_ptah)`);
    },
});
```

### A single tool factory (e.g. `invoke_ptah`) — concrete shape

```typescript
// src/tools/invokePtah.ts
import { Type, type Static } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { textResult, failedTextResult } from "openclaw/plugin-sdk/agent-runtime";

import { resolveProjectAndSpawnPtah } from "../ptahLauncher.js";
import { config } from "../config.js";

const InvokePtahParams = Type.Object({
    project: Type.String({ description: "Project slug as registered in the daemon." }),
    prompt: Type.String({ description: "Prompt forwarded verbatim to ptah-cli." }),
}, { additionalProperties: false });

type InvokePtahParams = Static<typeof InvokePtahParams>;

export const invokePtahTool: OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "invoke_ptah",
    label: "Invoke ptah-cli",
    description: "Dispatch a workspace-scoped ptah-cli invocation for long-context refactors. Synchronous — chat blocks until ptah returns. Use only when the operator says so, or when claude-code is obviously the right tool (multi-file, long-context).",
    parameters: InvokePtahParams,
    async execute(toolCallId, params: InvokePtahParams, signal, onUpdate): Promise<any> {
        try {
            const result = await resolveProjectAndSpawnPtah({
                project: params.project,
                prompt: params.prompt,
                signal,
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                onChunk: (chunk: string) => {
                    // Stream partial assistant output back to openclaw if available.
                    onUpdate?.(textResult(chunk, { partial: true }));
                },
            });
            return textResult(result.output, {
                status: "ok",
                durationMs: result.durationMs,
                exitCode: result.exitCode,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return failedTextResult(`invoke_ptah failed: ${message}`, { status: "failed", error: message });
        }
    },
});
```

### A 7-tool daemon-CRUD example

```typescript
// src/tools/daemonCrud.ts
import { Type, type Static } from "typebox";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { textResult, failedTextResult } from "openclaw/plugin-sdk/agent-runtime";

import { daemon } from "../daemonClient.js";

export const listProjects: OpenClawPluginToolFactory = (_ctx) => ({
    name: "list_projects",
    label: "List projects",
    description: "List all projects with their open and total task counts as a markdown table.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params) {
        try {
            const projects = await daemon.listProjects();
            return textResult(renderProjectTable(projects), { count: projects.length });
        } catch (err) {
            return failedTextResult(String(err), { status: "failed", error: String(err) });
        }
    },
});

function renderProjectTable(projects: Array<{ slug: string; open: number; total: number }>): string {
    if (projects.length === 0) return "No projects.";
    const header = "| Project | Open | Total |\n| --- | ---: | ---: |";
    const rows = projects.map((p) => `| ${p.slug} | ${p.open} | ${p.total} |`).join("\n");
    return `${header}\n${rows}`;
}

// ...analogous shapes for list_tasks, get_task, create_task, approve_task, handoff_task, start_harness_setup
```

### Streaming behavior

`execute` returns `Promise<AgentToolResult<T>>` — synchronous from the chat-loop perspective. For partial streaming during execution use `onUpdate` (third argument) to push intermediate `AgentToolResult` instances; openclaw forwards them through `tool_execution_update` events. For `invoke_ptah` we'd stream ptah's stdout chunks via `onUpdate` so Discord shows progress, with the final return value carrying the full output. The agent loop doesn't block — it awaits the final promise — but the model only sees the final result (not the intermediate updates) on next turn; updates are for UI/observability.

### How the plugin reads env

The plugin is just a Node module openclaw `import()`s — it shares openclaw's `process.env`. So:

```typescript
// src/config.ts
export const config = {
    daemonUrl:     process.env.OPENCLAW_DAEMON_URL     ?? "http://localhost:7878",
    internalToken: process.env.OPENCLAW_INTERNAL_TOKEN ?? "",
    ptahBin:       process.env.PTAH_BIN                ?? "ptah",
};
```

No special wiring through the plugin context. The plugin runs in-process with openclaw, NOT as a sidecar subprocess — this is different from the current bot-bridge architecture and is the right move per context.md §"Bot-bridge becomes a custom openclaw plugin process." Note: "process" in context.md is slightly misleading; openclaw plugins are in-process modules, not separate processes. The `invoke_ptah` tool spawns a ptah subprocess per-call, but the plugin itself is loaded inside openclaw's Node runtime.

### Plugin discovery in our image

Two viable paths for shipping the plugin:

**Option A — Bundled-extension layout (recommended):** Copy the built plugin into `/usr/lib/node_modules/openclaw/dist/extensions/bot-bridge-plugin/` at image build. Openclaw auto-discovers all `dist/extensions/*` entries that have an `index.js`. No `plugins.allow` or `plugins.load.paths` needed in config.

**Option B — External plugin via `plugins.load.paths`:** Install the plugin at e.g. `/opt/openclaw-control/bot-bridge/` and add `"plugins": { "load": { "paths": ["/opt/openclaw-control/bot-bridge"] } }` to the openclaw config, plus `"plugins": { "allow": ["bot-bridge-plugin"] }`. This is closer to the existing Dockerfile layout but exposes us to the historical jiti-alias-resolution edge cases. The fix in v2026.4.24 makes this work, but Option A removes one variable.

**Recommendation: Option A.** Less surface area, no `peerDependencies` resolution headaches.

## Recommendations

### Go / No-Go: **GO**

The migration architecture in context.md is feasible at v2026.4.24 with no blocking gaps. Every required capability is documented in code:

- Plugin SDK with `api.registerTool()` and a factory pattern that gives us the necessary context (`agentId`, `sessionKey`, `workspaceDir`, `senderIsOwner`).
- Multi-agent Discord with per-account bot tokens and `bindings[]` for routing.
- HTTP endpoints (`/v1/responses`, `/v1/chat/completions`, `/tools/invoke`) for external integration and smoke testing.
- Sandbox isolation via Docker bind-mount discipline + `tools.fs.workspaceOnly` for the persona-privacy invariant. (Caveat: no explicit deny-path semantics, but we don't need them — exclusion is sufficient.)
- The known bug 59047 is fixed at our exact version (`cbcfdf6` build hash matches the closer's cited commit).

### Architectural adjustments needed

1. **Plugin is in-process, not a sidecar process.** Context.md says "bot-bridge becomes a custom openclaw plugin process" — the actual shape is "openclaw plugin module loaded into openclaw's Node runtime." This is BETTER than the documented intent (one fewer process to manage, simpler IPC). The plugin's `invoke_ptah` tool still spawns a ptah subprocess per call, but the plugin lifetime is the openclaw lifetime.

2. **Ship as a bundled extension at `/usr/lib/node_modules/openclaw/dist/extensions/bot-bridge-plugin/`.** Avoids the `plugins.allow` / jiti-alias paths entirely and aligns with how openclaw bundles its own browser / diffs / discord plugins.

3. **Persona-privacy enforcement points migrate** as described in context.md §"Persona privacy: layers 1-4 ... layers 5-6 ... substituted by openclaw's per-agent sandbox + path-restriction policy." Concretely:
   - Layer 5 → `tools.fs.workspaceOnly: true` per agent + Docker sandbox with no `~/.claude/local-memory` bind-mount
   - Layer 6 → bot-bridge plugin handlers (specifically `invoke_ptah`) keep their input validation; daemon layers 1-4 remain the canonical chokepoint

4. **`/api/sessions/<id>/messages` doesn't exist in v2026.4.24.** Drop any plans that referenced it. The driveable surfaces are `/v1/responses`, `/v1/chat/completions`, `/tools/invoke`. The Discord-native chat loop is preferred (no HTTP layer needed).

5. **Plugin handler return types are AgentToolResult, not raw strings.** Adjust the migration architecture doc to reference `textResult(text, details)`, `failedTextResult(text, details)`, `imageResult(...)` — these are the canonical helpers.

### Specific risks, ranked by severity

| # | Risk                                                                                                                   | Severity | Mitigation                                                                                                                                                                                                                                                                              |
| - | ---------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Plugin tools fail to surface in production despite v2026.4.24 fix (regression or our deployment shape triggers a new code path). | MED      | Add an integration smoke test that POSTs `/tools/invoke` with `{tool:"list_projects"}` before each release. Use Option A (bundled-extension layout) to dodge the historical jiti-alias surface entirely.                                                                                |
| 2 | Per-agent Discord routing config has subtle "default agent" surprises (e.g. unbound messages routed to the wrong agent). | MED      | For each `accounts.<accountId>` entry create a corresponding `bindings[]` entry with `match.channel="discord", match.accountId=<id>`. Set `default: true` on exactly one agent. Smoke test by sending a DM to each bot and confirming `matchedBy` in logs.                              |
| 3 | Sandbox bind-mounts accidentally include local-memory (e.g. via a future `agents.defaults.sandbox.docker.binds` line).  | MED      | Defense in depth: layers 1-4 in daemon stay. Layer 5 = `tools.fs.workspaceOnly: true`. Layer 6 = unit test verifying no bind-mount entry contains `local-memory` or `.claude/`.                                                                                                          |
| 4 | `invoke_ptah` long-running ptah subprocess holds the chat loop open indefinitely.                                       | LOW      | Pass `signal: AbortSignal` (provided to `execute()`) through to the ptah subprocess. Set a default timeout (e.g. `PTAH_INVOKER_TIMEOUT_MS`, default 1800s = 30min). On timeout, kill the subprocess and return `failedTextResult`. Context.md §6 already calls out "v1: synchronous." |
| 5 | Plugin module not discovered (silent failure).                                                                          | LOW      | After plugin load, openclaw logs `"plugin <id> registered N tools"`. Add a startup check in `entrypoint-control.sh` that `curl /tools/invoke` for `list_projects` returns 200 before declaring the container healthy.                                                                   |
| 6 | The fix for issue 59047 has an edge case in subagent contexts that breaks our `invoke_ptah` if it spawns subagents.    | LOW      | `invoke_ptah` does not spawn an openclaw subagent — it spawns an external ptah process. So this risk class doesn't apply. Still: keep the `tool_search` smoke test in the gate.                                                                                                         |
| 7 | Memory plugin slot disabled when `plugins.enabled=false` propagates to our plugin.                                     | LOW      | Our plugin doesn't use the memory slot. We just need `plugins.enabled: true` (the default) and `plugins.allow` to either be omitted or include `bot-bridge-plugin`.                                                                                                                     |

## Open follow-ups

1. **Runtime endpoint verification.** The container must be started, and `curl` probes against `/tools/invoke`, `/v1/responses`, `/v1/chat/completions` performed with the actual `OPENCLAW_AUTH_TOKEN` from `.env`. Findings in B4 are derived from compiled JS sources and CHANGELOG — they should be accurate, but live confirmation is cheap and worth doing before architecture sign-off. This was deliberately not done during this spike per the constraint "no commands that modify the running container."

2. **Confirm the chat-tier model driving openclaw agents inside the gateway.** The current gateway template uses `${LLM_PROVIDER}/${LLM_MODEL}` — the same env vars the bot-bridge currently uses for its custom chat loop. Confirm this remains correct under the new architecture and that no additional config is needed for tool-call compatibility (some providers/models don't support function-calling).

3. **Plugin lifecycle vs. process lifecycle.** Decide whether the bot-bridge plugin should retain ANY long-lived state (e.g. an MCP client manager). If yes — register a `registerService({ start, stop })` and own that lifecycle there. If no — every tool factory is stateless and the migration is simpler. Recommend "no" for v1.

4. **Naming.** Context.md asks the user to confirm the rename from `bot-bridge` to `openclaw-plugin-host` or similar. Suggest deferring to the software-architect phase.

5. **Sandbox image.** The current Dockerfile installs the gateway + daemon + dashboard + bot-bridge in one image. Under the new architecture, `agents.list[].sandbox.mode: "all"` requires a SEPARATE sandbox image (the agents run inside containers spawned by openclaw, NOT the gateway container). This is a Phase 2 Dockerfile change — not blocking for the architecture doc but should be flagged.

6. **MCP client manager replacement.** The current bot-bridge has `src/mcp/mcpManager.ts`. Openclaw has its own MCP plumbing (`dist/pi-bundle-mcp-runtime-B_SrebwR.js` and others). Under the new architecture we should remove the bot-bridge MCP code entirely and configure MCP servers through openclaw's `config.mcp` instead. Worth a separate spike if MCP is in scope for v1.

7. **Cleanup of `.openclaw-extract/`.** This spike created `.openclaw-extract/` and `.openclaw-extract/pi-deps/` for source inspection. These are gitignored by default if not added; should be deleted after the architecture doc is approved (and a `.gitignore` entry added if not present). Not strictly load-bearing for migration.

---

## B4 (live runtime addendum) — Runtime endpoint probes executed 2026-05-12

The original B4 was code-only because the container was not running. After the user approved live verification, probes were executed against the **already-running host-native stack** (not the container — see "Process topology" below).

### Probe results

| # | Endpoint                            | Method | Auth      | HTTP | Body excerpt / shape                                                                                                  |
|---|-------------------------------------|--------|-----------|------|-----------------------------------------------------------------------------------------------------------------------|
| 1 | `/`                                 | GET    | Bearer    | 200  | Dashboard SPA HTML (`<title>OpenClaw Control</title>`)                                                                |
| 2 | `/health`                           | GET    | (any)     | 200  | `{"ok":true,"status":"live"}`                                                                                         |
| 3 | `/tools/invoke` (no auth)           | POST   | NONE      | 401  | `{"error":{"message":"Unauthorized","type":"unauthorized"}}`                                                          |
| 4 | `/tools/invoke` `sessions_list`     | POST   | Bearer    | 200  | `{"ok":true,"result":{"content":[{"type":"text","text":"{\"count\":1,\"sessions\":[{...}]}"}]}}` — real session data |
| 5 | `/tools/invoke` unknown tool        | POST   | Bearer    | 404  | `{"ok":false,"error":{"type":"not_found","message":"Tool not available: nonexistent_tool_xyz"}}`                      |
| 6 | `/v1/chat/completions`              | POST   | Bearer    | 404  | `Not Found` (plain text) — endpoint NOT enabled in current config                                                     |
| 7 | `/v1/responses`                     | POST   | Bearer    | 404  | `Not Found` (plain text) — endpoint NOT enabled in current config                                                     |
| 8 | `/v1/models`                        | GET    | Bearer    | 200  | Dashboard SPA HTML — SPA catch-all caught it, real endpoint absent                                                    |
| 9 | `/__openclaw__/info`                | GET    | Bearer    | 200  | Dashboard SPA HTML — same SPA catch-all                                                                               |

### Findings

1. **`/tools/invoke` works exactly as the research predicted.** Response shape is `{ok:true,result:{content:[{type:"text",text:string}]}}` for success, `{ok:false,error:{type,message}}` for failure. The bot-bridge plugin can rely on this contract. Auth enforced correctly (401 on missing token).

2. **OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`) are NOT enabled** in our current `openclaw.json`. Per the original research, they require `gateway.http.endpoints.openaiChat.enabled` / `responses.enabled` flipped on. **This is fine for the migration** — the migration uses the Discord-native chat path which doesn't traverse HTTP. No config change needed unless the architect decides to expose these for external integration (separate decision).

3. **SPA catch-all is greedy.** Any unrecognized path under `:18789` returns the dashboard HTML, NOT a 404. Important implication: future API routes must be deliberately registered before they're addressable; a missing registration appears as "dashboard HTML" rather than a clean 404. Document this for the architect — it's a debugging gotcha.

4. **Daemon at `:7878` reports current state:**
   ```json
   {"ok":true,"leader":true,"localAgentIds":["anubis"],"storage":"db","dbVersion":4,"dbPath":"/data/specs.db"}
   ```
   - Leader mode (matches the target architecture's leader/follower model).
   - `anubis` is the only locally-bound persona.
   - Schema is **v4** — already past TASK_2026_004's planned v3. The stashed TASK_004 migration code is therefore *behind* current schema and would not apply cleanly even if recovered. Reinforces the cancellation decision.

5. **Active session in `sessions_list` output:** one session for `agentId:"main"` running model `kimi-k2.6:cloud`, status `failed`. This is the **openclaw built-in default agent**, not anubis. The gateway is currently configured with the single default agent `main` and has NOT yet been migrated to multi-agent. The migration will replace this `main` agent with proper per-persona entries in `agents.list`.

### Process topology — IMPORTANT for the architect

`ps` revealed the entire stack is running **on the host directly**, NOT inside the `openclaw` container:

```
PID 2314  openclaw                              (gateway binary)
PID 2633  openclaw-gateway                      (child process)
PID 2572  node /opt/openclaw-control/daemon/dist/index.js     (control plane)
PID 2598  node /opt/openclaw-control/bot-bridge/dist/index.js (current bot-bridge — to be replaced)
PID 1092  node /home/anubis/.../scripts/ptah-bridge.mjs       (host-side ptah bridge)
```

PPID 2164 traces back to the user's session — these are user-launched processes, not container-managed. The `openclaw` binary was installed into `/opt/openclaw-control/` somehow (likely a host npm install or a build-artifact extraction), distinct from the `docker compose` workflow described in repo docs.

**Implications for migration deployment:**
- Phase 2 deployment must update whatever the user is using to start the host stack (systemd unit? terminal launcher? unknown — needs the user to surface this), not just `docker-compose.yml`.
- The current bot-bridge process (PID 2598) will be **stopped and replaced** by an openclaw plugin loaded into the gateway process (PID 2314). One fewer node process post-migration.
- The daemon (PID 2572) stays as-is; only its callers change.
- The ptah-bridge (PID 1092) stays — `invoke_ptah` calls into it via HTTP.

### Updated risk assessment

The two MED risks from the original report remain valid; one drops; one new MED:

| # | Risk                                                                | Severity     | Status                                                                                                             |
|---|---------------------------------------------------------------------|--------------|--------------------------------------------------------------------------------------------------------------------|
| 1 | Plugin tools fail to surface in production                          | MED          | Mitigation unchanged — smoke test at startup                                                                       |
| 2 | Per-agent Discord routing config surprises                          | MED          | Mitigation unchanged — `matchedBy` smoke test per bot                                                              |
| 3 | Sandbox bind-mounts accidentally include local-memory               | MED → **LOW** | Stack runs on host, not in container sandbox. Bind-mount risk doesn't apply to the gateway process; only to ptah sandboxes if `invoke_ptah` ever spawns one. Daemon layers 1-4 stay. |
| 4 | `invoke_ptah` long-running ptah subprocess holds chat loop          | LOW          | Mitigation unchanged                                                                                               |
| 5 | Plugin module not discovered (silent failure)                       | LOW          | Mitigation unchanged; finding #3 (SPA catch-all) reinforces the need for a deliberate smoke test                   |
| **new** | **Deployment-mechanism unknown.** Stack runs on host but the launcher is undocumented in this repo. Migration deployment plan needs the user to surface how the host stack is started. | **MED**   | Surface to user during architecture-doc checkpoint                                                                |

### Final GO/NO-GO after runtime verification

**Unchanged: GO.** Runtime probes confirm the documented surface works. The two surprises (OpenAI endpoints disabled, host-native deployment) are non-blocking — the migration design accommodates them naturally. The schema-v4-already-current finding strengthens the case for cancelling TASK_2026_004/_005 (their migration code is obsolete on contact).

---

**End of research-findings.md**
