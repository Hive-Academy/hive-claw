/**
 * horus-end-to-end — TASK_2026_002 B8 sub-task 8.
 *
 * The full AT#1–#5 sweep against the just-committed Horus harness fixture
 * (`shared-specs/memory/agents/horus/harness.yaml`). Each AT is a separate
 * `it(...)` block so a failing one names itself in the test runner output.
 *
 * AT#6 (`spawnPtahForAgent` body shape + materialized plugin file) is a
 * daemon-side concern that depends on `better-sqlite3` and the daemon's
 * `MemoryRepo`. Importing those into the bot-bridge process is not viable
 * without coupling the two packages. AT#6 lives in the companion daemon
 * test `daemon/test/horus-spawn.test.ts` (B8 sub-task 8 split). The
 * orchestrator's commit message MUST reference both files.
 *
 * Test seams used (all already exist — no new product code in this file):
 *
 *   - `undici.MockAgent` / `setGlobalDispatcher` for the LLM provider —
 *      same pattern as `mcp-manager.test.ts` and `llm-tool-call.test.ts`.
 *   - `mcpManager.__setSpawnForTests` / `__makeTestEntry` for AT#4 — drives
 *      a fake stdio server with a hand-rolled `callTool` that returns a
 *      known-text payload.
 *   - `daemonClient` monkey-patching for AT#1 (project list) — same shape
 *      as `harness-author.test.ts:stubDaemon`, factored down to just the
 *      methods this sweep exercises.
 *   - `chat.__resetHarnessSessionsForTests` between AT#5 turns to keep the
 *      cross-message harness-author session map clean.
 *
 * No new runtime deps. No new product code paths. Every assertion lands on
 * surface that B2–B7 already shipped.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stamp env BEFORE any module-level config read. ESM imports are hoisted, so
// the only correct place for these is at the very top of the file before any
// `import ... from '../../src/...'` line runs.
process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal';
process.env.REDIS_URL = '';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED = '1';
// Long timeout so AT#5's multi-turn dialog never auto-clears mid-run.
process.env.OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS = '3600000';
// Point skills root at the repo's `skills/` so AT#2 finds the real
// `security-review` SKILL.md scaffolded by Track A. Resolved relative to
// THIS file: …/openclaw-control/bot-bridge/test/integration/horus-end-to-end.test.ts
// → up four = repo root, then `skills/`.
const __here = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__here, '..', '..', '..', '..', '..');
process.env.OPENCLAW_SKILLS_ROOT = join(REPO_ROOT, 'skills');
// Per-agent local-memory dir — bot-bridge only reads `persona.md` from it,
// but agentRegistry.loadAgents() requires the dir to exist before attempting.
const TEST_AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'horus-e2e-agents-'));
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = TEST_AGENTS_ROOT;

import { test, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { mkdirSync, writeFileSync } from 'node:fs';

// Lazy-bind the module imports — the env stamps above must land first.
type DaemonClientModule = typeof import('../../src/daemonClient.ts');
type ChatModule = typeof import('../../src/chat.ts');
type AgentRegistryModule = typeof import('../../src/agentRegistry.ts');
type McpManagerModule = typeof import('../../src/mcp/mcpManager.ts');
type HarnessTypesModule = typeof import('../../src/harness/types.ts');

let daemonClient: DaemonClientModule;
let chatModule: ChatModule;
let mcpManager: McpManagerModule;
let harnessTypes: HarnessTypesModule;

// Seed Horus persona on the local-memory FS so `agentRegistry.loadAgentById`
// returns a runnable AgentDef. The integration test does NOT actually go
// through `loadAgents()` — it builds an `AgentDef` directly from the parsed
// harness fixture, the same way `harness-author.test.ts:makeFakeAgent` does.
// We still create the dir so any code that walks `localAgentsRoot` during
// import doesn't see an empty tree it considers a failure.
mkdirSync(join(TEST_AGENTS_ROOT, 'horus'), { recursive: true });
writeFileSync(
  join(TEST_AGENTS_ROOT, 'horus', 'persona.md'),
  '# Horus persona — TEST FIXTURE (private)\n',
);

before(async () => {
  daemonClient = await import('../../src/daemonClient.ts');
  chatModule = await import('../../src/chat.ts');
  mcpManager = await import('../../src/mcp/mcpManager.ts');
  harnessTypes = await import('../../src/harness/types.ts');
});

after(() => {
  try {
    rmSync(TEST_AGENTS_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
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
  mcpManager.__resetForTests();
  chatModule.__resetHarnessSessionsForTests();
});

// ---------------------------------------------------------------------------
// Fixture load
// ---------------------------------------------------------------------------

const HARNESS_YAML_PATH = join(REPO_ROOT, 'shared-specs', 'memory', 'agents', 'horus', 'harness.yaml');

function loadHorusHarness(): import('../../src/harness/types.ts').HarnessConfig {
  if (!existsSync(HARNESS_YAML_PATH)) {
    throw new Error(
      `horus harness fixture missing at ${HARNESS_YAML_PATH} — Track A must commit shared-specs/memory/agents/horus/harness.yaml first`,
    );
  }
  const yamlText = readFileSync(HARNESS_YAML_PATH, 'utf8');
  return harnessTypes.parseHarnessYaml(yamlText);
}

function makeHorusAgent(): import('../../src/agentRegistry.ts').AgentDef {
  const harness = loadHorusHarness();
  return {
    id: 'horus',
    name: 'Horus',
    persona: 'guardian',
    identityMd: '# Horus identity (TEST)\n\nThe security-focused pilot persona.',
    personaMd: '# Horus persona — TEST FIXTURE (private — local-memory only)',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake-token',
    harness,
    harnessVersion: harnessTypes.harnessHash(readFileSync(HARNESS_YAML_PATH, 'utf8')),
  };
}

// ---------------------------------------------------------------------------
// Discord-message stub — same shape `harness-author.test.ts` uses.
// ---------------------------------------------------------------------------

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

function makeFakeMessage(text: string, channelId = 'C-e2e'): FakeMessage {
  const captured: string[] = [];
  return {
    content: text,
    author: { id: 'U-e2e', username: 'tester' },
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

// ---------------------------------------------------------------------------
// Daemon-client stub — only the methods the AT sweep needs.
// ---------------------------------------------------------------------------

interface DaemonStub {
  origs: Record<string, unknown>;
  emittedSse: Array<{ event: string; data: unknown }>;
  listProjectsCalls: { count: number };
  writeProjectFileCalls: Array<{ slug: string; path: string; content: string }>;
  files: Map<string, string>;
  restore: () => void;
}

function stubDaemon(): DaemonStub {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const origs: Record<string, unknown> = {
    listProjects: (daemonClient.daemon as any).listProjects,
    listAgents: (daemonClient.daemon as any).listAgents,
    listTasks: (daemonClient.daemon as any).listTasks,
    readMemory: (daemonClient.daemon as any).readMemory,
    readAgentIdentity: (daemonClient.daemon as any).readAgentIdentity,
    readDiscordJson: (daemonClient.daemon as any).readDiscordJson,
    readHarnessYaml: (daemonClient.daemon as any).readHarnessYaml,
    readProjectFile: (daemonClient.daemon as any).readProjectFile,
    listProjectFiles: (daemonClient.daemon as any).listProjectFiles,
    writeProjectFile: (daemonClient.daemon as any).writeProjectFile,
    emitSseHint: (daemonClient.daemon as any).emitSseHint,
  };

  const emittedSse: Array<{ event: string; data: unknown }> = [];
  const listProjectsCalls = { count: 0 };
  const writeProjectFileCalls: Array<{ slug: string; path: string; content: string }> = [];
  const files = new Map<string, string>();

  // Seed sample project content for the AT#5 harness-author probe.
  files.set(
    'package.json',
    JSON.stringify(
      {
        name: 'sample-app',
        version: '1.0.0',
        description: 'A sample app for the AT sweep.',
        scripts: { test: 'node --test' },
        dependencies: { fastify: '^5.0.0' },
      },
      null,
      2,
    ),
  );
  files.set('README.md', '# sample-app\n\nReadme.\n');
  files.set('.git/config', '[remote "origin"]\n\turl = https://github.com/example/sample-app.git\n');
  files.set('tsconfig.json', '{}\n');

  (daemonClient.daemon as any).listProjects = async () => {
    listProjectsCalls.count += 1;
    return [
      { slug: 'fixing-openclaw', path: '/workspaces/fixing-openclaw', openTaskCount: 1, taskCount: 4, checkpointCount: 0 },
      { slug: 'sample-app', path: '/workspaces/sample-app', openTaskCount: 0, taskCount: 0, checkpointCount: 0 },
    ];
  };
  (daemonClient.daemon as any).listAgents = async () => [
    { id: 'horus', ownedHere: true, status: 'online' },
  ];
  (daemonClient.daemon as any).listTasks = async () => [];
  (daemonClient.daemon as any).readMemory = async () => null;
  (daemonClient.daemon as any).readAgentIdentity = async () => null;
  (daemonClient.daemon as any).readDiscordJson = async () => null;
  (daemonClient.daemon as any).readHarnessYaml = async () => null;
  (daemonClient.daemon as any).readProjectFile = async (slug: string, p: string) => {
    if (slug !== 'sample-app') return null;
    const content = files.get(p);
    if (content === undefined) return null;
    return { content, sizeBytes: Buffer.byteLength(content, 'utf8'), mtime: '2026-05-03T00:00:00Z' };
  };
  (daemonClient.daemon as any).listProjectFiles = async (slug: string, prefix = '') => {
    if (slug !== 'sample-app') return [];
    if (prefix.length > 0) return [];
    return [
      { path: 'package.json', size: files.get('package.json')!.length, mtime: '2026-05-03T00:00:00Z' },
      { path: 'README.md', size: files.get('README.md')!.length, mtime: '2026-05-03T00:00:00Z' },
      { path: 'tsconfig.json', size: files.get('tsconfig.json')!.length, mtime: '2026-05-03T00:00:00Z' },
    ];
  };
  (daemonClient.daemon as any).writeProjectFile = async (slug: string, p: string, content: string) => {
    writeProjectFileCalls.push({ slug, path: p, content });
    files.set(p, content);
    return { ok: true, sizeBytes: Buffer.byteLength(content, 'utf8') };
  };
  (daemonClient.daemon as any).emitSseHint = async (event: string, data: unknown) => {
    emittedSse.push({ event, data });
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    origs,
    emittedSse,
    listProjectsCalls,
    writeProjectFileCalls,
    files,
    restore: () => {
      Object.assign(daemonClient.daemon, origs);
    },
  };
}

// ===========================================================================
// AT#1 — list_projects tool call → assistant text contains project names
// ===========================================================================

test('horus-end-to-end AT#1: mocked LLM emits list_projects → assistant text contains project names', async () => {
  const stub = stubDaemon();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Round 1 → assistant calls list_projects.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_lp',
                type: 'function',
                function: { name: 'list_projects', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    // Round 2 → assistant uses the tool result and replies with the slugs.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'You have two projects: **fixing-openclaw** and **sample-app**.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg = makeFakeMessage('<@123> what projects do we have?');
    await chatModule.handleChat(makeHorusAgent(), msg as any);
    const reply = msg.__captured.join('\n');

    assert.match(reply, /fixing-openclaw/, 'reply must include the first project slug');
    assert.match(reply, /sample-app/, 'reply must include the second project slug');
    assert.ok(stub.listProjectsCalls.count >= 1, 'list_projects must have been invoked at least once');
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// AT#2 — Horus harness load + security-review skill body in system prompt
// ===========================================================================

test('horus-end-to-end AT#2: harness loads, security-review skill body lands in the system prompt', async () => {
  const stub = stubDaemon();
  try {
    // Capture the request body sent to /v1/chat/completions so we can inspect
    // the assembled system prompt.
    let capturedSystem: string | null = null;
    const pool = mockAgent.get('http://mock.openclaw.test');
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply((opts) => {
      const body = JSON.parse(String(opts.body));
      const sys = (body.messages ?? []).find((m: { role: string }) => m.role === 'system');
      capturedSystem = sys?.content ?? null;
      return {
        statusCode: 200,
        data: {
          choices: [
            { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        },
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });

    const msg = makeFakeMessage('<@123> hi');
    await chatModule.handleChat(makeHorusAgent(), msg as any);

    assert.ok(capturedSystem, 'system prompt must have been captured');
    assert.match(capturedSystem!, /Loaded skills/, 'system prompt must contain the "Loaded skills" header');
    assert.match(capturedSystem!, /### security-review/, 'system prompt must declare the security-review skill block');
    assert.match(
      capturedSystem!,
      /Security Review Skill/,
      'system prompt must inline the body of skills/security-review/SKILL.md (frontmatter stripped)',
    );
    assert.match(capturedSystem!, /### simplify/, 'system prompt must also declare the simplify skill (second harness entry)');
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// AT#3 — delegate_to_subagent → invoker.subagent_started/finished SSE events
// ===========================================================================

test('horus-end-to-end AT#3: delegate_to_subagent fires invoker.subagent_started + invoker.subagent_finished', async () => {
  const stub = stubDaemon();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Parent round 1 → call delegate_to_subagent.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_delegate',
                type: 'function',
                function: {
                  name: 'delegate_to_subagent',
                  arguments: JSON.stringify({
                    name: 'pr-diff-triage',
                    prompt: 'review the diff for #2026',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    // Subagent round 1 → final text from the subagent's sub-chat.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'NONE — no OWASP-relevant changes.' },
          finish_reason: 'stop',
        },
      ],
    });

    // Parent round 2 → final text incorporating the subagent reply.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'pr-diff-triage report: NONE — no OWASP-relevant changes.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg = makeFakeMessage('<@123> triage PR #2026');
    await chatModule.handleChat(makeHorusAgent(), msg as any);

    const startedEvents = stub.emittedSse.filter((e) => e.event === 'invoker.subagent_started');
    const finishedEvents = stub.emittedSse.filter((e) => e.event === 'invoker.subagent_finished');

    assert.equal(startedEvents.length, 1, 'invoker.subagent_started must fire exactly once');
    assert.equal(finishedEvents.length, 1, 'invoker.subagent_finished must fire exactly once');

    const startData = startedEvents[0]!.data as { name: string; parentAgentId: string; depth: number };
    assert.equal(startData.name, 'pr-diff-triage');
    assert.equal(startData.parentAgentId, 'horus');
    assert.equal(startData.depth, 1, 'depth must be 1 — first-level subagent invocation');

    const finishData = finishedEvents[0]!.data as { name: string; replyLength: number };
    assert.equal(finishData.name, 'pr-diff-triage');
    assert.ok(finishData.replyLength > 0, 'subagent must produce non-empty reply');
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// AT#4 — mocked stdio MCP returns a tool result; assistant text includes it
// ===========================================================================

test('horus-end-to-end AT#4: MCP tool round-trip — mocked stdio server result reaches the assistant text', async () => {
  const stub = stubDaemon();
  try {
    // Wire a fake MCP server for the gh server declared in horus harness.
    // mcp-manager test seam: __setSpawnForTests + __makeTestEntry (same
    // pattern as mcp-manager.test.ts:line 128).
    const callToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    mcpManager.__setSpawnForTests(async (agentId, s) =>
      mcpManager.__makeTestEntry(agentId, s, {
        tools: [
          {
            name: 'get_pull_request_diff',
            description: 'Fetch the unified diff of a PR.',
            inputSchema: {
              type: 'object',
              properties: { owner: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'number' } },
              required: ['owner', 'repo', 'pr'],
            },
          },
        ],
        callTool: async ({ name, arguments: args }) => {
          callToolCalls.push({ name, arguments: args });
          return {
            content: [
              {
                type: 'text',
                text: 'diff --git a/auth.ts b/auth.ts\n@@ -10,1 +10,1 @@\n-bad\n+good',
              },
            ],
            isError: false,
          };
        },
      }),
    );

    const agent = makeHorusAgent();
    await mcpManager.startServersForAgent(agent);

    const pool = mockAgent.get('http://mock.openclaw.test');
    // Round 1 → assistant calls the namespaced MCP tool.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_mcp',
                type: 'function',
                function: {
                  name: 'mcp__gh__get_pull_request_diff',
                  arguments: JSON.stringify({ owner: 'example', repo: 'sample-app', pr: 2026 }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    // Round 2 → assistant uses the tool output verbatim.
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Diff for PR #2026: changed `auth.ts` line 10 from `bad` to `good`.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg = makeFakeMessage('<@123> show me the diff for PR 2026');
    await chatModule.handleChat(agent, msg as any);
    const reply = msg.__captured.join('\n');

    assert.equal(callToolCalls.length, 1, 'MCP server must have been invoked exactly once');
    assert.equal(callToolCalls[0]!.name, 'get_pull_request_diff', 'MCP tool name (un-namespaced) routed correctly');
    assert.match(reply, /auth\.ts/, 'assistant reply must reference content surfaced by the MCP tool');
    assert.match(reply, /PR #2026/, 'assistant reply must keep the operator context intact');
  } finally {
    stub.restore();
    await mcpManager.shutdownAll();
  }
});

// ===========================================================================
// AT#5 — harness-authoring dialog → .claude/harness.yaml written + parses
// ===========================================================================

const VALID_AUTHORED_HARNESS_YAML = `version: 1

chatTier:
  skills:
    - simplify
  subagents:
    - name: triage
      description: Triage diffs.
      systemPrompt: |
        You triage diffs.
      tools: [Read, Grep]
  mcpServers: []

orchestrationTier:
  skills:
    - simplify
  subagents:
    - name: backend-developer
      description: Implementation.
      systemPrompt: |
        Backend dev.
      tools: [Read, Edit]
  mcpServers: []
  modelTier: claude_code
  enabledPluginIds: []
`;

test('horus-end-to-end AT#5: harness-authoring dialog writes .claude/harness.yaml and round-trips through parseHarnessYaml', async () => {
  const stub = stubDaemon();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // ----- Turn 1: operator says "set up the harness" -----
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
                  arguments: JSON.stringify({ project: 'sample-app' }),
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
          message: { role: 'assistant', content: 'Harness-author mode entered. Tell me when to begin.' },
          finish_reason: 'stop',
        },
      ],
    });

    const msg1 = makeFakeMessage('<@123> set up the harness for sample-app', 'C-author');
    await chatModule.handleChat(makeHorusAgent(), msg1 as any);
    assert.match(msg1.__captured.join('\n'), /Harness-author mode/);

    // ----- Turn 2: probe → propose → confirm -----
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'p', type: 'function', function: { name: 'probe_project', arguments: '{}' } },
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
                id: 'q',
                type: 'function',
                function: {
                  name: 'propose_harness',
                  arguments: JSON.stringify({ yaml: VALID_AUTHORED_HARNESS_YAML }),
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
              { id: 'r', type: 'function', function: { name: 'confirm_harness', arguments: '{}' } },
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
            content: 'Reply **yes** to write `.claude/harness.yaml`, **no** to revise.',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const msg2 = makeFakeMessage('<@123> go ahead', 'C-author');
    await chatModule.handleChat(makeHorusAgent(), msg2 as any);
    assert.match(msg2.__captured.join('\n'), /\*\*yes\*\*/);

    // ----- Turn 3: operator confirms with "yes" → write_harness_file -----
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'w', type: 'function', function: { name: 'write_harness_file', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'Wrote `.claude/harness.yaml`.' },
          finish_reason: 'stop',
        },
      ],
    });

    const msg3 = makeFakeMessage('<@123> yes', 'C-author');
    await chatModule.handleChat(makeHorusAgent(), msg3 as any);
    assert.match(msg3.__captured.join('\n'), /\.claude\/harness\.yaml/);

    // The mocked daemon must have received exactly one writeProjectFile call.
    assert.equal(
      stub.writeProjectFileCalls.length,
      1,
      `expected exactly one writeProjectFile call, got ${stub.writeProjectFileCalls.length}`,
    );
    const wrote = stub.writeProjectFileCalls[0]!;
    assert.equal(wrote.slug, 'sample-app');
    assert.equal(wrote.path, '.claude/harness.yaml');

    // The yaml round-trips cleanly (criterion 2 — same as harness-author.test).
    const parsed = harnessTypes.parseHarnessYaml(wrote.content);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.chatTier.skills, ['simplify']);
    assert.equal(parsed.orchestrationTier.modelTier, 'claude_code');
  } finally {
    stub.restore();
  }
});
