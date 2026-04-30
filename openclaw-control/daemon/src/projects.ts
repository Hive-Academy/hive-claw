import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectsRepo, TasksRepo } from './db/index.js';

/**
 * Project — the canonical view of a project as the daemon sees it.
 *
 * Note: `specsDir` is gone (specs live in SQLite, not on disk). `path`
 * stays — it's the working directory the headless invoker `cd`s into,
 * resolved per-project from a `.workspace` task-file (or the
 * `OPENCLAW_PROJECT_ROOTS` legacy fallback).
 */
export interface Project {
  slug: string;
  /**
   * Optional working directory on this host where headless invocations run.
   * Resolved from `task_files` row (filename `.workspace`) on the project's
   * tasks (we look at the most recent task that has one), then the legacy
   * `OPENCLAW_PROJECT_ROOTS` env, then falls back to `/`.
   */
  path: string;
  hasSpecs: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a per-project workspace dir.
 *
 * Lookup order (preserved from the pre-batch behavior except the first hit
 * is now sourced from the DB):
 *   1. Any `task_files` row (filename `.workspace`) on the project. The first
 *      such file we see whose content starts with `/` wins.
 *   2. `${OPENCLAW_PROJECT_ROOTS}/<slug>` (legacy convention).
 *   3. `/` — strict last-resort default; the invoker will likely refuse,
 *      but the daemon should not crash on a missing workspace.
 */
async function resolveWorkspace(slug: string): Promise<string> {
  const tasks = TasksRepo.list(slug);
  for (const task of tasks) {
    const ws = TasksRepo.readFile(slug, task.id, '.workspace');
    if (!ws) continue;
    const trimmed = ws.content.trim();
    if (trimmed && trimmed.startsWith('/')) return trimmed;
  }
  const root = (process.env.OPENCLAW_PROJECT_ROOTS ?? '').split(':').filter(Boolean)[0];
  if (root) {
    const candidate = path.join(root, slug);
    if (await exists(candidate)) return candidate;
  }
  return '/';
}

export async function discoverProjects(): Promise<Project[]> {
  const rows = ProjectsRepo.list();
  const projects: Project[] = [];
  for (const row of rows) {
    const workspace = row.workspace && row.workspace.startsWith('/')
      ? row.workspace
      : await resolveWorkspace(row.slug);
    projects.push({ slug: row.slug, path: workspace, hasSpecs: true });
  }
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getProject(slug: string): Promise<Project | null> {
  const row = ProjectsRepo.get(slug);
  if (!row) return null;
  const workspace = row.workspace && row.workspace.startsWith('/')
    ? row.workspace
    : await resolveWorkspace(slug);
  return { slug: row.slug, path: workspace, hasSpecs: true };
}

/**
 * Return the project-level registry markdown if present in `task_files`
 * under the synthetic task id `_project`. Kept for parity with the old
 * `<specsDir>/registry.md` read; callers tolerate a null return.
 */
export async function readRegistry(slug: string): Promise<string | null> {
  const file = TasksRepo.readFile(slug, '_project', 'registry.md');
  return file ? file.content : null;
}

/**
 * @deprecated use discoverProjects.
 */
export const listProjects = discoverProjects;

export async function ensureProject(slug: string): Promise<Project> {
  ProjectsRepo.upsert({ slug, name: slug });
  const workspace = await resolveWorkspace(slug);
  return { slug, path: workspace, hasSpecs: true };
}
