import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Project } from './projects.js';
import type { TaskSummary } from './phase.js';
import { broadcast } from './sse.js';

export interface InvokeOptions {
  project: Project;
  task: TaskSummary;
  agentId: string;
  prompt: string;
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

export async function invokeClaudeForTask(opts: InvokeOptions): Promise<InvokeResult> {
  const lockKey = `${opts.project.slug}:${opts.task.id}`;
  if (inflight.has(lockKey)) {
    return { ok: false, exitCode: null, stdout: '', stderr: 'already in flight', durationMs: 0 };
  }
  inflight.add(lockKey);
  const started = Date.now();
  try {
    broadcast('invoker.started', { taskId: opts.task.id, agentId: opts.agentId });

    const logDir = path.join(opts.task.folder, '.invoker');
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${Date.now()}-${opts.agentId}.log`);

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
        const result = {
          ok: false,
          exitCode: null,
          stdout,
          stderr: stderr + '\n' + err.message,
          durationMs: Date.now() - started,
        };
        broadcast('invoker.finished', { taskId: opts.task.id, ok: false });
        void fs.writeFile(logFile, formatLog(opts, result), 'utf8').catch(() => {});
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
        void fs.writeFile(logFile, formatLog(opts, result), 'utf8').catch(() => {});
        resolve(result);
      });
    });
  } finally {
    inflight.delete(lockKey);
  }
}

function formatLog(opts: InvokeOptions, r: InvokeResult): string {
  return [
    `# Invoker run`,
    `task: ${opts.task.id}`,
    `agent: ${opts.agentId}`,
    `cwd: ${opts.project.path}`,
    `exit: ${r.exitCode}`,
    `duration_ms: ${r.durationMs}`,
    ``,
    `## prompt`,
    opts.prompt,
    ``,
    `## stdout`,
    r.stdout,
    ``,
    `## stderr`,
    r.stderr,
  ].join('\n');
}
