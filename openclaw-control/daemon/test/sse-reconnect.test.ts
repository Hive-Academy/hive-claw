/**
 * T6.7 — SSE-reconnect smoke test (follower).
 *
 * Validates implementation-plan.md §12.6 lines 1158-1162 and the §7 line 779
 * polling-floor invariant: when the follower's SSE channel to the leader
 * drops, `subscribeDispatchSse` reconnects with exponential backoff
 * (capped at 30 s) and signals the caller with `null` on every successful
 * (re)connect — so the caller can refresh its pending list across the gap.
 *
 * Strategy:
 *   1. Boot a leader Fastify app on an ephemeral port.
 *   2. Configure leaderClient against that base URL.
 *   3. `subscribeDispatchSse` — wait for the first `null` (initial connect).
 *   4. Broadcast `dispatch.pending` on the leader; assert the follower
 *      receives it on the original connection.
 *   5. Force-drop the leader's SSE connection by closing all open TCP
 *      sockets (Fastify's reply.raw.write calls now fail). `app.close()`
 *      returns once the server stops accepting new sockets.
 *   6. Stand up a NEW Fastify instance on the SAME port. The reconnect
 *      loop in subscribeDispatchSse retries with backoff (initial 500 ms),
 *      and we wait for the second `null` callback.
 *   7. Broadcast on the new leader; assert the post-reconnect event lands.
 *   8. Use the polling-fallback HTTP endpoint (`listPendingForAgents`,
 *      which calls `GET /api/dispatches/pending`) to confirm a row
 *      inserted post-reconnect is visible — that is the §7 line 779
 *      polling floor.
 *
 * Budget: 15 seconds per the §12.6 "within 2× polling interval" hint with
 * default 10 s polling. In practice the reconnect is sub-2s on Linux.
 *
 * No orphaned processes — finally-block unhooks the subscription, closes
 * both apps (force-disconnecting any lingering SSE streams), and drops
 * the test DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import {
  initLeaderClient,
  subscribeDispatchSse,
  listPendingForAgents,
} from '../src/leaderClient.ts';
import { broadcast } from '../src/sse.ts';

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
        ms,
      ).unref?.(),
    ),
  ]);
}

/**
 * Force-shutdown helper: in Fastify v5 / Node 20+, `app.close()` blocks on
 * in-flight long-lived responses (SSE). `closeAllConnections()` severs
 * them so the close resolves; the SSE consumer sees a socket-error which
 * its reconnect loop is designed to handle.
 */
async function forceClose(app: ReturnType<typeof buildApp>): Promise<void> {
  try {
    app.server.closeAllConnections?.();
  } catch {
    // Older Node fallback: nothing to do; `close()` will hang briefly.
  }
  try {
    await app.close();
  } catch {
    // Already closed; ignore.
  }
}

test('SSE reconnect: follower picks up post-drop dispatches within the polling window', async () => {
  const t = setupTestDb();
  let app1: ReturnType<typeof buildApp> | null = buildApp();
  let app2: ReturnType<typeof buildApp> | null = null;
  let stopSubscription: (() => void) | null = null;

  try {
    t.ProjectsRepo.upsert({ slug: 'p1', name: 'p1' });
    t.TasksRepo.insert({ projectSlug: 'p1', id: 'T1' });

    // Bind to an ephemeral port; loopback only.
    await app1.listen({ host: '127.0.0.1', port: 0 });
    const addr1 = app1.server.address();
    if (!addr1 || typeof addr1 === 'string') throw new Error('no server address');
    const port = addr1.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    initLeaderClient(baseUrl, INTERNAL_TOKEN);

    // The callback receives `null` on every (re)connect and a parsed event
    // for each SSE block. We track both via deferred promises.
    const firstConnect = deferred<void>();
    const secondConnect = deferred<void>();
    const firstEvent = deferred<{ event: string }>();
    const postReconnectEvent = deferred<{ event: string }>();

    let connectCount = 0;
    let eventsAfterReconnect = 0;
    stopSubscription = subscribeDispatchSse((evt) => {
      if (evt === null) {
        connectCount += 1;
        if (connectCount === 1) firstConnect.resolve();
        else if (connectCount === 2) secondConnect.resolve();
        return;
      }
      if (connectCount <= 1) {
        if (evt.event === 'dispatch.pending') {
          firstEvent.resolve(evt as { event: string });
        }
      } else {
        eventsAfterReconnect += 1;
        if (evt.event === 'dispatch.pending') {
          postReconnectEvent.resolve(evt as { event: string });
        }
      }
    });

    // 1. Initial connect.
    await withTimeout(firstConnect.promise, 5_000, 'first SSE connect');

    // 2. Pre-drop event delivery. The leader does not auto-broadcast
    //    `dispatch.pending` from insertPending in the current api.ts surface,
    //    so we explicitly emit it via the SSE bus to verify event flow.
    const id1 = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'p1',
      taskId: 'T1',
      phase: 'CONTEXT',
      prompt: 'pre-drop dispatch',
      createdBy: 'test',
    });
    assert.ok(id1, 'pre-drop dispatch must insert');
    broadcast('dispatch.pending', { dispatchId: id1, agent: 'horus' });
    await withTimeout(firstEvent.promise, 5_000, 'first dispatch.pending event');

    // 3. Force-drop the SSE connection by tearing the leader down.
    await forceClose(app1);
    app1 = null;

    // 4. Stand up a fresh leader on the same port. Brief retry loop because
    //    the OS may need a moment to release the listening socket.
    let listened = false;
    for (let i = 0; i < 10; i++) {
      app2 = buildApp();
      try {
        await app2.listen({ host: '127.0.0.1', port });
        listened = true;
        break;
      } catch (err) {
        try {
          await app2.close();
        } catch {
          // best-effort
        }
        app2 = null;
        if (i === 9) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(listened && app2, 'second app must bind to the same port');

    // 5. Wait for the reconnect. subscribeDispatchSse uses 500 ms initial
    //    backoff doubling to a 30 s cap. With ECONNREFUSED retried twice
    //    plus one successful connect, this is well under 5 s in practice.
    await withTimeout(secondConnect.promise, 10_000, 'reconnect SSE connect');

    // 6. Post-reconnect event delivery.
    const id2 = t.DispatchRepo.insertPending({
      agentId: 'horus',
      projectSlug: 'p1',
      taskId: 'T1',
      phase: 'DESCRIPTION',
      prompt: 'post-reconnect dispatch',
      createdBy: 'test',
    });
    assert.ok(id2, 'post-reconnect dispatch must insert');
    broadcast('dispatch.pending', { dispatchId: id2, agent: 'horus' });
    await withTimeout(
      postReconnectEvent.promise,
      5_000,
      'post-reconnect dispatch.pending',
    );

    // 7. Polling fallback (the §7 line 779 floor): GET /api/dispatches/pending
    //    surfaces the row regardless of SSE state.
    const pending = await listPendingForAgents(['horus']);
    const ids = pending.map((d) => d.id);
    assert.ok(
      ids.includes(id2),
      `polling fallback must surface post-reconnect dispatch ${id2}, got ${JSON.stringify(ids)}`,
    );

    assert.ok(connectCount >= 2, 'must have connected at least twice (initial + reconnect)');
    assert.ok(
      eventsAfterReconnect >= 1,
      'at least one event must have been received after reconnect',
    );
  } finally {
    if (stopSubscription) {
      try {
        stopSubscription();
      } catch {
        // best-effort
      }
    }
    if (app1) {
      await forceClose(app1);
    }
    if (app2) {
      await forceClose(app2);
    }
    t.cleanup();
  }
});
