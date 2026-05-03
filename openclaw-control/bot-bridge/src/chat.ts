import type { Message } from 'discord.js';
import { daemon } from './daemonClient.js';
import { chatComplete, chatCompleteWithTools, type ToolDef, type ToolCallContext } from './llm.js';
import type { AgentDef } from './agentRegistry.js';
import { config } from './config.js';
import * as daemonTools from './tools/daemonTools.js';
import * as mcpTools from './tools/mcpTools.js';
import { merge as mergeToolRegistries } from './tools/index.js';
import { loadSkills, type LoadedSkill } from './skills/skillLoader.js';

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

  // ## Available tools — placeholder until B4 (mcpTools) and B5 (subagentTools)
  // fill the registry. The current `TOOLBELT_DOC` is the legacy directive
  // surface; when toolCallsEnabled is on, the OpenAI-compat tool definitions
  // are passed via `tools=[...]` in the request body, NOT the system prompt,
  // so a markdown table here is documentation only.
  parts.push(TOOLBELT_DOC);

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
  // TASK_2026_002 B4 — merge in the per-agent MCP tool slice. mcpTools is a
  // pure function over the manager's current open-server set: failed/backoff
  // servers are filtered at the source, so their tools never appear here.
  // Subagent tools (B5) and the harness-author surface (B7) plug in the
  // same way.
  return mergeToolRegistries(daemonTools.list(), mcpTools.listForAgent(agent.id));
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
    };
    const tools = await buildToolRegistry(agent, ctx);
    const systemPrompt = await buildSystemPrompt(agent, msg);
    const result = await chatCompleteWithTools(
      systemPrompt,
      [{ role: 'user', content: text }],
      tools,
      ctx,
      { maxDepth: config.toolCallDepthLimit },
    );
    if (result.content) {
      return await postReply(msg, result.content);
    }
    // Fall through to the legacy path on null content.
  }

  return await legacyHandleChat(agent, msg, text);
}
