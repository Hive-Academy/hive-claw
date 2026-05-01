/**
 * Leader-mode Fastify worker for the follower-read smoke test.
 *
 * Spawned by `follower-read.test.ts` via `worker_threads`. Each worker
 * stamps its own env (OPENCLAW_LEADER=1 + an isolated DB path) BEFORE any
 * relative import, opens the DB, runs migrations, seeds a project + a
 * task, and starts a Fastify app on an ephemeral port. The port is sent
 * back to the parent through `parentPort.postMessage`.
 *
 * The parent then boots its own daemon in follower mode against that port
 * and asserts that every read endpoint returns 200 — the CD1 fix.
 *
 * Why a worker instead of `child_process.spawn`? worker_threads share the
 * `tsx` loader the parent already installed, so the worker compiles the
 * TS sources without spawning a fresh Node toolchain. Module state is
 * isolated per worker, which is what we need — the parent process boots
 * follower-mode config and never touches the DB.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
// Register tsx programmatically inside the worker. The `--import tsx`
// flag in the parent's node --test invocation does not propagate to
// worker_threads (their loader chain is separate), so we hook tsx here
// for the dynamic `await import('../src/...ts')` calls below.
import { register } from 'tsx/esm/api';
register();

interface LeaderWorkerInput {
  port?: number;
  agentId?: string;
  internalToken?: string;
  jwtSecret?: string;
}

if (!parentPort) {
  throw new Error('leader-worker: must be spawned via worker_threads');
}

const opts = (workerData ?? {}) as LeaderWorkerInput;

// Stamp env BEFORE any relative import — config.ts reads at module load.
process.env.OPENCLAW_LEADER = '1';
const dir = mkdtempSync(join(tmpdir(), 'openclaw-leader-worker-'));
const dbPath = join(dir, `specs-${randomUUID()}.db`);
process.env.OPENCLAW_SPECS_DB_PATH = dbPath;
process.env.OPENCLAW_INTERNAL_TOKEN = opts.internalToken ?? 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET = opts.jwtSecret ?? 'test-jwt-secret';
process.env.REDIS_URL = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';
process.env.OPENCLAW_LOCAL_AGENT_IDS = opts.agentId ?? '';

const { openOnce, getDb } = await import('../src/db/client.ts');
const { runMigrations } = await import('../src/db/migrations.ts');
const { ProjectsRepo } = await import('../src/db/projects.ts');
const { TasksRepo } = await import('../src/db/tasks.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');
const { buildApp } = await import('../src/api.ts');

openOnce(dbPath);
runMigrations(getDb());

// Seed: one project, one task with a context.md, one shared memory file.
ProjectsRepo.upsert({ slug: 'p1', name: 'p1' });
TasksRepo.insert({ projectSlug: 'p1', id: 'TASK_2026_001', title: 'smoke' });
TasksRepo.writeFile('p1', 'TASK_2026_001', 'context.md', '# smoke\n', 'leader-worker');
MemoryRepo.write('users', 'u1', 'profile.md', '# profile\n', 'leader-worker');

const app = buildApp();
await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 });
const addr = app.server.address();
if (!addr || typeof addr === 'string') {
  throw new Error('leader-worker: no server address');
}

parentPort.postMessage({ port: addr.port });

// Keep the worker alive until the parent posts 'shutdown'.
parentPort.on('message', async (msg: unknown) => {
  if (msg === 'shutdown') {
    try {
      await app.close();
    } catch {
      // best-effort
    }
    parentPort?.postMessage({ done: true });
    process.exit(0);
  }
});
