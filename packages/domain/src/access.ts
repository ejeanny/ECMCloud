import type { Right } from './rights.js';

/**
 * Grant-then-deny evaluation, matching the overlay Dokmee builds out of
 * `Dms_Roles_System_Rights` / `Dms_Roles_Rights` minus
 * `Dms_Users_Denied_*` minus `Dms_User_Denied_Fc`
 * (REVERSE-ENGINEERING.md §5).
 */
export interface Principal {
  readonly userId: string;
  readonly userName: string;
  readonly isAdministrator: boolean;
  /** Union of rights granted by the user's roles, system-wide. */
  readonly systemGrants: ReadonlySet<Right>;
  /** Rights explicitly denied to this user, system-wide. */
  readonly systemDenies: ReadonlySet<Right>;
  /** Per-cabinet grants, keyed by cabinet id. */
  readonly cabinetGrants: ReadonlyMap<string, ReadonlySet<Right>>;
  /** Per-cabinet explicit denies. */
  readonly cabinetDenies: ReadonlyMap<string, ReadonlySet<Right>>;
  /** Cabinets this user may not enter at all. */
  readonly deniedCabinets: ReadonlySet<string>;
  /** Cabinets where the user's role is marked read-only. */
  readonly readOnlyCabinets: ReadonlySet<string>;
}

const WRITE_RIGHTS: ReadonlySet<Right> = new Set<Right>([
  'Copy_Document',
  'Move_Document',
  'Delete_Document',
  'Edit_Document',
  'Merge_Document',
  'Split_Document',
  'Extract_Pages',
  'Attach_Files',
  'Import_With_Indexing',
  'Create_Folder',
  'Save_Document_New_Version',
  'Save_Document_Overwrite',
  'Save_Document_Save_As',
  'Save_Document_Revert_Version',
  'Add_Annotation',
  'Edit_Annotation',
  'Delete_Annotation',
  'Burn_Annotation',
  'Add_Stamp',
  'Custom_Stamps_Create_Edit',
  'Bates_Label',
  'Edit_FileNotes',
  'Create_Index_Field',
  'Edit_Index_Field',
  'Delete_Index_Field',
  'Update_IndexValue',
  'Find_Replace_IndexValue',
  'Cut_Restore_Recycle_Bin',
  'Empty_Recycle_Bin',
]);

export function isWriteRight(right: Right): boolean {
  return WRITE_RIGHTS.has(right);
}

/** Does this principal hold `right` at the system level? */
export function canSystem(principal: Principal, right: Right): boolean {
  if (principal.isAdministrator) return true;
  if (principal.systemDenies.has(right)) return false;
  return principal.systemGrants.has(right);
}

/** Does this principal hold `right` inside `cabinetId`? */
export function canInCabinet(
  principal: Principal,
  cabinetId: string,
  right: Right,
): boolean {
  if (principal.deniedCabinets.has(cabinetId)) return false;
  if (principal.isAdministrator) return true;
  if (principal.readOnlyCabinets.has(cabinetId) && isWriteRight(right)) return false;
  if (principal.cabinetDenies.get(cabinetId)?.has(right)) return false;
  if (principal.systemDenies.has(right)) return false;
  if (principal.cabinetGrants.get(cabinetId)?.has(right)) return true;
  return principal.systemGrants.has(right);
}

export function canEnterCabinet(principal: Principal, cabinetId: string): boolean {
  if (principal.deniedCabinets.has(cabinetId)) return false;
  if (principal.isAdministrator) return true;
  return (
    principal.cabinetGrants.has(cabinetId) || principal.systemGrants.has('View_Open')
  );
}

/**
 * Row-level view restriction, replacing Dokmee's opaque
 * `Dms_View_Restrictions.RestrictionCondition` / `RestrictionCriteria`
 * varbinary blobs with a declared predicate (§6).
 */
export type RestrictionOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'isEmpty'
  | 'isNotEmpty';

export interface RestrictionClause {
  readonly fieldId: string;
  readonly operator: RestrictionOperator;
  readonly value?: string | number | boolean | readonly string[] | null;
}

export interface ViewRestriction {
  /** All clauses must hold (`and`) or any (`or`). */
  readonly combine: 'and' | 'or';
  readonly clauses: readonly RestrictionClause[];
}
