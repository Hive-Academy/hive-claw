/**
 * discord-tools — TASK_2026_003 unit tests for the Discord-native chat
 * tools. Pins:
 *
 *   1. `read_channel_history`
 *      - happy path against a mocked discord.js channel
 *      - throws when ctx has no Discord side-channel
 *
 *   2. `upload_attachment`
 *      - source.type="url" SSRF rejection (loopback / private IPs / non-https)
 *      - source.type="path" rejection of `../../etc/passwd`-style traversal
 *      - source.type="path" rejection of `local-memory/agents/horus/persona.md`
 *      - source.type="data" base64 payload → mocked `channel.send` is called
 *      - oversize body cap is enforced
 *      - happy paths for all three source types (mocked discord.js + undici)
 *
 *   3. `listForAgent` opt-in:
 *      - empty `[]` when harness has no `chatTier.tools`
 *      - emits exactly the requested tools when set
 *      - logs a warning + drops unknown names
 */

process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
process.env.REDIS_URL = '';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { Buffer } from 'node:buffer';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

import type { ToolCallContext, ToolDef } from '../src/llm.ts';
import type { AgentDef } from '../src/agentRegistry.ts';
import type { HarnessConfig } from '../src/harness/types.ts';

let discordTools: typeof import('../src/tools/discordTools.ts');
let daemonClient: typeof import('../src/daemonClient.ts');

before(async () => {
  discordTools = await import('../src/tools/discordTools.ts');
  daemonClient = await import('../src/daemonClient.ts');
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

interface CapturedSend {
  content: string | undefined;
  files: Array<{ name: string; size: number }>;
}

interface FakeAttachment {
  url: string;
}

function makeFakeMessageWithCapture(): {
  message: any;
  sentRef: { last: CapturedSend | null };
  fetchedHistory: { args: { limit: number; before?: string } | null };
} {
  const sentRef: { last: CapturedSend | null } = { last: null };
  const fetchedHistory: { args: { limit: number; before?: string } | null } = { args: null };

  // Simulate a discord.js Collection (Map-like) of messages for messages.fetch.
  const mockMessages = new Map<string, any>();
  for (let i = 0; i < 3; i++) {
    const id = `M${i}`;
    mockMessages.set(id, {
      id,
      author: { id: 'U-author', username: 'tester', tag: 'tester#0001' },
      createdAt: new Date(Date.UTC(2026, 4, 3, 12, i, 0)),
      content: `message ${i}`,
      attachments: new Map<string, FakeAttachment>(),
    });
  }
  // One message has an attachment so we can assert attachmentUrls round-trips.
  mockMessages.get('M2')!.attachments.set('A1', { url: 'https://cdn.discord/test.png' });

  const channel = {
    id: 'C-test',
    name: 'general',
    sendTyping: async () => {},
    messages: {
      fetch: async (opts: { limit: number; before?: string }) => {
        fetchedHistory.args = opts;
        return mockMessages;
      },
    },
    send: async (payload: { content?: string; files?: Array<{ attachment: Buffer; name: string }> }) => {
      sentRef.last = {
        content: payload.content,
        files: (payload.files ?? []).map((f: any) => ({
          name: f.name ?? 'unknown',
          size: f.attachment instanceof Buffer ? f.attachment.byteLength : 0,
        })),
      };
      return {
        id: 'MSG_NEW',
        attachments: new Map([
          ['A_NEW', { url: 'https://cdn.discord/uploaded.bin' }],
        ]),
      };
    },
  };
  const message = {
    id: 'M-current',
    content: 'hi',
    author: { id: 'U-test', username: 'tester' },
    channel,
    client: {
      channels: {
        fetch: async (id: string) => {
          if (id === 'C-other') {
            return {
              ...channel,
              id: 'C-other',
              messages: {
                fetch: async () => new Map(),
              },
            };
          }
          throw new Error(`no such channel: ${id}`);
        },
      },
    },
  };
  return { message, sentRef, fetchedHistory };
}

function makeCtxWithMessage(message: any): ToolCallContext {
  return {
    agentId: 'horus',
    userId: 'U-test',
    channelId: 'C-test',
    state: new Map(),
    emit: () => {},
    discord: { message },
  };
}

function makeCtxNoDiscord(): ToolCallContext {
  return {
    agentId: 'horus',
    userId: 'U-test',
    channelId: 'C-test',
    state: new Map(),
    emit: () => {},
  };
}

function makeAgentWithTools(tools: string[]): AgentDef {
  const harness: HarnessConfig = {
    version: 1,
    chatTier: { skills: [], subagents: [], mcpServers: [], tools },
    orchestrationTier: { skills: [], subagents: [], mcpServers: [] },
  };
  return {
    id: 'horus',
    name: 'Horus',
    persona: 'guardian',
    identityMd: '# Horus',
    personaMd: '# secret persona',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake',
    harness,
  };
}

function getTool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`expected tool "${name}" in registry`);
  return t;
}

