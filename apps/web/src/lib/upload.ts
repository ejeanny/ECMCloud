'use client';

import { useCallback, useState } from 'react';
import { SEGMENT_BYTES, segmentCountFor } from './format';
import { trpc } from './trpc';

export interface UploadProgress {
  name: string;
  done: number;
  total: number;
}

/**
 * The chunked upload, as a hook.
 *
 * `stage` runs `upload.begin` and the segment PUTs and stops there, handing
 * back the upload id — because the two things that consume an upload finish it
 * differently. A new document calls `upload.finish`; a check-in passes the id
 * to `version.checkIn`, which writes the blob as a new version instead. Both
 * need the same bytes moved the same way, so the moving lives here.
 *
 * Dokmee: UploadDocumentAsync + UploadSegmentAsync + SyncSegments.
 */
export function useChunkedUpload() {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const begin = trpc.upload.begin.useMutation();
  const abort = trpc.upload.abort.useMutation();

  const stage = useCallback(
    async (
      file: File,
      target: { cabinetId: string; parentId: string | null },
    ): Promise<string> => {
      const segmentCount = segmentCountFor(file.size);
      let uploadId: string | undefined;

      try {
        const opened = await begin.mutateAsync({
          cabinetId: target.cabinetId,
          parentId: target.parentId,
          fileName: file.name,
          byteLength: file.size,
          segmentCount,
        });
        uploadId = opened.uploadId;

        for (let i = 0; i < segmentCount; i += 1) {
          setProgress({ name: file.name, done: i, total: segmentCount });
          const slice = file.slice(i * SEGMENT_BYTES, (i + 1) * SEGMENT_BYTES);
          const response = await fetch(`/upload/${uploadId}/${i}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: slice,
          });
          if (!response.ok) {
            throw new Error(`Segment ${i + 1} failed with HTTP ${response.status}.`);
          }
        }

        setProgress({ name: file.name, done: segmentCount, total: segmentCount });
        return uploadId;
      } catch (cause) {
        // A failed upload is abandoned rather than left half-staged, so the
        // next attempt starts clean and the staging directory does not grow.
        if (uploadId) await abort.mutateAsync({ uploadId }).catch(() => undefined);
        throw cause;
      } finally {
        setProgress(null);
      }
    },
    [begin, abort],
  );

  return { stage, progress };
}
