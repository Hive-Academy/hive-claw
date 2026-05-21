// tools/mcpTools.ts — gateway-tier MCP bridge for the bot-bridge chat tier.
//
// Reads the same `openclaw.json` the gateway uses, spawns its own MCP clients,
// and exposes every discovered tool as an `mcp__<server>__<tool>` ToolDef.
//
// TASK_2026_006 Batch 12 follow-up — restores MCP tool availability in Discord
// chat after Batch 8 deleted the original bot-bridge MCP manager.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDef } from "../llm.js";

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

function loadMcpServers(): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as { mcp?: { servers?: Record<string, McpServerConfig> } };
    return config.mcp?.servers ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mcpTools] Could not read ${CONFIG_PATH}: ${message}`);
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
          buffer = buffer.slice(separator + (buffer.charAt(separator) === "\r" ? 4 : 2));
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
      // id: and :comment are ignored
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

async function discoverServerTools(
  serverId: string,
  cfg: McpServerConfig,
): Promise<{ client: Client; tools: McpToolDescriptor[] }> {
  const client = new Client({
    name: `openclaw-control-botbridge-${serverId}`,
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

// ---------------------------------------------------------------------------
// Persistent state — clients and discovered tools survive across messages.
// ---------------------------------------------------------------------------

let discoveryPromise: Promise<ToolDef[]> | null = null;
let toolsCache: ToolDef[] = [];
let cleanupRegistered = false;

async function runDiscovery(): Promise<ToolDef[]> {
  const servers = loadMcpServers();
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    console.log("[mcpTools] No MCP servers configured in openclaw.json");
    return [];
  }

  const clients: Client[] = [];
  const out: ToolDef[] = [];

  for (const [serverId, cfg] of entries) {
    try {
      const { client, tools } = await discoverServerTools(serverId, cfg);
      clients.push(client);

      for (const tool of tools) {
        const qualifiedName = `mcp__${serverId}__${tool.name}`;
        const schemaBlock = tool.inputSchema
          ? `\n\nParameter schema (JSON Schema):\n${JSON.stringify(tool.inputSchema, null, 2)}`
          : "";
        const description = `${tool.description ?? "No description provided."}${schemaBlock}`;

        out.push({
          name: qualifiedName,
          description,
          parameters: { type: "object", properties: {}, additionalProperties: true },
          handler: async (args: Record<string, unknown>) => {
            try {
              const result = await client.callTool({
                name: tool.name,
                arguments: args,
              });

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
              return outputText;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(`MCP call failed for ${qualifiedName}: ${msg}`);
            }
          },
        });
      }

      console.log(
        `[mcpTools] Discovered ${tools.length} tool(s) from MCP server "${serverId}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcpTools] Failed to connect to MCP server "${serverId}": ${msg}`);
    }
  }

  // Register one-shot cleanup on process signals.
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    const doCleanup = () => {
      Promise.all(
        clients.map(async (c) => {
          try {
            await c.close();
          } catch {
            // best-effort
          }
        }),
      ).catch(() => {});
    };
    process.once("SIGTERM", doCleanup);
    process.once("SIGINT", doCleanup);
  }

  return out;
}

/**
 * Return the cached MCP tool registry for the given agent.
 * Discovery runs once on first call (async in the background).  If discovery
 * fails for a server, its tools are silently omitted so chat can continue.
 */
export async function listForAgent(_agentId: string): Promise<ToolDef[]> {
  if (!discoveryPromise) {
    discoveryPromise = runDiscovery().catch((err) => {
      console.error("[mcpTools] Discovery failed:", err);
      return [];
    });
  }
  toolsCache = await discoveryPromise;
  return toolsCache;
}
