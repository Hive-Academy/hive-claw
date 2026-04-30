import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import Redis from 'ioredis';
import { config } from './config.js';
import { daemon } from './daemonClient.js';

// MUST match daemon/src/db/memory.ts PRIVATE_AGENT_FILES.
// Cross-package import is not possible (bot-bridge is a separate package);
// any change here must be mirrored there. This set is the bot-bridge-side
// reference for which agent files are personal and never traverse HTTP.
const PRIVATE_AGENT_FILES = new Set(['persona.md', 'persona.json', 'secrets.md', 'secrets.json']);

export interface AgentDef {
  id: string;
  name: string;
  persona?: string;
  /** Public bio markdown (from shared memory, fetched via daemon HTTP API: /api/memories/agents/<id>/identity.md) */
  identityMd?: string;
  /** Private system prompt (from local-memory/agents/<id>/persona.md). Owner-only. */
  personaMd?: string;
  tokenEnvVar: string;
  token: string | null;
  clientId?: string;
  channelAllowList?: string[];
}

export async function loadAgents(): Promise<AgentDef[]> {
  await fs.mkdir(config.localAgentsRoot, { recursive: true });

  // Source of truth for which agents could run on this machine: local-memory.
  // The agent must have a local persona to actually be runnable here.
  const localIds = (await fs.readdir(config.localAgentsRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const agents: AgentDef[] = [];
  for (const id of localIds) {
    const localDir = path.join(config.localAgentsRoot, id);

    let name = id;
    let persona: string | undefined;
    let identityMd: string | undefined;
    let personaMd: string | undefined;

    // Public identity comes from shared memory via the daemon HTTP API.
    // Personas (PRIVATE_AGENT_FILES) are NEVER fetched over HTTP — see below.
    try {
      const identity = await daemon.readAgentIdentity(id);
      if (identity) {
        const parsed = matter(identity.content);
        name = (parsed.data as any)?.name ?? id;
        persona = (parsed.data as any)?.persona;
        identityMd = parsed.content;
      }
    } catch (err) {
      console.warn(`[bot-bridge] failed to read identity for "${id}":`, (err as Error).message);
    }

    // Persona privacy invariant: the persona is read directly from local-memory
    // and NEVER fetched via the daemon HTTP API. The daemon's HTTP gate already
    // 404s scope=agents + persona.md, but bot-bridge must short-circuit before
    // any such call exists. See docs/SECURITY.md and PRIVATE_AGENT_FILES above.
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
      const disc = (await daemon.readDiscordJson(id)) as
        | { tokenEnvVar?: string; clientId?: string; channelAllowList?: string[] }
        | null;
      if (disc) {
        if (disc.tokenEnvVar) tokenEnvVar = disc.tokenEnvVar;
        clientId = disc.clientId;
        channelAllowList = disc.channelAllowList;
      }
    } catch (err) {
      console.warn(`[bot-bridge] failed to read discord.json for "${id}":`, (err as Error).message);
    }

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
