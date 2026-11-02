'use client';

import { useMemo } from 'react';
import Papa from 'papaparse';

import { cn } from '@/lib/utils';
import { RendererError, RendererLoading, SHEET, STAGE, type RendererProps } from './shared';
import { useText } from './use-text';

const MAX_ROWS = 2000;

/**
 * Delimited data as a table.
 *
 * Papa Parse rather than `split(',')`: a quoted field containing a comma or a
 * newline is ordinary in exported data and splitting mangles it silently,
 * which is worse than not showing the file at all.
 */
export function CsvRenderer({ nodeId, ext, scale }: RendererProps & { scale: number }) {
  const { text, truncated, error } = useText(nodeId);

  const parsed = useMemo(() => {
    if (text === null) return null;
    const result = Papa.parse<string[]>(text, {
      delimiter: ext?.toLowerCase() === 'tsv' ? '\t' : '',
      skipEmptyLines: 'greedy',
    });
    return result.data;
  }, [text, ext]);

  if (error) return <RendererError title="This file could not be read" message={error} />;
  if (parsed === null) return <RendererLoading label="Reading" />;
  if (parsed.length === 0) {
    return <RendererError title="Nothing to show" message="The file has no rows." />;
  }

  const [header, ...rows] = parsed;
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div className={STAGE}>
      <div
        className={cn(SHEET, 'h-fit w-full origin-top overflow-x-auto')}
        style={{ fontSize: `${scale * 0.8}rem` }}
      >
        {truncated || rows.length > MAX_ROWS ? (
          <p className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-[0.75rem] text-amber-900">
            Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()} rows
            {truncated ? ' from the first 4 MB of a larger file' : ''}. Download it for the
            whole thing.
          </p>
        ) : null}

        <table className="w-full border-collapse">
          <thead className="sticky top-0">
            <tr>
              <th className="border-b border-neutral-300 bg-neutral-100 px-2 py-1.5 text-right font-normal text-neutral-400 tabular-nums">
                #
              </th>
              {(header ?? []).map((cell, i) => (
                <th
                  key={i}
                  className="border-b border-neutral-300 bg-neutral-100 px-2 py-1.5 text-left font-semibold whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className="even:bg-neutral-50">
                <td className="border-b border-neutral-200 px-2 py-1 text-right text-neutral-400 tabular-nums">
                  {r + 1}
                </td>
                {(header ?? []).map((_, c) => (
                  <td
                    key={c}
                    className="border-b border-neutral-200 px-2 py-1 align-top whitespace-pre-wrap"
                  >
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
