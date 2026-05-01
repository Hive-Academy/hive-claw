import { request } from 'undici';
import { config } from './config.js';
import { broadcast } from './sse.js';

/**
 * Client for scripts/ptah-bridge.mjs — the host-side process that spawns ptah
 * on the host on behalf of this daemon.
 *
 * The bridge translates container paths to host paths; we send container
 * paths as the daemon sees them. The bridge's response is NDJSON: each line is
 * either a ptah JSON-RPC event (passed through verbatim from ptah's stdout) or
 * a final line with `{"_bridge": "done", ...}` carrying exit code, duration,
 * and stderr.
 */

export interface BridgeInvokeOptions {
  cwd: string;
  prompt: string;
  taskId: string;
  agentId: string;
  profile: string;
  autoApprove?: boolean;
}

export interface BridgeInvokeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  translatedCwd?: string;
  translations?: number;
}

/**
 * Final envelope written by scripts/ptah-bridge.mjs as the last line of the
 * NDJSON response stream — signalled by `_bridge: 'done'`. Field shape lives
 * with the host bridge script; we only narrow what we read.
 */
interface BridgeDoneEnvelope {
  _bridge: 'done';
  exitCode?: number | null;
  stderr?: string;
  durationMs?: number;
  translatedCwd?: string;
  translations?: number;
}

interface BridgeHealthResponse {
  ptahVersion?: string | null;
}

export function isBridgeEnabled(): boolean {
  return Boolean(config.ptah.bridgeUrl);
}

export async function invokeViaBridge(opts: BridgeInvokeOptions): Promise<BridgeInvokeResult> {
  const url = `${config.ptah.bridgeUrl.replace(/\/$/, '')}/invoke`;
  const started = Date.now();

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.internalToken}`,
      },
      body: JSON.stringify(opts),
      bodyTimeout: 0, // disable body timeout — runs can be long
      headersTimeout: 30_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: `bridge request failed: ${message}`,
      durationMs: Date.now() - started,
    };
  }

  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => '');
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: `bridge returned ${res.statusCode}: ${text.slice(0, 1000)}`,
      durationMs: Date.now() - started,
    };
  }

  let stdout = '';
  let leftover = '';
  let envelope: BridgeDoneEnvelope | null = null;

  for await (const chunk of res.body) {
    const text = leftover + chunk.toString();
    const lines = text.split('\n');
    leftover = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      // Try to peek at the line — is it the bridge's final envelope?
      if (line.startsWith('{') && line.includes('"_bridge"')) {
        try {
          const parsed = JSON.parse(line) as Partial<BridgeDoneEnvelope>;
          if (parsed?._bridge === 'done') {
            envelope = parsed as BridgeDoneEnvelope;
            continue;
          }
        } catch {
          // Malformed envelope line — fall through and treat as stdout.
        }
      }
      // Otherwise treat as a ptah JSON-RPC event line; pass through to SSE.
      stdout += line + '\n';
      broadcast('invoker.stdout', { taskId: opts.taskId, chunk: line.slice(0, 500) });
    }
  }
  if (leftover.trim()) {
    if (leftover.includes('"_bridge"')) {
      try {
        const parsed = JSON.parse(leftover) as Partial<BridgeDoneEnvelope>;
        if (parsed?._bridge === 'done') envelope = parsed as BridgeDoneEnvelope;
      } catch {
        // Malformed trailing envelope — discard rather than crash the run.
      }
    } else {
      stdout += leftover;
      broadcast('invoker.stdout', { taskId: opts.taskId, chunk: leftover.slice(0, 500) });
    }
  }

  if (!envelope) {
    return {
      ok: false,
      exitCode: null,
      stdout,
      stderr: 'bridge stream ended without _bridge envelope',
      durationMs: Date.now() - started,
    };
  }

  return {
    ok: envelope.exitCode === 0,
    exitCode: envelope.exitCode ?? null,
    stdout,
    stderr: envelope.stderr ?? '',
    durationMs: envelope.durationMs ?? Date.now() - started,
    translatedCwd: envelope.translatedCwd,
    translations: envelope.translations,
  };
}

export async function pingBridge(): Promise<{ ok: boolean; ptahVersion?: string | null; error?: string }> {
  if (!isBridgeEnabled()) return { ok: false, error: 'OPENCLAW_PTAH_BRIDGE_URL unset' };
  try {
    const res = await request(`${config.ptah.bridgeUrl.replace(/\/$/, '')}/health`, {
      method: 'GET',
      headersTimeout: 3000,
    });
    if (res.statusCode !== 200) return { ok: false, error: `health returned ${res.statusCode}` };
    const data = (await res.body.json()) as BridgeHealthResponse;
    return { ok: true, ptahVersion: data?.ptahVersion ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
