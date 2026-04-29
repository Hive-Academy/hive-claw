import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { commitAndPush } from './gitSync.js';

/**
 * Memory has two storage backends:
 *
 * - **shared** (under `config.sharedMemoryRoot`) — git-synced, visible to every
 *   machine. Used for agent *public bios*, user profiles, thread context,
 *   project notes. Writes go through git commit+push.
 *
 * - **local** (under `config.localMemoryRoot`) — per-machine, never synced.
 *   Used for agent *personas* (system prompts) and any per-machine secrets.
 *   Writes are plain fs writes, no git involvement.
 *
 * Routing rules (decided at write time):
 *   - scope=`agents`, file matches PRIVATE_AGENT_FILES → local backend, ownership-checked
 *   - scope=`agents`, anything else → shared backend, ownership-checked
 *   - all other scopes → shared backend, no ownership check
 */

export type MemoryScope = 'agents' | 'users' | 'projects' | 'threads';
const SCOPES: MemoryScope[] = ['agents', 'users', 'projects', 'threads'];

const PRIVATE_AGENT_FILES = new Set(['persona.md', 'secrets.md', 'persona.json', 'secrets.json']);

export interface MemoryEntry {
  scope: MemoryScope;
  id: string;
  files: { name: string; size: number; mtime: string; private: boolean }[];
}

export class MemoryError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export async function ensureSharedTree(): Promise<void> {
  for (const s of SCOPES) {
    await fs.mkdir(path.join(config.sharedMemoryRoot, s), { recursive: true });
  }
  await fs.mkdir(config.localAgentsRoot, { recursive: true });
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_\-.]+$/.test(id)) throw new MemoryError('invalid id');
  return id;
}

function safeFile(name: string): string {
  if (!/^[A-Za-z0-9_\-.]+\.(md|json)$/.test(name)) throw new MemoryError('invalid filename');
  return name;
}

function isPrivateAgentFile(file: string): boolean {
  return PRIVATE_AGENT_FILES.has(file);
}

function publicScopeDir(scope: MemoryScope): string {
  if (!SCOPES.includes(scope)) throw new MemoryError('invalid scope');
  return path.join(config.sharedMemoryRoot, scope);
}

function localAgentDir(id: string): string {
  return path.join(config.localAgentsRoot, safeId(id));
}

/**
 * Resolve which absolute directory holds a given (scope,id,file) and whether
 * the backend is git-synced.
 */
function resolveBackend(scope: MemoryScope, id: string, file: string): { dir: string; private: boolean } {
  if (scope === 'agents' && isPrivateAgentFile(file)) {
    return { dir: localAgentDir(id), private: true };
  }
  return { dir: path.join(publicScopeDir(scope), safeId(id)), private: false };
}

/**
 * For agent-scope writes only: enforce that this machine owns the agent.
 * Non-owners may read but not modify any file under `agents/<id>/`.
 *
 * If `OPENCLAW_LOCAL_AGENT_IDS` is empty, ownership checks are bypassed
 * (single-machine / dev setup).
 */
function assertAgentOwnership(id: string): void {
  if (config.localAgentIds.length === 0) return;
  if (!config.localAgentIds.includes(id)) {
    throw new MemoryError(
      `agent "${id}" is not owned by this machine (locals: ${config.localAgentIds.join(',') || 'none'})`,
      403,
    );
  }
}

