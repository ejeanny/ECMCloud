'use client';

import { useRef, useState } from 'react';
import { useChunkedUpload } from '@/lib/upload';
import { trpc } from '@/lib/trpc';

interface Props {
  cabinetId: string;
  parentId: string | null;
  onUploaded: () => void;
  disabled?: boolean;
}

/**
 * Add new documents. The bytes move through `useChunkedUpload`, which the
 * drag-and-drop on the file list and the check-in dialog share; this one
 * finishes the upload, which is what turns it into a new document.
 */
export function UploadButton({ cabinetId, parentId, onUploaded, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { stage, progress } = useChunkedUpload();
  const finish = trpc.upload.finish.useMutation();

  async function send(files: FileList): Promise<void> {
    setError(null);

    for (const file of Array.from(files)) {
      try {
        const uploadId = await stage(file, { cabinetId, parentId });
        await finish.mutateAsync({ uploadId });
      } catch (cause) {
        setError(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        break;
      }
    }

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
