import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';
import { MemoryRepo } from './db/index.js';

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

interface IdentityFrontmatter {
  name?: unknown;
  specializes_in?: unknown;
  capabilities?: unknown;
  owner_hint?: unknown;
  persona?: unknown;
}

const statusCache = new Map<string, StatusPayload>();

export function recordAgentStatus(agentId: string, payload: Omit<StatusPayload, 'ts'>): void {
  statusCache.set(agentId, { ...payload, ts: new Date().toISOString() });
}

export function getCachedStatus(agentId: string): StatusPayload | undefined {
  return statusCache.get(agentId);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

export async function listAgents(): Promise<Agent[]> {
  const ids = new Set<string>();

  // Shared identities live in memory_files. Scope='agents' lists all owners
  // that have ANY shared file; the per-id read below filters down to those
  // with an actual identity.md.
  for (const meta of MemoryRepo.list('agents')) ids.add(meta.ownerId);

  // Also surface agents that exist locally only (a follower might host an
  // agent whose public bio hasn't been pushed yet — purely persona/secrets).
  try {
    const local = await fs.readdir(config.localAgentsRoot, { withFileTypes: true });
    for (const e of local) if (e.isDirectory()) ids.add(e.name);
  } catch (err) {
    // ENOENT on the local-memory directory is expected on a fresh container;
    // anything else is a real bind-mount problem and worth logging.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[agents] local-memory readdir failed', err);
    }
  }

  const agents: Agent[] = [];
  for (const id of ids) {
    const agent: Agent = {
      id,
      name: id,
      ownedHere: false,
      status: 'unknown',
    };

    // Read public bio from the shared memory_files table.
    const identity = MemoryRepo.read('agents', id, 'identity.md');
    if (identity) {
      try {
        const parsed = matter(identity.content);
        const data = parsed.data as IdentityFrontmatter | undefined;
        if (data) {
          agent.name = asString(data.name) ?? id;
          agent.capabilities = asStringArray(data.specializes_in) ?? asStringArray(data.capabilities);
          agent.ownerHint = asString(data.owner_hint);
          // Persona summary from shared bio (one-line description, NOT the
          // full system prompt — that is local-only).
          agent.persona = asString(data.persona);
        }
      } catch {
        // Malformed frontmatter — keep the defaulted Agent shape.
      }
    }

    // Mark locally-owned if a persona file exists in local-memory.
    const personaPath = path.join(config.localAgentsRoot, id, 'persona.md');
    agent.ownedHere = await fs
      .access(personaPath)
      .then(() => true)
      .catch(() => false);

    // Status comes from in-memory cache (fed by Redis pub-sub).
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
