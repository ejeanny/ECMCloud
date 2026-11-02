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
import {
  ConversionFailed,
  ConversionUnavailable,
  canConvertToPdf,
  officeConversionAvailable,
  officeToPdf,
  openConversion,
} from './convert.js';
import { createContext } from './context.js';
import { env } from './env.js';
import { readBlob, stagingPath } from './storage.js';
import { isVisible } from './visibility.js';
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

  /**
   * Everything that must be true before any of a document's bytes leave: a
   * session, a document, the right, the row-level restriction, and which blob
   * is being asked for.
   *
   * Pulled out of `sendFile` when a second route began serving the same
   * content in another form. Two copies of a permission check is how one of
   * them comes to be missing a clause, and the converted-PDF route reaches
   * exactly the same bytes as the original.
   *
   * Returns null once it has answered, so each caller is one `if` from safe.
   */
  async function resolveDocument(
    req: FastifyRequest,
    reply: FastifyReply,
    nodeId: string,
    right: 'View_Open' | 'Launch_Document',
  ) {
    const ctx = await createContext({ req, res: reply });
    if (!ctx.principal) {
      reply.code(401).send({ error: 'No active session.' });
      return null;
    }

    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node || node.kind !== 'document') {
      reply.code(404).send({ error: 'Document not found.' });
      return null;
    }

    const { canInCabinet } = await import('@ecm/domain');
    if (!canInCabinet(ctx.principal, node.cabinetId, right)) {
      reply.code(403).send({ error: `Missing right ${right}.` });
      return null;
    }

    // The row-level restriction. Serving the bytes of a document the grid
    // hides would make the whole restriction decorative; 404, not 403, so the
    // response does not confirm the document exists.
    if (!(await isVisible(ctx.principal, node))) {
      reply.code(404).send({ error: 'Document not found.' });
      return null;
    }

    // A version id selects historical bytes; otherwise the node's current blob.
    const versionId = (req.query as { version?: string } | undefined)?.version;
    let source: {
      blobId: string | null;
      encryptedKey: string | null;
      encryptionIv: string | null;
      name: string;
      ext: string | null;
      sha256: string | null;
    } = node;

    if (versionId) {
      if (!canInCabinet(ctx.principal, node.cabinetId, 'Folders_Files_View_Versions')) {
        reply.code(403).send({ error: 'Missing right Folders_Files_View_Versions.' });
        return null;
      }
      const version = await prisma.nodeVersion.findUnique({ where: { id: versionId } });
      if (!version || version.nodeId !== node.id) {
        reply.code(404).send({ error: 'Version not found.' });
        return null;
      }
      source = version;
    }

    if (!source.blobId) {
      reply.code(409).send({ error: 'This item has no stored content.' });
      return null;
    }

    return { ctx, node, source, blobId: source.blobId };
  }

  async function sendFile(
    req: FastifyRequest,
    reply: FastifyReply,
    nodeId: string,
    disposition: 'inline' | 'attachment',
  ) {
    const resolved = await resolveDocument(
      req,
      reply,
      nodeId,
      disposition === 'attachment' ? 'Launch_Document' : 'View_Open',
    );
    if (!resolved) return reply;
    // `blobId` comes back separately because the check that it is present
    // happened in `resolveDocument`, and the source's own field stays nullable.
    const { ctx, node, source, blobId } = resolved;

    const stream = await readBlob(
      node.cabinetId,
      blobId,
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

  /**
   * The same document, as a PDF.
   *
   * What Apryse's `loadAsPDF` does for Office formats (PDF-VIEWER.md §8.4):
   * the viewer asks for a PDF and gets one, and everything it can do with a
   * PDF — annotations, search, thumbnails — then applies to a Word document.
   *
   * It needs `View_Open`, the same right as viewing the original, because that
   * is what this is. A converted rendition is not a second document with
   * permissions of its own.
   */
  app.get<{ Params: { nodeId: string } }>('/file/:nodeId/pdf', async (req, reply) => {
    const resolved = await resolveDocument(req, reply, req.params.nodeId, 'View_Open');
    if (!resolved) return reply;
    const { ctx, node, source, blobId } = resolved;

    const ext = (source.ext ?? '').toLowerCase();
    // Already a PDF: there is nothing to convert, and refusing would make the
    // viewer special-case which URL to ask for.
    if (ext === 'pdf') return sendFile(req, reply, req.params.nodeId, 'inline');

    if (!canConvertToPdf(ext)) {
      return reply.code(501).send({
        error: officeConversionAvailable()
          ? `.${ext || '(none)'} is not a format this server converts to PDF.`
          : 'This server has no document converter configured.',
      });
    }

    try {
      const stored = await readBlob(
        node.cabinetId,
        blobId,
        source.encryptedKey && source.encryptionIv
          ? { encryptedKey: source.encryptedKey, encryptionIv: source.encryptionIv }
          : null,
      );
      const { path: at, cached } = await officeToPdf(stored, ext, source.sha256);

      // Viewing is viewing, however the bytes were produced — and a converted
      // view is still a view of the original document.
      auditAsync(ctx.principal, ctx.ip, {
        action: 'view',
        cabinetId: node.cabinetId,
        nodeId: node.id,
        nodeName: node.name,
      });

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header('X-Conversion', cached ? 'cached' : 'converted')
        .send(openConversion(at));
    } catch (cause) {
      if (cause instanceof ConversionUnavailable) {
        req.log.error({ cause }, 'office conversion unavailable');
        return reply.code(501).send({ error: cause.message });
      }
      if (cause instanceof ConversionFailed) {
        // The document's problem, not the server's: 422 so the viewer can say
        // so rather than reporting an outage.
        req.log.warn({ cause, nodeId: node.id }, 'office conversion failed');
        return reply.code(422).send({ error: cause.message });
      }
      throw cause;
    }
  });

  return app;
}

/**
 * `X-Content-Type-Options: nosniff` is set on every response, so a type that is
 * missing here is served as `application/octet-stream` and the browser refuses
 * to render it — which is why the viewer's image and media formats have to be
 * listed.
 *
 * Two deliberate omissions. HTML and SVG can both carry script, and serving
 * them as `text/html` or `image/svg+xml` from this origin would let an
 * uploaded file run script against the session cookie by being navigated to
 * directly. They stay `application/octet-stream` here; the viewer renders them
 * from bytes it has fetched, sandboxed, where no such origin exists.
 */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',

  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/vnd.microsoft.icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',

  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',

  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',

  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
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
