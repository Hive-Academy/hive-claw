/**
 * harness/materialize.ts — TASK_2026_002 B6 sub-task 2 + 3.
 *
 * Materializes a persona's `harness.yaml` (read from `MemoryRepo` shared
 * row) into the on-disk per-agent ptah configuration:
 *
 *   ${OPENCLAW_HOST_HOME}/.ptah/agents/<id>/settings.json
 *   ${OPENCLAW_HOST_HOME}/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json
 *   ${OPENCLAW_HOST_HOME}/.ptah/plugins/openclaw-<id>-harness/agents/<sub>.md
 *
 * Per impl-plan §"Materialization (Phase 2)": idempotent (read existing →
 * byte-diff → rewrite only on change), defense-in-depth privacy invariant
 * (`assertMaterializedPathSafety`), and a default settings.json so personas
 * without `harness.yaml` keep dispatch byte-equivalent.
 *
 * Privacy invariant — fourth defense layer
 * ----------------------------------------
 * `assertMaterializedPathSafety(absPath)` is called BEFORE every
 * `fs.writeFile` here. The first three layers (memory.ts:resolveBackend,
 * api.ts HTTP gate, db/memory.ts:assertNotPrivate) protect MEMORY rows.
 * This layer protects CONFIG writes from accidentally landing inside the
 * local-memory tree — the materialized files are config, not memory, so
 * the existing 3-layer invariant doesn't reach them. See impl-plan
 * lines 1100–1109 for the exact throw message contract.
 *
 * Backwards compat
 * ----------------
 * If a persona has no `harness.yaml` row, materialize emits a default
 * settings.json with `enabledPluginIds: []` and `profile: 'claude_code'`,
 * matching the pre-B6 dispatch behavior byte-for-byte (impl-plan line 494).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { MemoryRepo, PRIVATE_AGENT_FILES } from '../db/index.js';
import { parseHarnessYaml, type HarnessConfig, type SubagentDef } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MaterializeResult {
  agentId: string;
  /** Absolute host path to ~/.ptah/agents/<id>/settings.json */
  settingsPath: string;
  /** Absolute host path to ~/.ptah/plugins/openclaw-<id>-harness/ */
  pluginDir: string;
  /** True iff any output file was rewritten. */
  changed: boolean;
  summary: { settingsBytes: number; pluginAgentsCount: number };
}

// ---------------------------------------------------------------------------
// Privacy invariant — fourth defense layer
// ---------------------------------------------------------------------------

/**
 * Hard assertion that no materialized path lives under
 * `config.localMemoryRoot`. Throws with the exact contract from impl-plan
 * lines 1100–1109. Called BEFORE every `fs.writeFile` in this module.
 *
 * Defense in depth on top of the three layers in `daemon/src/memory.ts`,
 * `daemon/src/api.ts`, and `daemon/src/db/memory.ts`. Those guard MEMORY
 * rows; this guards CONFIG writes — the materialized files are config,
 * not memory, so the existing invariant doesn't reach them.
 */
