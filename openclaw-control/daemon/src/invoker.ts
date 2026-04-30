import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { Project } from './projects.js';
import type { TaskSummary } from './phase.js';
import { broadcast } from './sse.js';
import { isBridgeEnabled, invokeViaBridge } from './ptahBridge.js';
import { DispatchRepo } from './db/index.js';

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
  // Only the leader has a DB handle. Followers will gain a remote-append
  // path in Batch 3; for now, swallow the missing-DB error rather than
  // crashing the worker on followers in this transitional batch.
  if (!config.leader) return;
  try {
    DispatchRepo.appendLog(dispatchId, message, level);
  } catch (err) {
    console.warn('[invoker] dispatch_log append failed', err);
  }
}

export async function invokeClaudeForTask(opts: InvokeOptions): Promise<InvokeResult> {
  const lockKey = `${opts.project.slug}:${opts.task.id}`;
  if (inflight.has(lockKey)) {
    return { ok: false, exitCode: null, stdout: '', stderr: 'already in flight', durationMs: 0 };
  }
  inflight.add(lockKey);
  const started = Date.now();
  try {
    broadcast('invoker.started', { taskId: opts.task.id, agentId: opts.agentId });
    logToDispatch(opts.dispatchId, `invoker started agent=${opts.agentId}`);

    // Preferred path: delegate to the host-side ptah-bridge so ptah runs where
    // its providers (Claude CLI, codex, gh, the desktop's authMethod) actually
    // exist. Falls through to in-container spawn when OPENCLAW_PTAH_BRIDGE_URL
    // is unset (dev mode and tests).
    if (isBridgeEnabled()) {
      const bridgeResult = await invokeViaBridge({
        cwd: opts.project.path,
        prompt: opts.prompt,
        taskId: opts.task.id,
        agentId: opts.agentId,
        profile: config.ptah.profile,
        autoApprove: config.ptah.autoApprove,
      });
      const result: InvokeResult = {
        ok: bridgeResult.ok,
        exitCode: bridgeResult.exitCode,
        stdout: bridgeResult.stdout,
        stderr: bridgeResult.stderr,
        durationMs: bridgeResult.durationMs,
      };
      broadcast('invoker.finished', {
        taskId: opts.task.id,
        ok: result.ok,
        exitCode: result.exitCode,
        viaBridge: true,
      });
      logToDispatch(
        opts.dispatchId,
        `invoker finished viaBridge=true exit=${result.exitCode} duration=${result.durationMs}ms`,
        result.ok ? 'info' : 'warn',
      );
      return result;
    }

    // ptah --json --cwd <project> [--auto-approve] session start --profile <p> --task <prompt>
    // emits JSON-RPC 2.0 NDJSON on stdout and exits when the single turn finishes.
    const args: string[] = ['--json', '--cwd', opts.project.path];
    if (config.ptah.autoApprove) args.push('--auto-approve');
    args.push('session', 'start', '--profile', config.ptah.profile, '--task', opts.prompt);

    return await new Promise<InvokeResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(config.ptah.bin, args, {
        cwd: opts.project.path,
        env: {
          ...process.env,
          OPENCLAW_TASK_ID: opts.task.id,
          OPENCLAW_AGENT_ID: opts.agentId,
        },
      });
      child.stdout.on('data', (b) => {
        const s = b.toString();
        stdout += s;
        broadcast('invoker.stdout', { taskId: opts.task.id, chunk: s.slice(0, 500) });
      });
      child.stderr.on('data', (b) => {
        stderr += b.toString();
      });
      child.on('error', (err) => {
        const result: InvokeResult = {
          ok: false,
          exitCode: null,
          stdout,
          stderr: stderr + '\n' + err.message,
          durationMs: Date.now() - started,
        };
        broadcast('invoker.finished', { taskId: opts.task.id, ok: false });
        logToDispatch(
          opts.dispatchId,
          `invoker spawn error: ${err.message} duration=${result.durationMs}ms`,
          'error',
        );
        resolve(result);
      });
      child.on('close', (code) => {
        const result: InvokeResult = {
          ok: code === 0,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
        };
        broadcast('invoker.finished', { taskId: opts.task.id, ok: result.ok, exitCode: code });
        logToDispatch(
          opts.dispatchId,
          `invoker finished exit=${code} duration=${result.durationMs}ms`,
          result.ok ? 'info' : 'warn',
        );
        resolve(result);
      });
    });
  } finally {
    inflight.delete(lockKey);
  }
}
