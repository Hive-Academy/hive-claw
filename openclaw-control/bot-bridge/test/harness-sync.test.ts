/**
 * harness-sync — TASK_2026_002 B3 sub-task 2.
 *
 * Verifies the Redis subscriber wiring end-to-end against a duck-typed
 * Redis stub:
 *
 *  1. `startHarnessSync` calls `subscribe('harness/sync')` exactly once.
 *  2. A published `{ agentId: 'horus', harnessHash: '...' }` message routes
 *     to the supplied `onAgentChanged` exactly once with `'horus'`.
 *  3. The returned `stop()` thunk unsubscribes and quits the client.
 *  4. Malformed JSON is dropped with a warning, handler does NOT fire.
 *  5. Non-string `agentId` is dropped with a warning, handler does NOT fire.
 *
 * The stub mimics the slice of ioredis our subscriber uses (`on`,
 * `subscribe`, `unsubscribe`, `quit`, plus a test-only `simulateMessage`).
 */

// Env vars must land before any import that transitively reads config.ts.
process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
// Force a non-empty REDIS_URL so the subscriber does NOT short-circuit to
// the no-Redis no-op path; the test seam injects a fake client below.
process.env.REDIS_URL = 'redis://stubbed:6379';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Redis as RedisClient } from 'ioredis';

let startHarnessSync: typeof import('../src/skills/harnessSync.ts').startHarnessSync;
let HARNESS_SYNC_TOPIC: string;
let __setRedisClientForTests: typeof import('../src/skills/harnessSync.ts').__setRedisClientForTests;

before(async () => {
  const mod = await import('../src/skills/harnessSync.ts');
  startHarnessSync = mod.startHarnessSync;
  HARNESS_SYNC_TOPIC = mod.HARNESS_SYNC_TOPIC;
  __setRedisClientForTests = mod.__setRedisClientForTests;
});

interface FakeRedis extends EventEmitter {
  subscribed: string[];
  unsubscribed: string[];
  quitCount: number;
  simulateMessage(channel: string, payload: string): void;
}

function makeFakeRedis(): FakeRedis {
  const ee = new EventEmitter() as unknown as FakeRedis;
  ee.subscribed = [];
  ee.unsubscribed = [];
  ee.quitCount = 0;
  (ee as any).subscribe = async (...channels: string[]) => {
    ee.subscribed.push(...channels);
    return channels.length;
  };
  (ee as any).unsubscribe = async (...channels: string[]) => {
    ee.unsubscribed.push(...channels);
    return 0;
  };
  (ee as any).quit = async () => {
    ee.quitCount += 1;
    return 'OK';
  };
  ee.simulateMessage = (channel: string, payload: string) => {
    ee.emit('message', channel, payload);
  };
  return ee;
}

let warns: string[];
let origWarn: typeof console.warn;
let origError: typeof console.error;

beforeEach(() => {
  warns = [];
  origWarn = console.warn;
  origError = console.error;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
});

afterEach(() => {
  console.warn = origWarn;
  console.error = origError;
  __setRedisClientForTests(null);
});

test('harness-sync: subscribes to the harness/sync topic exactly once', async () => {
  const fake = makeFakeRedis();
  __setRedisClientForTests(fake as unknown as RedisClient);

  const stop = await startHarnessSync({ onAgentChanged: () => {} });
  assert.deepEqual(fake.subscribed, [HARNESS_SYNC_TOPIC]);
  assert.equal(HARNESS_SYNC_TOPIC, 'harness/sync', 'topic name must match the bus.ts publisher');

  await stop();
});

test('harness-sync: published payload for id=horus fires onAgentChanged exactly once with "horus"', async () => {
  const fake = makeFakeRedis();
  __setRedisClientForTests(fake as unknown as RedisClient);

  const calls: Array<{ agentId: string; payload: any }> = [];
  let resolveOnce!: () => void;
  const fired = new Promise<void>((resolve) => { resolveOnce = resolve; });

  const stop = await startHarnessSync({
    onAgentChanged: async (agentId, payload) => {
      calls.push({ agentId, payload });
      resolveOnce();
    },
  });

  fake.simulateMessage(
    HARNESS_SYNC_TOPIC,
    JSON.stringify({ agentId: 'horus', harnessHash: 'deadbeef' }),
  );

  await fired;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.agentId, 'horus');
  assert.equal(calls[0]!.payload.harnessHash, 'deadbeef');

  await stop();
});

test('harness-sync: stop() unsubscribes and quits the client', async () => {
  const fake = makeFakeRedis();
  __setRedisClientForTests(fake as unknown as RedisClient);

  const stop = await startHarnessSync({ onAgentChanged: () => {} });
  await stop();

  assert.deepEqual(fake.unsubscribed, [HARNESS_SYNC_TOPIC]);
  assert.equal(fake.quitCount, 1);
});

test('harness-sync: malformed JSON payload is dropped with a warning, handler not invoked', async () => {
  const fake = makeFakeRedis();
  __setRedisClientForTests(fake as unknown as RedisClient);

  let invoked = 0;
  const stop = await startHarnessSync({
    onAgentChanged: () => { invoked += 1; },
  });

  fake.simulateMessage(HARNESS_SYNC_TOPIC, 'not-json');
  // Tick the microtask queue.
  await new Promise((r) => setImmediate(r));

  assert.equal(invoked, 0, 'handler must NOT fire on bad JSON');
  assert.ok(warns.some((w) => /malformed JSON payload/.test(w)));

  await stop();
});

test('harness-sync: payload missing agentId is dropped with a warning, handler not invoked', async () => {
  const fake = makeFakeRedis();
  __setRedisClientForTests(fake as unknown as RedisClient);

  let invoked = 0;
  const stop = await startHarnessSync({
    onAgentChanged: () => { invoked += 1; },
  });

  fake.simulateMessage(HARNESS_SYNC_TOPIC, JSON.stringify({ harnessHash: 'orphaned' }));
  await new Promise((r) => setImmediate(r));

  assert.equal(invoked, 0);
  assert.ok(warns.some((w) => /empty agentId/.test(w)));

  await stop();
});
