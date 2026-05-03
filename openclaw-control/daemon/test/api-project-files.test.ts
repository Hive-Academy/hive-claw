/**
 * api-project-files — TASK_2026_002 B6 sub-task 12 (test for sub-task 8).
 *
 * Verifies the project-files cluster:
 *   - POST /api/projects/:slug/files writes inside the workspace tree.
 *   - GET ?path= reads it back.
 *   - GET ?prefix= lists files (with mtime).
 *   - DELETE removes it.
 *   - Path traversal rejection (`..` segment).
 *   - Absolute path rejection (`/etc/passwd`).
 *   - 1 MB cap on content size.
 *   - 404 on unknown project, 404 on non-existent file.
 *
 * Pattern follows persona-privacy.test.ts: env-stamp first, then setupTestDb,
 * then buildApp(). Internal-token bearer auth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENTS_ROOT } from './env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `api-project-files.test: env override didn't reach config — got "${config.localAgentsRoot}"`,
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

/**
 * Stand up a project with a workspace tempdir. Returns the slug + the
 * absolute workspace path so the caller can assert on FS state.
 */
function makeProject(t: ReturnType<typeof setupTestDb>): { slug: string; workspace: string } {
  const slug = 'test-proj';
  const workspace = mkdtempSync(join(tmpdir(), 'openclaw-pf-ws-'));
  // ProjectsRepo.upsert + a `.workspace` task file is the canonical seed
  // path (see daemon/src/projects.ts:resolveWorkspace). We use a project
  // row with a non-empty workspace column on the repo directly so
  // resolveWorkspace returns our tempdir.
  t.ProjectsRepo.upsert({ slug, name: 'Test Project', workspace });
  return { slug, workspace };
}

test('api-project-files: POST writes content; GET reads it back', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    // POST
    const post = await app.inject({
      method: 'POST',
      url: `/api/projects/${slug}/files`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: '.claude/harness.yaml', content: 'version: 1\n' },
    });
    assert.equal(post.statusCode, 200, post.body);
    const postBody = JSON.parse(post.body) as { ok: boolean; sizeBytes: number };
    assert.equal(postBody.ok, true);
    assert.equal(postBody.sizeBytes, Buffer.byteLength('version: 1\n', 'utf8'));
    assert.ok(existsSync(join(workspace, '.claude', 'harness.yaml')));

    // GET single
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${slug}/files?path=.claude/harness.yaml`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(get.statusCode, 200);
    const getBody = JSON.parse(get.body) as { content: string; sizeBytes: number; mtime: string };
    assert.equal(getBody.content, 'version: 1\n');
    assert.equal(typeof getBody.mtime, 'string', 'mtime is exposed in single-file GET');
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: GET ?prefix= lists files with mtime', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    // Seed two files via POST.
    for (const p of ['.claude/harness.yaml', '.claude/notes.md']) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${slug}/files`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: { path: p, content: 'x' },
      });
      assert.equal(r.statusCode, 200);
    }
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${slug}/files?prefix=.claude`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(list.statusCode, 200);
    const body = JSON.parse(list.body) as Array<{ path: string; size: number; mtime: string }>;
    const paths = body.map((b) => b.path).sort();
    assert.deepEqual(paths, ['.claude/harness.yaml', '.claude/notes.md']);
    for (const e of body) {
      assert.equal(typeof e.mtime, 'string', 'mtime is exposed in prefix listing');
      assert.equal(e.size, 1, 'size matches written content');
    }
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: rejects ".." path traversal segments', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${slug}/files`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: '../../etc/passwd', content: 'evil' },
    });
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body) as { error: string };
    assert.match(body.error, /\.\./);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: rejects absolute paths', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${slug}/files`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: '/etc/passwd', content: 'evil' },
    });
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body) as { error: string };
    assert.match(body.error, /absolute/);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: enforces 1 MB cap on content size', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    // 1 MB + 1 byte. The HTTP route caps at exactly 1 MB. Fastify's default
    // bodyLimit (1 MiB) ALSO triggers a 413 before our route handler runs;
    // either path produces 413 — both are acceptable — but we assert the
    // status code and a non-empty body to confirm the cap is enforced
    // somewhere in the stack.
    const oversize = 'x'.repeat(1024 * 1024 + 1);
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${slug}/files`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: 'big.txt', content: oversize },
    });
    assert.equal(r.statusCode, 413);
    assert.ok(r.body.length > 0, '413 response must carry a body');
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: DELETE removes a file', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    // Seed.
    await app.inject({
      method: 'POST',
      url: `/api/projects/${slug}/files`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: 'tmp/file.txt', content: 'gone' },
    });
    assert.ok(existsSync(join(workspace, 'tmp', 'file.txt')));

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${slug}/files?path=tmp/file.txt`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(existsSync(join(workspace, 'tmp', 'file.txt')), false);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});

test('api-project-files: 404 on unknown project', async () => {
  const t = setupTestDb();
  const app = buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such-proj/files',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: 'foo.txt', content: 'x' },
    });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test('api-project-files: 404 on missing file (GET single)', async () => {
  const t = setupTestDb();
  const { slug, workspace } = makeProject(t);
  const app = buildApp();
  try {
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${slug}/files?path=does-not-exist.txt`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(r.statusCode, 404);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
    t.cleanup();
  }
});
