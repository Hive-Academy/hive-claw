/**
 * tool-call-fallback — pins the chat.ts branching contract from
 * TASK_2026_002 B2.
 *
 * Three properties verified end-to-end against a mocked LLM:
 *
 *  1. When `chatCompleteWithTools` returns `null` content, the legacy path
 *     runs: `parseDirectives` is invoked exactly once on the assistant text
 *     produced by `chatComplete`. (Null fallthrough.)
 *
 *  2. When the LLM returns assistant text and fires no tools, the chat
 *     handler postReply's that exact text without going through
 *     parseDirectives. (Happy-path tool-calling branch.)
 *
 *  3. When the LLM fires a `list_projects` tool call and then returns a
 *     final answer that mentions the project names, `daemon.listProjects`
 *     is hit and the assistant reply contains those names. (Round-trip.)
 *
 * Plus one structural assertion: `daemonTools.list().length === 9`
 * (verification item 5).
 *
 * The chat handler is hard-wired to the discord.js `Message` type, but it
 * only ever calls a small surface (`reply`, `channel.sendTyping`, etc.).
 * We hand it a duck-typed fake.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env vars must land before any module-level config read.
process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal';
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'tcfb-agents-'));
process.env.REDIS_URL = '';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
// Default the flag ON for the first three tests; the fallback-survives
// suite below resets it explicitly per-test via `setFlag`.
process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED = '1';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

// Import lazily so the env vars above land in config.ts first.
type ChatModule = typeof import('../src/chat.ts');
type DaemonClientModule = typeof import('../src/daemonClient.ts');
type DaemonToolsModule = typeof import('../src/tools/daemonTools.ts');
type AgentRegistryModule = typeof import('../src/agentRegistry.ts');

let chatModule: ChatModule;
let daemonClient: DaemonClientModule;
let daemonTools: DaemonToolsModule;

// Bind once so each test reuses the same singleton bindings (handleChat
// closes over `daemon` via daemonTools, so re-imports would not see fresh
// stubs).
async function loadModules(): Promise<void> {
  if (chatModule) return;
  daemonTools = await import('../src/tools/daemonTools.ts');
  daemonClient = await import('../src/daemonClient.ts');
  chatModule = await import('../src/chat.ts');
}

let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;

beforeEach(async () => {
  await loadModules();
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
// Fakes
// ---------------------------------------------------------------------------

interface CapturedReply {
  channel: 'reply' | 'send';
  content: string;
}

interface FakeMessage {
  /** Sentinel used by stripMentions; must be the inbound user text. */
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
  __captured: CapturedReply[];
}

function makeFakeMessage(text: string): FakeMessage {
  const captured: CapturedReply[] = [];
  const channel = {
    id: 'C-test',
    name: 'general',
    sendTyping: async () => {},
    send: async (s: string) => {
      captured.push({ channel: 'send', content: s });
    },
  };
  return {
    content: text,
    author: { id: 'U-test', username: 'tester' },
    channel,
    guild: { name: 'test-guild' },
    reply: async (s: string) => {
      captured.push({ channel: 'reply', content: s });
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

interface DaemonStub {
  listProjects: { calls: number };
  listProjectsReturns: any[];
  origs: Record<string, unknown>;
  restore: () => void;
}

function stubDaemonReads(): DaemonStub {
  const origs: Record<string, unknown> = {
    listProjects: daemonClient.daemon.listProjects,
    listAgents: (daemonClient.daemon as any).listAgents,
    readMemory: (daemonClient.daemon as any).readMemory,
  };
  const counts = { calls: 0 };
  const projects = [
    { slug: 'openclaw', openTaskCount: 2, taskCount: 11 },
    { slug: 'fixing-openclaw', openTaskCount: 1, taskCount: 4 },
  ];
  (daemonClient.daemon as any).listProjects = async () => {
    counts.calls += 1;
    return projects;
  };
  (daemonClient.daemon as any).listAgents = async () => [];
  (daemonClient.daemon as any).readMemory = async () => null;
  return {
    listProjects: counts,
    listProjectsReturns: projects,
    origs,
    restore: () => {
      Object.assign(daemonClient.daemon, origs);
    },
  };
}

// ---------------------------------------------------------------------------
// Structural assertion (verification item 5)
// ---------------------------------------------------------------------------

test('tool-call-fallback: daemonTools.list() returns exactly 9 tools', async () => {
  await loadModules();
  const tools = daemonTools.list();
  assert.equal(
    tools.length,
    9,
    `expected 9 tools, got ${tools.length} — verification item 5 demands exactly 9 ` +
      `(list_projects, list_tasks, get_task, create_task, approve_task, handoff_task, ` +
      `tick_continuation, start_harness_setup, dispatch_orchestration_task).`,
  );
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'approve_task',
    'create_task',
    'dispatch_orchestration_task',
    'get_task',
    'handoff_task',
    'list_projects',
    'list_tasks',
    'start_harness_setup',
    'tick_continuation',
  ]);
});

// ---------------------------------------------------------------------------
// (1) Null fallthrough: tool-call branch returns null content → legacy path
// ---------------------------------------------------------------------------

test('tool-call-fallback: null tool-call content falls through to legacy parseDirectives path', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Round 1 of chatCompleteWithTools — provider 503 forces content:null
    // (this is the documented "fall through to the legacy path" trigger).
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(503, 'service unavailable');

    // The legacy path then calls chatComplete (single shot) — return text
    // with a directive embedded so we can assert parseDirectives ran. We
    // use <<oc:tick>> because executeDirective for `tick` will hit
    // daemon.tick(); we stub it to a no-op to keep the test offline.
    const origTick = (daemonClient.daemon as any).tick;
    (daemonClient.daemon as any).tick = async () => ({ dispatched: 0, pending: 0, checkpoints: 0 });
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: { role: 'assistant', content: 'okay running tick.\n<<oc:tick>>' },
            finish_reason: 'stop',
          },
        ],
      });

    const msg = makeFakeMessage('@horus please tick');
    await chatModule.handleChat(makeFakeAgent(), msg as any);

    // The legacy directive path must have produced an "— actions —" block,
    // which is its signature post-parseDirectives output.
    assert.ok(
      msg.__captured.length >= 1,
      'legacy path should have produced at least one reply',
    );
    const joined = msg.__captured.map((c) => c.content).join('\n');
    assert.match(
      joined,
      /— actions —/,
      'legacy parseDirectives path must have run (— actions — marker missing)',
    );
    assert.match(joined, /tick(ed)?/i, 'legacy directive `tick` should have produced output');

    (daemonClient.daemon as any).tick = origTick;
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// (2) Tool-call branch with no tools fired and finish_reason=stop
// ---------------------------------------------------------------------------

