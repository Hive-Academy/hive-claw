/**
 * harness/ptahLauncher.ts — TASK_2026_002 B6 sub-task 1.
 *
 * The version-detect + spawn-arg seam between the dispatch worker and the
 * actual ptah runtime. `invoker.ts` calls `spawnPtahForAgent({...})`; this
 * module hides the difference between:
 *
 *   - **0.1.3 path (today)** — surface uses `--config <settings.json>` plus
 *     a per-persona Claude plugin under `~/.ptah/plugins/openclaw-<id>-harness/`.
 *     Bridge body carries `configFile` (forwarded by ptahBridge.ts).
 *
 *   - **future fixed path** — surface uses `--config-dir <dir>` and the
 *     workspace-local `.claude/agents/` (ptah's clean shape once it lands).
 *
 * Migration to v2 = swap the branch + bump `PTAH_MIN_VERSION` (env var). No
 * other code in the daemon needs to know.
 *
 * The launcher also calls `materializeAgent(agentId)` defensively when the
 * per-agent settings.json doesn't exist on disk — the daemon-startup pass
 * `materializeAll()` usually got there first, but a fresh persona added at
 * runtime + immediately dispatched would otherwise race the materialize step.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { isBridgeEnabled, invokeViaBridge, pingBridge } from '../ptahBridge.js';
import { materializeAgent } from './materialize.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnPtahOptions {
  agentId: string;
  /** Project working dir as the daemon sees it; bridge translates host paths. */
  cwd: string;
  prompt: string;
  taskId: string;
  /** Optional dispatch row id (passed through for log correlation). */
  dispatchId?: string;
}

export interface SpawnPtahResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProbedVersion {
  /** Raw semver string, or null if probe failed. */
  version: string | null;
  /** True iff the running ptah supports `--config-dir` (the future fixed shape). */
  configDirSupported: boolean;
  /** True iff the running ptah supports `--subagent <name>` (companion to the above). */
  subagentFlagSupported: boolean;
}

// ---------------------------------------------------------------------------
// Module-scope cache + test seam
// ---------------------------------------------------------------------------

let cachedProbe: ProbedVersion | null = null;

/**
 * Test/diagnostic seam — force a version branch in unit tests without
 * spawning a subprocess or hitting the bridge. Pass `null` to clear the
 * cache and force a re-probe on the next call.
 */
export function __setProbedVersionForTests(p: ProbedVersion | null): void {
  cachedProbe = p;
}

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

/**
 * Parse a semver-ish string (e.g. "0.1.3" or "ptah 0.1.3-rc.1") into
 * (major, minor, patch) — extra fields beyond patch are ignored. Returns
 * null when nothing recognizable parses; callers fall back to the
 * conservative 0.1.3 branch.
 */
