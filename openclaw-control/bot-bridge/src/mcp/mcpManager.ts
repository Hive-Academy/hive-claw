// mcp/mcpManager.ts — stubbed after TASK_2026_006 Batch 8 MCP migration.
//
// The bot-bridge no longer manages its own MCP server lifecycle. Gateway-tier
// MCP servers are discovered directly by `tools/mcpTools.ts` from the rendered
// `openclaw.json`. This stub satisfies the three imports still present in
// `index.ts` (startServersForAgent, reconcileForAgent, shutdownAll) so the
// bot-bridge compiles. All three are no-ops — the real MCP connections live in
// `mcpTools.ts` and are cleaned up via process signal handlers there.

import type { AgentDef } from '../agentRegistry.js';

export async function startServersForAgent(_agent: AgentDef): Promise<void> {
  // No-op — mcpTools.ts handles per-server discovery lazily.
}

export async function reconcileForAgent(_agent: AgentDef): Promise<void> {
  // No-op — harness sync does not require MCP server reconciliation in the
  // new architecture. The plugin bridge and mcpTools.ts re-read openclaw.json
  // on their own schedules.
}

export async function shutdownAll(): Promise<void> {
  // No-op — individual MCP clients in mcpTools.ts close over their own
  // transports and hook SIGTERM/SIGINT.
}