export async function listScope(scope: MemoryScope): Promise<MemoryEntry[]> {
  if (scope !== 'agents') {
    return readDirAsEntries(scope, publicScopeDir(scope), false);
  }
  // agents: union of shared (public bios) and local (personas this machine owns)
  const sharedEntries = await readDirAsEntries('agents', publicScopeDir('agents'), false);
  const localExists = await fs
    .access(config.localAgentsRoot)
    .then(() => true)
    .catch(() => false);
  if (!localExists) return sharedEntries;

  const localIds = (await fs.readdir(config.localAgentsRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const merged = new Map<string, MemoryEntry>();
  for (const e of sharedEntries) merged.set(e.id, e);
  for (const id of localIds) {
    const dir = localAgentDir(id);
    const files = (await fs.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile());
    const fileMeta = await Promise.all(
      files.map(async (f) => {
        const stat = await fs.stat(path.join(dir, f.name));
        return { name: f.name, size: stat.size, mtime: stat.mtime.toISOString(), private: true };
      }),
    );
    const existing = merged.get(id);
    if (existing) existing.files.push(...fileMeta);
    else merged.set(id, { scope: 'agents', id, files: fileMeta });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function readDirAsEntries(
  scope: MemoryScope,
  root: string,
  isPrivate: boolean,
): Promise<MemoryEntry[]> {
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const files = (await fs.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile());
    const fileMeta = await Promise.all(
      files.map(async (f) => {
        const stat = await fs.stat(path.join(dir, f.name));
        return {
          name: f.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          private: isPrivate || (scope === 'agents' && isPrivateAgentFile(f.name)),
        };
      }),
    );
    out.push({ scope, id: e.name, files: fileMeta });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readMemoryFile(
  scope: MemoryScope,
  id: string,
  file: string,
): Promise<{ content: string; private: boolean } | null> {
  const file_ = safeFile(file);
  const { dir, private: isPrivate } = resolveBackend(scope, id, file_);
  try {
    const content = await fs.readFile(path.join(dir, file_), 'utf8');
    return { content, private: isPrivate };
  } catch {
    return null;
  }
}

export async function writeMemoryFile(
  scope: MemoryScope,
  id: string,
  file: string,
  content: string,
): Promise<{ private: boolean }> {
  const id_ = safeId(id);
  const file_ = safeFile(file);
  if (scope === 'agents') assertAgentOwnership(id_);
  const { dir, private: isPrivate } = resolveBackend(scope, id_, file_);

  if (isPrivate) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file_), content, 'utf8');
    return { private: true };
  }
  await commitAndPush(`memory: ${scope}/${id_}/${file_}`, async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file_), content, 'utf8');
  });
  return { private: false };
}

export async function deleteMemoryFile(
  scope: MemoryScope,
  id: string,
  file: string,
): Promise<void> {
  const id_ = safeId(id);
  const file_ = safeFile(file);
  if (scope === 'agents') assertAgentOwnership(id_);
  const { dir, private: isPrivate } = resolveBackend(scope, id_, file_);
  if (isPrivate) {
    await fs.unlink(path.join(dir, file_)).catch(() => {});
    return;
  }
  await commitAndPush(`memory delete: ${scope}/${id_}/${file_}`, async () => {
    await fs.unlink(path.join(dir, file_)).catch(() => {});
  });
}

export async function appendInteraction(
  discordUserId: string,
  entry: { ts: string; agent: string; channel?: string; summary: string },
): Promise<void> {
  const id_ = safeId(discordUserId);
  await commitAndPush(`memory: users/${id_}/interactions.md += ${entry.agent}`, async () => {
    const dir = path.join(config.sharedMemoryRoot, 'users', id_);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'interactions.md');
    const line = `- **${entry.ts}** [${entry.agent}]${entry.channel ? ` (#${entry.channel})` : ''}: ${entry.summary}\n`;
    await fs.appendFile(file, line, 'utf8');
  });
}

/**
 * Build a full prompt context. For owned agents, includes the local persona.
 * For other agents, only the public identity is read (we never have access to
 * a persona we don't own — it lives on the owner's machine).
 */
export async function buildContextForMessage(opts: {
  agentId: string;
  discordUserId?: string;
  channelId?: string;
  projectSlug?: string;
}): Promise<string> {
  const parts: string[] = [];
  const tryRead = async (p: string, label: string) => {
    try {
      const txt = await fs.readFile(p, 'utf8');
      parts.push(`## ${label}\n${txt.trim()}`);
    } catch {}
  };
  const agent = safeId(opts.agentId);
  await tryRead(path.join(config.agentsRoot, agent, 'identity.md'), `Agent identity: ${agent}`);
  // Persona is local-only — we have it iff this machine owns the agent.
  await tryRead(path.join(config.localAgentsRoot, agent, 'persona.md'), `Agent persona (local): ${agent}`);
  if (opts.discordUserId) {
    await tryRead(
      path.join(config.sharedMemoryRoot, 'users', safeId(opts.discordUserId), 'profile.md'),
      `User profile: ${opts.discordUserId}`,
    );
  }
  if (opts.channelId) {
    await tryRead(
      path.join(config.sharedMemoryRoot, 'threads', safeId(opts.channelId), 'recent.md'),
      `Thread context: ${opts.channelId}`,
    );
  }
  if (opts.projectSlug) {
    await tryRead(
      path.join(config.sharedMemoryRoot, 'projects', safeId(opts.projectSlug), 'notes.md'),
      `Project notes: ${opts.projectSlug}`,
    );
  }
  return parts.join('\n\n');
}
