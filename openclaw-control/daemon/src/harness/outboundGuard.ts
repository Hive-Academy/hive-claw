/**
 * harness/outboundGuard.ts — TASK_2026_002 B8 sub-task 5.
 *
 * Single chokepoint that inspects the JSON body of every outbound HTTP call
 * the daemon makes to ptah/bridge or to a peer leader and throws if the
 * body's `method` field names a forbidden Pro-tier RPC. The two banned
 * shapes are:
 *
 *   - `wizard:*`             (any wizard sub-method — `wizard:deep-analyze`, …)
 *   - `harness:analyze-intent` (the single-method intent analyzer)
 *
 * Both are tier-locked behind ptah's Pro license. The community-tier
 * harness must never invoke them; if it does the `ptah --json license status`
 * boot probe (see `harness/licenseGuard.ts`) is a runtime defense, but this
 * module is the wire-level contract: a violation here means the calling
 * module is constructing a body it shouldn't.
 *
 * Activation
 * ----------
 * The guard activates only when:
 *
 *   - `process.env.NODE_ENV === 'test'`, OR
 *   - `process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER === '1'`.
 *
 * In production-default mode (env unset) the guard is a no-op pass-through.
 * Hot-path dispatchers (the bridge `/invoke` body for every orchestration
 * task) take ZERO additional cost when the env var is off — we early-return
 * before touching the body bytes.
 *
 * Body shape tolerance
 * --------------------
 * Callers pass whatever they already had on hand for `body`. We accept:
 *
 *   - `string`              → JSON.parse if it starts with `{` or `[`
 *   - `Buffer` / `Uint8Array` → utf-8 decode then JSON.parse
 *   - `undefined` / null    → no-op
 *   - non-JSON strings      → silent pass-through (we never crash on payload
 *                              shape; the guard's job is to BLOCK the two
 *                              named methods, not to police every body).
 *
 * Anything that parses to an object with a string `method` field gets
 * checked. Other shapes (arrays, primitives, JSON-RPC notifications without
 * a `method` field) pass.
 */

const FORBIDDEN_LITERAL_METHOD = 'harness:analyze-intent';

/**
 * Check whether the guard is active in this process. The check is read on
 * every call (not cached) so tests that toggle env vars between cases pick
 * up the change without a module re-import.
 */
function isActive(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER === '1') return true;
  return false;
}

function decodeBody(
  body: string | Buffer | Uint8Array | null | undefined,
): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  // Unknown body shape (e.g. a stream). The guard cannot inspect it; pass.
  return null;
}

function parseLooseJson(text: string): unknown {
  // Cheap pre-filter: avoid throwing on every empty or non-JSON body.
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return null;
  const first = trimmed.charCodeAt(0);
  // 0x7B = '{', 0x5B = '[' — only attempt JSON.parse on plausible JSON.
  if (first !== 0x7b && first !== 0x5b) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Inspect a JSON-RPC-shaped request body and throw if its `method` names a
 * forbidden Pro-tier RPC. No-op when the guard is inactive (production
 * default) or the body is non-JSON / has no `method` field.
 *
 * Throws a structured `Error('Forbidden Pro-tier RPC: <method>')` so the
 * caller (and any test asserting on the rejection) sees the exact method
 * that triggered the block.
 */
export function assertNotForbiddenJsonRpc(
  body: string | Buffer | Uint8Array | null | undefined,
): void {
  if (!isActive()) return;
  const text = decodeBody(body);
  if (text === null) return;
  const parsed = parseLooseJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const method = (parsed as { method?: unknown }).method;
  if (typeof method !== 'string' || method.length === 0) return;
  if (method === FORBIDDEN_LITERAL_METHOD || method.startsWith('wizard:')) {
    throw new Error(`Forbidden Pro-tier RPC: ${method}`);
  }
}

/**
 * Test seam — exposed so unit tests can confirm the guard's activation
 * predicate without poking env vars from the assertion site. Returns
 * `true` iff `assertNotForbiddenJsonRpc` would inspect bodies right now.
 */
export function __isGuardActiveForTests(): boolean {
  return isActive();
}
