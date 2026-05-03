/**
 * subagent-runner — pins TASK_2026_002 B5 sub-task 1-4 contracts.
 *
 * Verification covers (tasks.md:219):
 *
 *   1. System-prompt composition: parent name in header, subagent.name + body
 *      present, `[CALLER CONTEXT]` block present with the user prompt, and —
 *      most importantly — `personaMd` is NEVER referenced in the assembled
 *      sub-chat prompt. (Verifier also greps the runner source separately.)
 *   2. Tool-subset filter: subagent.tools intersected with parent registry,
 *      missing names skipped silently, empty/missing → zero tools.
 *   3. Depth increment: `parentCtx.state.subagentDepth` 0 → 1 in the child
 *      context observed by the LLM mock.
 *   4. Depth limit: at `subagentDepthLimit + 1`, run() throws.
 *   5. Recursion: depth N (N < limit) is allowed; depth = limit + 1 throws.
 *   6. Observability: parentCtx.emit fires `invoker.subagent_started` and
 *      `invoker.subagent_finished` exactly once per call.
 *
 * The LLM is mocked via undici.MockAgent so the real `chatCompleteWithTools`
 * loop drives end-to-end. We assert against the dispatched HTTP request body
 * to catch the system prompt and tool count.
 */

process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
process.env.OLLAMA_BASE_URL = 'http://mock.openclaw.test/v1';
process.env.LLM_PROVIDER = 'ollama';
process.env.LLM_MODEL = 'kimi-k2.6:cloud';
process.env.OPENCLAW_SUBAGENT_DEPTH_LIMIT = '2';
process.env.REDIS_URL = '';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { ToolDef, ToolCallContext } from '../src/llm.ts';
import type { AgentDef } from '../src/agentRegistry.ts';
import type { HarnessConfig, SubagentDef } from '../src/harness/types.ts';

let subagentRunner: typeof import('../src/subagents/subagentRunner.ts');

before(async () => {
  subagentRunner = await import('../src/subagents/subagentRunner.ts');
});

let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;
let warns: string[];
let origWarn: typeof console.warn;

