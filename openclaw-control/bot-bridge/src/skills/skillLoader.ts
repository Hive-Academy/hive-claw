// skills/skillLoader.ts — TASK_2026_002 B3 native skill loader.
//
// Reads `<skillsRoot>/<name>/SKILL.md` for each skill listed in a persona's
// `harness.yaml.chatTier.skills`, parses the gray-matter frontmatter, and
// returns a `LoadedSkill` whose `body` gets injected verbatim into the
// chat-tier system prompt by `chat.ts:buildSystemPrompt` (impl-plan §"Native
// skill loading" lines 964–982).
//
// Hard rule from the impl-plan: this loader is **fail-open**. A missing or
// malformed skill must NOT throw — it returns `null` plus a console warning
// so a busted skill never takes a persona offline. The system-prompt
// assembler filters nulls before stitching.
//
// Default skillsRoot resolves from `config.skillsRoot` (env
// `OPENCLAW_SKILLS_ROOT`, defaults to `/home/agent/skills` in-container or the
// repo's `skills/` in dev). Tests pass an explicit override.

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';

export interface LoadedSkill {
  /** Skill name as listed in harness.yaml — equals the directory name. */
  name: string;
  /**
   * Optional one-line summary from `description:` in the SKILL.md frontmatter.
   * Documentation-only — not enforced and not injected into the prompt
   * (the body is what shapes the model's behavior).
   */
  description?: string;
  /** SKILL.md content with frontmatter stripped. Injected verbatim into the system prompt. */
  body: string;
  /** Absolute path the file was read from — useful in logs and tests. */
  source: string;
}

export interface LoadSkillOptions {
  /**
   * Absolute path to the directory containing `<name>/SKILL.md`. Defaults to
   * `config.skillsRoot`. Tests pass a tempdir override.
   */
  skillsRoot?: string;
}

/**
 * Load a single skill from `<skillsRoot>/<name>/SKILL.md`.
 *
 * Returns `null` (not throws) when:
 *   - the file is missing (ENOENT) — common on fresh installs / typo'd skill name
 *   - the frontmatter is malformed — `gray-matter` throws on bad YAML
 *   - any other read error occurs
 *
 * In all `null` cases a `console.warn` records the reason so operators can see
 * why a skill silently dropped from a persona's prompt.
 */
export async function loadSkill(
  name: string,
  opts: LoadSkillOptions = {},
): Promise<LoadedSkill | null> {
  const root = opts.skillsRoot ?? config.skillsRoot;
  const source = path.join(root, name, 'SKILL.md');

  let raw: string;
  try {
    raw = await fs.readFile(source, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      console.warn(`[skills] skill "${name}" missing at ${source} — skipping`);
    } else {
      console.warn(`[skills] failed to read skill "${name}" at ${source}: ${e?.message ?? e}`);
    }
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] skill "${name}" has malformed frontmatter at ${source}: ${msg}`);
    return null;
  }

  const description =
    typeof (parsed.data as Record<string, unknown>)?.description === 'string'
      ? ((parsed.data as Record<string, unknown>).description as string)
      : undefined;

  return {
    name,
    description,
    body: parsed.content,
    source,
  };
}

/**
 * Load every skill in `names`, in declaration order, dropping any that fail.
 *
 * Duplicate names are deduped (first wins) per impl-plan §"Native skill
 * loading" line 989: "Skills can't override each other; they're concatenated."
 * A duplicate name is logged as a warning so authors notice the dedup.
 */
export async function loadSkills(
  names: readonly string[],
  opts: LoadSkillOptions = {},
): Promise<LoadedSkill[]> {
  const seen = new Set<string>();
  const out: LoadedSkill[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      console.warn(`[skills] duplicate skill "${name}" in harness — keeping first occurrence`);
      continue;
    }
    seen.add(name);
    const skill = await loadSkill(name, opts);
    if (skill) out.push(skill);
  }
  return out;
}
