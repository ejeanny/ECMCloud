'use client';

import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InlineError } from '@/components/states';
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
      <Button
        size="sm"
        disabled={disabled || progress !== null}
        onClick={() => input.current?.click()}
      >
        {progress ? <Loader2 className="animate-spin" /> : <Upload />}
        {progress
          ? `Uploading ${progress.name} (${progress.done}/${progress.total})`
          : 'Upload'}
      </Button>
      {error ? <InlineError message={error} className="text-xs" /> : null}
    </>
  );
}
