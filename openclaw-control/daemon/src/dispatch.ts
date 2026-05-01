import { config } from './config.js';
import { broadcast } from './sse.js';
import { publishNotify } from './bus.js';
import { invokeClaudeForTask } from './invoker.js';
import { getProject } from './projects.js';
import { readTask } from './phase.js';
import {
  DispatchRepo,
  isTerminalState,
  type Dispatch,
} from './db/index.js';
import * as leaderClient from './leaderClient.js';
import type { PendingDispatchSummary } from './leaderClient.js';

/**
 * Dispatch worker — thin orchestrator over a queue adapter.
 *
 * Two adapters with the same surface: `localQueueAdapter()` is direct
 * DispatchRepo calls (used by the leader's own worker), and
 * `remoteQueueAdapter()` is HTTP calls via leaderClient (used by
 * followers).
 *
 * The poison policy is NOT implemented in this file — it lives in
 * `DispatchRepo.markDone` (partial UNIQUE index + K-recent-failed window)
 * so both the leader's own worker and a follower hitting
 * `POST /api/dispatches/:id/done` go through the same code path.
 *
 * SSE-vs-polling (per implementation-plan.md §5 lines 538-577 and §7 line
 * 779): on a follower we subscribe to the leader's
 * `/api/stream?topics=dispatch` and trigger an immediate drain on every
 * `null` (re)connect or `dispatch.pending` event. The 10-second polling
 * interval is preserved as the SSE-reconnect-failure floor. The
 * subscription's reconnect logic (exponential backoff capped at 30 s)
 * lives in `leaderClient.subscribeDispatchSse` — we only consume it here.
 */

/**
 * QueueAdapter contract — `listPendingForAgents` returns the slim
 * `PendingDispatchSummary` shape. The worker only inspects `id` to decide
 * what to claim; full state comes back from `claim()`. Restricting the
 * type prevents future callers from relying on lossy fields (the leader's
 * /api/dispatches/pending strips `prompt` etc. for bandwidth).
 */
interface QueueAdapter {
  listPendingForAgents(agentIds: readonly string[]): Promise<PendingDispatchSummary[]>;
  claim(id: string, claimedBy: string): Promise<Dispatch | null>;
  markDone(
    id: string,
    info: { exitCode: number | null; durationMs: number; stderrSnippet?: string | null },
  ): Promise<Dispatch>;
}

function localQueueAdapter(): QueueAdapter {
  return {
    async listPendingForAgents(agentIds) {
      // The leader has the full Dispatch row in hand; project to the slim
      // shape so leader/follower paths share the contract.
      const rows = DispatchRepo.listPendingForAgents(agentIds);
      return rows.map((d) => ({
        id: d.id,
        projectSlug: d.projectSlug,
        taskId: d.taskId,
        phase: d.phase,
        agentId: d.agentId,
        createdAt: d.createdAt,
      }));
    },
    async claim(id, claimedBy) {
      return DispatchRepo.claim(id, claimedBy);
    },
    async markDone(id, info) {
      return DispatchRepo.markDone(id, {
        exitCode: info.exitCode,
        durationMs: info.durationMs,
        stderrSnippet: info.stderrSnippet ?? null,
      });
    },
  };
}

function remoteQueueAdapter(): QueueAdapter {
  return {
    listPendingForAgents: (agentIds) => leaderClient.listPendingForAgents(agentIds),
    claim: (id, claimedBy) => leaderClient.claim(id, claimedBy),
    markDone: (id, info) => leaderClient.markDone(id, info),
  };
}

/**
 * Subscribe to the leader's dispatch SSE topic so a follower learns of new
 * pending rows within ~one round-trip instead of waiting for the 10 s
 * polling tick. Returns the subscription stop function (or null when this
 * is a leader, in which case there is no leader to talk to).
 *
 * Exposed as a seam for tests: `__setSubscribeForTests` swaps the
 * underlying `leaderClient.subscribeDispatchSse` so the wiring can be
 * asserted without standing up a real follower↔leader pair.
 */
type SubscribeFn = (callback: (event: { event: string; data: unknown } | null) => void) => () => void;
let subscribeImpl: SubscribeFn = leaderClient.subscribeDispatchSse;
export function __setSubscribeForTests(fn: SubscribeFn | null): void {
  subscribeImpl = fn ?? leaderClient.subscribeDispatchSse;
}

const queue: QueueAdapter = config.leader ? localQueueAdapter() : remoteQueueAdapter();

function hostId(): string {
  return process.env.HOSTNAME ?? 'worker';
}

function snippet(s: string, max = 4096): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function statusLineFor(final: Dispatch, exitCode: number | null, durationMs: number): string {
  if (final.state === 'done') {
    return `done **${final.taskId}** (phase: **${final.phase}**) — ${durationMs}ms`;
  }
  if (final.state === 'poisoned') {
    return `poisoned **${final.taskId}** (phase: **${final.phase}**) — ${final.failureCount} consecutive failures, will not retry until acknowledged`;
  }
  if (final.state === 'failed') {
    if (exitCode === null) {
      return `no exit code (invocation may not have run) **${final.taskId}** (phase: **${final.phase}**) — ${durationMs}ms`;
    }
    return `failed **${final.taskId}** (phase: **${final.phase}**) — exit=${exitCode}, ${durationMs}ms`;
  }
  return `state=${final.state} **${final.taskId}** (phase: **${final.phase}**)`;
}

/**
 * Process exactly one pending dispatch addressed to this machine's local
 * agents. Returns `{ processed: true }` when work happened, regardless of
 * whether the work succeeded or failed (a poisoned/failed final state is
 * still "processed" — we got through the lifecycle).
 */
