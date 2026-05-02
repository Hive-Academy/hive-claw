# Spike findings — TASK_2026_002

**Probe environment:** ptah-cli 0.1.3, license tier `community` (not `pro`), node v24.15.0, host machine running fixing-openclaw daemon.
**Bundled SDK underneath:** `@anthropic-ai/claude-agent-sdk@0.2.126` (per `node_modules/@hive-academy/ptah-cli/node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
**Source artefact:** `/home/anubis/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/main.mjs` (2269 lines, bundled). Cross-verified against `node_modules/@hive-academy/ptah-cli/docs/jsonrpc-schema.md`.

---

## R1 — ptah-cli 0.1.3 `setup` CLI surface

**Status:** **DIVERGES — and it's worse than expected: setup is non-interactive AND Pro-gated.**

### What we assumed (refuted on every count)

> `ptah setup --intent "<text>"` → emits NDJSON questions → reads stdin replies → emits `setup.complete` with materials.

### What it actually is

`ptah setup` is a **non-interactive 5-phase orchestrator**. There is no `--intent` flag, no question/reply protocol, and no user-input plumbing. It boots, calls a sequence of backend RPCs end-to-end, and exits.

**CLI surface** (from `ptah setup --help`):

```
Usage: ptah setup [options]
  run the 5-phase Setup Wizard end-to-end (analyze → recommend → install_pack → generate → apply_harness)
Options:
  --dry-run       skip phases 3-5 (only run analyze + recommend; emits dry_run: true)
  --auto-approve  forward auto-approve to harness:apply config
```

**Action handler** is `Nk()` at `main.mjs` line ~2246. It calls these JSON-RPC methods sequentially via `Cl(transport, method, params)`:

1. `wizard:deep-analyze` — workspace scan (Pro-gated)
2. `wizard:recommend-agents`
3. `wizard:list-agent-packs` + `wizard:install-pack-agents`
4. `wizard:submit-selection` — fire-and-forget; awaits broadcast `setup-wizard:generation-complete` (10-min cap, hard-coded `Lk = 600 * 1e3` at line 2240)
5. `harness:apply` — writes harness materials to disk

**Live probe (community tier, dry-run):**

```bash
$ cd /tmp/ptah-spike && ptah --json setup --dry-run
{"jsonrpc":"2.0","method":"setup.phase.start","params":{"phase":"analyze"}}
{"jsonrpc":"2.0","method":"setup.phase.error","params":{"phase":"analyze","error":"Pro subscription required for this feature. Please upgrade to Pro."}}
{"jsonrpc":"2.0","method":"task.error","params":{"ptah_code":"wizard_phase_failed","data":{"phase":"analyze","error":"Pro subscription required for this feature. Please upgrade to Pro."}}}
```

**`harness analyze-intent` (the closest to "take an intent string"):**

```
Usage: ptah harness analyze-intent --intent <text>
```

Source: `XF()` at line ~2162. RPC method: `harness:analyze-intent`. Emits `harness.intent.analysis` with shape `{ intent, suggested_config }` (per `docs/jsonrpc-schema.md:139`). Live probe also hangs/times out on community tier — the backend RPC is gated.

### Stdin / stdout shape — what's possible and what isn't

`ptah` uses JSON-RPC 2.0 NDJSON throughout. Every CLI subcommand emits notifications of the form:

```json
{"jsonrpc":"2.0","method":"<event.name>","params":{...}}
```

But:

- **`setup` is one-way.** It does not read stdin. There is no `setup.user_reply`, no `wizard.user_input`, no `harness.user_input`. Verified by reading the action handler — only `await Cl(transport, ...)` calls, no `process.stdin` reads, no waiting for a response method.
- **`interact` is the only command that reads stdin RPCs.** Its dispatcher (`kk()` at line 2178) registers exactly four caller-invokable methods, no more:
  - `task.submit` — params `{task: string, cwd?: string, profile?: 'claude_code'|'enhanced'}` (validator `M$` at line 2178; profile that doesn't match the allowlist is silently coerced to `undefined`)
  - `task.cancel` — params `{turn_id: string}`
  - `session.shutdown`
  - `session.history` — params `{limit?: number}`
- Initial notification on `interact` startup: `session.ready` with `{session_id, version, capabilities:["chat","session","permission","question"], protocol_version:"2.0"}`. The `permission` and `question` capabilities are advertised but **handled internally by the chat bridge** (`Nn` at line 2178) and **approval bridge** (`fl` at line 2178) — they are not user-facing dialog hooks. They surface tool-permission prompts emitted by Claude Agent SDK, not free-form setup questions.

### Confirmed by ptah's own schema docs

`node_modules/@hive-academy/ptah-cli/docs/jsonrpc-schema.md:114`:

> "`setup.phase.start` / `setup.phase.complete` / `setup.complete` (Phase 2 / not yet implemented as discrete notifications). The `setup` orchestrator currently surfaces the underlying `analyze.*`, `wizard.generation.*`, and `harness.applied` events end-to-end. The dedicated `setup.*` cluster is reserved for a future Phase 2 enhancement."

And line 146:

> "`harness.chat.message` / `harness.chat.complete` (Phase 2 / not yet implemented as a separate cluster — `harness chat` is currently an alias for `session start --scope harness-skill` and emits `agent.*` notifications)."

So even `harness chat` does **not** offer a structured setup-dialog protocol — it's just a regular chat session with the system prompt scoped to harness-design tooling.

### The "fall back to interact" plan also doesn't fly

The original task asked: "If `ptah setup` does NOT exist as a first-class command, fall back to: can `ptah interact` be driven to perform the same role with a custom system prompt?"

Two blockers:

1. **`interact` does not let you set a system prompt.** `task.submit` accepts `{task, cwd?, profile?}` only, and `profile` is restricted to `'claude_code'|'enhanced'`. There is no `system_prompt` param.
2. **Even if you smuggle the system prompt into the `task` field**, the LLM still needs to know how to emit harness materials and tool-call signals — that is exactly the job ptah's setup-wizard backend does today, and it's the Pro-gated piece. We'd be re-implementing it from scratch.

### What we use instead

**Drop the assumption that ptah owns the harness-authoring dialog.** Architect should plan Phase 3 around bot-bridge running its own LLM-driven harness-authoring conversation, then writing `<project>/.claude/harness.yaml` directly. ptah's role shrinks to:

- `ptah harness init` (free, fast — creates `.ptah/{skills,agents,specs,presets}` scaffold; verified via live probe).
- `ptah harness apply --preset <id>` (free, fast — applies a stored preset). We can pre-populate presets and apply them, no LLM involved.
- The `ptah session start --task` path we already use for dispatch (already validated foundation).

The chat path that authors the harness lives **entirely in bot-bridge**, talking to the same kimi-k2.6:cloud endpoint that already handles persona chat. Tool-calling is already validated. The bot composes the harness YAML and pushes it through the daemon's existing memory writer.

---

## R2 — Subagent / `--profile` mechanism

**Status:** **DIVERGES — `--profile` is a system-prompt preset, not a subagent loader. There is no per-agent config-dir CLI flag. Subagents are loaded by the underlying Claude Agent SDK, not by ptah's CLI surface.**

### Hard evidence: `--profile` is strictly `claude_code|enhanced`

From `M$()` validator at `main.mjs` line 2178 (the `task.submit` param validator inside `interact`):

```js
function M$(o){
  if(!Kf(o)) throw new Error("task.submit: params required");
  let e=o.task;
  if(typeof e!="string"||e.length===0) throw new Error("task.submit: 'task' (non-empty string) required");
  let t=typeof o.cwd=="string"?o.cwd:void 0,
      r=o.profile,
      s=r==="claude_code"||r==="enhanced"?r:void 0;       // ← hard allowlist
  let n={task:e};
  return t!==void 0&&(n.cwd=t), s!==void 0&&(n.profile=s), n;
}
```

The `session start --profile` Commander flag (line ~2265 area) forwards exactly this value. The same allowlist appears in `Sl` (the shared `executeSessionStart`), which `harness chat` also routes through. **Any other value (e.g., `--profile horus-reviewer`) is silently coerced to `undefined`.**

### Live probe verification

Planted `/tmp/ptah-spike/.claude/agents/test-reviewer.md` with frontmatter `name: test-reviewer` and a body instructing the model to reply with the literal `PROBE-OK`. Then ran:

```bash
$ ptah --json session start --profile test-reviewer --task "echo PROBE-OK"
{"jsonrpc":"2.0","method":"session.created","params":{"session_id":"…","tab_id":"…"}}
{"jsonrpc":"2.0","method":"agent.message","params":{"text":"I won't run that — there's no user request here, just system context. If you want me to run `echo PROBE-OK`, please confirm."}}
```

The session ran fine but **the model did not adopt the test-reviewer persona** — it returned a generic-assistant refusal instead of `PROBE-OK`. This proves `--profile test-reviewer` was silently dropped at the CLI boundary.

### What "profile" actually does in ptah

Per `docs/jsonrpc-schema.md:51`: `session.created` has shape `{ session_id, profile?, cwd, created_at }` and `session.list` entries have `profile?` — these are the same `claude_code|enhanced` values. Inside the backend (resolved in the bundled `ln` class at line ~573), profile maps to a `systemPromptMode` (`mode` + `content`) that determines whether to use Claude Code's stock system prompt or an enhanced variant. **It is not a subagent reference.**

### Where subagents actually live (and how to load them)

The Claude Agent SDK (which ptah spawns under the hood) supports subagents three ways, per the bundled `sdk.d.ts`:

1. **Programmatic** — `agents?: Record<string, AgentDefinition>` option to the SDK options object (sdk.d.ts:1183). ptah does not expose this through the CLI.
2. **Settings-based** — "The agent must be defined either in the `agents` option or in settings." (sdk.d.ts:1152). The settings file is `~/.ptah/settings.json` (resolved by class `Gn` constructor: `this.dirPath = join(homedir(), ".ptah")` — see imports at the top of main.mjs).
3. **Plugin-based** — "Plugins provide custom commands, agents, ..." (sdk.d.ts:1492). Plugins live at `~/.ptah/plugins/<plugin-id>/` with manifest `.claude-plugin/plugin.json` and (per Claude Plugin spec) `agents/*.md` subdirectory. Verified format by inspecting `~/.ptah/plugins/ptah-core/.claude-plugin/plugin.json` — currently installed plugins ship `skills/` and `commands/` only, no `agents/` directory yet.

ptah's Commander surface exposes `ptah agent apply <name>` which writes templates into `<workspace>/.ptah/agents/<name>.md`, but per `harness scan` output, **`harness.available_agents` only enumerates the four canonical CLI runners** (`gemini`, `codex`, `copilot`, `ptah-cli`) — it does not pick up workspace-local subagent .md files. The `ptah agent` namespace is for storing/applying agent prompt templates, not for spawning per-session subagents inside a Claude session.

### `harness chat --profile <name>` — same trap

From the `harness chat` action handler (`QF`, line ~2162):

```js
function QF(o, e, t = {}) {
  return (t.executeSessionStart ?? Sl)(
    { task: o.task, profile: o.profile, scope: "harness-skill", resumeId: o.session, cwd: e.cwd },
    e
  );
}
```

`Sl` is the same `executeSessionStart` that runs the `claude_code|enhanced` allowlist check. Custom `--profile` values silently die there too. The `--scope harness-skill` flag is forwarded to `chat:start`'s backend params and toggles the harness-design system-prompt + tool surface — it is not a subagent loader either.

### What we use instead

The harness composition lives in the **per-agent ptah `settings.json` plus a per-agent plugin directory** that we author and bind-mount. Specifically:

- **One settings.json per persona** at `~/.ptah/agents/<id>/settings.json`. Pass it to ptah as `--config /home/anubis/.ptah/agents/<id>/settings.json` per spawn (the existing `--config <path>` flag, line 540 area, is what ptah honours — verified by `ptah --help`).
- **Subagents go in the persona's plugin dir.** Build `~/.ptah/agents/<id>/plugins/<id>-harness/` with `.claude-plugin/plugin.json` + `agents/*.md` (frontmatter: `name`, `description`, `tools`). Reference the plugin id from the persona's `settings.json` via `enabledPluginIds` (the field name `ln.resolvePluginPaths(enabledPluginIds)` consumes — line 573).
- **For synchronous subagent invocation from chat**, the bot uses Claude Agent SDK's Task/Agent tool-call (the model emits `Agent` tool calls naturally when subagents are loaded). No CLI flag needed.

This is a substantively different shape from "drop a file in `~/.ptah/agents/<id>/subagents/`" — that path doesn't exist as a recognised location anywhere in the binary.

---

## PTAH_CONFIG_DIR

**Status:** **Not implemented.** `grep -n "PTAH_CONFIG_DIR" main.mjs` returns zero matches. There is no env-var-based config-dir override.

What does exist:

- `PTAH_INTERACT_ACTIVE` — set internally by `interact` to the value `"1"` (line 2178); unrelated.
- `--config <path>` — top-level CLI flag (visible in `ptah --help`). Value lands at `e.config` in the global opts dispatcher `D()` (line 2265). Per the help text, it "override[s] config file path (default ~/.ptah/settings.json)". This is a **single-file** override (the settings file), **not a directory** override.
- The settings manager class `Gn` hard-codes `this.dirPath = join(homedir(), ".ptah")` in its constructor, and the plugin loader resolves plugins relative to that dirPath. Without an env var or directory flag, ptah always reads plugins from `~/.ptah/plugins/`.

**Implication:** to scope a ptah run to a per-agent harness, we cannot just set `PTAH_CONFIG_DIR=~/.ptah/agents/<id>/`. We must either:

(a) **Bind-mount or symlink-swap** `~/.ptah/plugins/` per agent before spawning ptah (clumsy, container-coupled), or
(b) **Use `--config <per-agent-settings.json>`** to point at a settings file whose `enabledPluginIds` references plugins **already installed under the host's `~/.ptah/plugins/`**. The plugin dir itself is global; the *selection* of plugins is per-config-file. Each persona's settings.json picks its own plugin set.

Option (b) is cleaner and survives multi-machine. Architect should default to it.

---

## Plan adjustments needed

### Phase 3 (Setup-session subsystem) — substantially rewritten

- **Drop the assumption that bot-bridge spawns `ptah setup` as a subprocess.** It either fails (Pro-gated) or runs end-to-end without any user dialog (--dry-run path).
- **Replace with: bot-bridge runs its own harness-authoring chat loop** using the same kimi-k2.6:cloud endpoint already validated for persona chat. The model uses tool calls (already validated via the smoke test recorded in `context.md`) to:
  1. Probe the project (read package.json, dir tree, optionally call `ptah harness scan` for the available_skills / available_agents surface — that RPC is **free and fast**, verified live).
  2. Propose a harness (skills, subagents, MCP servers).
  3. After operator approval, call `start_harness_apply` tool which writes `<project>/.claude/harness.yaml` and runs `ptah harness apply --preset <id>` if a preset already exists, or writes the preset first via `ptah harness preset save --from <path>` then applies.
- **Discord-thread bridging** is unchanged — the chat loop runs inside the persona's existing chat path. No subprocess to bridge to.
- **Drop the 10-min timeout fence** — it was for `wizard:submit-selection`'s broadcast response. Not needed in the new shape.
- **Concurrency note:** since this is just another tool-calling chat round inside the persona, no new locking surface is introduced. The persona was already tool-calling (Phase 1).

### Phase 4 (Subagent tools / synchronous chat path) — refactored

- **Per-agent harness composition** uses `~/.ptah/agents/<id>/settings.json` + persona-specific plugins under `~/.ptah/plugins/`, **invoked via `ptah --config <per-agent-settings.json> session start --task "..."`**. Drop the assumption of a per-agent config dir.
- **Subagent definitions** are written into a per-persona plugin directory `~/.ptah/plugins/openclaw-<id>-harness/agents/*.md` with Claude-plugin manifest. The `~/.ptah/agents/<id>/settings.json` references it by id in `enabledPluginIds`. Materialization step: bot-bridge writes both files; daemon doesn't need to know about plugins.
- **Synchronous subagent invocation** from chat: the bot's tool surface includes a `delegate_to_subagent` tool. When called, bot-bridge spawns a fresh ptah session with the persona's settings.json, passes the subagent name + sub-prompt as part of the `task` text (e.g., `"Use the <subagent-name> subagent to: ..."`), and the SDK auto-routes via the Task tool because the subagent is registered in `agents` option (resolved from the plugin manifest). Returns the subagent's final reply to the chat.
- **MCP servers** scope the same way — they live in `~/.ptah/agents/<id>/settings.json` under the `mcpServers` key (or are pulled in by a plugin). Per-agent isolation works through the settings file, not a config dir.

### Phase 5 (Persona docs / harness authoring) — minor adjustment

- The "initial harness authoring" deliverable now produces three files per persona:
  - `~/.ptah/agents/<id>/settings.json` (auth, mcp, model tier, enabledPluginIds)
  - `~/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json`
  - `~/.ptah/plugins/openclaw-<id>-harness/agents/*.md` (subagent defs)
- The persona privacy invariant from `CLAUDE.md` is unchanged: `persona.md` and `secrets.md` still go to local-memory; this Phase only touches `~/.ptah/agents/<id>/` and `~/.ptah/plugins/<id>-harness/` which are configuration, not persona memory. Architect should still spell out which file lives in which storage tier.

### Risk register update

- **R1 status:** answered — `setup` is non-interactive AND Pro-gated. Open mitigation: bot-bridge owns harness-authoring chat (community-tier-compatible).
- **R2 status:** answered — no per-agent config dir; subagent loading goes through plugin manifests + settings.json. Open mitigation: write a `<id>-harness` plugin per persona at materialization time.
- **New R3 (license tier):** the host's ptah license is `community` (`{tier:"community",isPremium:false}` per `ptah --json license status`). Several wizard backends (`wizard:deep-analyze`, likely `harness:analyze-intent`, `wizard:recommend-agents`) emit `Pro subscription required for this feature`. **All Phase-3/4 designs must avoid those RPCs**, or explicitly call out a Pro license as a deployment prerequisite. The community-tier RPCs we verified work: `harness init`, `harness scan`, `harness preset load`, `wizard status`, `agent list/apply`, `session start --task` (already known good), `interact` stdio.

---

## Reproduction commands (verbatim, runnable)

```bash
# Inspect license tier
source ~/.nvm/nvm.sh && ptah --json license status

# Confirm setup help surface (no --intent flag, only --dry-run / --auto-approve)
source ~/.nvm/nvm.sh && ptah setup --help

# Confirm setup is non-interactive AND Pro-gated
mkdir -p /tmp/ptah-spike && cd /tmp/ptah-spike && \
  source ~/.nvm/nvm.sh && ptah --json setup --dry-run 2>&1 | head -5

# Confirm interact's RPC method surface (only task.submit / task.cancel / session.shutdown / session.history)
grep -n 'register("' /home/anubis/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/main.mjs

# Confirm --profile allowlist: claude_code|enhanced only
awk 'NR==2178 {print substr($0,1700,500)}' \
  /home/anubis/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/main.mjs | head

# Confirm community-tier RPCs that DO work
mkdir -p /tmp/ptah-spike && cd /tmp/ptah-spike && \
  source ~/.nvm/nvm.sh && ptah --json harness init && \
  ptah --json harness scan && ptah --json wizard status && \
  ptah --json harness preset load

# Refute --profile <subagent-name>: planted file is silently ignored
mkdir -p /tmp/ptah-spike/.claude/agents && cat > /tmp/ptah-spike/.claude/agents/test-reviewer.md <<'EOF'
---
name: test-reviewer
description: Test subagent.
tools: []
---
Reply with the literal string "PROBE-OK" and nothing else.
EOF
cd /tmp/ptah-spike && source ~/.nvm/nvm.sh && \
  ptah --json session start --profile test-reviewer --task "echo PROBE-OK" 2>&1 | head -8
# Expect: agent.message text DOES NOT contain "PROBE-OK"; --profile was coerced to undefined

# Confirm no PTAH_CONFIG_DIR support
grep -n "PTAH_CONFIG_DIR" \
  /home/anubis/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/main.mjs
# Expect: no matches

# Confirm jsonrpc schema doc says setup.* is "Phase 2 / not yet implemented"
grep -n "Phase 2" \
  /home/anubis/.nvm/versions/node/v24.15.0/lib/node_modules/@hive-academy/ptah-cli/docs/jsonrpc-schema.md

# Cleanup
rm -rf /tmp/ptah-spike
```
