import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { prisma } from '@ecm/db';
import type { Annotation, JobKind, RestrictionClause, FieldType } from '@ecm/domain';
import { burnAnnotations } from './burn.js';
import { compileClauses, fieldsFor } from './index-values.js';
import { deleteBlob, readBlob, writeBlob } from './storage.js';
import { fireTriggers } from './workflow-engine.js';

/**
 * In-process job worker.
 *
 * Dokmee ran thirteen separate Windows services, each draining its own queue
 * table (§2). This is one worker over one `job` table (§6); the handlers are
 * split per kind so any of them can be moved back out to its own process
 * without changing the enqueue sites.
 *
 * Only the handlers that need no third-party engine are implemented. OCR,
 * Office conversion and AI summarisation are left as explicit stubs rather
 * than pretend implementations — Dokmee used IRIS, ISYS, Spire and Apryse for
 * these, and substituting a guess would be worse than an honest gap.
 */

type Handler = (job: {
  id: string;
  cabinetId: string | null;
  nodeId: string | null;
  payload: unknown;
}) => Promise<void>;

/**
 * Kinds that are deliberately declared without a handler, each with the reason
 * it has none. A failed job should tell whoever reads it what is actually
 * missing, rather than leaving them to guess at "not implemented".
 */
const NOT_IMPLEMENTED: Partial<Record<JobKind, string>> = {
  ocr: 'needs an OCR engine — Dokmee licensed IRIS; Tesseract is the open equivalent',
  autoIndex: 'needs the data-extraction engine it would index from',
  dataExtraction: 'needs a data-extraction engine',
  dataExport: 'needs a connector for the destination system',
  email: 'needs an SMTP or IMAP transport',
  aiSummary: 'needs a model endpoint',
  rpa: 'needs the RPA runner',
};

