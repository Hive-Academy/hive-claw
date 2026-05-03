// tools/index.ts — small aggregator for chat-tier tool registries.
//
// TASK_2026_002 B2 — implements the collision policy from
// implementation-plan.md §"Tool registry & dispatch loop" (lines 1064–1068):
//
//   "All registries are pure functions so chat.ts can rebuild on every
//    message cheaply. Name collisions resolved by namespacing — throw on
//    collision unless one of the providers is namespaced (mcp__ prefix)."
//
// Concretely:
//   - merge(a, b, c, …) returns a single ToolDef[] in registration order.
//   - If two registries both define a tool with the same name, throw —
//     except that an `mcp__`-prefixed name is allowed to coexist with a
//     non-prefixed name of the same suffix, because the prefix is the
//     namespacing escape hatch (an MCP-exposed `list_projects` cannot
//     possibly mean the same thing as the daemon's `list_projects`).
//
// This is a pure function: no side effects, no async, no I/O. chat.ts calls
// it on every inbound message — keep the constant factor low.

import type { ToolDef } from '../llm.js';

/** Prefix used to namespace MCP-server-exposed tools (see impl-plan §`tools/mcpTools.ts`). */
const MCP_PREFIX = 'mcp__';

/**
 * Merge an arbitrary number of tool registries into a single flat list.
 *
 * Collision policy:
 *   - Two tools with the EXACT same name from different registries → throw.
 *   - The `mcp__` prefix namespaces a tool, so `mcp__github__list_projects`
 *     and `list_projects` are NOT a collision (they have different names).
 *   - Within a single registry, duplicates are also rejected (programmer
 *     error: two tool factories with the same name).
 *
 * Registration order is preserved: the first registry's tools come first.
 * If you want a specific override semantics ("MCP shadows native"), build
 * that into the order you pass to merge() — this function does not pick.
 */
export function merge(...registries: ToolDef[][]): ToolDef[] {
  const seen = new Map<string, { providerIdx: number }>();
  const out: ToolDef[] = [];
  for (let i = 0; i < registries.length; i++) {
    const reg = registries[i];
    if (!reg) continue;
    for (const tool of reg) {
      const existing = seen.get(tool.name);
      if (existing) {
        // Both names are equal here — the prefix exception only applies
        // when names DIFFER. Equal names always collide regardless of
        // whether they happen to start with `mcp__`. Two different MCP
        // servers exposing the same fully-qualified name is still a
        // misconfiguration the operator must resolve.
        throw new Error(
          `[tools/merge] tool name collision: "${tool.name}" defined by registry #${existing.providerIdx} and registry #${i}. ` +
            `Resolve by namespacing one provider with the "${MCP_PREFIX}" prefix or by removing the duplicate.`,
        );
      }
      seen.set(tool.name, { providerIdx: i });
      out.push(tool);
    }
  }
  return out;
}
