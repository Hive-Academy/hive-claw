/**
 * ProjectsRepo — typed repository wrapping the `projects` table.
 *
 * Prepared statements are cached at module load (lazy via `getDb()`)
 * per implementation-plan.md §3 line 410.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './client.js';

export interface ProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  created_at: string;
  updated_at: string;
}

interface Statements {
  upsert: Statement<{ slug: string; name: string; workspace: string | null }>;
  get: Statement<{ slug: string }>;
  list: Statement<[]>;
}

let cached: Statements | null = null;

function stmts(): Statements {
  if (cached) return cached;
  const db = getDb();
  cached = {
    upsert: db.prepare(`
      INSERT INTO projects (slug, name, workspace, updated_at)
      VALUES (@slug, @name, @workspace, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        workspace = excluded.workspace,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    get: db.prepare(`SELECT slug, name, workspace, created_at, updated_at FROM projects WHERE slug = @slug`),
    list: db.prepare(`SELECT slug, name, workspace, created_at, updated_at FROM projects ORDER BY slug ASC`),
  };
  return cached;
}

function toProjectRow(raw: RawProjectRow): ProjectRow {
  return {
    slug: raw.slug,
    name: raw.name,
    workspace: raw.workspace,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface UpsertProjectInput {
  slug: string;
  name: string;
  workspace?: string | null;
}

export const ProjectsRepo = {
  upsert(opts: UpsertProjectInput): void {
    stmts().upsert.run({
      slug: opts.slug,
      name: opts.name,
      workspace: opts.workspace ?? null,
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
};

/** Test-only: drop the cached prepared statements (after closing the DB). */
export function _resetProjectsRepoForTests(): void {
  cached = null;
}
