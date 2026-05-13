// HarnessConfig — pinned cross-package contract for TASK_2026_002.
//
// This file is mirrored byte-identically (modulo this header comment) at:
//   openclaw-control/daemon/src/harness/types.ts
//
// Why two copies and not a shared package: bot-bridge and daemon are two
// independent npm packages with no monorepo tool. We keep the types in lock-
// step the same way `PRIVATE_AGENT_FILES` is duplicated in
// daemon/src/db/memory.ts and bot-bridge/src/agentRegistry.ts — defense in
// depth, with a CI grep (or MODE 2 manual diff) catching drift. Any change
// to this file MUST be applied to the daemon mirror in the same commit.

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export interface HarnessConfig {
  version: 1;
  chatTier: HarnessTier;
  orchestrationTier: HarnessTier & {
    enabledPluginIds?: string[];
    modelTier?: 'claude_code' | 'enhanced';
  };
}

export interface HarnessTier {
  skills: string[];
  subagents: SubagentDef[];
  mcpServers: McpServerSpec[];
  /**
   * Opt-in chat-tier built-in tools (TASK_2026_003).
   *
   * Free-form list of names that select from the set of statically registered
   * Discord-native tools. Today: `read_channel_history`, `upload_attachment`.
   * Unknown names are dropped at registry-build time with a console warning so
   * a typo in `harness.yaml` does not silently disable a tool the operator
   * thought they enabled.
   *
   * The schema is a free-form `string[]` rather than an enum so harness files
   * can stay forward-compatible with new built-ins added in later batches —
   * the same convention `subagents.tools` follows. The chat-tier registry is
   * the validator, not the parser.
   */
  tools?: string[];
  /**
   * Opt-in: when true and the operator's Discord message carries attachments,
   * the chat tier fetches them, base64-inlines images as `image_url` content
   * parts, and sends the multi-part user message to a vision-capable model.
   * Off by default — locked-down personas should not silently consume
   * attachments. Vision model selection: env `LLM_VISION_MODEL` (falls back
   * to `LLM_MODEL` if unset, which is fine when LLM_MODEL is already a VLM).
   */
  acceptAttachments?: boolean;
  enabledPluginIds?: string[];
  modelTier?: 'claude_code' | 'enhanced';
}

export interface SubagentDef {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
}

export interface McpServerSpec {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  transport?: 'stdio' | 'sse';
}

const MCP_ID_REGEX = /^[a-z0-9_-]+$/;

function fail(path: string, reason: string): never {
  throw new Error(`harness.${path}: ${reason}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected string, got ${typeof v}`);
  return v as string;
}

function asNonEmptyString(v: unknown, path: string): string {
  const s = asString(v, path);
  if (s.length === 0) fail(path, 'must not be empty');
  return s;
}

function asStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, `expected array, got ${typeof v}`);
  return v.map((item, i) => asString(item, `${path}[${i}]`));
}

function asOptionalStringArray(v: unknown, path: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  return asStringArray(v, path);
}

function asOptionalStringRecord(v: unknown, path: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) fail(path, `expected object, got ${typeof v}`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = asString(val, `${path}.${k}`);
  }
  return out;
}

function parseSubagent(v: unknown, path: string): SubagentDef {
  if (!isPlainObject(v)) fail(path, `expected object, got ${typeof v}`);
  const name = asNonEmptyString(v.name, `${path}.name`);
  const description = asNonEmptyString(v.description, `${path}.description`);
  const systemPrompt = asNonEmptyString(v.systemPrompt, `${path}.systemPrompt`);
  const tools = asOptionalStringArray(v.tools, `${path}.tools`);
  const out: SubagentDef = { name, description, systemPrompt };
  if (tools !== undefined) out.tools = tools;
  return out;
}

function parseMcpServer(v: unknown, path: string): McpServerSpec {
  if (!isPlainObject(v)) fail(path, `expected object, got ${typeof v}`);
  const id = asNonEmptyString(v.id, `${path}.id`);
  if (!MCP_ID_REGEX.test(id)) {
    fail(`${path}.id`, `must match ${MCP_ID_REGEX} (got "${id}")`);
  }
  const command = asNonEmptyString(v.command, `${path}.command`);
  const args = asOptionalStringArray(v.args, `${path}.args`);
  const env = asOptionalStringRecord(v.env, `${path}.env`);
  const out: McpServerSpec = { id, command };
  if (args !== undefined) out.args = args;
  if (env !== undefined) out.env = env;
  if (v.timeoutMs !== undefined && v.timeoutMs !== null) {
    if (typeof v.timeoutMs !== 'number' || !Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0) {
      fail(`${path}.timeoutMs`, 'must be a positive number');
    }
    out.timeoutMs = v.timeoutMs;
  }
  if (v.transport !== undefined && v.transport !== null) {
    const t = asString(v.transport, `${path}.transport`);
    if (t !== 'stdio' && t !== 'sse') fail(`${path}.transport`, `expected "stdio" | "sse" (got "${t}")`);
    out.transport = t;
  }
  return out;
}

