// Plugin-side daemon HTTP client. Batch 4 ships the MINIMAL surface needed
// by `invoke_ptah`: a single `invokePtah(body)` method. Batch 5 adds the
// 6 daemon-CRUD methods (`listProjects`, `listTasks`, `getTask`, etc.).
//
// Per arch §3.7 the following helpers from bot-bridge are explicit DROPS
// and MUST NOT be ported here:
//   - emitSseHint
//   - readHarnessYaml
//   - readDiscordJson
//   - readAgentIdentity
//   - tickContinuation
// Personas are openclaw's concern in the post-migration world. The plugin
// reaches the daemon only over HTTP with the internal Bearer token.

import { request } from "undici";
import { config } from "./config.js";

export interface InvokePtahBody {
  project: string;
  prompt: string;
  agentId?: string;
  sessionKey?: string;
  timeoutMs?: number;
}

export interface InvokePtahResponse {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  stderr?: string;
}

/**
 * Core HTTP helper. Mirrors bot-bridge's shape:
 *   - JSON content-type, Bearer auth header.
 *   - 4xx/5xx surfaces as a thrown Error with status + body in the message.
 *   - empty body parses to `{}`.
 *
 * Exported for tests; not part of the public plugin API.
 */
export async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.internalToken}`,
  };
  const r = await request(`${config.daemonUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new Error(`${method} ${path} → ${r.statusCode}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * Daemon client surface. Batch 4 ships ONLY `invokePtah`; the 6 CRUD methods
 * (listProjects, listTasks, getTask, createTask, approveTask, handoffTask)
 * land in Batch 5.
 *
 * Exported as `daemon` (singleton) for chat-loop consumers; the function
 * shape allows test code to substitute a mock via dependency injection if
 * needed.
 */
export const daemon = {
  invokePtah(body: InvokePtahBody): Promise<InvokePtahResponse> {
    return call<InvokePtahResponse>("POST", "/api/ptah/invoke", body);
  },
};