// ---------------------------------------------------------------------------
// (1) listForAgent opt-in semantics
// ---------------------------------------------------------------------------

test('discord-tools: agent without chatTier.tools returns empty registry', () => {
  const harness: HarnessConfig = {
    version: 1,
    chatTier: { skills: [], subagents: [], mcpServers: [] },
    orchestrationTier: { skills: [], subagents: [], mcpServers: [] },
  };
  const agent: AgentDef = {
    id: 'a',
    name: 'a',
    persona: 'p',
    personaMd: 'x',
    tokenEnvVar: 'T',
    token: null,
    harness,
  };
  assert.deepEqual(discordTools.listForAgent(agent), []);
});

test('discord-tools: agent with empty chatTier.tools returns empty registry', () => {
  const agent = makeAgentWithTools([]);
  assert.deepEqual(discordTools.listForAgent(agent), []);
});

test('discord-tools: agent with both tools listed gets both', () => {
  const agent = makeAgentWithTools(['read_channel_history', 'upload_attachment']);
  const tools = discordTools.listForAgent(agent);
  assert.equal(tools.length, 2);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['read_channel_history', 'upload_attachment'],
  );
});

test('discord-tools: unknown tool name is dropped (with a warning) and known names still emit', () => {
  const agent = makeAgentWithTools(['read_channel_history', 'definitely_not_a_tool']);
  const tools = discordTools.listForAgent(agent);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'read_channel_history');
});

// ---------------------------------------------------------------------------
// (2) read_channel_history happy path + ctx guard
// ---------------------------------------------------------------------------

test('discord-tools: read_channel_history returns slim message JSON', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'read_channel_history');
  const out = await tool.handler({ limit: 10 }, makeCtxWithMessage(message));
  const arr = JSON.parse(out) as Array<{
    id: string;
    authorId: string;
    content: string;
    attachmentUrls: string[];
  }>;
  assert.equal(arr.length, 3);
  // Sorted newest first.
  assert.equal(arr[0]!.id, 'M2');
  assert.deepEqual(arr[0]!.attachmentUrls, ['https://cdn.discord/test.png']);
  assert.equal(arr[1]!.id, 'M1');
  assert.equal(arr[2]!.id, 'M0');
});

test('discord-tools: read_channel_history caps limit at 100 and floors at 1', async () => {
  const { message, fetchedHistory } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'read_channel_history');
  await tool.handler({ limit: 999 }, makeCtxWithMessage(message));
  assert.equal(fetchedHistory.args!.limit, 100);
  await tool.handler({ limit: 0 }, makeCtxWithMessage(message));
  assert.equal(fetchedHistory.args!.limit, 1);
});

test('discord-tools: read_channel_history throws when ctx has no discord side-channel', async () => {
  const tool = getTool(discordTools.__listAllForTests(), 'read_channel_history');
  await assert.rejects(
    () => tool.handler({}, makeCtxNoDiscord()),
    /no Discord message in tool context/,
  );
});

// ---------------------------------------------------------------------------
// (3) upload_attachment SSRF guard
// ---------------------------------------------------------------------------

test('discord-tools: upload_attachment rejects http://127.0.0.1 (SSRF)', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  await assert.rejects(
    () =>
      tool.handler(
        { source: { type: 'url', url: 'http://127.0.0.1/leak' } },
        makeCtxWithMessage(message),
      ),
    /only https/i,
    'http should be refused before SSRF check (https-only policy)',
  );
});

test('discord-tools: upload_attachment rejects https://127.0.0.1 (SSRF)', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  await assert.rejects(
    () =>
      tool.handler(
        { source: { type: 'url', url: 'https://127.0.0.1/leak' } },
        makeCtxWithMessage(message),
      ),
    /private\/loopback/,
  );
});

test('discord-tools: upload_attachment rejects https://169.254.169.254 (cloud metadata)', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  await assert.rejects(
    () =>
      tool.handler(
        { source: { type: 'url', url: 'https://169.254.169.254/latest/meta-data/' } },
        makeCtxWithMessage(message),
      ),
    /private\/loopback/,
  );
});

