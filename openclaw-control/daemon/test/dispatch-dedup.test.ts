/**
 * T6.4 — dedup-via-schema regression.
 *
 * Validates the partial UNIQUE index `dispatches_unique_open` on
 * (project_slug, task_id, phase) WHERE state IN ('pending','taken')
 * (implementation-plan.md §2 lines 159-306, defect B).
 *
 * 100 sequential `insertPending` calls with the same (project, task, phase)
 * must yield exactly one non-null id. After the winner is moved to a
 * terminal state, the index allows a fresh open dispatch through with
 * a new id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from './setup.ts';

test('insertPending dedup is enforced by the partial UNIQUE index', () => {
  const t = setupTestDb();
  try {
    t.ProjectsRepo.upsert({ slug: 'p1', name: 'p1' });
    t.TasksRepo.insert({ projectSlug: 'p1', id: 't1' });

    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = t.DispatchRepo.insertPending({
        agentId: 'horus',
        projectSlug: 'p1',
        taskId: 't1',
        phase: 'PLAN',
        prompt: `attempt ${i}`,
        createdBy: 'test',
      });
      if (id !== null) ids.push(id);
    }
    assert.equal(ids.length, 1, 'exactly one of 100 sequential inserts should succeed');

    // Move the winner to terminal state. Need to claim first because
    // markDone requires state='taken'.
    const claimed = t.DispatchRepo.claim(ids[0], 'horus');
    assert.ok(claimed, 'claim of the unique winner must succeed');
    const final = t.DispatchRepo.markDone(ids[0], { exitCode: 0, durationMs: 100 });
    assert.equal(final.state, 'done');

    // 101st attempt with the same (project, task, phase) MUST succeed
    // because the partial index only forbids OPEN duplicates.
    const next = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'p1',
      taskId: 't1',
      phase: 'PLAN',
      prompt: 'after-terminal',
      createdBy: 'test',
    });
    assert.notEqual(next, null);
    assert.notEqual(next, ids[0], 'fresh dispatch must have a new id');
  } finally {
    t.cleanup();
  }
});
