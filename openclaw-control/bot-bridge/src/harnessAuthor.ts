// harnessAuthor.ts — chat-tier harness-authoring tool surface (TASK_2026_002 B7).
//
// When the operator says "set up the harness for this project", the persona's
// `start_harness_setup` tool flips `ctx.state.harnessSetup = { project, stage:
// 'probing', startedAt: Date.now() }` and returns the `HARNESS_AUTHOR_SYSTEM_PROMPT`
// body. `chat.ts` notices the state on the next message and REPLACES the tool
// registry (not a merge — impl-plan line 1068) with `tools(ctx.state)` so the
// LLM stays focused on the 5 authoring tools below.
//
// State machine (kept in `ctx.state.harnessSetup`):
//   { project, stage: 'probing', startedAt }
//     → propose_harness writes ctx.state.harnessSetup.proposed (still 'probing')
//     → confirm_harness flips stage to 'awaiting-operator-confirmation'
//     → operator types "yes" → chat.ts flips stage to 'writing'
//     → write_harness_file commits to <project>/.claude/harness.yaml
//   At any point the operator can say "no" (revert to 'probing', clear proposed)
//   or "cancel harness setup" (clear all state).
//
// Tools (exactly 5, matching impl-plan lines 1000–1028):
//   probe_project()         — bounded ls + framework-marker scan (200-entry cap)
//   read_file(path)         — bounded file read (100 KB cap), rejects '..'/abs
//   propose_harness(yaml)   — parseHarnessYaml validation; stores on success
//   confirm_harness()       — flips stage to await operator yes/no
//   write_harness_file()    — gated on stage='writing'; calls daemon POST files
//
// Constraints (impl-plan lines 1049–1052 + B8 CI grep):
//   - NO `wizard:*` calls. NO `harness:analyze-intent`.
//   - Subagent tool subsets must reference real parent-registry tools (the
//     LLM is responsible for this; we don't enforce here, only validate the
//     yaml shape via parseHarnessYaml).

import { posix as posixPath } from 'node:path';
import path from 'node:path';
import { daemon } from './daemonClient.js';
import { parseHarnessYaml, type HarnessConfig } from './harness/types.js';
import type { ToolDef, ToolCallContext } from './llm.js';

// ---------------------------------------------------------------------------
// State helpers — `ctx.state.harnessSetup` is the single source of truth.
// ---------------------------------------------------------------------------

export type HarnessAuthorStage =
  | 'probing'
  | 'awaiting-operator-confirmation'
  | 'writing';

export interface HarnessAuthorState {
  /** Project slug being authored against. */
  project: string;
  /** Resolved absolute project path, cached on first probe. Used for `read_file`'s
   *  containment check. We resolve on demand via `daemon.listProjects()` rather
   *  than passing it through `start_harness_setup` — keeps the entry-mode tool
   *  parameter surface tiny. */
  projectPath?: string;
  /** Current state-machine stage. */
  stage: HarnessAuthorStage;
  /** ms-since-epoch when start_harness_setup fired. chat.ts uses this for the
   *  30-min idle auto-clear (impl-plan line 1056). */
  startedAt: number;
  /** The yaml proposal the LLM has staged — populated by propose_harness on a
   *  successful parse. Cleared on operator "no". */
  proposed?: { yaml: string; config: HarnessConfig };
}

export const HARNESS_SETUP_STATE_KEY = 'harnessSetup';

/**
 * Read-modify-write helper for the harness-author state slot.
 *
 * `ctx.state` is a plain Map whose values are `unknown` — we cast at the
 * boundary and validate the shape on every read so a corrupted state value
 * (e.g. bot-bridge restart with stale fixtures) surfaces immediately
 * instead of producing a silent partial state machine.
 */
function readState(state: Map<string, unknown>): HarnessAuthorState {
  const raw = state.get(HARNESS_SETUP_STATE_KEY);
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'harness-author: ctx.state.harnessSetup missing — call start_harness_setup first.',
    );
  }
  const v = raw as Partial<HarnessAuthorState>;
  if (typeof v.project !== 'string' || v.project.length === 0) {
    throw new Error('harness-author: ctx.state.harnessSetup.project is invalid');
  }
  if (
    v.stage !== 'probing' &&
    v.stage !== 'awaiting-operator-confirmation' &&
    v.stage !== 'writing'
  ) {
    throw new Error(`harness-author: invalid stage "${v.stage}"`);
  }
  if (typeof v.startedAt !== 'number' || !Number.isFinite(v.startedAt)) {
    throw new Error('harness-author: ctx.state.harnessSetup.startedAt is invalid');
  }
  return v as HarnessAuthorState;
}

