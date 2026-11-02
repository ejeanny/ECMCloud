import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsServerPdf } from '@ecm/domain';
import { env } from './env.js';

/**
 * Office documents to PDF, so the viewer can open them.
 *
 * This is the half of Apryse's `loadAsPDF` (PDF-VIEWER.md §8.4) that cannot
 * run in the browser. An image becomes a PDF page with arithmetic; a Word
 * document becomes one only by being laid out — hyphenation, fonts, tables,
 * page breaks — and a layout engine is the thing you buy or install, not the
 * thing you write. Dokmee bought two: Spire server-side, Apryse's own office
 * worker client-side.
 *
 * The open equivalent is LibreOffice in headless mode, and this module is a
 * thin, careful wrapper around it:
 *
 *   OFFICE_CONVERT_COMMAND=C:\Program Files\LibreOffice\program\soffice.exe
 *
 * Unset, the feature is simply absent: the viewer asks the API what it can do
 * and keeps today's behaviour for formats it says no to. Nothing here pretends
 * to convert.
 *
 * ## It is running a converter on untrusted input
 *
 * Every byte handed to it came from an upload. LibreOffice is a large C++
 * codebase with a long history of parser vulnerabilities, and documents can
 * carry macros and remote references. What this module does about that:
 *
 * - a throwaway user profile per conversion, so nothing persists between runs
 *   and two conversions cannot collide over one profile directory;
 * - the document is passed as a file in a private temporary directory, never
 *   as a URL, and the output is read from that same directory;
 * - a hard timeout with a kill, because a malformed document that makes the
 *   converter spin is the common failure, not the exotic one.
 *
 * What it does *not* do, and what you should add before this faces the public
 * internet: run the converter as an unprivileged user in a container or jail,
 * with no network. That is a deployment decision, so it is named here rather
 * than half-done in code.
 */

/** Conversions are slow; a spreadsheet of any size is seconds, not milliseconds. */
const TIMEOUT_MS = 120_000;

export interface Conversion {
  /** Where the PDF is on disk. The caller streams it and leaves it alone. */
  path: string;
  /** True when this came back from the cache rather than the converter. */
  cached: boolean;
}

/** Is a converter configured at all? The viewer asks before routing to it. */
export function officeConversionAvailable(): boolean {
  return Boolean(env().OFFICE_CONVERT_COMMAND);
}

/** Will this server convert that format, given what is configured? */
export function canConvertToPdf(ext: string | null | undefined): boolean {
  return officeConversionAvailable() && needsServerPdf(ext);
}

function cacheRoot(): string {
  return env().RENDITION_CACHE_DIR ?? path.join(os.tmpdir(), 'ecm-renditions');
}

/**
 * Convert, or return the conversion made earlier.
 *
 * Keyed by the content hash, not the document id: a version restored to its
 * earlier bytes is the same document to convert, and two identical uploads in
 * different cabinets convert once. The cache holds derived bytes only — every
 * entry can be deleted at any time and the next request rebuilds it, which is
 * why it defaults to the temp directory rather than the repository.
 *
 * Dokmee cached the same thing in `App_Data`, keyed per file [observed:
 * `ViewerHelperUtil`].
 */
