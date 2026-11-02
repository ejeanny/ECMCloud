'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentPanel } from '@/components/document-panel';
import { FolderTree } from '@/components/folder-tree';
import { RowActions, openHrefFor, type GridNode } from '@/components/row-actions';
import { UploadButton } from '@/components/upload-button';
import { formatBytes, formatDate } from '@/lib/format';
import { useChunkedUpload } from '@/lib/upload';
import { trpc } from '@/lib/trpc';

const PAGE = 50;

export default function ExplorerPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const router = useRouter();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState('modified');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [dragging, setDragging] = useState(false);
  const gridRef = useRef<HTMLTableSectionElement>(null);

  const utils = trpc.useUtils();
  const cabinet = trpc.cabinet.byId.useQuery({ cabinetId });
  const columns = trpc.indexField.columns.useQuery({ cabinetId });
  const me = trpc.session.me.useQuery();
  const trail = trpc.node.breadcrumb.useQuery(
    { nodeId: folderId ?? '' },
    { enabled: folderId !== null },
  );

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

  const refresh = useCallback(() => {
    void utils.node.list.invalidate();
    void utils.node.count.invalidate();
    void utils.node.folders.invalidate();
  }, [utils]);

  const createFolder = trpc.node.createFolder.useMutation({ onSuccess: refresh });
  const recycle = trpc.node.sendToRecycleBin.useMutation({
    onSuccess() {
      setSelected([]);
      refresh();
    },
  });
  const move = trpc.node.move.useMutation({
    onSuccess() {
      setSelected([]);
      refresh();
    },
  });

  const { stage, progress } = useChunkedUpload();
  const finishUpload = trpc.upload.finish.useMutation();

  const items = nodes.data?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((total.data ?? 0) / PAGE));
  const readOnly = cabinet.data?.status !== 'active';

  const enter = useCallback(
    (node: { id: string; kind: string; ext: string | null }) => {
      if (node.kind === 'folder') {
        setFolderId(node.id);
        setSelected([]);
        setCursor(0);
        setPage(0);
      } else if (node.ext?.toLowerCase() === 'pdf') {
        router.push(`/v/${node.id}`);
      } else {
        window.open(`/file/${node.id}`, '_blank', 'noopener');
      }
    },
    [router],
  );

  function toggle(id: string, additive: boolean) {
    setSelected((current) => {
      if (additive) {
        return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      }
      return [id];
    });
  }

  function sort(by: string) {
    if (sortBy === by) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(by);
      setSortDir('asc');
    }
    setPage(0);
  }

  /**
   * Arrow keys move, Enter opens, Space selects, Backspace goes up.
   *
   * A file list is a list; being able to walk it without the mouse is most of
   * what makes one quick to use.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal a key from something the user is typing into.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (items.length === 0) return;

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          const next = Math.min(
            items.length - 1,
            Math.max(0, cursor + (event.key === 'ArrowDown' ? 1 : -1)),
          );
          setCursor(next);
          const row = items[next];
          if (row) setSelected([row.id]);
          gridRef.current
            ?.querySelectorAll('tr')
            [next]?.scrollIntoView({ block: 'nearest' });
          break;
        }
        case 'Enter': {
          const row = items[cursor];
          if (row) {
            event.preventDefault();
            enter(row);
          }
          break;
        }
        case ' ': {
          const row = items[cursor];
          if (row) {
            event.preventDefault();
            toggle(row.id, true);
          }
          break;
        }
        case 'Backspace': {
          if (folderId) {
            event.preventDefault();
            const parent = trail.data?.at(-2);
            setFolderId(parent ? parent.id : null);
            setSelected([]);
            setPage(0);
          }
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, cursor, enter, folderId, trail.data]);

  /** Files dropped on the grid land in the folder being looked at. */
  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (readOnly) return;
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const uploadId = await stage(file, { cabinetId, parentId: folderId });
        await finishUpload.mutateAsync({ uploadId });
      } catch {
        // `stage` has already abandoned the upload; the next file still goes.
      }
    }
    refresh();
  }

  const current = selected.length === 1 ? selected[0] : null;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{cabinet.data?.name ?? 'Cabinet'}</h2>
        <span className="spacer" />
        <Link className="pill" href={`/c/${cabinetId}/search`}>
          Search
        </Link>
        <Link className="pill" href="/checkouts">
          My check-outs
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

      {/* Where you are, and a way back up that is not the tree. */}
      <nav className="breadcrumb small" aria-label="Folder path">
        <button
          onClick={() => {
            setFolderId(null);
            setSelected([]);
            setPage(0);
          }}
        >
          {cabinet.data?.name ?? 'Cabinet'}
        </button>
        {(trail.data ?? []).map((crumb) => (
          <span key={crumb.id}>
            <span className="muted"> / </span>
            <button
              onClick={() => {
                setFolderId(crumb.id);
                setSelected([]);
                setPage(0);
              }}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="row wrap" style={{ margin: '8px 0 12px' }}>
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
          disabled={readOnly || selected.length === 0}
          onClick={() => {
            if (window.confirm(`Send ${selected.length} item(s) to the recycle bin?`)) {
              recycle.mutate({ nodeIds: selected });
            }
          }}
        >
          Recycle
        </button>
        <button
          disabled={readOnly || selected.length === 0 || folderId === null}
          title="Move the selection up one folder"
          onClick={() => {
            const parent = trail.data?.at(-2);
            move.mutate({ nodeIds: selected, targetParentId: parent?.id ?? null });
          }}
        >
          Move up
        </button>
        <span className="spacer" />
        <span className="small muted">
          {progress
            ? `Uploading ${progress.name} (${progress.done}/${progress.total})`
            : 'Drop files anywhere on the list · ↑↓ move · Enter opens'}
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
            setCursor(0);
            setPage(0);
          }}
        />

        <div style={{ minWidth: 0 }}>
          <div
            className={dragging ? 'grid-drop dragging' : 'grid-drop'}
            onDragOver={(e) => {
              e.preventDefault();
              if (!readOnly) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <table>
              <thead>
                <tr>
                  <th>
                    <button className="small" onClick={() => sort('name')}>
                      Name {sortBy === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </th>
                  <th style={{ width: 300 }} />
                  <th style={{ width: 90 }}>
                    <button className="small" onClick={() => sort('size')}>
                      Size
                    </button>
                  </th>
                  <th style={{ width: 160 }}>
                    <button className="small" onClick={() => sort('modified')}>
                      Modified {sortBy === 'modified' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody ref={gridRef}>
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
                      This folder is empty — drop files here to add some.
                    </td>
                  </tr>
                ) : null}

                {items.map((node, i) => (
                  <tr
                    key={node.id}
                    aria-selected={selected.includes(node.id)}
                    data-cursor={i === cursor ? 'true' : undefined}
                    onClick={(e) => {
                      setCursor(i);
                      toggle(node.id, e.shiftKey || e.ctrlKey || e.metaKey);
                    }}
                    onDoubleClick={() => enter(node)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td title={node.name}>
                      {/* The name is the open control: one click, no selection
                          first, and it is a real link so it can be opened in a
                          new tab the way anything else on the web can. */}
                      {node.kind === 'folder' ? (
                        <button
                          className="row-name"
                          onClick={(e) => {
                            e.stopPropagation();
                            enter(node);
                          }}
                        >
                          📁 {node.name}
                        </button>
                      ) : (
                        <Link
                          className="row-name"
                          href={openHrefFor(node)}
                          target={node.ext?.toLowerCase() === 'pdf' ? undefined : '_blank'}
                          onClick={(e) => e.stopPropagation()}
                        >
                          📄 {node.name}
                        </Link>
                      )}
                      {node.isCheckedOut ? (
                        <span
                          className="pill"
                          style={{ marginLeft: 6 }}
                          title={`Checked out by ${node.checkedOutBy ?? 'someone'}`}
                        >
                          {node.checkedOutById === me.data?.user.id ? 'yours' : 'out'}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <RowActions
                        node={node as GridNode}
                        me={me.data?.user.id ?? null}
                        readOnly={readOnly}
                        onChanged={refresh}
                      />
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

        {current ? (
          <DocumentPanel nodeId={current} onChanged={refresh} />
        ) : (
          <aside className="card muted small">
            Click a name to open it. Click a row to see its index values,
            versions and notes here. Shift-click or Ctrl-click to select
            several.
          </aside>
        )}
      </div>
    </>
  );
}
