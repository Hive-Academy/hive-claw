// tools/discordTools.ts — TASK_2026_003 Discord-native chat tools.
//
// Two opt-in tools the chat-tier LLM can invoke during a Discord
// conversation. Both must be listed in `harness.yaml`'s `chatTier.tools` to
// appear in the registry; absent from the harness → absent from the registry.
//
//   1. `read_channel_history`  — fetch recent messages from a Discord channel
//      or DM for context awareness. Default scope is the channel where the
//      conversation is happening; an explicit `channelId` is optionally
//      allowed but only succeeds if the bot is already a member of that
//      channel (discord.js + the Discord REST gate enforce this naturally).
//
//   2. `upload_attachment`     — post a file or image into the current
//      Discord channel. The path-source mode is the highest-risk surface in
//      the bot — it's a 6th defense layer of the persona privacy invariant.
//      See `docs/SECURITY.md` and the comments on `assertPathInsideProject`.
//
// Mirrors the pattern set by `daemonTools.ts` / `subagentTools.ts`:
// `list(...)` / `listForAgent(...)` returns OpenAI-shaped `ToolDef[]`,
// `call(name, args, ctx)` is implemented via the `handler` closure on each
// def. The chat dispatcher in `llm.ts` calls the handlers — there is no
// separate `call()` entry point.
//
// Hard constraints: no new runtime deps; `undici` (already a dep) handles
// URL fetches; Node built-ins for filesystem and path work. Strict TS, ESM.

