/**
 * mcp-everything — TASK_2026_002 B4 sub-task 8 integration test.
 *
 * Spawns the bundled `@modelcontextprotocol/server-everything` reference
 * server and round-trips `add(a:1, b:2) → 3`. This proves the production
 * lifecycle (`StdioClientTransport` → `client.initialize()` → `listTools()` →
 * `callTool()` → stop) works against a real MCP server.
 *
 * GATED: only runs when `OPENCLAW_TEST_REAL_MCP=1`. Skipped in CI because
 * spawning a Node child process under `node --test --import tsx` is fragile
 * and slow. Run locally with:
 *
 *   cd openclaw-control/bot-bridge && \
 *     OPENCLAW_TEST_REAL_MCP=1 npm test -- --grep mcp-everything
 *
 * The test discovers the everything server by attempting `node -e
 * "console.log(require.resolve('@modelcontextprotocol/server-everything'))"`
 * inside the bot-bridge package. If the package isn't installed, the test
 * fails with a precise error message — `npm i -D @modelcontextprotocol/
 * server-everything` is the fix.
 */

process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
process.env.REDIS_URL = '';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { McpServerSpec } from '../../src/harness/types.ts';
import type { AgentDef } from '../../src/agentRegistry.ts';

const REAL_MCP_ENABLED = process.env.OPENCLAW_TEST_REAL_MCP === '1';

let mcpManager: typeof import('../../src/mcp/mcpManager.ts');

before(async () => {
  if (!REAL_MCP_ENABLED) return;
  mcpManager = await import('../../src/mcp/mcpManager.ts');
});

function discoverEverythingBin(): string | null {
  // Try resolving the JS entry point of the package, then walk up to its
  // package.json `bin` entry. Falls back to checking node_modules/.bin.
  try {
    const entry = execFileSync(
      process.execPath,
      ['-e', "console.log(require.resolve('@modelcontextprotocol/server-everything'))"],
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim();
    if (entry && existsSync(entry)) return entry;
  } catch {
    /* fall through */
  }
  // Fallback: assume it's installed in the bot-bridge node_modules.
  const guess = join(
    process.cwd(),
    'node_modules',
    '@modelcontextprotocol',
    'server-everything',
    'dist',
    'index.js',
  );
  if (existsSync(guess)) return guess;
  return null;
}

const skipMessage = REAL_MCP_ENABLED
  ? null
  : 'OPENCLAW_TEST_REAL_MCP=1 not set — integration test skipped (CI never sets it)';

test('mcp-everything: round-trip add(a:1, b:2) → 3 against the real reference server', async (t) => {
  if (skipMessage) {
    t.skip(skipMessage);
    return;
  }

  const bin = discoverEverythingBin();
  if (!bin) {
    assert.fail(
      'cannot locate @modelcontextprotocol/server-everything — install with `npm i -D @modelcontextprotocol/server-everything` in openclaw-control/bot-bridge',
    );
  }

  const spec: McpServerSpec = {
    id: 'everything',
    command: process.execPath,
    args: [bin],
  };

  const agent: AgentDef = {
    id: 'horus',
    name: 'horus',
    tokenEnvVar: '',
    token: null,
    personaMd: '## persona',
    harness: {
      version: 1,
      chatTier: { skills: [], subagents: [], mcpServers: [spec] },
      orchestrationTier: { skills: [], subagents: [], mcpServers: [] },
    },
  };

  await mcpManager.startServersForAgent(agent);
  try {
    const open = mcpManager.getOpenServers('horus');
    assert.equal(open.length, 1, 'one server must be open');
    const tools = open[0]!.tools.map((t) => t.name);
    assert.ok(
      tools.includes('add'),
      `everything server should expose 'add', got: ${tools.join(', ')}`,
    );

    const r = await mcpManager.callTool('horus', 'everything', 'add', { a: 1, b: 2 });
    assert.equal(r.isError, false, `add() returned isError=true: ${r.content}`);
    assert.match(
      r.content,
      /3/,
      `expected '3' in the response, got: ${r.content}`,
    );
  } finally {
    await mcpManager.shutdownAll();
  }

  // Reference dirname so the lint doesn't complain about the unused import.
  void dirname;
});
