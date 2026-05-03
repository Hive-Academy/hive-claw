# Playbooks — operator runbooks for the openclaw-control control plane

Three end-to-end runbooks for the operator workflows that the platform supports but does not document elsewhere. Every step is exact: real commands, real expected output, real log lines to grep for. No estimates.

The runbooks assume:

- A working leader/follower fleet per [SETUP.md](SETUP.md).
- The reader has read [OPENCLAW_CONTROL.md](OPENCLAW_CONTROL.md) and understands the leader-only DB and the persona privacy invariant.
- All commands run from the repo root (`~/Desktop/fixing-openclaw`) unless stated.
- `./scripts/dc.sh` is the docker wrapper that bypasses gpg `credsStore`. Use it instead of raw `docker compose`.

---

## Operator-truth — six things you need to know first

These are non-obvious facts every runbook below depends on. Skim them once.

### 1. `local-memory/` (repo path) is NOT the runtime path

| Path | Role | Synced? |
|---|---|---|
| `local-memory/agents/<id>/` (under the repo) | git source-of-truth for fixtures, gitignored | committed nowhere; the directory exists on every checkout |
| `~/.claude/local-memory/agents/<id>/` | runtime path; bind-mounted into the container at `/home/agent/.claude/local-memory/` | never — the privacy invariant forbids it |

After editing a persona in the repo, copy it to the runtime path on the host:

```bash
cp local-memory/agents/<id>/persona.md ~/.claude/local-memory/agents/<id>/persona.md
```

The bot-bridge re-reads `persona.md` on every Discord message — no restart. But it only reads from the runtime path.

### 2. Repo `shared-specs/memory/agents/<id>/*` files are templates; the leader's DB is the live store

`shared-specs/memory/agents/<id>/{identity.md,harness.yaml}` are **canonical templates** in git. They are not served from disk — the bot-bridge fetches them via `GET /api/memories/agents/<id>/<file>` from the leader's daemon, which reads from `/data/specs.db`'s `memory_files` table.

After committing a new identity or harness, you MUST PUT the file into the leader's DB. The PUT is JSON-encoded:

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
BODY=$(jq -Rs '{content:.}' < shared-specs/memory/agents/<id>/harness.yaml)
curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  http://127.0.0.1:7878/api/memories/agents/<id>/harness.yaml
# => {"ok":true,"private":false}
```

Followers do not PUT — their daemon runs in HTTP-client mode and forwards to the leader.

### 3. Two harness layers — different file, different consumer

| Layer | Path | Loaded by | When |
|---|---|---|---|
| Per-agent harness | `shared-specs/memory/agents/<id>/harness.yaml` (live in leader DB) | bot-bridge `agentRegistry.loadAgents()` | bot-bridge boot + every `harness/sync` event (hot-reload) |
| Per-project harness | `<project>/.claude/harness.yaml` (in the project repo) | `daemon/src/harness/ptahLauncher.ts` at dispatch time | every dispatch worker invocation against that project |

The per-agent harness defines what an agent **is** (skills, subagents, MCP, opt-in chat tools). The per-project harness layers on what the agent **does inside this project**. The per-project harness is NOT served via the daemon's memory API; it travels with the project repo.

### 4. Agents are bound to machines via `OPENCLAW_LOCAL_AGENT_IDS`

A "Horus machine" is a follower whose `.env` has `OPENCLAW_LOCAL_AGENT_IDS=horus`. That machine hosts the Horus Discord client, the Horus persona file, the Horus MCP child processes. The leader holds the DB. Both run the same daemon binary; only `OPENCLAW_LEADER` distinguishes them.

`OPENCLAW_LOCAL_AGENT_IDS` must be **disjoint** across machines (every agent owned by exactly one host). If two machines list the same id, the loser of every dispatch claim race wastes HTTP calls — safe but pointless.

### 5. `OPENCLAW_INTERNAL_TOKEN` must match across the fleet

Every follower→leader call carries `Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}`. Mismatched tokens show up as 401s in the leader's daemon log:

```
docker compose logs openclaw 2>&1 | grep -E '401|Unauthorized'
```

After regenerating the token on the leader, paste the new value into every follower's `.env` and restart.

### 6. `<<oc:>>` directives are legacy; structured tool calls are the path forward

With `OPENCLAW_BOT_TOOL_CALLS_ENABLED=1`, the chat tier uses the OpenAI-compatible tool-calling API: `create_task`, `approve_task`, `dispatch_orchestration_task`, etc. The model emits structured `tool_calls`, not `<<oc:create_task ...>>` text directives.

The directive grammar still works — it is byte-equivalent to the pre-B2 path and is the rollback target (set `OPENCLAW_BOT_TOOL_CALLS_ENABLED=0` and restart). You can still type a directive by hand into Discord; the parser strips it from the model reply tail. Use whichever the operator prefers.

---

## Runbook A — register a new agent on a new machine

End-to-end flow for adding a new agent (call her `morrigan`, a hypothetical product-management persona) on a follower machine. Prerequisite: the machine already runs `openclaw-control` per [SETUP.md](SETUP.md).

### A.1. On the leader machine — draft identity + harness

```bash
mkdir -p shared-specs/memory/agents/morrigan
```

Write `shared-specs/memory/agents/morrigan/identity.md`:

```markdown
---
name: Morrigan
persona: product-manager
---

