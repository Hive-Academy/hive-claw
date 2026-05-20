/**
 * TasksRepo — typed repository for `tasks` and `task_files`.
 *
 * `deriveCurrentPhase` is a pure FS-free port of the original
 * `phase.ts:detectPhase`. It inspects task_files rows already in memory.
 *
 * Atomicity invariants (per implementation-plan.md §6 lines 622-635, §15):
 *   - `writeFile`: a single BEGIN IMMEDIATE … COMMIT updates `task_files`
 *     AND re-derives `tasks.current_phase` AND writes that back.
 *   - `recordApproval`: a single transaction updates both
 *     `tasks.approvals_json` and `tasks.approval_log_json`.
 *
 * File size limit: 1 MB per writeFile (RangeError) — bounded write so
 * the BEGIN IMMEDIATE transaction stays under the §15 50 ms budget.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export type Phase =
  | 'CONTEXT'
  | 'DESCRIPTION'
  | 'PLAN'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'IMPLEMENTED'
  | 'COMPLETE'
  | 'QA_DONE'
  | 'DONE'
  | 'UNKNOWN';

const PHASES: readonly Phase[] = [
  'CONTEXT',
  'DESCRIPTION',
  'PLAN',
  'PENDING',
  'IN_PROGRESS',
  'IMPLEMENTED',
  'COMPLETE',
  'QA_DONE',
  'DONE',
  'UNKNOWN',
];

function isPhase(s: string): s is Phase {
  return (PHASES as readonly string[]).includes(s);
}

const MAX_TASK_FILE_BYTES = 1 * 1024 * 1024; // 1 MB — implementation-plan.md §15

export interface TaskRow {
  projectSlug: string;
  id: string;
  title: string | null;
  taskType: string | null;
  assignedAgent: string | null;
  discordUserId: string | null;
  channelId: string | null;
  currentPhase: Phase;
  checkpointPending: boolean;
  approvals: Record<string, boolean>;
  approvalLog: ApprovalLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalLogEntry {
  ts: string;
  phase: Phase | string;
  approver: string;
}

export interface TaskFileMeta {
  filename: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TaskFile extends TaskFileMeta {
  content: string;
}

interface RawTaskRow {
  project_slug: string;
  id: string;
  title: string | null;
  task_type: string | null;
  assigned_agent: string | null;
  discord_user_id: string | null;
  channel_id: string | null;
  current_phase: string;
  checkpoint_pending: number;
  approvals_json: string;
  approval_log_json: string;
  created_at: string;
  updated_at: string;
}

interface RawTaskFileRow {
  project_slug: string;
  task_id: string;
  filename: string;
  content: string;
  content_type: string;
  size_bytes: number;
  updated_at: string;
  updated_by: string | null;
}

export interface InsertTaskInput {
  projectSlug: string;
  id: string;
  title?: string | null;
  taskType?: string | null;
  assignedAgent?: string | null;
  discordUserId?: string | null;
  channelId?: string | null;
  currentPhase?: Phase;
}

interface Statements {
  insert: Statement<{
    project_slug: string;
    id: string;
    title: string | null;
    task_type: string | null;
    assigned_agent: string | null;
    discord_user_id: string | null;
    channel_id: string | null;
    current_phase: string;
  }>;
  get: Statement<{ project_slug: string; id: string }>;
  list: Statement<{ project_slug: string }>;
  updatePhase: Statement<{ project_slug: string; id: string; phase: string }>;
  updateApprovals: Statement<{
    project_slug: string;
    id: string;
    approvals_json: string;
    approval_log_json: string;
  }>;
  upsertFile: Statement<{
    project_slug: string;
    task_id: string;
    filename: string;
    content: string;
    size_bytes: number;
    updated_by: string | null;
  }>;
  getFile: Statement<{ project_slug: string; task_id: string; filename: string }>;
  listFiles: Statement<{ project_slug: string; task_id: string }>;
  listFilenames: Statement<{ project_slug: string; task_id: string }>;
  deleteFile: Statement<{ project_slug: string; task_id: string; filename: string }>;
  touchTask: Statement<{ project_slug: string; id: string }>;
  deleteTask: Statement<{ project_slug: string; id: string }>;
  deleteTaskFiles: Statement<{ project_slug: string; task_id: string }>;
  cancelPendingDispatches: Statement<{ project_slug: string; task_id: string }>;
  updateAssignedAgent: Statement<{ project_slug: string; id: string; assigned_agent: string }>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  cached = {
    insert: db.prepare(`
      INSERT INTO tasks (
        project_slug, id, title, task_type, assigned_agent,
        discord_user_id, channel_id, current_phase
      ) VALUES (
        @project_slug, @id, @title, @task_type, @assigned_agent,
        @discord_user_id, @channel_id, @current_phase
      )
    `),
    get: db.prepare(`SELECT * FROM tasks WHERE project_slug = @project_slug AND id = @id`),
    list: db.prepare(`SELECT * FROM tasks WHERE project_slug = @project_slug ORDER BY id DESC`),
    updatePhase: db.prepare(`
      UPDATE tasks SET current_phase = @phase,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_slug = @project_slug AND id = @id
    `),
    updateApprovals: db.prepare(`
      UPDATE tasks SET
        approvals_json = @approvals_json,
        approval_log_json = @approval_log_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_slug = @project_slug AND id = @id
    `),
    upsertFile: db.prepare(`
      INSERT INTO task_files (
        project_slug, task_id, filename, content, size_bytes, updated_by, updated_at
      ) VALUES (
        @project_slug, @task_id, @filename, @content, @size_bytes, @updated_by,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
      ON CONFLICT(project_slug, task_id, filename) DO UPDATE SET
        content = excluded.content,
        size_bytes = excluded.size_bytes,
        updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    getFile: db.prepare(`
      SELECT * FROM task_files
      WHERE project_slug = @project_slug AND task_id = @task_id AND filename = @filename
    `),
    listFiles: db.prepare(`
      SELECT * FROM task_files
      WHERE project_slug = @project_slug AND task_id = @task_id
      ORDER BY filename ASC
    `),
    listFilenames: db.prepare(`
      SELECT filename, content FROM task_files
      WHERE project_slug = @project_slug AND task_id = @task_id
    `),
    deleteFile: db.prepare(`
      DELETE FROM task_files
      WHERE project_slug = @project_slug AND task_id = @task_id AND filename = @filename
    `),
    touchTask: db.prepare(`
      UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_slug = @project_slug AND id = @id
    `),
    deleteTask: db.prepare(`DELETE FROM tasks WHERE project_slug = @project_slug AND id = @id`),
    deleteTaskFiles: db.prepare(`DELETE FROM task_files WHERE project_slug = @project_slug AND task_id = @task_id`),
    cancelPendingDispatches: db.prepare(`
      UPDATE dispatches SET state = 'failed',
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_slug = @project_slug AND task_id = @task_id
        AND state IN ('pending', 'taken')
    `),
    updateAssignedAgent: db.prepare(`
      UPDATE tasks SET assigned_agent = @assigned_agent,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_slug = @project_slug AND id = @id
    `),
  };
  return cached;
}

function safeParseObject(raw: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = Boolean(v);
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

function safeParseLog(raw: string): ApprovalLogEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((e): e is ApprovalLogEntry =>
          Boolean(e) && typeof e === 'object' &&
          typeof (e as ApprovalLogEntry).ts === 'string' &&
          typeof (e as ApprovalLogEntry).phase === 'string' &&
          typeof (e as ApprovalLogEntry).approver === 'string',
        );
    }
  } catch {
    // fall through
  }
  return [];
}

function toTaskRow(raw: RawTaskRow): TaskRow {
  return {
    projectSlug: raw.project_slug,
    id: raw.id,
    title: raw.title,
    taskType: raw.task_type,
    assignedAgent: raw.assigned_agent,
    discordUserId: raw.discord_user_id,
    channelId: raw.channel_id,
    currentPhase: isPhase(raw.current_phase) ? raw.current_phase : 'UNKNOWN',
    checkpointPending: raw.checkpoint_pending !== 0,
    approvals: safeParseObject(raw.approvals_json),
    approvalLog: safeParseLog(raw.approval_log_json),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toFileMeta(raw: RawTaskFileRow): TaskFileMeta {
  return {
    filename: raw.filename,
    sizeBytes: raw.size_bytes,
    contentType: raw.content_type,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by,
  };
}

function toFile(raw: RawTaskFileRow): TaskFile {
  return { ...toFileMeta(raw), content: raw.content };
}

/**
 * Pure FS-free port of `phase.ts:detectPhase`. Inputs are the filenames
 * present and the body of `tasks.md` (or null). Output is a Phase.
 */
