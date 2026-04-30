/**
 * Leader HTTP client — Batch 3 territory.
 *
 * On followers, the dispatch worker and other read paths call into this
 * module to reach the leader's HTTP API. The full surface (listPending,
 * claim, markDone, readMemory, readTaskFile, …) lands in Batch 3.
 *
 * For Batch 2, the file exists so:
 *   1. `index.ts` can import `initLeaderClient` and follower-mode boot
 *      compiles cleanly.
 *   2. `dispatch.ts:remoteQueueAdapter()` has typed throwers it can call —
 *      the daemon will refuse to do work on a follower until Batch 3 lands,
 *      which is the explicit contract from the batch instructions.
 */

import type { Dispatch } from './db/index.js';

interface ConfiguredClient {
  baseUrl: string;
  token: string;
}

let client: ConfiguredClient | null = null;

/**
 * Capture the leader's URL and the internal bearer token. The configuration
 * is global to the process — followers always talk to exactly one leader.
 */
export function initLeaderClient(baseUrl: string, internalToken: string): void {
  if (!baseUrl || baseUrl.length === 0) {
    throw new Error('initLeaderClient: baseUrl is required');
  }
  client = { baseUrl: baseUrl.replace(/\/$/, ''), token: internalToken };
}

/**
 * Test helper / boot helper — returns whether `initLeaderClient` has been
 * called. Used by the remote queue adapter to give a more useful error
 * than "fetch undefined".
 */
export function isLeaderClientConfigured(): boolean {
  return client !== null;
}

/** Internal: read the configured client or throw a helpful error. */
function require_(): ConfiguredClient {
  if (!client) {
    throw new Error(
      'leaderClient: not configured. initLeaderClient must run during boot before any follower-side dispatch call.',
    );
  }
  return client;
}

/* -------------------------------------------------------------------------- */
/* The Batch-3 surface lives below. Each function throws synchronously so     */
/* the daemon fails loudly on a follower instead of silently no-oping.        */
/* -------------------------------------------------------------------------- */

export async function listPendingForAgents(_agentIds: readonly string[]): Promise<Dispatch[]> {
  void require_();
  throw new Error('Batch 3: leader HTTP client not yet implemented');
}

export async function claim(_id: string, _claimedBy: string): Promise<Dispatch | null> {
  void require_();
  throw new Error('Batch 3: leader HTTP client not yet implemented');
}

export async function markDone(
  _id: string,
  _info: { exitCode: number | null; durationMs: number; stderrSnippet?: string | null },
): Promise<Dispatch> {
  void require_();
  throw new Error('Batch 3: leader HTTP client not yet implemented');
}
