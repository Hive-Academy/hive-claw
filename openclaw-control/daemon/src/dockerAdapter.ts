/**
 * Production adapter wrapping `dockerode` for the install worker (Batch 8b).
 *
 * The install worker (`installWorker.ts`) talks to docker through a tight
 * 3-method interface (`DockerLike`) so tests can mock it. This adapter is
 * the real-docker implementation, wired at daemon boot in `index.ts`.
 *
 * Three operations:
 *   - `exec(container, cmd, timeoutMs)` — `docker exec` with stdout/stderr
 *     demuxed and a timeout-driven kill.
 *   - `restartContainer(container)` — `docker restart`.
 *   - `pingHealth(timeoutMs)` — HTTP GET of the gateway's `/health` endpoint
 *     via undici (NOT docker; the install pipeline polls the freshly-
 *     restarted gateway from the daemon's perspective).
 *
 * The adapter is the boundary where "real docker is unavailable" becomes
 * "fail closed with a useful error" — installWorker's `enqueueApproved`
 * and `listInstalled` already surface a structured "no docker handle"
 * message when `setDocker(null)` is in effect, so we just need to fail
 * gracefully if the socket isn't mountable.
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { request } from 'undici';
import type { DockerExecResult, DockerLike } from './installWorker.js';

export interface DockerAdapterOptions {
  /** Path to the docker daemon socket. Defaults to `/var/run/docker.sock`. */
  socketPath?: string;
  /** Full URL of the gateway's `/health` endpoint. Defaults to inter-container DNS. */
  gatewayHealthUrl?: string;
}

export function createDockerAdapter(opts: DockerAdapterOptions = {}): DockerLike {
  const docker = new Docker({
    socketPath: opts.socketPath ?? '/var/run/docker.sock',
  });
  const healthUrl = opts.gatewayHealthUrl ?? 'http://openclaw-gateway:18789/health';

  return {
    async exec(container, cmd, timeoutMs): Promise<DockerExecResult> {
      const c = docker.getContainer(container);
      const exec = await c.exec({
        Cmd: [...cmd],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });

      const stream = await exec.start({ Detach: false, Tty: false });

      const stdoutBuf = new PassThrough();
      const stderrBuf = new PassThrough();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      stdoutBuf.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      stderrBuf.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // dockerode's modem demuxes the docker exec multiplexed stream into
      // separate stdout and stderr.
      docker.modem.demuxStream(stream, stdoutBuf, stderrBuf);

      // Race the stream-end against a hard timeout.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy(new Error(`docker exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      try {
        await new Promise<void>((resolve, reject) => {
          stream.on('end', () => resolve());
          stream.on('close', () => resolve());
          stream.on('error', (err) => reject(err));
        });
      } finally {
        clearTimeout(timer);
        stdoutBuf.end();
        stderrBuf.end();
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        return {
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[adapter] timed out after ${timeoutMs}ms`,
        };
      }

      const inspectResult = await exec.inspect();
      return {
        exitCode: inspectResult.ExitCode ?? -1,
        stdout,
        stderr,
      };
    },

    async restartContainer(container): Promise<void> {
      await docker.getContainer(container).restart();
    },

    async pingHealth(timeoutMs): Promise<boolean> {
      try {
        const res = await request(healthUrl, {
          method: 'GET',
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          await res.body.dump();
        } catch {
          // Already consumed or aborted — fine.
        }
        return res.statusCode >= 200 && res.statusCode < 300;
      } catch {
        return false;
      }
    },
  };
}
