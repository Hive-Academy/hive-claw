import Redis from 'ioredis';
import { config } from './config.js';
import { broadcast } from './sse.js';
import { recordAgentStatus } from './agents.js';

export interface HandoffPayload {
  taskId: string;
  project: string;
  fromAgent: string;
  toAgent: string;
  reason?: string;
  checkpointPhase?: string;
  at: string;
}

export interface AgentStatusPayload {
  agentId: string;
  status: 'online' | 'busy' | 'offline';
  busyWith?: string;
  lastSeen?: string;
}

export interface NotifyPayload {
  agentId: string;
  channelId: string;
  text: string;
}

let pub: Redis | null = null;
let sub: Redis | null = null;

export function busAvailable(): boolean {
  return Boolean(config.redis.url);
}

export async function startBus(onHandoff: (p: HandoffPayload) => void): Promise<void> {
  if (!busAvailable()) {
    console.log('[bus] REDIS_URL not set — bus disabled (handoff in-process only, agent status not synced)');
    return;
  }
  pub = new Redis(config.redis.url);
  sub = new Redis(config.redis.url);

  await sub.psubscribe('agent:*:inbox', 'agent:status:*');
  sub.on('pmessage', (_pattern, channel, message) => {
    try {
      if (channel.endsWith(':inbox')) {
        const payload = JSON.parse(message) as HandoffPayload;
        broadcast('agent.handoff', payload);
        onHandoff(payload);
        return;
      }
      const m = channel.match(/^agent:status:(.+)$/);
      if (m) {
        const payload = JSON.parse(message) as AgentStatusPayload;
        recordAgentStatus(m[1], {
          status: payload.status,
          busyWith: payload.busyWith,
          lastSeen: payload.lastSeen,
        });
        broadcast('agent.status', { ...payload, agentId: m[1] });
      }
    } catch (err) {
      console.error('[bus] bad payload on', channel, err);
    }
  });
  console.log('[bus] connected to redis');
}

export async function publishHandoff(payload: HandoffPayload): Promise<void> {
  broadcast('agent.handoff', payload);
  if (pub) {
    await pub.publish(`agent:${payload.toAgent}:inbox`, JSON.stringify(payload));
  }
}

export async function publishNotify(payload: NotifyPayload): Promise<void> {
  if (!pub) return;
  await pub.publish(`agent:${payload.agentId}:notify`, JSON.stringify(payload));
}

export async function publishAgentStatus(payload: AgentStatusPayload): Promise<void> {
  // Always update local cache immediately, even if Redis is down
  recordAgentStatus(payload.agentId, {
    status: payload.status,
    busyWith: payload.busyWith,
    lastSeen: payload.lastSeen ?? new Date().toISOString(),
  });
  broadcast('agent.status', payload);
  if (pub) {
    await pub.publish(`agent:status:${payload.agentId}`, JSON.stringify(payload));
  }
}

export async function stopBus(): Promise<void> {
  await pub?.quit();
  await sub?.quit();
  pub = null;
  sub = null;
}
