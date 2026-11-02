'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Library } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface Props {
  cabinetId: string;
  selectedId: string | null;
  onSelect: (folderId: string | null) => void;
}

const rowClass =
  'flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors';

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
      <div className="space-y-1.5 py-1" style={{ paddingLeft: depth * 14 + 22 }}>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <>
      {(folders.data ?? []).map((folder) => {
        const isOpen = open[folder.id] ?? false;
        const isSelected = selectedId === folder.id;

        return (
          <div key={folder.id}>
            <div
              className="flex items-center"
              style={{ paddingLeft: depth * 14 }}
            >
              <button
                type="button"
                aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
                className={cn(
                  'text-muted-foreground hover:text-foreground grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm',
                  !folder.hasChildren && 'cursor-default opacity-0',
                )}
                disabled={!folder.hasChildren}
                onClick={() => setOpen((o) => ({ ...o, [folder.id]: !isOpen }))}
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>

              <button
                type="button"
                aria-current={isSelected}
                title={folder.name}
                onClick={() => onSelect(folder.id)}
                className={cn(
                  rowClass,
                  isSelected
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted text-foreground/90',
                )}
              >
                {isOpen ? (
                  <FolderOpen className="size-3.5 shrink-0" />
                ) : (
                  <Folder className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{folder.name}</span>
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
    <nav
      aria-label="Folders"
      className="bg-card max-h-[calc(100dvh-13rem)] overflow-auto rounded-xl border p-2 scrollbar-thin"
    >
      <button
        type="button"
        aria-current={selectedId === null}
        onClick={() => onSelect(null)}
        className={cn(
          rowClass,
          'pl-[22px]',
          selectedId === null
            ? 'bg-primary/10 text-primary font-medium'
            : 'hover:bg-muted text-foreground/90',
        )}
      >
        <Library className="size-3.5 shrink-0" />
        <span className="truncate">Cabinet root</span>
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
