/**
 * horus-spawn — TASK_2026_002 B8 sub-task 8 (AT#6 split, daemon side).
 *
 * AT#6 from impl-plan: `spawnPtahForAgent('horus')` produces a bridge body
 * where `configFile` ends with `horus/settings.json`, AND
 * `~/.ptah/plugins/openclaw-horus-harness/agents/security-review.md` exists
 * on disk after `materializeAgent('horus')` runs.
 *
 * This file lives daemon-side because both `materializeAgent` and
 * `spawnPtahForAgent` belong to the daemon and depend on `better-sqlite3`
 * (transitively, via `MemoryRepo`). The bot-bridge integration sweep at
 * `bot-bridge/test/integration/horus-end-to-end.test.ts` covers AT#1–#5;
 * AT#6 is exercised here so the full B8 contract has end-to-end coverage
 * without coupling the two npm packages.
 *
 * Fixture
 * -------
 * The Horus harness fixture committed by Track A
 * (`shared-specs/memory/agents/horus/harness.yaml`) is loaded into the
 * test SQLite DB via `writeMemoryFile` so `MemoryRepo.read('agents',
 * 'horus', 'harness.yaml')` returns the same bytes the production
 * leader would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// IMPORTANT: launcher-env-stamp.ts must be the FIRST relative import. It
// stamps OPENCLAW_HOST_HOME, OPENCLAW_PTAH_BRIDGE_URL, etc. BEFORE
// `daemon/src/config.ts` reads env at module load.
import { HOST_HOME } from './launcher-env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { writeMemoryFile } from '../src/memory.ts';
import {
  __setInvokeViaBridgeForTests,
  type BridgeInvokeOptions,
  type BridgeInvokeResult,
} from '../src/ptahBridge.ts';
import {
  spawnPtahForAgent,
  __setProbedVersionForTests,
} from '../src/harness/ptahLauncher.ts';
import { materializeAgent } from '../src/harness/materialize.ts';

// ---------------------------------------------------------------------------
// Locate the Horus harness fixture relative to the daemon test file. The
// repo root is up four levels from this file:
//   …/openclaw-control/daemon/test/horus-spawn.test.ts
//   ../../../..              = repo root
// ---------------------------------------------------------------------------

const __here = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__here), '..', '..', '..');
const HORUS_HARNESS_PATH = join(
  REPO_ROOT,
  'shared-specs',
  'memory',
  'agents',
  'horus',
  'harness.yaml',
);

if (!existsSync(HORUS_HARNESS_PATH)) {
  throw new Error(
    `horus-spawn.test: fixture missing at ${HORUS_HARNESS_PATH} — Track A must commit it before this test runs`,
  );
}
const HORUS_HARNESS_YAML = readFileSync(HORUS_HARNESS_PATH, 'utf8');

interface CapturedBridgeCall {
  opts: BridgeInvokeOptions;
}

function stubBridge(): { calls: CapturedBridgeCall[]; restore: () => void } {
  const calls: CapturedBridgeCall[] = [];
  __setInvokeViaBridgeForTests(async (opts: BridgeInvokeOptions): Promise<BridgeInvokeResult> => {
    calls.push({ opts });
    return {
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    };
  });
  return {
    calls,
    restore: () => __setInvokeViaBridgeForTests(null),
  };
}

test('horus-spawn AT#6: materializeAgent("horus") writes plugin agents/security-review.md AND spawnPtahForAgent body has configFile=horus/settings.json', async () => {
  const t = setupTestDb();
  const stub = stubBridge();
  // Pin the conservative 0.1.3 branch so the bridge body shape is the
  // production-current one (configFile points at settings.json, NOT a dir).
  __setProbedVersionForTests({
    version: '0.1.3',
    configDirSupported: false,
    subagentFlagSupported: false,
  });
  try {
    // Seed the harness.yaml row for horus from the Track A fixture.
    await writeMemoryFile('agents', 'horus', 'harness.yaml', HORUS_HARNESS_YAML, 'test');

    // Run materialize. This writes:
    //   ${HOST_HOME}/.ptah/agents/horus/settings.json
    //   ${HOST_HOME}/.ptah/plugins/openclaw-horus-harness/.claude-plugin/plugin.json
    //   ${HOST_HOME}/.ptah/plugins/openclaw-horus-harness/agents/security-review.md
    const result = await materializeAgent('horus');
    assert.equal(result.agentId, 'horus');
    assert.equal(result.changed, true, 'first materialize must report changed=true');

    // The orchestration-tier subagent file is the load-bearing AT#6 artifact.
    const subagentMd = join(
      HOST_HOME,
      '.ptah',
      'plugins',
      'openclaw-horus-harness',
      'agents',
      'security-review.md',
    );
    assert.equal(
      existsSync(subagentMd),
      true,
      `materialized subagent file must exist at ${subagentMd}`,
    );
    const md = readFileSync(subagentMd, 'utf8');
    assert.match(md, /^---/, 'subagent md must have frontmatter');
    assert.match(md, /name: security-review/, 'frontmatter must name the subagent');
    assert.match(md, /OWASP/i, 'subagent body must include the systemPrompt content from harness.yaml');

    // The settings.json file must exist on disk where the launcher will look
    // for it (HOST_HOME/.ptah/agents/horus/settings.json).
    const settingsPath = join(HOST_HOME, '.ptah', 'agents', 'horus', 'settings.json');
    assert.equal(existsSync(settingsPath), true, `settings.json must exist at ${settingsPath}`);

    // Now spawn — the bridge body (captured by stubBridge) must carry
    // configFile pointing exactly at the materialized settings.json.
    const spawnResult = await spawnPtahForAgent({
      agentId: 'horus',
      cwd: '/tmp/horus-cwd',
      prompt: 'AT#6 sweep',
      taskId: 'TASK_AT_6',
    });
    assert.equal(spawnResult.ok, true, `spawn must succeed; stderr=${spawnResult.stderr}`);
    assert.equal(stub.calls.length, 1, 'bridge invoked exactly once');
    const opts = stub.calls[0]!.opts;
    assert.equal(opts.agentId, 'horus');
    assert.ok(
      opts.configFile && opts.configFile.endsWith('horus/settings.json'),
      `configFile must end with horus/settings.json, got "${opts.configFile}"`,
    );
    assert.equal(opts.profile, 'claude_code', 'profile must come from harness.orchestrationTier.modelTier');
  } finally {
    __setProbedVersionForTests(null);
    stub.restore();
    t.cleanup();
  }
});
