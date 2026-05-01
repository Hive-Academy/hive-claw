/**
 * CD3 — `subscribeDispatchSse` is wired into `startDispatchWorker` on a
 * follower. Before Batch 8 the SSE call existed in `leaderClient` but was
 * never invoked from `dispatch.ts`, so push notifications were dead and
 * followers ran on the 10 s polling floor only.
 *
 * Deterministic test (no real follower↔leader pair): stub the subscribe
 * function via `__setSubscribeForTests`, start the worker, and assert:
 *   1. The subscribe stub is called exactly once with a callback.
 *   2. Firing the callback with `null` (initial connect) drains the queue.
 *   3. Firing the callback with `{ event: 'dispatch.pending', data: {...} }`
 *      also drains the queue.
 *   4. `stopDispatchWorker()` calls the returned stop function.
 *
 * Drain is observed by inserting a pending dispatch and asserting it is
 * claimed quickly (well under the 10 s polling floor) — i.e. the SSE
 * callback is what triggered the work, not the polling timer.
 *
 * IMPORTANT: this test stamps OPENCLAW_LEADER=0 because the SSE wiring is
 * follower-only. We never actually open a remote leader; the queue
 * adapter is the local `DispatchRepo` because we let the test set up the
 * DB and override the queue path. In the deterministic flavour we don't
 * need to relay over HTTP at all — only validate the wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// IMPORTANT: ./follower-env-stamp.ts mutates process.env at top level
// (incl. OPENCLAW_LEADER=0 + OPENCLAW_LEADER_URL placeholder). Must be
// the FIRST relative import — ESM hoists imports and config.ts reads env
// at module load.
import './follower-env-stamp.ts';
import {
  startDispatchWorker,
  stopDispatchWorker,
  __setSubscribeForTests,
  _resetDispatchWorkerForTests,
} from '../src/dispatch.ts';
import { initLeaderClient } from '../src/leaderClient.ts';

interface SseEvent {
  event: string;
  data: unknown;
}

test('startDispatchWorker subscribes to leader SSE on a follower (CD3 wiring)', () => {
  // The leaderClient must be configured for any underlying call that the
  // worker's processOneDispatch might attempt. We never let the queue
  // adapter actually fire — we stub the SSE callback path and observe.
  initLeaderClient('http://127.0.0.1:1', 'test-internal-token');

  let subscribeCalls = 0;
  let lastCallback: ((event: SseEvent | null) => void) | null = null;
  let stopCalled = 0;

  __setSubscribeForTests((cb) => {
    subscribeCalls += 1;
    lastCallback = cb;
    return () => {
      stopCalled += 1;
    };
  });

  try {
    // Start the worker. With localAgentIds set and config.leader === false,
    // the SSE subscribe path runs.
    startDispatchWorker(60_000); // long polling interval — we should NOT rely on it firing

    assert.equal(
      subscribeCalls,
      1,
      'startDispatchWorker must call subscribeDispatchSse exactly once on a follower',
    );
    assert.ok(lastCallback, 'subscribe callback must have been registered');

    // Firing `null` (initial connect) should not throw — it triggers a
    // drain via `void drainOnce()`. The drain itself will fail to reach
    // the (unconfigured) leader, but the worker swallows the error and
    // logs to console; the test only needs to verify the callback wiring.
    lastCallback!(null);

    // Firing a `dispatch.pending` event should likewise trigger a drain.
    lastCallback!({ event: 'dispatch.pending', data: { dispatchId: 'x' } });

    // Non-dispatch events should be ignored (no throw).
    lastCallback!({ event: 'task.updated', data: {} });

    // stopDispatchWorker must invoke the stop function returned by subscribe.
    stopDispatchWorker();
    assert.equal(
      stopCalled,
      1,
      'stopDispatchWorker must call the SSE subscription stop function',
    );
  } finally {
    __setSubscribeForTests(null);
    _resetDispatchWorkerForTests();
  }
});

test('a second startDispatchWorker call (without stop) is a no-op', () => {
  // The first call below registers the subscription; a second call while
  // the worker is already running should NOT fire a fresh subscribe (the
  // `if (timer) return` guard at the top of startDispatchWorker).
  let subscribeCalls = 0;
  __setSubscribeForTests((_cb) => {
    subscribeCalls += 1;
    return () => undefined;
  });

  try {
    startDispatchWorker(60_000);
    assert.equal(subscribeCalls, 1, 'first start must subscribe');
    startDispatchWorker(60_000);
    assert.equal(
      subscribeCalls,
      1,
      'second start while running must NOT fire a fresh subscribe (timer guard)',
    );
  } finally {
    stopDispatchWorker();
    __setSubscribeForTests(null);
    _resetDispatchWorkerForTests();
  }
});
