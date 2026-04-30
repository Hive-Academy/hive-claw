/**
 * SQLite singleton wrapper around better-sqlite3.
 *
 * Connection topology (per implementation-plan.md §3, lines 396-412):
 *   - One write handle (`getDb()`) is the singleton, owns all writers
 *     (continuation tick, dispatch worker, HTTP write handlers).
 *   - One read-only handle (`getReadOnlyDb()`) is opened with
 *     `{ readonly: true, fileMustExist: true }` so that long dashboard
 *     reads never accidentally block the dispatch claim under WAL.
 *
 * Pragmas applied to the write handle on open (per implementation-plan.md
 * §2 lines 142-147):
 *   - journal_mode = WAL          // readers concurrent with writers
 *   - synchronous = NORMAL        // ~1 ms commit latency
 *   - foreign_keys = ON           // enforce ON DELETE CASCADE
 *   - busy_timeout = 5000         // tolerate WAL checkpoint stalls
 *   - temp_store = MEMORY         // small temp tables in RAM
 *
 * IMPORTANT: keep every write transaction under 50 ms.
 *   per implementation-plan.md §15 line 1262 — long writers block the
 *   dispatch claim. Repos must use `BEGIN IMMEDIATE … COMMIT` and at
 *   most 2-3 statements. The largest single write is `task_files.write`
 *   for an .md body — it is bounded to <1 MB by validation in TasksRepo.
 *   If you add a new write path, audit it against this checklist:
 *     1. Wraps multi-row updates in a single `db.transaction(...)`.
 *     2. No I/O (HTTP, FS) inside the transaction.
 *     3. Bounded payload size (no unconstrained user input).
 *     4. Prepared statements cached at module load (not per call).
 */

import BetterSqlite3, { type Database } from 'better-sqlite3';

interface DbHandles {
  path: string;
  write: Database;
  readOnly: Database | null;
}

let handles: DbHandles | null = null;

const PRAGMAS: readonly string[] = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'temp_store = MEMORY',
];

/**
 * Open or return the cached singleton write handle for the given path.
 *
 * Idempotent: a second call with the same path returns the cached handle.
 * Calling with a *different* path while a handle is already open throws —
 * the daemon is single-DB per process by design.
 */
export function openOnce(dbPath: string): Database {
  if (handles) {
    if (handles.path !== dbPath) {
      throw new Error(
        `db/client: already opened with path "${handles.path}", refusing to reopen with "${dbPath}"`,
      );
    }
    return handles.write;
  }
  const write = new BetterSqlite3(dbPath);
  for (const p of PRAGMAS) write.pragma(p);
  handles = { path: dbPath, write, readOnly: null };
  return write;
}

/**
 * Return the singleton write handle. Throws if `openOnce` has not run yet.
 */
export function getDb(): Database {
  if (!handles) {
    throw new Error('db/client: getDb() called before openOnce(). Run runMigrations() at boot.');
  }
  return handles.write;
}

/**
 * Return a read-only handle bound to the same path. Lazily created on
 * first call. Used by HTTP GET handlers so dashboard reads do not contend
 * for the writer's lock.
 */
export function getReadOnlyDb(): Database {
  if (!handles) {
    throw new Error('db/client: getReadOnlyDb() called before openOnce().');
  }
  if (!handles.readOnly) {
    handles.readOnly = new BetterSqlite3(handles.path, {
      readonly: true,
      fileMustExist: true,
    });
    // foreign_keys is a connection-local pragma; the read-only handle does
    // not need WAL configured (the writer set the journal mode for the file)
    // but does benefit from the same busy_timeout if a checkpoint stalls.
    handles.readOnly.pragma('busy_timeout = 5000');
  }
  return handles.readOnly;
}

/**
 * Close both handles. Used by tests and by graceful shutdown.
 */
export function closeAll(): void {
  if (!handles) return;
  try {
    handles.write.close();
  } finally {
    if (handles.readOnly) {
      try {
        handles.readOnly.close();
      } catch {
        // best-effort close on the read handle
      }
    }
    handles = null;
  }
}
