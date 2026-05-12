// Plugin-side daemon HTTP client. Per arch §3.7 this is an almost-verbatim
// port of `bot-bridge/src/daemonClient.ts` with the following deltas:
//   - DROP `emitSseHint` — observability now rides openclaw's event system.
//   - DROP `tickContinuation`-mentioning comments — helper is already gone.
//   - DROP `readHarnessYaml`, `readDiscordJson`, `readAgentIdentity` — the
//     plugin doesn't render persona system prompts; openclaw does that.
//   - KEEP the `call<T>()` core, project-files helpers, listProjects,
//     listAgents, listTasks, getTask, createTask, approve, handoff,
//     approveTask, handoffTask, readMemory, readProjectFile,
//     listProjectFiles, writeProjectFile.
//   - ADD `invokePtah` (Batch 4) for the new `/api/ptah/invoke` route.
//
// The plugin reaches the daemon ONLY over HTTP with the internal Bearer
// token (arch §7.4). No direct FS access for memory/persona files.

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

export type MemoryScope = "users" | "agents" | "threads" | "projects";

export interface MemoryReadResult {
  content: string;
  private: boolean;
}

export class HttpStatusError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpStatusError";
  }
}

export interface ProjectFileMeta {
  path: string;
  size: number;
  mtime: string;
}

export interface ProjectFileReadResult {
  content: string;
  sizeBytes: number;
  mtime: string;
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
 * GET /api/memories/{scope}/{ownerId}/{filename}.
 *
 * 404 → null (normal "missing" flow). 5xx (or unexpected 4xx other than 404)
 * throws an `HttpStatusError` carrying the status code.
 *
 * There is intentionally NO `readPersona` helper. Personas are a local-FS
 * concern (PRIVATE_AGENT_FILES — persona privacy invariant). The daemon's
 * HTTP gate already 404s scope=agents + persona.md.
 */
async function readMemory(
  scope: MemoryScope,
  ownerId: string,
  filename: string,
): Promise<MemoryReadResult | null> {
  const url =
    `${config.daemonUrl}/api/memories/${encodeURIComponent(scope)}` +
    `/${encodeURIComponent(ownerId)}/${encodeURIComponent(filename)}`;
  const r = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    await r.body.dump();
    return null;
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/memories/${scope}/${ownerId}/${filename} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as MemoryReadResult;
}

/**
 * GET /api/projects/:slug/files?path=<relativePath>
 *
 * Returns the file contents + stat metadata. `null` on 404 (file missing).
 * 5xx and unexpected 4xx propagate as `HttpStatusError`.
 */
async function readProjectFile(
  slug: string,
  relativePath: string,
): Promise<ProjectFileReadResult | null> {
  const url =
    `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files` +
    `?path=${encodeURIComponent(relativePath)}`;
  const r = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    await r.body.dump();
    return null;
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/projects/${slug}/files?path=${relativePath} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as ProjectFileReadResult;
}

/**
 * GET /api/projects/:slug/files?prefix=<dir>
 *
 * Returns the (non-recursive) file listing under `<project>/<prefix>`.
 * Returns an empty array on 404 (prefix dir missing).
 */
async function listProjectFiles(
  slug: string,
  prefix: string = "",
): Promise<ProjectFileMeta[]> {
  const qs = prefix.length > 0 ? `?prefix=${encodeURIComponent(prefix)}` : "";
  const url = `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files${qs}`;
  const r = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    await r.body.dump();
    return [];
  }
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `GET /api/projects/${slug}/files${qs} → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as ProjectFileMeta[];
}

/**
 * POST /api/projects/:slug/files
 *
 * Writes `<project>/<relativePath>` with `content`.
 */
async function writeProjectFile(
  slug: string,
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; sizeBytes: number }> {
  const url = `${config.daemonUrl}/api/projects/${encodeURIComponent(slug)}/files`;
  const r = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.internalToken}`,
    },
    body: JSON.stringify({ path: relativePath, content }),
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) {
    throw new HttpStatusError(
      r.statusCode,
      `POST /api/projects/${slug}/files (path=${relativePath}) → ${r.statusCode}: ${text}`,
    );
  }
  return JSON.parse(text) as { ok: boolean; sizeBytes: number };
}

export interface CreateTaskBody {
  project: string;
  description: string;
  agentId?: string;
  discordUserId?: string;
  channelId?: string;
}

export interface CreateTaskResponse {
  taskId: string;
}

export interface ApproveTaskBody {
  phase: string;
  decision: "APPROVED" | "REJECTED";
  feedback?: string;
}

/**
 * Daemon client surface. The CRUD methods are called by `tools/daemonCrud.ts`
 * (Batch 5); `invokePtah` is called by `ptahLauncher.ts` (Batch 4).
 *
 * `approve` / `handoff` keep their bot-bridge legacy names; `approveTask`
 * and `handoffTask` are aliases the tool factories prefer. Both surfaces
 * coexist by design — see bot-bridge daemonClient comment.
 */
export const daemon = {
  invokePtah(body: InvokePtahBody): Promise<InvokePtahResponse> {
    return call<InvokePtahResponse>("POST", "/api/ptah/invoke", body);
  },

  listProjects: () => call<unknown[]>("GET", "/api/projects"),
  listAgents: () => call<unknown[]>("GET", "/api/agents"),
  listTasks: (slug: string) =>
    call<unknown[]>("GET", `/api/projects/${encodeURIComponent(slug)}/tasks`),
  getTask: (slug: string, id: string) =>
    call<Record<string, unknown>>(
      "GET",
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}`,
    ),
  createTask: (body: CreateTaskBody) =>
    call<CreateTaskResponse>("POST", "/api/tasks", body),

  approve: (slug: string, id: string, body: ApproveTaskBody) =>
    call(
      "POST",
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}/approve`,
      body,
    ),
  handoff: (slug: string, id: string, toAgent: string, reason?: string) =>
    call(
      "POST",
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}/handoff`,
      { toAgent, reason },
    ),

  // Aliases — the daemonCrud tool factories use these canonical names.
  approveTask: (slug: string, id: string, body: ApproveTaskBody) =>
    call(
      "POST",
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}/approve`,
      body,
    ),
  handoffTask: (slug: string, id: string, toAgent: string, reason?: string) =>
    call(
      "POST",
      `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}/handoff`,
      { toAgent, reason },
    ),

  readMemory,
  readProjectFile,
  listProjectFiles,
  writeProjectFile,
};