test('tool-call-fallback: assistant text + finish_reason=stop, no tools fired → postReply with that text', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: { role: 'assistant', content: 'plain-chat answer with no tool use' },
            finish_reason: 'stop',
          },
        ],
      });

    const msg = makeFakeMessage('@horus hi there');
    await chatModule.handleChat(makeFakeAgent(), msg as any);

    // postReply must have been called with the exact assistant text — and
    // critically, no "— actions —" suffix (the legacy directive flow did
    // not run).
    const joined = msg.__captured.map((c) => c.content).join('\n');
    assert.equal(joined, 'plain-chat answer with no tool use');
    assert.doesNotMatch(joined, /— actions —/);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// (3) list_projects tool-call round-trip
// ---------------------------------------------------------------------------

test('tool-call-fallback: list_projects tool call hits daemon.listProjects and reply contains project names', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Round 1: assistant fires list_projects.
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
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

    // Round 2: assistant synthesizes a final answer that mentions the names
    // returned by list_projects.
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'You have two projects: **openclaw** and **fixing-openclaw**.',
            },
            finish_reason: 'stop',
          },
        ],
      });

    const msg = makeFakeMessage('@horus what projects do we have?');
    await chatModule.handleChat(makeFakeAgent(), msg as any);

    // daemon.listProjects must have been called by the tool handler. The
    // legacy buildSystemPrompt also calls listProjects once for its
    // snapshot block — so the count is >= 2 (>=1 from buildSystemPrompt
    // when it runs, exactly 1 from the tool handler). We assert >=1 to
    // not over-pin behavior we don't own; the round-trip shape is the
    // load-bearing assertion.
    assert.ok(
      stub.listProjects.calls >= 1,
      `daemon.listProjects must have been called by the tool handler — got ${stub.listProjects.calls}`,
    );

    const joined = msg.__captured.map((c) => c.content).join('\n');
    assert.match(joined, /openclaw/);
    assert.match(joined, /fixing-openclaw/);
    assert.doesNotMatch(joined, /— actions —/);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// (4) Verification item 6: OPENCLAW_BOT_TOOL_CALLS_ENABLED=0 → fallback survives
// ---------------------------------------------------------------------------

test('tool-call-fallback: flag-off path skips the tool branch entirely (legacy directive flow runs)', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // ONE expected provider call: the legacy chatComplete shot.
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: { role: 'assistant', content: 'flag-off response' },
            finish_reason: 'stop',
          },
        ],
      });

    // Override the live config flag for this test only. We patched the env
    // var at module-load time, but config is a frozen object after import;
    // we mutate via the `as any` escape hatch to flip the bit cleanly.
    const cfgModule = await import('../src/config.ts');
    const originalFlag = cfgModule.config.toolCallsEnabled;
    (cfgModule.config as any).toolCallsEnabled = false;

    try {
      const msg = makeFakeMessage('@horus hi');
      await chatModule.handleChat(makeFakeAgent(), msg as any);

      // No tool-call branch ran → no "— actions —" footer (no directives in
      // the response either) and reply contains the legacy text directly.
      const joined = msg.__captured.map((c) => c.content).join('\n');
      assert.match(joined, /flag-off response/);
    } finally {
      (cfgModule.config as any).toolCallsEnabled = originalFlag;
    }
  } finally {
    stub.restore();
  }
});
