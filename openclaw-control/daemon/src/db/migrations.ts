/**
 * Schema migrator.
 *
 * Two entry points:
 *   1. `runMigrations(db)` — programmatic, called from the daemon boot.
 *   2. ESM CLI — invoked from `entrypoint-control.sh` (per implementation-plan.md
 *      §11 lines 1043-1054):
 *
 *        node dist/db/migrations.js /path/to/specs.db
 *
 * The migrator is idempotent: running twice on a fresh DB applies the
 * statements once, the second call is a no-op.
 *
 * Strategy:
 *   - Open / create the database file at the given path via openOnce().
 *   - Ensure schema_version exists.
 *   - Read the highest applied version. For each missing version, apply
 *     its step in a single transaction and INSERT the version row.
 *
 * Versions:
 *   v1 → fresh-DB schema (SCHEMA_V1).
 *   v2 → drop+recreate `dispatches_unique_open` so it covers
 *        ('pending','taken','poisoned') instead of ('pending','taken').
 *        Closes the runaway-loop CD2 from code-logic-review.md.
 */

import type { Database } from 'better-sqlite3';
import { openOnce, closeAll } from './client.js';
import { CURRENT_VERSION, SCHEMA_V1, SCHEMA_V3 } from './schema.js';

function hasSchemaVersionTable(db: Database): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
    )
    .get() as { name: string } | undefined;
  return Boolean(row);
}

function currentVersion(db: Database): number {
  if (!hasSchemaVersionTable(db)) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/**
 * Apply the v0 → v1 step (fresh DB): every CREATE in SCHEMA_V1, then mark v1.
 */
function applyV1(db: Database): void {
  const apply = db.transaction((statements: readonly string[]) => {
    for (let i = 0; i < statements.length; i++) {
      try {
        db.exec(statements[i]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`migration v1 step ${i + 1}/${statements.length} failed: ${message}`);
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  });
  apply(SCHEMA_V1);
}

/**
 * Apply the v1 → v2 step: drop + recreate `dispatches_unique_open` so the
 * partial UNIQUE index also covers `poisoned`. SQLite supports
 * DROP INDEX + CREATE INDEX inside a transaction; the rebuild is fast
 * because the index is small (open dispatches only).
 */
function applyV2(db: Database): void {
  const apply = db.transaction(() => {
    try {
      db.exec(`DROP INDEX IF EXISTS dispatches_unique_open`);
      db.exec(
        `CREATE UNIQUE INDEX dispatches_unique_open
           ON dispatches(project_slug, task_id, phase)
           WHERE state IN ('pending','taken','poisoned')`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`migration v2 (dispatches_unique_open rebuild) failed: ${message}`);
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
  });
  apply();
}

/**
 * Apply the v2 → v3 step: additive — create the `extension_install_requests`
 * table plus its two indexes. Backs TASK_2026_006 Batch 8b (plugin/MCP
 * self-extension feature, amendment-1 §16.2). Each CREATE runs inside the
 * same transaction as the version-row insert so a mid-step crash leaves
 * the DB at v2.
 */
function applyV3(db: Database): void {
  const apply = db.transaction((statements: readonly string[]) => {
    for (let i = 0; i < statements.length; i++) {
      try {
        db.exec(statements[i]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`migration v3 step ${i + 1}/${statements.length} failed: ${message}`);
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
  });
  apply(SCHEMA_V3);
}

/**
 * Apply all missing migrations up to CURRENT_VERSION. Idempotent.
 *
 * Each step's CREATE/DROP and the version-row insert run in a single
 * transaction, so a mid-step crash leaves the DB at the prior version.
 */
export function runMigrations(db: Database): void {
  let have = currentVersion(db);
  if (have >= CURRENT_VERSION) return;

  if (have < 1) {
    applyV1(db);
    have = 1;
  }
  if (have < 2) {
    applyV2(db);
    have = 2;
  }
  if (have < 3) {
    applyV3(db);
    have = 3;
  }
  // Future: if (have < 4) applyV4(db); ...
}

/**
 * CLI entrypoint — runs migrations against the path given as argv[2].
 *
 * Detection: `process.argv[1]` ends with `migrations.js` (after `tsc`) or
 * `migrations.ts` (under `tsx`). This survives both `node dist/db/migrations.js`
 * and direct `tsx src/db/migrations.ts` invocations.
 */
function isCliEntrypoint(): boolean {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('migrations.js') || arg1.endsWith('migrations.ts');
}

if (isCliEntrypoint()) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    process.stderr.write('usage: node dist/db/migrations.js <db-path>\n');
    process.exit(1);
  }
  try {
    const db = openOnce(dbPath);
    runMigrations(db);
    process.stdout.write(`migrations applied: schema_version=${CURRENT_VERSION} db=${dbPath}\n`);
    closeAll();
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`migrations failed: ${message}\n`);
    try {
      closeAll();
    } catch {
      // best-effort close on the way out
    }
    process.exit(1);
  }
}
