// Shim for `openclaw/plugin-sdk/agent-runtime`. Local implementations of
// the `textResult` / `failedTextResult` helpers plus the `AnyAgentTool`
// / `AgentToolResult` types. See ./README.md for the Batch 7 cleanup plan.

import type { TSchema, Static } from "@sinclair/typebox";

/**
 * The MCP-style content envelope returned from every tool's `execute()`.
 * `metadata` is an opaque bag for status/duration/error fields — openclaw
 * surfaces it in tool-call audit logs.
 */
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Tool descriptor handed to openclaw's runtime. `parameters` is a typebox
 * schema; openclaw uses it both for runtime validation and for the JSON
 * schema advertised to the model.
 */
export interface AgentTool<P extends TSchema = TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: P;
  execute: (
    toolCallId: string,
    params: Static<P>,
    signal?: AbortSignal,
    onUpdate?: (chunk: string) => void,
  ) => Promise<AgentToolResult>;
}

/**
 * Bivariant catch-all for `registerTool`. The real sdk uses a similar
 * `AnyAgentTool` alias so factories with different parameter schemas can
 * be registered through a single API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

/** Build a successful text result. */
export function textResult(
  text: string,
  metadata?: Record<string, unknown>,
): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    metadata,
  };
}

/** Build a failed text result (`isError: true` so openclaw flags it). */
export function failedTextResult(
  text: string,
  metadata?: Record<string, unknown>,
): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    metadata,
  };
}
