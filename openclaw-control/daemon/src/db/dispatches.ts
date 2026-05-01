/**
 * DispatchRepo — typed repository for `dispatches` and `dispatch_log`.
 *
 * Two bug fixes are encoded here:
 *
 * Defect B (continuation duplicates):
 *   `insertPending` is `INSERT … ON CONFLICT DO NOTHING RETURNING id`.
 *   The partial UNIQUE index `dispatches_unique_open` on
 *   (project_slug, task_id, phase) WHERE state IN ('pending','taken')
 *   makes the duplicate unrepresentable. Returns null on dedup hit;
 *   continuation loop treats null as "skipped, duplicate already open".
 *
 * Defect C (poison policy):
 *   `markDone` runs the K-recent-failed window query from
 *   implementation-plan.md §7 lines 760-770 inside a transaction:
 *
 *     WITH recent AS (
 *       SELECT state FROM dispatches
 *        WHERE project_slug = ? AND task_id = ? AND phase = ?
 *        ORDER BY created_at DESC LIMIT @threshold
 *     )
 *     SELECT COUNT(*) FROM recent WHERE state = 'failed';
 *
 *   If the count = (threshold - 1), this attempt becomes the Kth and
 *   transitions to `poisoned` rather than `failed`.
 *
 * Linearization point (per implementation-plan.md §4 lines 521-528):
 *   `claim(id, claimedBy)` is a SINGLE prepared `UPDATE … RETURNING *`
 *   statement. Not a SELECT-then-UPDATE chain. Under WAL mode the single
 *   statement is the linearization point; concurrent claims of the same
 *   row converge to exactly one winner.
 */

import { randomUUID } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export type DispatchState = 'pending' | 'taken' | 'done' | 'failed' | 'poisoned';
const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set(['done', 'failed', 'poisoned']);

export function isTerminalState(s: DispatchState): boolean {
  return TERMINAL_STATES.has(s);
}

/**
 * Typed error classes for dispatch state transitions. The HTTP layer uses
 * `instanceof` checks to map these to 404 / 409 — string-prefix matching
 * was fragile (cf. code-style-review.md S4 / code-logic-review.md LG4).
 */
export class UnknownDispatchError extends Error {
  readonly dispatchId: string;
  constructor(dispatchId: string) {
    super(`unknown dispatch ${dispatchId}`);
    this.name = 'UnknownDispatchError';
    this.dispatchId = dispatchId;
  }
}

export class DispatchStateError extends Error {
  readonly dispatchId: string;
  readonly state: DispatchState;
  readonly operation: string;
  constructor(operation: string, dispatchId: string, state: DispatchState) {
    super(`${operation}: cannot complete from state=${state}`);
    this.name = 'DispatchStateError';
    this.dispatchId = dispatchId;
    this.state = state;
    this.operation = operation;
  }
}

