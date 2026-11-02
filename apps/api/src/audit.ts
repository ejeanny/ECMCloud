import { prisma } from '@ecm/db';
import type { AuditAction, Principal } from '@ecm/domain';

/**
 * Dokmee writes audit rows to `Dms_System_Audit_Records` and to one table per
 * cabinet (`Dokmee_ECM_Audit_Records_<guid>`). Here it is one table with a
 * nullable `cabinetId` (REVERSE-ENGINEERING.md §6).
 *
 * Audit writes never fail a request: a lost audit row is bad, a request that
 * fails because auditing hiccupped is worse, and the failure is logged.
 */
export interface AuditInput {
  readonly action: AuditAction;
  readonly cabinetId?: string | null;
  readonly nodeId?: string | null;
  readonly nodeName?: string | null;
  readonly detail?: Record<string, unknown>;
}

export async function audit(
  principal: Pick<Principal, 'userId' | 'userName'> | null,
  ip: string | undefined,
  input: AuditInput,
): Promise<void> {
  try {
    await prisma.auditRecord.create({
      data: {
        action: input.action,
        userId: principal?.userId ?? null,
        userName: principal?.userName ?? 'anonymous',
        cabinetId: input.cabinetId ?? null,
        nodeId: input.nodeId ?? null,
        nodeName: input.nodeName ?? null,
        ipAddress: ip ?? null,
        detail: (input.detail ?? undefined) as never,
      },
    });
  } catch (error) {
    console.error('audit write failed', { action: input.action, error });
  }
}

/** Fire-and-forget form for hot paths such as view/download. */
export function auditAsync(
  principal: Pick<Principal, 'userId' | 'userName'> | null,
  ip: string | undefined,
  input: AuditInput,
): void {
  void audit(principal, ip, input);
}
