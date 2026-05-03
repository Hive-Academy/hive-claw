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

// ---------------------------------------------------------------------------
// Tool-calling loop (TASK_2026_002 B1).
//
// Drives an OpenAI-compatible /chat/completions endpoint until finish_reason
// is no longer 'tool_calls', or until the depth/wallclock budget is spent.
// `chatComplete` above remains the documented fallback path — do NOT refactor
// it through this function.
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
}

export interface ToolCallContext {
  agentId: string;
  userId: string;
  channelId: string;
  state: Map<string, unknown>;
  emit: (event: string, data: unknown) => void;
}

export interface ChatWithToolsOptions {
  timeoutMs?: number;
  maxDepth?: number;
  maxWallclockMs?: number;
  parallelToolCalls?: boolean;
}

export interface ToolCallAuditEntry {
  name: string;
  argsPreview: string;
  durationMs: number;
  ok: boolean;
}

export interface ChatWithToolsResult {
  content: string | null;
  trace: Array<{ round: number; calls: ToolCallAuditEntry[] }>;
  truncated: boolean;
  /** Populated only when the loop aborted on a network/provider error before any clean finish. */
  error?: string;
}

interface OAIToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

interface OAIChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: OAIToolCall[];
  };
  finish_reason?: string | null;
}

interface OAIChatResponse {
  choices?: OAIChoice[];
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function previewArgs(raw: string, limit = 200): string {
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit) + '…';
}

export async function chatCompleteWithTools(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  tools: ToolDef[],
  ctx: ToolCallContext,
  opts: ChatWithToolsOptions = {},
): Promise<ChatWithToolsResult> {
  const route = resolveProvider();
  const url = `${route.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const requestTimeoutMs = opts.timeoutMs ?? Number(process.env.CHAT_TIMEOUT_MS ?? 90_000);
  const maxDepth = opts.maxDepth ?? Number(process.env.OPENCLAW_TOOL_CALL_DEPTH_LIMIT ?? 8);
  const maxWallclockMs = opts.maxWallclockMs ?? 120_000;
  const parallelToolCalls = opts.parallelToolCalls ?? true;

  const toolByName = new Map<string, ToolDef>();
  for (const t of tools) toolByName.set(t.name, t);

  const oaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const convo: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  const trace: Array<{ round: number; calls: ToolCallAuditEntry[] }> = [];
  const startedAt = Date.now();

  for (let depth = 0; depth < maxDepth; depth++) {
    if (Date.now() - startedAt >= maxWallclockMs) {
      return { content: lastAssistantText(convo), trace, truncated: true };
    }

    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: convo,
      stream: false,
      temperature: 0.7,
    };
    if (oaiTools.length > 0) {
      body.tools = oaiTools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = parallelToolCalls;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    let data: OAIChatResponse;
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
        const errMsg = `${url} returned ${res.statusCode}: ${text.slice(0, 500)}`;
        console.error(`[llm] ${errMsg}`);
        return { content: null, trace, truncated: false, error: errMsg };
      }

      data = (await res.body.json()) as OAIChatResponse;
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      const errMsg =
        e?.name === 'AbortError' || e?.code === 'UND_ERR_ABORTED'
          ? `chat timed out after ${requestTimeoutMs}ms`
          : `chat failed: ${e?.message ?? String(err)}`;
      console.error(`[llm] ${errMsg}`);
      return { content: null, trace, truncated: false, error: errMsg };
    } finally {
      clearTimeout(timer);
    }

    const choice = data?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason ?? null;
    const toolCalls = message?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const content = typeof message?.content === 'string' ? message.content : null;
      return { content: content && content.trim() ? content : null, trace, truncated: false };
    }

    // Append the assistant turn that issued the tool calls. The OpenAI
    // protocol requires this BEFORE the matching tool messages.
    convo.push({
      role: 'assistant',
      content: typeof message?.content === 'string' ? message.content : null,
      tool_calls: toolCalls,
    });

    const calls: ToolCallAuditEntry[] = [];

    for (const call of toolCalls) {
      const callStart = Date.now();
      const callId = call.id ?? `call_${depth}_${calls.length}`;
      const rawArgs = call.function?.arguments ?? '';
      const toolName = call.function?.name ?? '';

      let parsedArgs: Record<string, unknown> | null = null;
      let parseError: string | null = null;
      try {
        parsedArgs = rawArgs.trim() === '' ? {} : (JSON.parse(rawArgs) as Record<string, unknown>);
      } catch (err) {
        parseError = `tool_calls.arguments was not valid JSON: ${(err as Error).message}`;
      }

      if (parseError !== null) {
        const auditEntry: ToolCallAuditEntry = {
          name: toolName,
          argsPreview: previewArgs(rawArgs),
          durationMs: Date.now() - callStart,
          ok: false,
        };
        calls.push(auditEntry);
        try {
          ctx.emit('invoker.tool_call', {
            depth,
            name: toolName,
            ok: false,
            error: parseError,
            durationMs: auditEntry.durationMs,
          });
        } catch {
          // Observability emitter must never break the loop.
        }
        convo.push({
          role: 'tool',
          tool_call_id: callId,
          content: `error: ${parseError}`,
        });
        continue;
      }

      const tool = toolByName.get(toolName);
      if (!tool) {
        const auditEntry: ToolCallAuditEntry = {
          name: toolName,
          argsPreview: previewArgs(rawArgs),
          durationMs: Date.now() - callStart,
          ok: false,
        };
        calls.push(auditEntry);
        try {
          ctx.emit('invoker.tool_call', {
            depth,
            name: toolName,
            ok: false,
            error: 'unknown tool',
            durationMs: auditEntry.durationMs,
          });
        } catch {
          // intentionally swallowed
        }
        convo.push({
          role: 'tool',
          tool_call_id: callId,
          content: `error: unknown tool "${toolName}"`,
        });
        continue;
      }

      try {
        const result = await tool.handler(parsedArgs ?? {}, ctx);
        const durationMs = Date.now() - callStart;
        calls.push({ name: toolName, argsPreview: previewArgs(rawArgs), durationMs, ok: true });
        try {
          ctx.emit('invoker.tool_call', { depth, name: toolName, ok: true, durationMs });
        } catch {
          // intentionally swallowed
        }
        convo.push({ role: 'tool', tool_call_id: callId, content: result });
      } catch (err) {
        const errMsg = (err as Error)?.message ?? String(err);
        const durationMs = Date.now() - callStart;
        calls.push({ name: toolName, argsPreview: previewArgs(rawArgs), durationMs, ok: false });
        try {
          ctx.emit('invoker.tool_call', {
            depth,
            name: toolName,
            ok: false,
            error: errMsg,
            durationMs,
          });
        } catch {
          // intentionally swallowed
        }
        convo.push({
          role: 'tool',
          tool_call_id: callId,
          content: `error: ${errMsg}`,
        });
      }
    }

    trace.push({ round: depth, calls });

    if (finishReason !== 'tool_calls') {
      // Some providers report 'stop' alongside tool_calls when the model
      // intends the calls to be terminal. We've already executed them; loop
      // again so the model can synthesize a final reply against the tool
      // results, but only if depth budget remains.
      // (Continue — the next iteration will hit a no-tool response.)
    }
  }

  // Depth budget exhausted with at least one outstanding tool round.
  return { content: lastAssistantText(convo), trace, truncated: true };
}

function lastAssistantText(convo: ChatMessage[]): string | null {
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}
