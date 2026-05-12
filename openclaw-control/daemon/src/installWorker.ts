/**
 * installWorker — in-process serial worker for plugin / MCP-skill install
 * requests (TASK_2026_006 Batch 8b, amendment-1 §16.5).
 *
 * Bounded concurrency = 1 (only one install runs at a time globally). The
 * worker is woken via `enqueueApproved(id)` from the approve route handler;
 * each call appends to an internal promise chain so subsequent approvals
 * queue and run in order without spawning threads or needing Redis.
 *
 * The worker drives `docker exec` against the `openclaw-gateway` container
 * via `dockerode` (npm dep). For testability the docker surface is reduced
 * to the small `DockerLike` interface below — production code injects a
 * real `Dockerode` instance via `setDocker()` at boot; tests inject a fake.
 *
 * Restart fallback chain (amendment-1 §16.5):
 *   1. `docker exec openclaw-gateway openclaw gateway restart` (graceful,
 *      drains in-flight tool calls). If exits 0 within 30s: prefer.
 *   2. Otherwise `docker.getContainer('openclaw-gateway').restart()`
 *      (SIGTERM with grace period, then SIGKILL).
 *
 * SSE events emitted (topic prefix `installs` — matches §16.3
 * `/api/stream?topics=installs`):
 *   - `installs.requested`   (emitted from the create route, not here)
 *   - `installs.approved`    (emitted from the approve route, before enqueue)
 *   - `installs.rejected`    (emitted from the reject route)
 *   - `installs.applied`     (worker, on success)
 *   - `installs.failed`      (worker, on non-zero install or restart error)
 */

import { broadcast } from './sse.js';
import {
  InstallRequestsRepo,
  type InstallKind,
  type InstallRequest,
} from './db/installRequests.js';

/** Result of a single `docker exec` call. */
export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal docker surface the worker depends on. Keeps the test seam tight —
 * we mock 3 methods, not the whole `dockerode` API.
 */
export interface DockerLike {
  /**
   * Run a command inside the named container. The worker captures
   * stdout+stderr separately so we can record both into `install_output`.
   */
  exec(container: string, cmd: readonly string[], timeoutMs: number): Promise<DockerExecResult>;
  /** `docker restart <container>` — SIGTERM with grace, then SIGKILL. */
  restartContainer(container: string): Promise<void>;
  /**
   * GET /health on the gateway with the given timeout. Returns true on
   * 2xx; false otherwise (including timeout / ECONNREFUSED).
   */
  pingHealth(timeoutMs: number): Promise<boolean>;
}

/* ----------------------------------------------------------------------------
 * Tunables (kept at module-scope so tests can override via setTimings()).
 * -------------------------------------------------------------------------- */

const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_CLI_RESTART_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 500;
const GATEWAY_CONTAINER = 'openclaw-gateway';

interface Timings {
  installTimeoutMs: number;
  cliRestartTimeoutMs: number;
  healthTimeoutMs: number;
  healthPollMs: number;
}

let timings: Timings = {
  installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
  cliRestartTimeoutMs: DEFAULT_CLI_RESTART_TIMEOUT_MS,
  healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
  healthPollMs: DEFAULT_HEALTH_POLL_MS,
};

let docker: DockerLike | null = null;
/** Single in-flight chain — bounds concurrency to 1 across the process. */
let chain: Promise<void> = Promise.resolve();

/**
 * Inject the docker handle. Production wires a real `dockerode` adapter at
 * boot (see `index.ts`); tests inject a fake.
 */
export function setDocker(d: DockerLike | null): void {
  docker = d;
}

/** Test-only: override timings so tests don't sit for 30s. */
export function setTimingsForTests(overrides: Partial<Timings>): () => void {
  const prev = timings;
  timings = { ...timings, ...overrides };
  return () => {
    timings = prev;
  };
}

/**
 * Enqueue an approved install request for processing. Idempotent: enqueuing
 * the same id twice is harmless — the worker re-reads the DB row and skips
 * if it's no longer in `approved` state.
 *
 * Returns the promise that resolves when THIS request finishes (success or
 * failure); fire-and-forget callers can ignore it. Errors are swallowed
 * inside the chain so they don't poison subsequent enqueues.
 */
