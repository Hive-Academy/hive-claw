/**
 * Follower-mode env stamp for tests that boot in `OPENCLAW_LEADER=0`
 * without standing up a real leader.
 *
 * Counterpart to env-stamp.ts (leader-mode). Same import-order rule:
 * `daemon/src/config.ts` reads env once at module load, so this module
 * must be the FIRST relative-path import in any test that uses it.
 *
 * `OPENCLAW_LEADER_URL` is set to a placeholder; tests that actually want
 * to talk to a leader call `initLeaderClient(realBaseUrl, token)` later
 * to overwrite it.
 */

process.env.OPENCLAW_LEADER = '0';
process.env.OPENCLAW_LEADER_URL = 'http://placeholder.invalid';
process.env.OPENCLAW_INTERNAL_TOKEN ??= 'test-internal-token';
process.env.OPENCLAW_JWT_SECRET ??= 'test-jwt-secret';
process.env.REDIS_URL = '';
process.env.DISCORD_CLIENT_ID = '';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.OPENCLAW_DISABLE_CONTINUATION = '1';
// Local agents must be non-empty for startDispatchWorker to actually run.
process.env.OPENCLAW_LOCAL_AGENT_IDS ??= 'horus';
