import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface Project {
  slug: string;
  /** Absolute path inside the shared-specs clone (where TASK_* dirs live) */
  specsDir: string;
  /**
   * Optional working directory on this host where headless invocations run.
   * Falls back to the specs dir if unset (rarely useful — most projects want
   * a real working tree). Configured per-project via `.workspace` file inside
   * the project's specs dir, holding an absolute host path.
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
 * Resolve a per-project workspace dir. Each project under shared-specs/specs/<slug>/
 * may contain a plain-text file `.workspace` whose contents are an absolute host
 * path that the headless invoker will `cd` into. If absent, we fall back to
 * `${OPENCLAW_PROJECT_ROOTS}/<slug>` (the legacy convention) and finally to the
 * specs dir itself.
 */
async function resolveWorkspace(slug: string, specsDir: string): Promise<string> {
  try {
    const ws = await fs.readFile(path.join(specsDir, '.workspace'), 'utf8');
    const trimmed = ws.trim();
    if (trimmed && trimmed.startsWith('/')) return trimmed;
  } catch {}
  const root = (process.env.OPENCLAW_PROJECT_ROOTS ?? '').split(':').filter(Boolean)[0];
  if (root) {
    const candidate = path.join(root, slug);
    if (await exists(candidate)) return candidate;
  }
  return specsDir;
}

export async function discoverProjects(): Promise<Project[]> {
  await fs.mkdir(config.specsDir, { recursive: true });
  const entries = await fs.readdir(config.specsDir, { withFileTypes: true });
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const slug = e.name;
    const specsDir = path.join(config.specsDir, slug);
    const workspace = await resolveWorkspace(slug, specsDir);
    projects.push({ slug, specsDir, path: workspace, hasSpecs: true });
  }
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getProject(slug: string): Promise<Project | null> {
  const specsDir = path.join(config.specsDir, slug);
  if (!(await exists(specsDir))) return null;
  return { slug, specsDir, path: await resolveWorkspace(slug, specsDir), hasSpecs: true };
}

export async function readRegistry(project: Project): Promise<string | null> {
  try {
    return await fs.readFile(path.join(project.specsDir, 'registry.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Backwards-compat alias for code paths that haven't been renamed yet.
 * @deprecated use discoverProjects.
 */
export const listProjects = discoverProjects;

export async function ensureProject(slug: string): Promise<Project> {
  const dir = path.join(config.specsDir, slug);
  await fs.mkdir(dir, { recursive: true });
  return { slug, specsDir: dir, path: await resolveWorkspace(slug, dir), hasSpecs: true };
}
