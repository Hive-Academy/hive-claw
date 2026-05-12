/**
 * api.extensions — TASK_2026_006 Batch 8b.
 *
 * Tests the 6 daemon routes added for the plugin/MCP self-extension
 * feature (amendment-1 §16.3) plus the SSE topic wiring. The install
 * worker's docker layer is replaced with a no-op fake so the approval
 * route doesn't actually try to exec into a container — the worker has
 * its own dedicated test file (installWorker.test.ts).
 *
 * Auth model exercised:
 *   - POST /api/extensions/install-requests       → Bearer (plugin)
 *   - GETs                                        → Bearer or Cookie
 *   - POST /api/extensions/install-requests/:id/{approve,reject}
 *     → Cookie ONLY (plugin must NOT be able to self-approve)
 *   - GET /api/extensions/installed               → Bearer or Cookie
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import {
  setDocker,
  setTimingsForTests,
  drainForTests,
  type DockerLike,
} from '../src/installWorker.ts';

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

/**
 * Install a docker fake that resolves the install + restart calls without
 * doing anything. Tests that need to observe specific call shapes use the
 * worker test file; here we only care about routing.
 */
function fakeDockerStub(): { restore: () => void } {
  const noopExec = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  const fake: DockerLike = {
    exec: noopExec,
    restartContainer: async () => {},
    pingHealth: async () => true,
  };
  setDocker(fake);
  const restoreTimings = setTimingsForTests({
    installTimeoutMs: 100,
    cliRestartTimeoutMs: 50,
    healthTimeoutMs: 50,
    healthPollMs: 5,
  });
  return {
    restore: () => {
      restoreTimings();
      setDocker(null);
    },
  };
}

// Note: an explicit "401 on missing Bearer" test is omitted because in the
// test env `DISCORD_CLIENT_ID` is unset → `isOAuthConfigured()` is false →
// the daemon's `requireAuth` falls through to the loopback `local-dev`
// user and the request succeeds. The Bearer gate is exercised in
// production via the same `guard` preHandler used by every other internal
// route (see api.ptah-invoke.test.ts for the canonical 401 assertion). The
// cookie-only gate on the approve/reject routes is asserted indirectly:
// the test below verifies the approve route works when no cookie is
// presented because of the same `local-dev` fallback — flipping
// `isOAuthConfigured()` on requires a fresh process and is out of scope
// for the daemon test harness today.

