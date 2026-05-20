/**
 * ProjectsRepo — typed repository wrapping the `projects` table.
 *
 * Prepared statements are cached at module load (lazy via `getDb()`)
 * per implementation-plan.md §3 line 410.
 *
 * v4 additions: `github_repo` + `default_branch` — set when the project is
 * a real git repo the invoker should treat as a worktree base. Both null on
 * existing rows (back-compat); the invoker only branches on a non-null
 * `github_repo`.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export interface ProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  github_repo: string | null;
  default_branch: string | null;
  created_at: string;
  updated_at: string;
}

interface Statements {
  upsert: Statement<{
    slug: string;
    name: string;
    workspace: string | null;
    github_repo: string | null;
    default_branch: string | null;
  }>;
  get: Statement<{ slug: string }>;
  list: Statement<[]>;
  delete: Statement<{ slug: string }>;
  update: Statement<{ slug: string; name: string | null; workspace: string | null; default_branch: string | null }>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  cached = {
    upsert: db.prepare(`
      INSERT INTO projects (slug, name, workspace, github_repo, default_branch, updated_at)
      VALUES (@slug, @name, @workspace, @github_repo, @default_branch, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        workspace = excluded.workspace,
        github_repo = excluded.github_repo,
        default_branch = excluded.default_branch,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    get: db.prepare(`SELECT slug, name, workspace, github_repo, default_branch, created_at, updated_at FROM projects WHERE slug = @slug`),
    list: db.prepare(`SELECT slug, name, workspace, github_repo, default_branch, created_at, updated_at FROM projects ORDER BY slug ASC`),
    delete: db.prepare(`DELETE FROM projects WHERE slug = @slug`),
    update: db.prepare(`
      UPDATE projects SET
        name = COALESCE(@name, name),
        workspace = COALESCE(@workspace, workspace),
        default_branch = COALESCE(@default_branch, default_branch),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE slug = @slug
    `),
  };
  return cached;
}

function toProjectRow(raw: RawProjectRow): ProjectRow {
  return {
    slug: raw.slug,
    name: raw.name,
    workspace: raw.workspace,
    githubRepo: raw.github_repo,
    defaultBranch: raw.default_branch,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface UpsertProjectInput {
  slug: string;
  name: string;
  workspace?: string | null;
  githubRepo?: string | null;
  defaultBranch?: string | null;
}

export const ProjectsRepo = {
  upsert(opts: UpsertProjectInput): void {
    stmts().upsert.run({
      slug: opts.slug,
      name: opts.name,
      workspace: opts.workspace ?? null,
      github_repo: opts.githubRepo ?? null,
      default_branch: opts.defaultBranch ?? null,
    });
  },

  get(slug: string): ProjectRow | null {
    const raw = stmts().get.get({ slug }) as RawProjectRow | undefined;
    return raw ? toProjectRow(raw) : null;
  },

  list(): ProjectRow[] {
    const rows = stmts().list.all() as RawProjectRow[];
    return rows.map(toProjectRow);
  },

  delete(slug: string): boolean {
    const result = stmts().delete.run({ slug });
    return result.changes > 0;
  },

  update(slug: string, fields: { name?: string; workspace?: string; defaultBranch?: string }): ProjectRow | null {
    stmts().update.run({
      slug,
      name: fields.name ?? null,
      workspace: fields.workspace ?? null,
      default_branch: fields.defaultBranch ?? null,
    });
    return ProjectsRepo.get(slug);
  },
};

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetProjectsRepoForTests(): void {
  cached = null;
}
