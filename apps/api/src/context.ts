import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@ecm/db';
import type { Principal } from '@ecm/domain';
import { loadPrincipal } from './principal.js';

export const SESSION_COOKIE = 'ecm_session';

export interface Context {
  readonly req: FastifyRequest;
  readonly res: FastifyReply;
  readonly ip: string | undefined;
  readonly sessionId: string | null;
  readonly principal: Principal | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = (req as FastifyRequest & { cookies?: Record<string, string> })
    .cookies?.[SESSION_COOKIE];
  return cookie ?? null;
}

export async function createContext({
  req,
  res,
}: {
  req: FastifyRequest;
  res: FastifyReply;
}): Promise<Context> {
  const base = { req, res, ip: req.ip } as const;
  const token = readToken(req);
  if (!token) return { ...base, sessionId: null, principal: null };

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return { ...base, sessionId: null, principal: null };
  }

  const principal = await loadPrincipal(session.userId);
  if (!principal) return { ...base, sessionId: null, principal: null };

  // Touch last-seen at most once a minute to avoid a write per request.
  void prisma.session
    .updateMany({
      where: { id: session.id, lastSeenAt: { lt: new Date(Date.now() - 60_000) } },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => undefined);

  return { ...base, sessionId: session.id, principal };
}
