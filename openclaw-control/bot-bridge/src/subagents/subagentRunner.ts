// subagents/subagentRunner.ts — TASK_2026_002 B5 native subagent runtime.
//
// Spawns a synchronous sub-chat that reuses `chatCompleteWithTools` against a
// scoped persona derived from `agent.harness.chatTier.subagents[name]`. The
// sub-chat is bounded by `OPENCLAW_SUBAGENT_DEPTH_LIMIT` (counter lives on the
// shared `ToolCallContext.state` Map under key `subagentDepth`). Per
// implementation-plan §"Native subagent runtime" lines 917-930:
//
//   - The parent persona's private body is NEVER propagated into the sub-chat
//     system prompt. Subagents are scoped, not nested persona-of-personas. The
//     B5 verification deliberately greps this file for the parent-body field
//     name and demands zero matches; the test surface
//     (test/subagent-runner.test.ts) pins the runtime composition behavior.
//   - The subagent's `tools: string[]` intersects with the parent's effective
//     tool registry (passed via `parentCtx.state.get('parentToolRegistry')`).
//     Empty/missing → zero tools. Names not in the parent registry → log + skip
//     silently (the harnessAuthor confirm step is what flags typos to the
//     operator; runtime never throws on this).
//   - Each `run` increments depth and passes a fresh `ToolCallContext` whose
//     `state` is a clone of the parent's state with `subagentDepth` overridden.
//   - At depth > limit, `run` throws — `delegate_to_subagent` upstream catches
//     and surfaces "Subagent recursion limit reached (depth=<n>); declining."
//     to the parent loop.

import type { AgentDef } from '../agentRegistry.js';
import type { SubagentDef } from '../harness/types.js';
import {
  chatCompleteWithTools,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ToolCallContext,
  type ToolDef,
} from '../llm.js';
import { config } from '../config.js';

/**
 * Key under which `chat.ts` stashes the freshly-built parent tool registry on
 * `ToolCallContext.state` before invoking the tool-calling loop. The runner
 * pulls this back out to compute the per-call subset for the subagent.
 *
 * Exported so `chat.ts` (the writer) and tests (which assert the round-trip)
 * agree on the wire-format key without stringly-typed drift.
 */
export const PARENT_TOOL_REGISTRY_STATE_KEY = 'parentToolRegistry';

/**
 * Key under which the recursion counter lives on the shared state map. Public
 * so subagentTools handlers can read the post-bump depth out of `parentCtx`
 * for telemetry, and so tests can pre-seed depth to assert the limit branch.
 */
export const SUBAGENT_DEPTH_STATE_KEY = 'subagentDepth';

export interface SubagentResult {
  name: string;
  reply: string;
  durationMs: number;
  trace: ChatWithToolsResult['trace'];
  truncated: boolean;
}

export interface RunArgs {
  /** Parent persona — owns the subagent definition and the parent tool registry. */
  agent: AgentDef;
  /** Must be a name in `agent.harness.chatTier.subagents[*].name`. */
  subagentName: string;
  /** Free-form user-style prompt to deliver to the subagent. */
  prompt: string;
  /** Parent's `ToolCallContext`; depth and registry are pulled from `state`. */
  parentCtx: ToolCallContext;
  /** Optional overrides forwarded to `chatCompleteWithTools`. */
  options?: ChatWithToolsOptions;
}

/**
 * Compose the sub-chat system prompt per impl-plan §"Native subagent runtime"
 * lines 917-930. Order is fixed and the verification grep depends on it
 * staying that way:
 *
 *   You are <subagent.name> (a subagent of <parent.name>).
 *
 *   <subagent.systemPrompt body>
 *
 *   You have access to a curated tool subset. Stay focused on the task you've
 *   been given; return your final answer when done.
 *
 *   [CALLER CONTEXT]
 *   - Parent agent: <parent.name>
 *   - Original user message: <prompt arg>
 *
 * Note (security-critical): the parent's private persona body is NEVER read
 * or interpolated here. See B5 verification item 5: a grep for the parent-
 * body field name on this file must return zero matches.
 */
export function composeSubagentSystemPrompt(
  parent: AgentDef,
  subagent: SubagentDef,
  prompt: string,
): string {
  return [
    `You are ${subagent.name} (a subagent of ${parent.name}).`,
    '',
    subagent.systemPrompt,
    '',
    "You have access to a curated tool subset. Stay focused on the task you've been given;",
    'return your final answer when done.',
    '',
    '[CALLER CONTEXT]',
    `- Parent agent: ${parent.name}`,
    `- Original user message: ${prompt}`,
  ].join('\n');
}

/**
 * Compute the parent-registry-intersected tool list for the subagent.
 *
 * Per impl-plan §"Tool subset selection":
 *   - `subagent.tools` empty/missing → zero tools (read-only reasoning).
 *   - Names present but not in the parent registry → log + skip silently.
 *   - Order follows the subagent's declaration (so the LLM sees a stable list).
 *
 * The parent registry is a `ToolDef[]` rather than a `Map`, but we materialize
 * a Map locally for O(1) lookup. The impl-plan calls this "cheap" and the
 * registry is already small (≤ ~30 entries even with MCP).
 */
export function filterParentToolsForSubagent(
  subagent: SubagentDef,
  parentRegistry: ToolDef[],
): ToolDef[] {
  const declared = subagent.tools;
  if (!declared || declared.length === 0) {
    // Read-only reasoning subagent: zero tools by design.
    return [];
  }
  const byName = new Map<string, ToolDef>();
  for (const t of parentRegistry) byName.set(t.name, t);
  const out: ToolDef[] = [];
  for (const name of declared) {
    const tool = byName.get(name);
    if (!tool) {
      console.warn(
        `[subagent ${subagent.name}] declared tool "${name}" not found in parent registry — skipping`,
      );
      continue;
    }
    out.push(tool);
  }
  return out;
}

