'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { DocumentPanel } from '@/components/document-panel';
import { FolderTree } from '@/components/folder-tree';
import { UploadButton } from '@/components/upload-button';
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

const PAGE = 50;

export default function ExplorerPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState('modified');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const utils = trpc.useUtils();
  const cabinet = trpc.cabinet.byId.useQuery({ cabinetId });
  const columns = trpc.indexField.columns.useQuery({ cabinetId });

  const listArgs = {
    cabinetId,
    parentId: folderId,
    inRecycleBin: false,
    skip: page * PAGE,
    take: PAGE,
    sort: { by: sortBy, dir: sortDir },
  };

  const nodes = trpc.node.list.useQuery(listArgs);
  const total = trpc.node.count.useQuery(listArgs);

  const createFolder = trpc.node.createFolder.useMutation({ onSuccess: refresh });
  const recycle = trpc.node.sendToRecycleBin.useMutation({
    onSuccess() {
      setSelected([]);
      refresh();
    },
  });
  const addFavorites = trpc.workspace.addFavorites.useMutation();
  const move = trpc.node.move.useMutation({
    onSuccess() {
      setSelected([]);
      refresh();
    },
  });

  function refresh() {
    void utils.node.list.invalidate();
    void utils.node.count.invalidate();
    void utils.node.folders.invalidate();
  }

  const items = nodes.data?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((total.data ?? 0) / PAGE));
  const readOnly = cabinet.data?.status !== 'active';

  function toggle(id: string, shiftKey: boolean) {
    setSelected((current) => {
      if (shiftKey) {
        return current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id];
      }
      return current.length === 1 && current[0] === id ? [] : [id];
    });
  }

  function sort(by: string) {
    if (sortBy === by) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(by);
      setSortDir('asc');
    }
    setPage(0);
  }

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{cabinet.data?.name ?? 'Cabinet'}</h2>
        <span className="spacer" />
        <Link className="pill" href={`/c/${cabinetId}/search`}>
          Search
        </Link>
        <Link className="pill" href={`/c/${cabinetId}/recycle`}>
          Recycle bin
        </Link>
        <Link className="pill" href={`/c/${cabinetId}/fields`}>
          Index fields
        </Link>
        <Link className="pill" href={`/c/${cabinetId}/workflows`}>
          Workflows
        </Link>
      </div>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <UploadButton
          cabinetId={cabinetId}
          parentId={folderId}
          onUploaded={refresh}
          disabled={readOnly}
        />
        <button
          disabled={readOnly}
          onClick={() => {
            const name = window.prompt('Folder name');
            if (name?.trim()) {
              createFolder.mutate({ cabinetId, parentId: folderId, name: name.trim() });
            }
          }}
        >
          New folder
        </button>
        <button
          disabled={selected.length === 0}
          onClick={() => addFavorites.mutate({ nodeIds: selected })}
        >
          Add to favourites
        </button>
        <button
          disabled={selected.length === 0 || readOnly}
          onClick={() => move.mutate({ nodeIds: selected, targetParentId: folderId })}
        >
          Move here
        </button>
        <button
          className="danger"
          disabled={selected.length === 0 || readOnly}
          onClick={() => {
            if (window.confirm(`Send ${selected.length} item(s) to the recycle bin?`)) {
              recycle.mutate({ nodeIds: selected });
            }
          }}
        >
          Delete
        </button>
        <span className="spacer" />
        <span className="small muted">
          {total.data ?? 0} item(s){selected.length ? ` · ${selected.length} selected` : ''}
        </span>
      </div>

      {recycle.error ? <p className="error">{recycle.error.message}</p> : null}
      {move.error ? <p className="error">{move.error.message}</p> : null}
      {createFolder.error ? <p className="error">{createFolder.error.message}</p> : null}

      <div className="explorer">
        <FolderTree
          cabinetId={cabinetId}
          selectedId={folderId}
          onSelect={(id) => {
            setFolderId(id);
            setSelected([]);
            setPage(0);
          }}
        />

        <div style={{ minWidth: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>
                    <button className="small" onClick={() => sort('name')}>
                      Name {sortBy === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th style={{ width: 90 }}>
                    <button className="small" onClick={() => sort('ext')}>
                      Type
                    </button>
                  </th>
                  <th style={{ width: 100 }}>
                    <button className="small" onClick={() => sort('size')}>
                      Size
                    </button>
                  </th>
                  <th style={{ width: 170 }}>
                    <button className="small" onClick={() => sort('modified')}>
                      Modified {sortBy === 'modified' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {nodes.isLoading ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}

                {!nodes.isLoading && items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      This folder is empty.
                    </td>
                  </tr>
                ) : null}

                {items.map((node) => (
                  <tr
                    key={node.id}
                    aria-selected={selected.includes(node.id)}
                    onClick={(e) => toggle(node.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                    onDoubleClick={() => {
                      if (node.kind === 'folder') {
                        setFolderId(node.id);
                        setSelected([]);
                        setPage(0);
                      } else {
                        window.open(`/file/${node.id}`, '_blank', 'noopener');
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <td title={node.name}>
                      {node.kind === 'folder' ? '📁 ' : '📄 '}
                      {node.name}
                      {node.isCheckedOut ? (
                        <span className="pill" style={{ marginLeft: 6 }}>
                          checked out
                        </span>
                      ) : null}
                    </td>
                    <td className="small muted">
                      {node.kind === 'folder' ? 'Folder' : (node.ext?.toUpperCase() ?? '—')}
                    </td>
                    <td className="small muted">
                      {node.kind === 'folder' ? '—' : formatBytes(node.byteLength)}
                    </td>
                    <td className="small muted">{formatDate(node.modified)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <div className="row" style={{ marginTop: 10 }}>
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="small muted">
                Page {page + 1} of {pageCount}
              </span>
              <button
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          ) : null}

          {columns.data && columns.data.length > 0 ? (
            <p className="small muted" style={{ marginTop: 10 }}>
              Index fields: {columns.data.map((c) => c.label).join(', ')}
            </p>
          ) : null}
        </div>

        {selected.length === 1 && selected[0] ? (
          <DocumentPanel nodeId={selected[0]} onChanged={refresh} />
        ) : (
          <aside className="card muted small">
            Select one item to see its index values, versions and notes.
            Shift-click or Ctrl-click to select several.
          </aside>
        )}
      </div>
    </>
  );
}
