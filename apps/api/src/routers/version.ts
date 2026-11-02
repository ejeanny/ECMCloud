import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { prisma } from '@ecm/db';
import { checkInInput, checkOutInput, revertVersionInput } from '@ecm/domain';
import { audit } from '../audit.js';
import { clearStaging, splitName, stagingPath, writeBlob } from '../storage.js';
import {
  assertCabinetRight,
  badRequest,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';

/**
 * Dokmee: Dms_FsVersions + Dms_FsCheckedOut, and the four Save_Document_*
 * rights that gate them (§4, §5). Versions are major.minor, each carrying its
 * own extracted text, as Dokmee's per-version `FullText` column did.
 */
export const versionRouter = router({
  list: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
      if (!node) notFound('Document');
      assertCabinetRight(ctx.principal, node.cabinetId, 'Folders_Files_View_Versions');

      const versions = await prisma.nodeVersion.findMany({
        where: { nodeId: node.id },
        orderBy: [{ majorVersion: 'desc' }, { minorVersion: 'desc' }],
        include: { createdBy: { select: { userName: true } } },
      });

      return versions.map((v) => ({
        id: v.id,
        label: `${v.majorVersion}.${v.minorVersion}`,
        majorVersion: v.majorVersion,
        minorVersion: v.minorVersion,
        name: v.name,
        ext: v.ext,
        byteLength: v.byteLength === null ? null : Number(v.byteLength),
        pages: v.pages,
        comment: v.comment,
        createdBy: v.createdBy.userName,
        created: v.created,
      }));
    }),

  checkOut: protectedProcedure.input(checkOutInput).mutation(async ({ ctx, input }) => {
    const node = await prisma.node.findUnique({
      where: { id: input.nodeId },
      include: { checkout: { include: { user: { select: { userName: true } } } } },
    });
    if (!node) notFound('Document');
    if (node.kind !== 'document') badRequest('Only documents can be checked out.');
    assertCabinetRight(ctx.principal, node.cabinetId, 'Edit_Document');

    if (node.checkout) {
      if (node.checkout.userId === ctx.principal.userId) {
        return { ok: true, alreadyHeld: true as const };
      }
      conflict(`Already checked out by ${node.checkout.user.userName}.`);
    }

    await prisma.$transaction([
      prisma.checkout.create({
        data: {
          nodeId: node.id,
          userId: ctx.principal.userId,
          comment: input.comment ?? null,
        },
      }),
      prisma.node.update({
        where: { id: node.id },
        data: { isCheckedOut: true, checkedOutAt: new Date() },
      }),
    ]);

    await audit(ctx.principal, ctx.ip, {
      action: 'checkOut',
      cabinetId: node.cabinetId,
      nodeId: node.id,
      nodeName: node.name,
    });
    return { ok: true, alreadyHeld: false as const };
  }),

  /**
   * Check-in snapshots the *current* content as a version, then promotes the
   * uploaded bytes to current — so the version list reads as a history and
   * reverting is symmetric.
   */
  checkIn: protectedProcedure.input(checkInInput).mutation(async ({ ctx, input }) => {
    const node = await prisma.node.findUnique({
      where: { id: input.nodeId },
      include: { checkout: true },
    });
    if (!node) notFound('Document');
    if (!node.checkout) conflict('Document is not checked out.');
    if (node.checkout.userId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
      conflict('Document is checked out by another user.');
    }

    const right =
      input.bump === 'major' || input.bump === 'minor'
        ? 'Save_Document_New_Version'
        : 'Save_Document_Overwrite';
    assertCabinetRight(ctx.principal, node.cabinetId, right);

    const cabinet = await prisma.fileCabinet.findUniqueOrThrow({
      where: { id: node.cabinetId },
      select: { repoEncrypted: true },
    });

    // No upload means the user is releasing the lock without new content.
    let incoming: {
      blobId: string;
      byteLength: number;
      sha256: string;
      encryptedKey: string | null;
      encryptionIv: string | null;
      name: string;
      ext: string | null;
    } | null = null;

    if (input.uploadId) {
      const upload = await prisma.upload.findUnique({ where: { id: input.uploadId } });
      if (!upload || upload.userId !== ctx.principal.userId) notFound('Upload');
      if (upload.state !== 'open') conflict(`Upload is already ${upload.state}.`);

      for (let i = 0; i < upload.segmentCount; i += 1) {
        try {
          await stat(stagingPath(upload.id, i));
        } catch {
          badRequest(`Segment ${i} is missing.`);
        }
      }

      const blobId = randomUUID();
      const stored = await writeBlob(
        node.cabinetId,
        blobId,
        concatSegments(upload.id, upload.segmentCount),
        { encrypt: cabinet.repoEncrypted },
      );
      await clearStaging(upload.id);
      await prisma.upload.update({ where: { id: upload.id }, data: { state: 'complete' } });

      const { ext } = splitName(upload.fileName);
      incoming = {
        blobId,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        encryptedKey: stored.envelope?.encryptedKey ?? null,
        encryptionIv: stored.envelope?.encryptionIv ?? null,
        name: upload.fileName,
        ext,
      };
    }

    const latest = await prisma.nodeVersion.findFirst({
      where: { nodeId: node.id },
      orderBy: [{ majorVersion: 'desc' }, { minorVersion: 'desc' }],
      select: { majorVersion: true, minorVersion: true },
    });

    const result = await prisma.$transaction(async (tx) => {
      let versionLabel: string | null = null;

      if (incoming && input.bump !== 'overwrite') {
        const major =
          input.bump === 'major' ? (latest?.majorVersion ?? 0) + 1 : latest?.majorVersion ?? 1;
        const minor = input.bump === 'major' ? 0 : (latest?.minorVersion ?? 0) + 1;

        // The version row takes ownership of the blob being superseded.
        await tx.nodeVersion.create({
          data: {
            nodeId: node.id,
            majorVersion: major,
            minorVersion: minor,
            name: node.name,
            ext: node.ext,
            byteLength: node.byteLength,
            pages: node.pages,
            sha256: node.sha256,
            blobId: node.blobId,
            encryptedKey: node.encryptedKey,
            encryptionIv: node.encryptionIv,
            fullText: node.fullText,
            textExtractedAt: node.textExtractedAt,
            comment: input.comment ?? null,
            createdById: ctx.principal.userId,
          },
        });
        versionLabel = `${major}.${minor}`;
      }

      await tx.node.update({
        where: { id: node.id },
        data: {
          isCheckedOut: false,
          checkedOutAt: null,
          ...(incoming
            ? {
                name: incoming.name,
                ext: incoming.ext,
                blobId: incoming.blobId,
                byteLength: BigInt(incoming.byteLength),
                sha256: incoming.sha256,
                encryptedKey: incoming.encryptedKey,
                encryptionIv: incoming.encryptionIv,
                // Text is stale until the extraction job re-runs.
                fullText: null,
                textExtractedAt: null,
                pages: null,
              }
            : {}),
        },
      });

      await tx.checkout.delete({ where: { nodeId: node.id } });

      if (incoming) {
        await tx.job.create({
          data: { kind: 'textExtraction', cabinetId: node.cabinetId, nodeId: node.id },
        });
      }

      return { versionLabel };
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'checkIn',
      cabinetId: node.cabinetId,
      nodeId: node.id,
      nodeName: node.name,
      detail: { bump: input.bump, version: result.versionLabel },
    });

    return { ok: true, version: result.versionLabel };
  }),

  /** Releases a lock without saving. Admins can break another user's lock. */
  cancelCheckOut: protectedProcedure
    .input(z.object({ nodeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const checkout = await prisma.checkout.findUnique({
        where: { nodeId: input.nodeId },
        include: { node: { select: { cabinetId: true, name: true } } },
      });
      if (!checkout) notFound('Check-out');
      if (checkout.userId !== ctx.principal.userId && !ctx.principal.isAdministrator) {
        conflict('Only the holder or an administrator can cancel this check-out.');
      }

      await prisma.$transaction([
        prisma.checkout.delete({ where: { nodeId: input.nodeId } }),
        prisma.node.update({
          where: { id: input.nodeId },
          data: { isCheckedOut: false, checkedOutAt: null },
        }),
      ]);

      await audit(ctx.principal, ctx.ip, {
        action: 'update',
        cabinetId: checkout.node.cabinetId,
        nodeId: input.nodeId,
        nodeName: checkout.node.name,
        detail: { what: 'cancelCheckOut', brokenLock: checkout.userId !== ctx.principal.userId },
      });
      return { ok: true };
    }),

  /** Dokmee: Save_Document_Revert_Version. */
  revert: protectedProcedure.input(revertVersionInput).mutation(async ({ ctx, input }) => {
    const node = await prisma.node.findUnique({ where: { id: input.nodeId } });
    if (!node) notFound('Document');
    assertCabinetRight(ctx.principal, node.cabinetId, 'Save_Document_Revert_Version');
    if (node.isCheckedOut) conflict('Check the document in before reverting.');

    const version = await prisma.nodeVersion.findUnique({ where: { id: input.versionId } });
    if (!version || version.nodeId !== node.id) notFound('Version');

    const latest = await prisma.nodeVersion.findFirst({
      where: { nodeId: node.id },
      orderBy: [{ majorVersion: 'desc' }, { minorVersion: 'desc' }],
      select: { majorVersion: true, minorVersion: true },
    });

    await prisma.$transaction(async (tx) => {
      // The content being replaced becomes a version of its own, so a revert
      // is itself undoable.
      await tx.nodeVersion.create({
        data: {
          nodeId: node.id,
          majorVersion: latest?.majorVersion ?? 1,
          minorVersion: (latest?.minorVersion ?? 0) + 1,
          name: node.name,
          ext: node.ext,
          byteLength: node.byteLength,
          pages: node.pages,
          sha256: node.sha256,
          blobId: node.blobId,
          encryptedKey: node.encryptedKey,
          encryptionIv: node.encryptionIv,
          fullText: node.fullText,
          textExtractedAt: node.textExtractedAt,
          comment: input.comment ?? `Superseded by revert to ${version.majorVersion}.${version.minorVersion}`,
          createdById: ctx.principal.userId,
        },
      });

      await tx.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          ext: version.ext,
          byteLength: version.byteLength,
          pages: version.pages,
          sha256: version.sha256,
          blobId: version.blobId,
          encryptedKey: version.encryptedKey,
          encryptionIv: version.encryptionIv,
          fullText: version.fullText,
          textExtractedAt: version.textExtractedAt,
        },
      });
    });

    await audit(ctx.principal, ctx.ip, {
      action: 'revertVersion',
      cabinetId: node.cabinetId,
      nodeId: node.id,
      nodeName: node.name,
      detail: { to: `${version.majorVersion}.${version.minorVersion}` },
    });
    return { ok: true };
  }),

  /** Documents the caller currently holds — the "my check-outs" view. */
  myCheckOuts: protectedProcedure.query(async ({ ctx }) => {
    const rows = await prisma.checkout.findMany({
      where: { userId: ctx.principal.userId },
      include: {
        node: { select: { id: true, name: true, ext: true, cabinetId: true } },
      },
      orderBy: { created: 'desc' },
    });
    return rows.map((r) => ({
      checkoutId: r.id,
      comment: r.comment,
      since: r.created,
      node: r.node,
    }));
  }),
});

function concatSegments(uploadId: string, count: number): Readable {
  async function* read(): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i += 1) {
      for await (const chunk of createReadStream(stagingPath(uploadId, i))) {
        yield chunk as Buffer;
      }
    }
  }
  return Readable.from(read());
}