# Morrigan

Product-management persona. Owns task scoping, requirements distillation,
acceptance-criteria authoring, and stakeholder Q&A. Hands off implementation
to anubis (infra) or horus (security review).

Reach Morrigan by mentioning `@morrigan` in Discord, or assign a task to
`agent_id="morrigan"` via the dashboard.
```

Write `shared-specs/memory/agents/morrigan/harness.yaml`:

```yaml
version: 1

chatTier:
  skills:
    - openclaw-onboarding
    - agent-fleet-overview
  subagents:
    - name: requirements-distiller
      description: Compresses a long stakeholder thread into acceptance criteria.
      systemPrompt: |
        You are requirements-distiller. The operator has pasted a thread or
        meeting transcript. Produce: (1) the user-facing outcome in one
        sentence, (2) three to five testable acceptance criteria as bullets,
        (3) the explicit out-of-scope list. No preamble, no severity rating.
      tools: []
  mcpServers: []
  tools:
    - read_channel_history

orchestrationTier:
  skills:
    - openclaw-onboarding
  subagents:
    - name: spec-writer
      description: Drafts a task-description from CONTEXT phase artifacts.
      systemPrompt: |
        You are spec-writer. Read context.md and produce task-description.md
        per the project's conventions. Cite file_path:line_number for every
        existing-code reference. Do not propose implementation.
      tools:
        - Read
        - Grep
  mcpServers: []
  enabledPluginIds: []
  modelTier: claude_code
```

Field reference (mandatory vs optional):

| Field | Required? | Note |
|---|---|---|
| `version: 1` | mandatory | only legal value |
| `chatTier`, `orchestrationTier` | mandatory | both must be present even when empty |
| `chatTier.skills`, `chatTier.subagents`, `chatTier.mcpServers` | required (may be `[]`) | parser defaults missing keys to `[]` |
| `chatTier.tools` | optional | TASK_2026_003 opt-in. Names must be in the registered set: `read_channel_history`, `upload_attachment` |
| `orchestrationTier.enabledPluginIds`, `modelTier` | optional | `modelTier` is `claude_code` (default) or `enhanced` |
| `subagent.tools` | optional | subset filter; subagents inherit parent tools when omitted |
| `mcpServer.transport` | optional | `stdio` (default) or `sse` |
| `mcpServer.timeoutMs` | optional | default 30000 |

Skill names must reference real files at `skills/<name>/SKILL.md`. The harness above uses `openclaw-onboarding` and `agent-fleet-overview`, which exist. If you reference a skill that does not exist, the bot-bridge logs a warning and the tool registry simply does not include it — scaffold the stub before commit:

```bash
ls skills/openclaw-onboarding/SKILL.md skills/agent-fleet-overview/SKILL.md
```

### A.2. Commit and push

```bash
git add shared-specs/memory/agents/morrigan/
git commit -m "feat(agents): register morrigan persona"
git push
```

### A.3. PUT the shared files into the leader's DB

The leader's daemon serves memories from `/data/specs.db`, not from the filesystem. The bot-bridge will not see the new persona until you PUT it.

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)

BODY=$(jq -Rs '{content:.}' < shared-specs/memory/agents/morrigan/identity.md)
curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  http://127.0.0.1:7878/api/memories/agents/morrigan/identity.md
# => {"ok":true,"private":false}

BODY=$(jq -Rs '{content:.}' < shared-specs/memory/agents/morrigan/harness.yaml)
curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  http://127.0.0.1:7878/api/memories/agents/morrigan/harness.yaml
# => {"ok":true,"private":false}
```

