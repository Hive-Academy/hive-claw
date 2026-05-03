/**
 * llm-tool-call — pins the chatCompleteWithTools loop semantics.
 *
 * Mocks the LLM provider via undici.MockAgent so we can script
 * /chat/completions responses round by round. The endpoint URL is built
 * from `config.llm.ollamaBaseUrl` (default for the `ollama` provider) —
 * this test sets `OLLAMA_BASE_URL` before importing the module.
 *
 * Coverage:
 *  - two-round tool-call loop succeeds and returns final assistant text
 *  - malformed `tool_calls.arguments` JSON in round 1 is recovered with an
 *    error tool message, round 2 succeeds
 *  - maxDepth=2 with infinite-tool-call mock returns truncated:true
 *  - provider returns 503 → content:null and error populated
 */

process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { ToolDef, ToolCallContext } from '../src/llm.ts';

// Imported dynamically inside `before()` so the env vars set above land
// in `config.ts` before its module-level read.
let chatCompleteWithTools: typeof import('../src/llm.ts').chatCompleteWithTools;

before(async () => {
  ({ chatCompleteWithTools } = await import('../src/llm.ts'));
});

let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;

function makeCtx(): ToolCallContext {
  return {
    agentId: 'test',
    userId: 'u1',
    channelId: 'c1',
    state: new Map(),
    emit: () => {},
  };
}

function makeWeatherTool(): ToolDef {
  return {
    name: 'get_weather',
    description: 'Get weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    handler: async (args) => `weather for ${String(args.city)}: sunny, 72F`,
  };
}

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

test('llm-tool-call: two-round tool-call loop returns final assistant text', async () => {
  const pool = mockAgent.get('http://mock.openclaw.test');

  // Round 1 → assistant requests get_weather(city=London).
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
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"London"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

  // Round 2 → assistant returns a final answer.
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: "It's sunny in London (72F)." },
          finish_reason: 'stop',
        },
      ],
    });

  const result = await chatCompleteWithTools(
    'You are a helpful weather bot.',
    [{ role: 'user', content: "What's the weather in London?" }],
    [makeWeatherTool()],
    makeCtx(),
  );

  assert.equal(result.truncated, false);
  assert.equal(result.content, "It's sunny in London (72F).");
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]!.calls.length, 1);
  assert.equal(result.trace[0]!.calls[0]!.name, 'get_weather');
  assert.equal(result.trace[0]!.calls[0]!.ok, true);
});

test('llm-tool-call: malformed tool_calls.arguments JSON is recovered, loop continues', async () => {
  const pool = mockAgent.get('http://mock.openclaw.test');

  // Round 1 → bad JSON in arguments.
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
                id: 'call_bad',
                type: 'function',
                function: { name: 'get_weather', arguments: '{not-valid-json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

  // Round 2 → assistant recovers and returns a final answer.
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: "I couldn't parse arguments — please retry." },
          finish_reason: 'stop',
        },
      ],
    });

  const result = await chatCompleteWithTools(
    'You are a helpful weather bot.',
    [{ role: 'user', content: 'weather?' }],
    [makeWeatherTool()],
    makeCtx(),
  );

  assert.equal(result.truncated, false);
  assert.equal(result.content, "I couldn't parse arguments — please retry.");
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]!.calls[0]!.ok, false);
});

test('llm-tool-call: maxDepth=2 with infinite tool calls returns truncated:true', async () => {
  const pool = mockAgent.get('http://mock.openclaw.test');

  // Always reply with another tool call — the loop should hit the depth cap.
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'thinking…',
            tool_calls: [
              {
                id: 'call_loop',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"X"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    .persist();

  const result = await chatCompleteWithTools(
    'sys',
    [{ role: 'user', content: 'go' }],
    [makeWeatherTool()],
    makeCtx(),
    { maxDepth: 2 },
  );

  assert.equal(result.truncated, true);
  assert.equal(result.trace.length, 2);
  // We log "thinking…" each round as the assistant text; lastAssistantText
  // returns it as the truncation fallback.
  assert.equal(result.content, 'thinking…');
});

test('llm-tool-call: provider 503 returns content:null with error populated', async () => {
  const pool = mockAgent.get('http://mock.openclaw.test');

  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(503, 'service unavailable');

  const result = await chatCompleteWithTools(
    'sys',
    [{ role: 'user', content: 'go' }],
    [makeWeatherTool()],
    makeCtx(),
  );

  assert.equal(result.content, null);
  assert.equal(result.truncated, false);
  assert.match(result.error ?? '', /503/);
});