export function deriveCurrentPhase(
  filenames: ReadonlySet<string>,
  tasksMd: string | null,
): Phase {
  if (filenames.has('future-enhancements.md')) return 'DONE';
  if (tasksMd) {
    const lines = tasksMd.split('\n');
    const states = lines
      .map((l) =>
        l.match(/^\s*-\s*\[([ xX-])\]\s*\*?\*?(PENDING|IN[_\s]PROGRESS|IMPLEMENTED|COMPLETE)/i),
      )
      .filter((m): m is RegExpMatchArray => m !== null);
    if (states.some((s) => /IN.PROGRESS/i.test(s[2]))) return 'IN_PROGRESS';
    if (states.length > 0 && states.every((s) => /COMPLETE/i.test(s[2]))) return 'QA_DONE';
    if (states.some((s) => /IMPLEMENTED/i.test(s[2]))) return 'IMPLEMENTED';
    if (states.some((s) => /PENDING/i.test(s[2]))) return 'PENDING';
  }
  if (filenames.has('implementation-plan.md')) return 'PLAN';
  if (filenames.has('task-description.md')) return 'DESCRIPTION';
  if (filenames.has('context.md')) return 'CONTEXT';
  return 'UNKNOWN';
}

function recomputePhase(
  projectSlug: string,
  taskId: string,
): Phase {
  const rows = stmts().listFilenames.all({
    project_slug: projectSlug,
    task_id: taskId,
  }) as { filename: string; content: string }[];
  const filenames = new Set(rows.map((r) => r.filename));
  const tasksRow = rows.find((r) => r.filename === 'tasks.md');
  return deriveCurrentPhase(filenames, tasksRow?.content ?? null);
}

