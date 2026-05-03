/**
 * Launcher-mode env stamp for tests that exercise harness/ptahLauncher.ts.
 *
 * Same module-load-order rule as env-stamp.ts: ESM hoists imports, so
 * mutating `process.env` in the test file body is too late — config.ts
 * has already read the env. This file's top-level statements run at
 * import time, before any other relative-path import in the test.
 *
 * Stamps:
 *   - OPENCLAW_HOST_HOME → fresh tempdir (so materialize writes land there)
 *   - OPENCLAW_LOCAL_AGENTS_ROOT → fresh tempdir (env-stamp pattern)
 *   - OPENCLAW_PTAH_BRIDGE_URL → stub URL (so isBridgeEnabled() === true;
 *     tests inject a bridge override via __setInvokeViaBridgeForTests)
 *   - All the boilerplate env-stamp.ts sets.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOST_HOME = mkdtempSync(join(tmpdir(), 'openclaw-launcher-host-'));
export const AGENTS_ROOT = mkdtempSync(join(tmpdir(), 'openclaw-launcher-agents-'));

process.env.OPENCLAW_HOST_HOME = HOST_HOME;
process.env.OPENCLAW_LOCAL_AGENTS_ROOT = AGENTS_ROOT;
process.env.OPENCLAW_PTAH_BRIDGE_URL = 'http://stub.invalid:8744';

process.env.OPENCLAW_LEADER = '1';
process.env.OPENCLAW_INTERNAL_TOKEN ??= 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET ??= 'test-jwt-secret';
process.env.REDIS_URL = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';
