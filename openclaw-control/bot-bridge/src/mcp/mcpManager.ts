// mcp/mcpManager.ts — TASK_2026_002 B4 native MCP client lifecycle.
//
// Per-persona MCP server lifecycle for the chat tier. Spawns one
// `StdioClientTransport` per `harness.chatTier.mcpServers[*]` entry, calls
// `initialize()` + `listTools()`, caches the tool list on `McpServerHandle`,
// and exposes `callTool` for the chat-tier registry (see `tools/mcpTools.ts`).
//
// Lifecycle (impl-plan §"MCP client architecture" lines 889–893):
//
//   start    : spawn transport → client.initialize() → client.listTools()
//   stop     : client.close() → transport.close() → SIGKILL after 5s
//   reconcile: diff old vs new server set by id; add → start, remove → stop,
//              changed (different command/args/env/timeoutMs) → stop + start
//   recover  : on unexpected transport `close`, errorCount++ and respawn on
//              the BACKOFF_CURVE; on exhaustion, emit `mcp.server_failed` SSE
//              and leave the handle in failed state until the next reconcile
//   shutdown : stopServersForAgent for every known agent
//
// Concurrency budget: at most OPENCLAW_MCP_MAX_CONCURRENT_SERVERS (default 8)
// open transports across all agents on this host. Excess specs are skipped
// with a warning — the manager warns when one persona starves another.
//
// Hard rule from impl-plan §"Error handling — flapping MCP must not break
// chat": failed/backoff servers stop offering their tools. `getOpenServers`
// MUST filter them out. The chat tool registry built each turn does the right
// thing because it always re-asks the manager for the current open set.

import type { AgentDef } from '../agentRegistry.js';
import type { McpServerSpec } from '../harness/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { daemon } from '../daemonClient.js';

/** Hard-coded backoff curve in ms — exported so tests can assert against the constant. */
export const BACKOFF_CURVE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];

/** How long to wait after `transport.close()` before SIGKILLing the child. */
export const STOP_GRACE_MS = 5_000;

/** initialize() + listTools() upper bound (impl-plan line 906). */
export const INIT_TIMEOUT_MS = 10_000;

/** Default per-tool call timeout when the spec doesn't pin one (impl-plan line 905). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default budget if the env var is unset/invalid (impl-plan line 897). */
export const DEFAULT_MAX_CONCURRENT_SERVERS = 8;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerHandle {
  serverId: string;
  agentId: string;
  client: Client;
  tools: McpTool[];
  startedAt: number;
  lastErrorAt?: number;
  errorCount: number;
}

// Internal wrapper carrying the bookkeeping the public McpServerHandle hides.
// `transport`, `spec` snapshot, `shuttingDown`, `failed`, and the backoff
// timer are implementation detail and must NOT leak through `getOpenServers`.
interface InternalEntry {
  handle: McpServerHandle;
  /** Best-effort handle to the underlying transport. May be a stub in tests. */
  transport: { close(): Promise<void>; pid: number | null };
  spec: McpServerSpec;
  /** Set when WE initiated the close (stop / reconcile / shutdownAll). */
  shuttingDown: boolean;
  /** True after backoff exhaustion; tools are filtered out until next reconcile. */
  failed: boolean;
  /** Active backoff timer if a respawn is scheduled. */
  backoffTimer?: NodeJS.Timeout;
}

/** agentId → (serverId → entry) */
const agents: Map<string, Map<string, InternalEntry>> = new Map();

/** spec snapshots used by `reconcileForAgent` to detect changed servers. */
const lastSpecsByAgent: Map<string, Map<string, McpServerSpec>> = new Map();

function maxConcurrentServers(): number {
  const raw = process.env.OPENCLAW_MCP_MAX_CONCURRENT_SERVERS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENT_SERVERS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_SERVERS;
  return Math.floor(n);
}

function totalOpenAcrossHost(): number {
  let count = 0;
  for (const inner of agents.values()) count += inner.size;
  return count;
}

/**
 * Deep-equal compare two `McpServerSpec`s on the four fields the impl-plan
 * pins as the equality key for reconcile: `{command, args, env, timeoutMs}`.
 * `id` is the diff key (not compared here) and `transport` is informational
 * only (we currently only support stdio).
 */