export interface Dispatch {
  id: string;
  projectSlug: string;
  taskId: string;
  phase: string;
  agentId: string;
  prompt: string;
  state: DispatchState;
  failureCount: number;
  exitCode: number | null;
  durationMs: number | null;
  stderrSnippet: string | null;
  createdBy: string;
  claimedBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

interface RawDispatchRow {
  id: string;
  project_slug: string;
  task_id: string;
  phase: string;
  agent_id: string;
  prompt: string;
  state: string;
  failure_count: number;
  exit_code: number | null;
  duration_ms: number | null;
  stderr_snippet: string | null;
  created_by: string;
  claimed_by: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface InsertPendingOptions {
  agentId: string;
  projectSlug: string;
  taskId: string;
  phase: string;
  prompt: string;
  createdBy: string;
}

export interface MarkDoneInput {
  exitCode: number | null;
  durationMs: number;
  stderrSnippet?: string | null;
}

interface Statements {
  insertPending: Statement<{
    id: string;
    project_slug: string;
    task_id: string;
    phase: string;
    agent_id: string;
    prompt: string;
    created_by: string;
  }>;
  claim: Statement<{ id: string; claimed_by: string }>;
  getById: Statement<{ id: string }>;
  markDoneOk: Statement<{
    id: string;
    exit_code: number | null;
    duration_ms: number;
    stderr_snippet: string | null;
  }>;
  markFailed: Statement<{
    id: string;
    failure_count: number;
    exit_code: number | null;
    duration_ms: number;
    stderr_snippet: string | null;
  }>;
  markPoisoned: Statement<{
    id: string;
    failure_count: number;
    exit_code: number | null;
    duration_ms: number;
    stderr_snippet: string | null;
  }>;
  countRecentFailed: Statement<{
    project_slug: string;
    task_id: string;
    phase: string;
    threshold: number;
  }>;
  incrementFailureCount: Statement<{ id: string }>;
  listPendingAll: Statement<[]>;
  listForTask: Statement<{ project_slug: string; task_id: string }>;
  appendLog: Statement<{
    dispatch_id: string;
    level: string;
    host: string | null;
    message: string;
  }>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  cached = {
    // ON CONFLICT DO NOTHING covers both PRIMARY KEY collisions (id reuse,
    // unlikely given the random suffix) and the partial UNIQUE index on
    // open dispatches. RETURNING is empty when the conflict suppresses
    // the insert — that is the dedup signal.
    insertPending: db.prepare(`
      INSERT INTO dispatches (
        id, project_slug, task_id, phase, agent_id, prompt, state, created_by
      ) VALUES (
        @id, @project_slug, @task_id, @phase, @agent_id, @prompt, 'pending', @created_by
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `),

    // Single-statement linearization point: §4 lines 521-528.
    claim: db.prepare(`
      UPDATE dispatches
         SET state = 'taken',
             claimed_by = @claimed_by,
             claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
         AND state = 'pending'
      RETURNING *
    `),

    getById: db.prepare(`SELECT * FROM dispatches WHERE id = @id`),

    markDoneOk: db.prepare(`
      UPDATE dispatches
         SET state = 'done',
             exit_code = @exit_code,
             duration_ms = @duration_ms,
             stderr_snippet = @stderr_snippet,
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
    `),

    markFailed: db.prepare(`
      UPDATE dispatches
         SET state = 'failed',
             failure_count = @failure_count,
             exit_code = @exit_code,
             duration_ms = @duration_ms,
             stderr_snippet = @stderr_snippet,
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
    `),

    markPoisoned: db.prepare(`
      UPDATE dispatches
         SET state = 'poisoned',
             failure_count = @failure_count,
             exit_code = @exit_code,
             duration_ms = @duration_ms,
             stderr_snippet = @stderr_snippet,
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id
    `),

    // K-recent window: count `failed` rows among the most recent
    // `@threshold` dispatches for the same (project, task, phase).
    countRecentFailed: db.prepare(`
      WITH recent AS (
        SELECT state FROM dispatches
         WHERE project_slug = @project_slug
           AND task_id = @task_id
           AND phase = @phase
         ORDER BY created_at DESC
         LIMIT @threshold
      )
      SELECT COUNT(*) AS cnt FROM recent WHERE state = 'failed'
    `),

    incrementFailureCount: db.prepare(`
      UPDATE dispatches SET failure_count = failure_count + 1 WHERE id = @id
    `),

    listPendingAll: db.prepare(`
      SELECT * FROM dispatches
      WHERE state = 'pending'
      ORDER BY created_at ASC
    `),

    listForTask: db.prepare(`
      SELECT * FROM dispatches
      WHERE project_slug = @project_slug AND task_id = @task_id
      ORDER BY created_at DESC
    `),

    appendLog: db.prepare(`
      INSERT INTO dispatch_log (dispatch_id, level, host, message)
      VALUES (@dispatch_id, @level, @host, @message)
    `),
  };
  return cached;
}

function toDispatchState(raw: string): DispatchState {
  switch (raw) {
    case 'pending':
    case 'taken':
    case 'done':
    case 'failed':
    case 'poisoned':
      return raw;
    default:
      throw new Error(`db/dispatches: invalid state "${raw}" in row`);
  }
}

function toDispatch(raw: RawDispatchRow): Dispatch {
  return {
    id: raw.id,
    projectSlug: raw.project_slug,
    taskId: raw.task_id,
    phase: raw.phase,
    agentId: raw.agent_id,
    prompt: raw.prompt,
    state: toDispatchState(raw.state),
    failureCount: raw.failure_count,
    exitCode: raw.exit_code,
    durationMs: raw.duration_ms,
    stderrSnippet: raw.stderr_snippet,
    createdBy: raw.created_by,
    claimedBy: raw.claimed_by,
    createdAt: raw.created_at,
    claimedAt: raw.claimed_at,
    completedAt: raw.completed_at,
  };
}

function newDispatchId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function failureThreshold(): number {
  const raw = process.env.OPENCLAW_DISPATCH_FAILURE_THRESHOLD ?? '3';
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return n;
}

export const DispatchRepo = {
  /**
   * Insert a pending dispatch. Returns the new id on success, or null if
   * the partial UNIQUE index `dispatches_unique_open` rejected the row
   * (an open dispatch for the same (project, task, phase) already exists).
   *
   * Continuation-loop call site treats null as "skipped duplicate", per
   * implementation-plan.md §6 lines 599-624. No throw on conflict.
   */
  insertPending(opts: InsertPendingOptions): string | null {
    const id = newDispatchId();
    const row = stmts().insertPending.get({
      id,
      project_slug: opts.projectSlug,
      task_id: opts.taskId,
      phase: opts.phase,
      agent_id: opts.agentId,
      prompt: opts.prompt,
      created_by: opts.createdBy,
    }) as { id: string } | undefined;
    return row ? row.id : null;
  },

  /**
   * Atomic pending → taken transition. Single SQL statement; the row
   * returned (if any) is the canonical post-claim view.
   *
   * Returns null when the row is unknown, terminal, or already taken
   * by someone else. Callers must distinguish those cases by calling
   * `getById` if they need a precise HTTP status.
   */
  claim(id: string, claimedBy: string): Dispatch | null {
    const raw = stmts().claim.get({ id, claimed_by: claimedBy }) as
      | RawDispatchRow
      | undefined;
    return raw ? toDispatch(raw) : null;
  },

  getById(id: string): Dispatch | null {
    const raw = stmts().getById.get({ id }) as RawDispatchRow | undefined;
    return raw ? toDispatch(raw) : null;
  },

  /**
   * Mark a taken dispatch as terminal. The poison policy is encoded in the
   * transaction below per implementation-plan.md §7 lines 715-770.
   *
   * Returns the post-update Dispatch row.
   *
   * Throws if the dispatch is unknown or not in 'taken' state — callers in
   * the HTTP layer translate to 404 / 409.
   */
  markDone(id: string, info: MarkDoneInput): Dispatch {
    const db = getDb();
    const threshold = failureThreshold();
    const stderr = info.stderrSnippet ?? null;
    const tx = db.transaction(() => {
      const cur = DispatchRepo.getById(id);
      if (!cur) throw new UnknownDispatchError(id);
      if (cur.state !== 'taken') {
        throw new DispatchStateError('markDone', id, cur.state);
      }

      // Healthy completion.
      if (info.exitCode === 0) {
        stmts().markDoneOk.run({
          id,
          exit_code: 0,
          duration_ms: info.durationMs,
          stderr_snippet: stderr,
        });
        DispatchRepo.appendLog(id, `done exit=0 ${info.durationMs}ms`, 'info');
        const next = DispatchRepo.getById(id);
        if (!next) throw new Error('markDone: row vanished mid-tx');
        return next;
      }

      // Failure path. Decide between `failed` and `poisoned` using the
      // K-recent window query. Note: the current row is still in state
      // 'taken' at this point, so it is NOT counted by `recent` — the
      // count reflects how many of the *previous* (threshold-1) attempts
      // already failed. If that count == threshold-1, this attempt is
      // the Kth consecutive failure → poison.
      const newCount = cur.failureCount + 1;
      const recentRow = stmts().countRecentFailed.get({
        project_slug: cur.projectSlug,
        task_id: cur.taskId,
        phase: cur.phase,
        threshold,
      }) as { cnt: number } | undefined;
      const recentFailed = recentRow?.cnt ?? 0;

      if (recentFailed >= threshold - 1) {
        stmts().markPoisoned.run({
          id,
          failure_count: newCount,
          exit_code: info.exitCode,
          duration_ms: info.durationMs,
          stderr_snippet: stderr,
        });
        DispatchRepo.appendLog(
          id,
          `poisoned after ${threshold} consecutive failures (last exit=${info.exitCode})`,
          'error',
        );
      } else {
        stmts().markFailed.run({
          id,
          failure_count: newCount,
          exit_code: info.exitCode,
          duration_ms: info.durationMs,
          stderr_snippet: stderr,
        });
        DispatchRepo.appendLog(
          id,
          `failed exit=${info.exitCode} count=${newCount}`,
          'warn',
        );
      }
      const next = DispatchRepo.getById(id);
      if (!next) throw new Error('markDone: row vanished mid-tx');
      return next;
    });
    return tx();
  },

  /**
   * Force a `failed` terminal state without consulting the K-recent window.
   * Used by callers that have already decided not to poison (e.g. an
   * operator override or an out-of-band cleanup). The poison policy in
   * `markDone` is the canonical path — prefer it.
   */
  markFailed(
    id: string,
    exitCode: number | null,
    durationMs: number,
    stderrSnippet: string,
  ): Dispatch {
    const db = getDb();
    const tx = db.transaction(() => {
      const cur = DispatchRepo.getById(id);
      if (!cur) throw new UnknownDispatchError(id);
      const newCount = cur.failureCount + 1;
      stmts().markFailed.run({
        id,
        failure_count: newCount,
        exit_code: exitCode,
        duration_ms: durationMs,
        stderr_snippet: stderrSnippet,
      });
      DispatchRepo.appendLog(id, `failed exit=${exitCode} count=${newCount}`, 'warn');
      const next = DispatchRepo.getById(id);
      if (!next) throw new Error('markFailed: row vanished mid-tx');
      return next;
    });
    return tx();
  },

  markPoisoned(id: string, reason: string): Dispatch {
    const db = getDb();
    const tx = db.transaction(() => {
      const cur = DispatchRepo.getById(id);
      if (!cur) throw new UnknownDispatchError(id);
      stmts().markPoisoned.run({
        id,
        failure_count: cur.failureCount,
        exit_code: cur.exitCode,
        duration_ms: cur.durationMs ?? 0,
        stderr_snippet: cur.stderrSnippet,
      });
      DispatchRepo.appendLog(id, `poisoned: ${reason}`, 'error');
      const next = DispatchRepo.getById(id);
      if (!next) throw new Error('markPoisoned: row vanished mid-tx');
      return next;
    });
    return tx();
  },

  incrementFailureCount(id: string): number {
    const db = getDb();
    const tx = db.transaction(() => {
      stmts().incrementFailureCount.run({ id });
      const cur = DispatchRepo.getById(id);
      if (!cur) throw new UnknownDispatchError(id);
      return cur.failureCount;
    });
    return tx();
  },

  /**
   * List pending dispatches addressed to any of `agentIds`, ordered
   * oldest-first. Empty input returns []. Dynamic IN-list requires
   * a fresh statement (the placeholder count varies with input length),
   * so this is the one method that does not use a cached prepared statement.
   */
  listPendingForAgents(agentIds: readonly string[]): Dispatch[] {
    if (agentIds.length === 0) return [];
    const db = getDb();
    const placeholders = agentIds.map(() => '?').join(',');
    const sql = `
      SELECT * FROM dispatches
      WHERE state = 'pending' AND agent_id IN (${placeholders})
      ORDER BY created_at ASC
    `;
    const rows = db.prepare(sql).all(...agentIds) as RawDispatchRow[];
    return rows.map(toDispatch);
  },

  listForTask(projectSlug: string, taskId: string): Dispatch[] {
    const rows = stmts().listForTask.all({
      project_slug: projectSlug,
      task_id: taskId,
    }) as RawDispatchRow[];
    return rows.map(toDispatch);
  },

  appendLog(
    id: string,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
    host: string | null = process.env.HOSTNAME ?? null,
  ): void {
    stmts().appendLog.run({
      dispatch_id: id,
      level,
      host,
      message,
    });
  },
};

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetDispatchRepoForTests(): void {
  cached = null;
}
