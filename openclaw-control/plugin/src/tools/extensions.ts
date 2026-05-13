// `tools/extensions.ts` — the five extension-install / ClawHub tool factories
// per amendment §16.4.
//
// All five tools call only daemon routes — none shells out to docker or
// openclaw directly. The daemon owns the docker-control privilege via its
// docker.sock bind.
//
//   request_plugin_install        → POST /api/extensions/install-requests
//   request_mcp_skill_install     → POST /api/extensions/install-requests
//   list_installed_plugins        → GET  /api/extensions/installed
//   list_installed_mcp_skills     → GET  /api/extensions/installed
//   search_clawhub                → GET  /api/extensions/clawhub/search   (NYI)
//
// Return-shape pattern matches `daemonCrud.ts` (Batch 5): `textResult` on
// success, `failedTextResult` on daemon error or input rejection.
//
// Input validation (arch §7.1 layer 6) — same defense-in-depth as the CRUD
// tools:
//   - `slug`:   trim, reject empty, cap at 200 chars, reject control chars.
//   - `reason`: trim, reject empty, cap at MAX_TEXT_LENGTH (50_000).
//   - `query`:  same as reason cap.
//
// After Batch 8c, the plugin registers 12 tools total: `invoke_ptah` (Batch
// 4) + 6 daemon-CRUD (Batch 5) + the 5 here.

import { Type, type Static } from "@sinclair/typebox";
import type {
  OpenClawPluginToolFactory,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  AnyAgentTool,
  AgentToolResult,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  textResult,
  failedTextResult,
} from "openclaw/plugin-sdk/agent-runtime";

import {
  daemon,
  type ExtensionKind,
  type InstalledItem,
  type ClawhubSearchResult,
} from "../daemonClient.js";
import { validateText, MAX_TEXT_LENGTH } from "../validators.js";

// ---------------------------------------------------------------------------
// Slug validation — extension slugs are richer than project slugs (they
// include `:` and `/`, e.g. `clawhub:dbalve/fast-io` or `npm:@scope/pkg`).
// We only reject the truly unsafe characters: ASCII control chars and
// newlines/CRs. Length cap at 200 (the daemon caps at 256; we belt-and-brace
// at 200 client-side).
// ---------------------------------------------------------------------------

const MAX_SLUG_LENGTH = 200;

function validateSlug(raw: unknown): { value: string; error: string | null } {
  // Defense-in-depth: openclaw doesn't enforce the typebox schema before
  // calling the handler — if the caller (e.g. /tools/invoke with a JSON
  // body missing the field) passes undefined, the original `raw.trim()`
  // crashes the tool with an opaque "Cannot read properties of undefined"
  // TypeError. Guard against non-string inputs explicitly.
  if (typeof raw !== "string") {
    return { value: "", error: "slug must be a non-empty string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: "", error: "slug must not be empty" };
  }
  if (trimmed.length > MAX_SLUG_LENGTH) {
    return {
      value: "",
      error: `slug exceeds maximum length of ${MAX_SLUG_LENGTH} characters`,
    };
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { value: "", error: "slug must not contain control characters" };
    }
  }
  return { value: trimmed, error: null };
}

// ---------------------------------------------------------------------------
// Tool-body envelope (mirrors daemonCrud.ts:128 — same try/catch shape).
// ---------------------------------------------------------------------------

async function runTool(
  toolName: string,
  body: () => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failedTextResult(`${toolName} failed: ${message}`, {
      status: "failed",
      error: message,
    });
  }
}

function reject(toolName: string, error: string): AgentToolResult {
  return failedTextResult(`${toolName} rejected: ${error}`, {
    status: "failed",
    error,
  });
}

// ---------------------------------------------------------------------------
// Markdown rendering helpers.
// ---------------------------------------------------------------------------

function renderInstalledTable(label: string, items: InstalledItem[]): string {
  if (!items.length) return `_(no ${label} installed)_`;
  const header = `| slug |\n|---|`;
  const rows = items.map((i) => `| ${i.slug || "?"} |`).join("\n");
  return `${header}\n${rows}`;
}

