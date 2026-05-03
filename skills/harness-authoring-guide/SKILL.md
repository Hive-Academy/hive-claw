---
name: harness-authoring-guide
description: Operating manual for authoring per-agent and per-project harness.yaml files, driving the harness-authoring chat flow, and reasoning about hot-reload and materialization. Use when an operator is creating a new agent, adding a project harness, or editing tier configuration. Cites the schema in daemon/src/harness/types.ts and the authoring tools in bot-bridge/src/harnessAuthor.ts.
---

# harness-authoring-guide skill

This skill compresses the operator runbooks in `docs/PLAYBOOKS.md` Runbook B
(register a new agent) and Runbook C (drive Anubis to author a per-project
harness). When the operator wants step-by-step procedure, point them at
`docs/PLAYBOOKS.md`; this skill is for the persona to *understand* the
workflow well enough to *guide* the operator through it.

## Tools this skill expects to be available

The persona composes these tool surfaces, in this order, when authoring:

- **Per-project harness flow** (the persona's primary authoring path) is
  driven by the harness-author tools in `bot-bridge/src/harnessAuthor.ts`,
  reached by firing the daemon-CRUD tool `start_harness_setup` with a
  `project` slug. After that call the chat-tier tool registry is replaced
  (not merged) with five tools: `probe_project`, `read_file`,
  `propose_harness`, `confirm_harness`, `write_harness_file`.
- **Per-agent harness flow** has no equivalent five-tool chat surface. It
  proceeds through the operator: the operator hand-edits
  `shared-specs/memory/agents/<id>/harness.yaml`, then fires
  `POST /api/agents/<id>/harness/sync` (an operator curl — no chat-tier
  tool exposes this endpoint). The persona's job is to draft the yaml in
  chat, not to write it.
- Verification of project slugs uses `list_projects` (daemon-CRUD).
- Background reads of public agent files (e.g. an existing
  `identity.md` for an agent referenced in a subagent prompt) happen via
  the operator's curl against `GET /api/memories/agents/<id>/identity.md`
  — the chat tier has no general-purpose read_memory tool today. The
  persona names the endpoint when it needs a fact it does not have.

## Per-agent vs per-project harness

Two locations, two behaviors:

- **Per-agent harness** at `shared-specs/memory/agents/<id>/harness.yaml`.
  Public config; reachable via `GET /api/memories/agents/<id>/harness.yaml`.
  Defines the agent's enduring shape across every project: which skills
  fold into its system prompt, which subagents it can spawn, which MCP
  servers attach. Edit this when the agent itself is changing — new
  specialty, new tool surface, new persona-level subagent. Materialized by
  the daemon into `~/.ptah/agents/<id>/settings.json` and
  `~/.ptah/plugins/openclaw-<id>-harness/` for the orchestration tier.
- **Per-project harness** at `<project>/.claude/harness.yaml`. Project-local
  overlay; written by the harness-authoring chat flow into the project
  directory via the daemon's `POST /api/projects/<slug>/files` endpoint.
  Defines the project-specific overlay: extra MCP servers, extra skills,
  project-specific subagents.

Authoring a new agent: per-agent. Adding a project to an existing agent's
working set: per-project. When the operator is unsure, ask which.

## The HarnessConfig schema

Defined in `openclaw-control/daemon/src/harness/types.ts`, mirrored
byte-identically in `openclaw-control/bot-bridge/src/harness/types.ts`. Any
yaml the persona produces must round-trip cleanly through `parseHarnessYaml`.

Top-level shape (required fields marked):

```yaml
version: 1                     # required, must equal 1
chatTier:                      # required
  skills: [<name>, ...]        # required, may be empty
  subagents: [<SubagentDef>]   # required, may be empty
  mcpServers: [<McpServerSpec>] # required, may be empty
  tools: [<name>, ...]         # optional — chatTier-only opt-in for
                               # Discord-native tools (read_channel_history,
                               # upload_attachment). NOT a general tools field.
orchestrationTier:             # required
  skills: [<name>, ...]        # required
  subagents: [<SubagentDef>]   # required
  mcpServers: [<McpServerSpec>] # required
  enabledPluginIds: [<id>]     # optional, orchestration only
  modelTier: claude_code | enhanced  # optional, defaults to claude_code
```

`SubagentDef` requires `name`, `description`, `systemPrompt`. Optional
`tools` is a SUBSET FILTER — it must list real tool names from the parent
tier's effective registry. The schema validates shape, not subset
membership; the runtime drops unknown names silently.

`McpServerSpec` requires `id` (matches `/^[a-z0-9_-]+$/`) and `command`.
Optional: `args`, `env`, `timeoutMs`, `transport` (`stdio` | `sse`,
defaults to `stdio`). Env values support `${VAR}` interpolation against the
daemon's process env at spawn time.

`enabledPluginIds`: do NOT list `openclaw-<id>-harness` here — the
materializer adds it.

## Skill loading

Skill names map to directories under `<repo-root>/skills/<name>/SKILL.md`.
Naming convention: hyphens, lowercase, no underscores. `parseHarnessYaml`
will accept underscores; the skill loader will fail to find the directory.

At chat time, the bot-bridge reads each skill body and concatenates it into
the persona's system prompt. At materialization, the daemon copies the
skill body into `~/.ptah/plugins/openclaw-<id>-harness/skills/<name>/`.

## Subagent loading

Each subagent in `chatTier.subagents` becomes two tools in the persona's
chat-tier registry: an umbrella `delegate_to_subagent(name, prompt)` and a
shortcut `delegate_to_<snakecased_name>(prompt)`. Both route through
`subagentRunner.run()`, which gets its own LLM call with its own system
prompt (the `systemPrompt` from the yaml).

Subagents inherit the parent's effective toolbelt unless `tools:` filters
it. Keep subagent system prompts tight: one paragraph of role definition,
an explicit stop condition, an explicit out-of-scope list.

## MCP loading

`stdio` servers spawn as child processes per-agent on the bot-bridge host.
Tools are namespaced as `mcp__<server-id>__<tool-name>` in the chat-tier
registry — see `bot-bridge/src/tools/mcpTools.ts`. Failed servers stop
appearing in the registry until `harness/sync` fires; until then the
manager retries on the backoff schedule `[1000, 2000, 4000, 8000, 16000,
30000]` ms.

## chatTier.tools (TASK_2026_003 opt-in)

Two Discord-native tools live behind explicit harness opt-in:

- `read_channel_history` — fetch recent messages from a Discord channel or
  DM for context.
- `upload_attachment` — post a file or image into the current Discord
  channel. Path-source mode is gated by the privacy guards in
  `bot-bridge/src/tools/discordTools.ts`.

A persona that does not list these in `chatTier.tools` does not get them.
Anubis's harness opts into both. Other agents must opt in explicitly. They
are NOT in the always-on chat-tier registry.

The `tools` field exists ONLY on `chatTier`. Adding it to
`orchestrationTier` is a no-op; `parseHarnessYaml` does not surface a
`tools` field on the orchestration tier.

## Hot-reload contract

The daemon writes harness files; both tiers re-read on a single Redis event
(`harness/sync`). Trigger paths:

- Per-agent: write `shared-specs/memory/agents/<id>/harness.yaml`, then
  fire `POST /api/agents/<id>/harness/sync` (operator curl). The daemon
  imports the file into the DB, materializes the orchestration tree, and
  publishes the Redis event.
- Per-project: the chat-tier `write_harness_file` tool emits the event
  after a successful POST to the project-files endpoint.

On the event, the bot-bridge's `reloadAgent` re-fetches the harness from
the daemon HTTP and swaps `running.get(id).def`. The next message uses the
new def. The orchestration tier rewrites its on-disk plugin tree. The
operator does not restart anything.

A note on the closure-bug fix: commit `fcd9061` corrected an issue where
older builds captured the harness by closure at agent boot, which made
hot-reload silently no-op. If the operator sees "I edited the harness but
the persona is still using the old subagents," check the bot-bridge
version against that commit before debugging anything else.

## The five-tool harness-authoring flow (per-project)

Code lives in `openclaw-control/bot-bridge/src/harnessAuthor.ts`. The
persona drives this flow when the operator says "set up a harness for this
project" or equivalent. The flow's preconditions: a project slug must
already exist in the daemon (verify with `list_projects`).

Entry:

1. Fire `start_harness_setup` (daemon-CRUD tool) with the project slug.
   The chat layer flips into harness-authoring mode and replaces the tool
   registry with the five authoring tools below. Idle timeout: 30 minutes.
   If the session expires the operator must restart by issuing the same
   `start_harness_setup` call.

The five authoring tools:

1. `probe_project` — bounded directory listing, package.json digest,
   framework-marker scan, git remote, README first 80 lines. Run this
   first.
2. `read_file(relativePath)` — read a single file inside the project, 100
   KB cap, no `..`, no leading `/`.
3. `propose_harness(yaml)` — emits a draft yaml. Validated through
   `parseHarnessYaml`; on failure the error is path-prefixed
   (`harness.chatTier.skills[0]: ...`) so the persona can fix and retry.
   On success the proposal is staged.
4. `confirm_harness` — flips the stage to `awaiting-operator-confirmation`.
   The persona MUST stop generating tool calls after this and end its
   reply asking the operator to type "yes", "no", or "cancel harness
   setup".
5. `write_harness_file` — writes `<project>/.claude/harness.yaml` via the
   daemon's project-files endpoint. Only callable after the operator types
   "yes" (the chat layer flips the stage to `writing` on a yes). Emits
   `harness/sync`.

When the operator says "no" mid-flow, drop back to step 3 with a revised
proposal. Do not fabricate tool names or skip the confirmation gate.

When the chat tier is unavailable (bot-bridge degraded), fall back to:
operator hand-edits `<project>/.claude/harness.yaml`, operator fires the
project-files HTTP endpoint, operator triggers `harness/sync`. The persona
walks them through the curl invocations.

## Common authoring mistakes

- Listing daemon-CRUD tools (`create_task`, `dispatch_orchestration_task`)
  in `subagents[].tools`. These are chat-tier registry tools, not subagent
  tools. The yaml will round-trip but the subagent will not get them.
- Listing `start_harness_setup` or the harness-author tools in any
  subagent's `tools`. The harness-author registry is a *replacement* of
  the chat-tier registry, not a subset of it.
- Adding a `tools` field to `orchestrationTier`. The schema only surfaces
  it on `chatTier`.
- Using underscores in skill names. The directory under `skills/` is
  hyphen-cased.
- Quoting `${GITHUB_TOKEN}` outside double quotes. YAML's `${...}` is not
  yaml syntax — it is interpolated by the daemon. Always quote the value.
- Setting `enabledPluginIds: ["openclaw-<id>-harness"]` explicitly. The
  materializer adds it.
- Putting orchestration-only fields (`enabledPluginIds`, `modelTier`)
  under `chatTier`. `parseHarnessYaml` ignores them there silently.

When proposing a harness, dry-run it mentally against the parser: every
required field present, every type correct, every name a real reference.

## Legacy rollback path

The bot-bridge retains a directive grammar of the form
`<<oc:create_task ...>>` parsed in `chat.ts`. This grammar is the rollback
path only — it exists so the system continues to function if the structured
tool layer regresses. The persona MUST NOT emit these directives in
visible chat replies. Default to the structured tools listed above. The
directive grammar is documented here for completeness; it is not a tool the
persona reaches for.
