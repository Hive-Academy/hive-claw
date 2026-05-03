import { config } from './config.js';
import type { Project } from './projects.js';
import type { TaskSummary } from './phase.js';
import { broadcast } from './sse.js';
import { spawnPtahForAgent } from './harness/ptahLauncher.js';
import { DispatchRepo } from './db/index.js';
import * as leaderClient from './leaderClient.js';

export interface InvokeOptions {
  project: Project;
  task: TaskSummary;
  agentId: string;
  prompt: string;
  /**
   * Optional dispatch row id. When set, lifecycle log lines (start, finish,
   * exit code, duration) are appended to `dispatch_log` via
   * DispatchRepo.appendLog. Direct continuation-loop invocations (no
   * dispatch row) leave it undefined and rely on broadcast/SSE alone.
   */
  dispatchId?: string;
}

export interface InvokeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const inflight = new Set<string>();

export function isInflight(taskId: string): boolean {
  return inflight.has(taskId);
}

function logToDispatch(
  dispatchId: string | undefined,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (!dispatchId) return;
  if (config.leader) {
    try {
      DispatchRepo.appendLog(dispatchId, message, level);
    } catch (err) {
      console.warn('[invoker] dispatch_log append failed', err);
    }
    return;
  }
  // Follower path — fire and forget through the leader client. The
  // appendLog helper is best-effort on followers (see leaderClient.ts);
  // we still want to call it so any future server-side /log endpoint will
  // pick up these calls without further changes here.
  void leaderClient.appendLog(dispatchId, message, level).catch((err) => {
    console.warn('[invoker] follower dispatch_log relay failed', err);
  });
}

/**
 * Invoke ptah for a task. TASK_2026_002 B6: the bridge / in-container
 * spawn arg-list construction is gone — this delegates to
 * `spawnPtahForAgent(...)` which version-detects the running ptah and
 * branches between the 0.1.3 and future-fixed surfaces. The global
 * profile selector is no longer read here; the launcher reads `modelTier`
 * from per-agent settings (see harness/materialize.ts).
 *
 * Backwards compat: a persona without `harness.yaml` still gets a default
 * settings.json via materialize, so the bridge body is byte-equivalent to
 * the pre-B6 invocation for unconfigured personas (impl-plan line 494).
 */
export async function invokeClaudeForTask(opts: InvokeOptions): Promise<InvokeResult> {
  const lockKey = `${opts.project.slug}:${opts.task.id}`;
  if (inflight.has(lockKey)) {
    return { ok: false, exitCode: null, stdout: '', stderr: 'already in flight', durationMs: 0 };
  }
  inflight.add(lockKey);
  try {
    broadcast('invoker.started', { taskId: opts.task.id, agentId: opts.agentId });
    logToDispatch(opts.dispatchId, `invoker started agent=${opts.agentId}`);

    const result = await spawnPtahForAgent({
      agentId: opts.agentId,
      cwd: opts.project.path,
      prompt: opts.prompt,
      taskId: opts.task.id,
      dispatchId: opts.dispatchId,
    });

    broadcast('invoker.finished', {
      taskId: opts.task.id,
      ok: result.ok,
      exitCode: result.exitCode,
    });
    logToDispatch(
      opts.dispatchId,
      `invoker finished agent=${opts.agentId} exit=${result.exitCode} duration=${result.durationMs}ms`,
      result.ok ? 'info' : 'warn',
    );
    return result;
  } finally {
    inflight.delete(lockKey);
  }
}