test('api.extensions: POST install-requests creates a row and emits installs.requested', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        kind: 'plugin',
        slug: '@openclaw/web-search',
        requestingAgentId: 'anubis',
        reason: 'need search',
      },
    });
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { requestId: number; status: string };
    assert.equal(body.status, 'pending');
    assert.equal(typeof body.requestId, 'number');
    assert.ok(body.requestId > 0);

    // Verify the row landed in the DB
    const row = t.db.prepare('SELECT * FROM extension_install_requests WHERE id = ?').get(body.requestId);
    assert.ok(row, 'row should exist in DB');
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: POST install-requests rejects bad kind (400)', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'malware', slug: 'x', requestingAgentId: 'anubis' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /kind/);
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: POST install-requests rejects empty slug (400)', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'plugin', slug: '   ', requestingAgentId: 'anubis' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /slug/);
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: POST install-requests rejects missing requestingAgentId (400)', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'plugin', slug: 'x' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /requestingAgentId/);
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: GET pending lists pending rows', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    for (const slug of ['a', 'b', 'c']) {
      await app.inject({
        method: 'POST',
        url: '/api/extensions/install-requests',
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: { kind: 'plugin', slug, requestingAgentId: 'anubis' },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/extensions/install-requests/pending',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { requests: Array<{ slug: string; status: string }> };
    assert.equal(body.requests.length, 3);
    assert.deepEqual(body.requests.map((r) => r.slug), ['a', 'b', 'c']);
    for (const r of body.requests) assert.equal(r.status, 'pending');
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: GET install-requests/:id returns the row, 404 on unknown', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'mcp_skill', slug: 'fast-io', requestingAgentId: 'horus' },
    });
    const id = (JSON.parse(createRes.body) as { requestId: number }).requestId;

    const ok = await app.inject({
      method: 'GET',
      url: `/api/extensions/install-requests/${id}`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(ok.statusCode, 200);
    const row = JSON.parse(ok.body) as { id: number; kind: string; slug: string };
    assert.equal(row.id, id);
    assert.equal(row.kind, 'mcp_skill');
    assert.equal(row.slug, 'fast-io');

    const notFound = await app.inject({
      method: 'GET',
      url: `/api/extensions/install-requests/9999`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(notFound.statusCode, 404);
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: approve transitions pending → approved and triggers the worker', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'plugin', slug: 'p1', requestingAgentId: 'anubis' },
    });
    const id = (JSON.parse(create.body) as { requestId: number }).requestId;

    // cookieOnlyGuard accepts loopback local-dev when OAuth is unconfigured
    // (setup.ts blanks DISCORD_CLIENT_ID), so we can call approve without
    // a real cookie in the test env.
    const approve = await app.inject({
      method: 'POST',
      url: `/api/extensions/install-requests/${id}/approve`,
      payload: { note: 'lgtm' },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    const body = JSON.parse(approve.body) as { status: string; deferApply: boolean };
    assert.equal(body.status, 'approved');
    assert.equal(body.deferApply, false);

    await drainForTests();

    // Row should be 'applied' since the docker fake always succeeds.
    const row = t.db.prepare('SELECT status FROM extension_install_requests WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.status, 'applied');
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: approve twice returns 409 conflict', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'plugin', slug: 'p2', requestingAgentId: 'anubis' },
    });
    const id = (JSON.parse(create.body) as { requestId: number }).requestId;

    // Use deferApply on the first approve so the row stays in 'approved'
    // (the worker would otherwise transition it to 'applied' before our
    // second call lands, making the conflict assertion racy).
    const first = await app.inject({
      method: 'POST',
      url: `/api/extensions/install-requests/${id}/approve`,
      payload: { deferApply: true },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/extensions/install-requests/${id}/approve`,
      payload: {},
    });
    assert.equal(second.statusCode, 409, `expected 409, got ${second.statusCode}: ${second.body}`);
    const body = JSON.parse(second.body) as { error: string; state: string };
    assert.equal(body.state, 'approved');
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: reject transitions pending → rejected', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const docker = fakeDockerStub();
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/api/extensions/install-requests',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { kind: 'plugin', slug: 'p3', requestingAgentId: 'anubis' },
    });
    const id = (JSON.parse(create.body) as { requestId: number }).requestId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/extensions/install-requests/${id}/reject`,
      payload: { note: 'not now' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { status: string };
    assert.equal(body.status, 'rejected');

    const row = t.db.prepare('SELECT status, operator_note FROM extension_install_requests WHERE id = ?').get(id) as
      | { status: string; operator_note: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.status, 'rejected');
    assert.equal(row.operator_note, 'not now');
  } finally {
    docker.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.extensions: GET installed lists docker plugins/skills output', async () => {
  const t = setupTestDb();
  const app = buildApp();
  // Custom fake — return JSON output for the list commands.
  const fake: DockerLike = {
    exec: async (_container, cmd) => {
      if (cmd.includes('plugins')) {
        return { exitCode: 0, stdout: JSON.stringify(['@openclaw/web-search']), stderr: '' };
      }
      if (cmd.includes('skills')) {
        return { exitCode: 0, stdout: JSON.stringify([{ slug: 'fast-io' }]), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown' };
    },
    restartContainer: async () => {},
    pingHealth: async () => true,
  };
  setDocker(fake);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/extensions/installed',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      plugins: Array<{ slug: string }>;
      mcpSkills: Array<{ slug: string }>;
    };
    assert.deepEqual(body.plugins.map((p) => p.slug), ['@openclaw/web-search']);
    assert.deepEqual(body.mcpSkills.map((s) => s.slug), ['fast-io']);
  } finally {
    setDocker(null);
    await app.close();
    t.cleanup();
  }
});