function parseTier(v: unknown, path: string, allowOrchestrationFields: boolean): HarnessTier {
  if (!isPlainObject(v)) fail(path, `expected object, got ${typeof v}`);
  const skills = asStringArray(v.skills ?? [], `${path}.skills`);
  const subagentsRaw = v.subagents ?? [];
  if (!Array.isArray(subagentsRaw)) fail(`${path}.subagents`, `expected array, got ${typeof subagentsRaw}`);
  const subagents = subagentsRaw.map((s, i) => parseSubagent(s, `${path}.subagents[${i}]`));
  const mcpRaw = v.mcpServers ?? [];
  if (!Array.isArray(mcpRaw)) fail(`${path}.mcpServers`, `expected array, got ${typeof mcpRaw}`);
  const mcpServers = mcpRaw.map((s, i) => parseMcpServer(s, `${path}.mcpServers[${i}]`));
  // TASK_2026_003 — opt-in chat-tier built-in tools (e.g. `read_channel_history`,
  // `upload_attachment`). Free-form list; the chat-tier registry validates the
  // names. Optional everywhere — undefined means "no built-in tools".
  const toolsOpt = asOptionalStringArray(v.tools, `${path}.tools`);
  let acceptAttachments: boolean | undefined;
  if (v.acceptAttachments !== undefined && v.acceptAttachments !== null) {
    if (typeof v.acceptAttachments !== 'boolean') {
      fail(`${path}.acceptAttachments`, `expected boolean, got ${typeof v.acceptAttachments}`);
    }
    acceptAttachments = v.acceptAttachments;
  }

  const tier: HarnessTier = { skills, subagents, mcpServers };
  if (toolsOpt !== undefined) tier.tools = toolsOpt;
  if (acceptAttachments !== undefined) tier.acceptAttachments = acceptAttachments;

  if (allowOrchestrationFields) {
    if (v.enabledPluginIds !== undefined && v.enabledPluginIds !== null) {
      tier.enabledPluginIds = asStringArray(v.enabledPluginIds, `${path}.enabledPluginIds`);
    }
    if (v.modelTier !== undefined && v.modelTier !== null) {
      const mt = asString(v.modelTier, `${path}.modelTier`);
      if (mt !== 'claude_code' && mt !== 'enhanced') {
        fail(`${path}.modelTier`, `expected "claude_code" | "enhanced" (got "${mt}")`);
      }
      tier.modelTier = mt;
    }
  }

  return tier;
}

export function parseHarnessYaml(yamlText: string): HarnessConfig {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('<root>', `yaml parse failed: ${msg}`);
  }
  if (!isPlainObject(parsed)) fail('<root>', `expected object, got ${typeof parsed}`);

  if (parsed.version !== 1) {
    fail('version', `expected 1 (got ${JSON.stringify(parsed.version)})`);
  }

  if (parsed.chatTier === undefined || parsed.chatTier === null) {
    fail('chatTier', 'required');
  }
  if (parsed.orchestrationTier === undefined || parsed.orchestrationTier === null) {
    fail('orchestrationTier', 'required');
  }

  const chatTier = parseTier(parsed.chatTier, 'chatTier', false);
  const orchestrationTier = parseTier(parsed.orchestrationTier, 'orchestrationTier', true) as HarnessConfig['orchestrationTier'];

  const chatTierOut: HarnessTier = {
    skills: chatTier.skills,
    subagents: chatTier.subagents,
    mcpServers: chatTier.mcpServers,
  };
  if (chatTier.tools !== undefined) chatTierOut.tools = chatTier.tools;
  if (chatTier.acceptAttachments !== undefined) chatTierOut.acceptAttachments = chatTier.acceptAttachments;

  return {
    version: 1,
    chatTier: chatTierOut,
    orchestrationTier,
  };
}

export function harnessHash(yamlText: string): string {
  return createHash('sha256').update(yamlText, 'utf8').digest('hex');
}
