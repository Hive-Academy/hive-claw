---
name: harness-authoring-guide
description: Operating manual for authoring per-agent and per-project harness.yaml files, driving the harness-authoring chat flow, and reasoning about hot-reload and materialization. Use when an operator is creating a new agent, adding a project harness, or editing tier configuration. Cites the schema in daemon/src/harness/types.ts and the authoring tools in bot-bridge/src/harnessAuthor.ts.
---

# harness-authoring-guide skill

> **Trigger rule.** When the operator says "set up", "create", "author",
> "configure", or "design" a harness for a *project*, your FIRST action is to
> fire `start_harness_setup(project=<slug>)`. Do not propose YAML, draft
> sections, or summarize the project before that tool call. Once it fires,
> the registry replaces with `probe_project`, `read_file`, `propose_harness`,
> `confirm_harness`, `write_harness_file` and you can read the project tree
> directly. If you have not fired `start_harness_setup`, you have NO
> authoring tools and any proposal you write is fabrication. Fabricating is
> forbidden — fire the tool first.

This skill compresses `docs/PLAYBOOKS.md` Runbook A (register agent) and
Runbook C (per-project harness). For step-by-step procedure, redirect:
*"For the operator-runnable procedure, see `docs/PLAYBOOKS.md` Runbook
A"* (per-agent) or *"Runbook C"* (per-project). This skill is for the
persona to *understand*; PLAYBOOKS.md is for the operator to *execute*.

## Capability boundary — Anubis CAN / CANNOT

Never claim a capability not in the CAN column.

| CAN                                                                  | CANNOT                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Fire `start_harness_setup(project)` to enter authoring mode          | `git push` or any shell-level git operation                     |
| Fire `probe_project`, `read_file` (after `start_harness_setup`)      | PUT files into the leader's daemon DB (no `write_memory` tool)  |
| Fire `propose_harness(yaml)` — validates through `parseHarnessYaml`  | Edit `.env` files on any host                                   |
| Fire `confirm_harness` then `write_harness_file` (per-project only)  | Restart docker containers or systemd units                      |
| Draft `identity.md` content in chat for the operator to copy         | Trigger `POST /api/agents/<id>/harness/sync` (operator curl)    |
| Draft per-agent `harness.yaml` content in chat for the operator      | Read another agent's `persona.md` (private, 404 at the gate)    |
| Validate proposed YAML mentally against `daemon/src/harness/types.ts`| Materialize plugin trees on a host machine                      |
| Fire `create_task` to track follow-up work in an existing project    | Run `parseHarnessYaml` on its own — proposal goes through tool  |

If a request requires a capability in the CANNOT column, name it
explicitly and hand off to the operator with a pointer to
`docs/PLAYBOOKS.md`.

## Tools this skill expects

- **Per-project flow.** Fire `start_harness_setup(project)` (daemon-CRUD).
  The chat-tier registry is REPLACED (not merged) with five tools from
  `bot-bridge/src/harnessAuthor.ts`: `probe_project`, `read_file`,
  `propose_harness`, `confirm_harness`, `write_harness_file`. See
  `chat.ts` lines 488–491 for the replacement gate (keyed on
  `HARNESS_SETUP_STATE_KEY`).
- **Per-agent flow.** No five-tool chat surface. Operator hand-edits
  `shared-specs/memory/agents/<id>/harness.yaml`, then fires
  `POST /api/agents/<id>/harness/sync` (operator curl — no chat-tier
  tool exposes this; see `docs/OPERATIONS.md §8` and
  `docs/PLAYBOOKS.md` Runbook A). The persona's job is to draft the
  yaml in chat, not to write it.
- Verify project slugs with `list_projects` (daemon-CRUD).
- Public agent files (e.g. `identity.md`) are operator-curled at
  `GET /api/memories/agents/<id>/identity.md` — the chat tier has no
  general-purpose `read_memory` tool. Name the endpoint when you need
  a fact you do not have.

## Per-agent vs per-project harness

Two locations, same schema, different lifecycles:

- **Per-agent** at `shared-specs/memory/agents/<id>/harness.yaml`.
  Public config; `GET /api/memories/agents/<id>/harness.yaml`. The
  agent's enduring shape across every project. Edit when the agent
  itself changes. Materialized into `~/.ptah/agents/<id>/settings.json`
  and `~/.ptah/plugins/openclaw-<id>-harness/` **on the host machine
  that runs `<id>`** — the follower whose `.env` has
  `OPENCLAW_LOCAL_AGENT_IDS=<id>` (see host-vs-leader note below).
