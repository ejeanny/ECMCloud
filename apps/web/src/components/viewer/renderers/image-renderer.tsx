'use client';

import { useEffect, useState } from 'react';

import { fileUrl, RendererError, RendererLoading, STAGE, type RendererProps } from './shared';
import { cn } from '@/lib/utils';

interface Props extends RendererProps {
  scale: number;
  rotation: number;
}

/**
 * A picture.
 *
 * SVG does not come from `/file/:id` like the rest: the API deliberately
 * serves it as `application/octet-stream` so an uploaded file can never be
 * navigated to and run script against this origin. Here the bytes are fetched
 * and handed to an `<img>` through a blob, which renders the drawing and runs
 * none of its script — that is a property of `<img>`, not of the blob.
 */
export function ImageRenderer({ nodeId, name, ext, scale, rotation }: Props) {
  const isSvg = ext?.toLowerCase() === 'svg';
  const [src, setSrc] = useState<string | null>(isSvg ? null : fileUrl(nodeId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSvg) {
      setSrc(fileUrl(nodeId));
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(fileUrl(nodeId), { credentials: 'include' });
        if (!response.ok) throw new Error(`The server answered ${response.status}.`);
        const blob = await response.blob();
        url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }));
        if (cancelled) URL.revokeObjectURL(url);
        else setSrc(url);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [nodeId, isSvg]);

  if (error) return <RendererError title="This image could not be loaded" message={error} />;
  if (!src) return <RendererLoading label="Loading image" />;

  return (
    <div className={cn(STAGE, 'items-center')}>
      {/* Not next/image: these bytes are private, behind the session cookie,
          and the optimiser would need to fetch them itself. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        className="max-w-none origin-center object-contain transition-transform"
        style={{
          transform: `scale(${scale}) rotate(${rotation}deg)`,
          maxHeight: scale === 1 ? '100%' : undefined,
        }}
        onError={() => setError('The file is not an image this browser can decode.')}
      />
    </div>
  );
}
