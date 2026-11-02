'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';

interface Props {
  cabinetId: string;
  selectedId: string | null;
  onSelect: (folderId: string | null) => void;
}

/** One level of the folder tree, fetched on expand. */
function Level({
  cabinetId,
  parentId,
  depth,
  selectedId,
  onSelect,
}: Props & { parentId: string | null; depth: number }) {
  const folders = trpc.node.folders.useQuery({ cabinetId, parentId });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (folders.isLoading) {
    return (
      <p className="small muted" style={{ paddingLeft: depth * 14 + 8 }}>
        Loading…
      </p>
    );
  }

  return (
    <>
      {(folders.data ?? []).map((folder) => {
        const isOpen = open[folder.id] ?? false;
        return (
          <div key={folder.id}>
            <div className="row" style={{ gap: 0, paddingLeft: depth * 14 }}>
              <button
                aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
                style={{ width: 22, flex: '0 0 22px', textAlign: 'center' }}
                disabled={!folder.hasChildren}
                onClick={() => setOpen((o) => ({ ...o, [folder.id]: !isOpen }))}
              >
                {folder.hasChildren ? (isOpen ? '−' : '+') : '·'}
              </button>
              <button
                aria-current={selectedId === folder.id}
                onClick={() => onSelect(folder.id)}
                title={folder.name}
              >
                {folder.name}
              </button>
            </div>
            {isOpen ? (
              <Level
                cabinetId={cabinetId}
                parentId={folder.id}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function FolderTree({ cabinetId, selectedId, onSelect }: Props) {
  return (
    <nav className="tree" aria-label="Folders">
      <button aria-current={selectedId === null} onClick={() => onSelect(null)}>
        Cabinet root
      </button>
      <Level
        cabinetId={cabinetId}
        parentId={null}
        depth={0}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </nav>
  );
}