function writeState(state: Map<string, unknown>, next: HarnessAuthorState): void {
  state.set(HARNESS_SETUP_STATE_KEY, next);
}

// ---------------------------------------------------------------------------
// System prompt — exact body from impl-plan lines 1032–1053. The
// `start_harness_setup` tool returns this prefixed with the entry-mode
// message described at lines 996–998.
// ---------------------------------------------------------------------------

export const HARNESS_AUTHOR_SYSTEM_PROMPT = [
  "You are <agent.name> in HARNESS-AUTHORING MODE for project '<slug>' (path: <project.path>).",
  '',
  'Your goal: compose a <project>/.claude/harness.yaml that captures the skills, subagents,',
  "and MCP servers this project needs. The harness has two tiers (chat-tier loaded by",
  "openclaw-control's bot-bridge; orchestration-tier loaded by ptah for dispatch).",
  '',
  'Process (strict):',
  '1. Use `probe_project` and `read_file` to understand the project.',
  '2. Use `propose_harness` to draft a harness.yaml. The schema is HarnessConfig — see',
  '   shared-specs/memory/templates/harness-template.yaml for the canonical shape.',
  '3. Show the operator your proposal and explain your choices.',
  '4. Use `confirm_harness` to ask the operator to approve.',
  '5. After "yes", use `write_harness_file` to commit it.',
  '',
  'If the operator says "no" or asks you to revise, go back to step 2.',
  '',
  'Constraints:',
  '- ONLY use community-tier ptah RPCs. Do not call wizard:* or harness:analyze-intent.',
  "- Subagent tool subsets must reference real tools from the parent persona's effective registry.",
  '- MCP server commands must be runnable on this host (assume container env).',
].join('\n');

// ---------------------------------------------------------------------------
// Probe helpers — bounded directory listing + framework-marker scan +
// package.json digest + README first-80-lines + git remote.
// ---------------------------------------------------------------------------

/** Hard caps. Bounded by impl-plan §"Tool surface" lines 1003–1011. */
const PROBE_MAX_ENTRIES = 200;
const PROBE_README_MAX_LINES = 80;
const READ_FILE_MAX_BYTES = 100 * 1024; // 100 KB cap (impl-plan line 1011)

/** Directory names the probe never descends into — matches impl-plan line 1007. */
const PROBE_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist']);

/** Existence checks we perform after the top-level listing. */
const FRAMEWORK_MARKERS: readonly string[] = [
  'angular.json',
  'nx.json',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'nuxt.config.js',
  'nuxt.config.ts',
  'svelte.config.js',
  'remix.config.js',
  'vite.config.js',
  'vite.config.ts',
  'astro.config.mjs',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Dockerfile',
  'docker-compose.yml',
  '.github/workflows',
];

interface PackageJsonDigest {
  name?: string;
  version?: string;
  description?: string;
  scripts: string[];
  dependencies: string[];
  devDependencies: string[];
}

/**
 * Resolve `project.path` for a slug by reading the listProjects snapshot
 * (which already includes `path` — see daemon storage.ts:96–113). Cached on
 * the harness-author state slot to avoid the round-trip on every probe.
 *
 * Returns the absolute project path. Throws if the slug is unknown — that
 * should be impossible if start_harness_setup succeeded, but we surface a
 * meaningful error rather than `undefined.charAt(...)`.
 */
async function resolveProjectPath(
  state: HarnessAuthorState,
  ctxState: Map<string, unknown>,
): Promise<string> {
  if (state.projectPath) return state.projectPath;
  const projects = await daemon.listProjects();
  const found = projects.find((p) => (p as { slug?: string }).slug === state.project) as
    | { slug?: string; path?: string }
    | undefined;
  if (!found || typeof found.path !== 'string' || found.path.length === 0) {
    throw new Error(
      `harness-author: project "${state.project}" has no resolved workspace path on the daemon`,
    );
  }
  state.projectPath = found.path;
  writeState(ctxState, state);
  return found.path;
}