`"private":false` is the expected response for `identity.md` and `harness.yaml` — both are public. A `403` on either of these means the path is being misrouted; double-check the URL.

### A.4. On the follower machine — pull and check env

```bash
cd ~/Desktop/fixing-openclaw
git pull --ff-only
grep -E '^OPENCLAW_(LEADER|LEADER_URL|LOCAL_AGENT_IDS|INTERNAL_TOKEN)=' .env
```

Required values on the follower:

```
OPENCLAW_LEADER=0
OPENCLAW_LEADER_URL=http://leader.lan:7878    # or https://leader.tailnet.ts.net
OPENCLAW_LOCAL_AGENT_IDS=morrigan             # add the new id (CSV if multiple)
OPENCLAW_INTERNAL_TOKEN=<must match leader's value byte-for-byte>
```

Add the bot token (from the Discord Developer Portal, per [SETUP.md](SETUP.md) §Step 3):

```bash
echo 'DISCORD_TOKEN_MORRIGAN=...the-token-you-copied...' >> .env
```

### A.5. On the follower — author the persona (private, never synced)

```bash
mkdir -p ~/.claude/local-memory/agents/morrigan
```

Write `~/.claude/local-memory/agents/morrigan/persona.md`:

```markdown
# Persona for morrigan

## Name
morrigan

## Role
Product-management persona for the fleet. Owns scoping, acceptance
criteria, stakeholder distillation. Defers implementation.

## Voice
Plain. Refuses to ship vague requirements. Always names a single user
outcome and three-to-five testable criteria.

## Do
- Cite the operator's exact words when extracting acceptance criteria
- Hand off to anubis or horus when the request crosses into infra or security

## Don't
- Don't write implementation plans
- Don't approve task phases on your own work
```

Privacy invariant: this file is never committed, never written to the leader's DB, never sent over HTTP. The local FS is the only copy. If you also keep an editable draft at `local-memory/agents/morrigan/persona.md` in the repo (the directory is gitignored), copy it into place:

```bash
cp local-memory/agents/morrigan/persona.md ~/.claude/local-memory/agents/morrigan/persona.md
```

### A.6. On the follower — rebuild + restart

```bash
./scripts/dc.sh compose build openclaw
./scripts/dc.sh compose up -d
```

### A.7. On the leader — trigger materialization

The leader writes the per-agent ptah config tree (`~/.ptah/agents/morrigan/settings.json` and `~/.ptah/plugins/openclaw-morrigan-harness/`) on every `harness/sync`:

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7878/api/agents/morrigan/harness/sync
# => {"ok":true,"agentId":"morrigan","harnessHash":"<sha256>"}
```

The same call publishes a Redis `harness/sync` event that the follower's bot-bridge consumes — `agentRegistry.reloadAgent()` re-fetches identity, persona, discord.json, and harness.yaml.

### A.8. Verify

On the follower, watch the bot-bridge log:

```bash
./scripts/dc.sh compose exec openclaw tail -f /tmp/openclaw-control-bot.log
```

Expected lines:

```
[bot-bridge] morrigan ready as Morrigan#NNNN
[bot-bridge] hot-reloaded harness for "morrigan"
```

On the leader, the agent list:

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7878/api/agents | jq '.[] | select(.id=="morrigan")'
```