test('discord-tools: upload_attachment rejects https://10.0.0.1 (RFC1918)', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  await assert.rejects(
    () =>
      tool.handler(
        { source: { type: 'url', url: 'https://10.0.0.1/x' } },
        makeCtxWithMessage(message),
      ),
    /private\/loopback/,
  );
});

test('discord-tools: assertPathInsideProject rejects ../../../etc/passwd', () => {
  const root = '/home/agent/projects/myproj';
  assert.throws(
    () => discordTools.__test_assertPathInsideProject(root, '../../../etc/passwd'),
    /escapes project root/,
  );
});

test('discord-tools: assertPathInsideProject rejects local-memory/agents/horus/persona.md', () => {
  const root = '/home/agent/projects/myproj';
  // Even if the file is *under* the project root, persona.md basename is
  // refused by the PRIVATE_AGENT_FILES gate. Here we additionally walk
  // through `local-memory/` which the forbidden-segment check catches first.
  assert.throws(
    () =>
      discordTools.__test_assertPathInsideProject(
        root,
        'local-memory/agents/horus/persona.md',
      ),
    /forbidden segment|private agent file/,
  );
});

test('discord-tools: assertPathInsideProject rejects PRIVATE_AGENT_FILES basename even under project', () => {
  const root = '/home/agent/projects/myproj';
  assert.throws(
    () => discordTools.__test_assertPathInsideProject(root, 'docs/persona.md'),
    /private agent file/,
  );
  assert.throws(
    () => discordTools.__test_assertPathInsideProject(root, 'subdir/secrets.json'),
    /private agent file/,
  );
});

test('discord-tools: assertPathInsideProject accepts a normal project file', () => {
  const root = '/home/agent/projects/myproj';
  const out = discordTools.__test_assertPathInsideProject(root, 'docs/README.md');
  assert.equal(out, '/home/agent/projects/myproj/docs/README.md');
});

test('discord-tools: assertPathInsideProject rejects sibling-prefix attack ("/projfoo" vs "/proj")', () => {
  // Without the trailing-separator guard, path.resolve("/proj", "../projfoo/x")
  // would yield "/projfoo/x" which startsWith("/proj"). The trailing-sep
  // check rejects this — that's the test's reason to exist.
  assert.throws(
    () => discordTools.__test_assertPathInsideProject('/proj', '../projfoo/x'),
    /escapes project root/,
  );
});

// ---------------------------------------------------------------------------
// (4) upload_attachment data source happy path
// ---------------------------------------------------------------------------

test('discord-tools: upload_attachment data source posts to the channel and returns the new message id', async () => {
  const { message, sentRef } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  const payload = Buffer.from('hello world').toString('base64');
  const out = await tool.handler(
    {
      source: {
        type: 'data',
        base64: payload,
        filename: 'hello.txt',
        mimeType: 'text/plain',
      },
      caption: 'a greeting',
    },
    makeCtxWithMessage(message),
  );
  const parsed = JSON.parse(out) as { ok: boolean; messageId: string; attachmentUrl: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.messageId, 'MSG_NEW');
  assert.equal(parsed.attachmentUrl, 'https://cdn.discord/uploaded.bin');
  assert.ok(sentRef.last, 'channel.send must have been called');
  assert.equal(sentRef.last!.content, 'a greeting');
  assert.equal(sentRef.last!.files.length, 1);
  assert.equal(sentRef.last!.files[0]!.name, 'hello.txt');
  assert.equal(sentRef.last!.files[0]!.size, Buffer.from('hello world').byteLength);
});

test('discord-tools: upload_attachment data source rejects oversize base64 payload', async () => {
  // Set the cap low for this one test.
  const orig = process.env.OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB;
  process.env.OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB = '0.000001'; // 1 byte
  try {
    const { message } = makeFakeMessageWithCapture();
    const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
    const payload = Buffer.from('hello world this is many bytes').toString('base64');
    await assert.rejects(
      () =>
        tool.handler(
          {
            source: {
              type: 'data',
              base64: payload,
              filename: 'big.txt',
              mimeType: 'text/plain',
            },
          },
          makeCtxWithMessage(message),
        ),
      /exceeds|cap/i,
    );
  } finally {
    if (orig === undefined) delete process.env.OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB;
    else process.env.OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB = orig;
  }
});

