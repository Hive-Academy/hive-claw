/**
 * api.ptah-invoke — TASK_2026_006 Batch 3.
 *
 * `POST /api/ptah/invoke` is the daemon-side endpoint the future plugin's
 * `invoke_ptah` tool will call. It wraps `spawnPtahForAgent` and exposes:
 *
 *   - Auth gate (Bearer internal token).
 *   - Body validation: project + prompt required; path-traversal rejected;
 *     timeoutMs bounded by `config.ptah.invokerTimeoutMs`.
 *   - 404 on unknown project slug.
 *   - Happy path: success result wrapped as
 *     `{ ok:true, exitCode, durationMs, output }`.
 *   - Timeout: stubbed bridge that never resolves trips the route-side
 *     `Promise.race` and returns
 *     `{ ok:false, exitCode:null, durationMs, output:'', stderr: '...timed out...' }`.
 *
 * Bridge is stubbed via `__setInvokeViaBridgeForTests` from `ptahBridge.ts`;
 * the test never spawns a real ptah subprocess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// IMPORTANT: launcher-env-stamp.ts must be the FIRST relative import. It
// stamps OPENCLAW_HOST_HOME, OPENCLAW_PTAH_BRIDGE_URL, and the rest BEFORE
// config.ts reads env at module load. ESM imports are hoisted; mutating
// process.env in this file's body is too late.
import { AGENTS_ROOT } from './launcher-env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import {
  __setInvokeViaBridgeForTests,
  isBridgeEnabled,
  type BridgeInvokeOptions,
  type BridgeInvokeResult,
} from '../src/ptahBridge.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `api.ptah-invoke.test: env override didn't reach config — got "${config.localAgentsRoot}", want "${AGENTS_ROOT}". ` +
      'launcher-env-stamp.ts must be the FIRST relative import.',
  );
}
if (!isBridgeEnabled()) {
  throw new Error(
    'api.ptah-invoke.test: bridge env not set — launcher-env-stamp.ts must be the FIRST relative import',
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;
const TEST_PROJECT_SLUG = 'test-project';
const TEST_PROJECT_PATH = '/tmp/openclaw-test-workspace';

interface CapturedBridgeCall {
  opts: BridgeInvokeOptions;
}

function stubBridgeOk(stdout: string): { calls: CapturedBridgeCall[]; restore: () => void } {
  const calls: CapturedBridgeCall[] = [];
  __setInvokeViaBridgeForTests(async (opts: BridgeInvokeOptions): Promise<BridgeInvokeResult> => {
    calls.push({ opts });
    return { ok: true, exitCode: 0, stdout, stderr: '', durationMs: 5 };
  });
  return { calls, restore: () => __setInvokeViaBridgeForTests(null) };
}

function stubBridgeNeverResolves(): { restore: () => void } {
  __setInvokeViaBridgeForTests(
    () => new Promise<BridgeInvokeResult>(() => { /* never resolves */ }),
  );
  return { restore: () => __setInvokeViaBridgeForTests(null) };
}

function seedProject(t: ReturnType<typeof setupTestDb>): void {
  t.ProjectsRepo.upsert({
    slug: TEST_PROJECT_SLUG,
    name: TEST_PROJECT_SLUG,
    workspace: TEST_PROJECT_PATH,
  });
}

test('api.ptah-invoke: 401 on missing Bearer token', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      payload: { project: TEST_PROJECT_SLUG, prompt: 'hello' },
    });
    assert.notEqual(
      res.statusCode,
      200,
      `unauthenticated POST must NOT succeed (got 200 — auth gate broken)`,
    );
    assert.equal(stub.calls.length, 0, 'bridge must not be called when auth fails');
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: 400 on missing project', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { prompt: 'hello' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /project/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: 400 on missing prompt', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    seedProject(t);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { project: TEST_PROJECT_SLUG },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /prompt/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: 400 on path-traversal project slug', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { project: '../etc/passwd', prompt: 'hello' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /must not contain/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: 400 on timeoutMs exceeding upper bound', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    seedProject(t);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        project: TEST_PROJECT_SLUG,
        prompt: 'hello',
        timeoutMs: config.ptah.invokerTimeoutMs + 1,
      },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /timeoutMs/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: 404 on unknown project', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('');
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { project: 'no-such-project', prompt: 'hello' },
    });
    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /project not found/);
    assert.equal(stub.calls.length, 0, 'bridge must not be called when project is unknown');
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: happy-path 200 wraps spawn result in documented envelope', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeOk('PTAH OK\nhello world');
  try {
    seedProject(t);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        project: TEST_PROJECT_SLUG,
        prompt: 'do the thing',
        agentId: 'horus',
        sessionKey: 'sess-abc',
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      exitCode: number;
      durationMs: number;
      output: string;
      stderr?: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.exitCode, 0);
    assert.equal(typeof body.durationMs, 'number');
    assert.equal(body.output, 'PTAH OK\nhello world');
    assert.equal(body.stderr, undefined, 'stderr must be absent on success envelope');

    // Bridge was called exactly once with the project's workspace path and
    // the caller-supplied agentId + sessionKey threaded through to taskId.
    assert.equal(stub.calls.length, 1, 'bridge must be called exactly once');
    const call = stub.calls[0]!.opts;
    assert.equal(call.cwd, TEST_PROJECT_PATH);
    assert.equal(call.prompt, 'do the thing');
    assert.equal(call.agentId, 'horus');
    assert.equal(call.taskId, 'sess-abc');
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: bridge failure surfaces ok=false envelope with stderr', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const calls: CapturedBridgeCall[] = [];
  __setInvokeViaBridgeForTests(async (opts: BridgeInvokeOptions): Promise<BridgeInvokeResult> => {
    calls.push({ opts });
    return {
      ok: false,
      exitCode: 1,
      stdout: 'partial',
      stderr: 'ptah crashed',
      durationMs: 7,
    };
  });
  try {
    seedProject(t);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { project: TEST_PROJECT_SLUG, prompt: 'do the thing' },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      exitCode: number | null;
      durationMs: number;
      output: string;
      stderr?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.exitCode, 1);
    assert.equal(body.output, 'partial');
    assert.equal(body.stderr, 'ptah crashed');
    assert.equal(calls.length, 1);
  } finally {
    __setInvokeViaBridgeForTests(null);
    await app.close();
    t.cleanup();
  }
});

test('api.ptah-invoke: timeout returns ok=false with non-empty stderr', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const stub = stubBridgeNeverResolves();
  try {
    seedProject(t);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptah/invoke',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { project: TEST_PROJECT_SLUG, prompt: 'long running', timeoutMs: 50 },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      exitCode: number | null;
      durationMs: number;
      output: string;
      stderr?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.exitCode, null);
    assert.equal(body.output, '');
    assert.ok(typeof body.stderr === 'string' && body.stderr.length > 0, 'stderr must be a non-empty string on timeout');
    assert.match(body.stderr!, /timed out/i);
    assert.ok(body.durationMs >= 50, `durationMs ${body.durationMs} should reflect the timeout window`);
  } finally {
    stub.restore();
    await app.close();
    t.cleanup();
  }
});
