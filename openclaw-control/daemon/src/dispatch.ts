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

/**
 * Dispatch worker — thin orchestrator over a queue adapter.
 *
 * Two adapters with the same surface: `localQueueAdapter()` is direct
 * DispatchRepo calls (used by the leader's own worker), and
 * `remoteQueueAdapter()` is HTTP calls via leaderClient (used by
 * followers; full implementation lands in Batch 3).
 *
 * The poison policy is NOT implemented in this file — it lives in
 * `DispatchRepo.markDone` (Batch 1, partial UNIQUE index +
 * K-recent-failed window) so both the leader's own worker and a follower
 * hitting `POST /api/dispatches/:id/done` go through the same code path.
 *
 * Per implementation-plan.md §7 line 779: the 10-second polling interval
 * is preserved as the SSE-reconnect-failure floor. Push notifications
 * (Batch 3) supersede polling when the SSE channel is healthy.
 */

interface QueueAdapter {
  listPendingForAgents(agentIds: readonly string[]): Promise<Dispatch[]>;
  claim(id: string, claimedBy: string): Promise<Dispatch | null>;
  markDone(
    id: string,
    info: { exitCode: number | null; durationMs: number; stderrSnippet?: string | null },
  ): Promise<Dispatch>;
}

function localQueueAdapter(): QueueAdapter {
  return {
    async listPendingForAgents(agentIds) {
      return DispatchRepo.listPendingForAgents(agentIds);
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
  // Stubs throw at call time — Batch 3 wires these to leaderClient HTTP.
  return {
    listPendingForAgents: (agentIds) => leaderClient.listPendingForAgents(agentIds),
    claim: (id, claimedBy) => leaderClient.claim(id, claimedBy),
    markDone: (id, info) => leaderClient.markDone(id, info),
  };
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

export function startDispatchWorker(intervalMs = 10_000): void {
  if (timer) return;
  if (config.localAgentIds.length === 0) return;
  const tick = async () => {
    if (stopping) return;
    try {
      while ((await processOneDispatch()).processed) {
        // drain
      }
    } catch (err) {
      console.error('[dispatch] worker error', err);
    } finally {
      if (!stopping) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  console.log(`[dispatch] worker started for local agents: ${config.localAgentIds.join(', ')}`);
}

export function stopDispatchWorker(): void {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
