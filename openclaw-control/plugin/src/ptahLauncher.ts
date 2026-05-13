// Thin shim that resolves a project slug to a workspace via the daemon and
// returns the consolidated ptah-invoke result. Per arch §3.8.
//
// v1 is synchronous from the chat-loop perspective: the daemon-side
// ptah-bridge call is a single round trip, so the `onChunk` streaming
// surface is reserved but unused.

import { daemon } from "./daemonClient.js";
import { config } from "./config.js";

export interface InvokePtahOptions {
  project: string;
  prompt: string;
  agentId?: string;
  sessionKey?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface InvokePtahResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Dispatch a workspace-scoped ptah-cli invocation through the daemon.
 *
 * Throws on `{ ok: false }` so the calling tool can map the failure to
 * `failedTextResult`. The thrown message includes the exit code; the
 * stderr (if any) is dropped here on purpose — it's already captured in
 * the daemon logs and we don't want to leak ptah-internal error text into
 * the chat surface verbatim. Tool-level error metadata records what we
 * can show safely.
 */
export async function resolveAndInvokePtah(
  opts: InvokePtahOptions,
): Promise<InvokePtahResult> {
  const result = await daemon.invokePtah({
    project: opts.project,
    prompt: opts.prompt,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    timeoutMs: config.ptahTimeoutMs,
  });
  if (!result.ok) {
    throw new Error(
      `ptah failed (exitCode=${result.exitCode}): see daemon logs`,
    );
  }
  return {
    output: result.output,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
