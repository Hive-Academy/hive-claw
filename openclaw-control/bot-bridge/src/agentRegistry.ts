import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import Redis from 'ioredis';
import { config } from './config.js';
import { daemon } from './daemonClient.js';
import { parseHarnessYaml, harnessHash, type HarnessConfig } from './harness/types.js';

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

  /** Parsed harness.yaml (TASK_2026_002). undefined when no harness.yaml exists for this persona. */
  harness?: HarnessConfig;
  /** sha256 of the raw harness.yaml bytes — used by harness/sync to dedupe broadcasts. */
  harnessVersion?: string | null;
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
    const def = await loadAgentById(id);
    if (def) agents.push(def);
  }
  return agents;
}

async function loadAgentById(id: string): Promise<AgentDef | null> {
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
    return null;
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

  // Harness (TASK_2026_002) — public, shared via the daemon's shared-memory
  // HTTP API. Missing yaml is the common case for personas without harness
  // configured yet (silent — debug log at most). Invalid yaml is operator
  // error and warns but does not throw (the persona stays online without
  // a harness; chat falls through to the legacy plain-chat path).
  let harness: HarnessConfig | undefined;
  let harnessVersion: string | null = null;
  try {
    const yamlResult = await daemon.readHarnessYaml(id);
    if (yamlResult) {
      try {
        harness = parseHarnessYaml(yamlResult.content);
        harnessVersion = harnessHash(yamlResult.content);
      } catch (err) {
        console.warn(`[bot-bridge] agent "${id}" harness.yaml is invalid:`, (err as Error).message);
        harness = undefined;
        harnessVersion = null;
      }
    }
  } catch (err) {
    console.warn(`[bot-bridge] failed to read harness.yaml for "${id}":`, (err as Error).message);
  }

  const token = process.env[tokenEnvVar] ?? null;
  return { id, name, persona, identityMd, personaMd, tokenEnvVar, token, clientId, channelAllowList, harness, harnessVersion };
}

/**
 * Hot-reload a single persona — re-fetches identity, persona, discord.json,
 * and harness.yaml. Returns the freshly constructed `AgentDef`, or `null` if
 * the persona has no local persona.md (and thus is not runnable on this host).
 *
 * Per the B1 contract: if `harness.yaml` is missing or invalid on reload, the
 * function returns the agent with `harness: undefined`. Callers that want
 * "preserve the previous harness on transient invalid yaml" should diff
 * against their cached copy and merge.
 */
export async function reloadAgent(id: string): Promise<AgentDef | null> {
  return loadAgentById(id);
}

export async function reloadAllAgents(): Promise<AgentDef[]> {
  return loadAgents();
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
