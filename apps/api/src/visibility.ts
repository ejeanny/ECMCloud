import { TRPCError } from '@trpc/server';
import { prisma } from '@ecm/db';
import type { Principal } from '@ecm/domain';
import { viewRestrictionFor } from './index-values.js';
import { roleIdsFor } from './principal.js';

/**
 * Row-level visibility for one document.
 *
 * `viewRestrictionFor` produces a where-clause, which is the right shape for a
 * list or a search — but a restriction that only filters lists is not
 * security. Every path that takes a node id has to ask the same question, or
 * anyone holding an id reads a document the grid correctly hides, and the
 * restriction becomes a convenience rather than a rule.
 *
 * Folders are never restricted, matching the list behaviour: hiding a folder
 * would break the tree around documents the user may legitimately see.
 */

interface NodeIdentity {
  id: string;
  cabinetId: string;
  kind: string;
}

export async function isVisible(
  principal: Principal,
  node: NodeIdentity,
): Promise<boolean> {
  if (principal.isAdministrator) return true;
  if (node.kind === 'folder') return true;

  const restriction = await viewRestrictionFor(
    node.cabinetId,
    await roleIdsFor(principal.userId),
    principal.isAdministrator,
  );
  if (!restriction) return true;

  const matches = await prisma.node.count({
    where: { id: node.id, ...restriction },
  });
  return matches > 0;
}

/**
 * Fail as though the document were not there.
 *
 * Deliberately `NOT_FOUND` rather than `FORBIDDEN`: "you may not see this"
 * confirms a document exists and matches whatever the caller was fishing for,
 * which is the thing a row-level restriction is meant to keep private.
 */
export async function assertVisible(
  principal: Principal,
  node: NodeIdentity,
): Promise<void> {
  if (await isVisible(principal, node)) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
}
