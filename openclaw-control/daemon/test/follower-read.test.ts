/**
 * CD1 smoke — a follower (no local DB) serves read endpoints by relaying
 * to the leader through `leaderClient` via the storage facade.
 *
 * Before Batch 8 every `/api/projects`, `/api/tasks/:slug`, etc. on a
 * follower threw `Error: db/client: getDb() called before openOnce()`.
 * This test boots a real leader Fastify app in a worker_thread, then in
 * the main thread builds a follower-mode app (OPENCLAW_LEADER=0 +
 * OPENCLAW_LEADER_URL pointing at the leader) and asserts that every read
 * endpoint returns 200 with a non-error body.
 *
 * IMPORTANT: env must be stamped BEFORE any import that transitively
 * loads `../src/config.ts`. Because ESM imports are hoisted, we stamp at
 * the top of this file. Once `config.ts` runs in this process it is
 * locked into follower mode for the lifetime of this test file.
 *
 * The leader is hosted in a `worker_thread` so it has its own module
 * cache and runs in leader mode (OPENCLAW_LEADER=1) without polluting
 * the parent process's `config.leader = false` state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// FOLLOWER MODE — must be set before any relative import (config.ts reads
// env at module load and we want this process to come up as a follower).
process.env.OPENCLAW_LEADER = '0';
process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET = 'test-jwt-secret';
process.env.REDIS_URL = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';
// We stamp OPENCLAW_LEADER_URL with a placeholder; the test rewrites
// `client.baseUrl` after the leader-worker reports its bound port via
// `initLeaderClient()`. config.ts only validates non-empty at module load.
process.env.OPENCLAW_LEADER_URL = 'http://placeholder';

const here = dirname(fileURLToPath(import.meta.url));
const LEADER_WORKER_PATH = join(here, 'leader-worker.ts');

interface LeaderHandle {
  worker: Worker;
  port: number;
  shutdown: () => Promise<void>;
}

async function startLeaderWorker(): Promise<LeaderHandle> {
  const worker = new Worker(LEADER_WORKER_PATH, {
    execArgv: ['--import', 'tsx'],
    workerData: { agentId: 'horus' },
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      worker.off('message', onMessage);
      reject(err);
    };
    const onMessage = (msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'port' in msg &&
        typeof (msg as { port: unknown }).port === 'number'
      ) {
        worker.off('error', onError);
        resolve((msg as { port: number }).port);
      }
    };
    worker.once('error', onError);
    worker.on('message', onMessage);
  });

  return {
    worker,
    port,
    async shutdown() {
      await new Promise<void>((resolve) => {
        const onMessage = (msg: unknown) => {
          if (
            typeof msg === 'object' &&
            msg !== null &&
            'done' in msg
          ) {
            worker.off('message', onMessage);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.postMessage('shutdown');
        // Belt-and-braces: terminate after a short grace period.
        setTimeout(() => {
          worker.terminate().then(() => resolve(), () => resolve());
        }, 1500).unref?.();
      });
    },
  };
}

test('follower can serve read endpoints by relaying to the leader (CD1)', async () => {
  const leader = await startLeaderWorker();
  // Configure the leaderClient AFTER we know the port. config.leaderUrl is
  // a snapshot from module load, but initLeaderClient takes the actual
  // baseUrl as an argument so we can rewrite it here.
  const baseUrl = `http://127.0.0.1:${leader.port}`;
  const { initLeaderClient } = await import('../src/leaderClient.ts');
  initLeaderClient(baseUrl, 'test-internal-token');

  const { buildApp } = await import('../src/api.ts');
  const { config } = await import('../src/config.ts');

  // Sanity: this process is in follower mode.
  assert.equal(config.leader, false, 'this process must be follower-mode');

  const app = buildApp();
  try {
    const headers = { authorization: 'Bearer test-internal-token' };

    // 1. /api/projects — was the canonical regression: getDb() crash.
    const r1 = await app.inject({ method: 'GET', url: '/api/projects', headers });
    assert.equal(
      r1.statusCode,
      200,
      `follower /api/projects must be 200, got ${r1.statusCode}: ${r1.body}`,
    );
    const projects = JSON.parse(r1.body) as Array<{ slug: string }>;
    assert.ok(
      projects.some((p) => p.slug === 'p1'),
      'follower must surface the leader-seeded project',
    );

    // 2. /api/projects/:slug/tasks — also hit getDb in the old path.
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/projects/p1/tasks',
      headers,
    });
    assert.equal(r2.statusCode, 200, `tasks list must be 200, got ${r2.statusCode}`);
    const tasks = JSON.parse(r2.body) as Array<{ id: string }>;
    assert.ok(
      tasks.some((t) => t.id === 'TASK_2026_001'),
      'follower must surface seeded task',
    );

    // 3. /api/projects/:slug/tasks/:taskId — task detail with artifacts.
    const r3 = await app.inject({
      method: 'GET',
      url: '/api/projects/p1/tasks/TASK_2026_001',
      headers,
    });
    assert.equal(r3.statusCode, 200, `task detail must be 200, got ${r3.statusCode}`);
    const detail = JSON.parse(r3.body) as { id: string; artifacts: Record<string, string> };
    assert.equal(detail.id, 'TASK_2026_001');
    assert.ok(
      'context.md' in detail.artifacts,
      'task detail must include context.md from leader',
    );

    // 4. /api/projects/:slug/tasks/:taskId/files — file listing.
    const r4 = await app.inject({
      method: 'GET',
      url: '/api/projects/p1/tasks/TASK_2026_001/files',
      headers,
    });
    assert.equal(r4.statusCode, 200, `files list must be 200, got ${r4.statusCode}`);

    // 5. /api/memories/:scope/:id/:file — non-private memory file.
    const r5 = await app.inject({
      method: 'GET',
      url: '/api/memories/users/u1/profile.md',
      headers,
    });
    assert.equal(r5.statusCode, 200, `memory read must be 200, got ${r5.statusCode}`);
    const mem = JSON.parse(r5.body) as { content: string };
    assert.ok(mem.content.includes('profile'), 'must surface leader content');

    // 6. /api/memories/agents/:id/persona.md — privacy gate (404, NOT 403).
    const r6 = await app.inject({
      method: 'GET',
      url: '/api/memories/agents/horus/persona.md',
      headers,
    });
    assert.equal(
      r6.statusCode,
      404,
      'follower must apply persona-privacy gate locally — 404 (not 403, not 500)',
    );

    // 7. /api/agents — list of agents.
    const r7 = await app.inject({ method: 'GET', url: '/api/agents', headers });
    assert.equal(r7.statusCode, 200, `agents list must be 200, got ${r7.statusCode}`);

    // 8. /api/dispatches — listing (the old direct getReadOnlyDb path).
    const r8 = await app.inject({ method: 'GET', url: '/api/dispatches', headers });
    assert.equal(r8.statusCode, 200, `dispatches list must be 200, got ${r8.statusCode}`);

    // 9. /api/dispatches/pending — slim shape relay.
    const r9 = await app.inject({
      method: 'GET',
      url: '/api/dispatches/pending?agentIds=horus',
      headers,
    });
    assert.equal(
      r9.statusCode,
      200,
      `pending list must be 200, got ${r9.statusCode}`,
    );
  } finally {
    try {
      await app.close();
    } catch {
      // best-effort
    }
    await leader.shutdown();
  }
});
