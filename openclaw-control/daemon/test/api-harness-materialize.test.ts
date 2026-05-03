/**
 * api-harness-materialize — TASK_2026_002 B6 sub-task 12 (test for sub-task 8).
 *
 * Verifies the operator/diagnostic materialize endpoints, leader path:
 *   - POST /api/agents/:id/harness/materialize → 200 + MaterializeResult
 *   - POST /api/harness/materialize          → 200 + MaterializeResult[]
 *
 * The follower-mode 405 path is exercised by a sibling test file
 * `api-harness-materialize-follower.test.ts` (separate process so config.ts
 * boots in follower mode — same pattern as `follower-read.test.ts`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

// IMPORTANT: launcher-env-stamp.ts must be the FIRST relative import.
// ESM hoists imports — config.ts reads env at module load.
import { HOST_HOME, AGENTS_ROOT } from './launcher-env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import { writeMemoryFile } from '../src/memory.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `api-harness-materialize.test: env override didn't reach config — got "${config.localAgentsRoot}"`,
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

const HARNESS_YAML = `
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

test('api-harness-materialize: POST /api/agents/:id/harness/materialize returns MaterializeResult on leader', async () => {
  const t = setupTestDb();
  const app = buildApp();
  try {
    await writeMemoryFile('agents', 'horus', 'harness.yaml', HARNESS_YAML, 'test');
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/horus/harness/materialize',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      agentId: string;
      settingsPath: string;
      pluginDir: string;
      changed: boolean;
    };
    assert.equal(body.agentId, 'horus');
    assert.match(body.settingsPath, /\/horus\/settings\.json$/);
    assert.match(body.pluginDir, /openclaw-horus-harness$/);
    assert.equal(body.changed, true, 'first materialize must rewrite');
    assert.ok(existsSync(body.settingsPath), 'settings.json must be on disk');
  } finally {
    await app.close();
    t.cleanup();
  }
});

test('api-harness-materialize: POST /api/harness/materialize returns array on leader', async () => {
  const t = setupTestDb();
  const app = buildApp();
  try {
    await writeMemoryFile('agents', 'anubis', 'harness.yaml', HARNESS_YAML, 'test');
    const res = await app.inject({
      method: 'POST',
      url: '/api/harness/materialize',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as Array<{ agentId: string; changed: boolean }>;
    assert.ok(Array.isArray(body));
    assert.ok(body.find((r) => r.agentId === 'anubis'), 'anubis must be in the result list');
  } finally {
    await app.close();
    t.cleanup();
  }
});

process.on('exit', () => {
  try {
    rmSync(HOST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