const handlers: Partial<Record<JobKind, Handler>> = {
  /**
   * Extracts text so full-text search has something to match. Only plain-text
   * formats are handled here; anything else needs a format engine and is
   * recorded as such rather than silently skipped.
   */
  textExtraction: async (job) => {
    if (!job.nodeId || !job.cabinetId) return;

    const node = await prisma.node.findUnique({
      where: { id: job.nodeId },
      select: {
        id: true,
        ext: true,
        cabinetId: true,
        blobId: true,
        encryptedKey: true,
        encryptionIv: true,
      },
    });
    if (!node?.blobId) return;

    const cabinet = await prisma.fileCabinet.findUnique({
      where: { id: node.cabinetId },
      select: { enableFullTextIndex: true },
    });
    if (!cabinet?.enableFullTextIndex) return;

    const textLike = new Set(['txt', 'csv', 'md', 'json', 'xml', 'html', 'htm', 'log']);
    if (!node.ext || !textLike.has(node.ext)) {
      throw new Error(
        `No text extractor for .${node.ext ?? '(none)'} — needs a format engine.`,
      );
    }

    const { readBlob } = await import('./storage.js');
    const stream = await readBlob(
      node.cabinetId,
      node.blobId,
      node.encryptedKey && node.encryptionIv
        ? { encryptedKey: node.encryptedKey, encryptionIv: node.encryptionIv }
        : null,
    );

    const chunks: Buffer[] = [];
    let total = 0;
    const LIMIT = 8 * 1024 * 1024; // a cap, so one huge file cannot exhaust the heap
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.byteLength;
      if (total > LIMIT) break;
      chunks.push(chunk);
    }

    await prisma.node.update({
      where: { id: node.id },
      data: {
        fullText: Buffer.concat(chunks).toString('utf8'),
        textExtractedAt: new Date(),
      },
    });

    await fireTriggers(node.cabinetId, node.id, 'newDocument');
  },

  /**
   * Reclaims a purged blob — but only once nothing references it. A copy
   * shares its source's blob, so deleting on the first purge would empty the
   * other document.
   */
  /**
   * Merge a document's annotations into its content and keep the result as a
   * new version.
   *
   * The pre-burn bytes become version N, exactly as a check-in's do, so burning
   * is recorded rather than destructive and `version.revert` undoes it. The
   * annotation rows are kept and stamped `burnedAt`: they are the record of
   * what was applied, and the router already refuses to edit or delete one.
   */
  burnAnnotations: async (job) => {
    if (!job.nodeId || !job.cabinetId) return;
    const requestedBy = (job.payload as { requestedBy?: { userId: string; userName: string } } | null)
      ?.requestedBy;
    // A burn writes a new version, and a version row names its author. A job
    // that cannot say who asked for a permanent change does not get to make one.
    if (!requestedBy) {
      throw new Error('This burn job records no requesting user, so it cannot be attributed.');
    }

    const node = await prisma.node.findUnique({
      where: { id: job.nodeId },
      select: {
        id: true,
        name: true,
        ext: true,
        cabinetId: true,
        blobId: true,
        byteLength: true,
        pages: true,
        sha256: true,
        encryptedKey: true,
        encryptionIv: true,
        fullText: true,
        textExtractedAt: true,
      },
    });
    if (!node?.blobId) throw new Error('This document has no stored content.');
    if (node.ext?.toLowerCase() !== 'pdf') {
      throw new Error(
        `Cannot burn into .${node.ext ?? '(none)'} — only PDF is written here, and ` +
          'converting other formats first needs the conversion engine this rebuild does not ship.',
      );
    }

    const rows = await prisma.annotation.findMany({
      where: { nodeId: node.id, burnedAt: null },
      orderBy: [{ page: 'asc' }, { created: 'asc' }],
    });
    if (rows.length === 0) return;

    const annotations: Annotation[] = rows.map((row) => ({
      name: row.name,
      kind: row.kind as Annotation['kind'],
      page: row.page,
      rect: { x1: row.x1, y1: row.y1, x2: row.x2, y2: row.y2 },
      color: row.color,
      opacity: row.opacity,
      coords: Array.isArray(row.coords) ? (row.coords as number[]) : undefined,
      gestures: Array.isArray(row.gestures) ? (row.gestures as number[][]) : undefined,
      width: row.width ?? undefined,
      contents: row.contents ?? undefined,
    }));

    const envelope =
      node.encryptedKey && node.encryptionIv
        ? { encryptedKey: node.encryptedKey, encryptionIv: node.encryptionIv }
        : null;
    const stream = await readBlob(node.cabinetId, node.blobId, envelope);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);

    const result = await burnAnnotations(Buffer.concat(chunks), annotations);
    if (result.burned.length === 0) {
      throw new Error(
        `Nothing could be drawn: ${result.skipped.map((s) => s.reason).join('; ')}`,
      );
    }

    const cabinet = await prisma.fileCabinet.findUniqueOrThrow({
      where: { id: node.cabinetId },
      select: { repoEncrypted: true },
    });

    const blobId = randomUUID();
    const stored = await writeBlob(
      node.cabinetId,
      blobId,
      Readable.from(Buffer.from(result.bytes)),
      { encrypt: cabinet.repoEncrypted },
    );

    const latest = await prisma.nodeVersion.findFirst({
      where: { nodeId: node.id },
      orderBy: [{ majorVersion: 'desc' }, { minorVersion: 'desc' }],
      select: { majorVersion: true, minorVersion: true },
    });
    const major = latest?.majorVersion ?? 1;
    const minor = (latest?.minorVersion ?? 0) + 1;

    await prisma.$transaction(async (tx) => {
      // The version row takes ownership of the blob being superseded, so the
      // un-annotated original stays reachable and the recycler leaves it alone.
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
          comment: `Before burning ${result.burned.length} annotation(s)`,
          createdById: requestedBy.userId,
        },
      });

      await tx.node.update({
        where: { id: node.id },
        data: {
          blobId,
          byteLength: BigInt(stored.byteLength),
          sha256: stored.sha256,
          encryptedKey: stored.envelope?.encryptedKey ?? null,
          encryptionIv: stored.envelope?.encryptionIv ?? null,
          fullText: null,
          textExtractedAt: null,
        },
      });

      await tx.annotation.updateMany({
        where: { nodeId: node.id, name: { in: result.burned } },
        data: { burnedAt: new Date() },
      });

      await tx.auditRecord.create({
        data: {
          action: 'update',
          userId: requestedBy.userId,
          userName: requestedBy.userName,
          cabinetId: node.cabinetId,
          nodeId: node.id,
          nodeName: node.name,
          detail: {
            what: 'burnAnnotations',
            burned: result.burned.length,
            // Named here rather than thrown: the transaction has committed, so
            // failing the job would retry a burn that already happened and add
            // a second version. What was skipped stays unburned, still visible
            // in the viewer, and a later burn can try it again.
            skipped: result.skipped,
            version: `${major}.${minor}`,
          } as never,
        },
      });
    });

    // A burned mark is part of the page now, so anything reading the text has
    // to look again.
    await prisma.job.create({
      data: { kind: 'textExtraction', cabinetId: node.cabinetId, nodeId: node.id },
    });
  },

  recycle: async (job) => {
    const payload = job.payload as { blobId?: string } | null;
    if (!job.cabinetId || !payload?.blobId) return;

    const [stillUsedByNode, stillUsedByVersion] = await Promise.all([
      prisma.node.count({ where: { blobId: payload.blobId } }),
      prisma.nodeVersion.count({ where: { blobId: payload.blobId } }),
    ]);
    if (stillUsedByNode + stillUsedByVersion > 0) return;

    await deleteBlob(job.cabinetId, payload.blobId);
  },

  /** Applies a retention job's configured action to everything expired. */
  retention: async (job) => {
    const payload = job.payload as { retentionJobId?: string } | null;
    if (!payload?.retentionJobId) return;

    const rule = await prisma.retentionJob.findUnique({
      where: { id: payload.retentionJobId },
    });
    if (!rule || !rule.isEnabled) return;

    const fields = await fieldsFor(rule.cabinetId);
    const typeById = new Map<string, FieldType>(fields.map((f) => [f.id, f.type]));
    const compiled = compileClauses(
      rule.clauses as unknown as RestrictionClause[],
      typeById,
      rule.combine === 'or' ? 'or' : 'and',
    );

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - rule.years);
    cutoff.setMonth(cutoff.getMonth() - rule.months);
    cutoff.setDate(cutoff.getDate() - rule.days);

    const where = {
      cabinetId: rule.cabinetId,
      kind: 'document',
      inRecycleBin: false,
      AND: [
        rule.retentionDateFieldId
          ? {
              indexValues: {
                some: { fieldId: rule.retentionDateFieldId, dateValue: { lte: cutoff } },
              },
            }
          : { created: { lte: cutoff } },
        ...(compiled ? [compiled] : []),
      ],
    };

    const expired = await prisma.node.findMany({
      where,
      select: { id: true, name: true, blobId: true },
      take: 5_000,
    });
    if (expired.length === 0) {
      await prisma.retentionJob.update({
        where: { id: rule.id },
        data: { lastRunAt: new Date() },
      });
      return;
    }

    const ids = expired.map((n) => n.id);

    switch (rule.expirationAction) {
      case 'recycle':
        await prisma.node.updateMany({
          where: { id: { in: ids } },
          data: { inRecycleBin: true, deletedAt: new Date() },
        });
        break;

      case 'deletePermanently': {
        const versionBlobs = await prisma.nodeVersion.findMany({
          where: { nodeId: { in: ids } },
          select: { blobId: true },
        });
        const blobIds = [
          ...new Set(
            [...expired, ...versionBlobs]
              .map((r) => r.blobId)
              .filter((b): b is string => b !== null),
          ),
        ];
        await prisma.$transaction([
          prisma.job.createMany({
            data: blobIds.map((blobId) => ({
              kind: 'recycle',
              cabinetId: rule.cabinetId,
              payload: { blobId },
            })),
          }),
          prisma.node.deleteMany({ where: { id: { in: ids } } }),
        ]);
        break;
      }

      case 'notify':
      case 'updateIndex':
      default: {
        // `notify` tells the cabinet's administrators; `updateIndex` would
        // stamp a field, which needs the field named in the rule — not
        // recovered from Dokmee's `Retention_Update_Index_Info`, so it
        // notifies rather than guessing which field to overwrite.
        const admins = await prisma.userRole.findMany({
          where: { role: { isAdministrator: true } },
          select: { userId: true },
        });
        await prisma.notification.createMany({
          data: admins.map((a) => ({
            userId: a.userId,
            type: 'retention',
            action: 'expired',
            message: `${expired.length} document(s) have reached retention under "${rule.name}".`,
            cabinetId: rule.cabinetId,
            entityId: rule.id,
          })),
        });
        break;
      }
    }

    await prisma.auditRecord.create({
      data: {
        action: rule.expirationAction === 'deletePermanently' ? 'purge' : 'delete',
        userName: 'retention',
        cabinetId: rule.cabinetId,
        detail: { what: 'retention', rule: rule.name, count: expired.length },
      },
    });

    await prisma.retentionJob.update({
      where: { id: rule.id },
      data: { lastRunAt: new Date() },
    });
  },

  /** Delivers queued notifications. Transport is out of scope; this marks them. */
  notification: async () => {
    // Notifications are already rows the UI polls; a push transport
    // (Dokmee used SignalR plus mobile tokens) would plug in here.
  },
};