function renderRequestSummary(
  kindLabel: string,
  slug: string,
  requestId: number,
  status: string,
): string {
  return [
    `Filed **${kindLabel}** install request.`,
    "",
    `- slug: \`${slug}\``,
    `- requestId: ${requestId}`,
    `- status: **${status}** — awaiting operator approval on the dashboard.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool param schemas.
// ---------------------------------------------------------------------------

const RequestInstallParams = Type.Object(
  {
    slug: Type.String({
      minLength: 1,
      description:
        "Extension slug — e.g. 'clawhub:dbalve/fast-io' or 'npm:@scope/pkg'.",
    }),
    reason: Type.Optional(
      Type.String({
        description:
          "Why this extension is needed. Surfaced verbatim to the operator on the approval queue.",
      }),
    ),
  },
  { additionalProperties: false },
);
type RequestInstallParamsT = Static<typeof RequestInstallParams>;

const ListInstalledParams = Type.Object({}, { additionalProperties: false });
type ListInstalledParamsT = Static<typeof ListInstalledParams>;

const SearchClawhubParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description: "Free-text search against the ClawHub registry.",
    }),
    kind: Type.Optional(
      Type.Union([Type.Literal("plugin"), Type.Literal("skill")], {
        description: "Optional filter — 'plugin' or 'skill'.",
      }),
    ),
  },
  { additionalProperties: false },
);
type SearchClawhubParamsT = Static<typeof SearchClawhubParams>;

// ---------------------------------------------------------------------------
// request_plugin_install
// ---------------------------------------------------------------------------

function makeRequestInstallTool(
  toolName: "request_plugin_install" | "request_mcp_skill_install",
  kind: ExtensionKind,
  kindLabel: string,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: toolName,
    label:
      kind === "plugin"
        ? "Request plugin install"
        : "Request MCP skill install",
    description:
      kind === "plugin"
        ? "File an install request for an openclaw plugin. Does NOT install — an operator must approve on the dashboard before the install runs."
        : "File an install request for a ClawHub skill (typically containing an MCP server). Does NOT install — an operator must approve on the dashboard.",
    parameters: RequestInstallParams,
    async execute(
      _toolCallId: string,
      params: RequestInstallParamsT,
    ): Promise<AgentToolResult> {
      const slugCheck = validateSlug(params.slug);
      if (slugCheck.error !== null) return reject(toolName, slugCheck.error);

      // The daemon route requires a non-empty requestingAgentId; ctx.agentId
      // is optional in the SDK type but always populated by openclaw when a
      // persona is registered. Fail fast with a clear message if it's missing.
      const requestingAgentId = ctx.agentId;
      if (typeof requestingAgentId !== "string" || requestingAgentId.length === 0) {
        return reject(toolName, "ctx.agentId is required to file an install request");
      }

      let reason: string | undefined;
      if (typeof params.reason === "string" && params.reason.trim() !== "") {
        const rCheck = validateText(params.reason, "reason");
        if (rCheck.error !== null) return reject(toolName, rCheck.error);
        reason = rCheck.value;
      }

      return runTool(toolName, async () => {
        const result = await daemon.requestExtensionInstall({
          kind,
          slug: slugCheck.value,
          requestingAgentId,
          reason: reason ?? null,
        });
        return textResult(
          renderRequestSummary(
            kindLabel,
            slugCheck.value,
            result.requestId,
            result.status,
          ),
          {
            status: "ok",
            requestId: result.requestId,
            requestStatus: result.status,
          },
        );
      });
    },
  };
}

export const requestPluginInstallFactory: OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
): AnyAgentTool =>
  makeRequestInstallTool("request_plugin_install", "plugin", "plugin", ctx);

export const requestMcpSkillInstallFactory: OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
): AnyAgentTool =>
  makeRequestInstallTool(
    "request_mcp_skill_install",
    "mcp_skill",
    "MCP skill",
    ctx,
  );

// ---------------------------------------------------------------------------
// list_installed_*
// ---------------------------------------------------------------------------

function makeListInstalledTool(
  toolName: "list_installed_plugins" | "list_installed_mcp_skills",
  kind: ExtensionKind,
  label: string,
): AnyAgentTool {
  return {
    name: toolName,
    label:
      kind === "plugin"
        ? "List installed plugins"
        : "List installed MCP skills",
    description:
      kind === "plugin"
        ? "List currently-installed openclaw plugins available to this agent."
        : "List currently-installed openclaw skills (including their bundled MCP tools).",
    parameters: ListInstalledParams,
    async execute(
      _toolCallId: string,
      _params: ListInstalledParamsT,
    ): Promise<AgentToolResult> {
      return runTool(toolName, async () => {
        const items = await daemon.listInstalled(kind);
        return textResult(renderInstalledTable(label, items), {
          status: "ok",
          count: items.length,
        });
      });
    },
  };
}

export const listInstalledPluginsFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool =>
  makeListInstalledTool("list_installed_plugins", "plugin", "plugins");

export const listInstalledMcpSkillsFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool =>
  makeListInstalledTool("list_installed_mcp_skills", "mcp_skill", "MCP skills");

// ---------------------------------------------------------------------------
// search_clawhub  (NYI on daemon side — STUB)
// ---------------------------------------------------------------------------
//
// TODO(batch-8c-followup): the daemon does NOT yet expose
// `/api/extensions/clawhub/search` (Batch 8b shipped only the 6 install-request
// routes per amendment §16.3). Until that route lands, this tool returns a
// `failedTextResult` informing the agent the capability is not yet available
// and pointing the operator at the manual `openclaw plugins search <query>`
// fallback. Once the daemon route exists, swap the body for the commented
// happy-path block below (already validated via `daemon.searchClawhub`).

function renderSearchTable(items: ClawhubSearchResult[]): string {
  if (!items.length) return "_(no results)_";
  const header = `| slug | kind | verified | description |\n|---|---|---|---|`;
  const rows = items
    .map((r) => {
      const slug = r.slug || "?";
      const kind = r.kind ?? "—";
      const verified = r.verified === true ? "yes" : "no";
      const desc = (r.description ?? "").replace(/\|/g, "\\|").slice(0, 200);
      return `| ${slug} | ${kind} | ${verified} | ${desc} |`;
    })
    .join("\n");
  return `${header}\n${rows}`;
}

export const searchClawhubFactory: OpenClawPluginToolFactory = (
  _ctx: OpenClawPluginToolContext,
): AnyAgentTool => ({
  name: "search_clawhub",
  label: "Search ClawHub",
  description:
    "Search ClawHub for installable plugins/skills matching a query. Optionally filter by `kind`.",
  parameters: SearchClawhubParams,
  async execute(
    _toolCallId: string,
    params: SearchClawhubParamsT,
  ): Promise<AgentToolResult> {
    // Input validation runs regardless — keeps the error surface uniform if
    // the daemon route lands later and we flip the stub off.
    const qCheck = validateText(params.query, "query");
    if (qCheck.error !== null) return reject("search_clawhub", qCheck.error);
    if (qCheck.value.length > MAX_TEXT_LENGTH) {
      // Defense-in-depth — validateText already caps at MAX_TEXT_LENGTH, but
      // we re-state the invariant here for the same belt-and-braces reason.
      return reject(
        "search_clawhub",
        `query exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
      );
    }

    // STUB — see TODO above.
    return failedTextResult(
      "search_clawhub is not yet available — the daemon endpoint " +
        "`/api/extensions/clawhub/search` is planned but unimplemented as of " +
        "Batch 8c. Operator can run `openclaw plugins search <query>` " +
        "manually inside the gateway container in the meantime.",
      {
        status: "failed",
        error: "not_yet_available",
        query: qCheck.value,
        kind: params.kind ?? null,
      },
    );

    // Once the daemon route lands, replace the stub above with:
    //
    //   return runTool("search_clawhub", async () => {
    //     const results = await daemon.searchClawhub(
    //       qCheck.value,
    //       params.kind === "skill" ? "mcp_skill" : params.kind,
    //     );
    //     return textResult(renderSearchTable(results), {
    //       status: "ok",
    //       count: results.length,
    //     });
    //   });
  },
});

// Keep `renderSearchTable` reachable so when the stub flips off the helper is
// already there. (TS would otherwise warn about it under stricter
// `noUnusedLocals`; the plugin tsconfig doesn't currently enable that flag,
// but this is cheap insurance.)
void renderSearchTable;
