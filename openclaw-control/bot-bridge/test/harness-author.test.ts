/**
 * harness-author — TASK_2026_002 B7 sub-task 10.
 *
 * Per-tool unit tests + an end-to-end integration test that drives the full
 * 4-tool-call dialog with a scripted mock LLM. The integration test is the
 * load-bearing assertion for AT#5: probe → propose → confirm → operator
 * "yes" → write_harness_file actually lands the yaml at the mocked daemon
 * endpoint and round-trips cleanly through `parseHarnessYaml`.
 *
 * Coverage map (verification criteria 5–8 from tasks.md:306–313):
 *   - read_file rejects '../etc/passwd' (criterion 5)
 *   - write_harness_file refuses on stage !== 'writing' (criterion 6)
 *   - the start_harness_setup placeholder is gone (criterion 7 is checked
 *     by the team-leader's CI grep; we additionally assert the real prompt
 *     body is returned to make the round-trip evidence inline)
 *   - no wizard:* / harness:analyze-intent calls (criterion 8 is grepped
 *     by B8's CI; we add a defensive assertion against the registry too)
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env vars must land before any module-level config read.
process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal';
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'ha-agents-'));
process.env.REDIS_URL = '';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED = '1';
// Long timeout so the integration test never auto-clears mid-run.
process.env.OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS = '3600000';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { ToolCallContext, ToolDef } from '../src/llm.ts';

// Lazy imports so config-time env vars land first.
type HarnessAuthorModule = typeof import('../src/harnessAuthor.ts');
type DaemonClientModule = typeof import('../src/daemonClient.ts');
type DaemonToolsModule = typeof import('../src/tools/daemonTools.ts');
type ChatModule = typeof import('../src/chat.ts');
type AgentRegistryModule = typeof import('../src/agentRegistry.ts');

let harnessAuthor: HarnessAuthorModule;
let daemonClient: DaemonClientModule;
let daemonTools: DaemonToolsModule;
let chatModule: ChatModule;

before(async () => {
  daemonTools = await import('../src/tools/daemonTools.ts');
  daemonClient = await import('../src/daemonClient.ts');
  harnessAuthor = await import('../src/harnessAuthor.ts');
  chatModule = await import('../src/chat.ts');
});

let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;

beforeEach(() => {
  savedDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(savedDispatcher);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_SLUG = 'sample-app';
const PROJECT_PATH = '/workspaces/sample-app';

const VALID_HARNESS_YAML = `version: 1

chatTier:
  skills:
    - skill-creator
    - simplify
  subagents:
    - name: triage
      description: Quick code review.
      systemPrompt: |
        You triage diffs.
      tools:
        - Read
        - Grep
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]

orchestrationTier:
  skills:
    - simplify
  subagents:
    - name: backend-developer
      description: Implementation specialist.
      systemPrompt: |
        Backend dev.
      tools: [Read, Edit]
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
  modelTier: claude_code
  enabledPluginIds: []
`;

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    agentId: 'horus',
    userId: 'U-1',
    channelId: 'C-1',
    state: new Map(),
    emit: () => {},
    ...overrides,
  };
}

interface DaemonStub {
  origs: Record<string, unknown>;
  files: Map<string, string>;
  listings: Map<string, Array<{ path: string; size: number; mtime: string }>>;
  listProjectsCalls: { count: number };
  writeProjectFileCalls: Array<{ slug: string; path: string; content: string }>;
  restore: () => void;
}

function stubDaemon(): DaemonStub {
  const origs: Record<string, unknown> = {
    listProjects: (daemonClient.daemon as any).listProjects,
    readProjectFile: (daemonClient.daemon as any).readProjectFile,
    listProjectFiles: (daemonClient.daemon as any).listProjectFiles,
    writeProjectFile: (daemonClient.daemon as any).writeProjectFile,
    listAgents: (daemonClient.daemon as any).listAgents,
    readMemory: (daemonClient.daemon as any).readMemory,
  };

  const files = new Map<string, string>();
  files.set(
    'package.json',
    JSON.stringify(
      {
        name: 'sample-app',
        version: '1.0.0',
        description: 'A sample app for the harness-author flow.',
        scripts: { test: 'node --test', build: 'tsc' },
        dependencies: { fastify: '^5.0.0' },
        devDependencies: { typescript: '^5.6.2' },
      },
      null,
      2,
    ),
  );
  files.set('README.md', '# sample-app\n\nThis is the readme.\n');
  files.set('.git/config', '[remote "origin"]\n\turl = https://github.com/example/sample-app.git\n');

  const listings = new Map<string, Array<{ path: string; size: number; mtime: string }>>();
  listings.set('', [
    { path: 'package.json', size: files.get('package.json')!.length, mtime: '2026-05-03T00:00:00Z' },
    { path: 'README.md', size: files.get('README.md')!.length, mtime: '2026-05-03T00:00:00Z' },
    { path: 'tsconfig.json', size: 100, mtime: '2026-05-03T00:00:00Z' },
  ]);
  files.set('tsconfig.json', '{}\n');

  const listProjectsCalls = { count: 0 };
  const writeProjectFileCalls: Array<{ slug: string; path: string; content: string }> = [];

  (daemonClient.daemon as any).listProjects = async () => {
    listProjectsCalls.count += 1;
    return [
      {
        slug: PROJECT_SLUG,
        path: PROJECT_PATH,
        openTaskCount: 0,
        taskCount: 0,
        checkpointCount: 0,
      },
    ];
  };

  (daemonClient.daemon as any).readProjectFile = async (slug: string, p: string) => {
    if (slug !== PROJECT_SLUG) return null;
    const content = files.get(p);
    if (content === undefined) return null;
    return {
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      mtime: '2026-05-03T00:00:00Z',
    };
  };

  (daemonClient.daemon as any).listProjectFiles = async (slug: string, prefix: string = '') => {
    if (slug !== PROJECT_SLUG) return [];
    return listings.get(prefix) ?? [];
  };

  (daemonClient.daemon as any).writeProjectFile = async (
    slug: string,
    p: string,
    content: string,
  ) => {
    writeProjectFileCalls.push({ slug, path: p, content });
    files.set(p, content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    listings.set(p.split('/').slice(0, -1).join('/'), [
      ...((listings.get(p.split('/').slice(0, -1).join('/')) ?? []) as Array<{
        path: string;
        size: number;
        mtime: string;
      }>),
      { path: p, size: sizeBytes, mtime: '2026-05-03T00:00:00Z' },
    ]);
    return { ok: true, sizeBytes };
  };

  (daemonClient.daemon as any).listAgents = async () => [];
  (daemonClient.daemon as any).readMemory = async () => null;

  return {
    origs,
    files,
    listings,
    listProjectsCalls,
    writeProjectFileCalls,
    restore: () => {
      Object.assign(daemonClient.daemon, origs);
    },
  };
}

function makeStateForProject(): Map<string, unknown> {
  const state = new Map<string, unknown>();
  state.set('harnessSetup', {
    project: PROJECT_SLUG,
    stage: 'probing',
    startedAt: Date.now(),
  });
  return state;
}

function findTool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" not present in registry`);
  return t;
}

// ===========================================================================
// (1) Registry shape — exactly 5 tools, the right names, no wizard:* leaks.
// ===========================================================================

test('harness-author: tools(state) returns exactly 5 tools with the canonical names', () => {
  const tools = harnessAuthor.tools(new Map());
  assert.equal(tools.length, 5, `expected 5 tools, got ${tools.length}`);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'confirm_harness',
    'probe_project',
    'propose_harness',
    'read_file',
    'write_harness_file',
  ]);
});

test('harness-author: HARNESS_AUTHOR_SYSTEM_PROMPT explicitly forbids wizard:* and harness:analyze-intent (criterion 8)', () => {
  // The system prompt mentions both names ONLY in a "Do not call …" forbid
  // clause — that's exactly what criterion 8 wants the LLM to see. The B8
  // CI grep verifies no CODE PATH ever invokes them; the system prompt is
  // the LLM-side guardrail.
  const prompt = harnessAuthor.HARNESS_AUTHOR_SYSTEM_PROMPT;
  assert.match(prompt, /Do not call wizard:\* or harness:analyze-intent/);
  // No code path in this module mentions wizard:* outside the forbid clause.
  // Strip the forbid line and assert the remainder is wizard-free.
  const withoutForbid = prompt.replace(
    /Do not call wizard:\* or harness:analyze-intent\.?/g,
    '',
  );
  assert.doesNotMatch(withoutForbid, /wizard:/i);
  assert.doesNotMatch(withoutForbid, /harness:analyze-intent/i);
});

// ===========================================================================
// (2) probe_project — bounded, surfaces package.json digest + git remote.
// ===========================================================================

test('harness-author: probe_project surfaces package.json digest, framework markers, README, git remote', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const probe = findTool(tools, 'probe_project');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await probe.handler({}, ctx);
    assert.match(out, /sample-app/);
    assert.match(out, /tsconfig\.json/, 'detected framework marker should appear');
    assert.match(out, /github\.com\/example\/sample-app/, 'git remote should be parsed');
    assert.match(out, /readme/i);
  } finally {
    stub.restore();
  }
});

test('harness-author: probe_project enforces the 200-entry cap', async () => {
  const stub = stubDaemon();
  try {
    // Replace the root listing with 250 fake files.
    const big = Array.from({ length: 250 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.txt`,
      size: 1,
      mtime: '2026-05-03T00:00:00Z',
    }));
    stub.listings.set('', big);
    const tools = harnessAuthor.tools(new Map());
    const probe = findTool(tools, 'probe_project');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await probe.handler({}, ctx);
    assert.match(out, /first 200 of 250/);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// (3) read_file — rejects '..' (criterion 5), absolute paths, escapes.
// ===========================================================================

test('harness-author: read_file rejects ../etc/passwd (criterion 5)', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const readFile = findTool(tools, 'read_file');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await readFile.handler({ relativePath: '../etc/passwd' }, ctx);
    assert.match(out, /\.\.|traversal/);
    // Must NOT have called readProjectFile — the boundary check is local.
    // (We can't directly assert the absence; we assert by content shape.)
    assert.match(out, /forbidden/);
  } finally {
    stub.restore();
  }
});

test('harness-author: read_file rejects absolute path', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const readFile = findTool(tools, 'read_file');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await readFile.handler({ relativePath: '/etc/passwd' }, ctx);
    assert.match(out, /absolute|forbidden/i);
  } finally {
    stub.restore();
  }
});

test('harness-author: read_file accepts a valid relative path and returns content', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const readFile = findTool(tools, 'read_file');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await readFile.handler({ relativePath: 'package.json' }, ctx);
    assert.match(out, /sample-app/);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// (4) propose_harness — validates via parseHarnessYaml.
// ===========================================================================

test('harness-author: propose_harness rejects invalid yaml with parse error', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const propose = findTool(tools, 'propose_harness');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await propose.handler(
      { yaml: 'version: 999\nchatTier: {}\norchestrationTier: {}' },
      ctx,
    );
    assert.match(out, /rejected/);
    // Must NOT have stored the proposal on a rejection.
    const state = ctx.state.get('harnessSetup') as { proposed?: unknown };
    assert.equal(state.proposed, undefined);
  } finally {
    stub.restore();
  }
});

test('harness-author: propose_harness stores the proposal and returns markdown digest on valid yaml', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const propose = findTool(tools, 'propose_harness');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await propose.handler({ yaml: VALID_HARNESS_YAML }, ctx);
    assert.match(out, /Harness proposal/);
    assert.match(out, /chat tier/i);
    assert.match(out, /orchestration tier/i);
    const state = ctx.state.get('harnessSetup') as {
      proposed?: { yaml: string; config: { version: 1 } };
    };
    assert.ok(state.proposed, 'proposal must be stored on success');
    assert.equal(state.proposed!.yaml, VALID_HARNESS_YAML);
    assert.equal(state.proposed!.config.version, 1);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// (5) confirm_harness — flips stage.
// ===========================================================================

test('harness-author: confirm_harness flips stage to awaiting-operator-confirmation', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const propose = findTool(tools, 'propose_harness');
    const confirm = findTool(tools, 'confirm_harness');
    const ctx = makeCtx({ state: makeStateForProject() });
    await propose.handler({ yaml: VALID_HARNESS_YAML }, ctx);
    const out = await confirm.handler({}, ctx);
    assert.match(out, /awaiting-operator-confirmation/);
    const state = ctx.state.get('harnessSetup') as { stage: string };
    assert.equal(state.stage, 'awaiting-operator-confirmation');
  } finally {
    stub.restore();
  }
});

test('harness-author: confirm_harness errors when no proposal staged', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const confirm = findTool(tools, 'confirm_harness');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await confirm.handler({}, ctx);
    assert.match(out, /no proposed harness/);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// (6) write_harness_file — gated on stage === 'writing' (criterion 6).
// ===========================================================================

test('harness-author: write_harness_file refuses when stage is "probing" (criterion 6)', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const write = findTool(tools, 'write_harness_file');
    const ctx = makeCtx({ state: makeStateForProject() });
    const out = await write.handler({}, ctx);
    assert.match(out, /stage is "probing"/);
    assert.equal(stub.writeProjectFileCalls.length, 0);
  } finally {
    stub.restore();
  }
});

test('harness-author: write_harness_file refuses when stage is "awaiting-operator-confirmation" (criterion 6)', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const write = findTool(tools, 'write_harness_file');
    const state = makeStateForProject();
    const slot = state.get('harnessSetup') as Record<string, unknown>;
    slot.stage = 'awaiting-operator-confirmation';
    slot.proposed = {
      yaml: VALID_HARNESS_YAML,
      config: { version: 1 } as unknown as object,
    };
    const ctx = makeCtx({ state });
    const out = await write.handler({}, ctx);
    assert.match(out, /not "writing"/);
    assert.equal(stub.writeProjectFileCalls.length, 0);
  } finally {
    stub.restore();
  }
});

test('harness-author: write_harness_file writes when stage is "writing" and proposal is present', async () => {
  const stub = stubDaemon();
  try {
    const tools = harnessAuthor.tools(new Map());
    const write = findTool(tools, 'write_harness_file');
    const propose = findTool(tools, 'propose_harness');
    const state = makeStateForProject();
    const ctx = makeCtx({ state });
    await propose.handler({ yaml: VALID_HARNESS_YAML }, ctx);
    const slot = state.get('harnessSetup') as Record<string, unknown>;
    slot.stage = 'writing';
    const out = await write.handler({}, ctx);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.path, '.claude/harness.yaml');
    assert.equal(stub.writeProjectFileCalls.length, 1);
    assert.equal(stub.writeProjectFileCalls[0]!.slug, PROJECT_SLUG);
    assert.equal(stub.writeProjectFileCalls[0]!.path, '.claude/harness.yaml');
    assert.equal(stub.writeProjectFileCalls[0]!.content, VALID_HARNESS_YAML);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// (7) start_harness_setup — no longer a placeholder (criterion 7).
// ===========================================================================

test('harness-author: start_harness_setup returns the real HARNESS_AUTHOR_SYSTEM_PROMPT body (criterion 7)', async () => {
  const tools = daemonTools.list();
  const start = findTool(tools, 'start_harness_setup');
  const ctx = makeCtx();
  const out = await start.handler({ project: PROJECT_SLUG }, ctx);
  // The placeholder body said "[harness-author placeholder]". The real one
  // contains the system prompt's "Process (strict):" header.
  assert.doesNotMatch(out, /placeholder/);
  assert.match(out, /HARNESS-AUTHORING MODE/);
  assert.match(out, /Process \(strict\):/);
  // State was written.
  const state = ctx.state.get('harnessSetup') as { project: string; stage: string; startedAt: number };
  assert.equal(state.project, PROJECT_SLUG);
  assert.equal(state.stage, 'probing');
  assert.equal(typeof state.startedAt, 'number');
});

// ===========================================================================
// (8) Integration — full 4-tool-call dialog with mock LLM.
// ===========================================================================

interface FakeMessage {
  content: string;
  author: { id: string; username: string };
  channel: {
    id: string;
    name?: string;
    sendTyping: () => Promise<void>;
    send: (s: string) => Promise<void>;
  };
  guild: { name: string } | null;
  reply: (s: string) => Promise<void>;
  __captured: string[];
}

function makeFakeMessage(text: string, channelId = 'C-int'): FakeMessage {
  const captured: string[] = [];
  return {
    content: text,
    author: { id: 'U-int', username: 'tester' },
    channel: {
      id: channelId,
      name: 'general',
      sendTyping: async () => {},
      send: async (s: string) => {
        captured.push(s);
      },
    },
    guild: { name: 'test-guild' },
    reply: async (s: string) => {
      captured.push(s);
    },
    __captured: captured,
  };
}

function makeFakeAgent(): AgentRegistryModule['AgentDef'] {
  return {
    id: 'horus',
    name: 'Horus',
    persona: 'orchestrator',
    identityMd: '# Horus identity',
    personaMd: '# Horus persona — TEST',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake',
  } as unknown as AgentRegistryModule['AgentDef'];
}

test('harness-author integration: full dialog start → probe → propose → confirm → yes → write', async () => {
  // Reset cross-message state from any prior test run.
  chatModule.__resetHarnessSessionsForTests();
  const stub = stubDaemon();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // ===== Turn 1: operator says "set up the harness" ======================
    // The default tool registry is in play. The LLM calls
    // `start_harness_setup`, which writes ctx.state.harnessSetup. Within
    // this same LLM loop the registry is NOT swapped (impl-plan line 1068:
    // chat.ts swaps the registry "on the next round" — meaning the next
    // *handleChat call*, not the next LLM iteration). So the LLM should
    // end its turn here, leaving the actual probe/propose work for Turn 2
    // when the registry has been replaced.

    // Round 1 of turn 1: fire start_harness_setup.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_start',
                type: 'function',
                function: {
                  name: 'start_harness_setup',
                  arguments: JSON.stringify({ project: PROJECT_SLUG }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    // Round 2 of turn 1: end turn with a confirmation message.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I am in harness-authoring mode for sample-app. Tell me when to begin.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg1 = makeFakeMessage('@horus set up the harness for sample-app');
    await chatModule.handleChat(makeFakeAgent(), msg1 as any);
    const reply1 = msg1.__captured.join('\n');
    assert.match(reply1, /harness-authoring mode/);

    // ===== Turn 2: operator says "go ahead" ================================
    // Now the registry is harnessAuthor.tools(...) — the LLM sees the 5
    // author tools and walks the canonical 3-call sequence:
    // probe_project → propose_harness → confirm_harness, then ends its
    // turn asking the operator for "yes" / "no".

    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_probe',
                type: 'function',
                function: { name: 'probe_project', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_propose',
                type: 'function',
                function: {
                  name: 'propose_harness',
                  arguments: JSON.stringify({ yaml: VALID_HARNESS_YAML }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_confirm',
                type: 'function',
                function: { name: 'confirm_harness', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              'Here is the proposed harness. Reply **yes** to write `.claude/harness.yaml`, **no** to revise, or **cancel harness setup** to abort.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg2 = makeFakeMessage('@horus go ahead and propose a harness');
    await chatModule.handleChat(makeFakeAgent(), msg2 as any);
    const reply2 = msg2.__captured.join('\n');
    assert.match(reply2, /\*\*yes\*\*/, 'turn 2 final reply asks operator to confirm');

    // ===== Turn 3: operator says "yes" =====================================
    // chat.ts flips stage → 'writing'. The LLM calls write_harness_file,
    // then ends its turn with a success message.

    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_write',
                type: 'function',
                function: { name: 'write_harness_file', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Wrote `.claude/harness.yaml`. The harness is live.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    // NB: use a Discord-formatted mention `<@123>` so stripMentions actually
    // removes it. The literal "@horus" string is not a Discord mention and
    // would survive into the operator-reply detector.
    const msg3 = makeFakeMessage('<@123456> yes');
    await chatModule.handleChat(makeFakeAgent(), msg3 as any);
    const reply3 = msg3.__captured.join('\n');
    // Debug aid (visible only on assertion failure):
    const debugBlob = JSON.stringify({
      reply2,
      reply3,
      writeCalls: stub.writeProjectFileCalls.length,
    });
    assert.match(reply3, /\.claude\/harness\.yaml/);

    // The mocked daemon must have received exactly one write call.
    assert.equal(
      stub.writeProjectFileCalls.length,
      1,
      `expected exactly one writeProjectFile call, got ${stub.writeProjectFileCalls.length} — debug=${debugBlob}`,
    );
    const wrote = stub.writeProjectFileCalls[0]!;
    assert.equal(wrote.slug, PROJECT_SLUG);
    assert.equal(wrote.path, '.claude/harness.yaml');

    // The yaml must round-trip cleanly through parseHarnessYaml (criterion 2).
    const harnessTypes = await import('../src/harness/types.ts');
    const parsed = harnessTypes.parseHarnessYaml(wrote.content);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.chatTier.skills, ['skill-creator', 'simplify']);
    assert.equal(parsed.chatTier.subagents.length, 1);
    assert.equal(parsed.chatTier.subagents[0]!.name, 'triage');
    assert.equal(parsed.orchestrationTier.modelTier, 'claude_code');
  } finally {
    stub.restore();
    chatModule.__resetHarnessSessionsForTests();
  }
});