const MAX_ATTEMPTS = 5;

async function runOnce(): Promise<boolean> {
  const job = await prisma.job.findFirst({
    where: { state: 'queued', runAfter: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }, { created: 'asc' }],
  });
  if (!job) return false;

  // Claim it with a conditional update, so two workers cannot take one job.
  const claimed = await prisma.job.updateMany({
    where: { id: job.id, state: 'queued' },
    data: { state: 'running', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return true;

  const handler = handlers[job.kind as JobKind];

  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        state: 'failed',
        finishedAt: new Date(),
        lastError: NOT_IMPLEMENTED[job.kind as JobKind]
          ? `Handler for "${job.kind}" is not implemented in this rebuild: ` +
            `${NOT_IMPLEMENTED[job.kind as JobKind]}.`
          : `Unknown job kind "${job.kind}".`,
      },
    });
    return true;
  }

  try {
    await handler(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { state: 'done', finishedAt: new Date(), lastError: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const giveUp = job.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.job.update({
      where: { id: job.id },
      data: giveUp
        ? { state: 'failed', finishedAt: new Date(), lastError: message }
        : {
            state: 'queued',
            lastError: message,
            // Exponential backoff, so a transient failure does not spin.
            runAfter: new Date(Date.now() + 2 ** (job.attempts + 1) * 1000),
          },
    });
  }

  return true;
}

let timer: NodeJS.Timeout | undefined;

export function startWorker(intervalMs = 2000): void {
  if (timer) return;
  let busy = false;

  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        // Drain a short burst per tick rather than one job, so a backlog
        // clears without making the interval the throughput limit.
        for (let i = 0; i < 20; i += 1) {
          if (!(await runOnce())) break;
        }
      } catch (error) {
        console.error('worker tick failed', error);
      } finally {
        busy = false;
      }
    })();
  }, intervalMs);
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
