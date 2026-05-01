/**
 * T6.5 — failure counter / poison policy (defect C) + CD2 follow-up.
 *
 * Validates implementation-plan.md §7 lines 715-770. With
 * OPENCLAW_DISPATCH_FAILURE_THRESHOLD=3, the K-recent-failed window query
 * fires on the Kth consecutive failure for a given (project, task, phase):
 *
 *   - The current attempt (state='taken') is the most recent row in the
 *     `recent` window (LIMIT @threshold ORDER BY created_at DESC) but is
 *     NOT counted as failed.
 *   - When the (threshold - 1) prior rows are all 'failed', the count
 *     reaches threshold-1 and this attempt poisons.
 *
 * With threshold=3, that means: attempts 1 and 2 end in 'failed', attempt 3
 * ends in 'poisoned'. (§12.4 in implementation-plan reads "fourth" but is a
 * spec stub — the canonical text in §7 line 768 says "this is the Kth";
 * the implementation matches §7 and the SQL is `recentFailed >=
 * threshold - 1`, fired on the Kth attempt, not K+1th.)
 *
 * Acceptance criteria (T6.5):
 *   - The first (threshold - 1) attempts are 'failed'.
 *   - The Kth attempt is 'poisoned'.
 *   - The poisoned dispatch is absent from listPendingForAgents.
 *
 * CD2 (schema v2): the partial UNIQUE index `dispatches_unique_open` now
 * covers ('pending','taken','poisoned'). After a poison, the next
 * `insertPending` for the same (project, task, phase) MUST return null —
 * the runaway loop is closed at the schema layer. Operator recovery is via
 * `DELETE FROM dispatches WHERE state='poisoned' AND ...` (documented in
 * docs/TROUBLESHOOTING.md / docs/OPERATIONS.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Lock the threshold for this test file. failureThreshold() in
// db/dispatches.ts re-reads process.env on every call, so this is
// order-tolerant — but stamping early keeps the test self-documenting.
process.env.OPENCLAW_DISPATCH_FAILURE_THRESHOLD = '3';

import { setupTestDb } from './setup.ts';

const THRESHOLD = 3;

test(`K=${THRESHOLD} consecutive null-exit failures transition to poisoned, not failed`, () => {
  const t = setupTestDb();
  try {
    t.ProjectsRepo.upsert({ slug: 'pro-estates', name: 'pro-estates' });
    t.TasksRepo.insert({ projectSlug: 'pro-estates', id: 'TASK_2026_001' });

    const project = 'pro-estates';
    const task = 'TASK_2026_001';
    const phase = 'CONTEXT';

    // First (threshold - 1) attempts should each end in 'failed'.
    const failedIds: string[] = [];
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const id = t.DispatchRepo.insertPending({
        agentId: 'horus',
        projectSlug: project,
        taskId: task,
        phase,
        prompt: `attempt ${i + 1}`,
        createdBy: 'test',
      });
      assert.ok(id, `attempt ${i + 1}: insertPending must succeed (none open at this point)`);
      const claimed = t.DispatchRepo.claim(id, 'horus');
      assert.ok(claimed, `attempt ${i + 1}: claim must succeed`);
      const final = t.DispatchRepo.markDone(id, {
        exitCode: null,
        durationMs: 5,
        stderrSnippet: 'ptah stub',
      });
      assert.equal(
        final.state,
        'failed',
        `attempt ${i + 1}: must end in 'failed' (only ${i} prior failures, < K-1=${THRESHOLD - 1})`,
      );
      failedIds.push(id);
    }

    // The Kth attempt MUST poison. After threshold-1 'failed' rows exist,
    // the recent window query returns recentFailed = threshold-1, which
    // satisfies `recentFailed >= threshold - 1` and trips the poison branch.
    const idK = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: project,
      taskId: task,
      phase,
      prompt: `attempt ${THRESHOLD} (the poisoning one)`,
      createdBy: 'test',
    });
    assert.ok(idK, 'Kth insertPending must succeed (no open dispatch in flight)');
    const claimedK = t.DispatchRepo.claim(idK, 'horus');
    assert.ok(claimedK, 'Kth claim must succeed');
    const finalK = t.DispatchRepo.markDone(idK, { exitCode: null, durationMs: 5 });
    assert.equal(
      finalK.state,
      'poisoned',
      `Kth attempt MUST be 'poisoned' (defect-C policy fired with K=${THRESHOLD})`,
    );

    // Worker must refuse to claim — the poisoned row is no longer pending.
    const pending = t.DispatchRepo.listPendingForAgents(['horus']);
    assert.equal(
      pending.find((d) => d.id === idK),
      undefined,
      'listPendingForAgents must not return the poisoned dispatch',
    );

    // And critically, no OTHER row for the same (project, task, phase) is
    // pending — we ran a full lifecycle each time, so only 'failed' and
    // 'poisoned' terminal rows exist now.
    assert.equal(
      pending.filter(
        (d) => d.projectSlug === project && d.taskId === task && d.phase === phase,
      ).length,
      0,
      'no pending dispatch should exist for the poisoned (project, task, phase)',
    );

    // CD2: the partial UNIQUE index `dispatches_unique_open` was extended
    // in schema v2 to cover ('pending','taken','poisoned'). The runaway
    // loop is closed: a fresh insertPending for the same (project, task,
    // phase) MUST be deduped by the index and return null.
    const blocked = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: project,
      taskId: task,
      phase,
      prompt: 'after-poison continuation tick',
      createdBy: 'test',
    });
    assert.equal(
      blocked,
      null,
      'CD2: insertPending after poison must be null — partial UNIQUE index now covers `poisoned`',
    );

    // Operator recovery: DELETE the poisoned row, then a fresh
    // insertPending succeeds. This is the documented recovery flow in
    // docs/TROUBLESHOOTING.md and docs/OPERATIONS.md.
    t.db.prepare(
      `DELETE FROM dispatches
        WHERE state='poisoned'
          AND project_slug=@p
          AND task_id=@t
          AND phase=@ph`,
    ).run({ p: project, t: task, ph: phase });
    const recovered = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: project,
      taskId: task,
      phase,
      prompt: 'after-operator-recovery',
      createdBy: 'test',
    });
    assert.notEqual(
      recovered,
      null,
      'after operator clears the poisoned row, a fresh insertPending must succeed',
    );
  } finally {
    t.cleanup();
  }
});
