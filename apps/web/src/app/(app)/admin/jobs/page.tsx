'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function JobsPage() {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<string[]>([]);

  const summary = trpc.job.summary.useQuery(undefined, { refetchInterval: 10_000 });
  const failed = trpc.job.failed.useQuery({ take: 100 }, { refetchInterval: 15_000 });
  const retry = trpc.job.retry.useMutation({
    onSuccess() {
      setSelected([]);
      void utils.job.failed.invalidate();
      void utils.job.summary.invalidate();
    },
  });

  if (summary.error) return <p className="error">{summary.error.message}</p>;

  const byKind = new Map<string, Record<string, number>>();
  for (const row of summary.data ?? []) {
    const current = byKind.get(row.kind) ?? {};
    current[row.state] = row.count;
    byKind.set(row.kind, current);
  }

  return (
    <>
      <h2>Services</h2>
      <p className="muted small">
        One queue stands in for the thirteen Windows services Dokmee ran. Handlers
        that need a third-party engine — OCR, Office conversion, data extraction,
        AI summarisation, RPA — are not implemented and fail with that reason.
      </p>

      <table style={{ marginBottom: 20 }}>
        <thead>
          <tr>
            <th>Queue</th>
            <th style={{ width: 100 }}>Queued</th>
            <th style={{ width: 100 }}>Running</th>
            <th style={{ width: 100 }}>Done</th>
            <th style={{ width: 100 }}>Failed</th>
          </tr>
        </thead>
        <tbody>
          {byKind.size === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                No jobs have been queued.
              </td>
            </tr>
          ) : null}
          {[...byKind].map(([kind, states]) => (
            <tr key={kind}>
              <td>{kind}</td>
              <td className="small muted">{states.queued ?? 0}</td>
              <td className="small muted">{states.running ?? 0}</td>
              <td className="small muted">{states.done ?? 0}</td>
              <td className="small">{states.failed ? <strong>{states.failed}</strong> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Failed jobs</h3>
        <span className="spacer" />
        <button
          disabled={selected.length === 0}
          onClick={() => retry.mutate({ ids: selected })}
        >
          Retry selected
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34 }} />
              <th style={{ width: 140 }}>Kind</th>
              <th style={{ width: 170 }}>Finished</th>
              <th style={{ width: 80 }}>Tries</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {(failed.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing has failed.
                </td>
              </tr>
            ) : null}
            {(failed.data ?? []).map((job) => (
              <tr key={job.id}>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={selected.includes(job.id)}
                    onChange={(e) =>
                      setSelected((c) =>
                        e.target.checked ? [...c, job.id] : c.filter((x) => x !== job.id),
                      )
                    }
                  />
                </td>
                <td className="small">{job.kind}</td>
                <td className="small muted">{formatDate(job.finishedAt)}</td>
                <td className="small muted">{job.attempts}</td>
                <td className="small muted" style={{ whiteSpace: 'normal' }}>
                  {job.lastError ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
