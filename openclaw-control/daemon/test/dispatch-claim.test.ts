/**
 * T6.2 — concurrent claim.
 *
 * Validates the linearization point in §4 lines 521-528: a single
 * `UPDATE dispatches SET state='taken' WHERE id=? AND state='pending'
 * RETURNING *` is the canonical claim. Under WAL, exactly one of N
 * concurrent claims for the same row must win.
 *
 * Two flavours:
 *  1. In-process: 50 parallel `DispatchRepo.claim()` calls. Even though
 *     better-sqlite3 is synchronous (calls serialise on the JS thread),
 *     the assertion still tests the WHERE-clause guard: 49 calls must
 *     observe state ≠ 'pending' and return null.
 *  2. Cross-process: 8 worker_threads × 10 attempts each (80 total)
 *     racing against the same on-disk SQLite file. Each worker opens its
 *     own better-sqlite3 handle. Exactly one winner across the 80.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setupTestDb } from './setup.ts';

test('in-process: exactly one of 50 concurrent claims wins', async () => {
  const t = setupTestDb();
  try {
    t.ProjectsRepo.upsert({ slug: 'pA', name: 'pA' });
    t.TasksRepo.insert({ projectSlug: 'pA', id: 'T1' });

    const id = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'pA',
      taskId: 'T1',
      phase: 'CONTEXT',
      prompt: 'race',
      createdBy: 'test',
    });
    assert.ok(id, 'seed insertPending should return an id');

    const claimerIds = Array.from({ length: 50 }, (_, i) => `claimer-${i}`);
    const results = await Promise.all(
      claimerIds.map((c) => Promise.resolve().then(() => t.DispatchRepo.claim(id, c))),
    );
    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1, '50 in-process claims must produce exactly one winner');

    const row = t.DispatchRepo.getById(id);
    assert.ok(row, 'row must still exist');
    assert.equal(row.state, 'taken');
    assert.match(row.claimedBy ?? '', /^claimer-\d+$/);
    // Sanity: the surviving winner row matches the recorded claimedBy.
    assert.equal(winners[0]!.claimedBy, row.claimedBy);
  } finally {
    t.cleanup();
  }
});

test('cross-process: exactly one of 80 worker_thread claims wins', async () => {
  const t = setupTestDb();
  try {
    t.ProjectsRepo.upsert({ slug: 'pA', name: 'pA' });
    t.TasksRepo.insert({ projectSlug: 'pA', id: 'T1' });
    const id = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'pA',
      taskId: 'T1',
      phase: 'CONTEXT',
      prompt: 'cross-race',
      createdBy: 'test',
    });
    assert.ok(id, 'seed insertPending should return an id');

    // Close the parent's write handles BEFORE spawning workers, so they
    // do not contend with a held WAL lock on the same process. The DB
    // file remains; each worker reopens it.
    const dbPath = t.dbPath;
    t.cleanup(); // drops parent handles (cleanup deletes the dir AFTER closing)

    // Re-create the dir/file? cleanup() rmSync'd the directory. We have to
    // reorder: don't call cleanup until after workers finish. Reopen the
    // db is unnecessary because workers each open their own handle.
    // Strategy: setup again WITHOUT cleanup, but keep the existing file.
    // Since cleanup() already removed the file, we must instead avoid the
    // parent close path. Re-do via a different path:
    //
    // (handle reset) — open a fresh test db here and run workers against it.
  } finally {
    // already cleaned in the test body
  }

  // The "close-before-spawn" approach above is fragile. The clean version:
  // open a fresh tempdir, do NOT call cleanup until workers finish.
  const t2 = setupTestDb();
  try {
    t2.ProjectsRepo.upsert({ slug: 'pA', name: 'pA' });
    t2.TasksRepo.insert({ projectSlug: 'pA', id: 'T1' });
    const id = t2.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'pA',
      taskId: 'T1',
      phase: 'CONTEXT',
      prompt: 'cross-race',
      createdBy: 'test',
    });
    assert.ok(id, 'seed insertPending should return an id');

    const here = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(here, 'worker-claim.ts');

    const NUM_WORKERS = 8;
    const ATTEMPTS_PER_WORKER = 10;

    const promises: Promise<{ winners: number }>[] = [];
    for (let w = 0; w < NUM_WORKERS; w++) {
      promises.push(
        new Promise((resolve, reject) => {
          // node:test was started with --import tsx, so the loader is
          // installed in the parent. Workers inherit execArgv via
          // `process.execArgv`, but to be explicit we pass --import tsx.
          const worker = new Worker(workerPath, {
            execArgv: ['--import', 'tsx'],
            workerData: {
              dbPath: t2.dbPath,
              dispatchId: id,
              workerIndex: w,
              attempts: ATTEMPTS_PER_WORKER,
            },
          });
          worker.once('message', (msg: { winners: number }) => resolve(msg));
          worker.once('error', reject);
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`worker exit ${code}`));
          });
        }),
      );
    }

    const results = await Promise.all(promises);
    const totalWinners = results.reduce((s, r) => s + r.winners, 0);
    assert.equal(
      totalWinners,
      1,
      `8 workers × 10 attempts must yield exactly one winner, got ${totalWinners}`,
    );

    const row = t2.DispatchRepo.getById(id);
    assert.ok(row, 'row must still exist after the race');
    assert.equal(row.state, 'taken');
    assert.match(row.claimedBy ?? '', /^worker-\d+-attempt-\d+$/);
  } finally {
    t2.cleanup();
  }
});