Expected: an object with `"id":"morrigan"`, `"name":"Morrigan"`, and a `"status"` of `"online"`.

### A.9. Smoke test in Discord

In any guild Morrigan was invited to:

```
@morrigan hello
```

The reply should be in-persona within ~10 seconds (cloud-model latency). The bot-bridge log records the request:

```bash
./scripts/dc.sh compose exec openclaw grep 'morrigan.*messageCreate\|morrigan.*tool' /tmp/openclaw-control-bot.log | tail -5
```

### A.10. Failure modes

| Symptom | Log signature | Fix |
|---|---|---|
| Persona missing on the follower | `[bot-bridge] no runnable agents found` or `[bot-bridge] agent "morrigan" has no local persona — skipping` | Create `~/.claude/local-memory/agents/morrigan/persona.md`; restart the container |
| Token mismatch | Leader log: repeated 401s on `/api/dispatches/pending?agentIds=morrigan` and `/api/memories/agents/morrigan/...` | Copy the leader's `OPENCLAW_INTERNAL_TOKEN` into every follower's `.env`; restart |
| Discord token wrong | `[bot-bridge] morrigan error <DiscordjsError [TokenInvalid]>` | Reset token in Discord Developer Portal; update `DISCORD_TOKEN_MORRIGAN` in `.env`; restart |
| Harness yaml invalid | `[bot-bridge] agent "morrigan" harness.yaml is invalid: <reason>` | The persona stays online with no harness (chat falls through to legacy path). Fix the yaml, PUT again, sync |
| Materialization can't find host home | Daemon log on dispatch attempt: bridge `/invoke` returns `ptahConfigDirExists: false` | Set `OPENCLAW_HOST_HOME=$HOME` (or the right host path) in `.env` on the leader; restart |

### A.11. Rollback

To neutralize the new persona without removing it:

```bash
sed -i 's|^OPENCLAW_BOT_TOOL_CALLS_ENABLED=.*|OPENCLAW_BOT_TOOL_CALLS_ENABLED=0|' .env
./scripts/dc.sh compose restart openclaw
```

The bot-bridge falls through to the legacy chat path. Morrigan still answers, but without harness tools (no MCP, no subagents, no Discord-native tools). To remove the persona entirely, delete `~/.claude/local-memory/agents/morrigan/` and restart — the bot-bridge skips it on the next boot.

---

## Runbook B — add a new skill or MCP server to an existing agent

The narrow, high-frequency case. No machine moves, no rebuild required, no restart.

### B.1. Author or edit the skill body

Skill names are hyphenated lowercase and match the directory name:

```bash
mkdir -p skills/release-notes-author
$EDITOR skills/release-notes-author/SKILL.md
```

Minimum content:

```markdown
---
description: Drafts a release note from the dispatch_log of a completed task.
---

# release-notes-author

When a task transitions to DONE, summarize the user-facing changes in 80 words.

## When to use
- The operator asks for release notes for TASK_<id>
- The operator drops a dispatch_log tail and asks "what shipped?"

## Instructions
Read context.md and the dispatch_log audit trail. Produce three bullets:
the user-visible change, the affected component, and any operator action
needed.
```

### B.2. Edit the agent's `harness.yaml`

```bash
$EDITOR shared-specs/memory/agents/anubis/harness.yaml
```

Add the skill to `chatTier.skills`. The same flow works for `orchestrationTier.skills` if it should also fold into dispatched runs:

```yaml
chatTier:
  skills:
    - openclaw-onboarding
    - harness-authoring-guide
    - agent-fleet-overview
    - release-notes-author       # added
```

The same edit pattern applies for:

| Capability | Where it goes |
|---|---|
| New skill | `chatTier.skills` and/or `orchestrationTier.skills` |
| New MCP server | `chatTier.mcpServers` and/or `orchestrationTier.mcpServers` |
| New subagent | `chatTier.subagents` and/or `orchestrationTier.subagents` |
| Discord-native tool (TASK_2026_003) | `chatTier.tools: [read_channel_history, upload_attachment]` (chat tier only — orchestration tier ignores `tools`) |

