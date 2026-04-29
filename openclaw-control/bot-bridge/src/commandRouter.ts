import type { Message } from 'discord.js';
import { config } from './config.js';
import { daemon } from './daemonClient.js';
import type { AgentDef } from './agentRegistry.js';

export interface RouteContext {
  agent: AgentDef;
  message: Message;
}

const HELP = `**Commands** (prefix: \`${config.commandPrefix}\`)
\`${config.commandPrefix}help\` — this message
\`${config.commandPrefix}projects\` — list projects
\`${config.commandPrefix}tasks [project]\` — list tasks (default: ${config.defaultProject || 'set OPENCLAW_DEFAULT_PROJECT'})
\`${config.commandPrefix}task <project> <description>\` — create a new task
\`${config.commandPrefix}approve <task-id> [feedback]\` — approve current checkpoint
\`${config.commandPrefix}reject <task-id> [feedback]\` — reject current checkpoint
\`${config.commandPrefix}handoff <task-id> <agent>\` — reassign to another agent
\`${config.commandPrefix}tick\` — kick the continuation loop
`;

export async function route(ctx: RouteContext): Promise<boolean> {
  const text = ctx.message.content.trim();
  if (!text.startsWith(config.commandPrefix)) return false;
  const [cmd, ...rest] = text.slice(config.commandPrefix.length).split(/\s+/);
  const args = rest;

  try {
    switch (cmd) {
      case 'help':
        await ctx.message.reply(HELP);
        return true;
      case 'projects': {
        const ps = await daemon.listProjects();
        if (!ps.length) { await ctx.message.reply('No projects with `.ptah/specs/` found.'); return true; }
        await ctx.message.reply(ps.map((p) => `**${p.slug}** — ${p.openTaskCount} open${p.checkpointCount ? ` · ⚠️ ${p.checkpointCount} pending approval` : ''}`).join('\n'));
        return true;
      }
      case 'tasks': {
        const slug = args[0] || config.defaultProject;
        if (!slug) { await ctx.message.reply('Usage: `!tasks <project-slug>`'); return true; }
        const ts = await daemon.listTasks(slug);
        if (!ts.length) { await ctx.message.reply(`No tasks in **${slug}**.`); return true; }
        await ctx.message.reply(ts.slice(0, 12).map((t) => `\`${t.id}\` [${t.phase}]${t.checkpointPending ? ' ⚠️' : ''} ${t.title || ''}`).join('\n'));
        return true;
      }
      case 'task': {
        const slug = args[0];
        const description = args.slice(1).join(' ');
        if (!slug || !description) { await ctx.message.reply('Usage: `!task <project> <description>`'); return true; }
        const r = await daemon.createTask({
          project: slug,
          description,
          agentId: ctx.agent.id,
          discordUserId: ctx.message.author.id,
          channelId: ctx.message.channel.id,
        });
        await ctx.message.reply(`Created **${r.taskId}** in **${slug}**. I'll start working on it.`);
        return true;
      }
      case 'approve':
      case 'reject': {
        const taskId = args[0];
        const feedback = args.slice(1).join(' ') || undefined;
        if (!taskId) { await ctx.message.reply(`Usage: \`!${cmd} <task-id> [feedback]\``); return true; }
        const project = await findProjectForTask(taskId);
        if (!project) { await ctx.message.reply(`Task ${taskId} not found.`); return true; }
        const summary = await daemon.getTask(project, taskId);
        await daemon.approve(project, taskId, {
          phase: summary.phase,
          decision: cmd === 'approve' ? 'APPROVED' : 'REJECTED',
          feedback,
        });
        await ctx.message.reply(`${cmd === 'approve' ? '✅ Approved' : '❌ Rejected'} **${taskId}** at phase **${summary.phase}**.`);
        return true;
      }
      case 'handoff': {
        const taskId = args[0];
        const toAgent = args[1];
        if (!taskId || !toAgent) { await ctx.message.reply('Usage: `!handoff <task-id> <agent>`'); return true; }
        const project = await findProjectForTask(taskId);
        if (!project) { await ctx.message.reply(`Task ${taskId} not found.`); return true; }
        await daemon.handoff(project, taskId, toAgent, `via discord by ${ctx.message.author.username}`);
        await ctx.message.reply(`🔄 Handed off **${taskId}** to **${toAgent}**.`);
        return true;
      }
      case 'tick': {
        const r = await daemon.tick();
        await ctx.message.reply(`Ticked: dispatched=${r.dispatched}, pending=${r.pending}, checkpoints=${r.checkpoints}.`);
        return true;
      }
      default:
        return false;
    }
  } catch (err: any) {
    await ctx.message.reply(`⚠️ ${err.message ?? String(err)}`);
    return true;
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
