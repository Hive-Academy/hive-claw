import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import Redis from 'ioredis';
import { config } from './config.js';

export interface AgentDef {
  id: string;
  name: string;
  persona?: string;
  /** Public bio markdown (from shared-specs/memory/agents/<id>/identity.md) */
  identityMd?: string;
  /** Private system prompt (from local-memory/agents/<id>/persona.md). Owner-only. */
  personaMd?: string;
  tokenEnvVar: string;
  token: string | null;
  clientId?: string;
  channelAllowList?: string[];
}

export async function loadAgents(): Promise<AgentDef[]> {
  await fs.mkdir(config.agentsRoot, { recursive: true });
  await fs.mkdir(config.localAgentsRoot, { recursive: true });

  // Source of truth for which agents could run on this machine: local-memory.
  // The agent must have a local persona to actually be runnable here.
  const localIds = (await fs.readdir(config.localAgentsRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const agents: AgentDef[] = [];
  for (const id of localIds) {
    const sharedDir = path.join(config.agentsRoot, id);
    const localDir = path.join(config.localAgentsRoot, id);

    let name = id;
    let persona: string | undefined;
    let identityMd: string | undefined;
    let personaMd: string | undefined;

    try {
      const raw = await fs.readFile(path.join(sharedDir, 'identity.md'), 'utf8');
      const parsed = matter(raw);
      name = (parsed.data as any)?.name ?? id;
      persona = (parsed.data as any)?.persona;
      identityMd = parsed.content;
    } catch {}

    try {
      personaMd = await fs.readFile(path.join(localDir, 'persona.md'), 'utf8');
    } catch {}

    if (!personaMd) {
      console.warn(`[bot-bridge] agent "${id}" has no local persona — skipping (create ${path.join(localDir, 'persona.md')})`);
      continue;
    }

    let tokenEnvVar = `DISCORD_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    let clientId: string | undefined;
    let channelAllowList: string[] | undefined;
    try {
      const disc = JSON.parse(await fs.readFile(path.join(sharedDir, 'discord.json'), 'utf8'));
      if (disc.tokenEnvVar) tokenEnvVar = disc.tokenEnvVar;
      clientId = disc.clientId;
      channelAllowList = disc.channelAllowList;
    } catch {}

    const token = process.env[tokenEnvVar] ?? null;
    agents.push({ id, name, persona, identityMd, personaMd, tokenEnvVar, token, clientId, channelAllowList });
  }
  return agents;
}

let statusPub: Redis | null = null;

export async function ensureStatusPublisher(): Promise<void> {
  if (statusPub || !config.redisUrl) return;
  statusPub = new Redis(config.redisUrl);
}

export async function publishStatus(
  agentId: string,
  status: { status: 'online' | 'busy' | 'offline'; busyWith?: string },
): Promise<void> {
  const payload = {
    agentId,
    status: status.status,
    busyWith: status.busyWith,
    lastSeen: new Date().toISOString(),
  };
  if (statusPub) {
    await statusPub.publish(`agent:status:${agentId}`, JSON.stringify(payload));
  }
}

export async function closeStatusPublisher(): Promise<void> {
  await statusPub?.quit();
  statusPub = null;
}
