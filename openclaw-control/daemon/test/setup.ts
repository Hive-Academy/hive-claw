/**
 * Shared test bootstrap for the daemon test suite.
 *
 * Test runner: `node --test --import tsx test/<file>.test.ts`
 * (chosen because the daemon already depends on `tsx` for `dev`; no new
 * dev dependencies required, no test framework to vendor.)
 *
 * Each test file is isolated by `node --test`'s default per-file worker
 * subprocess, which is why module-level singletons (`db/client.ts`,
 * cached prepared statements in repos) are safe to reset per file.
 *
 * IMPORTANT: this module mutates `process.env` at top level. It must be
 * imported before any module that reads from `./src/config.ts` (which
 * throws on follower mode without OPENCLAW_LEADER_URL). Tests that need
 * the daemon's HTTP routes import this first; tests that only touch
 * repos still benefit from the isolated DB harness.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Make config.ts happy. Set BEFORE any import of ../src/config.js (transitively).
process.env.OPENCLAW_LEADER = '1';
process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET = process.env.OPENCLAW_JWT_SECRET ?? 'test-jwt-secret';
// Empty REDIS_URL so bus.ts does not actually connect.
process.env.REDIS_URL = '';
// Empty DISCORD_CLIENT_ID/SECRET so isOAuthConfigured() returns false.
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
// Disable the continuation loop side-effect in case anything boots it.
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';

import { openOnce, closeAll, getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { ProjectsRepo, _resetProjectsRepoForTests } from '../src/db/projects.js';
import { TasksRepo, _resetTasksRepoForTests } from '../src/db/tasks.js';
import { DispatchRepo, _resetDispatchRepoForTests } from '../src/db/dispatches.js';
import { MemoryRepo, _resetMemoryRepoForTests } from '../src/db/memory.js';

export interface TestDbHandle {
  /** Absolute path to the on-disk SQLite file. */
  dbPath: string;
  /** Repos rebound against the freshly-opened DB. */
  ProjectsRepo: typeof ProjectsRepo;
  TasksRepo: typeof TasksRepo;
  DispatchRepo: typeof DispatchRepo;
  MemoryRepo: typeof MemoryRepo;
  /** Raw write handle; useful for direct SELECTs in assertions. */
  db: ReturnType<typeof getDb>;
  /** Closes handles and removes the temp directory. */
  cleanup(): void;
}

/**
 * Open a fresh SQLite file in a unique tmpdir, run migrations, and return
 * the bound repos plus a cleanup hook.
 *
 * Uses a real on-disk file (not `:memory:`) because the cross-process
 * concurrent-claim test needs a path workers can each open; making the
 * helper consistent avoids accidental in-memory shortcuts.
 *
 * `OPENCLAW_SPECS_DB_PATH` is also set to this path so any code that
 * reads `config.dbPath` at boot picks it up; that env mutation is benign
 * because each test file runs in its own subprocess.
 */
export function setupTestDb(): TestDbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-test-'));
  const dbPath = join(dir, `specs-${randomUUID()}.db`);
  process.env.OPENCLAW_SPECS_DB_PATH = dbPath;

  // Reset cached prepared statements from any previous setupTestDb call in
  // the same process (e.g. when a single test file calls setupTestDb twice).
  _resetDispatchRepoForTests();
  _resetMemoryRepoForTests();
  _resetProjectsRepoForTests();
  _resetTasksRepoForTests();

  openOnce(dbPath);
  runMigrations(getDb());

  return {
    dbPath,
    ProjectsRepo,
    TasksRepo,
    DispatchRepo,
    MemoryRepo,
    db: getDb(),
    cleanup() {
      try {
        closeAll();
      } finally {
        _resetDispatchRepoForTests();
        _resetMemoryRepoForTests();
        _resetProjectsRepoForTests();
        _resetTasksRepoForTests();
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    },
  };
}
