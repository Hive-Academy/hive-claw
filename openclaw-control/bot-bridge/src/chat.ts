import type { Message } from 'discord.js';
import { daemon } from './daemonClient.js';
import { chatComplete, chatCompleteWithTools, type ToolDef, type ToolCallContext } from './llm.js';
import type { AgentDef } from './agentRegistry.js';
import { config } from './config.js';
import * as daemonTools from './tools/daemonTools.js';
import * as mcpTools from './tools/mcpTools.js';
import * as subagentTools from './tools/subagentTools.js';
import * as discordTools from './tools/discordTools.js';
import { merge as mergeToolRegistries } from './tools/index.js';
import { loadSkills, type LoadedSkill } from './skills/skillLoader.js';
import { PARENT_TOOL_REGISTRY_STATE_KEY } from './subagents/subagentRunner.js';
import {
  tools as harnessAuthorTools,
  HARNESS_SETUP_STATE_KEY,
  type HarnessAuthorState,
} from './harnessAuthor.js';

const TOOLBELT_DOC = `## Operational tools (emit at the END of your reply, one per line)

When the user asks for an action, append directives in this exact format:

\`<<oc:create_task project="<slug>" description="<text>" agent="<id>">>\`
\`<<oc:approve task_id="TASK_YYYY_NNN" feedback="<optional>">>\`
\`<<oc:reject task_id="TASK_YYYY_NNN" feedback="<optional>">>\`
\`<<oc:handoff task_id="TASK_YYYY_NNN" to_agent="<id>" reason="<optional>">>\`
\`<<oc:tick>>\`

Rules:
- Only emit directives when the user is asking for the action. For pure questions or chat, just answer.
- One directive per line. Quote all string values with double quotes.
- After the directives, that's it — they will be executed and a one-line result appended to your reply.
- For questions about state ("what tasks are open?", "list projects"), DON'T emit a directive — instead use your knowledge from the context section above to answer in natural language.

If you need information you don't have (e.g. the user asks "what tasks are in projectA?"), just say what you'd need to know to answer.
`;

interface DirectiveCall {
  raw: string;
  op: string;
  args: Record<string, string>;
}

function parseDirectives(text: string): { stripped: string; calls: DirectiveCall[] } {
  const calls: DirectiveCall[] = [];
  const re = /<<oc:([a-z_]+)([^>]*)>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const op = m[1];
    const argsRaw = m[2] ?? '';
    const args: Record<string, string> = {};
    const argRe = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = argRe.exec(argsRaw)) !== null) args[am[1]] = am[2];
    calls.push({ raw: m[0], op, args });
  }
  const stripped = text.replace(re, '').trimEnd();
  return { stripped, calls };
}

async function executeDirective(call: DirectiveCall, ctx: { agentId: string; userId: string; channelId: string }): Promise<string> {
  try {
    switch (call.op) {
      case 'create_task': {
        const { project, description, agent } = call.args;
        if (!project || !description) return `⚠️ create_task missing project or description`;
        const r = await daemon.createTask({
          project,
          description,
          agentId: agent || ctx.agentId,
          discordUserId: ctx.userId,
          channelId: ctx.channelId,
        });
        return `✅ created **${r.taskId}** in **${project}**`;
      }
      case 'approve':
      case 'reject': {
        const taskId = call.args.task_id;
        if (!taskId) return `⚠️ ${call.op} missing task_id`;
        const project = await findProjectForTask(taskId);
        if (!project) return `⚠️ task ${taskId} not found`;
        const summary = await daemon.getTask(project, taskId);
        await daemon.approve(project, taskId, {
          phase: summary.phase,
          decision: call.op === 'approve' ? 'APPROVED' : 'REJECTED',
          feedback: call.args.feedback,
        });
        return `${call.op === 'approve' ? '✅ approved' : '❌ rejected'} **${taskId}** at phase **${summary.phase}**`;
      }
      case 'handoff': {
        const taskId = call.args.task_id;
        const toAgent = call.args.to_agent;
        if (!taskId || !toAgent) return `⚠️ handoff missing task_id or to_agent`;
        const project = await findProjectForTask(taskId);
        if (!project) return `⚠️ task ${taskId} not found`;
        await daemon.handoff(project, taskId, toAgent, call.args.reason);
        return `🔄 handed off **${taskId}** to **${toAgent}**`;
      }
      case 'tick': {
        const r = await daemon.tick();
        return `⏱  ticked: dispatched=${r.dispatched}, pending=${r.pending}, checkpoints=${r.checkpoints}`;
      }
      default:
        return `⚠️ unknown directive: ${call.op}`;
    }
  } catch (err: any) {
    return `⚠️ ${call.op} failed: ${err.message ?? err}`;
  }
}

