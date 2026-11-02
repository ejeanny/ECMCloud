import { Prisma, prisma } from '@ecm/db';
import {
  storageSlotFor,
  type FieldType,
  type IndexValue,
  type RestrictionClause,
  type ViewRestriction,
} from '@ecm/domain';
import { badRequest } from './trpc.js';

/**
 * Reads and writes index-field values.
 *
 * Dokmee kept these as *columns* on `Dms_FsNodeIndex`, added by ALTER TABLE
 * when a field was created (REVERSE-ENGINEERING.md §4). Here they are rows in
 * `node_index_value`, each landing in the typed slot its FieldType maps to, so
 * range and ordering queries stay typed without dynamic DDL.
 */

export interface FieldMeta {
  readonly id: string;
  readonly label: string;
  readonly type: FieldType;
  readonly isRequired: boolean;
  readonly isLocked: boolean;
  readonly folderLevel: number;
  readonly sort: number;
}

export async function fieldsFor(cabinetId: string): Promise<FieldMeta[]> {
  const rows = await prisma.indexField.findMany({
    where: { cabinetId },
    orderBy: [{ sort: 'asc' }, { label: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type as FieldType,
    isRequired: r.isRequired,
    isLocked: r.isLocked,
    folderLevel: r.folderLevel,
    sort: r.sort,
  }));
}

type Slots = {
  textValue: string | null;
  numberValue: Prisma.Decimal | null;
  dateValue: Date | null;
  booleanValue: boolean | null;
};

const EMPTY_SLOTS: Slots = {
  textValue: null,
  numberValue: null,
  dateValue: null,
  booleanValue: null,
};

/** Coerces a submitted value into the slot its field type uses. */
export function toSlots(type: FieldType, raw: IndexValue['value']): Slots {
  if (raw === null || raw === '') return { ...EMPTY_SLOTS };

  switch (storageSlotFor(type)) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) badRequest(`Value for a ${type} field is not a number.`);
      return { ...EMPTY_SLOTS, numberValue: new Prisma.Decimal(n) };
    }
    case 'date': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) badRequest(`Value for a ${type} field is not a date.`);
      return { ...EMPTY_SLOTS, dateValue: d };
    }
    case 'boolean': {
      const b =
        typeof raw === 'boolean'
          ? raw
          : ['true', '1', 'yes'].includes(String(raw).toLowerCase());
      return { ...EMPTY_SLOTS, booleanValue: b };
    }
    default:
      return { ...EMPTY_SLOTS, textValue: String(raw) };
  }
}

export function fromSlots(
  type: FieldType,
  slots: Partial<Slots>,
): string | number | boolean | Date | null {
  switch (storageSlotFor(type)) {
    case 'number':
      return slots.numberValue === null || slots.numberValue === undefined
        ? null
        : Number(slots.numberValue);
    case 'date':
      return slots.dateValue ?? null;
    case 'boolean':
      return slots.booleanValue ?? null;
    default:
      return slots.textValue ?? null;
  }
}

/** Writes a node's index values, enforcing required and locked fields. */
export async function setIndexValues(
  tx: Prisma.TransactionClient,
  cabinetId: string,
  nodeId: string,
  values: readonly IndexValue[],
  options: { allowLocked?: boolean } = {},
): Promise<void> {
  const fields = await tx.indexField.findMany({ where: { cabinetId } });
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const v of values) {
    const field = byId.get(v.fieldId);
    if (!field) badRequest(`Unknown index field ${v.fieldId} for this cabinet.`);
    if (field.isLocked && !options.allowLocked) {
      badRequest(`Index field "${field.label}" is locked.`);
    }
    if (field.isRequired && (v.value === null || v.value === '')) {
      badRequest(`Index field "${field.label}" is required.`);
    }

    const slots = toSlots(field.type as FieldType, v.value);
    await tx.nodeIndexValue.upsert({
      where: { nodeId_fieldId: { nodeId, fieldId: field.id } },
      update: slots,
      create: { nodeId, fieldId: field.id, ...slots },
    });
  }

  await tx.node.update({
    where: { id: nodeId },
    data: { indexModified: new Date() },
  });
}

/** Allocates the next value for an `autoNumber` field, atomically. */
export async function nextAutoNumber(
  tx: Prisma.TransactionClient,
  fieldId: string,
): Promise<number> {
  const updated = await tx.indexField.update({
    where: { id: fieldId },
    data: { autoNumberNext: { increment: 1 } },
    select: { autoNumberNext: true },
  });
  return updated.autoNumberNext - 1;
}

// ------------------------------------------------- predicate -> Prisma where

type Operator = RestrictionClause['operator'];