export function assertMaterializedPathSafety(p: string): void {
  const resolved = path.resolve(p);
  const rootResolved = path.resolve(config.localMemoryRoot);
  if (
    resolved.startsWith(rootResolved + path.sep) ||
    resolved === rootResolved
  ) {
    throw new Error(
      `materialize: refusing to write inside local-memory tree: ${resolved}. ` +
        `Materialized files are CONFIG, not persona memory; the privacy invariant in ` +
        `daemon/src/memory.ts forbids configuration files from sharing the local-memory namespace.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Path computation — uses OPENCLAW_HOST_HOME (impl-plan §R5)
// ---------------------------------------------------------------------------

/**
 * The host-side ~/.ptah root. We use OPENCLAW_HOST_HOME so the daemon
 * (running inside the container) emits paths the host sees — the bridge
 * runs ptah on the host and expects host paths. The bind-mount in
 * docker-compose.yml is identity-mapped (same path on both sides) so the
 * container can write to `/home/anubis/.ptah/...` and the bridge sees the
 * exact same string.
 */
function ptahRoot(): string {
  const hostHome =
    (process.env.OPENCLAW_HOST_HOME ?? '').trim() || os.homedir();
  return path.join(hostHome, '.ptah');
}

function agentSettingsPath(agentId: string): string {
  return path.join(ptahRoot(), 'agents', agentId, 'settings.json');
}

function agentPluginDir(agentId: string): string {
  return path.join(ptahRoot(), 'plugins', `openclaw-${agentId}-harness`);
}

function pluginManifestPath(agentId: string): string {
  return path.join(agentPluginDir(agentId), '.claude-plugin', 'plugin.json');
}

function pluginAgentsDir(agentId: string): string {
  return path.join(agentPluginDir(agentId), 'agents');
}

// ---------------------------------------------------------------------------
// Output rendering — keep deterministic so byte-diff is meaningful
// ---------------------------------------------------------------------------

interface SettingsJson {
  /** ptah profile (R2 allowlist). */
  profile: 'claude_code' | 'enhanced';
  /** Plugin ids ptah loads at session start. */
  enabledPluginIds: string[];
  /** MCP servers materialized from the orchestration tier. */
  mcpServers: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  >;
}

function renderSettings(agentId: string, harness: HarnessConfig | null): string {
  const enabledPluginIds = new Set<string>([`openclaw-${agentId}-harness`]);
  const mcpServers: SettingsJson['mcpServers'] = {};
  let profile: SettingsJson['profile'] = 'claude_code';

  if (harness) {
    const tier = harness.orchestrationTier;
    if (tier.modelTier === 'enhanced' || tier.modelTier === 'claude_code') {
      profile = tier.modelTier;
    }
    if (tier.enabledPluginIds) {
      for (const id of tier.enabledPluginIds) enabledPluginIds.add(id);
    }
    for (const spec of tier.mcpServers) {
      const entry: SettingsJson['mcpServers'][string] = { command: spec.command };
      if (spec.args && spec.args.length > 0) entry.args = [...spec.args];
      if (spec.env && Object.keys(spec.env).length > 0) entry.env = { ...spec.env };
      if (typeof spec.timeoutMs === 'number') entry.timeoutMs = spec.timeoutMs;
      mcpServers[spec.id] = entry;
    }
  }

  const out: SettingsJson = {
    profile,
    enabledPluginIds: [...enabledPluginIds].sort(),
    mcpServers,
  };
  return JSON.stringify(out, null, 2) + '\n';
}

interface PluginManifestJson {
  name: string;
  version: string;
  description: string;
}

function renderPluginManifest(agentId: string): string {
  const manifest: PluginManifestJson = {
    name: `openclaw-${agentId}-harness`,
    version: '1.0.0',
    description: `Per-agent harness plugin for openclaw persona "${agentId}". ` +
      `Generated by openclaw-control daemon — do not edit by hand.`,
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Render the per-subagent markdown file with frontmatter shape
 * `name / description / tools`. Frontmatter uses YAML-flow style for
 * deterministic byte output (no library round-trip surprises).
 */
function renderSubagentMd(sub: SubagentDef): string {
  const lines: string[] = ['---', `name: ${sub.name}`];
  // Description may have colons/quotes; emit as a JSON-quoted string to
  // remain unambiguously parseable.
  lines.push(`description: ${JSON.stringify(sub.description)}`);
  if (sub.tools && sub.tools.length > 0) {
    const flow = sub.tools.map((t) => JSON.stringify(t)).join(', ');
    lines.push(`tools: [${flow}]`);
  }
  lines.push('---', '', sub.systemPrompt.trimEnd(), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// FS write helpers — every writeFile is preceded by assertMaterializedPathSafety
// ---------------------------------------------------------------------------

/**
 * Read existing file (if present) and compare bytes with `next`. Writes
 * only on diff. Returns whether the file changed.
 *
 * IMPORTANT: assertMaterializedPathSafety is called HERE before every
 * fs.writeFile (verification 11). Callers do not need to repeat the
 * assertion.
 */
async function writeIfChanged(absPath: string, next: string): Promise<boolean> {
  assertMaterializedPathSafety(absPath);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  if (existing === next) return false;
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, next, 'utf8');
  return true;
}

/**
 * Remove obsolete subagent files. Any file in the plugin's agents dir not
 * in `keepNames` is unlinked so re-materialization after a harness edit
 * doesn't leave stale subagent definitions on disk.
 */
async function pruneStaleSubagents(
  agentId: string,
  keepNames: ReadonlySet<string>,
): Promise<boolean> {
  const dir = pluginAgentsDir(agentId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
  let changed = false;
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const base = name.slice(0, -'.md'.length);
    if (keepNames.has(base)) continue;
    const target = path.join(dir, name);
    assertMaterializedPathSafety(target);
    await fs.unlink(target);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the agent's harness.yaml from shared memory. Returns the parsed
 * HarnessConfig, or null when no row exists (backwards-compat path).
 *
 * PRIVATE_AGENT_FILES never enter the shared `memory_files` table by
 * construction (db/memory.ts:assertNotPrivate), so MemoryRepo.read with
 * `harness.yaml` is safe — it's a public file.
 */
async function readHarnessConfig(agentId: string): Promise<HarnessConfig | null> {
  // Defensive: harness.yaml is NOT private, but a future maintainer could
  // accidentally extend PRIVATE_AGENT_FILES. Refuse to read through this
  // helper if `harness.yaml` ever gets routed private.
  if (PRIVATE_AGENT_FILES.has('harness.yaml')) {
    throw new Error('materialize: harness.yaml routed private — invariant violated');
  }
  const row = MemoryRepo.read('agents', agentId, 'harness.yaml');
  if (!row) return null;
  try {
    return parseHarnessYaml(row.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`materialize: failed to parse harness.yaml for "${agentId}": ${msg}`);
  }
}

/**
 * Materialize one persona's harness.yaml → on-disk ptah config.
 *
 * If the persona has no harness.yaml, emit a default settings.json (and
 * an empty plugin scaffold) so dispatch keeps working byte-equivalent for
 * unconfigured personas (impl-plan line 494, "Backwards compat").
 */
export async function materializeAgent(agentId: string): Promise<MaterializeResult> {
  if (!agentId || !/^[A-Za-z0-9_\-.]+$/.test(agentId)) {
    throw new Error(`materialize: invalid agentId "${agentId}"`);
  }

  const harness = await readHarnessConfig(agentId);

  const settingsPath = agentSettingsPath(agentId);
  const pluginDir = agentPluginDir(agentId);
  const manifestPath = pluginManifestPath(agentId);

  let changed = false;

  // 1) settings.json (always written; default for personas without harness.yaml).
  const settingsBody = renderSettings(agentId, harness);
  if (await writeIfChanged(settingsPath, settingsBody)) changed = true;

  // 2) Plugin manifest (always written; even unconfigured personas get an
  //    empty plugin scaffold so ptah's enabledPluginIds reference is valid).
  const manifestBody = renderPluginManifest(agentId);
  if (await writeIfChanged(manifestPath, manifestBody)) changed = true;

  // 3) Per-subagent files for the orchestration tier. Subagent set is
  //    sourced from `orchestrationTier.subagents` per impl-plan §"Materialization
  //    (Phase 2)" — these are the files ptah loads when dispatching heavy
  //    runs, distinct from the chat-tier subagents (which live in-memory in
  //    bot-bridge, never on disk).
  const subagents: SubagentDef[] = harness?.orchestrationTier.subagents ?? [];
  const keepNames = new Set<string>();
  for (const sub of subagents) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sub.name)) {
      throw new Error(
        `materialize: invalid subagent name "${sub.name}" for agent "${agentId}" — must match /^[a-zA-Z0-9_-]+$/`,
      );
    }
    keepNames.add(sub.name);
    const target = path.join(pluginAgentsDir(agentId), `${sub.name}.md`);
    if (await writeIfChanged(target, renderSubagentMd(sub))) changed = true;
  }

  // 4) Drop subagent files that are no longer in the harness.
  if (await pruneStaleSubagents(agentId, keepNames)) changed = true;

  return {
    agentId,
    settingsPath,
    pluginDir,
    changed,
    summary: {
      settingsBytes: Buffer.byteLength(settingsBody, 'utf8'),
      pluginAgentsCount: subagents.length,
    },
  };
}

/**
 * Materialize every persona that has a row in shared memory PLUS every
 * persona this machine owns (so unconfigured local agents still get the
 * default settings.json — backwards compat).
 *
 * Best-effort across personas: a parse error for one persona does not
 * abort the others; the exception is wrapped per-agent and swallowed with
 * a console.warn so a single misshapen harness.yaml can't keep the whole
 * dispatch tier offline. Callers that want strictness should call
 * `materializeAgent(id)` directly.
 */
export async function materializeAll(): Promise<MaterializeResult[]> {
  const ids = new Set<string>();
  for (const id of config.localAgentIds) ids.add(id);
  for (const meta of MemoryRepo.list('agents')) {
    if (meta.filename === 'harness.yaml') ids.add(meta.ownerId);
  }

  const results: MaterializeResult[] = [];
  for (const id of [...ids].sort()) {
    try {
      results.push(await materializeAgent(id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[materialize] agent="${id}" skipped: ${msg}`);
    }
  }
  return results;
}