async function findProjectForTask(taskId: string): Promise<string | null> {
  const projects = await daemon.listProjects();
  for (const p of projects) {
    const tasks = await daemon.listTasks(p.slug);
    if (tasks.some((t) => t.id === taskId)) return p.slug;
  }
  return null;
}

async function tryReadMemory(
  scope: 'users' | 'threads',
  ownerId: string,
  filename: string,
): Promise<string | null> {
  // 404 → null (normal "no extra context" flow). 5xx is logged but does not
  // crash the chat path — the LLM still gets the prompt without the optional
  // context block.
  try {
    const r = await daemon.readMemory(scope, ownerId, filename);
    return r ? r.content.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Render the "Loaded skills" block per impl-plan §"Native skill loading"
 * lines 964–982. One `### <skill.name>` header per skill followed by the
 * skill body verbatim (frontmatter already stripped by the loader). Empty
 * skill list returns null so the section disappears entirely from the prompt.
 */
function renderLoadedSkills(skills: readonly LoadedSkill[]): string | null {
  if (!skills.length) return null;
  const blocks = skills.map((s) => `### ${s.name}\n${s.body}`);
  return `## Loaded skills\n\n${blocks.join('\n\n')}`;
}

async function buildSystemPrompt(agent: AgentDef, msg: Message): Promise<string> {
  const userId = msg.author.id;
  const channelId = msg.channel.id;
  const parts: string[] = [];

  // Locked order per impl-plan lines 964-982: bio → persona → loaded skills
  // → tool descriptions → discord context. Existing extra context sections
  // (user profile / thread context / current projects / registered agents)
  // sit between skills and tool descriptions — they're reference material,
  // not behavior shaping, so they don't disturb the bio→persona→skills→tools
  // flow the architect demanded.
  parts.push(`# You are ${agent.name} (id: ${agent.id})`);
  if (agent.identityMd) parts.push(`## Public bio\n${agent.identityMd}`);
  if (agent.personaMd) parts.push(`## Persona / system prompt\n${agent.personaMd}`);

  // Native skill loading (TASK_2026_002 B3). Loaded fresh on every call —
  // file system reads are cheap and the impl-plan §"Hot-reload via
  // harness/sync" line 986 explicitly says "Next inbound message rebuilds
  // the system prompt from the fresh def — no in-flight chat is interrupted."
  const skillNames = agent.harness?.chatTier?.skills ?? [];
  if (skillNames.length) {
    const skills = await loadSkills(skillNames);
    const block = renderLoadedSkills(skills);
    if (block) parts.push(block);
  }

  const userProfile = await tryReadMemory('users', userId, 'profile.md');
  if (userProfile) parts.push(`## User profile (Discord ${userId})\n${userProfile}`);
  const recent = await tryReadMemory('threads', channelId, 'recent.md');
  if (recent) parts.push(`## Thread context (channel ${channelId})\n${recent}`);

  // Live state — pull a small snapshot of projects + agents so the LLM has
  // something to reason about without needing tool calls for read queries.
  try {
    const projects = await daemon.listProjects();
    if (projects.length) {
      parts.push(
        `## Current projects\n${projects
          .map((p) => `- ${p.slug} (${p.openTaskCount} open / ${p.taskCount} total)`)
          .join('\n')}`,
      );
    }
  } catch {}
  try {
    const agents = await daemon.listAgents?.() ?? [];
    if (agents.length) {
      parts.push(
        `## Registered agents\n${agents
          .map((a: any) => `- ${a.id}${a.ownedHere ? ' (this machine)' : ''} — ${a.status}`)
          .join('\n')}`,
      );
    }
  } catch {}

  // Legacy directive grammar — only included on the rollback path
  // (toolCallsEnabled=false). With tool-calling on, structured OpenAI-compat
  // tool definitions go via `tools=[...]` in the request body and the LLM
  // must NOT see the directive grammar; otherwise it emits both — visibly
  // leaking `<<oc:create_task ...>>` strings into Discord replies AND
  // skipping the structured tool path. Surfaced 2026-05-03 against Anubis.
  if (!config.toolCallsEnabled) {
    parts.push(TOOLBELT_DOC);
  }

  parts.push(`## Discord context
user: ${msg.author.username} (${userId})
channel: #${(msg.channel as any).name ?? channelId}
guild: ${msg.guild?.name ?? 'DM'}

Reply concisely (Discord-friendly length). Use markdown sparingly.`);
  return parts.join('\n\n');
}

// Exported for tests — pinning the impl-plan lines 964-982 ordering and the
// `### <name>` skill block shape is verification item 5 of B3.
export { buildSystemPrompt as __buildSystemPromptForTests };

function stripMentions(content: string): string {
  return content.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();
}

function chunkBy(text: string, max = 1900): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + max, text.length);
    if (end < text.length) {
      const lastNl = text.lastIndexOf('\n', end);
      if (lastNl > cursor + max / 2) end = lastNl;
    }
    out.push(text.slice(cursor, end));
    cursor = end;
  }
  return out;
}