function slotFilter(
  type: FieldType,
  operator: Operator,
  value: RestrictionClause['value'],
): Prisma.NodeIndexValueWhereInput {
  const slot = storageSlotFor(type);

  if (operator === 'isEmpty' || operator === 'isNotEmpty') {
    const isNull = operator === 'isEmpty';
    switch (slot) {
      case 'number':
        return { numberValue: isNull ? null : { not: null } };
      case 'date':
        return { dateValue: isNull ? null : { not: null } };
      case 'boolean':
        return { booleanValue: isNull ? null : { not: null } };
      default:
        return { textValue: isNull ? null : { not: null } };
    }
  }

  if (operator === 'in') {
    const list = Array.isArray(value) ? value.map(String) : [String(value)];
    return { textValue: { in: list } };
  }

  if (slot === 'text') {
    const text = String(value ?? '');
    switch (operator) {
      case 'eq':
        return { textValue: { equals: text, mode: 'insensitive' } };
      case 'neq':
        return { textValue: { not: text } };
      case 'contains':
        return { textValue: { contains: text, mode: 'insensitive' } };
      case 'startsWith':
        return { textValue: { startsWith: text, mode: 'insensitive' } };
      case 'endsWith':
        return { textValue: { endsWith: text, mode: 'insensitive' } };
      default:
        badRequest(`Operator ${operator} is not valid on a text field.`);
    }
  }

  if (slot === 'boolean') {
    const b = value === true || String(value).toLowerCase() === 'true';
    return { booleanValue: operator === 'neq' ? { not: b } : b };
  }

  const key = slot === 'number' ? 'numberValue' : 'dateValue';
  const typed =
    slot === 'number' ? new Prisma.Decimal(Number(value)) : new Date(String(value));

  switch (operator) {
    case 'eq':
      return { [key]: typed } as Prisma.NodeIndexValueWhereInput;
    case 'neq':
      return { [key]: { not: typed } } as Prisma.NodeIndexValueWhereInput;
    case 'gt':
      return { [key]: { gt: typed } } as Prisma.NodeIndexValueWhereInput;
    case 'gte':
      return { [key]: { gte: typed } } as Prisma.NodeIndexValueWhereInput;
    case 'lt':
      return { [key]: { lt: typed } } as Prisma.NodeIndexValueWhereInput;
    case 'lte':
      return { [key]: { lte: typed } } as Prisma.NodeIndexValueWhereInput;
    default:
      badRequest(`Operator ${operator} is not valid on a ${type} field.`);
  }
}

/**
 * Compiles a clause list into a `Node` where-clause. Each clause becomes an
 * `indexValues: { some: … }` so an AND of clauses is an AND of existence
 * checks over different fields — which is what Dokmee's search and its
 * row-level `Dms_View_Restrictions` both mean.
 */
export function compileClauses(
  clauses: readonly RestrictionClause[],
  fields: ReadonlyMap<string, FieldType>,
  combine: 'and' | 'or',
): Prisma.NodeWhereInput | undefined {
  if (clauses.length === 0) return undefined;

  const parts: Prisma.NodeWhereInput[] = [];
  for (const clause of clauses) {
    const type = fields.get(clause.fieldId);
    if (!type) badRequest(`Unknown index field ${clause.fieldId}.`);
    parts.push({
      indexValues: {
        some: { fieldId: clause.fieldId, ...slotFilter(type, clause.operator, clause.value) },
      },
    });
  }

  return combine === 'or' ? { OR: parts } : { AND: parts };
}

/**
 * Row-level security: the intersection of the view restrictions attached to
 * every role the user holds in this cabinet. A user with no restriction on
 * any of their roles sees everything, matching Dokmee's behaviour where a
 * missing `Dms_View_Restrictions` row means unrestricted.
 */
export async function viewRestrictionFor(
  cabinetId: string,
  roleIds: readonly string[],
  isAdministrator: boolean,
): Promise<Prisma.NodeWhereInput | undefined> {
  if (isAdministrator || roleIds.length === 0) return undefined;

  const [restrictions, fields] = await Promise.all([
    prisma.viewRestriction.findMany({
      where: { cabinetId, roleId: { in: [...roleIds] } },
    }),
    fieldsFor(cabinetId),
  ]);

  // Any unrestricted role grants unrestricted visibility.
  if (restrictions.length < roleIds.length) return undefined;

  const typeById = new Map(fields.map((f) => [f.id, f.type]));
  const perRole: Prisma.NodeWhereInput[] = [];

  for (const r of restrictions) {
    const parsed = r.clauses as unknown as ViewRestriction['clauses'];
    const compiled = compileClauses(
      parsed,
      typeById,
      r.combine === 'or' ? 'or' : 'and',
    );
    if (!compiled) return undefined;
    perRole.push(compiled);
  }

  // Holding several restricted roles widens visibility, not narrows it.
  return perRole.length === 1 ? perRole[0] : { OR: perRole };
}
