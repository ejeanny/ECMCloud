'use client';

import Link from 'next/link';
import { Download, File as FileIcon, Star, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
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
import { openHrefFor } from '@/components/row-actions';
import { trpc } from '@/lib/trpc';

export default function FavoritesPage() {
  const utils = trpc.useUtils();
  const favorites = trpc.workspace.favorites.useQuery({ skip: 0, take: 200 });
  const remove = trpc.workspace.removeFavorites.useMutation({
    onSuccess: () => utils.workspace.favorites.invalidate(),
  });

  const header = (
    <PageHeader
      title="Favourites"
      description="Documents you have starred, across every cabinet you can see."
    />
  );

  if (favorites.isLoading) {
    return (
      <>
        {header}
        <div className="bg-card rounded-xl border">
          <TableSkeleton />
        </div>
      </>
    );
  }
  if (favorites.error) {
    return (
      <>
        {header}
        <ErrorState message={favorites.error.message} />
      </>
    );
  }

  const items = favorites.data?.items ?? [];

  return (
    <>
      {header}

      {items.length === 0 ? (
        <EmptyState
          icon={<Star />}
          title="No favourites yet"
          description="Star a document from its detail panel and it will be listed here."
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Size</TableHead>
                <TableHead className="w-44">Added</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(({ node, addedAt }) => (
                <TableRow key={node.id} className="group/row">
                  <TableCell title={node.name}>
                    <Link
                      href={openHrefFor(node)}
                      className="hover:text-primary flex w-full min-w-0 items-center gap-2 hover:underline"
                    >
                      <FileIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate">{node.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">
                    {formatBytes(node.byteLength)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(addedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-xs" asChild>
                            <a href={`/file/${node.id}/download`} aria-label="Download">
                              <Download />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Download</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Remove from favourites"
                            className="text-destructive hover:text-destructive"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate({ nodeIds: [node.id] })}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove from favourites</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