import { Buffer } from 'node:buffer';
import * as dns from 'node:dns/promises';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { URL } from 'node:url';
import { request } from 'undici';
import type { Message, TextBasedChannel } from 'discord.js';
import type { ToolCallContext, ToolDef } from '../llm.js';
import type { AgentDef } from '../agentRegistry.js';
import { daemon } from '../daemonClient.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's per-message attachment cap on free / Nitro-Basic servers. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Operator-tunable override (env var). 0 / NaN / negative falls back to the default. */
function maxAttachmentBytes(): number {
  const raw = Number(process.env.OPENCLAW_DISCORD_TOOLS_MAX_ATTACHMENT_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_ATTACHMENT_BYTES;
  return Math.floor(raw * 1024 * 1024);
}

/** URL-fetch timeout for the `url` source mode. 5s per the brief. */
const URL_FETCH_TIMEOUT_MS = 5_000;

/** Maximum redirect chain we will follow for `url` source mode. */
const URL_MAX_REDIRECTS = 3;

/**
 * Files that must NEVER traverse this tool surface, mirroring
 * `PRIVATE_AGENT_FILES` in `agentRegistry.ts` (and ultimately
 * `daemon/src/db/memory.ts`). Defense in depth — this set is the bot-bridge
 * tool-layer copy, NOT the source of truth.
 */
const PRIVATE_AGENT_FILES = new Set([
  'persona.md',
  'persona.json',
  'secrets.md',
  'secrets.json',
]);

/**
 * Path segments that always indicate a private filesystem region the
 * upload tool must refuse. Matches as a path component (`<sep>X<sep>`),
 * not as a substring — so `mylocal-memory-stuff/` won't trip on
 * `local-memory`. See `containsForbiddenSegment`.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  'local-memory',
  '.claude',
  '.ptah',
]);

/**
 * Tool names this module exposes. Kept in a Set so harness validation has a
 * single source of truth.
 */
export const SUPPORTED_TOOL_NAMES = new Set([
  'read_channel_history',
  'upload_attachment',
]);

// ---------------------------------------------------------------------------
// Helpers — argument extraction
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${toolName}: required argument "${key}" must be a non-empty string`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return v;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`required argument "${key}" must be an integer (got ${typeof v})`);
  }
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Helpers — discord.js context narrowing
// ---------------------------------------------------------------------------

/**
 * Pull the live `Message` reference out of `ToolCallContext.discord`. Throws
 * a structured error when the context was built without a Discord side-
 * channel (e.g. a unit test, or a subagent context where these tools are
 * disabled by design — see `subagentRunner.ts` for how the parent registry
 * is filtered).
 */
function requireMessage(ctx: ToolCallContext, toolName: string): Message {
  if (!ctx.discord || !ctx.discord.message) {
    throw new Error(
      `${toolName}: no Discord message in tool context — this tool can only run during a live Discord conversation, not from a subagent or background invocation.`,
    );
  }
  return ctx.discord.message as Message;
}

// ---------------------------------------------------------------------------
// SSRF / private-IP guard for url source mode
// ---------------------------------------------------------------------------

/**
 * Reject any IP literal that points back into a host-private address space.
 * This is the SSRF guard for `upload_attachment(source.type='url')`.
 *
 * Covers IPv4 (loopback 127.0.0.0/8, link-local 169.254.0.0/16, RFC1918
 * 10.x, 172.16-31.x, 192.168.x, multicast 224-239, broadcast 255.255.255.255,
 * unspecified 0.0.0.0/8) and the most common IPv6 ranges (loopback ::1,
 * link-local fe80::/10, unique-local fc00::/7, mapped v4 ::ffff:0.0.0.0/96).
 *
 * Hostnames are resolved through `dns.lookup` BEFORE the fetch (see
 * `fetchUrlAsBuffer`), so this function is the only place where the
 * IP-blocklist policy lives.
 */
function isPrivateIp(addr: string): boolean {
  // IPv4
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map((s) => Number(s));
    if (a === undefined || b === undefined) return true; // malformed → reject
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224 && a <= 239) return true; // multicast
    if (a === 255) return true; // broadcast
    return false;
  }
  // IPv6
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
    if (lower.startsWith('ff')) return true; // multicast
    // ::ffff:0.0.0.0/96 — IPv4-mapped. Strip the prefix and re-check as v4.
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length);
      if (net.isIPv4(tail) && isPrivateIp(tail)) return true;
    }
    return false;
  }
  // Not an IP literal — caller should reject (only literals reach here in our path).
  return true;
}

/**
 * Resolve a hostname to its v4 + v6 addresses and reject if ANY resolved
 * address is in a private range. We reject the whole hostname rather than
 * filter to public addresses: an attacker with DNS control could otherwise
 * race the resolver to swap a public answer for a private one between our
 * check and the kernel's connect.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  // Pure IP literal — check directly.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(
        `SSRF guard: refusing to fetch from private/loopback IP "${hostname}"`,
      );
    }
    return;
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `SSRF guard: failed to resolve "${hostname}": ${(err as Error).message}`,
    );
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      throw new Error(
        `SSRF guard: hostname "${hostname}" resolves to private/loopback address ${r.address} — refusing to fetch.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Path-source guards
// ---------------------------------------------------------------------------

function containsForbiddenSegment(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  for (const seg of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return true;
  }
  return false;
}

/**
 * Resolve `relativePath` against `projectRoot`, then assert:
 *
 *   1. The resolved path is INSIDE `projectRoot` (prefix check using
 *      path.resolve + a `path.sep`-padded prefix match — NOT `String#includes`,
 *      which is the broken pattern the brief explicitly warns against).
 *   2. The resolved path does NOT contain any forbidden segment
 *      (`local-memory`, `.claude`, `.ptah`).
 *   3. The resolved basename is NOT a `PRIVATE_AGENT_FILES` member.
 *
 * Returns the absolute, canonical path on success; throws a structured
 * `Error` with a leading "path guard:" prefix on any failure.
 *
 * This is enforcement layer 6 of the persona privacy invariant. See
 * `CLAUDE.md` "Persona privacy rule" for layers 1–5.
 */
function assertPathInsideProject(projectRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('path guard: relative path must be a non-empty string');
  }
  if (relativePath.includes('\0')) {
    throw new Error('path guard: NUL byte in path');
  }
  const absRoot = path.resolve(projectRoot);
  const absResolved = path.resolve(absRoot, relativePath);
  // Prefix check: must equal the root or live under `<root>/`. The trailing
  // separator is critical — without it, `/a/projectfoo` would pass
  // `startsWith('/a/project')`. Equality covers the "the file IS the root"
  // edge (impossible for a regular file but cheap to handle).
  if (absResolved !== absRoot && !absResolved.startsWith(absRoot + path.sep)) {
    throw new Error(
      `path guard: resolved path "${absResolved}" escapes project root "${absRoot}"`,
    );
  }
  if (containsForbiddenSegment(absResolved)) {
    throw new Error(
      `path guard: resolved path "${absResolved}" contains a forbidden segment (local-memory / .claude / .ptah)`,
    );
  }
  const basename = path.basename(absResolved);
  if (PRIVATE_AGENT_FILES.has(basename)) {
    throw new Error(
      `path guard: refusing to upload a private agent file "${basename}"`,
    );
  }
  return absResolved;
}