function specsEqual(a: McpServerSpec, b: McpServerSpec): boolean {
  if (a.command !== b.command) return false;
  if ((a.timeoutMs ?? null) !== (b.timeoutMs ?? null)) return false;
  const aArgs = a.args ?? [];
  const bArgs = b.args ?? [];
  if (aArgs.length !== bArgs.length) return false;
  for (let i = 0; i < aArgs.length; i++) if (aArgs[i] !== bArgs[i]) return false;
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    if (k !== bKeys[i]) return false;
    if (aEnv[k] !== bEnv[k]) return false;
  }
  return true;
}

/**
 * Wrap a promise with a timeout. On timeout, rejects with a descriptive error.
 * The underlying work is NOT cancelled.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Spawn dispatch — the production path uses StdioClientTransport + Client
// directly. Tests override the dispatcher via `__setSpawnForTests` to inject
// a fully-formed InternalEntry without spawning a child process.
// ---------------------------------------------------------------------------

type SpawnFn = (agentId: string, spec: McpServerSpec) => Promise<InternalEntry>;

/**
 * Expand `${VAR}` references in spec env values against `process.env`.
 * Unknown vars expand to '' and log a warning so the operator sees the cause
 * before the MCP server hits its upstream API with empty credentials.
 *
 * Returned env merges PATH/HOME/LANG/LC_ALL from `process.env` so the child
 * has a usable shell environment — the MCP SDK's StdioClientTransport
 * REPLACES (not merges) the child env when given an explicit `env`.
 */
function resolveSpawnEnv(
  agentId: string,
  spec: McpServerSpec,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL'] as const) {
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  const specEnv = spec.env ?? {};
  for (const [key, raw] of Object.entries(specEnv)) {
    out[key] = raw.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined || v === '') {
        console.warn(
          `[mcp] ${agentId}/${spec.id} env "${key}" references \${${name}} which is unset in process.env — expanding to empty string`,
        );
        return '';
      }
      return v;
    });
  }
  return out;
}

const realSpawn: SpawnFn = async (agentId, spec) => {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: resolveSpawnEnv(agentId, spec),
    // stderr defaults to "inherit" — operators see why an MCP server crashed.
  });

  const client = new Client(
    { name: 'openclaw-bot-bridge', version: '0.1.0' },
    { capabilities: {} },
  );

  // `client.connect(transport)` calls `transport.start()` internally and runs
  // the initialization handshake. Wrap in our 10s init budget.
  await withTimeout(client.connect(transport), INIT_TIMEOUT_MS, `mcp[${spec.id}] connect`);

  const listResult = await withTimeout(
    client.listTools(),
    INIT_TIMEOUT_MS,
    `mcp[${spec.id}] listTools`,
  );

  const tools: McpTool[] = listResult.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  const handle: McpServerHandle = {
    serverId: spec.id,
    agentId,
    client,
    tools,
    startedAt: Date.now(),
    errorCount: 0,
  };

  const entry: InternalEntry = {
    handle,
    transport: {
      close: () => transport.close(),
      get pid() {
        return transport.pid;
      },
    },
    spec,
    shuttingDown: false,
    failed: false,
  };

  // Crash-recovery hook — fires on unexpected close (clean stops set
  // `entry.shuttingDown=true` BEFORE calling transport.close()).
  transport.onclose = () => {
    if (entry.shuttingDown) return;
    handleUnexpectedClose(agentId, spec.id);
  };

  return entry;
};

let activeSpawn: SpawnFn = realSpawn;

function getOrCreateAgentMap(agentId: string): Map<string, InternalEntry> {
  let m = agents.get(agentId);
  if (!m) {
    m = new Map();
    agents.set(agentId, m);
  }
  return m;
}

/**
 * Crash recovery: increment errorCount, schedule a respawn on the backoff
 * curve. After 6 attempts emit `mcp.server_failed` and leave the entry in
 * `failed=true` state (its tools disappear from the registry until the next
 * `reconcileForAgent` brings the spec back).
 */
