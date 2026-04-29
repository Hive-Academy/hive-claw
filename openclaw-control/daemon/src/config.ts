import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const SHARED_SPECS_ROOT = process.env.OPENCLAW_SHARED_SPECS ?? path.join(home, '.claude', 'shared-specs');

export const config = {
  port: Number(process.env.OPENCLAW_PORT ?? 7878),
  host: process.env.OPENCLAW_HOST ?? '127.0.0.1',
  publicUrl: process.env.OPENCLAW_PUBLIC_URL ?? 'http://localhost:7878',

  // --- leader/follower mode ---
  leader: (process.env.OPENCLAW_LEADER ?? '0') === '1',
  // Comma-separated list of agent ids this machine is allowed to dispatch invocations for.
  // The bot-bridge running here typically owns these tokens.
  localAgentIds: (process.env.OPENCLAW_LOCAL_AGENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // --- shared-specs git layout ---
  sharedSpecsRoot: SHARED_SPECS_ROOT,
  specsDir: path.join(SHARED_SPECS_ROOT, 'specs'),
  sharedMemoryRoot: path.join(SHARED_SPECS_ROOT, 'memory'),
  agentsRoot: path.join(SHARED_SPECS_ROOT, 'memory', 'agents'),

  // --- local memory (NEVER synced) — per-machine private state ---
  // Personas, secrets, anything the agent owner does not want exposed via the
  // shared specs repo. Bind-mounted from the host at ~/.claude/local-memory.
  localMemoryRoot:
    process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory'),
  localAgentsRoot:
    process.env.OPENCLAW_LOCAL_AGENTS_ROOT ??
    path.join(process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory'), 'agents'),

  // --- git sync ---
  git: {
    repoUrl: process.env.OPENCLAW_SPECS_REPO_URL ?? '',
    branch: process.env.OPENCLAW_SPECS_BRANCH ?? 'main',
    githubToken: process.env.OPENCLAW_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? '',
    userName: process.env.OPENCLAW_GIT_USER_NAME ?? 'openclaw-control',
    userEmail: process.env.OPENCLAW_GIT_USER_EMAIL ?? 'openclaw@localhost',
    pullIntervalMs: Number(process.env.OPENCLAW_GIT_PULL_MS ?? 15_000),
    enabled: Boolean(process.env.OPENCLAW_SPECS_REPO_URL),
  },

  // --- claude code session JSONLs (host's, mounted read-only) ---
  claudeProjectsRoot: path.join(home, '.claude', 'projects'),

  ptahSpecsDirName: '.ptah/specs', // legacy, no longer scanned

  jwtSecret: process.env.OPENCLAW_JWT_SECRET ?? 'dev-secret-change-me',
  cookieName: 'openclaw_session',

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

  claude: {
    bin: process.env.CLAUDE_BIN ?? 'claude',
    defaultModel: process.env.CLAUDE_MODEL ?? '',
  },

  dashboardDir:
    process.env.OPENCLAW_DASHBOARD_DIR ??
    path.resolve(new URL('.', import.meta.url).pathname, '..', '..', 'dashboard', 'dist', 'dashboard', 'browser'),
};
