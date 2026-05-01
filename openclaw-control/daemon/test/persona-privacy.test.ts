/**
 * T6.3 — persona privacy invariant.
 *
 * Three mandatory tests from implementation-plan.md §8 lines 836-873.
 * The 404-not-403 distinction in test #3 is critical: a 403 would leak the
 * existence (or non-existence) of a persona to the network. The HTTP gate
 * in api.ts deliberately returns 404 for GETs of PRIVATE_AGENT_FILES so
 * the response is indistinguishable from "no such file at all".
 *
 * Strategy:
 *   - Seed the test DB on a fresh tempdir (setupTestDb), then point
 *     OPENCLAW_LOCAL_AGENTS_ROOT at a tempdir that the FS chokepoint will
 *     write into. Build the Fastify app and `inject()` against it.
 *   - Enable the internal-token bearer path (auth.ts:166) so the test does
 *     not need to mint a JWT.
 *
 * IMPORTANT: setup.ts MUST be imported first; it stamps the env vars that
 * config.ts reads at module load. We additionally set OPENCLAW_LOCAL_AGENTS_ROOT
 * to a per-test dir BEFORE config.ts is imported transitively by api.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// IMPORTANT: ./env-stamp.ts mutates process.env at top level (incl.
// OPENCLAW_LOCAL_AGENTS_ROOT pointing at a fresh tempdir). It must be the
// FIRST relative-path import in this file because ESM imports are hoisted
// and `config.ts` reads its env at module load — once setup.ts or api.ts
// runs, env mutations are too late.
import { AGENTS_ROOT } from './env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import { writeMemoryFile } from '../src/memory.ts';
import { config } from '../src/config.ts';

// Sanity: ensure config picked up the override. If not, every test below
// would write into the developer's real ~/.claude/local-memory — that
// would be a footgun, so fail loudly. The check has caught import-order
// regressions twice already; do not remove.
if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `persona-privacy.test: env override didn't reach config — got "${config.localAgentsRoot}", want "${AGENTS_ROOT}". ` +
      'env-stamp.ts must be the FIRST relative import — ESM hoists imports and config.ts reads env at module load.',
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;
const SECRET = 'SECRET PROMPT XYZ';

test('persona files never enter memory_files (FS chokepoint never writes to DB)', async () => {
  const t = setupTestDb();
  try {
    // Bypass HTTP — call the FS chokepoint directly. assertAgentOwnership
    // is bypassed when localAgentIds is empty (config default for tests).
    const result = await writeMemoryFile('agents', 'horus', 'persona.md', SECRET);
    assert.equal(result.private, true, 'writeMemoryFile must report private=true for persona.md');

    // The chokepoint should have written to local FS, not the DB.
    const onDisk = join(AGENTS_ROOT, 'horus', 'persona.md');
    assert.ok(existsSync(onDisk), `persona.md should land on local FS at ${onDisk}`);
    assert.equal(readFileSync(onDisk, 'utf8'), SECRET);

    // 1. memory_files must have NO row for (scope=agents, filename=persona.md).
    const rows = t.db
      .prepare(`SELECT * FROM memory_files WHERE scope='agents' AND filename='persona.md'`)
      .all();
    assert.deepEqual(rows, [], 'memory_files must contain no persona.md rows');

    // 2. The secret content must not appear ANYWHERE in memory_files.
    const hits = t.db
      .prepare(`SELECT 1 AS x FROM memory_files WHERE content LIKE '%' || ? || '%'`)
      .all(SECRET);
    assert.deepEqual(hits, [], 'no row in memory_files may contain the persona body');
  } finally {
    t.cleanup();
  }
});

test('HTTP PUT /api/memories/agents/:id/persona.md → 403 (before any DB query)', async () => {
  const t = setupTestDb();
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/memories/agents/horus/persona.md',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { content: 'attempt to leak via HTTP' },
    });
    assert.equal(res.statusCode, 403, 'PUT to a private filename must be forbidden');

    // Still no row in memory_files. The gate ran before the DB layer was
    // ever reached, so this is double-verification of §8.
    const rows = t.db
      .prepare(`SELECT * FROM memory_files WHERE scope='agents' AND filename='persona.md'`)
      .all();
    assert.deepEqual(rows, [], 'PUT 403 must not have written to memory_files');
  } finally {
    await app.close();
    t.cleanup();
  }
});

test('HTTP GET /api/memories/agents/:id/persona.md → 404 (NOT 403, no existence leak)', async () => {
  const t = setupTestDb();
  const app = buildApp();
  try {
    // Seed a real local persona so a "naive" handler that read FS would
    // find content. The gate must still 404 it.
    await writeMemoryFile('agents', 'horus', 'persona.md', SECRET);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memories/agents/horus/persona.md',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });

    assert.equal(
      res.statusCode,
      404,
      `GET on a private filename must be 404, not 403 (got ${res.statusCode}). ` +
        'A 403 would leak the existence of a persona to a network attacker.',
    );
    assert.notEqual(res.statusCode, 403, 'must NOT be 403 — that would distinguish "exists but private" from "missing"');

    // The body must not contain the persona content (defense in depth).
    assert.equal(
      res.body.includes(SECRET),
      false,
      '404 body must not echo the persona content',
    );
  } finally {
    await app.close();
    t.cleanup();
  }
});

// Cleanup the FS we created for the whole file. Each subtest already calls
// `t.cleanup()` for its DB tempdir; this hook removes the agents-root.
process.on('exit', () => {
  try {
    rmSync(AGENTS_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