/**
 * Send `text` back as a Discord reply, chunking to fit the message size cap.
 *
 * Extracted from the legacy `handleChat` (TASK_2026_002 B2) so the
 * tool-calling branch can render its assistant text via the same path.
 * The byte-level behavior — `msg.reply(chunk)` with a `(channel as any).send`
 * fallback on throw — is preserved exactly.
 */
async function postReply(msg: Message, text: string): Promise<void> {
  for (const chunk of chunkBy(text)) {
    try {
      await msg.reply(chunk);
    } catch {
      await (msg.channel as any).send?.(chunk).catch(() => {});
    }
  }
}

/**
 * Assemble the chat-tier tool registry for this agent.
 *
 * Per the impl-plan §"Tool registry & dispatch loop" the registry is the
 * merge of: daemonTools.list() + (later batches) mcpTools.listForAgent(...) +
 * subagentTools.list(agent) + (when in harness-authoring mode) the
 * harness-author tools. B2 ships only the daemon CRUD surface; the other
 * registries arrive in B3/B4/B5 and slot in here without further chat.ts
 * churn.
 */
async function buildToolRegistry(
  agent: AgentDef,
  _ctx: ToolCallContext,
): Promise<ToolDef[]> {
  // TASK_2026_002 B5 — merge in the per-agent subagent tool slice. The list is
  // empty when the persona has no harness or no declared subagents, so the
  // existing collision-policy behavior (impl-plan §"Tool registry & dispatch
  // loop") stays intact for personas that never delegate. Subagent tool names
  // are snake_case (`delegate_to_subagent`, `delegate_to_<n>`) so they don't
  // collide with daemon CRUD tools or the `mcp__` namespace.
  //
  // TASK_2026_003 — opt-in Discord-native tools (`read_channel_history`,
  // `upload_attachment`). Agents with no `chatTier.tools` field in their
  // harness get an empty slice; the registry is unchanged for them.
  return mergeToolRegistries(
    daemonTools.list(),
    mcpTools.listForAgent(agent.id),
    subagentTools.listForAgent(agent),
    discordTools.listForAgent(agent),
  );
}

// ---------------------------------------------------------------------------
// TASK_2026_002 B7 — harness-authoring conversation state.
//
// `ctx.state` is per-message (rebuilt on every handleChat), so the multi-turn
// harness-authoring flow needs a longer-lived store. We key by
// `<agentId>:<channelId>`: same persona in the same Discord channel = same
// authoring session. Bot-bridge restart drops everything (impl-plan line
// 1058 "state lives in-process … restart drops the conversation").
// ---------------------------------------------------------------------------

const harnessSessions = new Map<string, HarnessAuthorState>();

function harnessKey(agent: AgentDef, msg: Message): string {
  return `${agent.id}:${msg.channel.id}`;
}

/**
 * Test seam — exposed solely so unit tests can clear the in-process map
 * between cases without doing a process restart. NOT exported in
 * `index.ts`; only `harness-author.test.ts` reaches for it via dynamic import.
 */
export function __resetHarnessSessionsForTests(): void {
  harnessSessions.clear();
}

/** Strings that abort the harness-author session entirely (case-insensitive). */
const HARNESS_CANCEL_PHRASE = /\bcancel harness setup\b/i;

/**
 * Operator-confirmation parser. Run on the user's next message AFTER
 * `confirm_harness` flipped stage to 'awaiting-operator-confirmation'.
 *
 * Match precedence: cancel > yes > no > unrecognized. The cancel phrase wins
 * over "yes" / "no" so an operator typing "no, cancel harness setup" gets
 * the stronger action.
 *
 * Returns:
 *   - 'cancel' → chat.ts wipes the session, replies "cancelled".
 *   - 'yes'    → flip stage to 'writing'.
 *   - 'no'     → clear `proposed`, stage back to 'probing'.
 *   - null     → unrecognized (let the LLM see the message verbatim).
 */
