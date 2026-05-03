/**
 * harness-types — golden fixture round-trip + invalid-shape rejection.
 *
 * Pins the `parseHarnessYaml` contract: every required field must be
 * validated with a path-prefixed error message. Mirrored types in the
 * daemon copy are tested by file-equivalence in MODE 2's diff check, so
 * we only exercise the parser here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHarnessYaml, harnessHash } from '../src/harness/types.ts';

const VALID_YAML = `
version: 1

chatTier:
  skills:
    - security-review
    - simplify
  subagents:
    - name: pr-diff-triage
      description: Quick triage of PR diffs against OWASP Top 10.
      systemPrompt: |
        You are pr-diff-triage. Look for OWASP issues.
      tools:
        - mcp__gh__get_pull_request_diff
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: "\${GITHUB_TOKEN}"
      timeoutMs: 30000

orchestrationTier:
  skills:
    - security-review
  subagents:
    - name: security-review
      description: Deep security review for orchestration runs.
      systemPrompt: |
        You are security-review.
      tools: ["Read", "Grep", "Edit"]
  mcpServers:
    - id: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
  enabledPluginIds: []
  modelTier: claude_code
`;

test('harness-types: golden fixture round-trips with full shape', () => {
  const cfg = parseHarnessYaml(VALID_YAML);
  assert.equal(cfg.version, 1);

  // chatTier
  assert.deepEqual(cfg.chatTier.skills, ['security-review', 'simplify']);
  assert.equal(cfg.chatTier.subagents.length, 1);
  const subA = cfg.chatTier.subagents[0]!;
  assert.equal(subA.name, 'pr-diff-triage');
  assert.match(subA.description, /OWASP/);
  assert.match(subA.systemPrompt, /pr-diff-triage/);
  assert.deepEqual(subA.tools, ['mcp__gh__get_pull_request_diff']);

  assert.equal(cfg.chatTier.mcpServers.length, 1);
  const mcpA = cfg.chatTier.mcpServers[0]!;
  assert.equal(mcpA.id, 'gh');
  assert.equal(mcpA.command, 'npx');
  assert.deepEqual(mcpA.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(mcpA.env?.GITHUB_PERSONAL_ACCESS_TOKEN, '${GITHUB_TOKEN}');
  assert.equal(mcpA.timeoutMs, 30000);

  // orchestrationTier
  assert.deepEqual(cfg.orchestrationTier.skills, ['security-review']);
  assert.equal(cfg.orchestrationTier.subagents.length, 1);
  assert.deepEqual(cfg.orchestrationTier.subagents[0]!.tools, ['Read', 'Grep', 'Edit']);
  assert.deepEqual(cfg.orchestrationTier.enabledPluginIds, []);
  assert.equal(cfg.orchestrationTier.modelTier, 'claude_code');
});

test('harness-types: harnessHash returns sha256 hex (64 chars)', () => {
  const h = harnessHash(VALID_YAML);
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(h, harnessHash(VALID_YAML));
  assert.notEqual(h, harnessHash(VALID_YAML + '\n# trailing comment'));
});

test('harness-types: missing chatTier throws with field path', () => {
  const yamlNoChat = `
version: 1
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  assert.throws(
    () => parseHarnessYaml(yamlNoChat),
    (err: Error) => /harness\.chatTier/.test(err.message),
  );
});

test('harness-types: missing orchestrationTier throws with field path', () => {
  const yamlNoOrch = `
version: 1
chatTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  assert.throws(
    () => parseHarnessYaml(yamlNoOrch),
    (err: Error) => /harness\.orchestrationTier/.test(err.message),
  );
});

test('harness-types: mcpServers[0].id with uppercase chars rejected', () => {
  const badId = `
version: 1
chatTier:
  skills: []
  subagents: []
  mcpServers:
    - id: GH-Bad
      command: npx
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  assert.throws(
    () => parseHarnessYaml(badId),
    (err: Error) => /chatTier\.mcpServers\[0\]\.id/.test(err.message),
  );
});

test('harness-types: subagents[0].name empty rejected', () => {
  const emptyName = `
version: 1
chatTier:
  skills: []
  subagents:
    - name: ""
      description: x
      systemPrompt: y
  mcpServers: []
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  assert.throws(
    () => parseHarnessYaml(emptyName),
    (err: Error) => /chatTier\.subagents\[0\]\.name/.test(err.message),
  );
});

test('harness-types: invalid version (not 1) rejected at version path', () => {
  const badVer = `
version: 2
chatTier:
  skills: []
  subagents: []
  mcpServers: []
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;
  assert.throws(
    () => parseHarnessYaml(badVer),
    (err: Error) => /harness\.version/.test(err.message),
  );
});
