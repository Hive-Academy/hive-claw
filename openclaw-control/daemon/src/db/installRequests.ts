/**
 * InstallRequestsRepo — typed repository wrapping `extension_install_requests`.
 *
 * Backs TASK_2026_006 Batch 8b: plugin/MCP self-extension feature
 * (amendment-1 §16). Agents file install requests via the plugin; operators
 * approve/reject from the dashboard; the in-process install worker
 * (`installWorker.ts`) consumes approved rows.
 *
 * State machine: pending → approved → (applied | failed)
 *                pending → rejected
 *
 * Prepared statements are cached at module load (lazy via `getDb()`),
 * consistent with the other repos in this directory.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export type InstallKind = 'plugin' | 'mcp_skill';
export type InstallStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'failed';

export interface InstallRequest {
  id: number;
  kind: InstallKind;
  slug: string;
  requestingAgentId: string;
  reason: string | null;
  status: InstallStatus;
  operatorNote: string | null;
  installOutput: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

interface RawRow {
  id: number;
  kind: string;
  slug: string;
  requesting_agent_id: string;
  reason: string | null;
  status: string;
  operator_note: string | null;
  install_output: string | null;
  created_at: string;
  decided_at: string | null;
  applied_at: string | null;
}

function toRow(raw: RawRow): InstallRequest {
  return {
    id: raw.id,
    kind: raw.kind as InstallKind,
    slug: raw.slug,
    requestingAgentId: raw.requesting_agent_id,
    reason: raw.reason,
    status: raw.status as InstallStatus,
    operatorNote: raw.operator_note,
    installOutput: raw.install_output,
    createdAt: raw.created_at,
    decidedAt: raw.decided_at,
    appliedAt: raw.applied_at,
  };
}

interface Statements {
  insert: Statement<{ kind: string; slug: string; agent: string; reason: string | null }>;
  get: Statement<{ id: number }>;
  listPending: Statement<[]>;
  listHistory: Statement<{ limit: number }>;
  listByAgent: Statement<{ agent: string; limit: number }>;
  markApproved: Statement<{ id: number; note: string | null }>;
  markRejected: Statement<{ id: number; note: string | null }>;
  markApplied: Statement<{ id: number; output: string }>;
  markFailed: Statement<{ id: number; output: string }>;
  pickNextApproved: Statement<[]>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  const selectCols = `id, kind, slug, requesting_agent_id, reason, status,
                      operator_note, install_output, created_at, decided_at, applied_at`;
  cached = {
    insert: db.prepare(`
      INSERT INTO extension_install_requests (kind, slug, requesting_agent_id, reason)
      VALUES (@kind, @slug, @agent, @reason)
    `),
    get: db.prepare(`SELECT ${selectCols} FROM extension_install_requests WHERE id = @id`),
    listPending: db.prepare(
      `SELECT ${selectCols} FROM extension_install_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    ),
    listHistory: db.prepare(
      `SELECT ${selectCols} FROM extension_install_requests
        WHERE status IN ('approved','rejected','applied','failed')
        ORDER BY COALESCE(applied_at, decided_at, created_at) DESC
        LIMIT @limit`,
    ),
    listByAgent: db.prepare(
      `SELECT ${selectCols} FROM extension_install_requests
        WHERE requesting_agent_id = @agent
        ORDER BY created_at DESC
        LIMIT @limit`,
    ),
    markApproved: db.prepare(`
      UPDATE extension_install_requests
         SET status = 'approved',
             operator_note = @note,
             decided_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status = 'pending'
    `),
    markRejected: db.prepare(`
      UPDATE extension_install_requests
         SET status = 'rejected',
             operator_note = @note,
             decided_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status = 'pending'
    `),
    markApplied: db.prepare(`
      UPDATE extension_install_requests
         SET status = 'applied',
             install_output = @output,
             applied_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status = 'approved'
    `),
    markFailed: db.prepare(`
      UPDATE extension_install_requests
         SET status = 'failed',
             install_output = @output,
             applied_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status = 'approved'
    `),
    pickNextApproved: db.prepare(
      `SELECT ${selectCols} FROM extension_install_requests
        WHERE status = 'approved' AND applied_at IS NULL
        ORDER BY decided_at ASC
        LIMIT 1`,
    ),
  };
  return cached;
}

export interface CreateRequestInput {
  kind: InstallKind;
  slug: string;
  requestingAgentId: string;
  reason?: string | null;
}

/**
 * Typed errors so the HTTP layer can map to 404/409 without string-matching.
 */
