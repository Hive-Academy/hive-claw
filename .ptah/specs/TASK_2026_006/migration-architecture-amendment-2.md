# TASK_2026_006 — Migration Architecture Amendment 2

**Date:** 2026-05-13
**Status:** APPLIED (commit: see `fix(deploy): TASK_2026_006 follow-up — persona materialization into agent workspace`)
**Trigger:** Post-cutover regression — Anubis came online but had no identity
(greeted the operator as a blank-slate "I literally just came online — fresh
workspace, no memory, no name, nothing"). Discovered while validating Batch 10
acceptance on the leader machine.

## The gap

The migration architecture (and `migration-architecture.md` + amendment 1)
described how openclaw's per-agent tool policy, Discord adapter, and plugin
loading would replace the bot-bridge chat tier. It did **not** specify how
each agent's persona content would reach openclaw's system prompt.

In the old bot-bridge world, persona content was loaded by `agentRegistry.ts`
from `local-memory/agents/<id>/persona.md` and pasted into the LLM call as
the system prompt. After cutover, bot-bridge no longer runs that code — and
openclaw has no built-in knowledge of `persona.md`.

openclaw's actual mechanism (discovered by grepping the bundled runtime in
`/usr/lib/node_modules/openclaw/dist/system-prompt-*.js`) is a **workspace
context-file loader** with this fixed priority order:

| Priority | File |
|---:|---|
| 10 | `agents.md` |
| 20 | `soul.md` |
| 30 | `identity.md` |
| 40 | `user.md` |
| 50 | `tools.md` |
| 60 | `bootstrap.md` |
| 70 | `memory.md` |

Each agent's workspace (`/home/agent/.openclaw/workspace/<id>/`) is
auto-seeded by openclaw at first boot with stock template files — the stock
`IDENTITY.md` is literally:

```
# IDENTITY.md - Who Am I?
_Fill this in during your first conversation. Make it yours._
- **Name:** _(pick something you like)_
...
```

Nothing in the cutover pipeline overwrote those templates with persona
content, so every agent woke up with a placeholder identity.

