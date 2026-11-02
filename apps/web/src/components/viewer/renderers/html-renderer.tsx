'use client';

import { useEffect, useState } from 'react';

import { RendererError, RendererLoading, type RendererProps } from './shared';
import { useText } from './use-text';

/**
 * An uploaded HTML page.
 *
 * The API serves `.html` as `application/octet-stream` on purpose, so the file
 * can never be navigated to and run script against this origin and its session
 * cookie. Here the source is put into an iframe with a `sandbox` attribute and
 * nothing allowed: no scripts, no forms, and — because `allow-same-origin` is
 * absent — a unique opaque origin, so even if something did run it would have
 * nothing of ours to reach.
 */
export function HtmlRenderer({ nodeId, name }: RendererProps) {
  const { text, error } = useText(nodeId);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  useEffect(() => {
    if (text === null) return;
    setSrcDoc(text);
  }, [text]);

  if (error) return <RendererError title="This page could not be read" message={error} />;
  if (srcDoc === null) return <RendererLoading label="Loading page" />;

  return (
    <div className="h-full w-full bg-white">
      <iframe
        title={name}
        sandbox=""
        srcDoc={srcDoc}
        className="h-full w-full border-0"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
