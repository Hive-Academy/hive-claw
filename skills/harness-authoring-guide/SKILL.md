---
name: harness-authoring-guide
description: Operating manual for authoring per-agent and per-project harness.yaml files, driving the harness-authoring chat flow, and reasoning about hot-reload and materialization. Use when an operator is creating a new agent, adding a project harness, or editing tier configuration. Cites the schema in daemon/src/harness/types.ts and the authoring tools in bot-bridge/src/harnessAuthor.ts.
---

# harness-authoring-guide skill

This skill is the persona's operating manual for authoring harnesses. Two
audiences: the operator who is hand-editing a yaml, and the persona itself
when it drives the harness-authoring chat flow on the operator's behalf.

## Per-agent vs per-project harness

Two locations, two purposes:

- **Per-agent harness** at `shared-specs/memory/agents/<id>/harness.yaml`.
  Public config; reachable via
  `GET /api/memories/agents/<id>/harness.yaml`. Defines the agent's
  enduring shape across every project: which skills its system prompt
  contains, which subagents it can spawn, which MCP servers attach. Edit
  this when the agent itself is changing — new specialty, new tool surface,
  new persona-level subagent.
- **Per-project harness** at `<project>/.claude/harness.yaml`. Project-local
  override; written by the harness-authoring chat flow into the project
  directory via the daemon's project-files endpoint. Defines the
  project-specific overlay: extra MCP servers (e.g. project-specific
  Postgres, project-specific GitHub repo), extra skills, project-specific
  subagents.

Authoring a new agent: per-agent. Adding a project to an existing agent's
working set: per-project. When the operator is unsure, ask which.

## The schema

Defined in `openclaw-control/daemon/src/harness/types.ts`, mirrored
byte-identically in `openclaw-control/bot-bridge/src/harness/types.ts`. Any
yaml the persona produces must round-trip cleanly through `parseHarnessYaml`.

Top-level shape:

```yaml
version: 1
chatTier:    { skills, subagents, mcpServers }
orchestrationTier: { skills, subagents, mcpServers, enabledPluginIds?, modelTier? }
```

`HarnessTier` has exactly these fields: `skills`, `subagents`, `mcpServers`,
`enabledPluginIds` (orchestration only), `modelTier` (orchestration only).
**There is no `tools` field on `HarnessTier`.** Daemon-CRUD tools,
harness-authoring tools, and Discord-native tools (`read_channel_history`,
`upload_attachment`) are always-on at the chat-tier registry level. They
do not belong in the harness.

`SubagentDef` has `name`, `description`, `systemPrompt`, optional `tools`.
Subagent `tools` is a subset filter — must be a subset of the parent's
effective tools.

`McpServerSpec` has `id` (matches `/^[a-z0-9_-]+$/`), `command`, optional
`args`, `env`, `timeoutMs`, `transport` (`stdio` | `sse`). Env values
support `${VAR}` interpolation against the daemon's process env.

`modelTier` is `"claude_code"` or `"enhanced"`. `enabledPluginIds` is a
list; the per-agent plugin `openclaw-<id>-harness` is auto-added by the
materializer, so do not list it.

## The chat-tier vs orchestration-tier split

`docs/SKILLS-AND-PERSONA.md` is the canonical doc; this skill is the
working summary.

- **Chat tier** runs in the bot-bridge. Skills fold into the persona's
  system prompt verbatim. Subagents spawn in-process via
  `subagentRunner.run()` — no ptah dependency. MCP servers are per-persona
  stdio clients managed by the bot-bridge's MCP client manager.
- **Orchestration tier** runs in the dispatch worker's ptah subprocess.
  Skills materialize into `~/.ptah/plugins/openclaw-<id>-harness/`. Per-agent
  settings.json at `~/.ptah/agents/<id>/settings.json` is the
  `ptah --config` target. Subagents materialize as one file per subagent
  under `~/.ptah/plugins/openclaw-<id>-harness/agents/<subagent>.md`.