### B.3. Commit and push

```bash
git add skills/release-notes-author/SKILL.md shared-specs/memory/agents/anubis/harness.yaml
git commit -m "feat(anubis): add release-notes-author skill"
git push
```

### B.4. PUT the updated harness into the leader's DB

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
BODY=$(jq -Rs '{content:.}' < shared-specs/memory/agents/anubis/harness.yaml)
curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  http://127.0.0.1:7878/api/memories/agents/anubis/harness.yaml
# => {"ok":true,"private":false}
```

### B.5. Trigger hot-reload

```bash
TOKEN=$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7878/api/agents/anubis/harness/sync
# => {"ok":true,"agentId":"anubis","harnessHash":"<sha256>"}
```

Verify the bot-bridge picked up the change:

```bash
./scripts/dc.sh compose exec openclaw grep 'hot-reloaded harness for "anubis"\|harnessVersion=' /tmp/openclaw-control-bot.log | tail -5
```

The next Discord message exercises the new skill — no restart needed.

### B.6. Followers hosting the same agent

If anubis is owned by the leader, you are done. If a different host owns the agent (e.g. a follower whose `OPENCLAW_LOCAL_AGENT_IDS` includes the agent), that follower needs the new skill body **on disk** because the bot-bridge reads `skills/<name>/SKILL.md` from the bind-mounted repo path:

```bash
# On the follower:
cd ~/Desktop/fixing-openclaw
git pull --ff-only
ls skills/release-notes-author/SKILL.md   # must exist
```

The same `harness/sync` POST on the leader publishes Redis `harness/sync` to that follower's bot-bridge — it reloads the harness from the leader's HTTP API and re-reads skill bodies from its own disk. No follower restart needed once the repo is pulled.

---

## Runbook C — drive Anubis to author a per-project harness

The harness-authoring chat (TASK_2026_002 B7). The operator wants to give a project its own `.claude/harness.yaml` so dispatches against that project pick up project-specific skills, subagents, and MCP servers.

### C.0. Before you start — distinguish the two harnesses

This runbook authors the **per-project** harness at `<project>/.claude/harness.yaml`, NOT the per-agent harness at `shared-specs/memory/agents/<id>/harness.yaml`. The two are layered: the per-agent harness is what the agent IS (loaded by bot-bridge at startup), the per-project harness is what the agent does INSIDE that project (loaded by `daemon/src/harness/ptahLauncher.ts` when a dispatch fires for a task on that project).

For the per-agent path, see Runbook B.

### C.1. Mention Anubis in a Discord channel that can write to the project

Anubis must be an agent whose harness includes the `harness-authoring-guide` skill — `shared-specs/memory/agents/anubis/harness.yaml` already does, both in `chatTier.skills` and `orchestrationTier.skills`.

The channel must be one Anubis is allowed to operate from (no `channelAllowList` set, or this channel id is on the list — see `discord.json#channelAllowList` for the agent).

Phrases that trigger harness-authoring mode:

- `@anubis set up a harness for project pro-estate`
- `@anubis author a .claude/harness.yaml for project pro-estate`
- `@anubis configure the harness for pro-estate`

The trigger is the model recognizing the `harness-authoring-guide` skill instructions and calling `start_harness_setup`. There is no magic regex.

### C.2. Anubis fires `start_harness_setup`

The tool flips `ctx.state.harnessSetup = { project, stage: 'probing', startedAt: Date.now() }`. From this point the channel is in harness-authoring state for this `<agent>:<channel>` pair. The 30-minute idle timer (`OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS`, default 1800000 ms) starts.

Anubis posts an entry-mode message acknowledging the project and listing the next moves.

### C.3. Anubis fires `probe_project` and `read_file`

`probe_project` runs a bounded ls + framework-marker scan on the project root (200-entry cap). `read_file` reads project-relative files (100 KB cap, rejects `..` and absolute paths). Both go through the daemon's project-files API. Anubis summarizes what it finds: framework, build tooling, conventions, anything that should drive harness composition.

### C.4. Multi-turn dialog

