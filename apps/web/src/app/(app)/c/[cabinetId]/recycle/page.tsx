'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function RecyclePage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const [selected, setSelected] = useState<string[]>([]);
  const utils = trpc.useUtils();

  const cabinet = trpc.cabinet.byId.useQuery({ cabinetId });
  const bin = trpc.recycle.list.useQuery({ cabinetId, skip: 0, take: 200 });
  const size = trpc.recycle.size.useQuery({ cabinetId });

  function refresh() {
    setSelected([]);
    void utils.recycle.list.invalidate();
    void utils.recycle.size.invalidate();
    void utils.node.list.invalidate();
  }

  const restore = trpc.recycle.restore.useMutation({ onSuccess: refresh });
  const purge = trpc.recycle.purge.useMutation({ onSuccess: refresh });
  const empty = trpc.recycle.empty.useMutation({ onSuccess: refresh });

  const items = bin.data?.items ?? [];

  return (
    <>
      <h2>Recycle bin — {cabinet.data?.name ?? ''}</h2>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button
          disabled={selected.length === 0}
          onClick={() => restore.mutate({ cabinetId, nodeIds: selected })}
        >
          Restore
        </button>
        <button
          className="danger"
          disabled={selected.length === 0}
          onClick={() => {
            if (
              window.confirm(
                `Permanently delete ${selected.length} item(s)? This cannot be undone.`,
              )
            ) {
              purge.mutate({ cabinetId, nodeIds: selected });
            }
          }}
        >
          Delete permanently
        </button>
        <span className="spacer" />
        <span className="small muted">
          {size.data?.count ?? 0} item(s), {formatBytes(size.data?.bytes ?? 0)}
        </span>
        <button
          className="danger"
          disabled={!size.data?.count}
          onClick={() => {
            const name = cabinet.data?.name;
            if (!name) return;
            const typed = window.prompt(
              `Empty the recycle bin permanently? Type the cabinet name "${name}" to confirm.`,
            );
            if (typed === name) empty.mutate({ cabinetId, confirmName: typed });
          }}
        >
          Empty bin
        </button>
      </div>

      {restore.error ? <p className="error">{restore.error.message}</p> : null}
      {purge.error ? <p className="error">{purge.error.message}</p> : null}
      {empty.error ? <p className="error">{empty.error.message}</p> : null}
      {bin.error ? <p className="error">{bin.error.message}</p> : null}

      <table>
        <thead>
          <tr>
            <th style={{ width: 34 }} />
            <th>Name</th>
            <th style={{ width: 90 }}>Type</th>
            <th style={{ width: 100 }}>Size</th>
            <th style={{ width: 170 }}>Deleted</th>
          </tr>
        </thead>
        <tbody>
          {bin.isLoading ? (
            <tr>
              <td colSpan={5} className="muted">
                Loading…
              </td>
            </tr>
          ) : null}
          {!bin.isLoading && items.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                The recycle bin is empty.
              </td>
            </tr>
          ) : null}
          {items.map((node) => (
            <tr key={node.id} aria-selected={selected.includes(node.id)}>
              <td>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={selected.includes(node.id)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, node.id]
                        : current.filter((x) => x !== node.id),
                    )
                  }
                />
              </td>
              <td title={node.name}>
                {node.kind === 'folder' ? '📁 ' : '📄 '}
                {node.name}
              </td>
              <td className="small muted">
                {node.kind === 'folder' ? 'Folder' : (node.ext?.toUpperCase() ?? '—')}
              </td>
              <td className="small muted">
                {node.kind === 'folder' ? '—' : formatBytes(node.byteLength)}
              </td>
              <td className="small muted">{formatDate(node.deletedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