export function enqueueApproved(requestId: number): Promise<void> {
  const job = chain.then(() => processOne(requestId).catch((err) => {
    // The worker reports failures via SSE + DB; an uncaught here means a
    // programming bug (e.g. docker handle missing). Log loudly but do not
    // break the chain.
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[installWorker] unexpected error for request id=${requestId}: ${msg}`);
  }));
  chain = job;
  return job;
}

/**
 * Test seam: await the in-flight chain. Tests call this after enqueuing
 * to drain pending work before asserting.
 */
export function drainForTests(): Promise<void> {
  return chain;
}

/**
 * Process a single install request: run the install command, restart the
 * gateway on success, capture output, emit SSE.
 *
 * Mutates the DB through `InstallRequestsRepo.markApplied / markFailed`.
 * On any caught error this function records `failed` rather than throwing.
 */
async function processOne(requestId: number): Promise<void> {
  if (!docker) {
    console.error(
      `[installWorker] no docker handle injected — refusing to process id=${requestId}. ` +
        'Call setDocker() at boot.',
    );
    return;
  }

  const req = InstallRequestsRepo.get(requestId);
  if (!req) {
    console.warn(`[installWorker] request id=${requestId} not found, skipping`);
    return;
  }
  if (req.status !== 'approved') {
    // Re-enqueue races, or operator rejected after click — either way, drop.
    console.warn(
      `[installWorker] request id=${requestId} not in 'approved' state (got '${req.status}'), skipping`,
    );
    return;
  }

  const installCmd = buildInstallCommand(req.kind, req.slug);
  let installExit: DockerExecResult;
  try {
    installExit = await docker.exec(GATEWAY_CONTAINER, installCmd, timings.installTimeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finalize(req, 'failed', `install exec error: ${msg}`);
    return;
  }

  const installOutput = combineOutput(installExit);
  if (installExit.exitCode !== 0) {
    // Install failed — DO NOT restart. Gateway state preserved.
    finalize(req, 'failed', installOutput);
    return;
  }

  // Install succeeded — try graceful restart first.
  let restartOutput = '';
  try {
    const cliRestart = await docker.exec(
      GATEWAY_CONTAINER,
      ['openclaw', 'gateway', 'restart'],
      timings.cliRestartTimeoutMs,
    );
    restartOutput = `\n[cli restart exit=${cliRestart.exitCode}]\n${combineOutput(cliRestart)}`;
    if (cliRestart.exitCode !== 0) {
      // Graceful failed — fall back.
      await fallbackRestart();
      restartOutput += `\n[fallback] docker restart ${GATEWAY_CONTAINER} issued`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    restartOutput = `\n[cli restart error: ${msg}]`;
    try {
      await fallbackRestart();
      restartOutput += `\n[fallback] docker restart ${GATEWAY_CONTAINER} issued`;
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      finalize(req, 'failed', installOutput + restartOutput + `\n[fallback failed: ${msg2}]`);
      return;
    }
  }

  // Wait for gateway healthy. Treat failure-to-heal as install failure
  // so the operator sees the problem in the audit log.
  const healthy = await waitForHealthy();
  if (!healthy) {
    finalize(req, 'failed', installOutput + restartOutput + '\n[health check did not pass within 30s]');
    return;
  }

  finalize(req, 'applied', installOutput + restartOutput);
}

async function fallbackRestart(): Promise<void> {
  if (!docker) throw new Error('docker handle missing');
  await docker.restartContainer(GATEWAY_CONTAINER);
}

async function waitForHealthy(): Promise<boolean> {
  if (!docker) return false;
  const deadline = Date.now() + timings.healthTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await docker.pingHealth(Math.min(2_000, timings.healthTimeoutMs));
      if (ok) return true;
    } catch {
      // ignore; retry until deadline
    }
    await sleep(timings.healthPollMs);
  }
  return false;
}

function finalize(req: InstallRequest, status: 'applied' | 'failed', output: string): void {
  try {
    const row = status === 'applied'
      ? InstallRequestsRepo.markApplied(req.id, output)
      : InstallRequestsRepo.markFailed(req.id, output);
    // Event names use the `installs` topic prefix so dashboard
    // subscribers can filter via `/api/stream?topics=installs` (sse.ts
    // topic-filter splits on the first `.`).
    broadcast(status === 'applied' ? 'installs.applied' : 'installs.failed', {
      requestId: row.id,
      kind: row.kind,
      slug: row.slug,
      status: row.status,
      appliedAt: row.appliedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[installWorker] finalize id=${req.id} status=${status} failed: ${msg}`);
  }
}

function buildInstallCommand(kind: InstallKind, slug: string): readonly string[] {
  const sub = kind === 'plugin' ? 'plugins' : 'skills';
  // Slug passed verbatim — the plugin layer is responsible for stripping
  // `npm:` prefixes (the openclaw CLI rejects them per batch 5b probe).
  return ['openclaw', sub, 'install', slug];
}

function combineOutput(r: DockerExecResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(`[stdout]\n${r.stdout}`);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  parts.push(`[exit=${r.exitCode}]`);
  return parts.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-only listing of installed extensions. Routes call this directly
 * (no queueing) because it's pure read traffic and operators need it to
 * paint the dashboard without waiting on the install queue.
 */
export interface InstalledInventory {
  plugins: ReadonlyArray<{ slug: string; raw?: unknown }>;
  mcpSkills: ReadonlyArray<{ slug: string; raw?: unknown }>;
}

export async function listInstalled(): Promise<InstalledInventory> {
  if (!docker) {
    throw new Error('installWorker: docker handle not injected');
  }
  const plugins = await listOne(['openclaw', 'plugins', 'list', '--json']);
  const skills = await listOne(['openclaw', 'skills', 'list', '--json']);
  return { plugins, mcpSkills: skills };
}

async function listOne(cmd: readonly string[]): Promise<Array<{ slug: string; raw?: unknown }>> {
  if (!docker) throw new Error('docker handle missing');
  const r = await docker.exec(GATEWAY_CONTAINER, cmd, 15_000);
  if (r.exitCode !== 0) return [];
  // openclaw --json shape is not contractually frozen in v1; accept either
  // an array of strings or an array of objects with a `slug`/`name` field.
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    if (typeof entry === 'string') return { slug: entry };
    if (entry && typeof entry === 'object') {
      const o = entry as { slug?: unknown; name?: unknown };
      const slug =
        (typeof o.slug === 'string' && o.slug) ||
        (typeof o.name === 'string' && o.name) ||
        '';
      return { slug, raw: entry };
    }
    return { slug: '' };
  });
}
