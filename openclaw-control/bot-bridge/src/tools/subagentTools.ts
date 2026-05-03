// tools/subagentTools.ts — TASK_2026_002 B5 chat-tier subagent tool registry.
//
// Surfaces the persona's declared subagents to the LLM as two tool shapes
// (impl-plan §`tools/subagentTools.ts` lines 196-206):
//
//   1. `delegate_to_subagent(name, prompt)` — the umbrella dispatch tool. The
//      LLM picks `name` from the declared subagent list at call time. Useful
//      when the LLM wants to reason about which subagent fits.
//
//   2. `delegate_to_<n>(prompt)` — per-subagent shortcut. Same dispatch under
//      the hood; the name is fixed at registry-build time. v1 ALWAYS emits
//      shortcuts: the impl-plan calls this "nicer LLM affordance" and the
//      collision risk is contained because subagent names are snake_case and
//      the `delegate_to_` prefix has no other tenant in the registry.
//
// Both shapes route through `subagentRunner.run`. The umbrella validates
// `name` against `agent.harness.chatTier.subagents`; the shortcut bakes the
// name into the closure and skips the validation step.
//
// Tool naming is snake_case (`delegate_to_subagent`,
// `delegate_to_pr_diff_triage`) so it doesn't collide with the daemon CRUD
// tools or the `mcp__` namespace. `tools/index.ts:merge` will throw on any
// hypothetical clash — see test/subagent-tools.test.ts for the assertion.

import type { AgentDef } from '../agentRegistry.js';
import type { SubagentDef } from '../harness/types.js';
import type { ToolDef, ToolCallContext } from '../llm.js';
import * as subagentRunner from '../subagents/subagentRunner.js';

/**
 * Snake-case a subagent name for the per-subagent shortcut. Names already
 * matching `^[a-z0-9_]+$` are passed through; anything else is normalized:
 * runs of non-alphanumeric chars collapse to a single underscore, leading and
 * trailing underscores are stripped. Empty result falls back to
 * `delegate_to_subagent_<index>` upstream — but in practice the harness parser
 * already requires a non-empty name, so this is purely defensive.
 */
function snakeCase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Render the `delegate_to_subagent` umbrella tool. The handler validates the
 * `name` argument against the agent's declared subagent list — an unknown
 * name surfaces as a thrown error, which `chatCompleteWithTools` converts to
 * a tool message of shape `error: <text>`.
 */
function buildUmbrellaTool(agent: AgentDef): ToolDef {
  const declaredNames = (agent.harness?.chatTier?.subagents ?? []).map((s) => s.name);
  return {
    name: 'delegate_to_subagent',
    description:
      'Hand a focused sub-task to one of your declared subagents and wait for its reply. ' +
      `Available subagents: ${declaredNames.length ? declaredNames.join(', ') : '(none declared)'}. ` +
      'Use the per-subagent shortcuts (delegate_to_<name>) when you already know which one you want; ' +
      'use this umbrella when you want to pick by name at call time.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the declared subagent to invoke.',
          enum: declaredNames.length ? declaredNames : undefined,
        },
        prompt: {
          type: 'string',
          description: 'Free-form instructions for the subagent.',
        },
      },
      required: ['name', 'prompt'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolCallContext) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (!name) {
        throw new Error('delegate_to_subagent: required argument "name" must be a non-empty string');
      }
      if (!prompt) {
        throw new Error(
          'delegate_to_subagent: required argument "prompt" must be a non-empty string',
        );
      }
      const result = await subagentRunner.run({
        agent,
        subagentName: name,
        prompt,
        parentCtx: ctx,
      });
      return result.reply;
    },
  };
}

/**
 * Render the per-subagent shortcut tool. The subagent name is captured in the
 * closure, so the LLM only supplies `prompt`. The shortcut is a pure
 * convenience — internally it calls the same `subagentRunner.run` as the
 * umbrella tool.
 */
function buildShortcutTool(agent: AgentDef, sub: SubagentDef): ToolDef {
  const slug = snakeCase(sub.name);
  return {
    name: `delegate_to_${slug}`,
    description:
      `Delegate to subagent "${sub.name}": ${sub.description} ` +
      'Returns the subagent\'s final markdown reply.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Free-form instructions for the subagent.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolCallContext) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (!prompt) {
        throw new Error(
          `delegate_to_${slug}: required argument "prompt" must be a non-empty string`,
        );
      }
      const result = await subagentRunner.run({
        agent,
        subagentName: sub.name,
        prompt,
        parentCtx: ctx,
      });
      return result.reply;
    },
  };
}

/**
 * Build the chat-tier subagent tool slice for a given persona.
 *
 * Returns:
 *   - `[]` when the persona has no harness or no declared subagents — there's
 *     nothing to delegate to, and emitting the umbrella with `enum:[]` would
 *     just confuse the LLM.
 *   - Otherwise: `[delegate_to_subagent, delegate_to_<n1>, …, delegate_to_<nN>]`
 *     in the same order subagents are declared in `harness.yaml`.
 *
 * Pure function — call on every inbound message; agent.harness is the source
 * of truth and reloads (B3 hot-reload) automatically replace the closure on
 * the next chat turn.
 */
export function listForAgent(agent: AgentDef): ToolDef[] {
  const subs = agent.harness?.chatTier?.subagents ?? [];
  if (subs.length === 0) return [];
  const out: ToolDef[] = [buildUmbrellaTool(agent)];
  for (const sub of subs) {
    out.push(buildShortcutTool(agent, sub));
  }
  return out;
}
