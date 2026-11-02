/**
 * Seeds the four built-in roles Dokmee ships with their privilege sets, one
 * administrator, and a demo cabinet whose index fields mirror the `Invoices`
 * cabinet observed on the analysed machine (`Document Title`,
 * `Invoice number`, `Invoice supplier` — REVERSE-ENGINEERING.md §4).
 *
 *   DATABASE_URL=... ECM_ADMIN_PASSWORD=... npm run db:seed
 */
import { BUILTIN_ROLES, BUILTIN_ROLE_RIGHTS, type BuiltinRoleName } from '@ecm/domain';
import argon2 from 'argon2';
import { prisma } from './index.js';

const ADMIN_USER = process.env.ECM_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ECM_ADMIN_PASSWORD;

async function main(): Promise<void> {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'Set ECM_ADMIN_PASSWORD before seeding. The seed never invents a credential.',
    );
  }

  const roleIds = new Map<BuiltinRoleName, string>();

  for (const name of Object.keys(BUILTIN_ROLES) as BuiltinRoleName[]) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: BUILTIN_ROLES[name].description },
      create: {
        name,
        builtin: name,
        description: BUILTIN_ROLES[name].description,
        isAdministrator: name === 'Admin_Role',
      },
    });
    roleIds.set(name, role.id);

    await prisma.roleSystemRight.deleteMany({ where: { roleId: role.id } });
    await prisma.roleSystemRight.createMany({
      data: BUILTIN_ROLE_RIGHTS[name].map((right) => ({ roleId: role.id, right })),
    });
  }

  const adminRoleId = roleIds.get('Admin_Role')!;
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { userName: ADMIN_USER },
    update: { passwordHash, isTempPassword: false, status: 'active' },
    create: {
      userName: ADMIN_USER,
      firstName: 'System',
      lastName: 'Administrator',
      passwordHash,
      isTempPassword: false,
      status: 'active',
    },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRoleId } },
    update: {},
    create: { userId: admin.id, roleId: adminRoleId },
  });

  const cabinet = await prisma.fileCabinet.upsert({
    where: { name: 'Invoices' },
    update: {},
    create: {
      name: 'Invoices',
      description: 'Demo cabinet mirroring the analysed installation.',
      enableFullTextIndex: true,
    },
  });

  const fields: Array<{
    label: string;
    type: string;
    sort: number;
    isDefault?: boolean;
    folderLevel?: number;
  }> = [
    { label: 'Document Title', type: 'text', sort: 0, isDefault: true },
    { label: 'Invoice number', type: 'text', sort: 1 },
    { label: 'Invoice supplier', type: 'text', sort: 2, folderLevel: 1 },
    { label: 'Invoice date', type: 'date', sort: 3 },
    { label: 'Amount', type: 'decimal', sort: 4 },
  ];

  for (const f of fields) {
    await prisma.indexField.upsert({
      where: { cabinetId_label: { cabinetId: cabinet.id, label: f.label } },
      update: { sort: f.sort },
      create: {
        cabinetId: cabinet.id,
        label: f.label,
        type: f.type,
        sort: f.sort,
        isDefault: f.isDefault ?? false,
        folderLevel: f.folderLevel ?? 0,
      },
    });
  }

  for (const name of ['Admin_Role', 'Users_Role'] as BuiltinRoleName[]) {
    const roleId = roleIds.get(name)!;
    await prisma.cabinetRole.upsert({
      where: { cabinetId_roleId: { cabinetId: cabinet.id, roleId } },
      update: {},
      create: { cabinetId: cabinet.id, roleId },
    });
    await prisma.cabinetRoleRight.deleteMany({
      where: { cabinetId: cabinet.id, roleId },
    });
    await prisma.cabinetRoleRight.createMany({
      data: BUILTIN_ROLE_RIGHTS[name].map((right) => ({
        cabinetId: cabinet.id,
        roleId,
        right,
      })),
    });
  }

  console.log(
    `Seeded ${roleIds.size} built-in roles, user "${ADMIN_USER}", cabinet "Invoices" with ${fields.length} index fields.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
