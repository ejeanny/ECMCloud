'use client';

import Link from 'next/link';
import {
  ArrowRight,
  Columns3,
  FolderOpen,
  Lock,
  Pin,
  PinOff,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';

export default function CabinetsPage() {
  const cabinets = trpc.cabinet.list.useQuery();
  const utils = trpc.useUtils();
  const setPinned = trpc.cabinet.setPinned.useMutation({
    onSuccess: () => utils.cabinet.list.invalidate(),
  });

  if (cabinets.isLoading) {
    return (
      <>
        <PageHeader title="Cabinets" description="Every cabinet you have access to." />
        <CardsSkeleton />
      </>
    );
  }

  if (cabinets.error) {
    return (
      <>
        <PageHeader title="Cabinets" />
        <ErrorState message={cabinets.error.message} />
      </>
    );
  }

  const items = cabinets.data ?? [];

  return (
    <>
      <PageHeader
        title="Cabinets"
        description="A cabinet holds documents, the index fields that describe them, and the workflows that run on them."
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen />}
          title="No cabinet is accessible to you"
          description="An administrator grants access per cabinet and role. Ask for one and it will appear here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <Card key={c.id} className="group gap-4 py-5 transition-shadow hover:shadow-md">
              <CardHeader className="px-5">
                <CardTitle className="flex items-start gap-2">
                  <FolderOpen className="text-primary mt-0.5 size-4 shrink-0" />
                  <Link
                    href={`/c/${c.id}`}
                    className="min-w-0 flex-1 break-words hover:underline"
                  >
                    {c.name}
                  </Link>
                </CardTitle>
                <CardDescription className="line-clamp-2 min-h-10">
                  {c.description ?? 'No description.'}
                </CardDescription>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={c.isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                      className="col-start-2 row-span-2 row-start-1 self-start justify-self-end"
                      disabled={setPinned.isPending}
                      onClick={() => setPinned.mutate({ cabinetId: c.id, pinned: !c.isPinned })}
                    >
                      {c.isPinned ? (
                        <PinOff className="text-primary" />
                      ) : (
                        <Pin className="text-muted-foreground" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {c.isPinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
                  </TooltipContent>
                </Tooltip>
              </CardHeader>

              <CardContent className="flex flex-wrap gap-1.5 px-5">
                <Badge variant="secondary">
                  <Columns3 />
                  {c.indexFieldCount} index field{c.indexFieldCount === 1 ? '' : 's'}
                </Badge>
                {c.status !== 'active' ? (
                  <Badge variant="warning">{c.status}</Badge>
                ) : null}
                {c.isReadOnly ? (
                  <Badge variant="outline">
                    <Lock />
                    read only
                  </Badge>
                ) : null}
                {c.repoEncrypted ? (
                  <Badge variant="outline">
                    <ShieldCheck />
                    encrypted
                  </Badge>
                ) : null}
                {c.enableFullTextIndex ? (
                  <Badge variant="outline">
                    <ScanSearch />
                    full text
                  </Badge>
                ) : null}
              </CardContent>

              <CardFooter className="px-5">
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link href={`/c/${c.id}`}>
                    Open cabinet
                    <ArrowRight />
                  </Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
