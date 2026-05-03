/**
 * harness/licenseGuard.ts — TASK_2026_002 B8 sub-task 6.
 *
 * Boot-time hard-assert that the host's ptah is on the community license
 * tier whenever `OPENCLAW_REQUIRE_COMMUNITY_TIER=1`. Companion to the
 * outbound-HTTP guard in `harness/outboundGuard.ts`:
 *
 *   - `outboundGuard` blocks Pro RPCs at the wire (request body). Defense
 *     against accidental code paths or future regressions that smuggle a
 *     `wizard:*` body through one of our HTTP helpers.
 *
 *   - `licenseGuard` (this module) blocks the daemon from booting at all
 *     when ptah itself is on a Pro tier. Defense against an operator who
 *     sets the env var on the wrong host and would otherwise rely on the
 *     wire guard alone.
 *
 * Default behavior (`OPENCLAW_REQUIRE_COMMUNITY_TIER` unset or != '1') is a
 * no-op early return. The probe over the bridge is skipped entirely when
 * the env var is off — production hosts that haven't opted in pay zero
 * cost on boot.
 *
 * Probe path
 * ----------
 * `pingBridge()` returns `{ ptahLicenseTier: string | null }` (added in B8).
 * The bridge populates that field via `ptah --json license status` (see
 * `scripts/ptah-bridge.mjs:getPtahLicenseTier`). On any probe failure the
 * bridge returns `null` and we refuse the boot — fail-closed under the env
 * var, since "I can't tell" is not a green light when the operator has
 * explicitly demanded community-only.
 */

import { isBridgeEnabled, pingBridge } from '../ptahBridge.js';

/**
 * Hard-assert ptah is community tier. Throws when the env var demands it
 * and the bridge probe reports any other tier (or `null`).
 *
 * No-op when `OPENCLAW_REQUIRE_COMMUNITY_TIER !== '1'`.
 */
export async function assertCommunityTier(): Promise<void> {
  if (process.env.OPENCLAW_REQUIRE_COMMUNITY_TIER !== '1') return;

  if (!isBridgeEnabled()) {
    throw new Error(
      'OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but OPENCLAW_PTAH_BRIDGE_URL is unset — ' +
        'cannot probe ptah license tier without the bridge.',
    );
  }

  const probe = await pingBridge();
  if (!probe.ok) {
    throw new Error(
      `OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but bridge /health failed: ${probe.error ?? 'unknown error'}`,
    );
  }
  const tier = probe.ptahLicenseTier;
  if (tier !== 'community') {
    throw new Error(
      `OPENCLAW_REQUIRE_COMMUNITY_TIER=1 but ptah reports tier ${tier === null ? 'null' : `"${tier}"`}`,
    );
  }
}
