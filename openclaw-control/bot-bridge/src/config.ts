import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

const internalToken = process.env.OPENCLAW_INTERNAL_TOKEN ?? '';
if (!internalToken) {
  // bot-bridge has no anonymous fallback against the daemon. The daemon's
  // localhost loopback `local-dev` user only applies to browser sessions
  // (cookie-JWT path), not to the Bearer-token path bot-bridge uses.
  throw new Error(
    'OPENCLAW_INTERNAL_TOKEN is required for bot-bridge — there is no anonymous fallback for the Bearer-token path.',
  );
}

export const config = {
  daemonUrl: process.env.OPENCLAW_DAEMON_URL ?? 'http://localhost:7878',
  internalToken,
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
    // Vision turn override. When the operator's message has attachments AND
    // the persona opts in via `chatTier.acceptAttachments: true`, chat.ts
    // overrides `model` for that turn. Empty string = "use llm.model as-is",
    // appropriate when LLM_MODEL is already a VLM (e.g. qwen3-vl:235b-cloud).
    visionModel: process.env.LLM_VISION_MODEL ?? '',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434/v1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    customBaseUrl: process.env.CUSTOM_BASE_URL ?? '',
    customApiKey: process.env.CUSTOM_API_KEY ?? '',
  },

  // Per-attachment download budget. Discord allows up to 25 MB on free tier
  // and 500 MB on boosted servers; we cap aggressively because base64-inlined
  // images blow up prompt size and Ollama Cloud / vision providers reject
  // anything past ~5–10 MB anyway. Operators can raise via env if they're
  // self-hosting a VLM with a different limit.
  attachmentMaxBytes: Number(process.env.OPENCLAW_ATTACHMENT_MAX_BYTES ?? 8 * 1024 * 1024),
  attachmentMaxCount: Number(process.env.OPENCLAW_ATTACHMENT_MAX_COUNT ?? 8),

  // TASK_2026_002 — chat-tier tool-calling feature flag + loop bounds.
  // Default OFF for safe rollout. See docs/CONFIGURATION.md (B8) for the
  // operator flip procedure once a per-persona harness.yaml lands.
  toolCallsEnabled: (process.env.OPENCLAW_BOT_TOOL_CALLS_ENABLED ?? '0') === '1',
  toolCallDepthLimit: Number(process.env.OPENCLAW_TOOL_CALL_DEPTH_LIMIT ?? 8),
  subagentDepthLimit: Number(process.env.OPENCLAW_SUBAGENT_DEPTH_LIMIT ?? 2),
  mcpDefaultTimeoutMs: Number(process.env.OPENCLAW_MCP_DEFAULT_TIMEOUT_MS ?? 30_000),
  skillsRoot: process.env.OPENCLAW_SKILLS_ROOT ?? '/home/agent/skills',

  // TASK_2026_002 B7 — harness-authoring chat idle timeout. Default 30 min
  // matches impl-plan §"Harness-authoring chat" line 1056. After this many
  // ms without user input, chat.ts auto-clears `ctx.state.harnessSetup` so
  // a forgotten conversation can't pin the LLM to the harness-author tool
  // registry forever. Zero or negative disables the timeout (test harness
  // override only — production should not run with auto-clear off).
  harnessAuthorTimeoutMs: Number(
    process.env.OPENCLAW_HARNESS_AUTHOR_TIMEOUT_MS ?? 1_800_000,
  ),
};
