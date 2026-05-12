// `invoke_ptah` — dispatches a workspace-scoped ptah-cli invocation via
// the daemon. Per arch §3.9.
//
// Input validation layers (per arch §7.1 layer 6):
//   - typebox `minLength: 1` rejects empty `project` / `prompt`.
//   - Runtime check at the start of `execute()` rejects path-traversal
//     characters (`..`, `/`, `\`) and ASCII control chars in `project`.
//     This belt-and-braces the daemon's own validator at
//     `daemon/src/api.ts:314` so a misconfigured chat model can't get even
//     a 400 from the daemon — it's caught client-side first.

import { Type, type Static } from "openclaw/plugin-sdk/typebox";
import type {
  OpenClawPluginToolFactory,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  AnyAgentTool,
  AgentToolResult,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  textResult,
  failedTextResult,
} from "openclaw/plugin-sdk/agent-runtime";

import { resolveAndInvokePtah } from "../ptahLauncher.js";

const InvokePtahParams = Type.Object(
  {
    project: Type.String({
      description:
        "Project slug as registered in the daemon (see list_projects).",
      minLength: 1,
    }),
    prompt: Type.String({
      description:
        "Prompt forwarded verbatim to ptah-cli. Be explicit — ptah is non-interactive.",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

type InvokePtahParamsT = Static<typeof InvokePtahParams>;

/**
 * Reject path-traversal characters and ASCII control chars in a project
 * slug. Returns an error message on rejection, or `null` if the slug is
 * clean. Per arch §7.1 layer 6.
 *
 * Exported for unit-testing.
 */
export function validateProjectSlug(project: string): string | null {
  if (project.length === 0) {
    return "project must be a non-empty string";
  }
  if (
    project.includes("..") ||
    project.includes("/") ||
    project.includes("\\")
  ) {
    return 'project slug must not contain "..", "/" or "\\"';
  }
  // ASCII control chars (0x00–0x1F and 0x7F) — typebox doesn't catch these
  // and they have no business in a project slug.
  for (let i = 0; i < project.length; i++) {
    const code = project.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return "project slug must not contain control characters";
    }
  }
  return null;
}

export const invokePtahFactory: OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "invoke_ptah",
  label: "Invoke ptah-cli",
  description:
    "Dispatch a workspace-scoped ptah-cli invocation. Synchronous — chat " +
    "blocks until ptah returns. Use ONLY when the operator says so, or " +
    "when the task obviously needs claude-code (long context, multi-file " +
    "refactor). Default to openclaw's built-in tools for everything else.",
  parameters: InvokePtahParams,
  async execute(
    _toolCallId: string,
    params: InvokePtahParamsT,
  ): Promise<AgentToolResult> {
    // Defense-in-depth runtime check (arch §7.1 layer 6).
    const slugError = validateProjectSlug(params.project);
    if (slugError !== null) {
      return failedTextResult(`invoke_ptah rejected: ${slugError}`, {
        status: "failed",
        error: slugError,
      });
    }
    if (params.prompt.trim().length === 0) {
      return failedTextResult("invoke_ptah rejected: prompt is empty", {
        status: "failed",
        error: "prompt is empty",
      });
    }

    try {
      const result = await resolveAndInvokePtah({
        project: params.project,
        prompt: params.prompt,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });
      return textResult(result.output, {
        status: "ok",
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failedTextResult(`invoke_ptah failed: ${message}`, {
        status: "failed",
        error: message,
      });
    }
  },
});
