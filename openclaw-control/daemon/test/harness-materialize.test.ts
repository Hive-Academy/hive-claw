/**
 * harness-materialize — TASK_2026_002 B6 sub-task 12 (test for sub-tasks 2 + 3).
 *
 * Verifies:
 *   1. Golden bytes — for a known harness.yaml input, the produced
 *      settings.json + plugin.json + per-subagent .md files match a fixture.
 *   2. Idempotency — second materializeAgent run for the same input returns
 *      `changed: false` (no rewrite when bytes match).
 *   3. Privacy invariant — `assertMaterializedPathSafety` throws on any
 *      path under config.localMemoryRoot.
 *   4. Backwards compat — a persona with NO harness.yaml row gets a default
 *      settings.json (profile=claude_code, mcpServers={}, plugin scaffolded).
 *   5. Stale-prune — removing a subagent from harness.yaml deletes its .md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// IMPORTANT: launcher-env-stamp.ts must be the FIRST relative import.
// ESM hoists imports — mutating process.env in this file's body is too
// late because config.ts has already read the env. The stamp file's
// top-level statements run at import time.
import { HOST_HOME, AGENTS_ROOT } from './launcher-env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { writeMemoryFile } from '../src/memory.ts';
import {
  materializeAgent,
  materializeAll,
  assertMaterializedPathSafety,
} from '../src/harness/materialize.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `harness-materialize.test: env override didn't reach config — got "${config.localAgentsRoot}"`,
  );
}

const FULL_HARNESS_YAML = `
version: 1
chatTier:
  skills: [simplify]
  subagents: []
  mcpServers: []
orchestrationTier:
  skills: []
  modelTier: enhanced
  enabledPluginIds: [extra-plugin]
  subagents:
    - name: security-review
      description: "Quickly review a diff for security issues"
      systemPrompt: |
        You are a focused security reviewer. Check for: SQL injection,
        path traversal, authentication bypass, secret exfiltration.
        Reply with a markdown bullet list of findings.
      tools: [read_file, grep]
  mcpServers:
    - id: gh
      command: gh-mcp-server
      args: ["--scope", "repo"]
      env:
        GITHUB_TOKEN: \${GITHUB_TOKEN}
      timeoutMs: 30000
`;

test('harness-materialize: produces deterministic settings.json + plugin manifest + subagent file', async () => {
  const agentId = 'gold-' + Math.random().toString(36).slice(2, 10);
  const t = setupTestDb();
  try {
    await writeMemoryFile('agents', agentId, 'harness.yaml', FULL_HARNESS_YAML, 'test');
    const r = await materializeAgent(agentId);

    assert.equal(r.agentId, agentId);
    assert.equal(r.changed, true, 'first run must rewrite');

    // settings.json
    const settings = JSON.parse(readFileSync(r.settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings.profile, 'enhanced');
    assert.deepEqual(
      [...(settings.enabledPluginIds as string[])].sort(),
      ['extra-plugin', `openclaw-${agentId}-harness`].sort(),
      'enabledPluginIds must include the per-persona plugin and the orchestration tier extras',
    );
    const mcp = settings.mcpServers as Record<string, { command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }>;
    assert.ok(mcp.gh, 'gh MCP server present');
    assert.equal(mcp.gh!.command, 'gh-mcp-server');
    assert.deepEqual(mcp.gh!.args, ['--scope', 'repo']);
    assert.equal(mcp.gh!.timeoutMs, 30000);

    // Plugin manifest
    const manifestPath = join(r.pluginDir, '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(manifestPath), 'plugin.json must exist');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.name, `openclaw-${agentId}-harness`);
    assert.equal(typeof manifest.version, 'string');

    // Subagent .md
    const subPath = join(r.pluginDir, 'agents', 'security-review.md');
    assert.ok(existsSync(subPath), 'security-review.md must exist');
    const subBody = readFileSync(subPath, 'utf8');
    assert.match(subBody, /^---\n/, 'frontmatter starts with ---');
    assert.match(subBody, /name: security-review/);
    assert.match(subBody, /description: "Quickly review a diff for security issues"/);
    assert.match(subBody, /tools: \["read_file", "grep"\]/);
    assert.match(subBody, /Quickly review a diff/);
    assert.match(subBody, /security reviewer/);
  } finally {
    await t.cleanup();
  }
});

test('harness-materialize: second run is idempotent (changed:false)', async () => {
  // Use a unique agent id so the per-agent ~/.ptah/agents/<id> dir is fresh
  // even when HOST_HOME is reused across tests in this file.
  const agentId = 'idem-' + Math.random().toString(36).slice(2, 10);
  const t = setupTestDb();
  try {
    await writeMemoryFile('agents', agentId, 'harness.yaml', FULL_HARNESS_YAML, 'test');
    const first = await materializeAgent(agentId);
    assert.equal(first.changed, true, 'first run for a fresh agent must rewrite');
    const second = await materializeAgent(agentId);
    assert.equal(second.changed, false, 'second materialize must be a no-op (byte-diff returns equal)');
  } finally {
    await t.cleanup();
  }
});

test('harness-materialize: privacy invariant throws on local-memory paths', () => {
  const evil = join(config.localMemoryRoot, 'agents', 'horus', 'persona.md');
  assert.throws(
    () => assertMaterializedPathSafety(evil),
    /refusing to write inside local-memory tree/,
    'assertMaterializedPathSafety must throw on paths under config.localMemoryRoot',
  );
  // Sanity: a path NOT under local-memory must NOT throw.
  assert.doesNotThrow(() =>
    assertMaterializedPathSafety(join(HOST_HOME, '.ptah', 'agents', 'horus', 'settings.json')),
  );
  // Edge case: the localMemoryRoot itself is also forbidden (not just children).
  assert.throws(
    () => assertMaterializedPathSafety(config.localMemoryRoot),
    /refusing to write inside local-memory tree/,
  );
});

test('harness-materialize: backwards compat — persona without harness.yaml gets default settings.json', async () => {
  const agentId = 'unconf-' + Math.random().toString(36).slice(2, 10);
  const t = setupTestDb();
  try {
    // No writeMemoryFile — persona has no harness.yaml row.
    const r = await materializeAgent(agentId);
    assert.equal(r.changed, true, 'first run for unconfigured persona still emits files');
    const settings = JSON.parse(readFileSync(r.settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings.profile, 'claude_code', 'default profile is claude_code');
    assert.deepEqual(settings.mcpServers, {}, 'no MCP servers when no harness');
    assert.deepEqual(
      settings.enabledPluginIds,
      [`openclaw-${agentId}-harness`],
      'plugin id list contains only the per-persona scaffold',
    );
    // Plugin scaffold must still exist so ptah's enabledPluginIds reference is valid.
    const manifestPath = join(r.pluginDir, '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(manifestPath), 'plugin manifest is written even for unconfigured personas');
  } finally {
    await t.cleanup();
  }
});

test('harness-materialize: removing a subagent from harness.yaml prunes its .md on next run', async () => {
  const agentId = 'prune-' + Math.random().toString(36).slice(2, 10);
  const t = setupTestDb();
  try {
    await writeMemoryFile('agents', agentId, 'harness.yaml', FULL_HARNESS_YAML, 'test');
    const first = await materializeAgent(agentId);
    const subPath = join(first.pluginDir, 'agents', 'security-review.md');
    assert.ok(existsSync(subPath));

    // Now write a harness with NO subagents.
    const empty = `
version: 1
chatTier:
  skills: []
  subagents: []
  mcpServers: []
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
    await writeMemoryFile('agents', agentId, 'harness.yaml', empty, 'test');
    const second = await materializeAgent(agentId);
    assert.equal(second.changed, true, 'pruning a stale subagent counts as changed');
    assert.equal(existsSync(subPath), false, 'stale subagent .md must be removed');
  } finally {
    await t.cleanup();
  }
});

test('harness-materialize: materializeAll covers every agent with a harness.yaml row', async () => {
  const a = 'all-a-' + Math.random().toString(36).slice(2, 8);
  const b = 'all-b-' + Math.random().toString(36).slice(2, 8);
  const t = setupTestDb();
  try {
    await writeMemoryFile('agents', a, 'harness.yaml', FULL_HARNESS_YAML, 'test');
    await writeMemoryFile('agents', b, 'harness.yaml', FULL_HARNESS_YAML, 'test');
    const all = await materializeAll();
    const ids = all.map((r) => r.agentId).filter((id) => id === a || id === b).sort();
    assert.deepEqual(ids, [a, b].sort());
    // For freshly-named agents, results MUST report changed.
    for (const r of all) {
      if (r.agentId === a || r.agentId === b) assert.equal(r.changed, true);
    }
  } finally {
    await t.cleanup();
  }
});

process.on('exit', () => {
  try {
    rmSync(HOST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