test('discord-tools: upload_attachment data source rejects bad filename via safeFile', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  const payload = Buffer.from('x').toString('base64');
  await assert.rejects(
    () =>
      tool.handler(
        {
          source: {
            type: 'data',
            base64: payload,
            filename: '../escape.txt',
            mimeType: 'text/plain',
          },
        },
        makeCtxWithMessage(message),
      ),
    /safeFile|allow-list/,
  );
});

// ---------------------------------------------------------------------------
// (5) upload_attachment path source — happy path + private-file rejection
//
// We stub `daemon.listProjects` to return a controlled project root in a
// real tempdir so the FS read works without touching the actual repo.
// ---------------------------------------------------------------------------

test('discord-tools: upload_attachment path source reads file under project root and posts it', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dt-path-ok-'));
  try {
    const projDir = path.join(tmp, 'proj');
    await fsp.mkdir(projDir, { recursive: true });
    const targetPath = path.join(projDir, 'docs', 'hello.md');
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, '# hi from path mode\n', 'utf8');

    const orig = (daemonClient.daemon as any).listProjects;
    (daemonClient.daemon as any).listProjects = async () => [
      { slug: 'myproj', path: projDir, openTaskCount: 0, taskCount: 0 },
    ];
    try {
      const { message, sentRef } = makeFakeMessageWithCapture();
      const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
      const out = await tool.handler(
        {
          source: { type: 'path', path: 'docs/hello.md' },
          project: 'myproj',
        },
        makeCtxWithMessage(message),
      );
      const parsed = JSON.parse(out) as { ok: boolean };
      assert.equal(parsed.ok, true);
      assert.ok(sentRef.last, 'channel.send must have been called');
      assert.equal(sentRef.last!.files[0]!.name, 'hello.md');
    } finally {
      (daemonClient.daemon as any).listProjects = orig;
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('discord-tools: upload_attachment path source rejects local-memory traversal even when listProjects returns a root', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dt-path-deny-'));
  try {
    const projDir = path.join(tmp, 'proj');
    await fsp.mkdir(path.join(projDir, 'local-memory', 'agents', 'horus'), { recursive: true });
    await fsp.writeFile(
      path.join(projDir, 'local-memory', 'agents', 'horus', 'persona.md'),
      'secret\n',
      'utf8',
    );
    const orig = (daemonClient.daemon as any).listProjects;
    (daemonClient.daemon as any).listProjects = async () => [
      { slug: 'myproj', path: projDir, openTaskCount: 0, taskCount: 0 },
    ];
    try {
      const { message } = makeFakeMessageWithCapture();
      const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
      await assert.rejects(
        () =>
          tool.handler(
            {
              source: { type: 'path', path: 'local-memory/agents/horus/persona.md' },
              project: 'myproj',
            },
            makeCtxWithMessage(message),
          ),
        /forbidden segment|private agent file/,
      );
    } finally {
      (daemonClient.daemon as any).listProjects = orig;
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('discord-tools: upload_attachment path source requires the "project" argument', async () => {
  const { message } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  await assert.rejects(
    () =>
      tool.handler(
        { source: { type: 'path', path: 'docs/x.md' } },
        makeCtxWithMessage(message),
      ),
    /requires the "project" argument/,
  );
});

// ---------------------------------------------------------------------------
// (6) upload_attachment url source happy path (mocked undici)
// ---------------------------------------------------------------------------

test('discord-tools: upload_attachment url source fetches and posts to the channel', async () => {
  // Mock the upstream fetch through undici. Use a public-looking IP literal
  // to bypass the SSRF guard without doing real DNS — `8.8.8.8` is in a
  // public range.
  const pool = mockAgent.get('https://8.8.8.8');
  pool
    .intercept({ path: '/some.png', method: 'GET' })
    .reply(200, Buffer.from('PNGDATA'), {
      headers: { 'content-type': 'image/png' },
    });

  const { message, sentRef } = makeFakeMessageWithCapture();
  const tool = getTool(discordTools.__listAllForTests(), 'upload_attachment');
  const out = await tool.handler(
    { source: { type: 'url', url: 'https://8.8.8.8/some.png' }, caption: 'cat' },
    makeCtxWithMessage(message),
  );
  const parsed = JSON.parse(out) as { ok: boolean; messageId: string };
  assert.equal(parsed.ok, true);
  assert.ok(sentRef.last, 'channel.send must have been called');
  assert.equal(sentRef.last!.files[0]!.name, 'some.png');
  assert.equal(sentRef.last!.files[0]!.size, Buffer.from('PNGDATA').byteLength);
  assert.equal(sentRef.last!.content, 'cat');
});
