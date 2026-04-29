import type { FastifyReply } from 'fastify';

type Client = { id: number; reply: FastifyReply };
const clients = new Set<Client>();
let nextId = 1;

export function attachSse(reply: FastifyReply): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  const client: Client = { id: nextId++, reply };
  clients.add(client);
  reply.raw.write(`: connected ${client.id}\n\n`);

  const ping = setInterval(() => {
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {}
  }, 15000);

  reply.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.reply.raw.write(payload);
    } catch {}
  }
}
