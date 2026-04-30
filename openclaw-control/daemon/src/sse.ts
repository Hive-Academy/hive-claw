import type { FastifyReply } from 'fastify';

/**
 * Per-client topic filter. When non-null, an event is delivered to the
 * client only if its event-name's prefix (everything before the first `.`)
 * is in this set. When null, all events are delivered (back-compat).
 *
 * The follower's dispatch worker subscribes with `topics=dispatch` so it
 * receives `dispatch.pending`, `dispatch.taken`, `dispatch.done`,
 * `dispatch.failed`, `dispatch.poisoned` and nothing else.
 */
type TopicSet = ReadonlySet<string> | null;

type Client = { id: number; reply: FastifyReply; topics: TopicSet };
const clients = new Set<Client>();
let nextId = 1;

/**
 * Attach an SSE stream to the given Fastify reply. If `topics` is provided
 * (non-empty), only events whose name's first segment matches one of the
 * listed topics are delivered. Empty / undefined `topics` means
 * "everything", preserving the previous behavior.
 */
export function attachSse(reply: FastifyReply, topics?: readonly string[]): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  const filter: TopicSet = topics && topics.length > 0 ? new Set(topics) : null;
  const client: Client = { id: nextId++, reply, topics: filter };
  clients.add(client);
  reply.raw.write(`: connected ${client.id}\n\n`);

  const ping = setInterval(() => {
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {
      // Best-effort; the close handler will tear the client down.
    }
  }, 15000);

  reply.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function topicOf(event: string): string {
  const dot = event.indexOf('.');
  return dot >= 0 ? event.slice(0, dot) : event;
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const topic = topicOf(event);
  for (const c of clients) {
    if (c.topics && !c.topics.has(topic)) continue;
    try {
      c.reply.raw.write(payload);
    } catch {
      // Best-effort; the close handler will tear the client down.
    }
  }
}