function detectOperatorReply(text: string): 'cancel' | 'yes' | 'no' | null {
  if (HARNESS_CANCEL_PHRASE.test(text)) return 'cancel';
  // Strict word-boundary match so "yesterday" doesn't fire "yes" and
  // "north" doesn't fire "no".
  const trimmed = text.trim();
  if (/^(yes|y)\b/i.test(trimmed)) return 'yes';
  if (/^(no|n)\b/i.test(trimmed)) return 'no';
  return null;
}

/**
 * Legacy plain-chat path: existing `buildSystemPrompt` + `chatComplete` +
 * `parseDirectives` flow. Kept byte-identical (TASK_2026_002 B2 hard rule)
 * so disabling `OPENCLAW_BOT_TOOL_CALLS_ENABLED` produces exactly today's
 * Discord behavior. Do NOT refactor `buildSystemPrompt` or directive
 * parsing here — that's B3's territory.
 */
async function legacyHandleChat(agent: AgentDef, msg: Message, text: string): Promise<void> {
  const systemPrompt = await buildSystemPrompt(agent, msg);
  const reply = await chatComplete(systemPrompt, text);

  if (!reply) {
    await msg.reply('(no reply — the LLM backend timed out or returned nothing; check `tail /tmp/openclaw-control-bot.log`)');
    return;
  }

  const { stripped, calls } = parseDirectives(reply);
  let final = stripped;

  if (calls.length) {
    const results: string[] = [];
    for (const c of calls) {
      const out = await executeDirective(c, {
        agentId: agent.id,
        userId: msg.author.id,
        channelId: msg.channel.id,
      });
      results.push(out);
    }
    final = `${stripped}\n\n— actions —\n${results.join('\n')}`;
  }

  await postReply(msg, final);
}

