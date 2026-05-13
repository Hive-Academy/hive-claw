// Shim for `openclaw/plugin-sdk/plugin-entry`. Local definitions that pin
// the type contract; the real plugin-sdk module is structurally compatible.
// See ./README.md for the Batch 7 cleanup plan.

import type { AnyAgentTool } from "./agent-runtime.js";

/**
 * Context handed to every tool factory at registration time. The fields
 * mirror the post-amendment context shape (arch §3.10):
 *   - `requesterSenderId` (was `userId` in bot-bridge)
 *   - `messageChannel`     (was `channelId`)
 *   - `agentId`, `sessionKey`, `agentAccountId`
 *
 * Tools that don't need a field can ignore it; `?:` reflects that openclaw
 * doesn't always populate every field (e.g. tool-call from a non-Discord
 * surface won't have `messageChannel`).
 */
export interface OpenClawPluginToolContext {
  agentId?: string;
  sessionKey?: string;
  requesterSenderId?: string;
  messageChannel?: string;
  agentAccountId?: string;
}

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool;

export interface PluginApi {
  logger: {
    info: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  registerTool: (
    factory: OpenClawPluginToolFactory,
    opts: { name: string },
  ) => void;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi) => void;
}

/**
 * Identity function that pins the return shape. The real sdk export does
 * the same with additional runtime metadata recording; for the in-tree
 * build we just return the entry unchanged.
 */
export function definePluginEntry(entry: PluginEntry): PluginEntry {
  return entry;
}
