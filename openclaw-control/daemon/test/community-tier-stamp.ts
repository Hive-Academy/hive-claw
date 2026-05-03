/**
 * First-import env stamp for `community-tier-only.test.ts`.
 *
 * Stamps `OPENCLAW_PTAH_BRIDGE_URL` so `daemon/src/config.ts` reads a
 * non-empty `bridgeUrl` at module load. The licenseGuard tests pump
 * the bridge `/health` response through `undici.MockAgent`, so the URL
 * itself must resolve to a host MockAgent intercepts (`mock.bridge.openclaw.test`).
 *
 * Convention from `env-stamp.ts` / `follower-env-stamp.ts`: this module
 * must be the FIRST relative-path import in any test that uses it. ESM
 * imports are hoisted, so setting env in the test body's top-level
 * statement runs AFTER imports and is too late.
 */

process.env.OPENCLAW_PTAH_BRIDGE_URL = 'http://mock.bridge.openclaw.test';

// `node --test` does NOT set NODE_ENV automatically (that's a vitest/jest
// convention, not a Node convention). Stamp it here so the guard's
// activation predicate fires for this file. Other test files that don't
// import this stamp run with NODE_ENV unset and the guard is dormant —
// which is the right default: only the file that explicitly opts in to
// the guard contract pays the inspection cost.
process.env.NODE_ENV = 'test';
