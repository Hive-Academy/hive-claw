/**
 * skill-loader — pins TASK_2026_002 B3 sub-task 1 contract.
 *
 * Verifies the three documented paths through `loadSkill` / `loadSkills`:
 *
 *  1. Known-good skill: the SKILL.md frontmatter is parsed, `description`
 *     surfaces, and the body is returned verbatim (no frontmatter delimiters
 *     leaked).
 *  2. Missing file: `loadSkill` returns null and emits a warning containing
 *     the skill name.
 *  3. Malformed frontmatter: gray-matter throws → `loadSkill` returns null
 *     and the warning contains the skill name.
 *
 * Plus: `loadSkills` returns the surviving skills in declaration order, drops
 * nulls, and dedupes duplicate names with a warning.
 *
 * The skillsRoot is a per-test tempdir — config.skillsRoot is not touched.
 */

// Env vars must land before any import that transitively reads config.ts.
// ESM hoists imports above non-import statements, so we use dynamic
// imports below for any module that pulls in `../src/config.ts`.
process.env.OPENCLAW_INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? 'test-internal';
process.env.REDIS_URL = '';

import { test, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let loadSkill: typeof import('../src/skills/skillLoader.ts').loadSkill;
let loadSkills: typeof import('../src/skills/skillLoader.ts').loadSkills;

before(async () => {
  ({ loadSkill, loadSkills } = await import('../src/skills/skillLoader.ts'));
});

let SKILLS_ROOT: string;
let warns: string[];
let origWarn: typeof console.warn;

beforeEach(() => {
  SKILLS_ROOT = mkdtempSync(join(tmpdir(), 'skill-loader-'));
  warns = [];
  origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
});

afterEach(() => {
  console.warn = origWarn;
  rmSync(SKILLS_ROOT, { recursive: true, force: true });
});

function writeSkill(name: string, contents: string): string {
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, contents, 'utf8');
  return file;
}

test('skill-loader: known-good skill loads with frontmatter parsed and body verbatim', async () => {
  const body = '# Simplify\n\nReview changed code for reuse, quality, and efficiency.\n';
  const expected = writeSkill(
    'simplify',
    `---\nname: simplify\ndescription: Review changed code for reuse.\n---\n${body}`,
  );

  const skill = await loadSkill('simplify', { skillsRoot: SKILLS_ROOT });
  assert.ok(skill, 'loadSkill must return a non-null result for a valid SKILL.md');
  assert.equal(skill!.name, 'simplify');
  assert.equal(skill!.description, 'Review changed code for reuse.');
  assert.equal(skill!.body, body, 'body must equal the post-frontmatter content verbatim');
  assert.equal(skill!.source, expected);
  assert.deepEqual(warns, [], 'no warnings expected on the happy path');
});

test('skill-loader: missing file returns null and warns with the skill name', async () => {
  const skill = await loadSkill('does-not-exist', { skillsRoot: SKILLS_ROOT });
  assert.equal(skill, null);
  assert.equal(warns.length, 1, 'exactly one warning expected on missing skill');
  assert.match(warns[0]!, /does-not-exist/);
  assert.match(warns[0]!, /missing/);
});

test('skill-loader: malformed frontmatter returns null and warns with the skill name', async () => {
  // Unclosed YAML mapping value — gray-matter throws on this shape.
  writeSkill(
    'bad-skill',
    `---\nname: bad\ndescription: "unterminated\n---\n# body\n`,
  );

  const skill = await loadSkill('bad-skill', { skillsRoot: SKILLS_ROOT });
  assert.equal(skill, null);
  assert.equal(warns.length, 1, 'exactly one warning expected on malformed frontmatter');
  assert.match(warns[0]!, /bad-skill/);
  assert.match(warns[0]!, /malformed frontmatter/);
});

test('skill-loader: loadSkills returns survivors in order and drops nulls', async () => {
  writeSkill('alpha', '---\nname: alpha\n---\n# Alpha body\n');
  // beta intentionally missing
  writeSkill('gamma', '---\nname: gamma\n---\n# Gamma body\n');

  const skills = await loadSkills(['alpha', 'beta', 'gamma'], { skillsRoot: SKILLS_ROOT });
  assert.equal(skills.length, 2);
  assert.equal(skills[0]!.name, 'alpha');
  assert.equal(skills[1]!.name, 'gamma');
  // Exactly one warning — for the missing beta. Order-preserving filter.
  assert.equal(warns.filter((w) => /beta/.test(w)).length, 1);
});

test('skill-loader: loadSkills dedupes duplicate names with a warning', async () => {
  writeSkill('shared-skill', '---\nname: shared-skill\n---\n# only body\n');

  const skills = await loadSkills(
    ['shared-skill', 'shared-skill'],
    { skillsRoot: SKILLS_ROOT },
  );
  assert.equal(skills.length, 1, 'duplicates must be deduped');
  assert.equal(skills[0]!.name, 'shared-skill');
  assert.equal(
    warns.filter((w) => /duplicate skill "shared-skill"/.test(w)).length,
    1,
    'duplicate must produce exactly one warning',
  );
});
