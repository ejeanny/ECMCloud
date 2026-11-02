'use client';

import { useMemo } from 'react';

import { isCode } from '@/lib/viewer/formats';
import { cn } from '@/lib/utils';
import { RendererError, RendererLoading, SHEET, STAGE, type RendererProps } from './shared';
import { useText } from './use-text';

/**
 * Text, as text. Source gets a line-number gutter; prose does not, because a
 * gutter beside a paragraph is noise.
 */
export function TextRenderer({ nodeId, ext, scale }: RendererProps & { scale: number }) {
  const { text, truncated, error } = useText(nodeId);
  const code = isCode(ext);

  const lines = useMemo(() => (text === null ? [] : text.split('\n')), [text]);

  if (error) return <RendererError title="This file could not be read" message={error} />;
  if (text === null) return <RendererLoading label="Reading" />;

  return (
    <div className={STAGE}>
      <div
        className={cn(SHEET, 'h-fit w-full max-w-4xl origin-top p-6')}
        style={{ fontSize: `${scale}rem` }}
      >
        {truncated ? (
          <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Showing the first 4 MB of a larger file. Download it to read the rest.
          </p>
        ) : null}

        {code ? (
          <div className="flex gap-4 font-mono text-[0.8em] leading-relaxed">
            <div
              aria-hidden
              className="shrink-0 border-r border-neutral-200 pr-3 text-right text-neutral-400 select-none"
            >
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre">{text}</pre>
          </div>
        ) : (
          <pre className="font-sans text-[0.9em] leading-relaxed whitespace-pre-wrap">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
