import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import Redis from 'ioredis';
import { config } from './config.js';
import {
  loadAgents,
  ensureStatusPublisher,
  publishStatus,
  closeStatusPublisher,
  reloadAgent,
  type AgentDef,
} from './agentRegistry.js';
import { route } from './commandRouter.js';
import { startHarnessSync } from './skills/harnessSync.js';

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

  // TASK_2026_002 B3 — harness/sync hot-reload subscriber.
  //
  // Daemon's `POST /api/agents/:id/harness/sync` publishes on the Redis
  // `harness/sync` topic. We subscribe here and swap the running agent's
  // `def` so the next inbound message rebuilds its system prompt against
  // the fresh harness + skills (impl-plan §"Hot-reload via harness/sync"
  // line 986: "Next inbound message rebuilds the system prompt from the
  // fresh def — no in-flight chat is interrupted").
  //
  // The MCP reconcile call is B4's job — we deliberately do NOT call it
  // here. B3 only stubs the def-swap; the MCP lifecycle wiring arrives in
  // B4 along with the manager itself.
  const stopHarnessSync = await startHarnessSync({
    onAgentChanged: async (id) => {
      try {
        const next = await reloadAgent(id);
        const target = running.get(id);
        if (next && target) {
          target.def = next;
          console.log(`[bot-bridge] hot-reloaded harness for "${id}"`);
        } else if (!next) {
          console.warn(`[bot-bridge] harness/sync for "${id}" but persona is no longer runnable here — ignored`);
        } else {
          console.warn(`[bot-bridge] harness/sync for "${id}" but no running client on this machine — ignored`);
        }
      } catch (err) {
        console.error(`[bot-bridge] harness/sync reload failed for "${id}":`, (err as Error)?.message ?? err);
      }
    },
  });

  if (config.redisUrl) {
    const sub = new Redis(config.redisUrl);
    await sub.psubscribe('agent:*:inbox', 'agent:*:notify');
    sub.on('pmessage', async (_pattern, channel, message) => {
      try {
        const inbox = channel.match(/^agent:(.+):inbox$/);
        if (inbox) {
          const targetId = inbox[1];
          const target = running.get(targetId);
          if (!target) return;
          const payload = JSON.parse(message);
          console.log(`[bot-bridge] handoff received for ${targetId}`, payload.taskId);
          await publishStatus(targetId, { status: 'busy', busyWith: payload.taskId });
          return;
        }
        const notify = channel.match(/^agent:(.+):notify$/);
        if (notify) {
          const targetId = notify[1];
          const target = running.get(targetId);
          if (!target) return;
          const payload = JSON.parse(message) as { channelId: string; text: string };
          if (!payload.channelId || !payload.text) return;
          const ch = await target.client.channels.fetch(payload.channelId).catch(() => null);
          if (ch && 'send' in ch) {
            await (ch as any).send(payload.text).catch((err: any) =>
              console.warn(`[bot-bridge] notify post failed for ${targetId}: ${err?.message ?? err}`),
            );
          }
        }
      } catch (err) {
        console.error('[bot-bridge] bus error', err);
      }
    });
    console.log('[bot-bridge] subscribed to agent inbox + notify channels');
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`[bot-bridge] received ${sig}, shutting down`);
      // Stop the harness/sync subscriber BEFORE destroying clients so a
      // late-arriving Redis message does not try to swap a `def` on a
      // half-torn-down running map (B3 hard rule).
      try {
        await stopHarnessSync();
      } catch (err) {
        console.warn('[bot-bridge] harness-sync stop failed:', (err as Error)?.message ?? err);
      }
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