Anubis asks what the project needs: which skills (from `skills/*`), which MCP servers, which subagents. The operator answers in plain Discord messages. Anubis can iterate — re-probe a directory, ask about a specific file, propose, retract.

### C.5. Anubis fires `propose_harness`

Anubis drafts the YAML and posts it inline in chat. The tool runs `parseHarnessYaml` to validate the shape; on parse failure the tool returns `propose_harness rejected — fix the yaml and retry: <reason>` and Anubis re-drafts. On success the proposal is stored on `ctx.state.harnessSetup.proposed`.

The operator reads the proposal, pushes back, asks for changes. Anubis re-proposes — `propose_harness` is idempotent over the staged proposal slot.

### C.6. Operator confirms; Anubis fires `confirm_harness`

`confirm_harness` flips the stage to `awaiting-operator-confirmation`. Anubis posts the proposal one more time and asks "does this look right? say yes to write it."

### C.7. Operator types "yes"; chat.ts flips stage to `writing`

The chat layer (`bot-bridge/src/chat.ts`) recognizes the operator's plain-text "yes" (case-insensitive) and flips `ctx.state.harnessSetup.stage` to `writing`. On the next turn, Anubis fires `write_harness_file`.

`write_harness_file` is the only step that touches disk. It is gated on `stage === 'writing'`; calling it earlier returns an error and refuses to write. It POSTs to the daemon's project-files endpoint with `<project>/.claude/harness.yaml` as the path. The write guard refuses any path outside `.claude/` for harness authoring; attempts to write `package.json` or `src/whatever.ts` are 400'd at the daemon layer.

### C.8. Verify

The harness file lives in the project workspace at `<project>/.claude/harness.yaml`. Confirm via the host:

```bash
ls -l ~/projects/pro-estate/.claude/harness.yaml
cat  ~/projects/pro-estate/.claude/harness.yaml
```

Or via Discord by asking Anubis to `read_file .claude/harness.yaml` against the same project.

### C.9. Next dispatch picks it up

The per-project harness applies on the next dispatch worker invocation for a task on that project. `daemon/src/harness/ptahLauncher.ts` reads `<project>/.claude/harness.yaml` (when present) and layers it on top of the per-agent harness when materializing the ptah subprocess config. No restart, no further action.

### C.10. Failure modes

| Symptom | Cause | Resolution |
|---|---|---|
| Anubis goes silent after `start_harness_setup` | Operator stayed idle past `OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS` (default 30 min) — the next message clears state and posts a friendly cancel | Restart from §C.1 |
| `write_harness_file error: stage is "probing", not "writing"` | Anubis tried to write before the operator confirmed | Operator types "yes"; chat.ts flips stage; Anubis re-fires `write_harness_file` |
| `write_harness_file error: path outside .claude/` | The proposal targeted a path other than `.claude/harness.yaml` | The harness-authoring tools only write under `.claude/`. Re-propose with the correct path |
| Daemon returns 403 on the POST files call | The channel/operator is not allowed to write to that project | Anubis surfaces the error and stops. Check the project's allowlist and the operator's Discord user id |
| `propose_harness rejected — fix the yaml and retry: <reason>` | The drafted YAML failed `parseHarnessYaml` | Anubis re-drafts; the operator can paste a corrected snippet |
| Operator types "cancel harness setup" (case-insensitive) | Manual abort | State cleared; chat returns to normal |

---

## Cross-references

- Per-agent harness format and the chat-tier vs orchestration-tier split: [SKILLS-AND-PERSONA.md](SKILLS-AND-PERSONA.md#two-tiers-one-persona--chat-tier-vs-orchestration-tier).
- Materialization output paths and the host-home bind mount: [ARCHITECTURE.md](ARCHITECTURE.md#per-persona-claude-plugin-layout).
- Privacy invariant and the six enforcement layers: [SECURITY.md](SECURITY.md).
- Daily SQL and rollback: [OPERATIONS.md](OPERATIONS.md) §1, §7, §8, §9.
- New-machine bootstrap: [SETUP.md](SETUP.md).
- Symptom-to-fix table: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