export async function processOneDispatch(): Promise<{ processed: boolean; dispatchId?: string }> {
  if (config.localAgentIds.length === 0) return { processed: false };

  const candidates = await queue.listPendingForAgents(config.localAgentIds);
  if (candidates.length === 0) return { processed: false };

  // listPendingForAgents returns oldest-first.
  const next = candidates[0];

  const claimed = await queue.claim(next.id, hostId());
  if (!claimed) {
    // Either the row vanished, was already taken, or is no longer pending.
    // No-op: a future tick will pick up whatever is next.
    return { processed: false };
  }

  broadcast('dispatch.taken', { dispatchId: claimed.id, agent: claimed.agentId });

  // Notify Discord we've picked it up. Non-fatal on failure.
  const project = await getProject(claimed.projectSlug);
  const task = project ? await readTask(project, claimed.taskId) : null;
  if (task?.channelId) {
    await publishNotify({
      agentId: claimed.agentId,
      channelId: task.channelId,
      text: `picked up **${claimed.taskId}** (phase: **${claimed.phase}**) — running via ptah-cli, will report when done.`,
    }).catch((err) => console.warn('[dispatch] notify (taken) failed', err));
  }

  // If we cannot find the project or task, mark the dispatch failed and exit.
  // The poison policy lives in markDone, so a chronically broken project
  // ref will eventually transition to poisoned.
  if (!project || !task) {
    const finalErr = await queue
      .markDone(claimed.id, {
        exitCode: null,
        durationMs: 0,
        stderrSnippet: !project
          ? `unknown project ${claimed.projectSlug}`
          : `unknown task ${claimed.projectSlug}/${claimed.taskId}`,
      })
      .catch((err) => {
        console.error('[dispatch] markDone (no-project/task) failed', err);
        return null;
      });
    if (finalErr) {
      broadcast(`dispatch.${finalErr.state}`, {
        dispatchId: claimed.id,
        ok: false,
        exitCode: null,
      });
    }
    return { processed: true, dispatchId: claimed.id };
  }

  // Run the work.
  const result = await invokeClaudeForTask({
    project,
    task,
    agentId: claimed.agentId,
    prompt: claimed.prompt,
    dispatchId: claimed.id,
  });

  // Report. Server-side `markDone` decides terminal state (done / failed /
  // poisoned) using the K-recent-failed window from
  // implementation-plan.md §7. The worker is a thin client of that decision.
  let final: Dispatch | null = null;
  try {
    final = await queue.markDone(claimed.id, {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stderrSnippet: snippet(result.stderr),
    });
  } catch (err) {
    console.error('[dispatch] markDone failed', err);
  }

  if (final) {
    if (task.channelId) {
      await publishNotify({
        agentId: claimed.agentId,
        channelId: task.channelId,
        text: statusLineFor(final, result.exitCode, result.durationMs),
      }).catch((err) => console.warn('[dispatch] notify (done) failed', err));
    }
    broadcast(`dispatch.${final.state}`, {
      dispatchId: claimed.id,
      ok: final.state === 'done',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      terminal: isTerminalState(final.state),
    });
  }

  return { processed: true, dispatchId: claimed.id };
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;
let stopSubscription: (() => void) | null = null;
let draining = false;

/**
 * Drain pending dispatches addressed to this machine. Reentrant-safe via
 * the `draining` guard — multiple SSE events firing in quick succession
 * coalesce into a single drain so we never have two concurrent
 * `processOneDispatch` chains racing against the same row.
 */
async function drainOnce(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    while ((await processOneDispatch()).processed) {
      // keep going until the queue is empty
    }
  } catch (err) {
    console.error('[dispatch] drain error', err);
  } finally {
    draining = false;
  }
}

export function startDispatchWorker(intervalMs = 10_000): void {
  if (timer) return;
  if (config.localAgentIds.length === 0) return;
  const tick = async () => {
    if (stopping) return;
    try {
      await drainOnce();
    } finally {
      if (!stopping) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);

  // Followers subscribe to the leader's dispatch SSE so push notifications
  // trigger an immediate drain. The polling tick above remains as the
  // floor — it covers SSE-stream gaps, leader restarts, and config errors
  // that prevent the subscription from establishing.
  if (!config.leader) {
    try {
      stopSubscription = subscribeImpl((event) => {
        // `null` fires on every (re)connect — a fresh drain catches anything
        // that arrived during the disconnect window.
        if (event === null) {
          void drainOnce();
          return;
        }
        // Push events of interest: `dispatch.pending` (new work) and
        // `dispatch.taken`/`dispatch.done`/etc which can free up another
        // candidate for a multi-agent host. Be permissive — drain on any
        // dispatch.* event.
        if (typeof event.event === 'string' && event.event.startsWith('dispatch.')) {
          void drainOnce();
        }
      });
    } catch (err) {
      // Subscription setup failed (e.g. leaderClient not configured). We
      // still have the polling timer above — log and continue.
      console.warn('[dispatch] subscribeDispatchSse failed; falling back to polling only', err);
      stopSubscription = null;
    }
  }

  console.log(`[dispatch] worker started for local agents: ${config.localAgentIds.join(', ')}`);
}

export function stopDispatchWorker(): void {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (stopSubscription) {
    try {
      stopSubscription();
    } catch {
      // best-effort tear-down
    }
    stopSubscription = null;
  }
}

/** Test-only: reset the worker's running state between tests. */
export function _resetDispatchWorkerForTests(): void {
  stopping = false;
  draining = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  stopSubscription = null;
}