function summarizePackageJson(text: string): PackageJsonDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const scripts =
    p.scripts && typeof p.scripts === 'object' && !Array.isArray(p.scripts)
      ? Object.keys(p.scripts as Record<string, unknown>)
      : [];
  const dependencies =
    p.dependencies && typeof p.dependencies === 'object' && !Array.isArray(p.dependencies)
      ? Object.keys(p.dependencies as Record<string, unknown>)
      : [];
  const devDependencies =
    p.devDependencies &&
    typeof p.devDependencies === 'object' &&
    !Array.isArray(p.devDependencies)
      ? Object.keys(p.devDependencies as Record<string, unknown>)
      : [];
  const out: PackageJsonDigest = { scripts, dependencies, devDependencies };
  if (typeof p.name === 'string') out.name = p.name;
  if (typeof p.version === 'string') out.version = p.version;
  if (typeof p.description === 'string') out.description = p.description;
  return out;
}

function renderPackageDigest(d: PackageJsonDigest | null): string {
  if (!d) return '_(package.json present but unparseable)_';
  const head =
    d.name || d.version
      ? `**${d.name ?? '?'}** v${d.version ?? '?'}` +
        (d.description ? ` — ${d.description}` : '')
      : '_(no name/version in package.json)_';
  const sc = d.scripts.length ? `scripts: \`${d.scripts.join('`, `')}\`` : '_(no scripts)_';
  const deps = d.dependencies.length
    ? `dependencies (${d.dependencies.length}): \`${d.dependencies.slice(0, 30).join('`, `')}\`` +
      (d.dependencies.length > 30 ? ` … (+${d.dependencies.length - 30} more)` : '')
    : '_(no runtime dependencies)_';
  const devDeps = d.devDependencies.length
    ? `devDependencies (${d.devDependencies.length}): \`${d.devDependencies
        .slice(0, 20)
        .join('`, `')}\`` +
      (d.devDependencies.length > 20 ? ` … (+${d.devDependencies.length - 20} more)` : '')
    : '_(no devDependencies)_';
  return [head, sc, deps, devDeps].join('\n');
}

// ---------------------------------------------------------------------------
// Path validation for `read_file` — mirrors daemon's `safeProjectPath`
// (api.ts:52). The daemon will re-validate; this is a defense-in-depth check
// so the LLM gets a clean error message immediately on bogus input rather
// than a 400 from across the wire.
// ---------------------------------------------------------------------------

function validateReadPath(projectPath: string, rel: string): { ok: true; resolved: string } | { ok: false; error: string } {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  if (rel.startsWith('/')) {
    return { ok: false, error: "absolute paths are forbidden — use a project-relative path" };
  }
  // Mirror daemon's POSIX-only segment scan (we run in a Linux container).
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { ok: false, error: 'path traversal segment ".." is forbidden' };
    }
  }
  const resolved = path.resolve(projectPath, rel);
  const root = path.resolve(projectPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, error: 'resolved path escapes project root' };
  }
  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Tool handlers.
// ---------------------------------------------------------------------------