beforeEach(() => {
  savedDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  warns = [];
  origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(savedDispatcher);
  console.warn = origWarn;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubagent(overrides: Partial<SubagentDef> = {}): SubagentDef {
  return {
    name: 'pr_diff_triage',
    description: 'Reviews a PR diff for security smells.',
    systemPrompt: 'You are a security-focused PR reviewer. Be terse.',
    ...overrides,
  };
}

function makeAgent(subs: SubagentDef[]): AgentDef {
  const harness: HarnessConfig = {
    version: 1,
    chatTier: { skills: [], subagents: subs, mcpServers: [] },
    orchestrationTier: { skills: [], subagents: [], mcpServers: [] },
  };
  return {
    id: 'horus',
    name: 'Horus',
    persona: 'orchestrator',
    identityMd: '# Horus identity',
    // Persona body present on the parent — but the runner MUST NOT propagate
    // it into the sub-chat. The compose-prompt assertion below is the proof.
    personaMd: '# SECRET PARENT PERSONA — must not appear in subagent prompt',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake',
    harness,
  };
}

function makeParentRegistry(): ToolDef[] {
  return [
    {
      name: 'list_projects',
      description: 'List projects.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => 'stub list_projects',
    },
    {
      name: 'get_task',
      description: 'Fetch a task.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => 'stub get_task',
    },
    {
      name: 'create_task',
      description: 'Make a task.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => 'stub create_task',
    },
  ];
}

interface CapturedEmission {
  event: string;
  data: unknown;
}

function makeParentCtx(opts: {
  parentRegistry?: ToolDef[];
  depth?: number;
  emissions?: CapturedEmission[];
} = {}): ToolCallContext {
  const state = new Map<string, unknown>();
  if (opts.parentRegistry) {
    state.set(subagentRunner.PARENT_TOOL_REGISTRY_STATE_KEY, opts.parentRegistry);
  }
  if (opts.depth !== undefined) {
    state.set(subagentRunner.SUBAGENT_DEPTH_STATE_KEY, opts.depth);
  }
  return {
    agentId: 'horus',
    userId: 'U-test',
    channelId: 'C-test',
    state,
    emit: (event, data) => {
      opts.emissions?.push({ event, data });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. System-prompt composition (no personaMd leak)
// ---------------------------------------------------------------------------

test('subagent-runner: composeSubagentSystemPrompt assembles in the impl-plan order and excludes parent personaMd', () => {
  const sub = makeSubagent({
    name: 'pr_diff_triage',
    systemPrompt: 'SUBAGENT BODY: triage PRs for risk smells.',
  });
  const agent = makeAgent([sub]);
  const prompt = 'review #2026 for auth issues';

  const composed = subagentRunner.composeSubagentSystemPrompt(agent, sub, prompt);

  assert.match(
    composed,
    /^You are pr_diff_triage \(a subagent of Horus\)\./,
    'header must name subagent + parent',
  );
  assert.match(composed, /SUBAGENT BODY: triage PRs for risk smells\./, 'must inline subagent body');
  assert.match(composed, /\[CALLER CONTEXT\]/, 'caller-context block must be present');
  assert.match(composed, /Parent agent: Horus/, 'caller-context names parent');
  assert.match(composed, /Original user message: review #2026 for auth issues/, 'caller-context names prompt');

  // Hard rule from impl-plan line 930: parent personaMd MUST NOT appear in
  // the sub-chat system prompt. Verifier #5 also greps the source file for
  // the literal token; this test pins the runtime composition behavior.
  assert.doesNotMatch(
    composed,
    /SECRET PARENT PERSONA/,
    'parent personaMd content must NEVER leak into the sub-chat system prompt',
  );
});

// ---------------------------------------------------------------------------
// 2. Tool-subset filter (intersection + silent skip)
// ---------------------------------------------------------------------------

test('subagent-runner: filterParentToolsForSubagent intersects with parent registry, skips missing, empty list yields zero', () => {
  const parentRegistry = makeParentRegistry();

  // Empty/missing tools → zero
  assert.deepEqual(
    subagentRunner.filterParentToolsForSubagent(makeSubagent({ tools: [] }), parentRegistry).map((t) => t.name),
    [],
    'empty tools array → zero tools (read-only reasoning subagent)',
  );
  assert.deepEqual(
    subagentRunner.filterParentToolsForSubagent(makeSubagent({ tools: undefined }), parentRegistry).map((t) => t.name),
    [],
    'missing tools field → zero tools',
  );

  // Names present → intersect, preserving subagent declaration order
  const filtered = subagentRunner.filterParentToolsForSubagent(
    makeSubagent({ tools: ['get_task', 'list_projects'] }),
    parentRegistry,
  );
  assert.deepEqual(
    filtered.map((t) => t.name),
    ['get_task', 'list_projects'],
    'must preserve subagent declaration order',
  );

  // Missing names → skip silently with warn
  const filtered2 = subagentRunner.filterParentToolsForSubagent(
    makeSubagent({ tools: ['list_projects', 'nonexistent_tool', 'get_task'] }),
    parentRegistry,
  );
  assert.deepEqual(
    filtered2.map((t) => t.name),
    ['list_projects', 'get_task'],
    'unknown tool names must be silently skipped',
  );
  assert.ok(
    warns.some((w) => w.includes('nonexistent_tool')),
    'skipped tool must produce a warning naming the tool',
  );
});

// ---------------------------------------------------------------------------
// 3. Depth increment + 4. Depth limit throws
// ---------------------------------------------------------------------------

test('subagent-runner: depth increments from 0 → 1 inside the child context (mocked LLM round-trip)', async () => {
  const sub = makeSubagent({ tools: [] });
  const agent = makeAgent([sub]);

  const pool = mockAgent.get('http://mock.openclaw.test');
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'subagent says: done' },
          finish_reason: 'stop',
        },
      ],
    });

  const emissions: CapturedEmission[] = [];
  const parentCtx = makeParentCtx({ parentRegistry: makeParentRegistry(), emissions });

  const result = await subagentRunner.run({
    agent,
    subagentName: 'pr_diff_triage',
    prompt: 'do the thing',
    parentCtx,
  });

  assert.equal(result.reply, 'subagent says: done', 'reply must surface from the mocked LLM');
  assert.equal(result.truncated, false);
  assert.equal(result.name, 'pr_diff_triage');

  // The parent's depth is unchanged — the increment lives on the CHILD ctx.
  // Per the runner contract, the child's state is a clone with depth bumped;
  // the parent state.subagentDepth is whatever it was (undefined here).
  assert.equal(
    parentCtx.state.get(subagentRunner.SUBAGENT_DEPTH_STATE_KEY),
    undefined,
    'parent state.subagentDepth must be untouched (child gets a clone)',
  );

  // Observability events fired
  const startedEvents = emissions.filter((e) => e.event === 'invoker.subagent_started');
  const finishedEvents = emissions.filter((e) => e.event === 'invoker.subagent_finished');
  assert.equal(startedEvents.length, 1, 'invoker.subagent_started fires exactly once');
  assert.equal(finishedEvents.length, 1, 'invoker.subagent_finished fires exactly once');
  assert.equal((startedEvents[0].data as any).depth, 1, 'started event has depth=1');
  assert.equal((finishedEvents[0].data as any).depth, 1, 'finished event has depth=1');
});

test('subagent-runner: throws when bumped depth exceeds OPENCLAW_SUBAGENT_DEPTH_LIMIT', async () => {
  const sub = makeSubagent();
  const agent = makeAgent([sub]);

  // Limit is 2 (env var pinned at top of file). Pre-seed depth=2 → bumped 3 > limit.
  const parentCtx = makeParentCtx({
    parentRegistry: makeParentRegistry(),
    depth: 2,
  });

  await assert.rejects(
    () =>
      subagentRunner.run({
        agent,
        subagentName: 'pr_diff_triage',
        prompt: 'recurse forever',
        parentCtx,
      }),
    /Subagent recursion limit reached/,
    'must throw the documented "limit reached" error message',
  );
});

// ---------------------------------------------------------------------------
// 5. Recursion: allowed up to limit, rejected at limit + 1
// ---------------------------------------------------------------------------

test('subagent-runner: depth=limit-1 is allowed (bumped to limit), depth=limit is rejected (bumped past limit)', async () => {
  const sub = makeSubagent({ tools: [] });
  const agent = makeAgent([sub]);

  // Allowed: parent depth=1, bumped to 2 (== limit, NOT > limit).
  const pool = mockAgent.get('http://mock.openclaw.test');
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'depth-2 reply' },
          finish_reason: 'stop',
        },
      ],
    });

  const allowedCtx = makeParentCtx({
    parentRegistry: makeParentRegistry(),
    depth: 1,
  });
  const allowedResult = await subagentRunner.run({
    agent,
    subagentName: 'pr_diff_triage',
    prompt: 'one level deep',
    parentCtx: allowedCtx,
  });
  assert.equal(allowedResult.reply, 'depth-2 reply', 'depth=limit must be allowed');

  // Rejected: parent depth=2 (== limit), bumped to 3 (> limit).
  const rejectedCtx = makeParentCtx({
    parentRegistry: makeParentRegistry(),
    depth: 2,
  });
  await assert.rejects(
    () =>
      subagentRunner.run({
        agent,
        subagentName: 'pr_diff_triage',
        prompt: 'too deep',
        parentCtx: rejectedCtx,
      }),
    /Subagent recursion limit reached \(depth=3, limit=2\)/,
    'depth=limit+1 must throw with the structured message',
  );
});

