/**
 * subagent-tools — pins TASK_2026_002 B5 sub-task 5-6 contracts.
 *
 * Verifies (tasks.md:220):
 *
 *   1. `listForAgent(agent)` returns `[]` when the persona has no harness.
 *   2. With N declared subagents, returns `[delegate_to_subagent,
 *      delegate_to_<n1>, ..., delegate_to_<nN>]` (N+1 total).
 *   3. Calling `delegate_to_<name>(prompt)` invokes `subagentRunner.run` with
 *      the right subagentName and prompt — assertion is end-to-end via a
 *      mocked LLM, since ESM module exports are read-only and stubbing the
 *      runner directly is not possible.
 *   4. Calling the umbrella `delegate_to_subagent(name, prompt)` validates the
 *      name and dispatches to the runner.
 *   5. Tool names are snake_case — the merge() collision policy doesn't trip
 *      against daemon CRUD tools or the `mcp__` namespace.
 *   6. Empty/missing arguments throw with structured messages.
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
import type { ToolCallContext, ToolDef } from '../src/llm.ts';
import type { AgentDef } from '../src/agentRegistry.ts';
import type { HarnessConfig, SubagentDef } from '../src/harness/types.ts';

let subagentTools: typeof import('../src/tools/subagentTools.ts');
let subagentRunner: typeof import('../src/subagents/subagentRunner.ts');
let toolsIndex: typeof import('../src/tools/index.ts');
let daemonTools: typeof import('../src/tools/daemonTools.ts');

before(async () => {
  subagentTools = await import('../src/tools/subagentTools.ts');
  subagentRunner = await import('../src/subagents/subagentRunner.ts');
  toolsIndex = await import('../src/tools/index.ts');
  daemonTools = await import('../src/tools/daemonTools.ts');
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

function makeSubagent(name: string, overrides: Partial<SubagentDef> = {}): SubagentDef {
  return {
    name,
    description: `description for ${name}`,
    systemPrompt: `system prompt for ${name}`,
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
    identityMd: '# Horus',
    personaMd: '# secret persona',
    tokenEnvVar: 'DISCORD_TOKEN_HORUS',
    token: 'fake',
    harness,
  };
}

function makeAgentNoHarness(): AgentDef {
  return {
    id: 'lone',
    name: 'Lone',
    persona: 'lonely',
    identityMd: undefined,
    personaMd: '# lone persona',
    tokenEnvVar: 'DISCORD_TOKEN_LONE',
    token: null,
  };
}

function makeCtx(parentRegistry: ToolDef[] = []): ToolCallContext {
  const state = new Map<string, unknown>();
  state.set(subagentRunner.PARENT_TOOL_REGISTRY_STATE_KEY, parentRegistry);
  return {
    agentId: 'horus',
    userId: 'U-test',
    channelId: 'C-test',
    state,
    emit: () => {},
  };
}

/**
 * Mock the LLM to return a fixed assistant text on the first /chat/completions
 * call AND capture the system prompt seen on that call so dispatch tests can
 * assert which subagent was actually invoked. Returns the captured-state ref.
 */
