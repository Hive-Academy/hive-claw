/**
 * T6.6 — phase derivation regression.
 *
 * The pre-Batch-2 daemon walked the FS to derive a task's current phase
 * (the original `phase.ts:detectPhase`). Batch 2 ported that logic into
 * `db/tasks.ts:deriveCurrentPhase` as a pure function over (filenames,
 * tasksMd). This test pins down the mapping rules so any future refactor
 * cannot silently drift.
 *
 * Coverage: at least one fixture per Phase value the function can return:
 *   - DONE         (future-enhancements.md present)
 *   - IN_PROGRESS  (any tasks.md row marked IN_PROGRESS / IN PROGRESS)
 *   - QA_DONE      (every tasks.md row marked COMPLETE, ≥ 1 row)
 *   - IMPLEMENTED  (any tasks.md row marked IMPLEMENTED, none IN_PROGRESS)
 *   - PENDING      (any tasks.md row marked PENDING, none above)
 *   - PLAN         (implementation-plan.md present, no qualifying tasks.md)
 *   - DESCRIPTION  (task-description.md present, no plan, no qualifying tasks.md)
 *   - CONTEXT      (only context.md)
 *   - UNKNOWN      (no recognised file at all)
 *
 * Note: the function does NOT emit COMPLETE on its own — that is a
 * post-QA_DONE / DONE state set by other code paths (orchestration). The
 * fixture set therefore omits COMPLETE.
 *
 * Pure-function tests; no DB, no FS — fast.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePhase, type Phase } from '../src/phase.ts';

interface Fixture {
  name: string;
  filenames: string[];
  tasksMd?: string;
  expected: Phase;
}

const TASKS_MD_IN_PROGRESS = `
- [ ] **PENDING** something
- [-] **IN_PROGRESS** the active item
- [ ] **PENDING** later item
`.trim();

const TASKS_MD_IN_PROGRESS_SPACE = `
- [-] **IN PROGRESS** spelled with a space
`.trim();

const TASKS_MD_ALL_COMPLETE = `
- [x] **COMPLETE** first
- [x] **COMPLETE** second
`.trim();

const TASKS_MD_IMPLEMENTED = `
- [ ] **PENDING** A
- [x] **IMPLEMENTED** B
- [ ] **PENDING** C
`.trim();

const TASKS_MD_PENDING_ONLY = `
- [ ] **PENDING** A
- [ ] **PENDING** B
`.trim();

const FIXTURES: Fixture[] = [
  {
    name: 'DONE: future-enhancements.md present overrides everything',
    filenames: [
      'context.md',
      'task-description.md',
      'implementation-plan.md',
      'tasks.md',
      'future-enhancements.md',
    ],
    tasksMd: TASKS_MD_IN_PROGRESS,
    expected: 'DONE',
  },
  {
    name: 'IN_PROGRESS: any IN_PROGRESS row wins over PENDING/IMPLEMENTED',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md', 'tasks.md'],
    tasksMd: TASKS_MD_IN_PROGRESS,
    expected: 'IN_PROGRESS',
  },
  {
    name: 'IN_PROGRESS: also matches the "IN PROGRESS" spelling with a space',
    filenames: ['context.md', 'tasks.md'],
    tasksMd: TASKS_MD_IN_PROGRESS_SPACE,
    expected: 'IN_PROGRESS',
  },
  {
    name: 'QA_DONE: every row COMPLETE and at least one row',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md', 'tasks.md'],
    tasksMd: TASKS_MD_ALL_COMPLETE,
    expected: 'QA_DONE',
  },
  {
    name: 'IMPLEMENTED: any IMPLEMENTED row, no IN_PROGRESS, not all COMPLETE',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md', 'tasks.md'],
    tasksMd: TASKS_MD_IMPLEMENTED,
    expected: 'IMPLEMENTED',
  },
  {
    name: 'PENDING: only PENDING rows in tasks.md',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md', 'tasks.md'],
    tasksMd: TASKS_MD_PENDING_ONLY,
    expected: 'PENDING',
  },
  {
    name: 'PLAN: implementation-plan.md present, no qualifying tasks.md states',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md'],
    expected: 'PLAN',
  },
  {
    name: 'PLAN: tasks.md exists but has no recognised state markers',
    filenames: ['context.md', 'task-description.md', 'implementation-plan.md', 'tasks.md'],
    tasksMd: '## TODO\n\n- nothing structured here',
    expected: 'PLAN',
  },
  {
    name: 'DESCRIPTION: task-description.md present, no implementation-plan.md',
    filenames: ['context.md', 'task-description.md'],
    expected: 'DESCRIPTION',
  },
  {
    name: 'CONTEXT: only context.md',
    filenames: ['context.md'],
    expected: 'CONTEXT',
  },
  {
    name: 'UNKNOWN: empty filename set',
    filenames: [],
    expected: 'UNKNOWN',
  },
  {
    name: 'UNKNOWN: only an unrecognised file',
    filenames: ['random.md'],
    expected: 'UNKNOWN',
  },
];

for (const f of FIXTURES) {
  test(`derivePhase: ${f.name}`, () => {
    const out = derivePhase(new Set(f.filenames), f.tasksMd ?? null);
    assert.equal(out, f.expected, `expected ${f.expected}, got ${out}`);
  });
}

// Sanity: every Phase the function can produce has at least one fixture.
test('fixture coverage: every Phase the function emits has a fixture', () => {
  const expectedPhases = new Set<Phase>([
    'CONTEXT',
    'DESCRIPTION',
    'PLAN',
    'PENDING',
    'IN_PROGRESS',
    'IMPLEMENTED',
    'QA_DONE',
    'DONE',
    'UNKNOWN',
  ]);
  const covered = new Set<Phase>(FIXTURES.map((f) => f.expected));
  for (const p of expectedPhases) {
    assert.ok(covered.has(p), `no fixture for Phase=${p}`);
  }
});