function handleUnexpectedClose(agentId: string, serverId: string): void {
  const inner = agents.get(agentId);
  const entry = inner?.get(serverId);
  if (!entry) return;

  entry.handle.errorCount += 1;
  entry.handle.lastErrorAt = Date.now();

  console.warn(
    `[mcp] ${agentId}/${serverId} transport closed unexpectedly (errorCount=${entry.handle.errorCount})`,
  );

  if (entry.handle.errorCount > BACKOFF_CURVE_MS.length) {
    entry.failed = true;
    if (entry.backoffTimer) {
      clearTimeout(entry.backoffTimer);
      entry.backoffTimer = undefined;
    }
    console.error(
      `[mcp] ${agentId}/${serverId} backoff exhausted after ${BACKOFF_CURVE_MS.length} attempts — emitting mcp.server_failed`,
    );
    void daemon.emitSseHint('mcp.server_failed', {
      agentId,
      serverId,
      errorCount: entry.handle.errorCount,
    });
    return;
  }

  const delay = BACKOFF_CURVE_MS[entry.handle.errorCount - 1] ?? BACKOFF_CURVE_MS.at(-1)!;
  console.warn(`[mcp] ${agentId}/${serverId} respawn scheduled in ${delay}ms`);

  entry.backoffTimer = setTimeout(() => {
    void respawnEntry(agentId, serverId, entry.spec);
  }, delay);
  entry.backoffTimer.unref?.();
}

async function respawnEntry(
  agentId: string,
  serverId: string,
  spec: McpServerSpec,
): Promise<void> {
  const inner = agents.get(agentId);
  const oldEntry = inner?.get(serverId);
  if (!inner || !oldEntry) return;
  if (oldEntry.shuttingDown) return; // a stop landed while the timer was queued

  oldEntry.backoffTimer = undefined;
  const previousErrorCount = oldEntry.handle.errorCount;

  try {
    const fresh = await activeSpawn(agentId, spec);
    // Carry the errorCount forward so consecutive flaps walk the curve.
    fresh.handle.errorCount = previousErrorCount;
    inner.set(serverId, fresh);
    console.log(`[mcp] ${agentId}/${serverId} respawned successfully`);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[mcp] ${agentId}/${serverId} respawn failed: ${msg}`);
    // Treat a failed respawn as another close event — re-enters the curve.
    handleUnexpectedClose(agentId, serverId);
  }
}

/**
 * Tear down a single entry. Best-effort:
 *   - mark `shuttingDown` so the close handler ignores the upcoming event
 *   - clear any pending backoff timer
 *   - client.close() then transport.close()
 *   - SIGKILL the child if it doesn't exit within STOP_GRACE_MS
 */
async function stopEntry(entry: InternalEntry): Promise<void> {
  entry.shuttingDown = true;
  if (entry.backoffTimer) {
    clearTimeout(entry.backoffTimer);
    entry.backoffTimer = undefined;
  }

  try {
    await entry.handle.client.close();
  } catch (err) {
    // The SDK throws if already closed — non-fatal during teardown.
    console.warn(
      `[mcp] ${entry.handle.agentId}/${entry.handle.serverId} client.close() failed: ${(err as Error)?.message ?? err}`,
    );
  }

  // Capture pid before transport.close() — once close runs the field nulls.
  const pid = entry.transport.pid;

  try {
    await entry.transport.close();
  } catch (err) {
    console.warn(
      `[mcp] ${entry.handle.agentId}/${entry.handle.serverId} transport.close() failed: ${(err as Error)?.message ?? err}`,
    );
  }

  if (pid !== null && pid > 0) {
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {
      // gone — nothing more to do
    }
    if (stillAlive) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
            console.warn(
              `[mcp] ${entry.handle.agentId}/${entry.handle.serverId} pid=${pid} did not exit in ${STOP_GRACE_MS}ms — SIGKILL sent`,
            );
          } catch {
            // process exited between the check and the kill — fine
          }
          resolve();
        }, STOP_GRACE_MS);
        timer.unref?.();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — five exports, ordered exactly as in implementation-plan.md
// lines 239–245.
// ---------------------------------------------------------------------------

/**
 * Start every MCP server in `agent.harness.chatTier.mcpServers`.
 *
 * Servers that take the host past the concurrency budget are skipped with a
 * warning — the LLM will never see those tools, but the rest of the persona's
 * surface stays alive. Spec failures (spawn / initialize / listTools) log and
 * skip; chat is never blocked on a flaky MCP server.
 */
export async function startServersForAgent(agent: AgentDef): Promise<void> {
  const specs = agent.harness?.chatTier?.mcpServers ?? [];
  if (!specs.length) return;

  const inner = getOrCreateAgentMap(agent.id);
  const lastSpecs = lastSpecsByAgent.get(agent.id) ?? new Map<string, McpServerSpec>();
  lastSpecsByAgent.set(agent.id, lastSpecs);

  const budget = maxConcurrentServers();

  for (const spec of specs) {
    if (inner.has(spec.id)) {
      // Idempotent — second call for the same agent is a no-op for already-open servers.
      continue;
    }
    if (totalOpenAcrossHost() >= budget) {
      console.warn(
        `[mcp] concurrency budget reached (${budget}); skipping ${agent.id}/${spec.id} — operator should raise OPENCLAW_MCP_MAX_CONCURRENT_SERVERS or trim some persona's mcpServers`,
      );
      continue;
    }
    try {
      const entry = await activeSpawn(agent.id, spec);
      inner.set(spec.id, entry);
      lastSpecs.set(spec.id, spec);
      console.log(
        `[mcp] started ${agent.id}/${spec.id} (${entry.handle.tools.length} tools)`,
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.warn(`[mcp] failed to start ${agent.id}/${spec.id}: ${msg}`);
    }
  }
}