function parseSemver(raw: string): { major: number; minor: number; patch: number } | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  const patch = Number.parseInt(m[3]!, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Capability flags as a function of the parsed version. The future-fixed
 * surface is gated at >= 0.2.0 by convention (this is the only place that
 * needs to change when the upstream fix lands; the rest of the daemon
 * branches off `configDirSupported`).
 */
function capsFor(v: { major: number; minor: number; patch: number } | null): {
  configDirSupported: boolean;
  subagentFlagSupported: boolean;
} {
  if (!v) return { configDirSupported: false, subagentFlagSupported: false };
  const fixed = v.major > 0 || (v.major === 0 && v.minor >= 2);
  return { configDirSupported: fixed, subagentFlagSupported: fixed };
}

/**
 * Inspect the running ptah on the host (preferred — bridge `/health`) or
 * the in-container fallback (`${PTAH_BIN} --version`) and cache the result
 * for the process lifetime. Idempotent re-callable; subsequent invocations
 * return the cached probe immediately.
 */
export async function probePtahVersion(): Promise<ProbedVersion> {
  if (cachedProbe) return cachedProbe;

  // Preferred: bridge /health surfaces ptahVersion (one round trip,
  // already authenticated, already on the host where ptah lives).
  if (isBridgeEnabled()) {
    try {
      const r = await pingBridge();
      if (r.ok && typeof r.ptahVersion === 'string') {
        const parsed = parseSemver(r.ptahVersion);
        const caps = capsFor(parsed);
        cachedProbe = {
          version: r.ptahVersion,
          configDirSupported: caps.configDirSupported,
          subagentFlagSupported: caps.subagentFlagSupported,
        };
        return cachedProbe;
      }
    } catch {
      // Bridge unreachable — fall through to local probe.
    }
  }

  // Fallback: shell out to the local PTAH_BIN. Mostly dev/test mode.
  try {
    const { stdout } = await execFileAsync(config.ptah.bin, ['--version'], {
      timeout: 3000,
    });
    const parsed = parseSemver(stdout);
    const caps = capsFor(parsed);
    cachedProbe = {
      version: stdout.trim(),
      configDirSupported: caps.configDirSupported,
      subagentFlagSupported: caps.subagentFlagSupported,
    };
    return cachedProbe;
  } catch {
    // Neither bridge nor local ptah — assume the conservative 0.1.3 branch.
    cachedProbe = { version: null, configDirSupported: false, subagentFlagSupported: false };
    return cachedProbe;
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Defensive materialize: if the per-agent settings.json doesn't exist on
 * disk yet, run `materializeAgent(agentId)` once. The startup pass usually
 * got there first; this catches "persona added at runtime + immediately
 * dispatched" races without requiring callers to remember.
 *
 * Stamp-file check: simple `fs.access` on the settings path. We don't
 * cache "I already materialized this in this process" because materialize
 * itself is idempotent (byte-diff write) — repeated calls are no-ops.
 */
async function ensureMaterialized(agentId: string, settingsPath: string): Promise<void> {
  try {
    await fs.access(settingsPath);
    return;
  } catch {
    // ENOENT path — materialize now.
  }
  try {
    await materializeAgent(agentId);
  } catch (err) {
    // Surface a warning but don't block dispatch — materialize might fail
    // on a misshapen harness.yaml, in which case we still want ptah to
    // get a chance with whatever was on disk previously (or the bridge
    // call to fail loud at the dispatch boundary).
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ptahLauncher] defensive materialize failed for "${agentId}": ${msg}`);
  }
}

function settingsPathFor(agentId: string): string {
  // Mirror materialize.ts:agentSettingsPath without re-importing internals
  // (keeps the seam test-friendly: callers can stub probePtahVersion +
  // invokeViaBridge without pulling materialize's FS into the test).
  const home = (process.env.OPENCLAW_HOST_HOME ?? '').trim() || process.env.HOME || '';
  return `${home}/.ptah/agents/${agentId}/settings.json`;
}

/**
 * Read the orchestration tier `modelTier` (== ptah `profile`) for this
 * agent from the materialized settings.json. The launcher reads it from
 * disk rather than `config.ptah.profile` so per-agent config wins —
 * impl-plan line 494, "config.ptah.profile is no longer read here".
 *
 * Defaults to `claude_code` on any read/parse failure (back-compat with
 * unconfigured personas — same byte-equivalent behavior as pre-B6).
 */
async function readProfileFromSettings(settingsPath: string): Promise<string> {
  try {
    const txt = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(txt) as { profile?: unknown };
    if (parsed && typeof parsed.profile === 'string' && parsed.profile.length > 0) {
      return parsed.profile;
    }
  } catch {
    // Missing or malformed settings.json → fall back to default profile.
  }
  return 'claude_code';
}

/**
 * Spawn ptah for the given agent + task. Branches on `configDirSupported`:
 *
 *   - false (0.1.3): bridge body carries `configFile` (the per-agent
 *     settings.json). Bridge prepends `--config <translatePath(configFile)>`
 *     to the ptah argv.
 *
 *   - true (future fixed): bridge body carries `configFile` set to the
 *     PER-AGENT CONFIG DIR rather than the file (the bridge field is the
 *     same key; the bridge will use `--config-dir` in this branch when it
 *     ships the upgrade — for now this branch is a placeholder waiting on
 *     the bridge upgrade).
 *
 * Today, only the 0.1.3 branch is exercised in production. The
 * future-fixed branch is reachable from tests via `__setProbedVersionForTests`
 * and is the one-line swap that ships the v2 surface.
 */
export async function spawnPtahForAgent(opts: SpawnPtahOptions): Promise<SpawnPtahResult> {
  const probe = await probePtahVersion();
  const settingsPath = settingsPathFor(opts.agentId);
  await ensureMaterialized(opts.agentId, settingsPath);

  const profile = await readProfileFromSettings(settingsPath);

  if (!isBridgeEnabled()) {
    // Bridge unconfigured (dev/test mode). The legacy invoker had an
    // in-container spawn fallback; we keep the seam single-point-of-entry
    // and surface a structured error rather than silently shelling out.
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr:
        '[ptahLauncher] OPENCLAW_PTAH_BRIDGE_URL is unset — in-container spawn was removed in TASK_2026_002 B6. ' +
        'Set the bridge URL or run tests via __setProbedVersionForTests + a stubbed bridge.',
      durationMs: 0,
    };
  }

  // Both branches send the same bridge field today; the bridge consumes
  // `configFile` and prepends `--config <translated>` to ptah's argv. The
  // future fixed branch will swap to `--config-dir` once the bridge is
  // upgraded — at that point this `if` decides which kind of path goes
  // into the field. Until then, we send the file path either way.
  const bridgeBody = {
    cwd: opts.cwd,
    prompt: opts.prompt,
    taskId: opts.taskId,
    agentId: opts.agentId,
    profile,
    autoApprove: config.ptah.autoApprove,
    configFile: settingsPath,
  };

  if (probe.configDirSupported) {
    // Future-fixed: bridge will be re-pointed to use --config-dir; for now
    // we still send the per-agent settings file (the leading metadata is
    // the same regardless). This branch exists so the version-detect logic
    // is exercised end-to-end and unit-testable today.
    bridgeBody.configFile = settingsPath;
  }

  return invokeViaBridge(bridgeBody);
}
