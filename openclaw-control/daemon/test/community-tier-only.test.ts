/**
 * community-tier-only — TASK_2026_002 B8 sub-task 7.
 *
 * Pins three contracts:
 *
 *   1. The outbound JSON-RPC guard (`harness/outboundGuard.ts`) blocks
 *      `wizard:*` and `harness:analyze-intent` bodies BEFORE the request
 *      is dispatched. Benign methods pass through.
 *
 *   2. `licenseGuard.assertCommunityTier()` is a no-op when the env var is
 *      unset (default), resolves when the bridge reports
 *      `ptahLicenseTier: 'community'`, and throws on any other tier
 *      (`'pro'`, `null`, missing field).
 *
 *   3. The body-shape tolerance contract from `outboundGuard.ts`: string
 *      bodies, Buffer bodies, Uint8Array bodies, undefined, and non-JSON
 *      strings all behave correctly (no crash on anything; throw only on
 *      genuinely-forbidden methods).
 *
 * Activation
 * ----------
 * `node --test` sets `NODE_ENV=test` automatically (Node 22 default), so
 * the guard's "test mode" predicate fires without manual env stamping for
 * the outbound-guard tests. The licenseGuard tests stamp
 * `OPENCLAW_REQUIRE_COMMUNITY_TIER=1` per case and unset on cleanup so they
 * don't bleed into other test files in the same `node --test` run.
 *
 * Network mocking
 * ---------------
 * Uses `undici.MockAgent` + `setGlobalDispatcher` — the same pattern as
 * `bot-bridge/test/llm-tool-call.test.ts` and `mcp-manager.test.ts`. The
 * bridge URL is set to a fake `http://mock.bridge.openclaw.test` and
 * MockAgent intercepts `/health`. We DON'T mock `/invoke` because the
 * outbound-guard assertion fires before any network I/O — by design.
 */

// `community-tier-stamp.ts` is the FIRST relative import — it stamps
// OPENCLAW_PTAH_BRIDGE_URL before `daemon/src/config.ts` reads env at
// module load. ESM imports are hoisted, so a top-of-body `process.env.X = ...`
// statement runs AFTER imports and is too late.
import './community-tier-stamp.ts';
import './env-stamp.ts';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

import { assertNotForbiddenJsonRpc, __isGuardActiveForTests } from '../src/harness/outboundGuard.ts';
import { assertCommunityTier } from '../src/harness/licenseGuard.ts';

let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;
let mockAgent: MockAgent;

beforeEach(() => {
  savedDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(savedDispatcher);
  // Always clear any per-test env mutation. node --test sets NODE_ENV=test
  // automatically; we leave that alone.
  delete process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER;
});

// ===========================================================================
// (1) Outbound guard — activation predicate
// ===========================================================================

test('community-tier-only: guard is active under NODE_ENV=test (node --test default)', () => {
  // The test runner sets NODE_ENV=test before any test body runs, so the
  // guard MUST be active here without us setting OPENCLAW_REQUIRE_COMMUNITY_TIER.
  // This is the property that makes "any new code path that fires a wizard
  // body during the AT sweep fails the suite" actually work.
  assert.equal(process.env.NODE_ENV, 'test', 'node --test sets NODE_ENV=test');
  assert.equal(__isGuardActiveForTests(), true);
});

// ===========================================================================
// (2) Outbound guard — benign and forbidden methods
// ===========================================================================

test('community-tier-only: benign JSON-RPC body passes (method=getProjects)', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProjects' });
  // Should not throw.
  assertNotForbiddenJsonRpc(body);
});

test('community-tier-only: body without a `method` field passes', () => {
  // Mirrors the canonical bridge `/invoke` body shape — `cwd`, `prompt`, etc.
  // Has no top-level `method`, so the guard is inert.
  const body = JSON.stringify({ cwd: '/tmp/x', prompt: 'hi', taskId: 't1', agentId: 'horus' });
  assertNotForbiddenJsonRpc(body);
});

test('community-tier-only: wizard:deep-analyze method throws', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'wizard:deep-analyze' });
  assert.throws(
    () => assertNotForbiddenJsonRpc(body),
    /Forbidden Pro-tier RPC: wizard:deep-analyze/,
  );
});

test('community-tier-only: any wizard:* method throws', () => {
  // Defensive — there is no exhaustive list of wizard sub-methods, so the
  // guard uses a prefix match. We assert against three different sub-methods
  // to pin the regex.
  for (const m of ['wizard:scan', 'wizard:plan', 'wizard:something-new']) {
    const body = JSON.stringify({ method: m });
    assert.throws(
      () => assertNotForbiddenJsonRpc(body),
      new RegExp(`Forbidden Pro-tier RPC: ${m.replace(':', ':')}`),
      `wizard sub-method "${m}" must be blocked by the prefix match`,
    );
  }
});

test('community-tier-only: harness:analyze-intent method throws (literal match)', () => {
  const body = JSON.stringify({ method: 'harness:analyze-intent', params: { foo: 'bar' } });
  assert.throws(
    () => assertNotForbiddenJsonRpc(body),
    /Forbidden Pro-tier RPC: harness:analyze-intent/,
  );
});