async function handleProbeProject(_args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  const state = readState(ctx.state);
  const projectPath = await resolveProjectPath(state, ctx.state);

  // 1. Top-level listing (bounded). The daemon's GET /api/projects/:slug/files
  //    returns FILES only (`if (!e.isFile()) continue` on api.ts:824), so for
  //    directory awareness we list the prefix and supplement with a
  //    framework-marker existence-check fan-out for subdirs we care about.
  let topFiles: Awaited<ReturnType<typeof daemon.listProjectFiles>>;
  try {
    topFiles = await daemon.listProjectFiles(state.project, '');
  } catch (err) {
    return `Probe failed: ${(err as Error).message ?? String(err)}`;
  }
  const truncated = topFiles.length > PROBE_MAX_ENTRIES;
  const shown = truncated ? topFiles.slice(0, PROBE_MAX_ENTRIES) : topFiles;
  // Sort already happens daemon-side; re-sort defensively to make the output
  // stable across daemon versions.
  shown.sort((a, b) => a.path.localeCompare(b.path));
  const lsLines = shown.map((f) => `- \`${f.path}\` (${f.size} bytes)`);
  if (truncated) {
    lsLines.push(`_(showing first ${PROBE_MAX_ENTRIES} of ${topFiles.length} files)_`);
  }

  // The daemon's listing is non-recursive and excludes directories, so we
  // surface "skipped" directory names (informational only — chokidar/fast-glob
  // boundaries already prevent descent into them on the daemon side; this
  // line is purely so the LLM doesn't go fishing for `node_modules/`).
  const skipNote = `_(probe skips: ${[...PROBE_SKIP_DIRS].join(', ')}; max ${PROBE_MAX_ENTRIES} entries)_`;

  // 2. package.json digest if present.
  const hasPackageJson = topFiles.some((f) => f.path === 'package.json');
  let pkgBlock = '_(no package.json at project root)_';
  if (hasPackageJson) {
    try {
      const pkg = await daemon.readProjectFile(state.project, 'package.json');
      pkgBlock = pkg ? renderPackageDigest(summarizePackageJson(pkg.content)) : '_(package.json missing)_';
    } catch (err) {
      pkgBlock = `_(package.json read failed: ${(err as Error).message ?? String(err)})_`;
    }
  }

  // 3. Framework markers — existence check via prefix listing for nested
  //    directories (.github/workflows) and the top-level listing for files.
  const topNames = new Set(topFiles.map((f) => f.path));
  const detectedMarkers: string[] = [];
  for (const marker of FRAMEWORK_MARKERS) {
    if (marker.includes('/')) {
      // Nested marker (e.g. .github/workflows). The daemon endpoint lists files
      // under a prefix; treat "any entries" as "marker present".
      try {
        const dirEntries = await daemon.listProjectFiles(state.project, marker);
        if (dirEntries.length > 0) detectedMarkers.push(marker);
      } catch {
        // 404 → not present. Swallow per-marker errors so one missing marker
        // doesn't kill the whole probe.
      }
    } else {
      if (topNames.has(marker)) detectedMarkers.push(marker);
    }
  }
  const markersBlock = detectedMarkers.length
    ? `Detected: ${detectedMarkers.map((m) => `\`${m}\``).join(', ')}`
    : '_(no framework markers detected)_';

  // 4. README.md first 80 lines.
  let readmeBlock = '_(no README.md at project root)_';
  if (topNames.has('README.md')) {
    try {
      const readme = await daemon.readProjectFile(state.project, 'README.md');
      if (readme) {
        const lines = readme.content.split('\n').slice(0, PROBE_README_MAX_LINES);
        readmeBlock = '```markdown\n' + lines.join('\n') + '\n```' +
          (readme.content.split('\n').length > PROBE_README_MAX_LINES
            ? `\n_(README truncated to first ${PROBE_README_MAX_LINES} lines)_`
            : '');
      }
    } catch (err) {
      readmeBlock = `_(README read failed: ${(err as Error).message ?? String(err)})_`;
    }
  }

  // 5. git remote — best-effort read of `.git/config`. The daemon's
  //    `safeProjectPath` allows reading inside `.git/` (it's a regular file
  //    under the project root); the probe deliberately doesn't *write* there.
  //    We parse the first `[remote "origin"] url = ...` line.
  let remoteBlock = '_(no .git/config readable)_';
  try {
    const gitConfig = await daemon.readProjectFile(state.project, '.git/config');
    if (gitConfig) {
      const remote = parseGitConfigOriginUrl(gitConfig.content);
      remoteBlock = remote ? `origin: \`${remote}\`` : '_(no `[remote "origin"]` in .git/config)_';
    }
  } catch {
    // .git/config absent or unreadable — leave the default message.
  }

  return [
    `# Project probe — \`${state.project}\` (path: \`${projectPath}\`)`,
    '',
    '## Top-level files',
    skipNote,
    lsLines.length ? lsLines.join('\n') : '_(empty project root)_',
    '',
    '## package.json digest',
    pkgBlock,
    '',
    '## Framework markers',
    markersBlock,
    '',
    '## git remote',
    remoteBlock,
    '',
    '## README.md (first ' + String(PROBE_README_MAX_LINES) + ' lines)',
    readmeBlock,
  ].join('\n');
}

/**
 * Parse the `url =` value under `[remote "origin"]` in a .git/config file.
 * Returns null if the section is missing. Tolerant of indentation.
 */
function parseGitConfigOriginUrl(text: string): string | null {
  const lines = text.split('\n');
  let inOrigin = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[remote\s+"origin"\]\s*$/.test(line)) {
      inOrigin = true;
      continue;
    }
    if (line.startsWith('[')) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const m = /^url\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

