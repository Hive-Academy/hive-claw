import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const config = {
  daemonUrl: process.env.OPENCLAW_DAEMON_URL ?? 'http://localhost:7878',
  internalToken: process.env.OPENCLAW_INTERNAL_TOKEN ?? '',
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

  // Free-form @mention chat hits the LLM provider directly — same env vars the
  // openclaw gateway uses (LLM_PROVIDER / LLM_MODEL / *_API_KEY / *_BASE_URL).
  // ptah is reserved for orchestration; it is not on the chat path.
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'ollama',
    model: process.env.LLM_MODEL ?? 'kimi-k2.6:cloud',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434/v1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    customBaseUrl: process.env.CUSTOM_BASE_URL ?? '',
    customApiKey: process.env.CUSTOM_API_KEY ?? '',
  },
};