- **Per-project** at `<project>/.claude/harness.yaml`. Project-local
  overlay; written by the harness-authoring chat flow via
  `POST /api/projects/<slug>/files`. Extra MCP servers, extra skills,
  project-specific subagents.

When the operator is unsure which to author, ask.

## Host-vs-leader

The leader (`OPENCLAW_LEADER=1`) owns `/data/specs.db`. Hosts are the
machines that run agent processes — any machine whose `.env` lists the
agent in `OPENCLAW_LOCAL_AGENT_IDS`.

Materialization paths (`~/.ptah/agents/<id>/settings.json`,
`~/.ptah/plugins/openclaw-<id>-harness/`) appear on the **host** for
that agent, not on the leader (unless the leader is also the host).
Always qualify when naming a materialized path: *"on the host that
runs Ramses — the follower whose `OPENCLAW_LOCAL_AGENT_IDS` contains
`ramses`"*. DB on the leader; plugin tree on the host.

## The HarnessConfig schema

Verbatim from `openclaw-control/daemon/src/harness/types.ts` lines 16–62
(mirrored in `bot-bridge/src/harness/types.ts`):

```ts
interface HarnessConfig {
  version: 1;
  chatTier: HarnessTier;
  orchestrationTier: HarnessTier & {
    enabledPluginIds?: string[];
    modelTier?: 'claude_code' | 'enhanced';
  };
}
interface HarnessTier {
  skills: string[];                  // names → skills/<name>/SKILL.md
  subagents: SubagentDef[];
  mcpServers: McpServerSpec[];
  tools?: string[];                  // chatTier-only: read_channel_history, upload_attachment
  enabledPluginIds?: string[];
  modelTier?: 'claude_code' | 'enhanced';
}
interface SubagentDef {
  name: string;
  description: string;
  systemPrompt: string;              // REQUIRED — non-empty
  tools?: string[];
}
interface McpServerSpec {
  id: string;                        // /^[a-z0-9_-]+$/
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  transport?: 'stdio' | 'sse';
}
```

Anti-confusion notes — live failure modes:

- NO top-level `project:` or `description:`. Only `version`, `chatTier`,
  `orchestrationTier`. Anti-pattern (do NOT emit):

  ```yaml
  # WRONG — anti-pattern
  project: pro-estate
  description: ...
  skills:
    - name: github-ops
      tools: [mcp__gh__list_issues]
  ```

- `skills` is `string[]`, NOT objects. Names map to `skills/<name>/SKILL.md`.
- `subagents` are objects with REQUIRED `systemPrompt`. If you cannot
  write a system prompt, do not propose the subagent.
- Field names are camelCase: `mcpServers`, NOT `mcp_servers`.
  `enabledPluginIds`, NOT `enabled_plugin_ids`.
- The per-project `.claude/harness.yaml` uses the SAME schema as the
  per-agent harness. No project-specific variant.
- The `tools` field exists ONLY on `chatTier` (no-op on orchestration).
- Do NOT list `openclaw-<id>-harness` in `enabledPluginIds` — the
  materializer adds it.

## Worked example — minimal valid per-project harness

Copy-pasteable. Empty arrays are valid; only `version`, `chatTier`,
`orchestrationTier` are required.

```yaml
version: 1
chatTier:
  skills: [github-ops]
  subagents: []
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
orchestrationTier:
  skills: [github-ops]
  subagents: []
  mcpServers: []
  modelTier: claude_code
```

If a referenced skill (e.g. `github-ops`) does not exist under `skills/`,
offer to scaffold a `SKILL.md` stub before proposing — the loader
silently drops unknown skill names at materialization.

## Skill, subagent, and MCP loading

- **Skills.** Names map to `<repo-root>/skills/<name>/SKILL.md`.
  Hyphenated, lowercase, no underscores (the loader fails on
  underscores even though `parseHarnessYaml` accepts them). At chat
  time `bot-bridge/src/skills/skillLoader.ts` concatenates each body
  into the persona's system prompt; at materialization the daemon
  copies the body into `~/.ptah/plugins/openclaw-<id>-harness/skills/<name>/`
  on the host.
- **Subagents.** Each `chatTier.subagents` entry becomes two tools in
  the registry: an umbrella `delegate_to_subagent(name, prompt)` and a
  shortcut `delegate_to_<snakecased_name>(prompt)`. Both route through
  `subagentRunner.run()` (see `bot-bridge/src/tools/subagentTools.ts`)
  with the `systemPrompt` from the yaml. Subagents inherit the parent
  toolbelt unless `tools:` filters it. Keep system prompts tight: one
  paragraph of role definition, an explicit stop condition, an
  explicit out-of-scope list.
