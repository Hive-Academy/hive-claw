/**
 * harness-launcher — TASK_2026_002 B6 sub-task 12 (test for sub-task 1).
 *
 * Verifies the version-detect branch in `harness/ptahLauncher.ts`:
 *
 *   1. `__setProbedVersionForTests` correctly forces the branch.
 *   2. The 0.1.3 branch (configDirSupported=false) builds a bridge body
 *      whose `configFile` field points at the per-agent settings.json.
 *   3. The future-fixed branch (configDirSupported=true) also passes the
 *      file path through `configFile` (today the bridge body shape is
 *      identical; the bridge will switch to `--config-dir` when upstream
 *      ships the fix).
 *   4. `probePtahVersion` caches its result after the first probe.
 *
 * The test stubs `invokeViaBridge` via the `__setInvokeViaBridgeForTests`
 * seam so we can capture the body without a real ptah-bridge process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// IMPORTANT: launcher-env-stamp.ts must be the FIRST relative import. It
// stamps OPENCLAW_HOST_HOME, OPENCLAW_PTAH_BRIDGE_URL, and the rest BEFORE
// config.ts reads env at module load. ESM imports are hoisted; mutating
// process.env in this file's body is too late.
import { HOST_HOME, AGENTS_ROOT } from './launcher-env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { writeMemoryFile } from '../src/memory.ts';
import {
  __setInvokeViaBridgeForTests,
  isBridgeEnabled,
  type BridgeInvokeOptions,
  type BridgeInvokeResult,
} from '../src/ptahBridge.ts';
import {
  spawnPtahForAgent,
  probePtahVersion,
  __setProbedVersionForTests,
} from '../src/harness/ptahLauncher.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `harness-launcher.test: env override didn't reach config — got "${config.localAgentsRoot}", want "${AGENTS_ROOT}". ` +
      'launcher-env-stamp.ts must be the FIRST relative import.',
  );
}
if (!isBridgeEnabled()) {
  throw new Error(
    'harness-launcher.test: bridge env not set — launcher-env-stamp.ts must be the FIRST relative import',
  );
}

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

const MIN_HARNESS_YAML = `
version: 1
chatTier:
  skills: []
  subagents: []
  mcpServers: []
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
  modelTier: claude_code
`;

test('harness-launcher: 0.1.3 branch builds bridge body with configFile pointing at settings.json', async () => {
  const t = setupTestDb();
  const stub = stubBridge();
  __setProbedVersionForTests({
    version: '0.1.3',
    configDirSupported: false,
    subagentFlagSupported: false,
  });
  try {
    await writeMemoryFile('agents', 'horus', 'harness.yaml', MIN_HARNESS_YAML, 'test');
    const result = await spawnPtahForAgent({
      agentId: 'horus',
      cwd: '/tmp/test-project',
      prompt: 'do the thing',
      taskId: 'TASK_TEST_001',
    });
    assert.equal(result.ok, true, `expected ok, stderr: ${result.stderr}`);
    assert.equal(stub.calls.length, 1, 'bridge invoked exactly once');
    const opts = stub.calls[0]!.opts;
    assert.equal(opts.cwd, '/tmp/test-project');
    assert.equal(opts.prompt, 'do the thing');
    assert.equal(opts.taskId, 'TASK_TEST_001');
    assert.equal(opts.agentId, 'horus');
    assert.equal(opts.profile, 'claude_code', 'profile should come from per-agent settings.json');
    assert.equal(
      opts.configFile,
      join(HOST_HOME, '.ptah', 'agents', 'horus', 'settings.json'),
      'configFile must be the host-side path to the materialized settings.json',
    );
  } finally {
    __setProbedVersionForTests(null);
    stub.restore();
    t.cleanup();
  }
});

test('harness-launcher: future-fixed branch (configDirSupported=true) still passes settings.json today', async () => {
  const t = setupTestDb();
  const stub = stubBridge();
  __setProbedVersionForTests({
    version: '0.2.0',
    configDirSupported: true,
    subagentFlagSupported: true,
  });
  try {
    await writeMemoryFile('agents', 'anubis', 'harness.yaml', MIN_HARNESS_YAML, 'test');
    const result = await spawnPtahForAgent({
      agentId: 'anubis',
      cwd: '/tmp/test-project',
      prompt: 'future-fixed test',
      taskId: 'TASK_TEST_002',
    });
    assert.equal(result.ok, true, `expected ok, stderr: ${result.stderr}`);
    assert.equal(stub.calls.length, 1);
    const opts = stub.calls[0]!.opts;
    assert.equal(
      opts.configFile,
      join(HOST_HOME, '.ptah', 'agents', 'anubis', 'settings.json'),
      'configFile is the same shape today; bridge will swap to --config-dir when ptah ships the fix',
    );
  } finally {
    __setProbedVersionForTests(null);
    stub.restore();
    t.cleanup();
  }
});

test('harness-launcher: persona without harness.yaml gets default profile=claude_code', async () => {
  const t = setupTestDb();
  const stub = stubBridge();
  __setProbedVersionForTests({
    version: '0.1.3',
    configDirSupported: false,
    subagentFlagSupported: false,
  });
  try {
    // No writeMemoryFile call — persona has no harness.yaml row.
    const result = await spawnPtahForAgent({
      agentId: 'unconfigured-agent',
      cwd: '/tmp/test-project',
      prompt: 'unconfigured',
      taskId: 'TASK_TEST_003',
    });
    assert.equal(result.ok, true);
    assert.equal(stub.calls[0]!.opts.profile, 'claude_code', 'default profile is claude_code');
  } finally {
    __setProbedVersionForTests(null);
    stub.restore();
    t.cleanup();
  }
});

test('harness-launcher: probePtahVersion caches result after first call', async () => {
  __setProbedVersionForTests({
    version: '0.1.3',
    configDirSupported: false,
    subagentFlagSupported: false,
  });
  try {
    const a = await probePtahVersion();
    const b = await probePtahVersion();
    assert.deepEqual(a, b, 'second probe must return the cached value');
    assert.equal(a.version, '0.1.3');
    assert.equal(a.configDirSupported, false);
  } finally {
    __setProbedVersionForTests(null);
  }
});

process.on('exit', () => {
  try {
    rmSync(HOST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