export const TasksRepo = {
  insert(opts: InsertTaskInput): void {
    stmts().insert.run({
      project_slug: opts.projectSlug,
      id: opts.id,
      title: opts.title ?? null,
      task_type: opts.taskType ?? null,
      assigned_agent: opts.assignedAgent ?? null,
      discord_user_id: opts.discordUserId ?? null,
      channel_id: opts.channelId ?? null,
      current_phase: opts.currentPhase ?? 'CONTEXT',
    });
  },

  get(projectSlug: string, taskId: string): TaskRow | null {
    const raw = stmts().get.get({
      project_slug: projectSlug,
      id: taskId,
    }) as RawTaskRow | undefined;
    return raw ? toTaskRow(raw) : null;
  },

  list(projectSlug: string): TaskRow[] {
    const rows = stmts().list.all({ project_slug: projectSlug }) as RawTaskRow[];
    return rows.map(toTaskRow);
  },

  updatePhase(projectSlug: string, taskId: string, phase: Phase): void {
    stmts().updatePhase.run({
      project_slug: projectSlug,
      id: taskId,
      phase,
    });
  },

  /**
   * Atomic: read existing approvals/log JSON, merge in the new approval,
   * and write both columns back in one transaction.
   */
  recordApproval(
    projectSlug: string,
    taskId: string,
    phase: Phase | string,
    approver: string,
  ): TaskRow {
    const db = getDb();
    const tx = db.transaction(() => {
      const cur = TasksRepo.get(projectSlug, taskId);
      if (!cur) {
        throw new Error(`recordApproval: task ${projectSlug}/${taskId} not found`);
      }
      const approvals = { ...cur.approvals, [phase]: true };
      const logEntry: ApprovalLogEntry = {
        ts: new Date().toISOString(),
        phase,
        approver,
      };
      const log = [...cur.approvalLog, logEntry];
      stmts().updateApprovals.run({
        project_slug: projectSlug,
        id: taskId,
        approvals_json: JSON.stringify(approvals),
        approval_log_json: JSON.stringify(log),
      });
      const next = TasksRepo.get(projectSlug, taskId);
      if (!next) throw new Error('recordApproval: task disappeared mid-tx');
      return next;
    });
    return tx();
  },

  /**
   * Atomic: write the file row AND re-derive `tasks.current_phase` AND
   * persist the new phase, all in one BEGIN IMMEDIATE … COMMIT.
   *
   * Throws RangeError if `content` exceeds 1 MB (size cap from §15).
   */
  writeFile(
    projectSlug: string,
    taskId: string,
    filename: string,
    content: string,
    updatedBy?: string | null,
  ): { sizeBytes: number; phase: Phase } {
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > MAX_TASK_FILE_BYTES) {
      throw new RangeError(
        `task file ${filename} exceeds 1 MB limit (${sizeBytes} bytes)`,
      );
    }
    const db = getDb();
    const tx = db.transaction(() => {
      stmts().upsertFile.run({
        project_slug: projectSlug,
        task_id: taskId,
        filename,
        content,
        size_bytes: sizeBytes,
        updated_by: updatedBy ?? null,
      });
      const phase = recomputePhase(projectSlug, taskId);
      stmts().updatePhase.run({
        project_slug: projectSlug,
        id: taskId,
        phase,
      });
      return phase;
    });
    const phase = tx();
    return { sizeBytes, phase };
  },

  readFile(projectSlug: string, taskId: string, filename: string): TaskFile | null {
    const raw = stmts().getFile.get({
      project_slug: projectSlug,
      task_id: taskId,
      filename,
    }) as RawTaskFileRow | undefined;
    return raw ? toFile(raw) : null;
  },

  listFiles(projectSlug: string, taskId: string): TaskFileMeta[] {
    const rows = stmts().listFiles.all({
      project_slug: projectSlug,
      task_id: taskId,
    }) as RawTaskFileRow[];
    return rows.map(toFileMeta);
  },

  deleteFile(projectSlug: string, taskId: string, filename: string): { phase: Phase } {
    const db = getDb();
    const tx = db.transaction(() => {
      stmts().deleteFile.run({
        project_slug: projectSlug,
        task_id: taskId,
        filename,
      });
      const phase = recomputePhase(projectSlug, taskId);
      stmts().updatePhase.run({
        project_slug: projectSlug,
        id: taskId,
        phase,
      });
      stmts().touchTask.run({ project_slug: projectSlug, id: taskId });
      return phase;
    });
    const phase = tx();
    return { phase };
  },

  /** FS-free phase derivation, exposed for callers that already have the rows. */
  deriveCurrentPhase(projectSlug: string, taskId: string): Phase {
    return recomputePhase(projectSlug, taskId);
  },

  /**
   * Atomic: cancel pending/taken dispatches, delete task files, delete task row.
   * Returns null when task not found.
   */
  deleteTask(
    projectSlug: string,
    taskId: string,
  ): { cancelledDispatches: number; wasInProgress: boolean } | null {
    const db = getDb();
    const tx = db.transaction(() => {
      const task = TasksRepo.get(projectSlug, taskId);
      if (!task) return null;
      const wasInProgress = task.currentPhase === 'IN_PROGRESS' || task.checkpointPending;
      const cancelResult = stmts().cancelPendingDispatches.run({
        project_slug: projectSlug,
        task_id: taskId,
      });
      const cancelledDispatches = cancelResult.changes;
      stmts().deleteTaskFiles.run({ project_slug: projectSlug, task_id: taskId });
      stmts().deleteTask.run({ project_slug: projectSlug, id: taskId });
      return { cancelledDispatches, wasInProgress };
    });
    return tx();
  },

  updateAssignedAgent(
    projectSlug: string,
    taskId: string,
    assignedAgent: string,
  ): boolean {
    const result = stmts().updateAssignedAgent.run({
      project_slug: projectSlug,
      id: taskId,
      assigned_agent: assignedAgent,
    });
    return result.changes > 0;
  },
};

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetTasksRepoForTests(): void {
  cached = null;
}
