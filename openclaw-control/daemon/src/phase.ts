/**
 * Pure phase derivation + compatibility wrappers for the API layer.
 *
 * Per implementation-plan.md §6 lines 641-647: the FS-walking `detectPhase`
 * is gone. `derivePhase` is a pure function over (filenames, tasksMd) that
 * mirrors `TasksRepo.deriveCurrentPhase` exactly. The wrappers `readTask`,
 * `listTasks`, `readTaskArtifacts` are thin proxies over `TasksRepo` so the
 * existing API surface (api.ts, continuation.ts) keeps compiling without
 * having to know about the SQLite repos.
 */

import {
  TasksRepo,
  deriveCurrentPhase as repoDeriveCurrentPhase,
  type Phase,
} from './db/index.js';
import type { Project } from './projects.js';

export type { Phase };

export interface TaskSummary {
  id: string;
  project: string;
  phase: Phase;
  taskType?: string;
  title?: string;
  assignedAgent?: string;
  discordUserId?: string;
  channelId?: string;
  checkpointPending: boolean;
  updatedAt: string;
}

/**
 * Pure phase derivation from a set of filenames present and the body of
 * `tasks.md` (or null). FS-free — the caller already has both inputs in
 * memory. Used by TasksRepo.recomputePhase and any HTTP route that wants
 * to preview a phase without touching the DB.
 */
export function derivePhase(filenames: ReadonlySet<string>, tasksMd?: string | null): Phase {
  return repoDeriveCurrentPhase(filenames, tasksMd ?? null);
}

function isCheckpointPending(phase: Phase): boolean {
  return phase === 'DESCRIPTION' || phase === 'PLAN' || phase === 'IMPLEMENTED';
}

/**
 * Compatibility wrapper for the existing API surface. Reads from the
 * `tasks` table via TasksRepo and returns the legacy shape. Returns null
 * when the task does not exist.
 */
export async function readTask(project: Project, taskId: string): Promise<TaskSummary | null> {
  const row = TasksRepo.get(project.slug, taskId);
  if (!row) return null;
  return {
    id: row.id,
    project: row.projectSlug,
    phase: row.currentPhase,
    taskType: row.taskType ?? undefined,
    title: row.title ?? undefined,
    assignedAgent: row.assignedAgent ?? undefined,
    discordUserId: row.discordUserId ?? undefined,
    channelId: row.channelId ?? undefined,
    checkpointPending: row.checkpointPending || isCheckpointPending(row.currentPhase),
    updatedAt: row.updatedAt,
  };
}

export async function listTasks(project: Project): Promise<TaskSummary[]> {
  const rows = TasksRepo.list(project.slug);
  return rows
    .map<TaskSummary>((row) => ({
      id: row.id,
      project: row.projectSlug,
      phase: row.currentPhase,
      taskType: row.taskType ?? undefined,
      title: row.title ?? undefined,
      assignedAgent: row.assignedAgent ?? undefined,
      discordUserId: row.discordUserId ?? undefined,
      channelId: row.channelId ?? undefined,
      checkpointPending: row.checkpointPending || isCheckpointPending(row.currentPhase),
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export async function readTaskArtifacts(
  project: Project,
  taskId: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of [
    'context.md',
    'task-description.md',
    'implementation-plan.md',
    'tasks.md',
    'future-enhancements.md',
  ]) {
    const file = TasksRepo.readFile(project.slug, taskId, f);
    if (file) out[f] = file.content;
  }
  return out;
}
