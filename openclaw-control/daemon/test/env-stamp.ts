/**
 * First-import env stamp for tests that need a custom OPENCLAW_LOCAL_AGENTS_ROOT.
 *
 * `daemon/src/config.ts` reads env once at module load. Tests that import
 * `setup.ts` (or anything that transitively imports config) must mutate env
 * BEFORE that load happens. ESM imports are hoisted, so setting env in the
 * test file body does NOT run early enough.
 *
 * Convention: a test that needs a per-file FS isolation tempdir imports this
 * module FIRST (before setup.ts and any ../src/* import). The exported
 * AGENTS_ROOT is the fresh tempdir; the module also stamps the env vars
 * `setup.ts` would otherwise stamp itself, so importing this module makes
 * the duplicate stamp in setup.ts a no-op.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'openclaw-test-agents-'));
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = AGENTS_ROOT;

// Mirror the env stamps from setup.ts so the same module-load-order rules
// apply when this file is imported first.
process.env.OPENCLAW_LEADER = '1';
process.env.OPENCLAW_INTERNAL_TOKEN ??= 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET ??= 'test-jwt-secret';
process.env.REDIS_URL = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';
