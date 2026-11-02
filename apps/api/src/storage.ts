import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from './env.js';

/**
 * Blob repository.
 *
 * Mirrors Dokmee's layout: one directory per cabinet under a repository root
 * (`PrimaryRepo` pointed at `C:\Dokmee ECM Repository\<cabinetGuid>`), the
 * database holding only metadata plus a per-file encryption envelope
 * (`Dms_FsNodes.CryptoKey` / `CryptoVector`). The files are fanned out two
 * levels by the blob id so no directory holds millions of entries.
 */

export interface Envelope {
  /** Per-file key, encrypted with the repository master key, base64. */
  readonly encryptedKey: string;
  /** AES-GCM IV, base64. */
  readonly encryptionIv: string;
}

export interface StoredBlob {
  readonly blobId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly envelope: Envelope | null;
}

function masterKey(): Buffer {
  const raw = env().REPOSITORY_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'REPOSITORY_MASTER_KEY is required for an encrypted cabinet. Generate 32 random bytes, base64-encoded.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error('REPOSITORY_MASTER_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

function wrapKey(fileKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const wrapped = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), wrapped]).toString('base64');
}

function unwrapKey(encoded: string): Buffer {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

/** `<root>/<cabinetId>/<aa>/<bb>/<blobId>` */
export function blobPath(cabinetId: string, blobId: string): string {
  return path.join(
    env().REPOSITORY_ROOT,
    cabinetId,
    blobId.slice(0, 2),
    blobId.slice(2, 4),
    blobId,
  );
}

export function stagingPath(uploadId: string, segment: number): string {
  return path.join(
    env().REPOSITORY_ROOT,
    '.staging',
    uploadId,
    String(segment).padStart(8, '0'),
  );
}

export async function writeBlob(
  cabinetId: string,
  blobId: string,
  source: Readable,
  options: { encrypt: boolean },
): Promise<StoredBlob> {
  const target = blobPath(cabinetId, blobId);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.partial`;

  const hash = createHash('sha256');
  let byteLength = 0;

  // Hash and count the plaintext as it streams through, then (optionally)
  // encrypt. The digest is of the plaintext, so it survives re-keying.
  async function* measured(): AsyncGenerator<Buffer> {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
      yield chunk;
    }
  }

  let envelope: Envelope | null = null;
  if (options.encrypt) {
    const fileKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', fileKey, iv);
    await pipeline(measured(), cipher, createWriteStream(temp));
    // The GCM tag is appended, so the file is self-verifying on read.
    await appendFile(temp, cipher.getAuthTag());
    envelope = { encryptedKey: wrapKey(fileKey), encryptionIv: iv.toString('base64') };
  } else {
    await pipeline(measured(), createWriteStream(temp));
  }

  await rename(temp, target);

  return { blobId, byteLength, sha256: hash.digest('hex'), envelope };
}

export async function readBlob(
  cabinetId: string,
  blobId: string,
  envelope: Envelope | null,
): Promise<Readable> {
  const file = blobPath(cabinetId, blobId);
  if (!envelope) return createReadStream(file);

  const { size } = await stat(file);
  const tagStart = size - 16;
  if (tagStart <= 0) {
    throw new Error(`Encrypted blob ${blobId} is too short to carry an auth tag.`);
  }

  const handle = await open(file, 'r');
  let tag: Buffer;
  try {
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, tagStart);
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    unwrapKey(envelope.encryptedKey),
    Buffer.from(envelope.encryptionIv, 'base64'),
  );
  decipher.setAuthTag(tag);

  // The tag is excluded from the ciphertext range; decipher.final() throws if
  // it does not verify, which surfaces as a stream error to the caller.
  return createReadStream(file, { start: 0, end: tagStart - 1 }).pipe(decipher);
}

export async function deleteBlob(cabinetId: string, blobId: string): Promise<void> {
  await rm(blobPath(cabinetId, blobId), { force: true });
}

export async function clearStaging(uploadId: string): Promise<void> {
  await rm(path.join(env().REPOSITORY_ROOT, '.staging', uploadId), {
    recursive: true,
    force: true,
  });
}

/** Extension, lower-cased, without the dot — Dokmee stores `Ext` separately. */
export function splitName(fileName: string): { name: string; ext: string | null } {
  const ext = path.extname(fileName);
  if (!ext) return { name: fileName, ext: null };
  return { name: fileName, ext: ext.slice(1).toLowerCase() };
}
