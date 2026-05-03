// tools/mcpTools.ts — TASK_2026_002 B4 MCP tool registry adapter.
//
// One `ToolDef` per `(server, tool)` pair from the running MCP servers for
// the given agent. Names are namespaced as `mcp__<server-id>__<tool-name>` —
// this is the prefix the chat-tier `tools/index.ts` collision policy
// recognizes as the namespacing escape hatch (impl-plan §"MCP client
// architecture" line 895).
//
// Failed/backoff servers are filtered out at the source: `mcpManager.
// getOpenServers` already drops them, so no half-broken affordances appear in
// the registry (impl-plan §"Error handling" line 902).
//
// Per-tool timeout: spec-level `timeoutMs` is honored inside `callTool`; this
// adapter is a thin wrapper that just routes the call to the manager.

import type { ToolDef } from '../llm.js';
import * as mcpManager from '../mcp/mcpManager.js';

/** The namespacing prefix recognized by `tools/index.ts:merge`. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * Build the chat-tier tool registry slice for an agent's running MCP servers.
 *
 * Pure function — call on every inbound message; the manager is the source of
 * truth for which servers are open. A failed (backoff-exhausted) server stays
 * absent from `getOpenServers` until the operator runs `harness/sync`, so its
 * tools naturally stop being offered between turns.
 */
export function listForAgent(agentId: string): ToolDef[] {
  const handles = mcpManager.getOpenServers(agentId);
  const out: ToolDef[] = [];
  for (const handle of handles) {
    for (const tool of handle.tools) {
      // mcp__<server-id>__<tool-name> — see impl-plan line 895.
      const namespaced = `${MCP_TOOL_PREFIX}${handle.serverId}__${tool.name}`;
      const description =
        tool.description ?? `MCP tool ${handle.serverId}/${tool.name} (no description provided by server).`;
      // Pass through the server's input schema verbatim. The OpenAI tool API
      // expects a JSON-Schema-shaped object; the MCP SDK already returns one.
      const parameters = tool.inputSchema ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      };

      const serverId = handle.serverId;
      const toolName = tool.name;
      out.push({
        name: namespaced,
        description,
        parameters,
        handler: async (args, ctx) => {
          const result = await mcpManager.callTool(ctx.agentId, serverId, toolName, args);
          // The chat dispatcher expects a string. We surface the textual
          // content directly (with an `error:` prefix on failure so the LLM
          // sees what went wrong without us throwing through the tool loop).
          if (result.isError) return `error: ${result.content}`;
          return result.content;
        },
      });
    }
  }
  return out;
}
