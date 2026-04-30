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
 *   - Read the highest applied version. If it equals CURRENT_VERSION, return.
 *   - Otherwise apply each statement in SCHEMA_V1 in order, then INSERT
 *     the version row. Wrap the whole step in a single transaction so a
 *     mid-migration crash leaves the DB unchanged.
 */

import type { Database } from 'better-sqlite3';
import { openOnce, closeAll } from './client.js';
import { CURRENT_VERSION, SCHEMA_V1 } from './schema.js';

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
 * Apply all missing migrations up to CURRENT_VERSION. Idempotent.
 *
 * Throws if a CREATE statement fails — the partially-applied transaction
 * is rolled back automatically by better-sqlite3's transaction wrapper.
 */
export function runMigrations(db: Database): void {
  const have = currentVersion(db);
  if (have >= CURRENT_VERSION) return;

  // We have only a single revision so far (V1). Every statement in
  // SCHEMA_V1 plus the version-row insert run in one transaction.
  const apply = db.transaction((statements: readonly string[]) => {
    for (let i = 0; i < statements.length; i++) {
      try {
        db.exec(statements[i]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`migration step ${i + 1}/${statements.length} failed: ${message}`);
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION);
  });

  apply(SCHEMA_V1);
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
