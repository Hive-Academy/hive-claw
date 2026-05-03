/**
 * api-harness-materialize-follower — TASK_2026_002 B6 sub-task 12 + B8 sub-task 9.
 *
 * Verifies the follower-mode 405 path for every leader-only route the
 * `if (!config.leader)` guards in `daemon/src/api.ts` cover. Lives in its
 * own file because `config.ts` reads `OPENCLAW_LEADER` once at module load
 * — same pattern as `follower-read.test.ts`.
 *
 * The leader-only routes covered here:
 *   - POST   /api/agents/:id/harness/sync           (B3)
 *   - POST   /api/agents/:id/harness/materialize    (B6)
 *   - POST   /api/harness/materialize               (B6)
 *   - GET    /api/projects/:slug/files              (B7)
 *   - POST   /api/projects/:slug/files              (B7)
 *   - DELETE /api/projects/:slug/files              (B7)
 *
 * All of them touch FS state on the leader's host. A follower must 405 with
 * the standard "POST to OPENCLAW_LEADER_URL" message so the caller routes
 * to the right machine. The body must mention "leader" so a curl-driving
 * operator immediately sees what's wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stamp follower mode BEFORE any src/* import. ESM hoists imports, so this
// must precede the relative imports below.
import './follower-env-stamp.ts';
import { buildApp } from '../src/api.ts';
import { config } from '../src/config.ts';

if (config.leader !== false) {
  throw new Error(
    `api-harness-materialize-follower.test: expected follower mode (config.leader=false), got ${config.leader}`,
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

test('api-harness-materialize-follower: POST /api/agents/:id/harness/materialize → 405 on follower', async () => {
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/horus/harness/materialize',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });
    assert.equal(res.statusCode, 405, res.body);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /leader/);
  } finally {
    await app.close();
  }
});

test('api-harness-materialize-follower: POST /api/harness/materialize → 405 on follower', async () => {
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/materialize',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });
    assert.equal(res.statusCode, 405, res.body);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /leader/);
  } finally {
    await app.close();
  }
});

test('api-harness-materialize-follower: POST /api/agents/:id/harness/sync → 405 on follower (B8 sub-task 9)', async () => {
  // The B3 leader-only `harness/sync` route is the broadcast trigger: it
  // re-reads `harness.yaml` from the leader's DB and publishes a Redis
  // event. Followers have no DB and no broadcast surface, so they must
  // 405 with the same shape as the materialize routes.
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/horus/harness/sync',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });
    assert.equal(res.statusCode, 405, res.body);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /leader/, 'error body must point operator at the leader');
    assert.match(body.error, /OPENCLAW_LEADER_URL/, 'error body must name the env var');
  } finally {
    await app.close();
  }
});

test('api-harness-materialize-follower: project-files routes also 405 on follower', async () => {
  const app = buildApp();
  try {
    const post = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such/files',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { path: 'foo.txt', content: 'x' },
    });
    assert.equal(post.statusCode, 405, post.body);
    const get = await app.inject({
      method: 'GET',
      url: '/api/projects/no-such/files?path=foo.txt',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(get.statusCode, 405);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/projects/no-such/files?path=foo.txt',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(del.statusCode, 405);
  } finally {
    await app.close();
  }
});
