/**
 * Fastify request type augmentation.
 *
 * `requireAuth` (auth.ts) returns a `SessionUser` and the `guard` preHandler
 * stamps it onto `req.user` for downstream route handlers. Without this
 * augmentation, every read site has to cast through `any` (cf. CLAUDE.md
 * project guidance: no unsafe casts at JWT/parsing boundaries). Declaring
 * the shape once here lets every handler read `req.user.username` with full
 * type-checking — the type system catches a future rename of
 * `SessionUser.username` instead of letting it silently fall through to
 * `?? 'unknown'` audit lines.
 *
 * NOTE: `@fastify/jwt` already declares `user: fastifyJwt.UserType` on
 * `FastifyRequest`. To narrow that to our session shape we augment
 * `@fastify/jwt`'s `FastifyJWT` interface — that is the documented hook
 * (`@fastify/jwt/types/jwt.d.ts` lines 89-105). Augmenting `fastify`
 * directly would conflict with the plugin's narrower declaration.
 *
 * The optional `[k: string]: unknown` index signature is intentional: the
 * JWT may carry additional fields populated by other auth paths (avatar,
 * email). Authoritative consumers narrow before reading those.
 */

import '@fastify/jwt';

interface OpenClawSessionUser {
  discordId: string;
  username: string;
  avatar?: string;
  email?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: OpenClawSessionUser;
    user: OpenClawSessionUser;
  }
}