/**
 * Stop every MCP server for the given agent. Used by reconcile (when the
 * agent's harness drops all servers) and by `shutdownAll` on SIGTERM.
 */
export async function stopServersForAgent(agentId: string): Promise<void> {
  const inner = agents.get(agentId);
  if (!inner) return;
  const entries = Array.from(inner.values());
  inner.clear();
  agents.delete(agentId);
  lastSpecsByAgent.delete(agentId);

  for (const entry of entries) {
    try {
      await stopEntry(entry);
    } catch (err) {
      console.warn(
        `[mcp] stopServersForAgent: ${agentId}/${entry.handle.serverId} threw during teardown: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

/**
 * Diff old vs new spec set by id. Implements the impl-plan §"MCP client
 * architecture" line 891 contract:
 *
 *   added   → start
 *   removed → stop
 *   changed → stop + start (deep-equal of {command, args, env, timeoutMs})
 *
 * A failed entry with the same spec is left in place — the operator must
 * edit the harness to trigger a respawn (matches impl-plan line 893:
 * "operator must `harness/sync` to retry").
 */
export async function reconcileForAgent(agent: AgentDef): Promise<void> {
  const specs = agent.harness?.chatTier?.mcpServers ?? [];
  const inner = getOrCreateAgentMap(agent.id);
  const lastSpecs = lastSpecsByAgent.get(agent.id) ?? new Map<string, McpServerSpec>();
  lastSpecsByAgent.set(agent.id, lastSpecs);

  const newById = new Map<string, McpServerSpec>();
  for (const s of specs) newById.set(s.id, s);

  const toStop: string[] = [];
  const toStart: McpServerSpec[] = [];
  const toReplace: McpServerSpec[] = [];

  // Removed: in inner but not in newById.
  for (const id of Array.from(inner.keys())) {
    if (!newById.has(id)) toStop.push(id);
  }
  // Added or changed.
  for (const spec of specs) {
    const prev = lastSpecs.get(spec.id);
    const open = inner.get(spec.id);
    if (!prev || !open) {
      toStart.push(spec);
    } else if (!specsEqual(prev, spec)) {
      toReplace.push(spec);
    }
    // else: identical spec, leave alone (this is also where a failed-state
    // entry stays put — operator edits the harness if they want to retry).
  }

  for (const id of toStop) {
    const entry = inner.get(id);
    if (!entry) continue;
    inner.delete(id);
    lastSpecs.delete(id);
    try {
      await stopEntry(entry);
      console.log(`[mcp] reconcile: stopped ${agent.id}/${id} (removed from harness)`);
    } catch (err) {
      console.warn(
        `[mcp] reconcile: stop ${agent.id}/${id} failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  for (const spec of toReplace) {
    const entry = inner.get(spec.id);
    if (entry) {
      inner.delete(spec.id);
      try {
        await stopEntry(entry);
      } catch (err) {
        console.warn(
          `[mcp] reconcile: stop-before-start ${agent.id}/${spec.id} failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    try {
      const fresh = await activeSpawn(agent.id, spec);
      inner.set(spec.id, fresh);
      lastSpecs.set(spec.id, spec);
      console.log(`[mcp] reconcile: replaced ${agent.id}/${spec.id} (spec changed)`);
    } catch (err) {
      console.warn(
        `[mcp] reconcile: respawn ${agent.id}/${spec.id} failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  if (toStart.length) {
    const budget = maxConcurrentServers();
    for (const spec of toStart) {
      if (inner.has(spec.id)) continue;
      if (totalOpenAcrossHost() >= budget) {
        console.warn(
          `[mcp] reconcile: concurrency budget reached (${budget}); skipping ${agent.id}/${spec.id}`,
        );
        continue;
      }
      try {
        const fresh = await activeSpawn(agent.id, spec);
        inner.set(spec.id, fresh);
        lastSpecs.set(spec.id, spec);
        console.log(`[mcp] reconcile: started ${agent.id}/${spec.id} (added to harness)`);
      } catch (err) {
        console.warn(
          `[mcp] reconcile: start ${agent.id}/${spec.id} failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }
}

/**
 * Return the live, healthy server handles for an agent. Failed (backoff-
 * exhausted) servers are filtered out so their tools never appear in the
 * chat-tier registry — impl-plan §"Error handling" line 902: "no half-broken
 * affordances offered to the LLM".
 *
 * Returned handles share their underlying objects with the manager — callers
 * MUST treat them as read-only.
 */
export function getOpenServers(agentId: string): McpServerHandle[] {
  const inner = agents.get(agentId);
  if (!inner) return [];
  const out: McpServerHandle[] = [];
  for (const entry of inner.values()) {
    if (entry.failed) continue;
    if (entry.shuttingDown) continue;
    out.push(entry.handle);
  }
  return out;
}

/**
 * Invoke an MCP tool. Returns the same `{ content, isError }` envelope the
 * chat tool registry needs. Timeouts and SDK errors map to `isError: true`
 * with a descriptive `content` string — impl-plan §"Error handling" line 901.
 */
export async function callTool(
  agentId: string,
  serverId: string,
  toolName: string,
  args: unknown,
): Promise<{ content: string; isError: boolean }> {
  const inner = agents.get(agentId);
  const entry = inner?.get(serverId);
  if (!entry) {
    return {
      content: `<MCP server "${serverId}" not running for agent "${agentId}">`,
      isError: true,
    };
  }
  if (entry.failed) {
    return {
      content: `<MCP server "${serverId}" is in failed state — operator must harness/sync to retry>`,
      isError: true,
    };
  }
  if (entry.shuttingDown) {
    return {
      content: `<MCP server "${serverId}" is shutting down>`,
      isError: true,
    };
  }

  const timeoutMs = entry.spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;

  try {
    const result = await withTimeout(
      entry.handle.client.callTool({ name: toolName, arguments: argsObj }),
      timeoutMs,
      `MCP server '${serverId}' tool '${toolName}'`,
    );

    // CallToolResult: array of content items OR legacy `toolResult`. We emit
    // the textual concatenation so the LLM gets a readable string.
    let content: string;
    let isError = false;
    if ('content' in result && Array.isArray(result.content)) {
      isError = result.isError === true;
      content = result.content
        .map((c) => {
          if (c.type === 'text' && typeof c.text === 'string') return c.text;
          if (c.type === 'image' && typeof c.data === 'string') return `<image:${c.mimeType}>`;
          if (c.type === 'audio' && typeof c.data === 'string') return `<audio:${c.mimeType}>`;
          if (c.type === 'resource') return `<resource>`;
          if (c.type === 'resource_link') return `<resource_link:${(c as { uri?: string }).uri ?? ''}>`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else if ('toolResult' in result) {
      content = JSON.stringify((result as { toolResult: unknown }).toolResult);
    } else {
      content = JSON.stringify(result);
    }
    return { content, isError };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/timed out/i.test(msg)) {
      return {
        content: `<MCP server '${serverId}' tool '${toolName}' timed out after ${timeoutMs}ms>`,
        isError: true,
      };
    }
    return {
      content: `<MCP server '${serverId}' tool '${toolName}' failed: ${msg}>`,
      isError: true,
    };
  }
}

/**
 * Tear down every server across every agent. Called from the SIGTERM handler
 * BEFORE Discord client.destroy() — that ordering is a verification item.
 */
export async function shutdownAll(): Promise<void> {
  const ids = Array.from(agents.keys());
  for (const id of ids) {
    try {
      await stopServersForAgent(id);
    } catch (err) {
      console.warn(
        `[mcp] shutdownAll: agent "${id}" teardown threw: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test seams — production code never reads these. Tests mock the
// StdioClientTransport+Client lifecycle by injecting a `SpawnFn` that returns
// a fully-formed `InternalEntry`.
// ---------------------------------------------------------------------------

/** Build an InternalEntry from a partial test fixture — used by tests + by `__setSpawnForTests`. */
export interface TestSpawnFixture {
  /** Override the tool list returned by the fake `listTools`. */
  tools?: McpTool[];
  /** Hook the fake client.callTool — defaults to echoing the args. */
  callTool?: (
    args: { name: string; arguments: Record<string, unknown> },
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean } | { toolResult: unknown }>;
  /** Hook the fake client.close — defaults to a no-op. */
  close?: () => Promise<void>;
  /** Optional fake pid so the SIGKILL path can be exercised. */
  pid?: number | null;
}

export function __setSpawnForTests(
  fn: ((agentId: string, spec: McpServerSpec) => Promise<InternalEntry>) | null,
): void {
  activeSpawn = fn ?? realSpawn;
}

/** Build a minimum InternalEntry without spawning a child process. */
export function __makeTestEntry(
  agentId: string,
  spec: McpServerSpec,
  fixture: TestSpawnFixture = {},
): InternalEntry {
  const tools: McpTool[] = fixture.tools ?? [
    { name: 'noop', description: 'no-op test tool', inputSchema: { type: 'object', properties: {} } },
  ];

  const closedFlag = { value: false };
  const fakeClient = {
    close: async () => {
      closedFlag.value = true;
      if (fixture.close) await fixture.close();
    },
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      if (closedFlag.value) throw new Error('client is closed');
      if (fixture.callTool) {
        return fixture.callTool({ name: params.name, arguments: params.arguments ?? {} });
      }
      return {
        content: [
          { type: 'text', text: `echo:${params.name}:${JSON.stringify(params.arguments ?? {})}` },
        ],
        isError: false,
      };
    },
  } as unknown as Client;

  const handle: McpServerHandle = {
    serverId: spec.id,
    agentId,
    client: fakeClient,
    tools,
    startedAt: Date.now(),
    errorCount: 0,
  };

  let pid: number | null = fixture.pid ?? null;
  return {
    handle,
    transport: {
      close: async () => {
        pid = null;
      },
      get pid() {
        return pid;
      },
    },
    spec,
    shuttingDown: false,
    failed: false,
  };
}

/** Trigger the unexpected-close path from tests without owning a real transport. */
export function __triggerUnexpectedCloseForTests(agentId: string, serverId: string): void {
  handleUnexpectedClose(agentId, serverId);
}

/** Surface internal entry state for unit-test assertions. */
export function __getInternalEntryForTests(
  agentId: string,
  serverId: string,
): {
  handle: McpServerHandle;
  shuttingDown: boolean;
  failed: boolean;
  hasBackoffTimer: boolean;
} | null {
  const entry = agents.get(agentId)?.get(serverId);
  if (!entry) return null;
  return {
    handle: entry.handle,
    shuttingDown: entry.shuttingDown,
    failed: entry.failed,
    hasBackoffTimer: entry.backoffTimer !== undefined,
  };
}

/** Reset all manager state — tests call this in their teardown. */
export function __resetForTests(): void {
  for (const inner of agents.values()) {
    for (const entry of inner.values()) {
      if (entry.backoffTimer) clearTimeout(entry.backoffTimer);
    }
  }
  agents.clear();
  lastSpecsByAgent.clear();
  activeSpawn = realSpawn;
}
