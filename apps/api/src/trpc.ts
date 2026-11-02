import { TRPCError, initTRPC } from '@trpc/server';
import {
  canInCabinet,
  canSystem,
  canEnterCabinet,
  type Principal,
  type Right,
} from '@ecm/domain';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const requireSession = middleware(({ ctx, next }) => {
  if (!ctx.principal) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No active session.' });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

export const protectedProcedure = t.procedure.use(requireSession);

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.principal.isAdministrator) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator only.' });
  }
  return next();
});

/** Procedure that needs a system-level right. */
export function systemRight(right: Right) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!canSystem(ctx.principal, right)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Missing right ${right}.` });
    }
    return next();
  });
}

/**
 * Procedure whose input carries a `cabinetId` and needs `right` inside it.
 * Mirrors Dokmee's per-cabinet right check rather than a global one.
 */
export function cabinetRight(right: Right) {
  return protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
    const raw = (await getRawInput()) as { cabinetId?: unknown } | undefined;
    const cabinetId = raw?.cabinetId;
    if (typeof cabinetId !== 'string') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cabinetId is required for this procedure.',
      });
    }
    if (!canInCabinet(ctx.principal, cabinetId, right)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Missing right ${right} in this cabinet.`,
      });
    }
    return next();
  });
}

/** Imperative check for procedures that resolve the cabinet from a node id. */
export function assertCabinetRight(
  principal: Principal,
  cabinetId: string,
  right: Right,
): void {
  if (!canInCabinet(principal, cabinetId, right)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Missing right ${right} in this cabinet.`,
    });
  }
}

export function assertCanEnter(principal: Principal, cabinetId: string): void {
  if (!canEnterCabinet(principal, cabinetId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cabinet not accessible.' });
  }
}

export function notFound(what: string): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: `${what} not found.` });
}

export function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}

export function badRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}
