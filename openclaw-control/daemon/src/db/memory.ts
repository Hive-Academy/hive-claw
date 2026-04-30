/**
 * MemoryRepo — typed repository for the SHARED tier of `memory_files`.
 *
 * PERSONA PRIVACY INVARIANT (defense-in-depth, per implementation-plan.md
 * §8 lines 815-817):
 *   The chokepoint at `daemon/src/memory.ts:resolveBackend` is supposed
 *   to route PRIVATE_AGENT_FILES to the local-FS backend so this repo
 *   should NEVER see them. If it does — that is a programming error
 *   worth crashing on. `write` and `delete` throw synchronously when
 *   given (scope='agents', filename ∈ PRIVATE_AGENT_FILES).
 *
 *   `PRIVATE_AGENT_FILES` is exported from this module as the single
 *   source of truth; `daemon/src/memory.ts` (Batch 2) imports it from
 *   here.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export type MemoryScope = 'agents' | 'users' | 'threads' | 'projects';

const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set([
  'agents',
  'users',
  'threads',
  'projects',
]);

/**
 * Files that hold per-machine private state for an agent (system prompts,
 * secrets). They live on the local FS only and must never enter the
 * shared `memory_files` table.
 */
export const PRIVATE_AGENT_FILES: ReadonlySet<string> = new Set([
  'persona.md',
  'secrets.md',
  'persona.json',
  'secrets.json',
]);

export interface MemoryFile {
  scope: MemoryScope;
  ownerId: string;
  filename: string;
  content: string;
  sizeBytes: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface MemoryFileMeta {
  scope: MemoryScope;
  ownerId: string;
  filename: string;
  sizeBytes: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface RawMemoryFileRow {
  scope: string;
  owner_id: string;
  filename: string;
  content: string;
  size_bytes: number;
  updated_at: string;
  updated_by: string | null;
}

interface Statements {
  read: Statement<{ scope: string; owner_id: string; filename: string }>;
  upsert: Statement<{
    scope: string;
    owner_id: string;
    filename: string;
    content: string;
    size_bytes: number;
    updated_by: string | null;
  }>;
  listScope: Statement<{ scope: string }>;
  listScopeOwner: Statement<{ scope: string; owner_id: string }>;
  delete: Statement<{ scope: string; owner_id: string; filename: string }>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  cached = {
    read: db.prepare(`
      SELECT scope, owner_id, filename, content, size_bytes, updated_at, updated_by
      FROM memory_files
      WHERE scope = @scope AND owner_id = @owner_id AND filename = @filename
    `),
    upsert: db.prepare(`
      INSERT INTO memory_files (
        scope, owner_id, filename, content, size_bytes, updated_by, updated_at
      ) VALUES (
        @scope, @owner_id, @filename, @content, @size_bytes, @updated_by,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
      ON CONFLICT(scope, owner_id, filename) DO UPDATE SET
        content = excluded.content,
        size_bytes = excluded.size_bytes,
        updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    listScope: db.prepare(`
      SELECT scope, owner_id, filename, size_bytes, updated_at, updated_by
      FROM memory_files
      WHERE scope = @scope
      ORDER BY owner_id ASC, filename ASC
    `),
    listScopeOwner: db.prepare(`
      SELECT scope, owner_id, filename, size_bytes, updated_at, updated_by
      FROM memory_files
      WHERE scope = @scope AND owner_id = @owner_id
      ORDER BY filename ASC
    `),
    delete: db.prepare(`
      DELETE FROM memory_files
      WHERE scope = @scope AND owner_id = @owner_id AND filename = @filename
    `),
  };
  return cached;
}

function assertScope(scope: MemoryScope): void {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`MemoryRepo: invalid scope "${String(scope)}"`);
  }
}

function assertNotPrivate(scope: MemoryScope, filename: string): void {
  if (scope === 'agents' && PRIVATE_AGENT_FILES.has(filename)) {
    // Synchronous, hard error: the caller bypassed `resolveBackend`.
    throw new Error(
      `private file routed to MemoryRepo: scope=agents filename=${filename}. ` +
        'PRIVATE_AGENT_FILES must go through the local-FS backend in memory.ts.',
    );
  }
}

function toScope(raw: string): MemoryScope {
  switch (raw) {
    case 'agents':
    case 'users':
    case 'threads':
    case 'projects':
      return raw;
    default:
      throw new Error(`MemoryRepo: invalid scope "${raw}" in row`);
  }
}

function toMemoryFile(raw: RawMemoryFileRow): MemoryFile {
  return {
    scope: toScope(raw.scope),
    ownerId: raw.owner_id,
    filename: raw.filename,
    content: raw.content,
    sizeBytes: raw.size_bytes,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by,
  };
}

function toMeta(raw: Omit<RawMemoryFileRow, 'content'>): MemoryFileMeta {
  return {
    scope: toScope(raw.scope),
    ownerId: raw.owner_id,
    filename: raw.filename,
    sizeBytes: raw.size_bytes,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by,
  };
}

export const MemoryRepo = {
  read(scope: MemoryScope, ownerId: string, filename: string): MemoryFile | null {
    assertScope(scope);
    // Reads of PRIVATE_AGENT_FILES against this repo must NOT fall through
    // to the table — even though the row should not exist, we return null
    // explicitly to avoid leaking any hypothetical existence signal.
    if (scope === 'agents' && PRIVATE_AGENT_FILES.has(filename)) {
      return null;
    }
    const raw = stmts().read.get({
      scope,
      owner_id: ownerId,
      filename,
    }) as RawMemoryFileRow | undefined;
    return raw ? toMemoryFile(raw) : null;
  },

  /**
   * Upsert a shared memory file. Throws synchronously if (scope, filename)
   * is in the persona-private allowlist — the chokepoint at memory.ts is
   * supposed to route those to local FS, so a hit here is a bug.
   */
  write(
    scope: MemoryScope,
    ownerId: string,
    filename: string,
    content: string,
    updatedBy?: string | null,
  ): { sizeBytes: number } {
    assertScope(scope);
    assertNotPrivate(scope, filename);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    stmts().upsert.run({
      scope,
      owner_id: ownerId,
      filename,
      content,
      size_bytes: sizeBytes,
      updated_by: updatedBy ?? null,
    });
    return { sizeBytes };
  },

  /**
   * List shared memory file metadata. Pass `ownerId` to limit the scan to
   * one owner. Returns ordered (owner_id, filename) for deterministic UI.
   */
  list(scope: MemoryScope, ownerId?: string): MemoryFileMeta[] {
    assertScope(scope);
    const rows = ownerId === undefined
      ? (stmts().listScope.all({ scope }) as Omit<RawMemoryFileRow, 'content'>[])
      : (stmts().listScopeOwner.all({ scope, owner_id: ownerId }) as Omit<RawMemoryFileRow, 'content'>[]);
    return rows.map(toMeta);
  },

  delete(scope: MemoryScope, ownerId: string, filename: string): void {
    assertScope(scope);
    assertNotPrivate(scope, filename);
    stmts().delete.run({
      scope,
      owner_id: ownerId,
      filename,
    });
  },
};

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetMemoryRepoForTests(): void {
  cached = null;
}
