import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '@ecm/db';
import {
  CABINET_RIGHTS,
  RIGHTS,
  SYSTEM_RIGHTS,
  createRoleInput,
  createUserInput,
  pageInput,
  rightSchema,
  setCabinetRoleRightsInput,
  setViewRestrictionInput,
  updateUserInput,
} from '@ecm/domain';
import { audit } from '../audit.js';
import {
  badRequest,
  conflict,
  notFound,
  protectedProcedure,
  router,
  systemRight,
} from '../trpc.js';

/**
 * Dokmee: SecurityController / UserAccountController / RepoSecurityController
 * and `Dms.Contracts.Security.dll` (§5). Right assignment is grant-then-deny:
 * roles grant, `UserDeniedRight` takes away, and view restrictions narrow
 * which rows a role can see at all.
 */
const userAdmin = systemRight('User_Administration');

export const securityRouter = router({
  /** The privilege vocabulary, for the role editor. */
  rights: protectedProcedure.query(() => ({
    all: RIGHTS,
    system: SYSTEM_RIGHTS,
    cabinet: CABINET_RIGHTS,
  })),

  // --- users ------------------------------------------------------------

  users: userAdmin
    .input(
      pageInput.extend({
        search: z.string().max(256).optional(),
        includeDeleted: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const where = {
        ...(input.includeDeleted ? {} : { deleted: null }),
        ...(input.search
          ? {
              OR: [
                { userName: { contains: input.search, mode: 'insensitive' as const } },
                { firstName: { contains: input.search, mode: 'insensitive' as const } },
                { lastName: { contains: input.search, mode: 'insensitive' as const } },
                { email: { contains: input.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { userName: 'asc' },
          skip: input.skip,
          take: input.take,
          select: {
            id: true,
            userName: true,
            firstName: true,
            lastName: true,
            email: true,
            status: true,
            userType: true,
            isTempPassword: true,
            expirationDate: true,
            languageCode: true,
            created: true,
            deleted: true,
            roles: { select: { role: { select: { id: true, name: true } } } },
          },
        }),
        prisma.user.count({ where }),
      ]);

      return {
        items: items.map((u) => ({
          ...u,
          roles: u.roles.map((r) => r.role),
        })),
        total,
      };
    }),

  createUser: userAdmin.input(createUserInput).mutation(async ({ ctx, input }) => {
    const clash = await prisma.user.findUnique({ where: { userName: input.userName } });
    if (clash) conflict(`A user named "${input.userName}" already exists.`);

    // A temporary password is generated rather than asked for, so an
    // administrator never has to invent or transcribe one.
    const generated = input.password ?? randomBytes(12).toString('base64url');
    const { roleIds, password, ...data } = input;

    const user = await prisma.user.create({
      data: {
        ...data,
        passwordHash: await argon2.hash(generated, { type: argon2.argon2id }),
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
      },
      select: { id: true, userName: true },
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'create',
      detail: { what: 'user', userName: user.userName },
    });

    return {
      user,
      /** Returned once, never stored in clear, so it can be handed over. */
      temporaryPassword: input.password ? null : generated,
    };
  }),

  updateUser: userAdmin.input(updateUserInput).mutation(async ({ ctx, input }) => {
    const { userId, roleIds, ...data } = input;

    const user = await prisma.$transaction(async (tx) => {
      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId } });
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId, roleId })),
        });
      }
      return tx.user.update({
        where: { id: userId },
        data,
        select: { id: true, userName: true },
      });
    });

    // A permission change must not leave a stale session authorised.
    if (roleIds) {
      await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await audit(ctx.principal, ctx.ip, {
      action: roleIds ? 'permissionChange' : 'update',
      detail: { what: 'user', userName: user.userName },
    });
    return user;
  }),

  resetPassword: userAdmin
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const temporary = randomBytes(12).toString('base64url');
      const user = await prisma.user.update({
        where: { id: input.userId },
        data: {
          passwordHash: await argon2.hash(temporary, { type: argon2.argon2id }),
          isTempPassword: true,
          passwordChanged: null,
        },
        select: { userName: true },
      });

      await prisma.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        detail: { what: 'passwordReset', userName: user.userName },
      });
      return { temporaryPassword: temporary };
    }),

  /** Soft delete, as Dokmee's `Dms_Users.Deleted` column is. */
  deleteUser: userAdmin
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.principal.userId) {
        badRequest('You cannot delete your own account.');
      }
      const user = await prisma.user.update({
        where: { id: input.userId },
        data: { deleted: new Date(), status: 'disabled' },
        select: { userName: true },
      });
      await prisma.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(ctx.principal, ctx.ip, {
        action: 'delete',
        detail: { what: 'user', userName: user.userName },
      });
      return { ok: true };
    }),

  // --- roles ------------------------------------------------------------

  roles: userAdmin.query(async () => {
    const roles = await prisma.role.findMany({
      orderBy: [{ builtin: 'asc' }, { name: 'asc' }],
      include: {
        systemRights: { select: { right: true } },
        _count: { select: { users: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      builtin: r.builtin,
      isAdministrator: r.isAdministrator,
      systemRights: r.systemRights.map((s) => s.right),
      userCount: r._count.users,
    }));
  }),

  createRole: userAdmin.input(createRoleInput).mutation(async ({ ctx, input }) => {
    const clash = await prisma.role.findUnique({ where: { name: input.roleName } });
    if (clash) conflict(`A role named "${input.roleName}" already exists.`);

    const role = await prisma.role.create({
      data: {
        name: input.roleName,
        description: input.description,
        systemRights: { create: input.systemRights.map((right) => ({ right })) },
      },
      select: { id: true, name: true },
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'create',
      detail: { what: 'role', name: role.name },
    });
    return role;
  }),

  setRoleSystemRights: userAdmin
    .input(z.object({ roleId: z.string().uuid(), rights: z.array(rightSchema) }))
    .mutation(async ({ ctx, input }) => {
      const role = await prisma.role.findUnique({ where: { id: input.roleId } });
      if (!role) notFound('Role');
      if (role.builtin) badRequest('Built-in role rights cannot be changed.');

      await prisma.$transaction([
        prisma.roleSystemRight.deleteMany({ where: { roleId: input.roleId } }),
        prisma.roleSystemRight.createMany({
          data: input.rights.map((right) => ({ roleId: input.roleId, right })),
        }),
      ]);

      await invalidateSessionsForRole(input.roleId);
      await audit(ctx.principal, ctx.ip, {
        action: 'permissionChange',
        detail: { what: 'roleSystemRights', role: role.name, count: input.rights.length },
      });
      return { ok: true };
    }),

  deleteRole: userAdmin
    .input(z.object({ roleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const role = await prisma.role.findUnique({ where: { id: input.roleId } });
      if (!role) notFound('Role');
      if (role.builtin) badRequest('A built-in role cannot be deleted.');

      await invalidateSessionsForRole(input.roleId);
      await prisma.role.delete({ where: { id: input.roleId } });
      await audit(ctx.principal, ctx.ip, {
        action: 'delete',
        detail: { what: 'role', name: role.name },
      });
      return { ok: true };
    }),

  // --- per-cabinet rights ----------------------------------------------

  cabinetRoles: userAdmin
    .input(z.object({ cabinetId: z.string().uuid() }))
    .query(async ({ input }) => {
      const [bindings, grants, restrictions] = await Promise.all([
        prisma.cabinetRole.findMany({
          where: { cabinetId: input.cabinetId },
          include: { role: { select: { id: true, name: true, builtin: true } } },
        }),
        prisma.cabinetRoleRight.findMany({ where: { cabinetId: input.cabinetId } }),
        prisma.viewRestriction.findMany({ where: { cabinetId: input.cabinetId } }),
      ]);

      const rightsByRole = new Map<string, string[]>();
      for (const g of grants) {
        const list = rightsByRole.get(g.roleId) ?? [];
        list.push(g.right);
        rightsByRole.set(g.roleId, list);
      }
      const restrictionByRole = new Map(restrictions.map((r) => [r.roleId, r]));

      return bindings.map((b) => ({
        role: b.role,
        isReadOnly: b.isReadOnly,
        isFileAccessDenied: b.isFileAccessDenied,
        rights: rightsByRole.get(b.roleId) ?? [],
        restriction: restrictionByRole.get(b.roleId)
          ? {
              combine: restrictionByRole.get(b.roleId)!.combine,
              clauses: restrictionByRole.get(b.roleId)!.clauses,
            }
          : null,
      }));
    }),

  setCabinetRoleRights: userAdmin
    .input(setCabinetRoleRightsInput)
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction([
        prisma.cabinetRole.upsert({
          where: {
            cabinetId_roleId: { cabinetId: input.cabinetId, roleId: input.roleId },
          },
          update: {
            isReadOnly: input.isReadOnly,
            isFileAccessDenied: input.isFileAccessDenied,
          },
          create: {
            cabinetId: input.cabinetId,
            roleId: input.roleId,
            isReadOnly: input.isReadOnly,
            isFileAccessDenied: input.isFileAccessDenied,
          },
        }),
        prisma.cabinetRoleRight.deleteMany({
          where: { cabinetId: input.cabinetId, roleId: input.roleId },
        }),
        prisma.cabinetRoleRight.createMany({
          data: input.rights.map((right) => ({
            cabinetId: input.cabinetId,
            roleId: input.roleId,
            right,
          })),
        }),
      ]);

      await invalidateSessionsForRole(input.roleId);
      await audit(ctx.principal, ctx.ip, {
        action: 'permissionChange',
        cabinetId: input.cabinetId,
        detail: { what: 'cabinetRoleRights', roleId: input.roleId },
      });
      return { ok: true };
    }),

  /** Dokmee: Dms_View_Restrictions — row-level security over index fields. */
  setViewRestriction: userAdmin
    .input(setViewRestrictionInput)
    .mutation(async ({ ctx, input }) => {
      const fields = await prisma.indexField.findMany({
        where: { cabinetId: input.cabinetId },
        select: { id: true },
      });
      const known = new Set(fields.map((f) => f.id));
      for (const clause of input.clauses) {
        if (!known.has(clause.fieldId)) {
          badRequest(`Field ${clause.fieldId} is not in this cabinet.`);
        }
      }

      if (input.clauses.length === 0) {
        await prisma.viewRestriction.deleteMany({
          where: { cabinetId: input.cabinetId, roleId: input.roleId },
        });
      } else {
        await prisma.viewRestriction.upsert({
          where: {
            cabinetId_roleId: { cabinetId: input.cabinetId, roleId: input.roleId },
          },
          update: { combine: input.combine, clauses: input.clauses as never },
          create: {
            cabinetId: input.cabinetId,
            roleId: input.roleId,
            combine: input.combine,
            clauses: input.clauses as never,
          },
        });
      }

      await audit(ctx.principal, ctx.ip, {
        action: 'permissionChange',
        cabinetId: input.cabinetId,
        detail: { what: 'viewRestriction', roleId: input.roleId, clauses: input.clauses.length },
      });
      return { ok: true };
    }),

  // --- explicit denies --------------------------------------------------

  setUserDenies: userAdmin
    .input(
      z.object({
        userId: z.string().uuid(),
        cabinetId: z.string().uuid().nullable(),
        rights: z.array(rightSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction([
        prisma.userDeniedRight.deleteMany({
          where: { userId: input.userId, cabinetId: input.cabinetId },
        }),
        prisma.userDeniedRight.createMany({
          data: input.rights.map((right) => ({
            userId: input.userId,
            cabinetId: input.cabinetId,
            right,
          })),
        }),
      ]);
      await prisma.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(ctx.principal, ctx.ip, {
        action: 'permissionChange',
        cabinetId: input.cabinetId,
        detail: { what: 'userDenies', userId: input.userId, count: input.rights.length },
      });
      return { ok: true };
    }),

  setCabinetDenied: userAdmin
    .input(
      z.object({
        userId: z.string().uuid(),
        cabinetId: z.string().uuid(),
        denied: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.denied) {
        await prisma.userDeniedCabinet.upsert({
          where: { userId_cabinetId: { userId: input.userId, cabinetId: input.cabinetId } },
          update: {},
          create: { userId: input.userId, cabinetId: input.cabinetId },
        });
      } else {
        await prisma.userDeniedCabinet.deleteMany({
          where: { userId: input.userId, cabinetId: input.cabinetId },
        });
      }
      await prisma.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true };
    }),
});

/**
 * Revokes every session of every user holding the role, so a narrowed
 * permission takes effect immediately rather than at the next login.
 */
async function invalidateSessionsForRole(roleId: string): Promise<void> {
  const holders = await prisma.userRole.findMany({
    where: { roleId },
    select: { userId: true },
  });
  if (holders.length === 0) return;
  await prisma.session.updateMany({
    where: { userId: { in: holders.map((h) => h.userId) }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