async function handleReadFile(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<string> {
  const state = readState(ctx.state);
  const relativePath = args.relativePath ?? args.path;
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return 'read_file error: required argument "relativePath" must be a non-empty string';
  }
  const projectPath = await resolveProjectPath(state, ctx.state);
  const validation = validateReadPath(projectPath, relativePath);
  if (!validation.ok) {
    return `read_file error: ${validation.error}`;
  }
  // Normalize via posix rejoin so the daemon receives a path identical in
  // shape to what its safeProjectPath validator expects (POSIX, no leading /).
  const normalized = posixPath.normalize(relativePath.replace(/\\/g, '/'));
  let result;
  try {
    result = await daemon.readProjectFile(state.project, normalized);
  } catch (err) {
    return `read_file error: ${(err as Error).message ?? String(err)}`;
  }
  if (!result) {
    return `read_file: \`${normalized}\` not found`;
  }
  if (result.sizeBytes > READ_FILE_MAX_BYTES) {
    // Daemon's PROJECT_FILE_MAX_BYTES (1 MB at the time of writing) is bigger
    // than ours; if it ever drops below 100 KB the daemon would 413 first.
    // We still cap defensively here.
    return `read_file error: file exceeds ${READ_FILE_MAX_BYTES} byte cap (got ${result.sizeBytes} bytes)`;
  }
  return [
    `\`${normalized}\` (${result.sizeBytes} bytes, mtime ${result.mtime}):`,
    '```',
    result.content,
    '```',
  ].join('\n');
}