test('community-tier-only: a method that LOOKS like harness:* but is NOT analyze-intent passes', () => {
  // Only the literal `harness:analyze-intent` is blocked — other harness:*
  // RPCs are NOT (impl-plan §"Outbound HTTP wrapper guard" — the regex is
  // exact, not prefix). This pins that contract.
  const body = JSON.stringify({ method: 'harness:list' });
  assertNotForbiddenJsonRpc(body);
});

// ===========================================================================
// (3) Outbound guard — body shape tolerance
// ===========================================================================

test('community-tier-only: undefined body passes (no crash)', () => {
  assertNotForbiddenJsonRpc(undefined);
  assertNotForbiddenJsonRpc(null);
});

test('community-tier-only: Buffer body is decoded and inspected', () => {
  const buf = Buffer.from(JSON.stringify({ method: 'wizard:plan' }), 'utf8');
  assert.throws(
    () => assertNotForbiddenJsonRpc(buf),
    /Forbidden Pro-tier RPC: wizard:plan/,
  );
});

test('community-tier-only: Uint8Array body is decoded and inspected', () => {
  const u8 = new Uint8Array(Buffer.from(JSON.stringify({ method: 'harness:analyze-intent' }), 'utf8'));
  assert.throws(
    () => assertNotForbiddenJsonRpc(u8),
    /Forbidden Pro-tier RPC: harness:analyze-intent/,
  );
});

test('community-tier-only: non-JSON string body passes silently', () => {
  // Form-encoded, plain text, etc. — the guard does NOT police every body
  // shape; it only blocks the two named methods, and only when the body
  // parses as a JSON object with a `method` field.
  assertNotForbiddenJsonRpc('not json at all');
  assertNotForbiddenJsonRpc('   ');
  assertNotForbiddenJsonRpc('foo=bar&baz=qux');
});

test('community-tier-only: malformed JSON body passes silently', () => {
  // Don't crash on bad JSON — we'd take down whatever HTTP helper is
  // wrapping us if we did. The guard's mandate is to BLOCK, not to police
  // payload validity.
  assertNotForbiddenJsonRpc('{not valid json');
});

test('community-tier-only: JSON array body passes (no `method` field at root)', () => {
  // Top-level arrays are how JSON-RPC batches are shaped; we do not unpack
  // them. The bridge body and follower→leader bodies are objects, never
  // arrays, so this is a YAGNI-conscious guardrail-skip.
  assertNotForbiddenJsonRpc(JSON.stringify([{ method: 'wizard:plan' }]));
});

// ===========================================================================
// (4) licenseGuard — env-var off → no-op
// ===========================================================================

test('community-tier-only: assertCommunityTier no-op when OPENCLAW_REQUIRE_COMMUNITY_TIER unset', async () => {
  delete process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER;
  // No /health intercept set up — if the guard tried to call the bridge
  // we'd see a "no matching mock" error from MockAgent.
  await assertCommunityTier();
});

test('community-tier-only: assertCommunityTier resolves when bridge reports tier=community', async () => {
  process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER = '1';
  const pool = mockAgent.get('http://mock.bridge.openclaw.test');
  pool.intercept({ path: '/health', method: 'GET' }).reply(
    200,
    { ok: true, ptahVersion: '0.1.3', ptahLicenseTier: 'community' },
    { headers: { 'content-type': 'application/json' } },
  );
  await assertCommunityTier();
});

test('community-tier-only: assertCommunityTier throws when bridge reports tier=pro', async () => {
  process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER = '1';
  const pool = mockAgent.get('http://mock.bridge.openclaw.test');
  pool.intercept({ path: '/health', method: 'GET' }).reply(
    200,
    { ok: true, ptahVersion: '0.1.3', ptahLicenseTier: 'pro' },
    { headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    () => assertCommunityTier(),
    /OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but ptah reports tier "pro"/,
  );
});

test('community-tier-only: assertCommunityTier throws when bridge reports tier=null (probe failed)', async () => {
  process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER = '1';
  const pool = mockAgent.get('http://mock.bridge.openclaw.test');
  pool.intercept({ path: '/health', method: 'GET' }).reply(
    200,
    { ok: true, ptahVersion: '0.1.3', ptahLicenseTier: null },
    { headers: { 'content-type': 'application/json' } },
  );
  // Fail-closed: an unknown tier under the env var is treated as a refusal.
  // The error message names the tier explicitly so the operator's logs
  // distinguish "got pro" from "couldn't probe".
  await assert.rejects(
    () => assertCommunityTier(),
    /OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but ptah reports tier null/,
  );
});

test('community-tier-only: assertCommunityTier throws when bridge /health returns 500', async () => {
  process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER = '1';
  const pool = mockAgent.get('http://mock.bridge.openclaw.test');
  pool.intercept({ path: '/health', method: 'GET' }).reply(500, 'broken');
  await assert.rejects(
    () => assertCommunityTier(),
    /OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but bridge \/health failed/,
  );
});
