'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Columns3,
  File as FileIcon,
  Folder,
  FolderPlus,
  Lock,
  LockOpen,
  MousePointerClick,
  Search,
  Trash2,
  UploadCloud,
  Workflow,
} from 'lucide-react';

import { DocumentPanel } from '@/components/document-panel';
import { FolderTree } from '@/components/folder-tree';
import { PageHeader } from '@/components/page-header';
import { RowActions, openHrefFor, type GridNode } from '@/components/row-actions';
import { Pager } from '@/components/pager';
import { EmptyState, InlineError, TableSkeleton } from '@/components/states';
import { UploadButton } from '@/components/upload-button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes, formatDate } from '@/lib/format';
import { useChunkedUpload } from '@/lib/upload';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

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
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [confirmRecycle, setConfirmRecycle] = useState(false);
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

  const createFolder = trpc.node.createFolder.useMutation({
    onSuccess() {
      setNewFolder(null);
      refresh();
    },
  });
  const recycle = trpc.node.sendToRecycleBin.useMutation({
    onSuccess() {
      setSelected([]);
      setConfirmRecycle(false);
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

  function goToFolder(id: string | null) {
    setFolderId(id);
    setSelected([]);
    setCursor(0);
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
  const crumbs = trail.data ?? [];

  const tabs = [
    { href: `/c/${cabinetId}/search`, label: 'Search', icon: Search },
    { href: `/c/${cabinetId}/fields`, label: 'Index fields', icon: Columns3 },
    { href: `/c/${cabinetId}/workflows`, label: 'Workflows', icon: Workflow },
    { href: `/c/${cabinetId}/recycle`, label: 'Recycle bin', icon: Trash2 },
  ];

  return (
    <>
      <PageHeader
        title={cabinet.data?.name ?? 'Cabinet'}
        description={cabinet.data?.description ?? undefined}
        actions={
          <>
            {readOnly ? (
              <Badge variant="warning">
                <Lock />
                read only
              </Badge>
            ) : null}
            {tabs.map(({ href, label, icon: Icon }) => (
              <Button key={href} asChild variant="outline" size="sm">
                <Link href={href}>
                  <Icon />
                  {label}
                </Link>
              </Button>
            ))}
          </>
        }
      />

      {/* Where you are, and a way back up that is not the tree. */}
      <Breadcrumb className="mb-3">
        <BreadcrumbList>
          <BreadcrumbItem>
            {crumbs.length === 0 ? (
              <BreadcrumbPage>{cabinet.data?.name ?? 'Cabinet'}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <button type="button" onClick={() => goToFolder(null)}>
                  {cabinet.data?.name ?? 'Cabinet'}
                </button>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {crumbs.map((crumb, i) => (
            <BreadcrumbItem key={crumb.id}>
              <BreadcrumbSeparator />
              {i === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={() => goToFolder(crumb.id)}>
                    {crumb.name}
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="bg-card mb-3 flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <UploadButton
          cabinetId={cabinetId}
          parentId={folderId}
          onUploaded={refresh}
          disabled={readOnly}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={() => setNewFolder('')}
        >
          <FolderPlus />
          New folder
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || selected.length === 0}
          onClick={() => setConfirmRecycle(true)}
        >
          <Trash2 />
          Recycle
          {selected.length > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {selected.length}
            </Badge>
          ) : null}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly || selected.length === 0 || folderId === null}
              onClick={() => {
                const parent = trail.data?.at(-2);
                move.mutate({ nodeIds: selected, targetParentId: parent?.id ?? null });
              }}
            >
              <ArrowUpToLine />
              Move up
            </Button>
          </TooltipTrigger>
          <TooltipContent>Move the selection up one folder</TooltipContent>
        </Tooltip>

        <span className="flex-1" />

        <p className="text-muted-foreground hidden text-xs sm:block">
          {progress
            ? `Uploading ${progress.name} (${progress.done}/${progress.total})`
            : 'Drop files on the list · ↑↓ move · Enter opens · Space selects'}
        </p>
      </div>

      <div className="space-y-2">
        {recycle.error ? <InlineError message={recycle.error.message} /> : null}
        {move.error ? <InlineError message={move.error.message} /> : null}
        {nodes.error ? <InlineError message={nodes.error.message} /> : null}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_20rem]">
        <div className="hidden xl:block">
          <FolderTree cabinetId={cabinetId} selectedId={folderId} onSelect={goToFolder} />
        </div>

        <div className="min-w-0">
          <div
            className={cn(
              'bg-card rounded-xl border-2 border-dashed transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-transparent',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              if (!readOnly) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="overflow-hidden rounded-xl border">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-muted/50">
                    <TableHead>
                      <SortButton
                        label="Name"
                        active={sortBy === 'name'}
                        dir={sortDir}
                        onClick={() => sort('name')}
                      />
                    </TableHead>
                    <TableHead className="w-28" />
                    <TableHead className="w-20">
                      <SortButton
                        label="Size"
                        active={sortBy === 'size'}
                        dir={sortDir}
                        onClick={() => sort('size')}
                      />
                    </TableHead>
                    <TableHead className="w-40">
                      <SortButton
                        label="Modified"
                        active={sortBy === 'modified'}
                        dir={sortDir}
                        onClick={() => sort('modified')}
                      />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody ref={gridRef}>
                  {nodes.isLoading ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="p-0">
                        <TableSkeleton rows={8} columns={4} />
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {!nodes.isLoading && items.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState
                          className="border-0"
                          icon={<UploadCloud />}
                          title="This folder is empty"
                          description="Drop files here, or use Upload, to add the first document."
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {items.map((node, i) => (
                    <TableRow
                      key={node.id}
                      aria-selected={selected.includes(node.id)}
                      data-cursor={i === cursor ? 'true' : undefined}
                      className={cn(
                        'group/row cursor-pointer',
                        // The keyboard cursor, distinct from selection: you can
                        // be moving through the list without having chosen
                        // anything yet.
                        i === cursor && 'ring-primary/40 ring-inset ring-1',
                      )}
                      onClick={(e) => {
                        setCursor(i);
                        toggle(node.id, e.shiftKey || e.ctrlKey || e.metaKey);
                      }}
                      onDoubleClick={() => enter(node)}
                    >
                      <TableCell title={node.name}>
                        <div className="flex items-center gap-2">
                          {/* The name is the open control: one click, no
                              selection first, and a document is a real link so
                              it can be opened in a new tab the way anything
                              else on the web can. */}
                          {node.kind === 'folder' ? (
                            <button
                              type="button"
                              className="hover:text-primary flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                enter(node);
                              }}
                            >
                              <Folder className="text-muted-foreground size-4 shrink-0" />
                              <span className="truncate font-medium">{node.name}</span>
                            </button>
                          ) : (
                            <Link
                              className="hover:text-primary flex min-w-0 flex-1 items-center gap-2 hover:underline"
                              href={openHrefFor(node)}
                              target={
                                node.ext?.toLowerCase() === 'pdf' ? undefined : '_blank'
                              }
                              onClick={(e) => e.stopPropagation()}
                            >
                              <FileIcon className="text-muted-foreground size-4 shrink-0" />
                              <span className="truncate">{node.name}</span>
                            </Link>
                          )}

                          {node.isCheckedOut ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant={
                                    node.checkedOutById === me.data?.user.id
                                      ? 'default'
                                      : 'secondary'
                                  }
                                  className="shrink-0"
                                >
                                  {node.checkedOutById === me.data?.user.id ? (
                                    <LockOpen />
                                  ) : (
                                    <Lock />
                                  )}
                                  {node.checkedOutById === me.data?.user.id
                                    ? 'yours'
                                    : 'out'}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Checked out by {node.checkedOutBy ?? 'someone'}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActions
                          node={node as GridNode}
                          me={me.data?.user.id ?? null}
                          readOnly={readOnly}
                          onChanged={refresh}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        {node.kind === 'folder' ? '—' : formatBytes(node.byteLength)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {formatDate(node.modified)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <Pager
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            summary={
              total.data
                ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total.data)} of ${total.data}`
                : undefined
            }
          />

          {columns.data && columns.data.length > 0 ? (
            <p className="text-muted-foreground mt-3 text-xs">
              Index fields: {columns.data.map((c) => c.label).join(', ')}
            </p>
          ) : null}
        </div>

        {current ? (
          <DocumentPanel nodeId={current} onChanged={refresh} />
        ) : (
          <aside className="bg-card hidden rounded-xl border p-5 xl:block">
            <EmptyState
              className="border-0 px-0 py-2"
              icon={<MousePointerClick />}
              title="Nothing selected"
              description="Click a name to open it, or a row to see its index values, versions and notes here. Shift-click or Ctrl-click to select several."
            />
          </aside>
        )}
      </div>

      {/* New folder — a dialog rather than window.prompt, which cannot be
          styled, cannot be cancelled with Escape consistently, and blocks. */}
      <Dialog
        open={newFolder !== null}
        onOpenChange={(open) => setNewFolder(open ? '' : null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <form
            id="new-folder-form"
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = (newFolder ?? '').trim();
              if (name) createFolder.mutate({ cabinetId, parentId: folderId, name });
            }}
          >
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              autoFocus
              required
              value={newFolder ?? ''}
              onChange={(e) => setNewFolder(e.target.value)}
            />
            {createFolder.error ? (
              <InlineError message={createFolder.error.message} />
            ) : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolder(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="new-folder-form"
              disabled={!(newFolder ?? '').trim() || createFolder.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRecycle} onOpenChange={setConfirmRecycle}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send {selected.length} item{selected.length === 1 ? '' : 's'} to the recycle
              bin?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They leave this folder but are not destroyed — the cabinet&apos;s recycle bin
              can restore them until it is emptied.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={(event) => {
                event.preventDefault();
                recycle.mutate({ nodeIds: selected });
              }}
            >
              <Trash2 />
              Recycle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-semibold tracking-wide uppercase transition-colors',
        active && 'text-foreground',
      )}
    >
      {label}
      {active ? (
        dir === 'asc' ? (
          <ChevronUp className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )
      ) : null}
    </button>
  );
}
