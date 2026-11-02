import type { Principal, Right } from '@ecm/domain';
import { prisma } from '@ecm/db';

/**
 * Builds the grant/deny overlay described in REVERSE-ENGINEERING.md §5 out of
 * the user's roles, their per-cabinet role bindings, and the explicit denies.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deleted: null },
    include: {
      roles: { include: { role: { include: { systemRights: true } } } },
      deniedRights: true,
      deniedCabinets: true,
    },
  });
  if (!user) return null;

  const roleIds = user.roles.map((r) => r.roleId);
  const isAdministrator = user.roles.some((r) => r.role.isAdministrator);

  const systemGrants = new Set<Right>();
  for (const { role } of user.roles) {
    for (const g of role.systemRights) systemGrants.add(g.right as Right);
  }

  const systemDenies = new Set<Right>();
  const cabinetDenies = new Map<string, Set<Right>>();
  for (const d of user.deniedRights) {
    if (d.cabinetId === null) {
      systemDenies.add(d.right as Right);
    } else {
      let set = cabinetDenies.get(d.cabinetId);
      if (!set) cabinetDenies.set(d.cabinetId, (set = new Set()));
      set.add(d.right as Right);
    }
  }

  const cabinetGrants = new Map<string, Set<Right>>();
  const readOnlyCabinets = new Set<string>();

  if (roleIds.length > 0) {
    const [grants, bindings] = await Promise.all([
      prisma.cabinetRoleRight.findMany({ where: { roleId: { in: roleIds } } }),
      prisma.cabinetRole.findMany({ where: { roleId: { in: roleIds } } }),
    ]);

    for (const g of grants) {
      let set = cabinetGrants.get(g.cabinetId);
      if (!set) cabinetGrants.set(g.cabinetId, (set = new Set()));
      set.add(g.right as Right);
    }

    // A cabinet is read-only for this user only if *every* role that binds
    // them to it is read-only; one writable role is enough to write.
    const byCabinet = new Map<string, boolean[]>();
    for (const b of bindings) {
      const list = byCabinet.get(b.cabinetId) ?? [];
      list.push(b.isReadOnly);
      byCabinet.set(b.cabinetId, list);
      if (b.isFileAccessDenied) {
        let set = cabinetDenies.get(b.cabinetId);
        if (!set) cabinetDenies.set(b.cabinetId, (set = new Set()));
        set.add('View_Open');
        set.add('Launch_Document');
      }
    }
    for (const [cabinetId, flags] of byCabinet) {
      if (flags.length > 0 && flags.every(Boolean)) readOnlyCabinets.add(cabinetId);
    }
  }

  return {
    userId: user.id,
    userName: user.userName,
    isAdministrator,
    systemGrants,
    systemDenies,
    cabinetGrants,
    cabinetDenies,
    deniedCabinets: new Set(user.deniedCabinets.map((d) => d.cabinetId)),
    readOnlyCabinets,
  };
}

/** Role ids the user holds — needed to resolve view restrictions. */
export async function roleIdsFor(userId: string): Promise<string[]> {
  const rows = await prisma.userRole.findMany({
    where: { userId },
    select: { roleId: true },
  });
  return rows.map((r) => r.roleId);
}
