'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  fileUrl,
  RendererError,
  RendererLoading,
  SHEET,
  STAGE,
  type RendererProps,
} from './shared';

/**
 * A Word document.
 *
 * Mammoth maps the document's own styles onto plain HTML rather than trying to
 * reproduce Word's layout — headings stay headings, tables stay tables, and
 * nothing pretends to be page-accurate. That is the honest ceiling for reading
 * a .docx without the conversion engine this rebuild does not ship, and it is
 * enough to read and search a contract.
 *
 * The HTML is sanitised: it is built from an uploaded file.
 */
export function DocxRenderer({ nodeId, scale }: RendererProps & { scale: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);

    (async () => {
      try {
        const response = await fetch(fileUrl(nodeId), { credentials: 'include' });
        if (!response.ok) throw new Error(`The server answered ${response.status}.`);
        const arrayBuffer = await response.arrayBuffer();

        // The package's `browser` field swaps its Node-only unzip and file
        // modules for browser ones, so the main entry is the right import
        // here — and it is the one that carries types.
        const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
          import('mammoth'),
          import('dompurify'),
        ]);
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (cancelled) return;

        setHtml(DOMPurify.sanitize(result.value));
        setMessages(
          (result.messages ?? [])
            .filter((m) => m.type === 'warning' || m.type === 'error')
            .map((m) => m.message)
            .filter(Boolean)
            .slice(0, 3),
        );
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  if (error) {
    return (
      <RendererError
        title="This document could not be rendered"
        message={
          <>
            <p>{error}</p>
            <p className="text-xs">
              Only the modern .docx format can be read here; a legacy .doc is a
              different format entirely.
            </p>
          </>
        }
      />
    );
  }
  if (html === null) return <RendererLoading label="Converting document" />;

  return (
    <div className={STAGE}>
      <div
        className={cn(SHEET, 'markdown-body h-fit w-full max-w-3xl origin-top p-10')}
        style={{ fontSize: `${scale}rem` }}
      >
        {messages.length > 0 ? (
          <details className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <summary className="cursor-pointer">
              Some formatting could not be carried over
            </summary>
            <ul className="mt-1 list-disc pl-4">
              {messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
