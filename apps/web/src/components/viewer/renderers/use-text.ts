'use client';

import { useEffect, useState } from 'react';
import { fileUrl } from './shared';

/** A document's bytes, decoded as UTF-8, with a ceiling. */
export function useText(nodeId: string, limitBytes = 4 * 1024 * 1024) {
  const [state, setState] = useState<{
    text: string | null;
    truncated: boolean;
    error: string | null;
  }>({ text: null, truncated: false, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ text: null, truncated: false, error: null });

    (async () => {
      try {
        const response = await fetch(fileUrl(nodeId), { credentials: 'include' });
        if (!response.ok) throw new Error(`The server answered ${response.status}.`);
        const buffer = await response.arrayBuffer();
        // A log can be hundreds of megabytes, and laying all of it out would
        // lock the tab up; the tail is cut rather than the browser.
        const truncated = buffer.byteLength > limitBytes;
        const slice = truncated ? buffer.slice(0, limitBytes) : buffer;
        const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        if (!cancelled) setState({ text, truncated, error: null });
      } catch (cause) {
        if (!cancelled) {
          setState({
            text: null,
            truncated: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodeId, limitBytes]);

  return state;
}