export async function officeToPdf(
  source: NodeJS.ReadableStream,
  ext: string,
  sha256: string | null,
): Promise<Conversion> {
  const command = env().OFFICE_CONVERT_COMMAND;
  if (!command) {
    throw new ConversionUnavailable(
      'No document converter is configured on this server (OFFICE_CONVERT_COMMAND).',
    );
  }
  if (!needsServerPdf(ext)) {
    throw new ConversionFailed(`.${ext} is not a format this server converts.`);
  }

  const bytes = await collect(source);
  // The node's recorded hash is the content of the *stored* file, which is
  // what we are converting — but a version or a missing hash falls back to
  // hashing what we just read, so the key is always the bytes in hand.
  const key = sha256 ?? createHash('sha256').update(bytes).digest('hex');

  const root = cacheRoot();
  const cached = path.join(root, `${key}.pdf`);
  if (await exists(cached)) return { path: cached, cached: true };

  const work = await mkdtemp(path.join(os.tmpdir(), 'ecm-convert-'));
  try {
    // LibreOffice names the output after the input, so the input needs an
    // extension it recognises and a name we can predict.
    const input = path.join(work, `in.${ext.toLowerCase()}`);
    await writeFile(input, bytes);

    await run(command, [
      ...(env().OFFICE_CONVERT_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      '--headless',
      '--norestore',
      '--invisible',
      '--nolockcheck',
      '--nodefault',
      // A profile of its own, inside the work directory that is deleted below.
      // Without it, concurrent conversions fight over one profile and the
      // second silently exits having converted nothing.
      `-env:UserInstallation=${fileUrl(path.join(work, 'profile'))}`,
      '--convert-to',
      'pdf',
      '--outdir',
      work,
      input,
    ]);

    // Trust the directory, not the name: the converter has been known to pick
    // its own output name, and there is exactly one PDF in here.
    const produced = (await readdir(work)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!produced) {
      throw new ConversionFailed(
        'The converter produced no PDF. The document may be malformed, password-protected or of an unsupported kind.',
      );
    }

    await mkdir(root, { recursive: true });
    // Written beside the target and renamed, so a reader never opens a file
    // that is still being written.
    const pending = path.join(root, `${key}.${process.pid}.partial`);
    await writeFile(pending, await readFile(path.join(work, produced)));
    await rename(pending, cached);
    return { path: cached, cached: false };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export function openConversion(at: string): NodeJS.ReadableStream {
  return createReadStream(at);
}

/** No converter configured — a 501, not a failure of this document. */
export class ConversionUnavailable extends Error {}
/** This document could not be converted. */
export class ConversionFailed extends Error {}

/**
 * Why the converter would not start, said in a way that names the fix.
 *
 * Node reports both "it is not there" and "it is a batch file" as an errno and
 * nothing else, and the second is the one people meet: wrapping `soffice` in a
 * `.cmd` is the obvious thing to do on Windows, and Node refuses to spawn one
 * without a shell. `EINVAL` on its own sends you looking at the document.
 */
function cannotStart(command: string, cause: NodeJS.ErrnoException): ConversionUnavailable {
  const hint =
    cause.code === 'EINVAL' && /\.(cmd|bat)$/i.test(command)
      ? ` — a ${path.extname(command)} file cannot be run directly. Set OFFICE_CONVERT_COMMAND to the interpreter and OFFICE_CONVERT_ARGS to the script.`
      : '';
  return new ConversionUnavailable(
    `The converter could not be started: ${cause.message}${hint}`,
  );
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
      // No shell: the command is configuration and the arguments contain paths
      // this process built, but a shell would still be one quoting bug away
      // from running something else.
      shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      // Not every refusal arrives as an `error` event: spawning a batch file
      // throws from the call itself, and an uncaught one reaches the caller as
      // a bare `Error: spawn EINVAL`.
      return reject(cannotStart(command, cause as NodeJS.ErrnoException));
    }

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      // Bounded: a converter that complains once per cell of a spreadsheet
      // should not be able to grow this without limit.
      if (stderr.length < 8192) stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ConversionFailed(`The converter did not finish within ${TIMEOUT_MS / 1000}s.`));
    }, TIMEOUT_MS);

    child.on('error', (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(cannotStart(command, cause));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        new ConversionFailed(
          `The converter exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '.'}`,
        ),
      );
    });
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function exists(at: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(at)).size > 0;
  } catch {
    return false;
  }
}

async function rename(from: string, to: string): Promise<void> {
  const { rename: move } = await import('node:fs/promises');
  try {
    await move(from, to);
  } catch {
    // Another request converted the same bytes first; its result is as good as
    // ours, so drop ours rather than failing the response.
    await rm(from, { force: true }).catch(() => {});
  }
}

/** `-env:UserInstallation` takes a URL, and Windows paths are not one. */
function fileUrl(at: string): string {
  const slashes = path.resolve(at).replace(/\\/g, '/');
  return `file:///${slashes.replace(/^\//, '')}`;
}
