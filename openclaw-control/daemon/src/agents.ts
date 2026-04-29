import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';

export interface Agent {
  id: string;
  name: string;
  persona?: string;
  capabilities?: string[];
  ownerHint?: string;
  /** Whether this machine has the persona file locally (i.e. we own this agent) */
  ownedHere: boolean;
  status: 'online' | 'busy' | 'offline' | 'unknown';
  lastSeen?: string;
  busyWith?: string;
}

interface StatusPayload {
  status: 'online' | 'busy' | 'offline';
  lastSeen?: string;
  busyWith?: string;
  ts: string;
}

const statusCache = new Map<string, StatusPayload>();

export function recordAgentStatus(agentId: string, payload: Omit<StatusPayload, 'ts'>): void {
  statusCache.set(agentId, { ...payload, ts: new Date().toISOString() });
}

export function getCachedStatus(agentId: string): StatusPayload | undefined {
  return statusCache.get(agentId);
}

export async function listAgents(): Promise<Agent[]> {
  await fs.mkdir(config.agentsRoot, { recursive: true });
  const ids = new Set<string>();
  try {
    const entries = await fs.readdir(config.agentsRoot, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) ids.add(e.name);
  } catch {}
  // Also surface agents that exist locally only (a follower might host an
  // agent whose public bio hasn't been pushed yet).
  try {
    const local = await fs.readdir(config.localAgentsRoot, { withFileTypes: true });
    for (const e of local) if (e.isDirectory()) ids.add(e.name);
  } catch {}

  const agents: Agent[] = [];
  for (const id of ids) {
    const agent: Agent = {
      id,
      name: id,
      ownedHere: false,
      status: 'unknown',
    };

    // Read public bio from the shared specs repo
    try {
      const raw = await fs.readFile(path.join(config.agentsRoot, id, 'identity.md'), 'utf8');
      const parsed = matter(raw);
      agent.name = (parsed.data as any)?.name ?? id;
      agent.capabilities = (parsed.data as any)?.specializes_in ?? (parsed.data as any)?.capabilities;
      agent.ownerHint = (parsed.data as any)?.owner_hint;
      // Take persona summary from shared bio if provided (one-line description, NOT the full system prompt)
      agent.persona = (parsed.data as any)?.persona;
    } catch {}

    // Mark locally-owned if a persona file exists in local-memory
    const personaPath = path.join(config.localAgentsRoot, id, 'persona.md');
    agent.ownedHere = await fs
      .access(personaPath)
      .then(() => true)
      .catch(() => false);

    // Status comes from in-memory cache (fed by Redis pub-sub)
    const status = statusCache.get(id);
    if (status) {
      agent.status = status.status;
      agent.lastSeen = status.lastSeen;
      agent.busyWith = status.busyWith;
    }
    agents.push(agent);
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}
