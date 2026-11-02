'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  ArrowLeft,
  File as FileIcon,
  Folder,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, InlineError, TableSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function RecyclePage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [typedName, setTypedName] = useState('');
  const utils = trpc.useUtils();

  const cabinet = trpc.cabinet.byId.useQuery({ cabinetId });
  const bin = trpc.recycle.list.useQuery({ cabinetId, skip: 0, take: 200 });
  const size = trpc.recycle.size.useQuery({ cabinetId });

  function refresh() {
    setSelected([]);
    setConfirmPurge(false);
    setConfirmEmpty(false);
    setTypedName('');
    void utils.recycle.list.invalidate();
    void utils.recycle.size.invalidate();
    void utils.node.list.invalidate();
  }

  const restore = trpc.recycle.restore.useMutation({ onSuccess: refresh });
  const purge = trpc.recycle.purge.useMutation({ onSuccess: refresh });
  const empty = trpc.recycle.empty.useMutation({ onSuccess: refresh });

  const items = bin.data?.items ?? [];
  const cabinetName = cabinet.data?.name ?? '';
  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <>
      <PageHeader
        title="Recycle bin"
        description={
          cabinetName
            ? `Deleted items from ${cabinetName}. They are recoverable until the bin is emptied.`
            : 'Deleted items, recoverable until the bin is emptied.'
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${cabinetId}`}>
              <ArrowLeft />
              Back to cabinet
            </Link>
          </Button>
        }
      />

      <div className="bg-card mb-3 flex flex-wrap items-center gap-2 rounded-xl border p-2">
        <Button
          variant="outline"
          size="sm"
          disabled={selected.length === 0 || restore.isPending}
          onClick={() => restore.mutate({ cabinetId, nodeIds: selected })}
        >
          <RotateCcw />
          Restore
          {selected.length > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {selected.length}
            </Badge>
          ) : null}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={selected.length === 0}
          onClick={() => setConfirmPurge(true)}
        >
          <Trash2 />
          Delete permanently
        </Button>

        <span className="flex-1" />

        <p className="text-muted-foreground text-xs tabular-nums">
          {size.data?.count ?? 0} item{size.data?.count === 1 ? '' : 's'},{' '}
          {formatBytes(size.data?.bytes ?? 0)}
        </p>

        <Button
          variant="destructive"
          size="sm"
          disabled={!size.data?.count}
          onClick={() => {
            setTypedName('');
            setConfirmEmpty(true);
          }}
        >
          <TriangleAlert />
          Empty bin
        </Button>
      </div>

      <div className="mb-3 space-y-2">
        {restore.error ? <InlineError message={restore.error.message} /> : null}
        {purge.error ? <InlineError message={purge.error.message} /> : null}
        {empty.error ? <InlineError message={empty.error.message} /> : null}
        {bin.error ? <InlineError message={bin.error.message} /> : null}
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select every item"
                  checked={allSelected}
                  disabled={items.length === 0}
                  onCheckedChange={(checked) =>
                    setSelected(checked === true ? items.map((n) => n.id) : [])
                  }
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24">Type</TableHead>
              <TableHead className="w-24">Size</TableHead>
              <TableHead className="w-44">Deleted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bin.isLoading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <TableSkeleton rows={6} columns={4} />
                </TableCell>
              </TableRow>
            ) : null}

            {!bin.isLoading && items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0"
                    icon={<Trash2 />}
                    title="The recycle bin is empty"
                    description="Items recycled from the explorer land here first."
                  />
                </TableCell>
              </TableRow>
            ) : null}

            {items.map((node) => (
              <TableRow key={node.id} aria-selected={selected.includes(node.id)}>
                <TableCell>
                  <Checkbox
                    aria-label={`Select ${node.name}`}
                    checked={selected.includes(node.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked === true
                          ? [...current, node.id]
                          : current.filter((x) => x !== node.id),
                      )
                    }
                  />
                </TableCell>
                <TableCell title={node.name}>
                  <div className="flex min-w-0 items-center gap-2">
                    {node.kind === 'folder' ? (
                      <Folder className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <FileIcon className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="truncate">{node.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {node.kind === 'folder' ? 'Folder' : (node.ext?.toUpperCase() ?? '—')}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {node.kind === 'folder' ? '—' : formatBytes(node.byteLength)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {formatDate(node.deletedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={confirmPurge} onOpenChange={setConfirmPurge}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete {selected.length} item
              {selected.length === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The bytes are destroyed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={purge.isPending}
              onClick={() => purge.mutate({ cabinetId, nodeIds: selected })}
            >
              <Trash2 />
              Delete permanently
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Emptying the bin asks for the cabinet's name, as the API does: it is
          the one action here with nothing behind it. */}
      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the recycle bin?</AlertDialogTitle>
            <AlertDialogDescription>
              Every one of the {size.data?.count ?? 0} item
              {size.data?.count === 1 ? '' : 's'} in it is destroyed, freeing{' '}
              {formatBytes(size.data?.bytes ?? 0)}. Type the cabinet name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <Label htmlFor="confirm-name">
              Cabinet name — <span className="font-mono">{cabinetName}</span>
            </Label>
            <Input
              id="confirm-name"
              autoComplete="off"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={
                !cabinetName || typedName !== cabinetName || empty.isPending
              }
              onClick={() => empty.mutate({ cabinetId, confirmName: typedName })}
            >
              <TriangleAlert />
              Empty bin
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