- **MCP servers.** `stdio` servers spawn as child processes per-agent
  on the bot-bridge host. Tools are namespaced
  `mcp__<server-id>__<tool-name>` (see `bot-bridge/src/tools/mcpTools.ts`).
  Failed servers stop appearing in the registry until `harness/sync`
  fires; the manager retries on backoff
  `[1000, 2000, 4000, 8000, 16000, 30000]` ms.

## chatTier.tools (TASK_2026_003 opt-in)

Two Discord-native tools, opt-in only (schemas in
`bot-bridge/src/tools/discordTools.ts`): `read_channel_history` (fetch
recent messages from a channel/DM) and `upload_attachment` (post a
file/image; path-source gated by privacy guards). Personas that do not
list these in `chatTier.tools` do not get them. Anubis opts in;
others must opt in explicitly.

## Hot-reload contract

Both tiers re-read on a single Redis event (`harness/sync`). Per-agent:
operator curl `POST /api/agents/<id>/harness/sync` after editing the
yaml (Runbook A, `docs/OPERATIONS.md §8`). Per-project: the chat-tier
`write_harness_file` emits the event after a successful project-files
POST. On the event, `reloadAgent` re-fetches from the daemon and swaps
`running.get(id).def`; the next message uses the new def. No restart.

If "I edited the harness but the persona is still using the old
subagents," check the bot-bridge build is at or past commit `fcd9061`
(closure bug — older builds captured the harness at agent boot).

## The five-tool harness-authoring flow (per-project)

> **Trigger rule (repeated).** Operator says "set up / create / author /
> configure a harness for project X" → fire `start_harness_setup(project='X')`
> FIRST. No drafting, no summarizing, no proposing before that fires.

Code: `openclaw-control/bot-bridge/src/harnessAuthor.ts`. Precondition:
project slug exists in the daemon (verify with `list_projects`). Idle
timeout 30 minutes; if it expires, re-issue `start_harness_setup`.

The five authoring tools:

1. `probe_project` — bounded dir listing, package.json digest,
   framework markers, git remote, README first 80 lines. Run first.
2. `read_file(relativePath)` — single file, 100 KB cap, no `..`, no
   leading `/`.
3. `propose_harness(yaml)` — validated through `parseHarnessYaml`
   (`harnessAuthor.ts:486`); failures are path-prefixed
   (`harness.chatTier.skills[0]: ...`) so you can fix and retry.
4. `confirm_harness` — flips stage to `awaiting-operator-confirmation`.
   The persona MUST stop generating tool calls and end its reply
   asking the operator to type "yes", "no", or "cancel harness setup".
5. `write_harness_file` — writes `<project>/.claude/harness.yaml` via
   the project-files endpoint. Only callable after "yes". Emits
   `harness/sync`.

On "no" mid-flow, drop back to step 3 with a revised proposal. Do not
fabricate tool names or skip the confirmation gate.

When the chat tier is unavailable, fall back to the operator-curl path
in `docs/PLAYBOOKS.md` Runbook C and walk them through it.

## Common authoring mistakes (anti-patterns)

Beyond the schema-confusion list above:

- Listing daemon-CRUD tools (`create_task`,
  `dispatch_orchestration_task`) in `subagents[].tools`. The yaml
  round-trips but the subagent does not get them — those are chat-tier
  registry tools, not subagent tools.
- Listing `start_harness_setup` or the harness-author tools in any
  subagent's `tools`. The harness-author registry is a *replacement*
  of the chat-tier registry, not a subset of it.
- Using underscores in skill names. The directory under `skills/` is
  hyphen-cased.
- Quoting `${GITHUB_TOKEN}` outside double quotes. YAML's `${...}` is
  not yaml syntax — it is interpolated by the daemon. Always quote.
- Putting orchestration-only fields (`enabledPluginIds`, `modelTier`)
  under `chatTier`. `parseHarnessYaml` ignores them there silently.

When proposing a harness, dry-run it mentally against the parser: every
required field present, every type correct, every name a real reference.

## Legacy rollback path

The bot-bridge retains a directive grammar of the form
`<<oc:create_task ...>>` parsed in `chat.ts`. **This grammar is the
rollback path only** — it exists so the system continues to function if
the structured tool layer regresses. The persona MUST NOT emit these
directives in visible chat replies. Default to the structured tools
listed above. Documented here for completeness; not a tool the persona
reaches for.
