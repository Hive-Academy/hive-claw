import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import Redis from 'ioredis';
import { config } from './config.js';
import {
  loadAgents,
  ensureStatusPublisher,
  publishStatus,
  closeStatusPublisher,
  type AgentDef,
} from './agentRegistry.js';
import { route } from './commandRouter.js';

interface RunningAgent {
  def: AgentDef;
  client: Client;
}

const running = new Map<string, RunningAgent>();

async function startAgent(def: AgentDef): Promise<RunningAgent | null> {
  if (!def.token) {
    console.warn(`[bot-bridge] agent "${def.id}" has no token (env: ${def.tokenEnvVar}) — skipping`);
    return null;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.ClientReady, async () => {
    console.log(`[bot-bridge] ${def.id} ready as ${client.user?.tag}`);
    await publishStatus(def.id, { status: 'online' });
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (def.channelAllowList?.length && !def.channelAllowList.includes(msg.channel.id)) return;
    const mentioned = msg.mentions.users.has(client.user?.id ?? '');
    const isCommand = msg.content.startsWith(config.commandPrefix);
    if (!isCommand && !mentioned) return;
    await publishStatus(def.id, { status: 'busy', busyWith: `discord:${msg.channel.id}` });
    try {
      await route({ agent: def, message: msg });
    } finally {
      await publishStatus(def.id, { status: 'online' });
    }
  });

  client.on(Events.Error, (err) => console.error(`[bot-bridge] ${def.id} error`, err));

  await client.login(def.token);
  return { def, client };
}

async function main() {
  await ensureStatusPublisher();

  const agents = await loadAgents();
  if (!agents.length) {
    console.warn(
      '[bot-bridge] no runnable agents found (each agent needs both shared-specs/memory/agents/<id>/identity.md and local-memory/agents/<id>/persona.md) — exiting',
    );
    process.exit(0);
  }
  for (const def of agents) {
    const r = await startAgent(def);
    if (r) running.set(def.id, r);
  }

  if (config.redisUrl) {
    const sub = new Redis(config.redisUrl);
    await sub.psubscribe('agent:*:inbox');
    sub.on('pmessage', async (_pattern, channel, message) => {
      try {
        const m = channel.match(/^agent:(.+):inbox$/);
        if (!m) return;
        const targetId = m[1];
        const target = running.get(targetId);
        if (!target) return;
        const payload = JSON.parse(message);
        console.log(`[bot-bridge] handoff received for ${targetId}`, payload.taskId);
        await publishStatus(targetId, { status: 'busy', busyWith: payload.taskId });
      } catch (err) {
        console.error('[bot-bridge] bus error', err);
      }
    });
    console.log('[bot-bridge] subscribed to agent inbox channels');
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`[bot-bridge] received ${sig}, shutting down`);
      for (const [id, a] of running) {
        await publishStatus(id, { status: 'offline' });
        a.client.destroy();
      }
      await closeStatusPublisher();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