/**
 * `safeFile` for the `data` source mode — the bot-bridge equivalent of the
 * daemon's `safeFile` helper in `daemon/src/memory.ts`. Cross-package import
 * isn't possible (separate npm packages), so we keep a local copy with the
 * SAME regex. Drift against the daemon copy is an audit smell — there is a
 * `MUST match` comment on the daemon side too.
 *
 * Discord allows a wider filename set than memory does, but we deliberately
 * keep the same allow-list here for two reasons:
 *  1. Symmetry with the persona-privacy chokepoint — fewer surprises for
 *     reviewers comparing the two sides.
 *  2. Defense against shell-meta filename smuggling if a downstream consumer
 *     of the Discord attachment fetches and re-saves the file by name.
 */
function safeFile(name: string): string {
  if (!/^[A-Za-z0-9_\-.]+\.(md|json|yaml|txt|png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|csv|tsv|log|html|js|ts|py|sh)$/i.test(
    name,
  )) {
    throw new Error(
      `safeFile: filename "${name}" rejected — must match the allow-list (alphanumerics, underscore, hyphen, dot, with a known extension)`,
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// URL-source fetcher (with SSRF guard, redirect limit, body cap, timeout)
// ---------------------------------------------------------------------------

interface FetchedAttachment {
  buffer: Buffer;
  contentType: string | null;
  finalUrl: string;
}

async function fetchUrlAsBuffer(rawUrl: string): Promise<FetchedAttachment> {
  const cap = maxAttachmentBytes();
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= URL_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch (err) {
      throw new Error(`upload_attachment: invalid url "${currentUrl}": ${(err as Error).message}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `upload_attachment: only https:// urls are allowed (got "${parsed.protocol}")`,
      );
    }
    await assertPublicHost(parsed.hostname);

    // We disable undici's redirect-following so we can count hops ourselves
    // and re-run the SSRF guard on every redirect target.
    const res = await request(parsed.toString(), {
      method: 'GET',
      headersTimeout: URL_FETCH_TIMEOUT_MS,
      bodyTimeout: URL_FETCH_TIMEOUT_MS,
      maxRedirections: 0,
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers['location'];
      const locStr = Array.isArray(loc) ? loc[0] : loc;
      if (typeof locStr !== 'string' || locStr.length === 0) {
        await res.body.dump();
        throw new Error(
          `upload_attachment: redirect (${res.statusCode}) without Location header`,
        );
      }
      await res.body.dump();
      // Resolve relative redirects against the current url.
      currentUrl = new URL(locStr, currentUrl).toString();
      continue;
    }
    if (res.statusCode >= 400) {
      const text = (await res.body.text()).slice(0, 300);
      throw new Error(
        `upload_attachment: fetch failed for "${currentUrl}" — HTTP ${res.statusCode}: ${text}`,
      );
    }
    // Stream into a buffer with the size cap enforced incrementally.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > cap) {
        throw new Error(
          `upload_attachment: response body exceeds ${cap} byte cap (got >${total})`,
        );
      }
      chunks.push(buf);
    }
    const ct = res.headers['content-type'];
    const ctStr = Array.isArray(ct) ? ct[0] : ct;
    return {
      buffer: Buffer.concat(chunks),
      contentType: typeof ctStr === 'string' ? ctStr : null,
      finalUrl: currentUrl,
    };
  }
  throw new Error(
    `upload_attachment: too many redirects (>${URL_MAX_REDIRECTS}) starting from "${rawUrl}"`,
  );
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function buildReadChannelHistoryTool(): ToolDef {
  return {
    name: 'read_channel_history',
    description:
      'Fetch the last N messages from a Discord channel or DM for context. ' +
      'Defaults to the channel where the current conversation is happening. ' +
      'Returns a JSON array of { id, authorId, authorTag, timestamp, content, attachmentUrls[] }.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Number of messages to fetch (1–100). Defaults to 20. Capped to 100 by the Discord API.',
        },
        channelId: {
          type: 'string',
          description:
            'Optional Discord channel id. If omitted, uses the channel where this conversation is happening. ' +
            'A non-default channel only works when the bot is already a member of it.',
        },
        before: {
          type: 'string',
          description:
            'Optional Discord message snowflake — fetch messages strictly older than this id (pagination).',
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const message = requireMessage(ctx, 'read_channel_history');
      let limit = optionalInteger(args, 'limit') ?? 20;
      if (limit < 1) limit = 1;
      if (limit > 100) limit = 100;
      const explicitChannelId = optionalString(args, 'channelId');
      const before = optionalString(args, 'before');

      let channel: TextBasedChannel;
      if (explicitChannelId && explicitChannelId !== message.channel.id) {
        // discord.js will throw if the bot is not a member, or if the channel
        // type does not support text. We surface those errors verbatim — the
        // chat dispatcher converts them to a tool-error message.
        const fetched = await message.client.channels.fetch(explicitChannelId);
        if (!fetched || !('messages' in fetched) || typeof (fetched as any).messages?.fetch !== 'function') {
          throw new Error(
            `read_channel_history: channel "${explicitChannelId}" does not exist or is not text-based`,
          );
        }
        channel = fetched as unknown as TextBasedChannel;
      } else {
        channel = message.channel;
      }

      const fetchOpts: { limit: number; before?: string } = { limit };
      if (before) fetchOpts.before = before;
      const collection = await (channel as any).messages.fetch(fetchOpts);

      // discord.js returns a Collection (Map). Sort newest→oldest, materialize
      // the slim shape the LLM cares about.
      const out: Array<{
        id: string;
        authorId: string;
        authorTag: string;
        timestamp: string;
        content: string;
        attachmentUrls: string[];
      }> = [];
      for (const m of (collection as Map<string, Message>).values()) {
        const atts: string[] = [];
        for (const a of m.attachments.values()) atts.push(a.url);
        out.push({
          id: m.id,
          authorId: m.author?.id ?? '',
          authorTag:
            (m.author as any)?.tag ??
            m.author?.username ??
            '',
          timestamp: m.createdAt.toISOString(),
          content: m.content ?? '',
          attachmentUrls: atts,
        });
      }
      // Stable order — newest first, deterministic for tests.
      out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return JSON.stringify(out);
    },
  };
}

interface UploadAttachmentSource {
  type: 'url' | 'path' | 'data';
  url?: string;
  path?: string;
  base64?: string;
  filename?: string;
  mimeType?: string;
}

function parseUploadSource(args: Record<string, unknown>): UploadAttachmentSource {
  const raw = args.source;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('upload_attachment: required argument "source" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type === 'url') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    if (!url) throw new Error('upload_attachment: source.type="url" requires source.url (string)');
    return { type, url };
  }
  if (type === 'path') {
    const p = typeof obj.path === 'string' ? obj.path : '';
    if (!p) throw new Error('upload_attachment: source.type="path" requires source.path (string)');
    return { type, path: p };
  }
  if (type === 'data') {
    const base64 = typeof obj.base64 === 'string' ? obj.base64 : '';
    const filename = typeof obj.filename === 'string' ? obj.filename : '';
    const mimeType = typeof obj.mimeType === 'string' ? obj.mimeType : '';
    if (!base64) throw new Error('upload_attachment: source.type="data" requires source.base64 (string)');
    if (!filename) throw new Error('upload_attachment: source.type="data" requires source.filename (string)');
    if (!mimeType) throw new Error('upload_attachment: source.type="data" requires source.mimeType (string)');
    return { type, base64, filename, mimeType };
  }
  throw new Error(
    `upload_attachment: source.type must be "url" | "path" | "data" (got ${JSON.stringify(type)})`,
  );
}

function buildUploadAttachmentTool(): ToolDef {
  return {
    name: 'upload_attachment',
    description:
      'Post an attachment (file or image) into the current Discord channel. ' +
      'The source can be an https URL (SSRF-guarded), a project-relative file path, ' +
      'or inline base64 data. Returns { ok, messageId, attachmentUrl }.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'url' },
                url: {
                  type: 'string',
                  description: 'Public HTTPS URL. Private IPs and loopback are rejected.',
                },
              },
              required: ['type', 'url'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'path' },
                path: {
                  type: 'string',
                  description:
                    'Relative path under the project workspace. Paths under local-memory/, .claude/, .ptah/, ' +
                    'or matching PRIVATE_AGENT_FILES (persona.md, secrets.md, ...) are rejected.',
                },
              },
              required: ['type', 'path'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'data' },
                base64: {
                  type: 'string',
                  description: 'Base64-encoded body. Capped at the configured attachment size.',
                },
                filename: {
                  type: 'string',
                  description: 'Filename for the attachment. Required for type="data".',
                },
                mimeType: {
                  type: 'string',
                  description: 'MIME type of the inline data.',
                },
              },
              required: ['type', 'base64', 'filename', 'mimeType'],
              additionalProperties: false,
            },
          ],
        },
        caption: {
          type: 'string',
          description: 'Optional message body text accompanying the attachment.',
        },
        filename: {
          type: 'string',
          description:
            'Optional override for the displayed filename. Required when source.type="data" if not provided in source.filename.',
        },
        project: {
          type: 'string',
          description:
            'Project slug — required for source.type="path". Used to resolve the project root.',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const message = requireMessage(ctx, 'upload_attachment');
      const source = parseUploadSource(args);
      const caption = optionalString(args, 'caption') ?? '';
      const captionSafe = caption.length > 1900 ? caption.slice(0, 1900) : caption;
      const filenameOverride = optionalString(args, 'filename');
      const cap = maxAttachmentBytes();

      let buffer: Buffer;
      let resolvedFilename: string;

      if (source.type === 'url') {
        const fetched = await fetchUrlAsBuffer(source.url!);
        buffer = fetched.buffer;
        const fromUrl = path.basename(new URL(fetched.finalUrl).pathname) || 'download';
        resolvedFilename = filenameOverride ?? fromUrl;
        // Validate the chosen filename against safeFile so we don't write a
        // filename to Discord that smuggles shell metas if any downstream
        // consumer mirrors it. Hostnames-as-paths from URLs are unlikely to
        // pass the regex, so we fall back to a safe default on failure.
        try {
          safeFile(resolvedFilename);
        } catch {
          resolvedFilename = 'download.bin';
        }
      } else if (source.type === 'path') {
        const slug = optionalString(args, 'project');
        if (!slug) {
          throw new Error('upload_attachment: source.type="path" requires the "project" argument');
        }
        // Look up the project's working-tree path via the daemon. This is the
        // same surface daemonTools.create_task etc. use; the daemon is the
        // source of truth for project paths.
        const projects = (await daemon.listProjects()) as Array<{ slug: string; path?: string }>;
        const proj = projects.find((p) => p.slug === slug);
        if (!proj) {
          throw new Error(`upload_attachment: project "${slug}" not found`);
        }
        if (!proj.path || !proj.path.startsWith('/')) {
          throw new Error(
            `upload_attachment: project "${slug}" has no resolved workspace path`,
          );
        }
        const absPath = assertPathInsideProject(proj.path, source.path!);
        const stat = await fsp.stat(absPath);
        if (!stat.isFile()) {
          throw new Error(`upload_attachment: "${absPath}" is not a regular file`);
        }
        if (stat.size > cap) {
          throw new Error(
            `upload_attachment: file "${absPath}" exceeds ${cap} byte cap (got ${stat.size})`,
          );
        }
        buffer = await fsp.readFile(absPath);
        const baseName = path.basename(absPath);
        resolvedFilename = filenameOverride ?? baseName;
        safeFile(resolvedFilename); // hard-fail on bad filename overrides
      } else {
        // source.type === 'data'
        // Estimate decoded size cheaply: base64 is 4 chars per 3 bytes, so
        // decoded bytes ≈ floor(len * 3 / 4). Reject upfront before allocating.
        const b64 = source.base64!;
        const decodedSize = Math.floor((b64.length * 3) / 4);
        if (decodedSize > cap) {
          throw new Error(
            `upload_attachment: base64 payload would decode to >${decodedSize} bytes (cap ${cap})`,
          );
        }
        buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > cap) {
          throw new Error(
            `upload_attachment: decoded payload exceeds ${cap} byte cap (got ${buffer.byteLength})`,
          );
        }
        const candidate = filenameOverride ?? source.filename!;
        resolvedFilename = safeFile(candidate);
      }

      // Send via discord.js. We construct the AttachmentBuilder lazily to
      // keep the import cost off the cold path.
      const { AttachmentBuilder } = await import('discord.js');
      const attachment = new AttachmentBuilder(buffer, { name: resolvedFilename });
      const sent = await (message.channel as any).send({
        content: captionSafe || undefined,
        files: [attachment],
      });
      const attachmentUrl =
        sent?.attachments?.first?.()?.url ??
        sent?.attachments?.values?.().next?.()?.value?.url ??
        null;
      return JSON.stringify({
        ok: true,
        messageId: sent?.id ?? null,
        attachmentUrl,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Build the chat-tier Discord-tools registry slice for an agent.
 *
 * Only tools listed in `agent.harness.chatTier.tools` are emitted. Unknown
 * names are dropped with a `console.warn` so a typo doesn't silently disable
 * a tool the operator thought they'd enabled. An agent with no harness or no
 * `tools` field returns an empty list — the chat tier behavior is unchanged
 * for personas that haven't opted in.
 */
export function listForAgent(agent: AgentDef): ToolDef[] {
  const requested = agent.harness?.chatTier?.tools ?? [];
  if (requested.length === 0) return [];
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!SUPPORTED_TOOL_NAMES.has(name)) {
      console.warn(
        `[discord-tools] agent "${agent.id}" requested unknown tool "${name}" — supported: ${[...SUPPORTED_TOOL_NAMES].join(', ')}`,
      );
      continue;
    }
    if (name === 'read_channel_history') out.push(buildReadChannelHistoryTool());
    else if (name === 'upload_attachment') out.push(buildUploadAttachmentTool());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Test-only: build the full registry regardless of harness opt-in. Used by
 * `test/integration/discord-tools.test.ts` to exercise both tools without
 * needing a fixture harness.
 */
export function __listAllForTests(): ToolDef[] {
  return [buildReadChannelHistoryTool(), buildUploadAttachmentTool()];
}

/** Test-only: expose the path-guard for direct assertions. */
export const __test_assertPathInsideProject = assertPathInsideProject;

/** Test-only: expose the SSRF guard for direct assertions. */
export const __test_assertPublicHost = assertPublicHost;

/** Test-only: expose the safeFile helper for direct assertions. */
export const __test_safeFile = safeFile;
