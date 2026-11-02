import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { prisma } from '@ecm/db';
import { beginUploadInput, finishUploadInput } from '@ecm/domain';
import { audit } from '../audit.js';
import { setIndexValues } from '../index-values.js';
import { clearStaging, splitName, stagingPath, writeBlob } from '../storage.js';
import {
  badRequest,
  cabinetRight,
  conflict,
  notFound,
  protectedProcedure,
  router,
} from '../trpc.js';

/**
 * Dokmee: UploadDocumentAsync / UploadSegmentAsync / SyncSegments /
 * RemovePartiallyExtractedFile (§3). Segment *bytes* travel over plain HTTP
 * (`POST /upload/:uploadId/:segment`, see server.ts) because tRPC carries
 * JSON; this router opens, finishes and abandons the upload.
 */
export const uploadRouter = router({
  begin: cabinetRight('Import_With_Indexing')
    .input(beginUploadInput)
    .mutation(async ({ ctx, input }) => {
      if (input.parentId) {
        const parent = await prisma.node.findUnique({
          where: { id: input.parentId },
          select: { cabinetId: true, kind: true },
        });
        if (!parent || parent.cabinetId !== input.cabinetId) notFound('Parent folder');
        if (parent.kind !== 'folder') badRequest('Parent must be a folder.');
      }

      const upload = await prisma.upload.create({
        data: {
          cabinetId: input.cabinetId,
          parentId: input.parentId,
          userId: ctx.principal.userId,
          fileName: input.fileName,
          byteLength: BigInt(input.byteLength),
          segmentCount: input.segmentCount,
          expectedSha256: input.sha256 ?? null,
        },
      });

      return {
        uploadId: upload.id,
        segmentCount: upload.segmentCount,
        /** The client PUTs each segment here, 0-based. */
        segmentUrlTemplate: `/upload/${upload.id}/{segment}`,
      };
    }),

  /** Dokmee: SyncSegments — which segments the server already holds. */
  status: protectedProcedure
    .input(z.object({ uploadId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const upload = await prisma.upload.findUnique({ where: { id: input.uploadId } });
      if (!upload || upload.userId !== ctx.principal.userId) notFound('Upload');

      const dir = path.dirname(stagingPath(upload.id, 0));
      let present: number[] = [];
      try {
        const names = await readdir(dir);
        present = names.map((n) => Number.parseInt(n, 10)).filter(Number.isInteger).sort((a, b) => a - b);
      } catch {
        present = [];
      }

      return {
        state: upload.state,
        segmentCount: upload.segmentCount,
        received: present,
        missing: Array.from({ length: upload.segmentCount }, (_, i) => i).filter(
          (i) => !present.includes(i),
        ),
      };
    }),

  /**
   * Concatenates the staged segments into one blob, creates the node and
   * writes its index values — all after the bytes are safely on disk, so a
   * failed finish leaves a resumable upload rather than a half-made document.
   */
  finish: protectedProcedure
    .input(finishUploadInput)
    .mutation(async ({ ctx, input }) => {
      const upload = await prisma.upload.findUnique({ where: { id: input.uploadId } });
      if (!upload || upload.userId !== ctx.principal.userId) notFound('Upload');
      if (upload.state !== 'open') conflict(`Upload is already ${upload.state}.`);

      const cabinet = await prisma.fileCabinet.findUniqueOrThrow({
        where: { id: upload.cabinetId },
        select: { id: true, repoEncrypted: true, allowDuplicateFileNames: true },
      });

      for (let i = 0; i < upload.segmentCount; i += 1) {
        try {
          await stat(stagingPath(upload.id, i));
        } catch {
          badRequest(`Segment ${i} is missing; re-upload it before finishing.`);
        }
      }

      if (!cabinet.allowDuplicateFileNames) {
        const clash = await prisma.node.findFirst({
          where: {
            cabinetId: cabinet.id,
            parentId: upload.parentId,
            name: upload.fileName,
            inRecycleBin: false,
          },
          select: { id: true },
        });
        if (clash) conflict(`"${upload.fileName}" already exists in this folder.`);
      }

      const blobId = randomUUID();
      const stored = await writeBlob(
        cabinet.id,
        blobId,
        concatSegments(upload.id, upload.segmentCount),
        { encrypt: cabinet.repoEncrypted },
      );

      if (upload.expectedSha256 && upload.expectedSha256 !== stored.sha256) {
        await clearStaging(upload.id);
        await prisma.upload.update({
          where: { id: upload.id },
          data: { state: 'aborted' },
        });
        badRequest('Uploaded bytes do not match the declared SHA-256.');
      }

      const parent = upload.parentId
        ? await prisma.node.findUnique({
            where: { id: upload.parentId },
            select: { id: true, path: true },
          })
        : null;

      const { ext } = splitName(upload.fileName);

      const node = await prisma.$transaction(async (tx) => {
        const created = await tx.node.create({
          data: {
            blobId,
            cabinetId: cabinet.id,
            parentId: upload.parentId,
            kind: 'document',
            name: upload.fileName,
            ext,
            path: parent ? `${parent.path}${parent.id}/` : '/',
            byteLength: BigInt(stored.byteLength),
            sha256: stored.sha256,
            encryptedKey: stored.envelope?.encryptedKey ?? null,
            encryptionIv: stored.envelope?.encryptionIv ?? null,
            createdById: ctx.principal.userId,
          },
        });

        if (input.values?.length) {
          await setIndexValues(tx, cabinet.id, created.id, input.values);
        }

        await tx.upload.update({ where: { id: upload.id }, data: { state: 'complete' } });

        // Queue text extraction, as Dokmee's AutoOcr / DataExtraction
        // services picked new documents off their queues (§2).
        await tx.job.create({
          data: { kind: 'textExtraction', cabinetId: cabinet.id, nodeId: created.id },
        });

        return created;
      });

      await clearStaging(upload.id);

      await audit(ctx.principal, ctx.ip, {
        action: 'create',
        cabinetId: cabinet.id,
        nodeId: node.id,
        nodeName: node.name,
        detail: { what: 'document', bytes: stored.byteLength },
      });

      return { nodeId: node.id, byteLength: stored.byteLength, sha256: stored.sha256 };
    }),

  abort: protectedProcedure
    .input(z.object({ uploadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const upload = await prisma.upload.findUnique({ where: { id: input.uploadId } });
      if (!upload || upload.userId !== ctx.principal.userId) notFound('Upload');
      await clearStaging(upload.id);
      await prisma.upload.update({
        where: { id: upload.id },
        data: { state: 'aborted' },
      });
      return { ok: true };
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
