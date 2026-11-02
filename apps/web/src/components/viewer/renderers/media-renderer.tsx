'use client';

import { fileUrl, type RendererProps } from './shared';

/**
 * Audio and video, played by the browser itself. The API streams the bytes and
 * honours range requests, so seeking in a long recording does not download it.
 */
export function MediaRenderer({ nodeId, name, kind }: RendererProps & { kind: 'audio' | 'video' }) {
  if (kind === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-3">
          <p className="truncate text-center text-sm font-medium" title={name}>
            {name}
          </p>
          <audio controls preload="metadata" className="w-full" src={fileUrl(nodeId)}>
            Your browser cannot play this audio.
          </audio>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-900 p-4">
      <video
        controls
        preload="metadata"
        className="max-h-full max-w-full"
        src={fileUrl(nodeId)}
      >
        Your browser cannot play this video.
      </video>
    </div>
  );
}
