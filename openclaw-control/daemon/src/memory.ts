import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import {
  MemoryRepo,
  PRIVATE_AGENT_FILES,
  type MemoryScope as RepoMemoryScope,
} from './db/index.js';

/**
 * Memory has two storage backends, gated by the single chokepoint
 * `resolveBackend` below.
 *
 * - **shared** — `MemoryRepo` (rows in the `memory_files` table on the
 *   leader). Visible across machines through the leader's HTTP API. Used
 *   for agent *public bios*, user profiles, thread context, project notes.
 *
 * - **local** — `~/.claude/local-memory/` on this machine, never synced.
 *   Used exclusively for files in `PRIVATE_AGENT_FILES`
 *   ({persona.md, secrets.md, persona.json, secrets.json}) under
 *   `agents/<id>/`. The owner machine is the only place these ever land.
 *
 * Routing rules (decided at every read/write/delete):
 *   - scope=`agents`, file ∈ PRIVATE_AGENT_FILES → local backend, ownership-checked
 *   - everything else → shared backend (MemoryRepo), agents-scope ownership-checked
 *
 * `PRIVATE_AGENT_FILES` is imported from `./db/index.js` — it is defined
 * once in `db/memory.ts` and re-exported through the barrel. Do NOT
 * redeclare it here.
 */

export type MemoryScope = RepoMemoryScope;
const SCOPES: readonly MemoryScope[] = ['agents', 'users', 'threads', 'projects'];

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

/**
 * Make sure the local-memory directory tree exists on this machine. The
 * shared tier lives in SQLite — there is nothing to mkdir for it.
 */
export async function ensureLocalTree(): Promise<void> {
  await fs.mkdir(config.localAgentsRoot, { recursive: true });
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_\-.]+$/.test(id)) throw new MemoryError('invalid id');
  return id;
}

function safeFile(name: string): string {
  // .yaml is allowed for harness.yaml (TASK_2026_002 B3) — public, shared-tier
  // memory. The persona-privacy invariant is unaffected because PRIVATE_AGENT_FILES
  // is the gate for what stays local, not the extension allow-list.
  if (!/^[A-Za-z0-9_\-.]+\.(md|json|yaml)$/.test(name)) throw new MemoryError('invalid filename');
  return name;
}

function isPrivateAgentFile(file: string): boolean {
  return PRIVATE_AGENT_FILES.has(file);
}

function localAgentDir(id: string): string {
  return path.join(config.localAgentsRoot, safeId(id));
}

interface ResolvedSharedBackend {
  kind: 'shared';
  scope: MemoryScope;
  ownerId: string;
  filename: string;
}

interface ResolvedLocalBackend {
  kind: 'local';
  dir: string;
  filename: string;
}

type ResolvedBackend = ResolvedSharedBackend | ResolvedLocalBackend;

/**
 * THE chokepoint. Every read/write/delete must go through this.
 *
 * The local-FS branch is byte-for-byte identical behavior to the pre-batch
 * implementation: PRIVATE_AGENT_FILES under scope=agents go to
 * `localMemoryRoot/agents/<id>/<filename>` and never hit the DB.
 */