function interceptLlmCapture(): { captured: { systemPrompt: string | null } } {
  const captured: { systemPrompt: string | null } = { systemPrompt: null };
  const pool = mockAgent.get('http://mock.openclaw.test');
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply((opts) => {
      const body = JSON.parse(String(opts.body));
      const sys = body?.messages?.[0];
      if (sys?.role === 'system') captured.systemPrompt = sys.content;
      return {
        statusCode: 200,
        data: {
          choices: [
            {
              message: { role: 'assistant', content: 'mocked subagent reply' },
              finish_reason: 'stop',
            },
          ],
        },
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
  return { captured };
}

// ---------------------------------------------------------------------------
// (1) No harness / no subagents → empty registry (pure, no LLM)
// ---------------------------------------------------------------------------

test('subagent-tools: agent with no harness returns empty tool list', () => {
  const tools = subagentTools.listForAgent(makeAgentNoHarness());
  assert.deepEqual(tools, [], 'no harness → no subagent tools');
});

test('subagent-tools: agent with harness but zero subagents returns empty tool list', () => {
  const tools = subagentTools.listForAgent(makeAgent([]));
  assert.deepEqual(tools, [], 'empty subagents array → no subagent tools');
});

// ---------------------------------------------------------------------------
// (2) Registry shape: umbrella + per-subagent shortcuts (pure, no LLM)
// ---------------------------------------------------------------------------

test('subagent-tools: with N subagents, returns umbrella + N shortcuts in declaration order', () => {
  const agent = makeAgent([
    makeSubagent('pr_diff_triage'),
    makeSubagent('security_review'),
    makeSubagent('cve_lookup'),
  ]);
  const tools = subagentTools.listForAgent(agent);
  const names = tools.map((t) => t.name);
  assert.deepEqual(
    names,
    [
      'delegate_to_subagent',
      'delegate_to_pr_diff_triage',
      'delegate_to_security_review',
      'delegate_to_cve_lookup',
    ],
    'umbrella first, then shortcuts in declaration order',
  );
  assert.equal(tools.length, 4, 'N=3 subagents → 1 umbrella + 3 shortcuts = 4 tools');
});

test('subagent-tools: subagent name with hyphens is snake_cased for the shortcut tool name', () => {
  // The harness parser allows `name` to be any non-empty string. The shortcut
  // tool name must be snake_case to satisfy the OpenAI tool naming convention.
  const agent = makeAgent([makeSubagent('Pr-Diff Triage!!')]);
  const tools = subagentTools.listForAgent(agent);
  const shortcutName = tools[1].name;
  assert.match(shortcutName, /^delegate_to_[a-z0-9_]+$/, 'shortcut name must be snake_case');
  assert.equal(shortcutName, 'delegate_to_pr_diff_triage');
});

test('subagent-tools: umbrella tool description enumerates declared subagent names', () => {
  const agent = makeAgent([makeSubagent('alpha'), makeSubagent('beta')]);
  const tools = subagentTools.listForAgent(agent);
  const umbrella = tools.find((t) => t.name === 'delegate_to_subagent')!;
  assert.match(umbrella.description, /Available subagents: alpha, beta/);
});

// ---------------------------------------------------------------------------
// (3) Shortcut handler dispatches to the runner with the captured name
// ---------------------------------------------------------------------------

test('subagent-tools: shortcut tool dispatches to subagentRunner.run with the captured subagent name', async () => {
  const agent = makeAgent([
    makeSubagent('pr_diff_triage', { systemPrompt: 'PRDIFF SYSTEM PROMPT' }),
    makeSubagent('security_review', { systemPrompt: 'SECREVIEW SYSTEM PROMPT' }),
  ]);
  const tools = subagentTools.listForAgent(agent);
  const shortcut = tools.find((t) => t.name === 'delegate_to_security_review')!;

  const { captured } = interceptLlmCapture();

  const reply = await shortcut.handler({ prompt: 'audit auth flow' }, makeCtx());

  assert.equal(reply, 'mocked subagent reply', 'reply must surface from the runner');
  // The system prompt observed by the LLM tells us which subagent ran.
  assert.ok(captured.systemPrompt, 'LLM must have been invoked');
  assert.match(captured.systemPrompt!, /SECREVIEW SYSTEM PROMPT/, 'security_review subagent ran');
  assert.match(captured.systemPrompt!, /a subagent of Horus/, 'parent agent name in header');
  assert.match(captured.systemPrompt!, /Original user message: audit auth flow/);
  // The OTHER subagent's body must NOT have leaked.
  assert.doesNotMatch(captured.systemPrompt!, /PRDIFF SYSTEM PROMPT/);
});

// ---------------------------------------------------------------------------
// (4) Umbrella handler validates the name and dispatches
// ---------------------------------------------------------------------------

test('subagent-tools: umbrella delegate_to_subagent validates name and dispatches', async () => {
  const agent = makeAgent([
    makeSubagent('pr_diff_triage', { systemPrompt: 'PRDIFF SYSTEM PROMPT' }),
    makeSubagent('security_review'),
  ]);
  const tools = subagentTools.listForAgent(agent);
  const umbrella = tools.find((t) => t.name === 'delegate_to_subagent')!;

  const { captured } = interceptLlmCapture();

  const reply = await umbrella.handler(
    { name: 'pr_diff_triage', prompt: 'review #2026' },
    makeCtx(),
  );

  assert.equal(reply, 'mocked subagent reply');
  assert.match(captured.systemPrompt!, /PRDIFF SYSTEM PROMPT/);
  assert.match(captured.systemPrompt!, /Original user message: review #2026/);
});

test('subagent-tools: umbrella throws on missing name argument', async () => {
  const agent = makeAgent([makeSubagent('pr_diff_triage')]);
  const tools = subagentTools.listForAgent(agent);
  const umbrella = tools.find((t) => t.name === 'delegate_to_subagent')!;

  await assert.rejects(
    () => umbrella.handler({ prompt: 'go' }, makeCtx()),
    /required argument "name"/,
  );
});

test('subagent-tools: umbrella throws on missing prompt argument', async () => {
  const agent = makeAgent([makeSubagent('pr_diff_triage')]);
  const tools = subagentTools.listForAgent(agent);
  const umbrella = tools.find((t) => t.name === 'delegate_to_subagent')!;

  await assert.rejects(
    () => umbrella.handler({ name: 'pr_diff_triage' }, makeCtx()),
    /required argument "prompt"/,
  );
});

test('subagent-tools: shortcut throws on missing prompt argument', async () => {
  const agent = makeAgent([makeSubagent('pr_diff_triage')]);
  const tools = subagentTools.listForAgent(agent);
  const shortcut = tools.find((t) => t.name === 'delegate_to_pr_diff_triage')!;

  await assert.rejects(
    () => shortcut.handler({}, makeCtx()),
    /required argument "prompt"/,
  );
});

// ---------------------------------------------------------------------------
// (5) Collision policy: subagent tools merge cleanly with daemon CRUD + mcp__
// ---------------------------------------------------------------------------

test('subagent-tools: merge() with daemonTools and a hypothetical mcp__-prefixed tool does not collide', () => {
  const agent = makeAgent([
    makeSubagent('pr_diff_triage'),
    makeSubagent('security_review'),
  ]);
  const subs = subagentTools.listForAgent(agent);
  const daemons = daemonTools.list();
  const fakeMcp: ToolDef[] = [
    {
      name: 'mcp__github__list_repos',
      description: 'fake MCP tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => 'stub',
    },
  ];

  // Should NOT throw. If collision policy ever changes to flag `delegate_to_*`
  // names, this is the canary.
  const merged = toolsIndex.merge(daemons, fakeMcp, subs);
  const names = merged.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'merged registry must have unique names');
  assert.ok(names.includes('list_projects'));
  assert.ok(names.includes('mcp__github__list_repos'));
  assert.ok(names.includes('delegate_to_subagent'));
  assert.ok(names.includes('delegate_to_pr_diff_triage'));
});

test('subagent-tools: merge() throws when two subagents collide (programming error)', () => {
  // Two subagents with the same name → the parser would already reject this,
  // but listForAgent doesn't dedupe. Asserting merge() catches the collision
  // is the belt-and-braces check the impl-plan asks for.
  const agent = makeAgent([
    makeSubagent('pr_diff_triage'),
    makeSubagent('pr_diff_triage'),
  ]);
  const subs = subagentTools.listForAgent(agent);
  assert.throws(
    () => toolsIndex.merge(subs),
    /tool name collision/,
    'duplicate subagent names must trip the collision policy',
  );
});

// ---------------------------------------------------------------------------
// (6) Tool parameter schemas declare required fields correctly
// ---------------------------------------------------------------------------

test('subagent-tools: tool schemas list required fields per the OpenAI tool API', () => {
  const agent = makeAgent([makeSubagent('pr_diff_triage')]);
  const tools = subagentTools.listForAgent(agent);
  const umbrella = tools.find((t) => t.name === 'delegate_to_subagent')!;
  const shortcut = tools.find((t) => t.name === 'delegate_to_pr_diff_triage')!;

  const umbrellaParams = umbrella.parameters as { required?: string[] };
  assert.deepEqual(umbrellaParams.required?.sort(), ['name', 'prompt']);

  const shortcutParams = shortcut.parameters as { required?: string[] };
  assert.deepEqual(shortcutParams.required, ['prompt']);
});
