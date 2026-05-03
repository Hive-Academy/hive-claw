# TASK_2026_003 — Implementation plan

## Goal

Add two opt-in chat-tier tools (`read_channel_history`, `upload_attachment`) so registered personas can read recent Discord messages for context and post files/images back into the conversation. Both gated behind a new opt-in `chatTier.tools: string[]` field in `harness.yaml`.

## Architecture

The chat tier already has a tool-merge spine in `bot-bridge/src/chat.ts:buildToolRegistry`:

```
mergeToolRegistries(
  daemonTools.list(),                    // CRUD tools (B2)
  mcpTools.listForAgent(agent.id),       // per-persona MCP (B4)
  subagentTools.listForAgent(agent),     // per-persona subagents (B5)
  discordTools.listForAgent(agent),      // ← NEW (TASK_2026_003)
)
```

`discordTools.listForAgent` returns `[]` for any agent without `chatTier.tools` set. This keeps every existing persona's behavior byte-equivalent and only enables the new tools when explicitly opted in.

## Privacy invariant — 6th defense layer

CLAUDE.md previously enumerated 5 enforcement layers around `PRIVATE_AGENT_FILES`. The `upload_attachment(source.type='path')` mode adds a 6th layer in `bot-bridge/src/tools/discordTools.ts:assertPathInsideProject`:

1. Resolved path must equal the project root or live under `<root><sep>` (trailing-separator prefix check).
2. No path component may be `local-memory`, `.claude`, or `.ptah`.
3. Basename must not be in `PRIVATE_AGENT_FILES = {persona.md, persona.json, secrets.md, secrets.json}`.

The check uses `path.resolve` + segment-equality, not `String#includes`. The existing 5 layers (resolveBackend, HTTP gate, MemoryRepo throw, assertMaterializedPathSafety, agentRegistry persona-only-from-FS) are unmodified.

## SSRF guard

`upload_attachment(source.type='url')`:

- HTTPS only (refuse `http://`, `file://`, `ftp://`, etc.).
- Resolve hostname through `dns.lookup({ all: true })`. If ANY resolved address is in a private/loopback range, refuse the whole request (not just the private addresses — DNS rebinding defense).
- IP literals are checked directly without DNS.
- Private ranges covered: 0.x, 10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x, 224-239.x (multicast), 255.x; IPv6 `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, IPv4-mapped `::ffff:0.0.0.0/96`.
- Redirects bounded to 3 hops; SSRF guard re-runs on every hop.
- 5-second timeout; streaming body cap so a malicious server can't exhaust memory.

## Schema

`HarnessTier.tools?: string[]` — free-form list, validated at registry-build time. Unknown names are dropped with `console.warn`. Mirrored byte-equivalent in `daemon/src/harness/types.ts` (same convention as `PRIVATE_AGENT_FILES`).

## Test surface

- 23 unit tests in `bot-bridge/test/discord-tools.test.ts` covering: registry opt-in, both tool happy paths (data + path + url + history fetch), SSRF rejection (4 cases), path-traversal rejection (5 cases), file-cap enforcement, filename allow-list.
- 2 integration tests in `bot-bridge/test/integration/discord-tools.test.ts` driving a mocked LLM through `chat.handleChat` for each new tool, asserting the discord.js fake was hit with the right payload.

## Out of scope

- True voice channel / video / sticker APIs.
- Channel-pinning, reactions, embed crafting (the brief says "strip embeds and reactions").
- discord.js `MessageManager.fetch({ around })` — only `before` and `limit` are exposed; `around` is rare and adds API surface for no demand.