The chat tier never needs ptah to be installed. Only
`dispatch_orchestration_task` (a chat tool) queues work for the
orchestration tier, and that hop is asynchronous. When the operator asks
"why is anubis still answering when ptah is broken?" — that is the answer.

## How skills, subagents, and mcpServers fold in

- **Skills** are referenced by name. The name must match a directory under
  `skills/` containing `SKILL.md`. Hyphens, lowercase, no underscores.
  At chat time, the bot-bridge reads each skill body and concatenates it
  into the persona's system prompt. At materialization, the daemon copies
  the skill body into the per-agent plugin tree.
- **Subagents** are full system prompts authored inline in the yaml. Keep
  them tight: one paragraph of role definition, an explicit stop condition,
  and an explicit out-of-scope list. The subagent inherits the parent's
  toolbelt unless `tools:` filters it.
- **MCP servers** spawn as stdio child processes (default) or attach via
  SSE. The `id` namespaces the tool names — `gh` MCP exposes
  `mcp__gh__*`. The `env` block is interpolated against the daemon's
  process env at spawn time.

## Hot-reload contract

The daemon writes harness files; both tiers re-read on a single Redis event
(`harness/sync`). The event fires:

- `reloadAgent` in the bot-bridge: chat-tier registry rebuilds.
- `materializeAgent` in the daemon: orchestration-tier on-disk tree rewrites.

Both fire on every change. The operator does not restart anything.

Trigger paths:

- Direct HTTP write: `PUT /api/memories/agents/<id>/harness.yaml` followed
  by `POST /api/agents/<id>/harness/sync`.
- Harness-authoring chat: the persona drives the flow; the daemon emits
  the event when `finalize_harness` succeeds.

## The harness-authoring tool flow

Code lives in `openclaw-control/bot-bridge/src/harnessAuthor.ts`. The
persona drives this flow when the operator says "set up a harness for this
project" or equivalent.

Four tools, used in order:

1. `start_harness_setup` — initiates a harness-authoring session for a
   project path. Server-side state holds the in-progress draft. Idle
   timeout: 30 minutes; the session expires and must be restarted.
2. `inspect_project_files` — the persona reads project structure (package
   manager, framework, monorepo shape, existing `.claude/` if any). Used
   to inform skill and MCP suggestions.
3. `propose_harness` — emits a draft yaml. The persona shows it to the
   operator in chat, asks for changes, calls `propose_harness` again with
   revisions until the operator says "yes."
4. `finalize_harness` — writes the file via the daemon's project-files
   endpoint and emits `harness/sync`. Both tiers reload.

The persona never fabricates this flow on its own. It uses the tools.
When the tools are unavailable (chat tier is degraded), the persona
falls back to "edit the file at `<project>/.claude/harness.yaml` directly
and `POST /api/agents/<id>/harness/sync`."

## Common authoring mistakes

- Listing daemon-CRUD tools (`create_task`, `dispatch_orchestration_task`)
  in `subagents[].tools`. These are chat-tier registry tools, not subagent
  tools. The yaml will round-trip but the subagent will not get them.
- Using underscores in skill names. The directory under `skills/` is
  hyphen-cased. `parseHarnessYaml` will pass; the skill loader will fail
  silently.
- Quoting `${GITHUB_TOKEN}` outside double quotes. YAML's `${...}` is not
  yaml syntax — it is interpolated by the daemon. Always quote the value
  string.
- Setting `enabledPluginIds: ["openclaw-<id>-harness"]` explicitly. The
  materializer adds it. Listing it twice is harmless but confusing.
- Putting orchestration-only fields (`enabledPluginIds`, `modelTier`) under
  `chatTier`. `parseHarnessYaml` ignores them there silently. The persona
  should not.

When proposing a harness, dry-run it mentally against the parser: every
required field present, every type correct, every name a real reference.
