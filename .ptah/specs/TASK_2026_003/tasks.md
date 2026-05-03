# TASK_2026_003 — Tasks

**Total Batches:** 1 | **Status:** 1/1 implemented (awaiting orchestrator commit)

This task adds two opt-in Discord-native chat tools to the bot-bridge tool registry:
`read_channel_history` and `upload_attachment`. Both are listed in `harness.yaml`'s
new `chatTier.tools` field; absent from the harness → absent from the registry.
The high-risk surface is `upload_attachment(source.type='path')` — that mode is
the 6th defense layer of the persona privacy invariant (CLAUDE.md §"Persona
privacy rule" originally enumerated 5).

## Status legend

- **PENDING** — not yet assigned
- **IN PROGRESS** — orchestrator has spawned the executor
- **IMPLEMENTED** — executor returned; awaiting team-leader (MODE 2) verification + commit
- **COMPLETE** — verified and committed

## Batch B1 — Discord-native chat tools

- **Status:** IMPLEMENTED
- **Files (in/out):**
  - NEW `openclaw-control/bot-bridge/src/tools/discordTools.ts`
  - MODIFIED `openclaw-control/bot-bridge/src/harness/types.ts` — add optional `HarnessTier.tools: string[]`
  - MODIFIED `openclaw-control/daemon/src/harness/types.ts` — mirror of the above (cross-package contract)
  - MODIFIED `openclaw-control/bot-bridge/src/llm.ts` — `ToolCallContext.discord?: { message: unknown }`
  - MODIFIED `openclaw-control/bot-bridge/src/chat.ts` — wire `discordTools.listForAgent(...)` into `buildToolRegistry`; populate `ctx.discord` with the live `Message`
  - NEW `openclaw-control/bot-bridge/test/discord-tools.test.ts` — 23 unit tests (SSRF, path-guard, registry opt-in, all 3 source types)
  - NEW `openclaw-control/bot-bridge/test/integration/discord-tools.test.ts` — 2 end-to-end tests through `chat.handleChat` with mocked LLM
  - MODIFIED `docs/SECURITY.md` — new section "Discord-native chat tools (TASK_2026_003)" enumerating the SSRF guard, the path-guard, and the persona-privacy 6th layer
  - MODIFIED `docs/CONFIGURATION.md` — `OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB` env var
  - MODIFIED `docs/SKILLS-AND-PERSONA.md` — paragraph under chat-tier-tools section documenting the new opt-in

- **Sub-tasks:**
  1. Extend `HarnessTier` schema with optional `tools: string[]`. Mirror in daemon copy. Free-form list (no enum) so the schema stays forward-compatible with future built-ins; the registry validates names.
  2. Add `ToolCallContext.discord?: { message: unknown }` to `llm.ts`. Subagent context inheritance does NOT propagate this (subagents shouldn't post to the parent's channel arbitrarily).
  3. Implement `read_channel_history` — wraps `channel.messages.fetch({ limit, before })`. Returns slim JSON: `{ id, authorId, authorTag, timestamp, content, attachmentUrls[] }[]`, sorted newest first.
  4. Implement `upload_attachment` with three source modes:
     - `url`: HTTPS only; SSRF guard rejects loopback / RFC1918 / link-local / metadata; redirects bounded to 3; 5s timeout; size-cap streaming.
     - `path`: requires `project` slug; resolve project root via `daemon.listProjects`; `path.resolve` + trailing-separator prefix check (NOT `String#includes`); reject path components in `local-memory` / `.claude` / `.ptah`; reject basenames in `PRIVATE_AGENT_FILES`.
     - `data`: base64 decode with size cap; filename validated by a local `safeFile` mirror of the daemon helper.
  5. Wire `discordTools.listForAgent(agent)` into `chat.ts:buildToolRegistry`. Populate `ctx.discord = { message: msg }` in `handleChat`.
  6. Tests: 23 unit + 2 integration. All verifications green.

- **Verification:**
  - `cd openclaw-control/bot-bridge && npx tsc --noEmit` → 0 errors. ✅
  - `cd openclaw-control/bot-bridge && npm test 2>&1 | tail -15` → 110 pass / 0 fail / 1 skip (pre-existing gated MCP). ✅
  - `cd openclaw-control/daemon && npx tsc --noEmit` → 0 errors. ✅
  - `grep -rnE 'wizard:[a-z-]+|harness:analyze-intent' openclaw-control/{daemon,bot-bridge}/src/` → 6 enforcement-only matches, unchanged. ✅

## Hard constraints honored

- No new runtime deps (`undici`, `node:fs/promises`, `node:dns/promises`, `node:net`, `node:path`, `node:url` are all already available).
- `HarnessConfig` mirror discipline preserved: same change applied to daemon copy in the same commit.
- Strict TS / ESM / target ES2023.
- Privacy invariant: `upload_attachment` path mode adds a 6th enforcement layer; no module short-circuits the existing 5.
