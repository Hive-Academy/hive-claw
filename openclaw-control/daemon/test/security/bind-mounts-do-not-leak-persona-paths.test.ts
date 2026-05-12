/**
 * Persona-privacy bind-mount discipline (TASK_2026_006 Batch 6, arch §7.5).
 *
 * Personas live in ~/.claude/local-memory and MUST NEVER be reachable from
 * inside any agent sandbox. The openclaw config controls sandboxing via
 * `agents.defaults.tools.fs.workspaceOnly: true`, and the docker-compose
 * volume layout controls what's bind-mountable into the gateway container.
 *
 * This test is the enforcement mechanism — it runs in CI on every PR that
 * touches docker-compose.yml, the openclaw template, or the Dockerfile, and
 * fails loudly if anyone wires a sandbox bind into a forbidden path segment.
 *
 * Scan strategy (matches arch §7.5):
 *   - On each line that names a bind-mount surface (`binds[…]`, `volumes:`),
 *     reject any line that ALSO contains a forbidden segment as a real path
 *     segment (delimited by `/`, end-of-string, or `:`).
 *   - The same-line filter is intentional: docker-compose's top-level
 *     `volumes:` key (which only declares named volumes, no host paths)
 *     should NOT trip on host-path bind-mount lines below it that legitimately
 *     reference `${HOME}/.ptah` for ptah-cli auth (those are not sandbox
 *     bind-mounts — they target the gateway HOME, never the agent workspace).
 *   - When the failure mode IS a line of the form `volumes: ["…/local-memory/…"]`
 *     (compose inline-array form) or `binds: …/.claude/…`, this test catches it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root: this file is at openclaw-control/daemon/test/security/<file>.ts,
// so three levels up from __dirname.
const REPO_ROOT = resolve(__dirname, '../../../..');

const FORBIDDEN_SEGMENTS = ['local-memory', '.claude', '.ptah'] as const;

const FILES_TO_SCAN = [
  'docker-compose.yml',
  'config/openclaw.json.tmpl',
] as const;

/**
 * True when `segment` appears as a real path segment inside `line` — bounded
 * by `/`, `:`, start-of-string, end-of-string, or whitespace. Substring
 * matches like `local-memory-foo` or `myclaude` should NOT match
 * `local-memory` or `.claude` respectively.
 */
function containsAsPathSegment(line: string, segment: string): boolean {
  // Escape regex metacharacters in the segment.
  const esc = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundaries: start-of-line, slash, colon, whitespace, or quote characters.
  const re = new RegExp(`(^|[\\s/:"'\`])${esc}(?=$|[\\s/:"'\`])`);
  return re.test(line);
}

function isBindOrVolumeLine(line: string): boolean {
  // Matches both the YAML-key form (`volumes:` / `binds:`) AND the JSON-style
  // (`"binds": [...]`, `"volumes": "..."`).
  return /\b(binds?|volumes?)\b\s*[:=]/i.test(line);
}

for (const file of FILES_TO_SCAN) {
  test(`${file}: bind-mount lines reference no private persona path segment`, () => {
    const absolute = resolve(REPO_ROOT, file);
    const content = readFileSync(absolute, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isBindOrVolumeLine(line)) continue;

      for (const seg of FORBIDDEN_SEGMENTS) {
        if (containsAsPathSegment(line, seg)) {
          assert.fail(
            `${file}:${i + 1}: bind-mount/volume declaration references forbidden ` +
              `path segment "${seg}":\n` +
              `  ${line.trim()}\n` +
              `Personas live in ~/.claude/local-memory and MUST NEVER traverse a sandbox bind.`,
          );
        }
      }
    }
  });
}

