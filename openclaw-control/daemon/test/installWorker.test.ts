/**
 * installWorker — TASK_2026_006 Batch 8b.
 *
 * Exercises the in-process serial worker without standing up real docker.
 * The `DockerLike` surface is injected with a fully scripted fake so each
 * test can decide what `docker exec`, `docker restart`, and `/health`
 * return.
 *
 * Coverage:
 *   1. Approved requests process serially (concurrency=1)
 *   2. Non-zero install exit → markFailed, NO restart attempted
 *   3. CLI restart non-zero → fallback to docker.restartContainer succeeds
 *   4. SSE events fire in order: installs.applied / installs.failed
 *   5. Worker drops jobs whose row is no longer in 'approved' state
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './env-stamp.ts';
import { setupTestDb } from './setup.ts';
import {
  enqueueApproved,
  setDocker,
  setTimingsForTests,
  drainForTests,
  type DockerLike,
  type DockerExecResult,
} from '../src/installWorker.ts';
import { InstallRequestsRepo } from '../src/db/installRequests.ts';
import { attachSse, broadcast } from '../src/sse.ts';
import { buildApp } from '../src/api.ts';

interface ExecCall {
  container: string;
  cmd: readonly string[];
}

interface FakeBehavior {
  exec?: (call: ExecCall) => DockerExecResult | Promise<DockerExecResult>;
  restart?: (container: string) => void | Promise<void>;
  ping?: () => boolean | Promise<boolean>;
}

interface FakeDocker {
  docker: DockerLike;
  execCalls: ExecCall[];
  restartCalls: string[];
}

function makeDocker(behavior: FakeBehavior = {}): FakeDocker {
  const execCalls: ExecCall[] = [];
  const restartCalls: string[] = [];
  const docker: DockerLike = {
    exec: async (container, cmd) => {
      execCalls.push({ container, cmd });
      if (behavior.exec) return behavior.exec({ container, cmd });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    restartContainer: async (container) => {
      restartCalls.push(container);
      if (behavior.restart) await behavior.restart(container);
    },
    pingHealth: async () => {
      if (behavior.ping) return behavior.ping();
      return true;
    },
  };
  return { docker, execCalls, restartCalls };
}

const FAST_TIMINGS = {
  installTimeoutMs: 200,
  cliRestartTimeoutMs: 100,
  healthTimeoutMs: 50,
  healthPollMs: 5,
};

/**
 * SSE event capture without standing up a real HTTP client. We hook the
 * raw socket interface that `sse.ts:attachSse` writes to.
 */
interface CapturedEvent {
  event: string;
  data: unknown;
}

function attachCapture(): { events: CapturedEvent[]; restore: () => void } {
  const events: CapturedEvent[] = [];
  const closeListeners: Array<() => void> = [];
  const fakeSocket: Record<string, unknown> = {
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      const eventLine = chunk.match(/^event: ([^\n]+)/m);
      const dataLine = chunk.match(/^data: ([^\n]+)/m);
      if (eventLine && dataLine) {
        try {
          events.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) });
        } catch {
          // ignore malformed payloads
        }
      }
    },
    on(event: string, listener: () => void) {
      if (event === 'close') closeListeners.push(listener);
    },
  };
  const fakeReply = { raw: fakeSocket } as unknown as Parameters<typeof attachSse>[0];
  attachSse(fakeReply);
  return {
    events,
    restore: () => {
      // Fire 'close' so attachSse clears its 15s ping interval and removes
      // the client; otherwise the active interval keeps the test process
      // alive past completion.
      for (const cb of closeListeners) cb();
    },
  };
}

test('installWorker: two approved requests process serially with order preserved', async () => {
  const t = setupTestDb();
  const fake = makeDocker();
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  try {
    // Seed two pending requests, then approve both
    const r1 = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'first',
      requestingAgentId: 'anubis',
    });
    const r2 = InstallRequestsRepo.create({
      kind: 'mcp_skill',
      slug: 'second',
      requestingAgentId: 'anubis',
    });
    InstallRequestsRepo.markApproved(r1.id);
    InstallRequestsRepo.markApproved(r2.id);

    enqueueApproved(r1.id);
    enqueueApproved(r2.id);
    await drainForTests();

    // Both transitioned to applied
    const after1 = InstallRequestsRepo.get(r1.id);
    const after2 = InstallRequestsRepo.get(r2.id);
    assert.equal(after1?.status, 'applied');
    assert.equal(after2?.status, 'applied');

    // Exec calls: install + restart for each, in order
    // 1. plugins install first, 2. gateway restart, 3. skills install second, 4. gateway restart
    assert.ok(fake.execCalls.length >= 4, `expected >=4 exec calls, got ${fake.execCalls.length}`);
    assert.deepEqual(fake.execCalls[0].cmd, ['openclaw', 'plugins', 'install', 'first']);
    assert.deepEqual(fake.execCalls[1].cmd, ['openclaw', 'gateway', 'restart']);
    assert.deepEqual(fake.execCalls[2].cmd, ['openclaw', 'skills', 'install', 'second']);
    assert.deepEqual(fake.execCalls[3].cmd, ['openclaw', 'gateway', 'restart']);
  } finally {
    restore();
    setDocker(null);
    t.cleanup();
  }
});

