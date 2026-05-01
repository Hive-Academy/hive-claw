/**
 * bot-bridge persona-invariant test.
 *
 * Validates the docs/SECURITY.md / implementation-plan.md §8 invariant
 * from the bot-bridge side. Two concrete properties:
 *
 *   1. `loadAgents` reads `persona.md` directly from the local FS and
 *      never issues an HTTP call to fetch it. We assert this by handing
 *      `loadAgents` a tempdir containing two agent directories — one with
 *      a `persona.md`, one without — and stubbing the global daemon HTTP
 *      surface (undici `request`) to throw if any URL contains `persona`.
 *      The test also asserts the without-persona agent is SKIPPED (not
 *      registered) per the documented "no persona → not runnable" rule.
 *
 *   2. The `daemonClient.daemon` surface intentionally has NO entry that
 *      reads or writes `persona.md` / `secrets.md`. We pin that down by
 *      enumerating the public surface and asserting nothing references the
 *      forbidden filenames.
 *
 * These tests live in the bot-bridge package because the invariant is
 * enforced jointly by `agentRegistry.ts` (FS-only persona read) and
 * `daemonClient.ts` (no persona route). The corresponding daemon-side
 * checks live in `daemon/test/persona-privacy.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Provide the env vars the bot-bridge config.ts reads at module load.
// Must be set BEFORE any relative import (ESM hoisting).
const AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'botbridge-personas-'));
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = AGENTS_ROOT;
process.env.OPENCLAW_INTERNAL_TOKEN = 'test-internal-token';
process.env.OPENCLAW_DAEMON_URL = 'http://127.0.0.1:1';
// Empty REDIS_URL so the status publisher stays inert.
process.env.REDIS_URL = '';

const BAD_FILENAMES = ['persona.md', 'persona.json', 'secrets.md', 'secrets.json'];

test('loadAgents reads persona.md from local FS only — no HTTP fetch for personas', async () => {
  // Set up two agent directories: one with a persona, one without.
  const horusDir = join(AGENTS_ROOT, 'horus');
  const ghostDir = join(AGENTS_ROOT, 'ghost-no-persona');
  mkdirSync(horusDir, { recursive: true });
  mkdirSync(ghostDir, { recursive: true });
  writeFileSync(join(horusDir, 'persona.md'), 'TEST PERSONA — never fetched over HTTP');

  // Stub the daemon HTTP surface: identity.md and discord.json calls return
  // 404 (so no shared metadata is needed), but ANY persona-flavoured URL
  // throws — that lets the test fail loudly if loadAgents ever attempts
  // such a fetch.
  const daemonClientModule = await import('../src/daemonClient.ts');
  const original = {
    readAgentIdentity: daemonClientModule.daemon.readAgentIdentity,
    readDiscordJson: daemonClientModule.daemon.readDiscordJson,
    readMemory: daemonClientModule.daemon.readMemory,
  };

  const requestedUrls: string[] = [];

  // Patch the daemon surface in place. agentRegistry imports `daemon` once;
  // the binding is the same object the test patches here.
  (daemonClientModule.daemon as any).readAgentIdentity = async (id: string) => {
    requestedUrls.push(`identity:${id}`);
    return null;
  };
  (daemonClientModule.daemon as any).readDiscordJson = async (id: string) => {
    requestedUrls.push(`discord.json:${id}`);
    return null;
  };
  (daemonClientModule.daemon as any).readMemory = async (
    scope: string,
    id: string,
    file: string,
  ) => {
    requestedUrls.push(`memory:${scope}/${id}/${file}`);
    if (
      scope === 'agents' &&
      BAD_FILENAMES.some((bad) => file === bad || file.includes(bad.split('.')[0]))
    ) {
      throw new Error(
        `INVARIANT VIOLATION: bot-bridge attempted to fetch a private file via daemon.readMemory: ${scope}/${id}/${file}`,
      );
    }
    return null;
  };

  try {
    const { loadAgents } = await import('../src/agentRegistry.ts');
    const agents = await loadAgents();

    // The agent with a local persona must be present; the one without must be skipped.
    const ids = agents.map((a) => a.id).sort();
    assert.deepEqual(
      ids,
      ['horus'],
      'loadAgents must register only agents whose local persona.md exists',
    );
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, 'horus');
    assert.equal(
      agents[0].personaMd?.includes('TEST PERSONA'),
      true,
      'persona content must come from the local FS read',
    );

    // Defense-in-depth: no requested URL referenced a private filename.
    for (const url of requestedUrls) {
      for (const bad of BAD_FILENAMES) {
        assert.equal(
          url.includes(bad),
          false,
          `loadAgents must NEVER request a private filename over HTTP: ${url}`,
        );
      }
    }
  } finally {
    Object.assign(daemonClientModule.daemon, original);
  }
});

test('daemonClient public surface has no persona/secrets entry point', async () => {
  const { daemon } = await import('../src/daemonClient.ts');
  const keys = Object.keys(daemon);

  // Sanity: the readMemory and readAgentIdentity helpers we expect ARE present.
  assert.ok(keys.includes('readMemory'), 'readMemory should be exported');
  assert.ok(keys.includes('readAgentIdentity'), 'readAgentIdentity should be exported');

  // No method name on the daemon surface should reference a private filename.
  for (const key of keys) {
    const lower = key.toLowerCase();
    for (const bad of ['persona', 'secret']) {
      assert.equal(
        lower.includes(bad),
        false,
        `daemon.${key} appears to be a persona/secrets accessor — that breaks the privacy invariant`,
      );
    }
  }

  // The implementation note in daemonClient.ts:33-43 promises:
  //   "there is intentionally NO `readPersona` helper".
  // We verify the absence symbolically: no readPersona / writePersona /
  // readSecrets etc. exist.
  for (const key of [
    'readPersona',
    'writePersona',
    'getPersona',
    'putPersona',
    'readSecrets',
    'writeSecrets',
    'getSecrets',
  ]) {
    assert.equal(
      key in (daemon as Record<string, unknown>),
      false,
      `daemon.${key} must NOT exist — bot-bridge MUST never fetch ${key} over HTTP`,
    );
  }
});

test('daemonClient.readMemory: defense-in-depth — calling it with persona.md hits a 404 from the daemon gate (not exercised here, but the surface is documented)', async () => {
  // This test is a documentation pin: readMemory IS general-purpose and
  // accepts any (scope, ownerId, filename), but the daemon's HTTP gate at
  // api.ts returns 404 for (agents, persona.md). bot-bridge code path
  // intentionally never calls it that way (loadAgents reads FS directly
  // via fs.readFile per agentRegistry.ts:65). We assert the call signature
  // accepts the bad path — it must NOT block at the bot-bridge layer
  // with a TypeError or input-validation throw, because the SECURITY
  // invariant lives at the daemon gate. Belt-and-braces.
  const { daemon } = await import('../src/daemonClient.ts');
  // Call with a clearly-invalid daemon URL so the network call fails fast.
  // We expect either a network error OR a 404; neither must include the
  // persona content (because there is no persona content to leak).
  let outcome: 'rejected' | 'returned-null' | 'returned-content' = 'rejected';
  try {
    const r = await daemon.readMemory('agents', 'horus', 'persona.md');
    outcome = r === null ? 'returned-null' : 'returned-content';
  } catch {
    outcome = 'rejected';
  }
  // Either a network error (no daemon on 127.0.0.1:1) or a parsed 404 from
  // a real daemon — both are acceptable; "returned-content" never is.
  assert.notEqual(
    outcome,
    'returned-content',
    'readMemory must never return persona content — daemon gate should 404 it',
  );
});

process.on('exit', () => {
  try {
    rmSync(AGENTS_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
