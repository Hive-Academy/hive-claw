/**
 * discord-tools integration — TASK_2026_003.
 *
 * Drives a mocked LLM emitting a tool_call for each new tool and asserts the
 * discord.js mock was called with the expected payload. Two cases:
 *
 *   1. `read_channel_history` — the LLM fires the tool, we then return a
 *      final assistant message; we assert `messages.fetch` was called and
 *      the assistant text contains the messages summary.
 *
 *   2. `upload_attachment` (data source) — the LLM fires the tool, we
 *      assert `channel.send` was called with the expected attachment buffer.
 *
 * Mirrors the harness used by `tool-call-fallback.test.ts` (the canonical
 * pattern for end-to-end chat assertions in this package).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal';
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'dt-int-agents-'));
process.env.REDIS_URL = '';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED = '1';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

type ChatModule = typeof import('../../src/chat.ts');
type DaemonClientModule = typeof import('../../src/daemonClient.ts');
type AgentRegistryModule = typeof import('../../src/agentRegistry.ts');
type HarnessTypesModule = typeof import('../../src/harness/types.ts');

let chatModule: ChatModule;
let daemonClient: DaemonClientModule;
let harnessTypes: HarnessTypesModule;

async function loadModules(): Promise<void> {
  if (chatModule) return;
  chatModule = await import('../../src/chat.ts');
  daemonClient = await import('../../src/daemonClient.ts');
  harnessTypes = await import('../../src/harness/types.ts');
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

interface CapturedSend {
  content?: string;
  files: Array<{ name: string; size: number }>;
}

function makeFakeAgent(): AgentRegistryModule['AgentDef'] {
  // harnessTypes is loaded by the time tests run.
  const yaml = `
version: 1
chatTier:
  skills: []
  subagents: []
  mcpServers: []
  tools:
    - read_channel_history
    - upload_attachment
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  const harness = harnessTypes.parseHarnessYaml(yaml);
  return {
    id: 'horus',
    name: 'Horus',
    persona: 'guardian',
    identityMd: '# Horus identity (TEST)',
    personaMd: '# Horus persona — TEST FIXTURE (private)',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake',
    harness,
    harnessVersion: 'test',
  } as unknown as AgentRegistryModule['AgentDef'];
}

interface FakeMessage {
  content: string;
  author: { id: string; username: string };
  channel: any;
  guild: { name: string } | null;
  reply: (s: string) => Promise<void>;
  client: any;
  __captured: string[];
  __sent: { last: CapturedSend | null };
  __fetchedHistory: { args: any | null };
}

function makeFakeMessage(text: string): FakeMessage {
  const captured: string[] = [];
  const sent: { last: CapturedSend | null } = { last: null };
  const fetchedHistory: { args: any | null } = { args: null };

  const mockMessages = new Map<string, any>();
  for (let i = 0; i < 2; i++) {
    const id = `H${i}`;
    mockMessages.set(id, {
      id,
      author: { id: 'U-author', username: 'someone', tag: 'someone#0001' },
      createdAt: new Date(Date.UTC(2026, 4, 3, 12, i, 0)),
      content: `historic ${i}`,
      attachments: new Map(),
    });
  }

  const channel: any = {
    id: 'C-int',
    name: 'general',
    sendTyping: async () => {},
    messages: {
      fetch: async (args: any) => {
        fetchedHistory.args = args;
        return mockMessages;
      },
    },
    send: async (payload: any) => {
      const files = (payload.files ?? []).map((f: any) => ({
        name: f.name ?? 'unknown',
        size: f.attachment instanceof Buffer ? f.attachment.byteLength : 0,
      }));
      sent.last = { content: payload.content, files };
      captured.push(`[upload] ${files.map((f: any) => f.name).join(',')} :: ${payload.content ?? ''}`);
      return {
        id: 'MSG_INT',
        attachments: new Map([['A', { url: 'https://cdn.discord/int.bin' }]]),
      };
    },
  };
  const message: FakeMessage = {
    content: text,
    author: { id: 'U-int', username: 'tester' },
    channel,
    guild: { name: 'test-guild' },
    reply: async (s: string) => {
      captured.push(s);
    },
    client: {
      channels: {
        fetch: async () => {
          throw new Error('only current channel in this test');
        },
      },
    },
    __captured: captured,
    __sent: sent,
    __fetchedHistory: fetchedHistory,
  };
  return message;
}

function stubDaemonReads(): { restore: () => void } {
  const origs = {
    listProjects: (daemonClient.daemon as any).listProjects,
    listAgents: (daemonClient.daemon as any).listAgents,
    readMemory: (daemonClient.daemon as any).readMemory,
  };
  (daemonClient.daemon as any).listProjects = async () => [];
  (daemonClient.daemon as any).listAgents = async () => [];
  (daemonClient.daemon as any).readMemory = async () => null;
  return {
    restore: () => {
      Object.assign(daemonClient.daemon, origs);
    },
  };
}

// ---------------------------------------------------------------------------
// (1) read_channel_history end-to-end
// ---------------------------------------------------------------------------

test('integration: LLM fires read_channel_history → messages.fetch is called and assistant text mentions the history', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    // Round 1: assistant fires read_channel_history.
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
                  id: 'call_rch',
                  type: 'function',
                  function: {
                    name: 'read_channel_history',
                    arguments: '{"limit":5}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

    // Round 2: assistant synthesizes a final reply.
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'I see two recent messages: historic 0 and historic 1.',
            },
            finish_reason: 'stop',
          },
        ],
      });

    const msg = makeFakeMessage('@horus what was just said?');
    await chatModule.handleChat(makeFakeAgent(), msg as any);

    assert.deepEqual(msg.__fetchedHistory.args, { limit: 5 }, 'messages.fetch must have been called with limit:5');
    const joined = msg.__captured.join('\n');
    assert.match(joined, /historic 0|historic 1|two recent messages/);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// (2) upload_attachment (data source) end-to-end
// ---------------------------------------------------------------------------

test('integration: LLM fires upload_attachment(data) → channel.send is called with the buffer', async () => {
  const stub = stubDaemonReads();
  try {
    const pool = mockAgent.get('http://mock.openclaw.test');

    const payload = Buffer.from('integration-test-bytes');
    const b64 = payload.toString('base64');

    // Round 1: assistant fires upload_attachment.
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
                  id: 'call_up',
                  type: 'function',
                  function: {
                    name: 'upload_attachment',
                    arguments: JSON.stringify({
                      source: {
                        type: 'data',
                        base64: b64,
                        filename: 'test.txt',
                        mimeType: 'text/plain',
                      },
                      caption: 'here you go',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

    // Round 2: assistant confirms.
    pool
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          {
            message: { role: 'assistant', content: 'Uploaded.' },
            finish_reason: 'stop',
          },
        ],
      });

    const msg = makeFakeMessage('@horus please send the file');
    await chatModule.handleChat(makeFakeAgent(), msg as any);

    assert.ok(msg.__sent.last, 'channel.send must have been called');
    assert.equal(msg.__sent.last!.content, 'here you go');
    assert.equal(msg.__sent.last!.files.length, 1);
    assert.equal(msg.__sent.last!.files[0]!.name, 'test.txt');
    assert.equal(msg.__sent.last!.files[0]!.size, payload.byteLength);
  } finally {
    stub.restore();
  }
});
