import { request } from 'undici';
import { config } from './config.js';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.internalToken) headers['authorization'] = `Bearer ${config.internalToken}`;
  const r = await request(`${config.daemonUrl}${path}`, {
    method: method as any,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) throw new Error(`${method} ${path} → ${r.statusCode}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export type MemoryScope = 'users' | 'agents' | 'threads' | 'projects';

export interface MemoryReadResult {
  content: string;
  private: boolean;
}

class HttpStatusError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpStatusError';
  }
}

/**
 * GET /api/memories/{scope}/{ownerId}/{filename}.
 *
 * 404 → null (normal "missing" flow). 5xx (or unexpected 4xx other than 404)
 * throws an `HttpStatusError` carrying the status code.
 *
 * Note: there is intentionally NO `readPersona` helper. Personas are a
 * local-FS concern (PRIVATE_AGENT_FILES — see persona privacy invariant in
 * docs/SECURITY.md); the daemon's HTTP gate already 404s scope=agents +
 * persona.md, but bot-bridge must short-circuit before any HTTP call exists.
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
    method: 'GET',
    headers: { authorization: `Bearer ${config.internalToken}` },
  });
  if (r.statusCode === 404) {
    // Drain the body so the connection can be reused.
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

async function readAgentIdentity(agentId: string): Promise<MemoryReadResult | null> {
  return readMemory('agents', agentId, 'identity.md');
}

async function readDiscordJson(agentId: string): Promise<unknown | null> {
  const result = await readMemory('agents', agentId, 'discord.json');
  if (result === null) return null;
  // JSON.parse failure here is a data-integrity error, not "missing" —
  // let it propagate so it surfaces in logs rather than being swallowed.
  return JSON.parse(result.content);
}

export const daemon = {
  listProjects: () => call<any[]>('GET', '/api/projects'),
  listAgents: () => call<any[]>('GET', '/api/agents'),
  listTasks: (slug: string) => call<any[]>('GET', `/api/projects/${slug}/tasks`),
  getTask: (slug: string, id: string) => call<any>('GET', `/api/projects/${slug}/tasks/${id}`),
  createTask: (body: { project: string; description: string; agentId?: string; discordUserId?: string; channelId?: string }) =>
    call<{ taskId: string }>('POST', '/api/tasks', body),
  approve: (slug: string, id: string, body: { phase: string; decision: 'APPROVED' | 'REJECTED'; feedback?: string }) =>
    call('POST', `/api/projects/${slug}/tasks/${id}/approve`, body),
  handoff: (slug: string, id: string, toAgent: string, reason?: string) =>
    call('POST', `/api/projects/${slug}/tasks/${id}/handoff`, { toAgent, reason }),
  tick: () => call<{ dispatched: number; checkpoints: number; pending: number }>('POST', '/api/continuation/tick'),
  appendInteraction: (discordUserId: string, agent: string, channel: string, summary: string) =>
    call('PUT', `/api/memories/users/${discordUserId}/interactions.md`, {
      content: `_appended ${new Date().toISOString()}_`,
    }).catch(() => {}),
  readMemory,
  readAgentIdentity,
  readDiscordJson,
};
