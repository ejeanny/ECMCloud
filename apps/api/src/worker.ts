import { prisma } from '@ecm/db';
import type { JobKind, RestrictionClause, FieldType } from '@ecm/domain';
import { compileClauses, fieldsFor } from './index-values.js';
import { deleteBlob } from './storage.js';
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
  burnAnnotations:
    'needs a PDF writer that can build annotation appearance streams (PDF-VIEWER.md §7); ' +
    'the markup is exportable as XFDF in the meantime',
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
