import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from 'discord.js';
import { config } from './config.js';
import { daemon } from './daemonClient.js';
import type { AgentDef } from './agentRegistry.js';

const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 180_000);

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

async function tryRead(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function buildSystemPrompt(agent: AgentDef, msg: Message): Promise<string> {
  const userId = msg.author.id;
  const channelId = msg.channel.id;
  const parts: string[] = [];
  parts.push(`# You are ${agent.name} (id: ${agent.id})`);
  if (agent.identityMd) parts.push(`## Public bio\n${agent.identityMd}`);
  if (agent.personaMd) parts.push(`## Persona / system prompt\n${agent.personaMd}`);

  const userProfile = await tryRead(path.join(config.sharedMemoryRoot, 'users', userId, 'profile.md'));
  if (userProfile) parts.push(`## User profile (Discord ${userId})\n${userProfile}`);
  const recent = await tryRead(path.join(config.sharedMemoryRoot, 'threads', channelId, 'recent.md'));
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

  parts.push(TOOLBELT_DOC);
  parts.push(`## Discord context
user: ${msg.author.username} (${userId})
channel: #${(msg.channel as any).name ?? channelId}
guild: ${msg.guild?.name ?? 'DM'}

Reply concisely (Discord-friendly length). Use markdown sparingly.`);
  return parts.join('\n\n');
}

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

async function runPtah(systemPrompt: string, userMessage: string): Promise<string | null> {
  return new Promise((resolve) => {
    const fullTask = `${systemPrompt}\n\n---\n## User message\n${userMessage}\n\n## Your reply`;
    const args = [
      '--json',
      '--auto-approve',
      '--cwd',
      '/workspace',
      'session',
      'start',
      '--profile',
      config.ptahProfile,
      '--task',
      fullTask,
    ];
    const child = spawn(config.ptahBin, args, { cwd: '/workspace' });
    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, CHAT_TIMEOUT_MS);
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(extractFinalReply(stdout));
    });
  });
}

function extractFinalReply(jsonl: string): string | null {
  const lines = jsonl.split('\n').filter((l) => l.trim().startsWith('{'));
  const candidates: string[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      const m: string = evt.method ?? '';
      const p: any = evt.params ?? {};
      if (typeof p.text === 'string' && /assistant|message|chunk|response|complete|delta/i.test(m)) {
        candidates.push(p.text);
        continue;
      }
      if (Array.isArray(p.content)) {
        for (const c of p.content) {
          if (c?.type === 'text' && typeof c.text === 'string') candidates.push(c.text);
        }
        continue;
      }
      const cc = p.message?.content;
      if (typeof cc === 'string') candidates.push(cc);
      else if (Array.isArray(cc)) for (const c of cc) if (c?.text) candidates.push(c.text);
    } catch {}
  }
  if (!candidates.length) return null;
  // Heuristic: pick the longest assistant-y text — that's usually the final reply.
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

export async function handleChat(agent: AgentDef, msg: Message): Promise<void> {
  const text = stripMentions(msg.content);
  if (!text) {
    await msg.reply('hello — ask me something. for the command list, send `!help`.');
    return;
  }
  await (msg.channel as any).sendTyping?.().catch(() => {});

  const systemPrompt = await buildSystemPrompt(agent, msg);
  const reply = await runPtah(systemPrompt, text);

  if (!reply) {
    await msg.reply('(no reply — the agent backend timed out or returned nothing)');
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

  for (const chunk of chunkBy(final)) {
    try {
      await msg.reply(chunk);
    } catch {
      await (msg.channel as any).send?.(chunk).catch(() => {});
    }
  }
}