test('harness-author integration: "cancel harness setup" wipes state and posts cancelled reply', async () => {
  chatModule.__resetHarnessSessionsForTests();
  const stub = stubDaemon();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Turn 1: same as before — bring the session up to confirm stage.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_start',
                type: 'function',
                function: {
                  name: 'start_harness_setup',
                  arguments: JSON.stringify({ project: PROJECT_SLUG }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will probe shortly. Tell me when ready.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg1 = makeFakeMessage(
      '@horus please set up the harness for sample-app',
      'C-cancel',
    );
    await chatModule.handleChat(makeFakeAgent(), msg1 as any);

    // Turn 2: operator cancels. No LLM calls should happen — chat.ts
    // short-circuits before building the tool registry. Set up zero
    // intercepts; if chat.ts tries to call the LLM, we'd see a network
    // assertion failure.
    const msg2 = makeFakeMessage('<@123456> cancel harness setup', 'C-cancel');
    await chatModule.handleChat(makeFakeAgent(), msg2 as any);
    const reply2 = msg2.__captured.join('\n');
    assert.match(reply2, /[Cc]ancelled/);

    // No write should have happened.
    assert.equal(stub.writeProjectFileCalls.length, 0);
  } finally {
    stub.restore();
    chatModule.__resetHarnessSessionsForTests();
  }
});

test('harness-author integration: timeout auto-clears the session', async () => {
  chatModule.__resetHarnessSessionsForTests();
  const stub = stubDaemon();
  // Ultra-short timeout for this test — restore at the end.
  const cfgModule = await import('../src/config.ts');
  const originalTimeout = cfgModule.config.harnessAuthorTimeoutMs;
  (cfgModule.config as any).harnessAuthorTimeoutMs = 1;
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Round 1 of turn 1: start_harness_setup.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_start',
                type: 'function',
                function: {
                  name: 'start_harness_setup',
                  arguments: JSON.stringify({ project: PROJECT_SLUG }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'Started.' },
          finish_reason: 'stop',
        },
      ],
    });
    const msg1 = makeFakeMessage('@horus set up the harness for sample-app', 'C-timeout');
    await chatModule.handleChat(makeFakeAgent(), msg1 as any);

    // Sleep a tick so Date.now() moves past the 1ms timeout. Turn 2 must
    // see the session as expired and post the auto-clear notice.
    await new Promise((r) => setTimeout(r, 10));

    // Turn 2: any message — chat.ts should detect timeout, clear the
    // session, post the timeout notice, then PROCESS the message normally
    // against the default tool registry. Stub a one-round LLM response.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'normal response' },
          finish_reason: 'stop',
        },
      ],
    });
    const msg2 = makeFakeMessage('@horus hi', 'C-timeout');
    await chatModule.handleChat(makeFakeAgent(), msg2 as any);
    const reply2 = msg2.__captured.join('\n');
    assert.match(reply2, /timed out/);
  } finally {
    (cfgModule.config as any).harnessAuthorTimeoutMs = originalTimeout;
    stub.restore();
    chatModule.__resetHarnessSessionsForTests();
  }
});
