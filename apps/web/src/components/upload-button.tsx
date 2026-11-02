'use client';

import { useRef, useState } from 'react';
import { SEGMENT_BYTES, segmentCountFor } from '@/lib/format';
import { trpc } from '@/lib/trpc';

interface Props {
  cabinetId: string;
  parentId: string | null;
  onUploaded: () => void;
  disabled?: boolean;
}

/**
 * Chunked upload, matching the API's begin / segment / finish contract
 * (Dokmee: UploadDocumentAsync + UploadSegmentAsync + SyncSegments). Segment
 * bytes go over plain HTTP; only the envelope is tRPC.
 */
export function UploadButton({ cabinetId, parentId, onUploaded, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ name: string; done: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const begin = trpc.upload.begin.useMutation();
  const finish = trpc.upload.finish.useMutation();
  const abort = trpc.upload.abort.useMutation();

  async function send(files: FileList): Promise<void> {
    setError(null);

    for (const file of Array.from(files)) {
      const segmentCount = segmentCountFor(file.size);
      let uploadId: string | undefined;

      try {
        const opened = await begin.mutateAsync({
          cabinetId,
          parentId,
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
            throw new Error(`Segment ${i} failed with HTTP ${response.status}.`);
          }
        }

        setProgress({ name: file.name, done: segmentCount, total: segmentCount });
        await finish.mutateAsync({ uploadId });
      } catch (cause) {
        // A failed upload is abandoned rather than left half-staged.
        if (uploadId) {
          await abort.mutateAsync({ uploadId }).catch(() => undefined);
        }
        setError(
          `${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        break;
      }
    }

    setProgress(null);
    if (input.current) input.current.value = '';
    onUploaded();
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void send(e.target.files);
        }}
      />
      <button
        className="primary"
        disabled={disabled || progress !== null}
        onClick={() => input.current?.click()}
      >
        {progress
          ? `Uploading ${progress.name} (${progress.done}/${progress.total})`
          : 'Upload'}
      </button>
      {error ? (
        <span className="error small" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
