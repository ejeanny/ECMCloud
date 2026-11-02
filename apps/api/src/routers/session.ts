import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '@ecm/db';
import { changePasswordInput, loginInput, pageInput } from '@ecm/domain';
import { audit } from '../audit.js';
import { SESSION_COOKIE, hashToken } from '../context.js';
import { env } from '../env.js';
import { loadPrincipal } from '../principal.js';
import {
  badRequest,
  protectedProcedure,
  publicProcedure,
  router,
  systemRight,
} from '../trpc.js';

/**
 * Dokmee: SessionController / UserAccountController / GettingStartedController.
 * Sessions are rows (`Dms_Sessions`), not stateless tokens, and Dokmee keys
 * them per browser window — kept here as `windowId`.
 */
export const sessionRouter = router({
  /** Dokmee: login + UpdateSessionStatus. */
  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    const user = await prisma.user.findFirst({
      where: { userName: input.userName, deleted: null },
    });

    // Compare even when the user is missing, so a bad user name and a bad
    // password take the same time.
    const hash = user?.passwordHash ?? `$argon2id$v=19$m=65536,t=3,p=4$${'A'.repeat(22)}$${'A'.repeat(43)}`;
    let ok = false;
    try {
      ok = await argon2.verify(hash, input.password);
    } catch {
      ok = false;
    }

    if (!user || !ok) {
      await audit(null, ctx.ip, {
        action: 'loginFailed',
        detail: { userName: input.userName },
      });
      badRequest('Invalid user name or password.');
    }

    if (user.status !== 'active') {
      badRequest(`Account is ${user.status}.`);
    }
    if (user.expirationDate && user.expirationDate <= new Date()) {
      badRequest('Account has expired.');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env().SESSION_TTL_MINUTES * 60_000);

    const session = await prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        deviceId: input.deviceId ?? '',
        windowId: randomBytes(8).toString('hex'),
        userAgent: ctx.req.headers['user-agent'] ?? null,
        ipAddress: ctx.ip ?? null,
        expiresAt,
      },
    });

    ctx.res.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().NODE_ENV === 'production',
      path: '/',
      expires: expiresAt,
    });

    await audit({ userId: user.id, userName: user.userName }, ctx.ip, {
      action: 'login',
    });

    return {
      token,
      sessionId: session.id,
      expiresAt,
      mustChangePassword: user.isTempPassword,
      user: {
        id: user.id,
        userName: user.userName,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        languageCode: user.languageCode,
      },
    };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionId) {
      await prisma.session.update({
        where: { id: ctx.sessionId },
        data: { revokedAt: new Date() },
      });
    }
    ctx.res.clearCookie(SESSION_COOKIE, { path: '/' });
    await audit(ctx.principal, ctx.ip, { action: 'logout' });
    return { ok: true };
  }),

  /** The caller's identity plus their resolved rights — what the UI gates on. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.principal.userId },
      select: {
        id: true,
        userName: true,
        firstName: true,
        lastName: true,
        email: true,
        languageCode: true,
        isTempPassword: true,
      },
    });

    return {
      user,
      isAdministrator: ctx.principal.isAdministrator,
      systemRights: [...ctx.principal.systemGrants].filter(
        (r) => !ctx.principal.systemDenies.has(r),
      ),
      cabinetRights: Object.fromEntries(
        [...ctx.principal.cabinetGrants].map(([cabinetId, rights]) => [
          cabinetId,
          [...rights].filter((r) => !ctx.principal.cabinetDenies.get(cabinetId)?.has(r)),
        ]),
      ),
      readOnlyCabinets: [...ctx.principal.readOnlyCabinets],
    };
  }),

  changePassword: protectedProcedure
    .input(changePasswordInput)
    .mutation(async ({ ctx, input }) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: ctx.principal.userId },
      });
      if (!user.passwordHash || !(await argon2.verify(user.passwordHash, input.currentPassword))) {
        badRequest('Current password is incorrect.');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await argon2.hash(input.newPassword, { type: argon2.argon2id }),
          isTempPassword: false,
          passwordChanged: new Date(),
        },
      });

      // Every other session for this user is invalidated.
      await prisma.session.updateMany({
        where: { userId: user.id, id: { not: ctx.sessionId ?? '' }, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        detail: { what: 'password' },
      });
      return { ok: true };
    }),

  /** Dokmee: gettingstarted/GetPagedSessionsAsync — the admin session list. */
  list: systemRight('User_Administration')
    .input(pageInput.extend({ activeOnly: z.boolean().default(true) }))
    .query(async ({ input }) => {
      const where = input.activeOnly
        ? { revokedAt: null, expiresAt: { gt: new Date() } }
        : {};
      const [items, total] = await Promise.all([
        prisma.session.findMany({
          where,
          orderBy: { lastSeenAt: 'desc' },
          skip: input.skip,
          take: input.take,
          select: {
            id: true,
            userId: true,
            deviceId: true,
            ipAddress: true,
            userAgent: true,
            issuedAt: true,
            lastSeenAt: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: { userName: true, firstName: true, lastName: true } },
          },
        }),
        prisma.session.count({ where }),
      ]);
      return { items, total };
    }),

  /** Dokmee: gettingstarted/DeleteSessionAsync — force a user off. */
  revoke: systemRight('User_Administration')
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.session.update({
        where: { id: input.sessionId },
        data: { revokedAt: new Date() },
      });
      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        detail: { what: 'sessionRevoked', sessionId: input.sessionId },
      });
      return { ok: true };
    }),

  /** Refreshes the principal after a permission change, without re-login. */
  refresh: protectedProcedure.query(async ({ ctx }) => {
    const principal = await loadPrincipal(ctx.principal.userId);
    return { ok: principal !== null };
  }),
});
