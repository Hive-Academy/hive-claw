// `tools/mcpBridge.ts` — bridge gateway-tier MCP servers into Discord chat.
//
// Reads the same `openclaw.json` the gateway uses, spawns its own MCP clients
// (the gateway's internal session MCP runtime is not exposed to plugins),
// and registers every discovered tool as `mcp__<server>__<tool>`.
//
// Supported transports: stdio (command+args+env) and SSE (url).
//
// Error handling philosophy: fail fast at plugin load time for *discovery*
// errors (server won't start → log + skip), but fail gracefully at *call*
// time (connection dropped → return failedTextResult so the agent can react).

import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, AgentToolResult } from "openclaw/plugin-sdk/agent-runtime";
import { textResult, failedTextResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawPluginToolFactory,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

// MCP SDK — resolved from openclaw's node_modules at runtime.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CONFIG_PATH = "/home/agent/.openclaw/openclaw.json";

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  connectionTimeoutMs?: number;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Load MCP server definitions from the rendered openclaw.json.
 * Returns an empty record if the file is missing or has no `mcp.servers`.
 */
function loadMcpServers(): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as { mcp?: { servers?: Record<string, McpServerConfig> } };
    return config.mcp?.servers ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mcpBridge] Could not read ${CONFIG_PATH}: ${message}`);
    return {};
  }
}

/**
 * Lightweight SSE transport that uses native `fetch` so we can inject custom
 * headers (e.g. `Authorization: Bearer`). The stock `SSEClientTransport` from
 * `@modelcontextprotocol/sdk` relies on `EventSource` which does not support
 * custom headers in the browser spec; in Node.js the `eventsource` package
 * does support them, but the SDK's wrapper overrides the internal fetch and
 * discards constructor headers. This transport bypasses both problems.
 */
class FetchSseTransport {
  private _url: URL;
  private _headers: Record<string, string>;
  private _abortController: AbortController | null = null;
  private _endpoint: URL | null = null;
  private _endpointResolve: (() => void) | null = null;
  private _endpointPromise: Promise<void> | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(url: URL, headers: Record<string, string> = {}) {
    this._url = url;
    this._headers = headers;
  }

  async start(): Promise<void> {
    this._abortController = new AbortController();
    this._endpointPromise = new Promise<void>((resolve) => {
      this._endpointResolve = resolve;
    });

    try {
      const res = await fetch(this._url.href, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...this._headers,
        },
        signal: this._abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }

      const body = res.body;
      if (!body) throw new Error("SSE response has no body");

      // Begin consuming the stream in the background.
      this._consumeStream(body);

      // Wait up to 15 s for the initial `endpoint` event before returning.
      // The MCP protocol requires this event on connect; without it `send()`
      // has no URL to POST to.
      const timeoutMs = 15000;
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`SSE endpoint event not received within ${timeoutMs}ms`)), timeoutMs),
      );
      await Promise.race([this._endpointPromise, timeout]);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async send(message: unknown): Promise<void> {
    if (!this._endpoint) {
      throw new Error("SSE endpoint not yet available — wait for the endpoint event");
    }
    const res = await fetch(this._endpoint.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this._headers,
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      throw new Error(`POST to ${this._endpoint.href} failed: ${res.status} ${res.statusText}`);
    }
  }

  async close(): Promise<void> {
    this._abortController?.abort();
    this._abortController = null;
  }

  private async _consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while (
          (separator = buffer.indexOf("\n\n")) !== -1 ||
          (separator = buffer.indexOf("\r\n\r\n")) !== -1
        ) {
          const eventText = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          this._handleEvent(eventText);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        this._handleEvent(buffer);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      reader.releaseLock();
      this.onclose?.();
    }
  }

  private _handleEvent(text: string): void {
    const lines = text.split(/\r?\n/);
    let eventType = "message";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      }
    }

    if (eventType === "endpoint") {
      this._endpoint = new URL(data, this._url);
      this._endpointResolve?.();
      this._endpointResolve = null;
    } else if (eventType === "message") {
      try {
        const message = JSON.parse(data);
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(
          new Error(`Invalid JSON in SSE message: ${(err as Error).message}`),
        );
      }
    }
  }
}

/**
 * Spawn an MCP client for a single server config and discover its tools.
 * Supports stdio (command+args+env) and SSE (url) transports.
 *
 * For command-based configs (including mcp-remote stdio proxies) we use
 * StdioClientTransport and let the proxy handle the remote connection. For
 * bare url configs we use FetchSseTransport so custom auth headers reach the
 * SSE endpoint (the SDK's SSEClientTransport does not support headers).
 */
async function discoverServerTools(
  serverId: string,
  cfg: McpServerConfig,
): Promise<{ client: Client; tools: McpToolDescriptor[] }> {
  const client = new Client({
    name: `openclaw-control-plugin-${serverId}`,
    version: "0.1.0",
  });

  if (cfg.command) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
    });
    await client.connect(transport);
  } else if (cfg.url) {
    const transport = new FetchSseTransport(new URL(cfg.url));
    await client.connect(transport as any);
  } else {
    throw new Error(`MCP server "${serverId}": neither command nor url configured`);
  }

  const result = await client.listTools();
  const tools = (result.tools ?? []) as McpToolDescriptor[];
  return { client, tools };
}

/**
 * Build tool factories for every MCP tool discovered across all configured servers.
 *
 * Returns:
 *   - `factories`: an array of { name, factory } tuples ready for `api.registerTool()`.
 *   - `cleanup`: async teardown to close all MCP clients on shutdown.
 */
export async function buildMcpBridge(): Promise<{
  factories: Array<{ name: string; factory: OpenClawPluginToolFactory }>;
  cleanup: () => Promise<void>;
}> {
  const servers = loadMcpServers();
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    console.log("[mcpBridge] No MCP servers configured in openclaw.json");
    return { factories: [], cleanup: async () => {} };
  }

  const factories: Array<{ name: string; factory: OpenClawPluginToolFactory }> = [];
  const clients: Client[] = [];

  for (const [serverId, cfg] of entries) {
    try {
      const { client, tools } = await discoverServerTools(serverId, cfg);
      clients.push(client);

      for (const tool of tools) {
        const qualifiedName = `mcp__${serverId}__${tool.name}`;

        // Embed the JSON Schema in the description so the LLM knows what
        // parameters to pass even though we declare parameters as Type.Any().
        const schemaBlock = tool.inputSchema
          ? `\n\nParameter schema (JSON Schema):\n${JSON.stringify(tool.inputSchema, null, 2)}`
          : "";
        const description = `${tool.description ?? "No description provided."}${schemaBlock}`;

        // Factory: called per tool invocation. It closes over the persistent
        // MCP client so we don't reconnect on every call.
        const factory: OpenClawPluginToolFactory = (
          _ctx: OpenClawPluginToolContext,
        ): AnyAgentTool => ({
          name: qualifiedName,
          label: `${tool.name} (${serverId})`,
          description,
          // Accept any JSON payload — the MCP server validates the actual schema.
          parameters: Type.Any(),
          async execute(
            _toolCallId: string,
            params: unknown,
            _signal?: AbortSignal,
          ): Promise<AgentToolResult> {
            try {
              const result = await client.callTool({
                name: tool.name,
                arguments: params as Record<string, unknown>,
              });

              // MCP results are content arrays; collapse to a single text block.
              let outputText: string;
              if (
                Array.isArray(result.content) &&
                result.content.length > 0
              ) {
                outputText = result.content
                  .map((c: unknown) => {
                    if (typeof c === "object" && c !== null) {
                      const maybeText = (c as { text?: string; type?: string }).text;
                      if (typeof maybeText === "string") return maybeText;
                    }
                    return JSON.stringify(c);
                  })
                  .join("\n");
              } else {
                outputText = JSON.stringify(result);
              }

              return textResult(outputText, { server: serverId, tool: tool.name });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return failedTextResult(
                `MCP call failed for ${qualifiedName}: ${msg}`,
                { server: serverId, tool: tool.name, error: msg },
              );
            }
          },
        });

        factories.push({ name: qualifiedName, factory });
      }

      console.log(
        `[mcpBridge] Discovered ${tools.length} tool(s) from MCP server "${serverId}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcpBridge] Failed to connect to MCP server "${serverId}": ${msg}`);
      // Continue with other servers — don't let one bad server crash the bridge.
    }
  }

  const cleanup = async (): Promise<void> => {
    await Promise.all(
      clients.map(async (c) => {
        try {
          await c.close();
        } catch {
          // Best-effort cleanup.
        }
      }),
    );
  };

  return { factories, cleanup };
}
