import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const config = {
  daemonUrl: process.env.OPENCLAW_DAEMON_URL ?? 'http://localhost:7878',
  agentsRoot:
    process.env.OPENCLAW_AGENTS_ROOT ??
    path.join(process.env.OPENCLAW_SHARED_SPECS ?? path.join(home, '.claude', 'shared-specs'), 'memory', 'agents'),
  sharedMemoryRoot:
    process.env.OPENCLAW_SHARED_MEMORY ??
    path.join(process.env.OPENCLAW_SHARED_SPECS ?? path.join(home, '.claude', 'shared-specs'), 'memory'),
  localAgentsRoot:
    process.env.OPENCLAW_LOCAL_AGENTS_ROOT ??
    path.join(process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory'), 'agents'),
  redisUrl: process.env.REDIS_URL ?? '',
  defaultProject: process.env.OPENCLAW_DEFAULT_PROJECT ?? '',
  commandPrefix: process.env.BOT_PREFIX ?? '!',
};
