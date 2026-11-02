'use client';

import { useState } from 'react';
import { File as FileIcon, Loader2, LockOpen, Undo2, Upload } from 'lucide-react';

import { CheckInDialog } from '@/components/check-in-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, InlineError, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function CheckoutsPage() {
  const utils = trpc.useUtils();
  const checkouts = trpc.version.myCheckOuts.useQuery();
  const [checkingIn, setCheckingIn] = useState<{
    nodeId: string;
    cabinetId: string;
    name: string;
  } | null>(null);

  function refresh() {
    void utils.version.myCheckOuts.invalidate();
    void utils.node.list.invalidate();
  }

  const cancel = trpc.version.cancelCheckOut.useMutation({ onSuccess: refresh });

  const header = (
    <PageHeader
      title="My check-outs"
      description="A checked-out document is locked against other users’ edits until it is checked in or the check-out is cancelled."
    />
  );

  if (checkouts.isLoading) {
    return (
      <>
        {header}
        <div className="bg-card rounded-xl border">
          <TableSkeleton />
        </div>
      </>
    );
  }
  if (checkouts.error) {
    return (
      <>
        {header}
        <ErrorState message={checkouts.error.message} />
      </>
    );
  }

  const items = checkouts.data ?? [];

  return (
    <>
      {header}

      {items.length === 0 ? (
        <EmptyState
          icon={<LockOpen />}
          title="You have nothing checked out"
          description="Check a document out from the explorer to take the lock on it."
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead className="w-44">Since</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead className="w-56" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.checkoutId}>
                  <TableCell title={item.node.name}>
                    <a
                      href={`/file/${item.node.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary flex w-full min-w-0 items-center gap-2 hover:underline"
                    >
                      <FileIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate">{item.node.name}</span>
                    </a>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(item.since)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {item.comment ?? '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {/* The dialog, so checking in can carry the revised file. */}
                      <Button
                        size="xs"
                        onClick={() =>
                          setCheckingIn({
                            nodeId: item.node.id,
                            cabinetId: item.node.cabinetId,
                            name: item.node.name,
                          })
                        }
                      >
                        <Upload />
                        Check in
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate({ nodeId: item.node.id })}
                      >
                        {cancel.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Undo2 />
                        )}
                        Cancel
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {cancel.error ? (
        <InlineError className="mt-3" message={cancel.error.message} />
      ) : null}

      {checkingIn ? (
        <CheckInDialog
          nodeId={checkingIn.nodeId}
          cabinetId={checkingIn.cabinetId}
          name={checkingIn.name}
          onClose={() => setCheckingIn(null)}
          onDone={refresh}
        />
      ) : null}
    </>
  );
}
