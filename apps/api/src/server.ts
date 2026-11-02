import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { prisma } from '@ecm/db';
import { auditAsync } from './audit.js';
import { createContext } from './context.js';
import { env } from './env.js';
import { readBlob, stagingPath } from './storage.js';
import { appRouter } from './routers/index.js';
import { startWorker } from './worker.js';

/**
 * Fastify host.
 *
 * tRPC carries the JSON API. Three things cannot travel as JSON and get plain
 * HTTP routes, exactly as Dokmee's own `WebDocViewer.ashx` and its
 * download/upload actions did (§3):
 *
 *   PUT  /upload/:uploadId/:segment   segment bytes   (UploadSegmentAsync)
 *   GET  /file/:nodeId                inline view     (ViewDocumentAsync)
 *   GET  /file/:nodeId/download       attachment      (DownloadDocumentAsync)
 */
export async function buildServer() {
  const app = Fastify({
    logger: { level: env().NODE_ENV === 'development' ? 'info' : 'warn' },
    bodyLimit: 1024 * 1024 * 64,
    routerOptions: {
      // A batched tRPC query puts every procedure name in one route parameter
      // ("node.list,node.count,cabinet.byId,…"). Fastify's default limit of 100
      // characters rejects that with 414, which the client then retries, so the
      // explorer never loads.
      maxParamLength: 5000,
    },
  });

  await app.register(cors, { origin: env().WEB_ORIGIN, credentials: true });
  await app.register(cookie);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext },
  });

  app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

  // --- upload segments --------------------------------------------------

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 64 },
    (_req, body, done) => done(null, body),
  );

  app.put<{ Params: { uploadId: string; segment: string } }>(
    '/upload/:uploadId/:segment',
    async (req, reply) => {
      const ctx = await createContext({ req, res: reply });
      if (!ctx.principal) return reply.code(401).send({ error: 'No active session.' });

      const segment = Number.parseInt(req.params.segment, 10);
      if (!Number.isInteger(segment) || segment < 0) {
        return reply.code(400).send({ error: 'Segment must be a non-negative integer.' });
      }

      const upload = await prisma.upload.findUnique({
        where: { id: req.params.uploadId },
      });
      if (!upload || upload.userId !== ctx.principal.userId) {
        return reply.code(404).send({ error: 'Upload not found.' });
      }
      if (upload.state !== 'open') {
        return reply.code(409).send({ error: `Upload is ${upload.state}.` });
      }
      if (segment >= upload.segmentCount) {
        return reply.code(400).send({ error: 'Segment index is out of range.' });
      }

      const target = stagingPath(upload.id, segment);
      await mkdir(path.dirname(target), { recursive: true });

      const body = req.body;
      if (Buffer.isBuffer(body)) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, body);
      } else {
        await pipeline(req.raw, createWriteStream(target));
      }

      await prisma.upload.update({
        where: { id: upload.id },
        data: { received: { increment: 1 } },
      });

      return reply.code(204).send();
    },
  );

  // --- document bytes ---------------------------------------------------

  async function sendFile(
    req: FastifyRequest,
    reply: FastifyReply,
    nodeId: string,
    disposition: 'inline' | 'attachment',
  ) {
    const ctx = await createContext({ req, res: reply });
    if (!ctx.principal) return reply.code(401).send({ error: 'No active session.' });

    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node || node.kind !== 'document') {
      return reply.code(404).send({ error: 'Document not found.' });
    }

    const { canInCabinet } = await import('@ecm/domain');
    const right = disposition === 'attachment' ? 'Launch_Document' : 'View_Open';
    if (!canInCabinet(ctx.principal, node.cabinetId, right)) {
      return reply.code(403).send({ error: `Missing right ${right}.` });
    }

    // A version id selects historical bytes; otherwise the node's current blob.
    const versionId = (req.query as { version?: string } | undefined)?.version;
    let source: {
      blobId: string | null;
      encryptedKey: string | null;
      encryptionIv: string | null;
      name: string;
      ext: string | null;
    } = node;

    if (versionId) {
      if (!canInCabinet(ctx.principal, node.cabinetId, 'Folders_Files_View_Versions')) {
        return reply
          .code(403)
          .send({ error: 'Missing right Folders_Files_View_Versions.' });
      }
      const version = await prisma.nodeVersion.findUnique({ where: { id: versionId } });
      if (!version || version.nodeId !== node.id) {
        return reply.code(404).send({ error: 'Version not found.' });
      }
      source = version;
    }

    if (!source.blobId) {
      return reply.code(409).send({ error: 'This item has no stored content.' });
    }

    const stream = await readBlob(
      node.cabinetId,
      source.blobId,
      source.encryptedKey && source.encryptionIv
        ? { encryptedKey: source.encryptedKey, encryptionIv: source.encryptionIv }
        : null,
    );

    auditAsync(ctx.principal, ctx.ip, {
      action: disposition === 'attachment' ? 'download' : 'view',
      cabinetId: node.cabinetId,
      nodeId: node.id,
      nodeName: node.name,
    });

    // The name is quoted and escaped; a document name is user-controlled.
    const safeName = source.name.replace(/["\\\r\n]/g, '_');
    reply
      .header('Content-Type', contentTypeFor(source.ext))
      .header(
        'Content-Disposition',
        `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(source.name)}`,
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store');

    return reply.send(stream);
  }

  app.get<{ Params: { nodeId: string } }>('/file/:nodeId', (req, reply) =>
    sendFile(req, reply, req.params.nodeId, 'inline'),
  );

  app.get<{ Params: { nodeId: string } }>('/file/:nodeId/download', (req, reply) =>
    sendFile(req, reply, req.params.nodeId, 'attachment'),
  );

  return app;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
  zip: 'application/zip',
  mp4: 'video/mp4',
};

function contentTypeFor(ext: string | null): string {
  if (!ext) return 'application/octet-stream';
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const app = await buildServer();
  const { HOST, PORT, REPOSITORY_ROOT } = env();
  await mkdir(REPOSITORY_ROOT, { recursive: true });
  await app.listen({ host: HOST, port: PORT });
  startWorker();
  app.log.info(`API on http://${HOST}:${PORT}, repository at ${REPOSITORY_ROOT}`);
}
