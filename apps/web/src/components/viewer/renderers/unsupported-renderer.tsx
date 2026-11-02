'use client';

import { Download, FileQuestion } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FORMAT_NOTES } from '@/lib/viewer/formats';
import { formatBytes } from '@/lib/format';
import type { RendererProps } from './shared';

/**
 * A format with no in-browser renderer.
 *
 * It says what the file is and hands over the bytes, rather than showing an
 * error: there is nothing wrong, the application simply cannot draw this one.
 */
export function UnsupportedRenderer({ nodeId, name, ext, byteLength }: RendererProps) {
  const note = FORMAT_NOTES[(ext ?? '').toLowerCase()];

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm space-y-4 text-center">
        <div className="bg-muted text-muted-foreground mx-auto grid size-12 place-items-center rounded-full">
          <FileQuestion className="size-6" />
        </div>
        <div className="space-y-1">
          <p className="font-medium break-words">{name}</p>
          <p className="text-muted-foreground text-sm">
            {note ?? (ext ? `${ext.toUpperCase()} file` : 'Unknown format')}
            {byteLength !== null ? ` · ${formatBytes(byteLength)}` : ''}
          </p>
        </div>
        <p className="text-muted-foreground text-sm">
          There is no preview for this format. Download it to open it in the
          application it belongs to.
        </p>
        <Button asChild>
          <a href={`/file/${nodeId}/download`}>
            <Download />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}