// ---------------------------------------------------------------------------
// 6. Unknown subagent name surfaces a structured error
// ---------------------------------------------------------------------------

test('subagent-runner: unknown subagent name throws with the available-names hint', async () => {
  const agent = makeAgent([makeSubagent({ name: 'pr_diff_triage' })]);
  const parentCtx = makeParentCtx({ parentRegistry: makeParentRegistry() });

  await assert.rejects(
    () =>
      subagentRunner.run({
        agent,
        subagentName: 'security_review',
        prompt: 'find bugs',
        parentCtx,
      }),
    /subagent "security_review" not declared on agent "horus"/,
    'unknown name must throw with structured error naming the subagent',
  );
});

// ---------------------------------------------------------------------------
// 7. Tool-subset filter end-to-end: only the intersected tools are sent to LLM
// ---------------------------------------------------------------------------

test('subagent-runner: only intersected tools reach the LLM request body', async () => {
  const sub = makeSubagent({ tools: ['get_task', 'nonexistent_tool', 'list_projects'] });
  const agent = makeAgent([sub]);

  // Capture the request body so we can assert on the `tools` array sent.
  let captured: any = null;
  const pool = mockAgent.get('http://mock.openclaw.test');
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply((opts) => {
      captured = JSON.parse(String(opts.body));
      return {
        statusCode: 200,
        data: {
          choices: [
            {
              message: { role: 'assistant', content: 'final' },
              finish_reason: 'stop',
            },
          ],
        },
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });

  const parentCtx = makeParentCtx({ parentRegistry: makeParentRegistry() });
  await subagentRunner.run({
    agent,
    subagentName: 'pr_diff_triage',
    prompt: 'go',
    parentCtx,
  });

  assert.ok(captured, 'request body must have been captured');
  const sentToolNames: string[] = (captured.tools ?? []).map((t: any) => t.function?.name);
  assert.deepEqual(
    sentToolNames,
    ['get_task', 'list_projects'],
    'only intersected tools (in subagent declaration order) reach the LLM',
  );
  assert.ok(
    !sentToolNames.includes('nonexistent_tool'),
    'unknown tools are silently dropped',
  );
});
