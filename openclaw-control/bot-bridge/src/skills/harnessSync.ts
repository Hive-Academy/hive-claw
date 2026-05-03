// skills/harnessSync.ts — TASK_2026_002 B3 harness/sync subscriber.
//
// Subscribes to the Redis `harness/sync` topic so the bot-bridge picks up
// hot-reload requests from the daemon. The daemon publishes
// `{ agentId, harnessHash }` whenever a persona's harness.yaml changes
// (via `POST /api/agents/:id/harness/sync` → `bus.publishHarnessSync`).
//
// We intentionally do NOT reuse the bot-bridge's existing daemon-SSE channel
// (impl-plan §"Hot-reload via harness/sync" line 984): Redis pub/sub is the
// architect's chosen mechanism so the daemon and the bot can fan out
// independently, without the SSE stream being a single point of failure.
//
// Fail-open: when REDIS_URL is empty (dev / single-machine smoke tests with
// no Redis available) we log a warning and return a no-op `stop()`. The bot
// stays alive; hot-reload simply does not propagate. This matches how
// `agentRegistry.ensureStatusPublisher` already degrades silently.

import Redis, { type Redis as RedisClient } from 'ioredis';
import { config } from '../config.js';

/**
 * Test seam — when set, `startHarnessSync` uses this client instead of
 * constructing a fresh `new Redis(config.redisUrl)`. Tests reset to `null`
 * in their teardown. Production code never reads or writes this.
 */
let __testClient: RedisClient | null = null;
export function __setRedisClientForTests(client: RedisClient | null): void {
  __testClient = client;
}

export interface HarnessSyncPayload {
  agentId: string;
  /** Optional sha256 of the new harness.yaml — used by callers to dedupe. */
  harnessHash?: string;
}

export interface HarnessSyncHandlers {
  /**
   * Called once per `harness/sync` event whose payload decodes to a non-empty
   * `agentId`. Errors thrown here are logged and swallowed — the subscriber
   * must not crash on a single bad reload.
   */
  onAgentChanged: (agentId: string, payload: HarnessSyncPayload) => Promise<void> | void;
}

export const HARNESS_SYNC_TOPIC = 'harness/sync';

/**
 * Start the Redis subscriber for `harness/sync`. Returns a `stop()` thunk that
 * unsubscribes and disconnects the client; call it from the SIGTERM handler
 * in `index.ts` so the process can exit cleanly.
 *
 * The returned promise resolves once the subscription is confirmed — callers
 * can `await` it on boot to know the listener is ready.
 */
export async function startHarnessSync(
  handlers: HarnessSyncHandlers,
): Promise<() => Promise<void>> {
  if (!__testClient && !config.redisUrl) {
    console.warn(
      '[harness-sync] REDIS_URL not set — harness/sync hot-reload disabled ' +
        '(personas reload only on bot-bridge restart)',
    );
    return async () => {};
  }

  const client: RedisClient = __testClient ?? new Redis(config.redisUrl);

  client.on('error', (err: Error) => {
    // ioredis auto-reconnects; we surface the error so it shows up in the
    // operator's tail without crashing the bot.
    console.error('[harness-sync] redis error:', err?.message ?? err);
  });

  client.on('message', (channel: string, message: string) => {
    if (channel !== HARNESS_SYNC_TOPIC) return;
    let payload: HarnessSyncPayload;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn('[harness-sync] dropped non-object payload:', message);
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const agentId = typeof obj.agentId === 'string' ? obj.agentId : '';
      if (!agentId) {
        console.warn('[harness-sync] dropped payload with empty agentId:', message);
        return;
      }
      const harnessHash =
        typeof obj.harnessHash === 'string' ? obj.harnessHash : undefined;
      payload = harnessHash !== undefined ? { agentId, harnessHash } : { agentId };
    } catch (err) {
      console.warn(
        `[harness-sync] dropped malformed JSON payload: ${(err as Error).message}`,
      );
      return;
    }

    // Fire and forget — we deliberately do NOT block the Redis client's
    // message loop on the handler. Errors propagate to console.
    void Promise.resolve()
      .then(() => handlers.onAgentChanged(payload.agentId, payload))
      .catch((err) => {
        console.error(
          `[harness-sync] onAgentChanged for "${payload.agentId}" failed:`,
          (err as Error)?.message ?? err,
        );
      });
  });

  await client.subscribe(HARNESS_SYNC_TOPIC);
  console.log(`[harness-sync] subscribed to ${HARNESS_SYNC_TOPIC}`);

  return async () => {
    try {
      await client.unsubscribe(HARNESS_SYNC_TOPIC);
    } catch {
      // best-effort — connection might already be torn down
    }
    await client.quit().catch(() => {});
  };
}