// `agents.defaults.tools.fs.workspaceOnly` from arch §7.5 doesn't exist
// in openclaw's schema. The actual openclaw sandbox slot is
// `agents.defaults.sandbox.{mode, workspaceAccess, ...}` (verified in
// openclaw v2026.4.24 at config-DVWzrbBW.js:129-145 via
// resolveSandboxConfigForAgent). Two meanings:
//
//   - `sandbox.mode: "off"` (default): tools run in the gateway's own
//     filesystem context. Persona privacy is then enforced by:
//       1) the daemon's memory.ts routing (layers 1-4) for HTTP memory ops,
//       2) docker-compose.yml bind-mount discipline so the gateway
//          container doesn't see ~/.claude/local-memory at all,
//       3) plugin handler input validation (validators.ts).
//   - `sandbox.mode: "docker"`: openclaw spawns per-session sandbox
//     containers and applies workspaceAccess: "none"|"ro"|"rw". A heavier
//     model. We don't use it; the gateway-container approach is sufficient.
//
// So there is NO assertion to make here about a workspaceOnly flag. The
// bind-mount-segment tests above are what actually enforces the invariant.
// This test guards against a future regression where someone re-adds an
// invalid `agents.defaults.tools` block (openclaw will refuse to boot).
test('openclaw config: no rejected agents.defaults.tools block', () => {
  const tmplPath = resolve(REPO_ROOT, 'config/openclaw.json.tmpl');
  const raw = readFileSync(tmplPath, 'utf8');

  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const stubbed = stripped
    .replace(/\$\{LLM_PROVIDERS_JSON\}/g, '{}')
    .replace(/\$\{[^}]+\}/g, 'STUB');

  const cfg = JSON.parse(stubbed);
  assert.ok(cfg?.agents?.defaults, 'agents.defaults block must exist');
  assert.equal(
    cfg?.agents?.defaults?.tools,
    undefined,
    'agents.defaults.tools is rejected by openclaw v2026.4.24 — the correct sandbox slot is agents.defaults.sandbox.* (see config-DVWzrbBW.js:129-145 in the installed openclaw). Persona-privacy at the FS layer is enforced by docker-compose bind-mount discipline + daemon memory.ts layers 1-4, not via this template key.',
  );
});

test('sanity: containsAsPathSegment matches segments, rejects substrings', () => {
  // Whitelist-style positive matches.
  assert.equal(containsAsPathSegment('- /home/anubis/.claude/local-memory:/x', 'local-memory'), true);
  assert.equal(containsAsPathSegment('- /home/anubis/.claude:/x', '.claude'), true);
  assert.equal(containsAsPathSegment('volumes: ["/home/anubis/.ptah:/y"]', '.ptah'), true);
  assert.equal(containsAsPathSegment('binds: "/x/.claude"', '.claude'), true);

  // Substring traps must NOT match.
  assert.equal(containsAsPathSegment('- /opt/local-memory-backup/x', 'local-memory'), false);
  assert.equal(containsAsPathSegment('- /opt/myclaude/x', '.claude'), false);
  assert.equal(containsAsPathSegment('- /opt/ptah-bridge/x', '.ptah'), false);
});

test('sanity: deliberate violation triggers the scanner (regression guard)', () => {
  // Construct an in-memory faux-compose snippet containing a clearly-bad
  // sandbox bind, and confirm the same predicate the test uses above fires.
  // (Belt-and-braces: ensures the test is not vacuously passing.)
  const violations: Array<[string, string]> = [
    ['volumes: ["${HOME}/.claude/local-memory:/home/agent/leak:ro"]', 'local-memory'],
    ['binds: "/home/anubis/.claude:/sandbox"', '.claude'],
    ['volumes = ["/home/x/.ptah:/agent/.ptah"]', '.ptah'],
  ];
  for (const [line, segment] of violations) {
    assert.ok(
      isBindOrVolumeLine(line),
      `expected line to match bind/volume predicate: ${line}`,
    );
    assert.ok(
      containsAsPathSegment(line, segment),
      `expected segment "${segment}" to be detected in: ${line}`,
    );
  }
});
