'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { DocumentPanel } from '@/components/document-panel';
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

type Operator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty';

interface Criterion {
  fieldId: string;
  operator: Operator;
  value: string;
}

const PAGE = 50;

export default function SearchPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const columns = trpc.indexField.columns.useQuery({ cabinetId });

  const [text, setText] = useState('');
  const [fullText, setFullText] = useState(true);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<null | {
    text: string;
    fullText: boolean;
    criteria: Criterion[];
  }>(null);

  const args = submitted
    ? {
        cabinetIds: [cabinetId],
        text: submitted.text || undefined,
        fullText: submitted.fullText,
        fields: submitted.criteria
          .filter((c) => c.fieldId)
          .map((c) => ({
            fieldId: c.fieldId,
            operator: c.operator,
            value:
              c.operator === 'isEmpty' || c.operator === 'isNotEmpty'
                ? undefined
                : c.value,
          })),
        includeRecycleBin: false,
        skip: page * PAGE,
        take: PAGE,
      }
    : null;

  const results = trpc.search.documents.useQuery(args!, { enabled: args !== null });
  const total = trpc.search.count.useQuery(args!, { enabled: args !== null });
  const snippets = trpc.search.snippets.useQuery(
    {
      nodeIds: (results.data?.items ?? []).map((n) => n.id),
      text: submitted?.text ?? '',
    },
    {
      enabled:
        Boolean(submitted?.text) &&
        Boolean(submitted?.fullText) &&
        (results.data?.items.length ?? 0) > 0,
    },
  );

  const snippetById = new Map(
    (snippets.data ?? []).map((s) => [s.nodeId, s.snippet] as const),
  );

  const exportRows = trpc.search.exportRows.useQuery(args!, { enabled: false });

  async function downloadCsv() {
    const result = await exportRows.refetch();
    const rows = result.data?.rows ?? [];
    if (rows.length === 0) return;

    const headers = Object.keys(rows[0]!);
    const escape = (v: unknown) =>
      v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
    ].join('\r\n');

    const url = URL.createObjectURL(
      new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `search-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h2>Search</h2>

      <form
        className="card"
        style={{ marginBottom: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setSubmitted({ text, fullText, criteria });
        }}
      >
        <div className="field">
          <label htmlFor="q">Text</label>
          <input
            id="q"
            value={text}
            placeholder="Name, and extracted document text"
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <label className="row small" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={fullText}
            onChange={(e) => setFullText(e.target.checked)}
          />
          Search extracted document text as well as names
        </label>

        {criteria.map((c, i) => (
          <div className="row" key={i} style={{ marginBottom: 6 }}>
            <select
              value={c.fieldId}
              onChange={(e) =>
                setCriteria((list) =>
                  list.map((x, j) => (i === j ? { ...x, fieldId: e.target.value } : x)),
                )
              }
            >
              <option value="">Select a field…</option>
              {(columns.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              value={c.operator}
              onChange={(e) =>
                setCriteria((list) =>
                  list.map((x, j) =>
                    i === j ? { ...x, operator: e.target.value as Operator } : x,
                  ),
                )
              }
            >
              {(
                [
                  ['contains', 'contains'],
                  ['eq', 'equals'],
                  ['neq', 'does not equal'],
                  ['startsWith', 'starts with'],
                  ['endsWith', 'ends with'],
                  ['gt', 'greater than'],
                  ['gte', 'at least'],
                  ['lt', 'less than'],
                  ['lte', 'at most'],
                  ['isEmpty', 'is empty'],
                  ['isNotEmpty', 'is not empty'],
                ] as const
              ).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <input
              value={c.value}
              disabled={c.operator === 'isEmpty' || c.operator === 'isNotEmpty'}
              onChange={(e) =>
                setCriteria((list) =>
                  list.map((x, j) => (i === j ? { ...x, value: e.target.value } : x)),
                )
              }
            />

            <button
              type="button"
              className="danger"
              onClick={() => setCriteria((list) => list.filter((_, j) => j !== i))}
            >
              −
            </button>
          </div>
        ))}

        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() =>
              setCriteria((list) => [
                ...list,
                { fieldId: '', operator: 'contains', value: '' },
              ])
            }
          >
            Add field criterion
          </button>
          <span className="spacer" />
          <button className="primary" type="submit">
            Search
          </button>
        </div>
      </form>

      {results.error ? <p className="error">{results.error.message}</p> : null}

      {submitted ? (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="small muted">{total.data ?? 0} match(es)</span>
            <span className="spacer" />
            <button onClick={() => void downloadCsv()} disabled={!total.data}>
              Export CSV
            </button>
          </div>

          <div className="explorer" style={{ gridTemplateColumns: '1fr 340px' }}>
            <div style={{ minWidth: 0, overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ width: 90 }}>Type</th>
                    <th style={{ width: 100 }}>Size</th>
                    <th style={{ width: 170 }}>Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {results.isLoading ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        Searching…
                      </td>
                    </tr>
                  ) : null}
                  {!results.isLoading && (results.data?.items.length ?? 0) === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        No documents match.
                      </td>
                    </tr>
                  ) : null}
                  {(results.data?.items ?? []).map((node) => {
                    const snippet = snippetById.get(node.id);
                    return (
                      <tr
                        key={node.id}
                        aria-selected={selected === node.id}
                        onClick={() => setSelected(node.id)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td title={node.name} style={{ whiteSpace: 'normal' }}>
                          📄 {node.name}
                          {snippet ? (
                            <div className="small muted">{snippet}</div>
                          ) : null}
                        </td>
                        <td className="small muted">{node.ext?.toUpperCase() ?? '—'}</td>
                        <td className="small muted">{formatBytes(node.byteLength)}</td>
                        <td className="small muted">{formatDate(node.modified)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {(total.data ?? 0) > PAGE ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </button>
                  <span className="small muted">Page {page + 1}</span>
                  <button
                    disabled={(page + 1) * PAGE >= (total.data ?? 0)}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>

            {selected ? (
              <DocumentPanel nodeId={selected} onChanged={() => results.refetch()} />
            ) : (
              <aside className="card muted small">Select a result to see its detail.</aside>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