function resolveBackend(scope: MemoryScope, id: string, filename: string): ResolvedBackend {
  if (!SCOPES.includes(scope)) throw new MemoryError('invalid scope');
  if (scope === 'agents' && isPrivateAgentFile(filename)) {
    return { kind: 'local', dir: localAgentDir(id), filename };
  }
  return { kind: 'shared', scope, ownerId: safeId(id), filename };
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
  if (!SCOPES.includes(scope)) throw new MemoryError('invalid scope');

  // Shared metadata first — one query, no per-row content.
  const sharedMeta = MemoryRepo.list(scope);
  const merged = new Map<string, MemoryEntry>();
  for (const m of sharedMeta) {
    const entry = merged.get(m.ownerId) ?? {
      scope,
      id: m.ownerId,
      files: [],
    };
    entry.files.push({
      name: m.filename,
      size: m.sizeBytes,
      mtime: m.updatedAt,
      private: false,
    });
    merged.set(m.ownerId, entry);
  }

  // For the agents scope, also surface local-only personas/secrets that this
  // machine owns. Other scopes have no local tier — return shared as-is.
  if (scope === 'agents') {
    const localExists = await fs
      .access(config.localAgentsRoot)
      .then(() => true)
      .catch(() => false);
    if (localExists) {
      const dirEntries = await fs.readdir(config.localAgentsRoot, { withFileTypes: true });
      for (const d of dirEntries) {
        if (!d.isDirectory()) continue;
        const id = d.name;
        const dir = localAgentDir(id);
        const files = (await fs.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile());
        const fileMeta = await Promise.all(
          files.map(async (f) => {
            const stat = await fs.stat(path.join(dir, f.name));
            return {
              name: f.name,
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              private: true,
            };
          }),
        );
        const existing = merged.get(id);
        if (existing) existing.files.push(...fileMeta);
        else merged.set(id, { scope: 'agents', id, files: fileMeta });
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function readMemoryFile(
  scope: MemoryScope,
  id: string,
  file: string,
): Promise<{ content: string; private: boolean } | null> {
  const file_ = safeFile(file);
  const backend = resolveBackend(scope, id, file_);
  if (backend.kind === 'local') {
    try {
      const content = await fs.readFile(path.join(backend.dir, backend.filename), 'utf8');
      return { content, private: true };
    } catch {
      return null;
    }
  }
  const row = MemoryRepo.read(backend.scope, backend.ownerId, backend.filename);
  if (!row) return null;
  return { content: row.content, private: false };
}

export async function writeMemoryFile(
  scope: MemoryScope,
  id: string,
  file: string,
  content: string,
  updatedBy?: string | null,
): Promise<{ private: boolean }> {
  const id_ = safeId(id);
  const file_ = safeFile(file);
  if (scope === 'agents') assertAgentOwnership(id_);
  const backend = resolveBackend(scope, id_, file_);

  if (backend.kind === 'local') {
    await fs.mkdir(backend.dir, { recursive: true });
    await fs.writeFile(path.join(backend.dir, backend.filename), content, 'utf8');
    return { private: true };
  }
  MemoryRepo.write(backend.scope, backend.ownerId, backend.filename, content, updatedBy ?? null);
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
  const backend = resolveBackend(scope, id_, file_);
  if (backend.kind === 'local') {
    try {
      await fs.unlink(path.join(backend.dir, backend.filename));
    } catch (err) {
      // ENOENT on delete is a no-op — anything else is a real error and
      // should surface to the caller.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    return;
  }
  MemoryRepo.delete(backend.scope, backend.ownerId, backend.filename);
}

/**
 * Append a one-line interaction record for a Discord user. Stored as a
 * shared memory file `users/<id>/interactions.md` (markdown bullet list).
 *
 * Done as read-modify-write because MemoryRepo.write is an upsert; we
 * fetch the existing content first, append the line, write back. The
 * window is small (single tick of one user's chat thread); a full
 * concurrent-append story would require an append-only sub-table.
 */
export async function appendInteraction(
  discordUserId: string,
  entry: { ts: string; agent: string; channel?: string; summary: string },
): Promise<void> {
  const id_ = safeId(discordUserId);
  const filename = 'interactions.md';
  const existing = MemoryRepo.read('users', id_, filename);
  const line = `- **${entry.ts}** [${entry.agent}]${entry.channel ? ` (#${entry.channel})` : ''}: ${entry.summary}\n`;
  const next = (existing?.content ?? '') + line;
  MemoryRepo.write('users', id_, filename, next, entry.agent);
}

/**
 * Build a full prompt context. For owned agents, includes the local persona.
 * For other agents, only the public identity is read (we never have access
 * to a persona we don't own — it lives on the owner's machine).
 */
export async function buildContextForMessage(opts: {
  agentId: string;
  discordUserId?: string;
  channelId?: string;
  projectSlug?: string;
}): Promise<string> {
  const parts: string[] = [];

  const tryReadShared = (
    scope: MemoryScope,
    ownerId: string,
    filename: string,
    label: string,
  ): void => {
    const row = MemoryRepo.read(scope, ownerId, filename);
    if (row && row.content.trim().length > 0) {
      parts.push(`## ${label}\n${row.content.trim()}`);
    }
  };

  const tryReadLocal = async (filePath: string, label: string): Promise<void> => {
    try {
      const txt = await fs.readFile(filePath, 'utf8');
      if (txt.trim().length > 0) parts.push(`## ${label}\n${txt.trim()}`);
    } catch (err) {
      // ENOENT for an optional context file is expected; anything else
      // surfaces because it likely indicates a bind-mount or perm bug.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  };

  const agent = safeId(opts.agentId);
  tryReadShared('agents', agent, 'identity.md', `Agent identity: ${agent}`);
  // Persona is local-only — we have it iff this machine owns the agent.
  await tryReadLocal(
    path.join(config.localAgentsRoot, agent, 'persona.md'),
    `Agent persona (local): ${agent}`,
  );
  if (opts.discordUserId) {
    tryReadShared('users', safeId(opts.discordUserId), 'profile.md', `User profile: ${opts.discordUserId}`);
  }
  if (opts.channelId) {
    tryReadShared('threads', safeId(opts.channelId), 'recent.md', `Thread context: ${opts.channelId}`);
  }
  if (opts.projectSlug) {
    tryReadShared('projects', safeId(opts.projectSlug), 'notes.md', `Project notes: ${opts.projectSlug}`);
  }
  return parts.join('\n\n');
}
