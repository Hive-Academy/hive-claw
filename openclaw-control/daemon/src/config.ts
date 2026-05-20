import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

const leader = (process.env.OPENCLAW_LEADER ?? '0') === '1';
const leaderUrl = (process.env.OPENCLAW_LEADER_URL ?? '').trim();

if (!leader && leaderUrl.length === 0) {
  // Hard fail at config-load time per implementation-plan.md §10. Followers
  // have no other way to find the leader's HTTP API.
  throw new Error('Followers MUST set OPENCLAW_LEADER_URL');
}

const dispatchFailureThresholdRaw = process.env.OPENCLAW_DISPATCH_FAILURE_THRESHOLD ?? '3';
const parsedThreshold = Number.parseInt(dispatchFailureThresholdRaw, 10);
const dispatchFailureThreshold =
  Number.isFinite(parsedThreshold) && parsedThreshold >= 1 ? parsedThreshold : 3;

export const config = {
  port: Number(process.env.OPENCLAW_PORT ?? 7878),
  host: process.env.OPENCLAW_HOST ?? '127.0.0.1',
  publicUrl: process.env.OPENCLAW_PUBLIC_URL ?? 'http://localhost:7878',

  // --- leader/follower mode ---
  leader,
  /**
   * Leader's HTTP base URL — only meaningful on followers. Empty string on
   * the leader. The constructor above guarantees this is non-empty when
   * `leader === false`.
   */
  leaderUrl,
  // Comma-separated list of agent ids this machine is allowed to dispatch invocations for.
  // The bot-bridge running here typically owns these tokens.
  localAgentIds: (process.env.OPENCLAW_LOCAL_AGENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // --- SQLite store (leader only) ---
  /**
   * Absolute path to the SQLite database file. Only meaningful on the leader;
   * followers never open it. Defaults to /data/specs.db (the named volume
   * mounted in docker-compose).
   */
  dbPath: process.env.OPENCLAW_SPECS_DB_PATH ?? '/data/specs.db',

  /**
   * K consecutive failures (per (project, task, phase)) before a dispatch
   * is poisoned. Leader-only — DispatchRepo.markDone reads this through
   * env on the leader's process.
   */
  dispatchFailureThreshold,

  // --- local memory (NEVER synced) — per-machine private state ---
  // Personas, secrets, anything the agent owner does not want exposed via
  // the shared API surface. Bind-mounted from the host at ~/.claude/local-memory.
  localMemoryRoot:
    process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory'),
  localAgentsRoot:
    process.env.OPENCLAW_LOCAL_AGENTS_ROOT ??
    path.join(process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory'), 'agents'),

  // --- claude code session JSONLs (host's, mounted read-only) ---
  // Pre-cutover Claude-Code sessions; still referenced by `watcher.ts` for
  // legacy session tailing. Not used by the dashboard "Live sessions" page
  // anymore (that reads `openclawAgentsRoot` below post-cutover).
  claudeProjectsRoot: path.join(home, '.claude', 'projects'),

  /**
   * Openclaw's per-agent session JSONL root. After the TASK_2026_006
   * cutover, agent conversations live at
   *   `<openclawAgentsRoot>/<agentId>/sessions/<sessionId>.jsonl`
   * (plus a sibling `.trajectory.jsonl`). The daemon container bind-mounts
   * the gateway's `openclaw-state` volume read-only at
   * `/home/agent/.openclaw`, which is the default below.
   */
  openclawAgentsRoot:
    process.env.OPENCLAW_AGENTS_ROOT ?? '/home/agent/.openclaw/agents',

  /**
   * Comma-separated list of sibling-daemon URLs to aggregate sessions from.
   * On the leader, set to the URLs of all follower daemons so the dashboard
   * shows sessions from every machine in one view.
   * Example: http://machine2:7878,http://machine3:7878
   */
  followerUrls: (process.env.OPENCLAW_FOLLOWER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: process.env.OPENCLAW_JWT_SECRET ?? 'dev-secret-change-me',
  cookieName: 'openclaw_session',
  /** Service token for internal callers (bot-bridge, dispatched agents). */
  internalToken: process.env.OPENCLAW_INTERNAL_TOKEN ?? '',

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.DISCORD_REDIRECT_URI ?? 'http://localhost:7878/auth/discord/callback',
    allowedUserIds: (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedGuildId: process.env.DISCORD_ALLOWED_GUILD_ID ?? '',
  },

  redis: {
    url: process.env.REDIS_URL ?? '',
  },

  // Headless agent invoker — ptah-cli's `session start --task` is the
  // JSON-RPC interface we drive. Same CLI that powers interactive ptah
  // sessions, so dispatched work runs through the same harness as live work.
  //
  // Preferred mode: bridgeUrl set → daemon delegates to scripts/ptah-bridge.mjs
  //   running on the host (systemd user service). The host has Claude CLI +
  //   codex + gh + your desktop's full auth surface; the container does not.
  //
  // Fallback mode: bridgeUrl empty → daemon shells out to a local `ptah` binary
  //   inside the container. Works in dev/test where the bridge is offline.
  ptah: {
    bin: process.env.PTAH_BIN ?? 'ptah',
    profile: process.env.PTAH_INVOKER_PROFILE ?? 'claude_code',
    autoApprove: (process.env.PTAH_INVOKER_AUTO_APPROVE ?? '1') === '1',
    bridgeUrl: process.env.OPENCLAW_PTAH_BRIDGE_URL ?? '',
    /**
     * Upper bound for `POST /api/ptah/invoke`'s `timeoutMs` body field.
     * The route rejects (400) any caller-provided timeout that exceeds
     * this and applies this value as the default when the caller omits
     * the field. 30 minutes by default — matches the chat-tier's tolerance
     * for a long ptah subprocess.
     */
    invokerTimeoutMs: (() => {
      const raw = process.env.PTAH_INVOKER_TIMEOUT_MS ?? '1800000';
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1_800_000;
    })(),
  },

  dashboardDir:
    process.env.OPENCLAW_DASHBOARD_DIR ??
    path.resolve(new URL('.', import.meta.url).pathname, '..', '..', 'dashboard', 'dist', 'dashboard', 'browser'),
};
