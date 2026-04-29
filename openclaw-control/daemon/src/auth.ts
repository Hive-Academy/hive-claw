import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest } from 'undici';
import { config } from './config.js';

export interface SessionUser {
  discordId: string;
  username: string;
  avatar?: string;
  email?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, number>();

function newState(): string {
  const s = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  states.set(s, Date.now() + STATE_TTL_MS);
  return s;
}

function consumeState(s: string): boolean {
  const exp = states.get(s);
  if (!exp) return false;
  states.delete(s);
  return exp > Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of states) if (v < now) states.delete(k);
}, 60_000).unref?.();

export function isOAuthConfigured(): boolean {
  return Boolean(config.discord.clientId && config.discord.clientSecret);
}

export async function isAuthorized(
  discordId: string,
  accessToken?: string,
): Promise<boolean> {
  // Strict allowlist (highest priority)
  if (config.discord.allowedUserIds.length > 0) {
    return config.discord.allowedUserIds.includes(discordId);
  }
  // Guild membership check
  if (config.discord.allowedGuildId && accessToken) {
    try {
      const r = await undiciRequest('https://discord.com/api/users/@me/guilds', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const guilds = (await r.body.json()) as Array<{ id: string }>;
      return Array.isArray(guilds) && guilds.some((g) => g.id === config.discord.allowedGuildId);
    } catch {
      return false;
    }
  }
  // Neither set → deny remote logins (only local-dev mode if OAuth not configured)
  return false;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return user;
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(config.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/discord/login', async (_req, reply) => {
    if (!isOAuthConfigured()) {
      return reply
        .code(503)
        .send({ error: 'discord oauth not configured — set DISCORD_CLIENT_ID/SECRET' });
    }
    const state = newState();
    const scope = config.discord.allowedGuildId ? 'identify email guilds' : 'identify email';
    const params = new URLSearchParams({
      client_id: config.discord.clientId,
      redirect_uri: config.discord.redirectUri,
      response_type: 'code',
      scope,
      state,
      prompt: 'consent',
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/discord/callback',
    async (req, reply) => {
      const { code, state } = req.query;
      if (!code || !state || !consumeState(state)) {
        return reply.code(400).send({ error: 'invalid state or code' });
      }
      const tokenRes = await undiciRequest('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.discord.redirectUri,
        }).toString(),
      });
      const tokenJson = (await tokenRes.body.json()) as any;
      if (!tokenJson.access_token) {
        return reply.code(401).send({ error: 'discord token exchange failed', detail: tokenJson });
      }
      const userRes = await undiciRequest('https://discord.com/api/users/@me', {
        headers: { authorization: `Bearer ${tokenJson.access_token}` },
      });
      const u = (await userRes.body.json()) as any;
      if (!u.id) return reply.code(401).send({ error: 'discord user fetch failed' });

      if (!(await isAuthorized(u.id, tokenJson.access_token))) {
        return reply.code(403).send({ error: 'user not allowed', discordId: u.id });
      }

      const session: SessionUser = {
        discordId: u.id,
        username: u.global_name ?? u.username,
        avatar: u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
          : undefined,
        email: u.email,
      };
      const token = await reply.jwtSign(session, { expiresIn: '14d' });
      reply.setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        maxAge: 60 * 60 * 24 * 14,
      });
      return reply.redirect('/');
    },
  );
}

export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = (req.cookies as any)?.[config.cookieName];
  if (!token) return null;
  try {
    const decoded = await req.server.jwt.verify<SessionUser>(token);
    return decoded;
  } catch {
    return null;
  }
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  // Service-token bypass — used by bot-bridge and dispatched agents calling
  // the daemon from inside the same container. Match a constant-time-ish
  // comparison against OPENCLAW_INTERNAL_TOKEN.
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const presented = auth.slice('Bearer '.length).trim();
    if (config.internalToken && presented && presented === config.internalToken) {
      return { discordId: 'service', username: 'service:internal' };
    }
  }

  if (!isOAuthConfigured()) {
    return { discordId: 'local', username: 'local-dev' };
  }
  const user = await currentUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return user;
}