export class UnknownInstallRequestError extends Error {
  readonly requestId: number;
  constructor(id: number) {
    super(`unknown install request ${id}`);
    this.name = 'UnknownInstallRequestError';
    this.requestId = id;
  }
}

export class InstallRequestStateError extends Error {
  readonly requestId: number;
  readonly state: InstallStatus;
  readonly operation: string;
  constructor(operation: string, id: number, state: InstallStatus) {
    super(`${operation}: cannot complete from state=${state}`);
    this.name = 'InstallRequestStateError';
    this.requestId = id;
    this.state = state;
    this.operation = operation;
  }
}

export const InstallRequestsRepo = {
  create(input: CreateRequestInput): InstallRequest {
    const info = stmts().insert.run({
      kind: input.kind,
      slug: input.slug,
      agent: input.requestingAgentId,
      reason: input.reason ?? null,
    });
    const id = Number(info.lastInsertRowid);
    const row = stmts().get.get({ id }) as RawRow | undefined;
    if (!row) {
      throw new Error(`install-requests: insert succeeded but row id=${id} not found`);
    }
    return toRow(row);
  },

  get(id: number): InstallRequest | null {
    const raw = stmts().get.get({ id }) as RawRow | undefined;
    return raw ? toRow(raw) : null;
  },

  listPending(): InstallRequest[] {
    const rows = stmts().listPending.all() as RawRow[];
    return rows.map(toRow);
  },

  /**
   * Terminal-state history (approved + rejected + applied + failed),
   * newest-first. The dashboard "History" tab reads this so failed installs
   * (which leave `pending` immediately) remain visible to the operator.
   */
  listHistory(limit = 100): InstallRequest[] {
    const capped = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = stmts().listHistory.all({ limit: capped }) as RawRow[];
    return rows.map(toRow);
  },

  listByAgent(agentId: string, limit = 100): InstallRequest[] {
    const rows = stmts().listByAgent.all({ agent: agentId, limit }) as RawRow[];
    return rows.map(toRow);
  },

  markApproved(id: number, operatorNote?: string | null): InstallRequest {
    const info = stmts().markApproved.run({ id, note: operatorNote ?? null });
    return assertTransition(id, info.changes, 'approve');
  },

  markRejected(id: number, operatorNote?: string | null): InstallRequest {
    const info = stmts().markRejected.run({ id, note: operatorNote ?? null });
    return assertTransition(id, info.changes, 'reject');
  },

  markApplied(id: number, installOutput: string): InstallRequest {
    const info = stmts().markApplied.run({ id, output: installOutput });
    return assertTransition(id, info.changes, 'apply');
  },

  markFailed(id: number, installOutput: string): InstallRequest {
    const info = stmts().markFailed.run({ id, output: installOutput });
    return assertTransition(id, info.changes, 'fail');
  },

  /**
   * Worker helper: return the oldest approved-but-not-applied request, or
   * null if the queue is empty. Caller (`installWorker.ts`) treats null as
   * "nothing to do — wait for the next approval."
   */
  pickNextApproved(): InstallRequest | null {
    const raw = stmts().pickNextApproved.get() as RawRow | undefined;
    return raw ? toRow(raw) : null;
  },
};

/**
 * Throw a typed error when an UPDATE didn't change a row — distinguishes
 * "no such id" from "wrong state". The route layer maps these to 404/409.
 */
function assertTransition(
  id: number,
  changes: number,
  operation: string,
): InstallRequest {
  if (changes === 1) {
    const row = stmts().get.get({ id }) as RawRow | undefined;
    if (!row) throw new UnknownInstallRequestError(id);
    return toRow(row);
  }
  // 0 rows updated — figure out why.
  const row = stmts().get.get({ id }) as RawRow | undefined;
  if (!row) throw new UnknownInstallRequestError(id);
  throw new InstallRequestStateError(operation, id, row.status as InstallStatus);
}

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetInstallRequestsRepoForTests(): void {
  cached = null;
}