async function handleProposeHarness(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<string> {
  const state = readState(ctx.state);
  const yamlText = args.yaml;
  if (typeof yamlText !== 'string' || yamlText.length === 0) {
    return 'propose_harness error: required argument "yaml" must be a non-empty string containing the harness yaml body';
  }
  let parsed: HarnessConfig;
  try {
    parsed = parseHarnessYaml(yamlText);
  } catch (err) {
    // Surface the parse error verbatim so the LLM sees exactly what failed
    // (parseHarnessYaml emits path-prefixed messages like "harness.chatTier.skills[0]: ...").
    const msg = (err as Error).message ?? String(err);
    return `propose_harness rejected — fix the yaml and retry:\n${msg}`;
  }
  // Stash on success so confirm_harness + write_harness_file can find it.
  const next: HarnessAuthorState = { ...state, proposed: { yaml: yamlText, config: parsed } };
  writeState(ctx.state, next);
  return renderProposalDigest(parsed);
}

function renderProposalDigest(c: HarnessConfig): string {
  const ct = c.chatTier;
  const ot = c.orchestrationTier;
  const subagentNames = (tier: typeof ct) =>
    tier.subagents.length
      ? tier.subagents.map((s) => `\`${s.name}\``).join(', ')
      : '_(none)_';
  const mcpIds = (tier: typeof ct) =>
    tier.mcpServers.length ? tier.mcpServers.map((m) => `\`${m.id}\``).join(', ') : '_(none)_';
  return [
    '# Harness proposal',
    '',
    '## Chat tier',
    `- skills (${ct.skills.length}): ${ct.skills.length ? ct.skills.map((s) => `\`${s}\``).join(', ') : '_(none)_'}`,
    `- subagents (${ct.subagents.length}): ${subagentNames(ct)}`,
    `- mcpServers (${ct.mcpServers.length}): ${mcpIds(ct)}`,
    '',
    '## Orchestration tier',
    `- skills (${ot.skills.length}): ${ot.skills.length ? ot.skills.map((s) => `\`${s}\``).join(', ') : '_(none)_'}`,
    `- subagents (${ot.subagents.length}): ${subagentNames(ot)}`,
    `- mcpServers (${ot.mcpServers.length}): ${mcpIds(ot)}`,
    `- modelTier: \`${ot.modelTier ?? 'claude_code'}\``,
    `- enabledPluginIds: ${ot.enabledPluginIds && ot.enabledPluginIds.length ? ot.enabledPluginIds.map((p) => `\`${p}\``).join(', ') : '_(none)_'}`,
    '',
    '_Proposal stored. Use `confirm_harness` to ask the operator to approve before writing._',
  ].join('\n');
}

async function handleConfirmHarness(
  _args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<string> {
  const state = readState(ctx.state);
  if (!state.proposed) {
    return 'confirm_harness error: no proposed harness to confirm — call propose_harness first.';
  }
  if (state.stage === 'writing') {
    return 'confirm_harness error: stage is already "writing" — call write_harness_file to commit.';
  }
  writeState(ctx.state, { ...state, stage: 'awaiting-operator-confirmation' });
  return [
    'Stage flipped to **awaiting-operator-confirmation**.',
    '',
    'STOP generating tool calls now. End your reply by asking the operator,',
    'verbatim: _"Reply **yes** to write `<project>/.claude/harness.yaml`, **no** to revise,',
    'or **cancel harness setup** to abort."_',
  ].join('\n');
}

async function handleWriteHarnessFile(
  _args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<string> {
  const state = readState(ctx.state);
  if (state.stage !== 'writing') {
    return (
      `write_harness_file error: stage is "${state.stage}", not "writing". ` +
      'Call confirm_harness and wait for the operator to type "yes" before writing.'
    );
  }
  if (!state.proposed) {
    // Debug-friendly error so the test failure mode is unambiguous: a stage
    // of 'writing' should never coexist with a missing proposal — that's a
    // chat.ts persistence bug, not an LLM mistake.
    return 'write_harness_file error: no proposed harness to write — call propose_harness first.';
  }
  try {
    const result = await daemon.writeProjectFile(
      state.project,
      '.claude/harness.yaml',
      state.proposed.yaml,
    );
    return JSON.stringify({
      ok: result.ok,
      project: state.project,
      path: '.claude/harness.yaml',
      sizeBytes: result.sizeBytes,
    });
  } catch (err) {
    return `write_harness_file error: ${(err as Error).message ?? String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Tool registry — exactly 5 tools, returned in author-flow order so the LLM
// sees them in a useful sequence in its function-list view.
// ---------------------------------------------------------------------------

/**
 * Build the harness-author tool registry. `state` is `ctx.state` (a Map);
 * we close over it the same way subagentTools does so each tool handler can
 * mutate the shared slot without needing the runtime ToolCallContext at
 * registry build time.
 *
 * Pure function. chat.ts may call this on every inbound message — the cost
 * is allocating 5 closure objects, no I/O.
 */
export function tools(_state: Map<string, unknown>): ToolDef[] {
  return [
    {
      name: 'probe_project',
      description:
        "Probe the harness-author's target project. Returns a markdown summary: bounded directory listing, package.json digest if present, detected framework markers (angular.json/nx.json/next.config/etc.), git remote, and the first 80 lines of README.md. Run this first to understand the project.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: handleProbeProject,
    },
    {
      name: 'read_file',
      description:
        'Read a single file inside the target project. The path is project-relative (no leading `/`, no `..` segments). Capped at 100 KB.',
      parameters: {
        type: 'object',
        properties: {
          relativePath: {
            type: 'string',
            description: 'Project-relative path (e.g. `package.json`, `src/index.ts`).',
          },
        },
        required: ['relativePath'],
        additionalProperties: false,
      },
      handler: handleReadFile,
    },
    {
      name: 'propose_harness',
      description:
        'Propose a harness.yaml body. The yaml is parsed and validated against HarnessConfig (chatTier + orchestrationTier; skills, subagents, mcpServers each tier). On invalid yaml, returns a path-prefixed error so you can fix and retry. On success, stages the proposal and returns a markdown digest for the operator.',
      parameters: {
        type: 'object',
        properties: {
          yaml: {
            type: 'string',
            description:
              'Full harness.yaml body as a single string. Must be valid HarnessConfig (version: 1, chatTier, orchestrationTier).',
          },
        },
        required: ['yaml'],
        additionalProperties: false,
      },
      handler: handleProposeHarness,
    },
    {
      name: 'confirm_harness',
      description:
        'Flip the conversation into "awaiting operator confirmation". After calling this, STOP generating tool calls and end your reply asking the operator to type "yes" or "no". The operator\'s next message will be interpreted by the chat layer as the answer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: handleConfirmHarness,
    },
    {
      name: 'write_harness_file',
      description:
        'Write the staged proposal to `<project>/.claude/harness.yaml`. Only callable after confirm_harness AND after the operator has answered "yes" (the chat layer flips the stage to "writing" on a yes). Returns JSON with the byte size on success.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: handleWriteHarnessFile,
    },
  ];
}

/**
 * Entry-mode message returned by `start_harness_setup` ahead of the system
 * prompt body. Kept as a separate exported builder so daemonTools.ts and the
 * tests can compose the exact string the impl-plan §"Harness-authoring chat"
 * lines 996–998 demand.
 */
export function entryModeMessage(slug: string): string {
  return (
    `You are now in harness-authoring mode for project '${slug}'. ` +
    'Use the harness-authoring tools to compose a harness, then ask the operator to confirm before writing.'
  );
}