A second compounding issue: the persona files live on the host at
`${OPENCLAW_LOCAL_MEMORY_DIR}/agents/<id>/persona.md` and **were not
bind-mounted into either container** in the Batch 5b compose split. The
private-memory backend in `daemon/src/memory.ts` (CLAUDE.md §"Persona privacy
rule" layer 1) would also have silently failed any write to a private file
for the same reason.

## Root cause classification

- **Spec gap, not bug.** `migration-architecture.md §7` covered the privacy
  invariant (layers 1–4) and §6 covered the openclaw config template, but
  there is no section that maps "where persona.md lives on the host" to
  "where openclaw reads its system prompt." The seam between the two stores
  was assumed, not specified.
- **Missed by smoke tests.** Batch 10's acceptance checklist verified that
  `/tools/invoke list_projects` returned 200 and that "Anubis replies to
  `@Anubis ping` on Discord" — both passed, because the generic agent will
  reply. There was no check that the reply matched the configured persona.

## Fix applied (commit hash on completion)

Two files modified:

### `docker-compose.yml`

Added a bind mount to both `openclaw-gateway` and `openclaw-daemon`:

```yaml
- ${OPENCLAW_LOCAL_MEMORY_DIR:-${HOME}/.claude/local-memory}:/home/agent/.claude/local-memory:rw
```

- **Why both services?** The daemon's `resolveBackend()` writes private agent
  files (persona.md, secrets.md) to this path; the gateway needs read access
  for the materialization step below. Without the mount on the daemon,
  layer 1 of the privacy invariant silently no-ops.
- **Why `rw`?** The daemon writes (operator updates persona via the dashboard
  or `PUT /api/memories/agents/<id>/persona.md`). Gateway only reads.

### `entrypoint.sh`

After the existing "Pre-creating per-persona workspace dirs" block, added:

```bash
PERSONA_ROOT="${OPENCLAW_LOCAL_MEMORY:-/home/agent/.claude/local-memory}/agents"
echo "[entrypoint] Syncing persona.md → IDENTITY.md for local agents (source: $PERSONA_ROOT)"
jq -r '.agents.list[]? | "\(.id)\t\(.workspace // "")"' "$CONFIG_FILE" 2>/dev/null \
    | while IFS=$'\t' read -r aid ws; do
        if [ -z "$aid" ] || [ -z "$ws" ]; then continue; fi
        src="$PERSONA_ROOT/$aid/persona.md"
        if [ -f "$src" ]; then
            cp -f "$src" "$ws/IDENTITY.md"
            ...
        fi
    done
```

Idempotent, runs every container boot, picks up the latest persona content.
If the operator edits `persona.md` on the host, a `docker restart
openclaw-gateway` is now sufficient to apply the change.

## Privacy invariant — still intact?

Yes, with one nuance worth recording.

- The bind mount is `rw` for the daemon (writes private files) and shared
  with the gateway (reads for materialization). The gateway never writes to
  the private path — only **reads** from it during entrypoint init.
- The persona content is copied **into the openclaw workspace** as
  `IDENTITY.md`. That workspace lives in the `openclaw-state` named volume,
  which is **not** bind-mounted back to the host and not pushed anywhere.
  The persona content therefore stays on the leader machine (and is
  re-materialized from `persona.md` on every container boot — there is no
  drift problem).
- **No new exposure path.** The agent itself can read its own `IDENTITY.md`
  (that's literally what we want), but the openclaw fs policy
  (`agents.defaults.tools.fs.workspaceOnly = true`, per arch §7.5) prevents
  any other agent from reading it. Layers 1–4 of the privacy invariant in
  `memory.ts` are untouched.

## Adjacent gaps to track (not fixed here)

1. **No persona-content health check.** A future regression where
   `persona.md` is missing or empty will silently fall back to the stock
   template. Recommend adding to Batch 13 docs or a follow-up batch:
   - daemon `/api/health` endpoint reports per-agent `personaBytes`
   - entrypoint emits `[entrypoint] WARN: agent <id> has no persona.md` (the
     current `- $aid: no persona.md at $src` line — but it's an info-level
     stderr line, not an error)
2. **`secrets.md` not yet materialized.** The privacy invariant covers
   `secrets.md` as a private file but the workspace materialization only
   touches `persona.md → IDENTITY.md`. If/when agents need
   credentials at runtime, decide whether `secrets.md` should be exposed in
   the workspace (and if so, with what file name — there is no openclaw
   priority slot for "secrets").
3. **Multi-persona on one machine.** When/if a single machine ever runs
   `OPENCLAW_LOCAL_AGENT_IDS=anubis,horus`, the entrypoint loop will already
   handle both — but the openclaw fs policy (`workspaceOnly`) needs spot-
   checking to make sure horus's workspace can't read anubis's
   `IDENTITY.md`. Add to Batch 13's smoke checklist.
4. **Boot-time Discord retry loop.** Independently surfaced during this
   incident: the Discord adapter inside openclaw gives up reconnecting after
   a finite number of attempts. On a slow-network boot, the gateway can end
   up indefinitely with `gatewayConnected=false` until manually restarted.
   Recommend adding to docs/OPERATIONS.md and considering a healthcheck
   that fails when `gatewayConnected=false` for >N minutes (the existing
   container healthcheck only verifies HTTP responds, not Discord).

## Acceptance

- `[ok]` Gateway boots, entrypoint logs:
  `✓ anubis: .../persona.md → .../IDENTITY.md (6942 bytes)`
- `[ok]` `docker exec openclaw-gateway head -3
  /home/agent/.openclaw/workspace/anubis/IDENTITY.md`
  prints the persona frontmatter (`name: Anubis / persona: leader-coordinator`).
- `[ok]` Discord login succeeds (`logged in to discord as ... (Anubis)`).
- `[pending]` Operator DMs `@Anubis` and the reply matches the configured
  voice (encyclopedic professor of the underworld, etc., per
  `local-memory/agents/anubis/persona.md`). This is the final acceptance
  signal; if it fails, the cached session prompt may need to be invalidated
  (delete the agent's session JSONL under
  `/home/agent/.openclaw/agents/anubis/sessions/`).