test('installWorker: non-zero install exit → markFailed, NO restart attempted', async () => {
  const t = setupTestDb();
  const fake = makeDocker({
    exec: ({ cmd }) => {
      if (cmd.includes('install')) {
        return { exitCode: 1, stdout: '', stderr: 'package not found' };
      }
      // restart command — should NEVER be reached in this test
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  try {
    const r = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'bogus',
      requestingAgentId: 'anubis',
    });
    InstallRequestsRepo.markApproved(r.id);

    enqueueApproved(r.id);
    await drainForTests();

    const after = InstallRequestsRepo.get(r.id);
    assert.equal(after?.status, 'failed');
    assert.match(after?.installOutput ?? '', /package not found/);

    // No restart command was issued
    const restartCalls = fake.execCalls.filter((c) => c.cmd.includes('restart'));
    assert.equal(restartCalls.length, 0, 'restart must NOT be attempted on install failure');
    assert.equal(fake.restartCalls.length, 0, 'docker restart must NOT be attempted');
  } finally {
    restore();
    setDocker(null);
    t.cleanup();
  }
});

test('installWorker: CLI restart returning non-zero → falls back to docker restart', async () => {
  const t = setupTestDb();
  const fake = makeDocker({
    exec: ({ cmd }) => {
      if (cmd.includes('install')) {
        return { exitCode: 0, stdout: 'installed', stderr: '' };
      }
      if (cmd.includes('restart')) {
        return { exitCode: 5, stdout: '', stderr: 'cli restart unavailable' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  try {
    const r = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'p',
      requestingAgentId: 'anubis',
    });
    InstallRequestsRepo.markApproved(r.id);

    enqueueApproved(r.id);
    await drainForTests();

    const after = InstallRequestsRepo.get(r.id);
    assert.equal(after?.status, 'applied');
    assert.equal(fake.restartCalls.length, 1, 'fallback docker restart must be called once');
    assert.equal(fake.restartCalls[0], 'openclaw-gateway');
  } finally {
    restore();
    setDocker(null);
    t.cleanup();
  }
});

test('installWorker: emits installs.applied SSE event on success', async () => {
  const t = setupTestDb();
  const fake = makeDocker();
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  // Build app to ensure SSE module is initialized (no-op but mirrors prod)
  const app = buildApp();
  const cap = attachCapture();
  try {
    const r = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'happy',
      requestingAgentId: 'anubis',
    });
    InstallRequestsRepo.markApproved(r.id);
    enqueueApproved(r.id);
    await drainForTests();

    const applied = cap.events.find((e) => e.event === 'installs.applied');
    assert.ok(applied, `expected installs.applied event, got: ${cap.events.map((e) => e.event).join(',')}`);
    assert.equal((applied!.data as { requestId: number }).requestId, r.id);

    const failed = cap.events.find((e) => e.event === 'installs.failed');
    assert.equal(failed, undefined, 'should not emit installs.failed on success');
  } finally {
    cap.restore();
    restore();
    setDocker(null);
    await app.close();
    t.cleanup();
  }
});

test('installWorker: emits installs.failed SSE event when install command fails', async () => {
  const t = setupTestDb();
  const fake = makeDocker({
    exec: ({ cmd }) => {
      if (cmd.includes('install')) return { exitCode: 7, stdout: '', stderr: 'boom' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  const app = buildApp();
  const cap = attachCapture();
  try {
    const r = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'sad',
      requestingAgentId: 'anubis',
    });
    InstallRequestsRepo.markApproved(r.id);
    enqueueApproved(r.id);
    await drainForTests();

    const failed = cap.events.find((e) => e.event === 'installs.failed');
    assert.ok(failed, 'expected installs.failed event');
    assert.equal((failed!.data as { requestId: number }).requestId, r.id);
  } finally {
    cap.restore();
    restore();
    setDocker(null);
    await app.close();
    t.cleanup();
  }
});

test('installWorker: drops job whose row is no longer in approved state', async () => {
  const t = setupTestDb();
  const fake = makeDocker();
  setDocker(fake.docker);
  const restore = setTimingsForTests(FAST_TIMINGS);
  try {
    const r = InstallRequestsRepo.create({
      kind: 'plugin',
      slug: 'noop',
      requestingAgentId: 'anubis',
    });
    // Leave it in 'pending' — do NOT approve
    enqueueApproved(r.id);
    await drainForTests();

    const after = InstallRequestsRepo.get(r.id);
    assert.equal(after?.status, 'pending');
    assert.equal(fake.execCalls.length, 0, 'no docker exec on non-approved row');
  } finally {
    restore();
    setDocker(null);
    t.cleanup();
  }
});

// Silence broadcast typing import "unused" warning by referencing it
void broadcast;