/**
 * Resolve a subagent definition by name on the parent's harness, throwing a
 * structured error when missing. Exported for tests and for the
 * `delegate_to_subagent` umbrella tool.
 */
export function resolveSubagent(agent: AgentDef, name: string): SubagentDef {
  const list = agent.harness?.chatTier?.subagents ?? [];
  const found = list.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `subagent "${name}" not declared on agent "${agent.id}" — available: ${
        list.map((s) => s.name).join(', ') || '(none)'
      }`,
    );
  }
  return found;
}

/**
 * Build the child `ToolCallContext` for the sub-chat. The state map is cloned
 * from the parent (shallow clone — values are not deep-copied) so the parent
 * sees mutations the subagent makes to shared keys. The `subagentDepth`
 * counter is overridden to the bumped value so the next nested
 * `delegate_to_subagent` call sees the new depth.
 *
 * Other keys are preserved verbatim — including `parentToolRegistry`, which
 * means a recursive subagent gets the SAME parent's registry to intersect
 * against. That matches the impl-plan: "the intersection is computed fresh on
 * every `delegate_to_subagent` call" — fresh meaning re-evaluated, not
 * re-built; a recursive subagent's grandparent registry is what flows down.
 */
function buildChildContext(parentCtx: ToolCallContext, depth: number): ToolCallContext {
  const childState = new Map<string, unknown>(parentCtx.state);
  childState.set(SUBAGENT_DEPTH_STATE_KEY, depth);
  return {
    agentId: parentCtx.agentId,
    userId: parentCtx.userId,
    channelId: parentCtx.channelId,
    state: childState,
    emit: parentCtx.emit,
  };
}

/**
 * Spawn a subagent sub-chat. See module header for the contract.
 *
 * Caller responsibilities:
 *   - `parentCtx.state` SHOULD have `parentToolRegistry` populated by chat.ts;
 *     missing means "zero tools available" which is conservative but valid.
 *
 * Failure modes:
 *   - Unknown `subagentName` → throws (umbrella tool surfaces as an error
 *     tool message to the parent loop).
 *   - Depth limit exceeded → throws with a stable message ("Subagent
 *     recursion limit reached…") so the umbrella tool can pattern-match for
 *     observability without parsing.
 *
 * Successful return:
 *   - `truncated:true` is possible (chatCompleteWithTools depth/wallclock
 *     budget hit); the partial assistant text is still surfaced in `reply`.
 *   - `reply` is the empty string if the loop produced no assistant text at
 *     all; the parent LLM sees a tool message body of `""` and decides what
 *     to do next.
 */
export async function run(args: RunArgs): Promise<SubagentResult> {
  const { agent, subagentName, prompt, parentCtx, options } = args;

  const subagent = resolveSubagent(agent, subagentName);

  const parentDepth = (parentCtx.state.get(SUBAGENT_DEPTH_STATE_KEY) as number | undefined) ?? 0;
  const depth = parentDepth + 1;
  const limit = config.subagentDepthLimit;
  if (depth > limit) {
    throw new Error(
      `Subagent recursion limit reached (depth=${depth}, limit=${limit}); declining.`,
    );
  }

  // Pull parent registry from shared state. chat.ts populates this right
  // before calling chatCompleteWithTools (see chat.ts:handleChat). When the
  // key is missing (e.g. an upstream caller forgot to set it), we treat the
  // registry as empty rather than throwing — the subagent simply gets zero
  // tools, which is the same conservative posture as a subagent with no
  // `tools:` field declared.
  const parentRegistryRaw = parentCtx.state.get(PARENT_TOOL_REGISTRY_STATE_KEY);
  const parentRegistry: ToolDef[] = Array.isArray(parentRegistryRaw)
    ? (parentRegistryRaw as ToolDef[])
    : [];
  const filteredTools = filterParentToolsForSubagent(subagent, parentRegistry);

  const subagentSystemPrompt = composeSubagentSystemPrompt(agent, subagent, prompt);

  // Observability — `invoker.subagent_started` is emitted BEFORE the LLM call
  // so AT#3's SSE visibility test catches in-flight subagents even if the
  // sub-chat hangs against a flapping provider. The emitter is fire-and-forget
  // by contract (see chat.ts ToolCallContext wiring); we don't await.
  const startedAt = Date.now();
  try {
    parentCtx.emit('invoker.subagent_started', {
      name: subagent.name,
      parentAgentId: agent.id,
      depth,
      toolCount: filteredTools.length,
    });
  } catch {
    // Observability emitter must never break the loop.
  }

  const childCtx = buildChildContext(parentCtx, depth);
  const result = await chatCompleteWithTools(
    subagentSystemPrompt,
    [{ role: 'user', content: prompt }],
    filteredTools,
    childCtx,
    options ?? {},
  );

  const durationMs = Date.now() - startedAt;
  const reply = typeof result.content === 'string' ? result.content : '';

  try {
    parentCtx.emit('invoker.subagent_finished', {
      name: subagent.name,
      parentAgentId: agent.id,
      depth,
      durationMs,
      truncated: result.truncated,
      replyLength: reply.length,
    });
  } catch {
    // intentionally swallowed — see started-event note
  }

  return {
    name: subagent.name,
    reply,
    durationMs,
    trace: result.trace,
    truncated: result.truncated,
  };
}
