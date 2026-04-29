import { request } from 'undici';
import { config } from './config.js';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await request(`${config.daemonUrl}${path}`, {
    method: method as any,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.body.text();
  if (r.statusCode >= 400) throw new Error(`${method} ${path} → ${r.statusCode}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export const daemon = {
  listProjects: () => call<any[]>('GET', '/api/projects'),
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
};
