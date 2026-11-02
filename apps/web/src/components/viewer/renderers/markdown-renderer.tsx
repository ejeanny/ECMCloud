'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { RendererError, RendererLoading, SHEET, STAGE, type RendererProps } from './shared';
import { useText } from './use-text';

/**
 * Markdown, rendered.
 *
 * The HTML that comes out is built from an uploaded file, so it goes through
 * DOMPurify before it reaches the DOM — Markdown permits inline HTML, which
 * means a document can carry a script tag or an `onerror` attribute, and
 * `dangerouslySetInnerHTML` would run it on this origin.
 */
export function MarkdownRenderer({ nodeId, scale }: RendererProps & { scale: number }) {
  const { text, truncated, error } = useText(nodeId);
  const [html, setHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ marked }, { default: DOMPurify }] = await Promise.all([
          import('marked'),
          import('dompurify'),
        ]);
        const raw = await marked.parse(text, { async: true, gfm: true, breaks: false });
        if (!cancelled) setHtml(DOMPurify.sanitize(raw));
      } catch (cause) {
        if (!cancelled) {
          setRenderError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (error ?? renderError) {
    return <RendererError title="This document could not be rendered" message={error ?? renderError} />;
  }
  if (html === null) return <RendererLoading label="Rendering" />;

  return (
    <div className={STAGE}>
      <div
        className={cn(SHEET, 'markdown-body h-fit w-full max-w-3xl origin-top p-8')}
        style={{ fontSize: `${scale}rem` }}
      >
        {truncated ? (
          <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Showing the first 4 MB of a larger file.
          </p>
        ) : null}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
