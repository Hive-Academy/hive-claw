import { request } from 'undici';
import { config } from './config.js';

/**
 * Provider-agnostic OpenAI-compatible chat client.
 *
 * Discord @mention chat goes through here, NOT through ptah-cli. ptah is
 * reserved for orchestration (the continuation loop / dispatch worker), where
 * its skill system + JSON-RPC interface earn their complexity. Conversational
 * chat just needs an LLM, so we hit the configured provider directly with the
 * standard OpenAI chat-completions shape.
 *
 * Supported providers: ollama, openai, openrouter, groq, custom (all
 * OpenAI-compatible). Anthropic uses a different request/response shape and
 * is intentionally not supported here yet — fall through to ollama if that's
 * what's set, and the user's Discord chat will still work.
 */

interface ProviderRoute {
  baseUrl: string;
  apiKey: string;
}

function resolveProvider(): ProviderRoute {
  const p = (config.llm.provider || 'ollama').toLowerCase();
  switch (p) {
    case 'ollama':
      return { baseUrl: config.llm.ollamaBaseUrl, apiKey: 'not-needed' };
    case 'openai':
      return { baseUrl: 'https://api.openai.com/v1', apiKey: config.llm.openaiApiKey };
    case 'openrouter':
      return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: config.llm.openrouterApiKey };
    case 'groq':
      return { baseUrl: 'https://api.groq.com/openai/v1', apiKey: config.llm.groqApiKey };
    case 'custom':
      return { baseUrl: config.llm.customBaseUrl, apiKey: config.llm.customApiKey };
    case 'anthropic':
      // Anthropic Messages API has a different shape; not implemented here.
      // Fall back to ollama so chat still works while the operator decides.
      console.warn('[llm] LLM_PROVIDER=anthropic is not yet supported by bot-bridge chat — falling back to ollama');
      return { baseUrl: config.llm.ollamaBaseUrl, apiKey: 'not-needed' };
    default:
      console.warn(`[llm] unknown LLM_PROVIDER=${p} — falling back to ollama`);
      return { baseUrl: config.llm.ollamaBaseUrl, apiKey: 'not-needed' };
  }
}

export async function chatComplete(
  systemPrompt: string,
  userMessage: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const route = resolveProvider();
  const url = `${route.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CHAT_TIMEOUT_MS ?? 90_000);

  const body = {
    model: config.llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    temperature: 0.7,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(route.apiKey && route.apiKey !== 'not-needed'
          ? { authorization: `Bearer ${route.apiKey}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.statusCode >= 400) {
      const text = await res.body.text();
      console.error(`[llm] ${url} returned ${res.statusCode}: ${text.slice(0, 500)}`);
      return null;
    }

    const data = (await res.body.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    console.warn('[llm] response had no assistant text', JSON.stringify(data).slice(0, 300));
    return null;
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.code === 'UND_ERR_ABORTED') {
      console.error(`[llm] chat timed out after ${timeoutMs}ms`);
    } else {
      console.error('[llm] chat failed', err?.message ?? err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