export async function handleChat(agent: AgentDef, msg: Message): Promise<void> {
  const text = stripMentions(msg.content);
  if (!text) {
    await msg.reply('hello — ask me something. for the command list, send `!help`.');
    return;
  }
  await (msg.channel as any).sendTyping?.().catch(() => {});

  // TASK_2026_002 B2 — feature-flagged tool-calling branch.
  // When OPENCLAW_BOT_TOOL_CALLS_ENABLED=1, build the per-persona tool
  // registry and run the OpenAI-compatible tool-call loop. On truthy
  // assistant content we surface it directly (the tool calls themselves
  // already mutated daemon state, so no <<oc:...>> directive layer is
  // needed). On null content (provider error / no usable text) we fall
  // through to the legacy directive flow — the safety net survives.
  if (config.toolCallsEnabled) {
    const sessionKey = harnessKey(agent, msg);

    // TASK_2026_002 B7 — harness-authoring session lifecycle.
    //
    // Steps:
    //  (a) Auto-clear if the in-process session is older than the configured
    //      idle timeout (default 30 min — config.harnessAuthorTimeoutMs).
    //  (b) "cancel harness setup" anywhere in the message wipes the session.
    //  (c) When stage === 'awaiting-operator-confirmation', interpret the
    //      next message as the yes/no answer.
    let harnessSession = harnessSessions.get(sessionKey);
    if (
      harnessSession &&
      config.harnessAuthorTimeoutMs > 0 &&
      Date.now() - harnessSession.startedAt > config.harnessAuthorTimeoutMs
    ) {
      // Auto-clear via harnessSetup.startedAt timestamp. Reference site for
      // verification grep: `harnessSetup.startedAt` (impl-plan line 1056).
      harnessSessions.delete(sessionKey);
      harnessSession = undefined;
      await msg.reply(
        '_(harness-author session timed out and was cleared. Say "set up the harness" again to restart.)_',
      );
      // Fall through to the rest of the handler so the user's actual
      // message is still processed against the default tool registry.
    }

    if (harnessSession && HARNESS_CANCEL_PHRASE.test(text)) {
      // "cancel harness setup" — wipe state, post a "cancelled" reply, return.
      harnessSessions.delete(sessionKey);
      await msg.reply('Harness-authoring cancelled. No file was written.');
      return;
    }

    if (harnessSession && harnessSession.stage === 'awaiting-operator-confirmation') {
      const decision = detectOperatorReply(text);
      if (decision === 'yes') {
        harnessSession = { ...harnessSession, stage: 'writing' };
        harnessSessions.set(sessionKey, harnessSession);
        // Fall through with the user's "yes" — the LLM will see it and
        // (per the system prompt) call write_harness_file on this round.
      } else if (decision === 'no') {
        harnessSession = {
          ...harnessSession,
          stage: 'probing',
          ...(harnessSession.proposed ? {} : {}),
        };
        // Clear `proposed` explicitly (spread above keeps it; rebuild without).
        const next: HarnessAuthorState = {
          project: harnessSession.project,
          stage: 'probing',
          startedAt: harnessSession.startedAt,
        };
        if (harnessSession.projectPath) next.projectPath = harnessSession.projectPath;
        harnessSessions.set(sessionKey, next);
        harnessSession = next;
      }
      // decision === null → leave the stage alone; the LLM will see the
      // message verbatim and can ask the operator to clarify.
    }

    const ctx: ToolCallContext = {
      agentId: agent.id,
      userId: msg.author.id,
      channelId: msg.channel.id,
      state: new Map(),
      // TASK_2026_002 B3 (forwarded from B2 sub-task 8): route observability
      // hints through `daemonClient.emitSseHint` so `invoker.tool_call`,
      // `invoker.subagent_started` and `invoker.subagent_finished` surface on
      // `/api/stream`. Fire-and-forget — the helper swallows errors so a
      // dead daemon never breaks Discord chat. AT#3 (visibility) hangs on
      // this wire being present. **B6 owns the daemon endpoint.**
      emit: (event, data) => {
        void daemon.emitSseHint(event, data);
      },
      // TASK_2026_003 — Discord side-channel for the chat-tier tools that
      // need to act on the live conversation surface (read history, post
      // attachments). Subagents inherit this through `buildChildContext` if
      // present; tools that require it throw a structured error when it's
      // missing rather than crashing on a null deref.
      discord: { message: msg },
    };
    // TASK_2026_002 B7 — load the persistent harness session into ctx.state
    // BEFORE building the tool registry, so the registry decision below sees
    // the same slot the tool handlers will mutate.
    if (harnessSession) {
      ctx.state.set(HARNESS_SETUP_STATE_KEY, harnessSession);
    }

    // TASK_2026_002 B7 — when the harness-author session is live, REPLACE
    // (not merge) the registry with the 5 author tools. impl-plan line 1068:
    // "keeps the LLM focused per impl-plan line 1068".
    let tools: ToolDef[];
    if (ctx.state.has(HARNESS_SETUP_STATE_KEY)) {
      tools = harnessAuthorTools(ctx.state);
    } else {
      tools = await buildToolRegistry(agent, ctx);
    }
    // TASK_2026_002 B5 — stash the parent tool registry on the shared state
    // map so `subagentRunner.run` can intersect against it without a circular
    // import (chat.ts → subagentTools.ts → subagentRunner.ts → chat.ts would
    // otherwise be the path). Any nested subagent inherits the SAME parent's
    // registry via `buildChildContext` cloning the state map verbatim.
    ctx.state.set(PARENT_TOOL_REGISTRY_STATE_KEY, tools);
    const systemPrompt = await buildSystemPrompt(agent, msg);
    const result = await chatCompleteWithTools(
      systemPrompt,
      [{ role: 'user', content: text }],
      tools,
      ctx,
      { maxDepth: config.toolCallDepthLimit },
    );

    // TASK_2026_002 B7 — persist any harness-state mutations the tool handlers
    // wrote during this round. `start_harness_setup` (in daemonTools.ts) and
    // `propose_harness` / `confirm_harness` / `write_harness_file` (in
    // harnessAuthor.ts) all write to ctx.state.harnessSetup; we must copy
    // those mutations back into the cross-message store.
    const finalHarnessState = ctx.state.get(HARNESS_SETUP_STATE_KEY) as
      | HarnessAuthorState
      | undefined;
    if (finalHarnessState) {
      harnessSessions.set(sessionKey, finalHarnessState);
    }

    if (result.content) {
      // Defensive scrub: even with TOOLBELT_DOC removed from the system
      // prompt, an LLM can still hallucinate the directive grammar from
      // training data or echo it from a quoted user message. Strip any
      // residual `<<oc:...>>` from the visible reply (NOT executed — the
      // structured tool registry is the only sanctioned mutation path
      // when toolCallsEnabled is on; silent execution would be a footgun).
      // If a directive was stripped, log a warning so production drift
      // is detectable.
      const cleaned = result.content.replace(/<<oc:[^>]*>>/g, '').trimEnd();
      if (cleaned.length !== result.content.trimEnd().length) {
        console.warn(
          `[chat] ${agent.id}: stripped <<oc:>> directive(s) from tool-call reply — model is mixing legacy + structured paths. Check skill prose.`,
        );
      }
      if (cleaned.length > 0) {
        return await postReply(msg, cleaned);
      }
      // If scrubbing left an empty reply, fall through to the legacy path
      // so the operator sees something rather than silence.
    }
    // Fall through to the legacy path on null content.
  }

  return await legacyHandleChat(agent, msg, text);
}
