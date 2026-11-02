'use client';

import { useState } from 'react';
import { CircleCheck, RefreshCw, Server } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, InlineError, TableSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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

export default function JobsPage() {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<string[]>([]);

  const summary = trpc.job.summary.useQuery(undefined, { refetchInterval: 10_000 });
  const failed = trpc.job.failed.useQuery({ take: 100 }, { refetchInterval: 15_000 });
  const retry = trpc.job.retry.useMutation({
    onSuccess() {
      setSelected([]);
      void utils.job.failed.invalidate();
      void utils.job.summary.invalidate();
    },
  });

  if (summary.error) return <ErrorState message={summary.error.message} />;

  const byKind = new Map<string, Record<string, number>>();
  for (const row of summary.data ?? []) {
    const current = byKind.get(row.kind) ?? {};
    current[row.state] = row.count;
    byKind.set(row.kind, current);
  }

  const totals: Record<'queued' | 'running' | 'done' | 'failed', number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const states of byKind.values()) {
    totals.queued += states.queued ?? 0;
    totals.running += states.running ?? 0;
    totals.done += states.done ?? 0;
    totals.failed += states.failed ?? 0;
  }

  const failedJobs = failed.data ?? [];
  const allSelected = failedJobs.length > 0 && selected.length === failedJobs.length;

  return (
    <>
      <PageHeader
        title="Services"
        description="One queue stands in for the thirteen Windows services Dokmee ran. Handlers that need a third-party engine — OCR, Office conversion, data extraction, AI summarisation, RPA — are not implemented and fail with that reason."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ['Queued', totals.queued, 'secondary'],
            ['Running', totals.running, 'default'],
            ['Done', totals.done, 'success'],
            ['Failed', totals.failed, 'destructive'],
          ] as const
        ).map(([label, value, variant]) => (
          <Card key={label} className="gap-1 py-4">
            <CardContent className="px-4">
              <CardDescription className="text-xs">{label}</CardDescription>
              <CardTitle className="flex items-center gap-2 text-2xl tabular-nums">
                {value}
                {label === 'Failed' && value > 0 ? (
                  <Badge variant={variant}>needs attention</Badge>
                ) : null}
              </CardTitle>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-2 text-base font-semibold tracking-tight">Queues</h2>
      <div className="bg-card mb-8 overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead>Queue</TableHead>
              <TableHead className="w-24">Queued</TableHead>
              <TableHead className="w-24">Running</TableHead>
              <TableHead className="w-24">Done</TableHead>
              <TableHead className="w-24">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.isLoading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <TableSkeleton rows={4} columns={5} />
                </TableCell>
              </TableRow>
            ) : null}

            {!summary.isLoading && byKind.size === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0"
                    icon={<Server />}
                    title="No jobs have been queued"
                    description="Uploading a document queues text extraction; workflows queue their own steps."
                  />
                </TableCell>
              </TableRow>
            ) : null}

            {[...byKind].map(([kind, states]) => (
              <TableRow key={kind}>
                <TableCell className="font-mono text-xs">{kind}</TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {states.queued ?? 0}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {states.running ?? 0}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {states.done ?? 0}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {states.failed ? (
                    <Badge variant="destructive">{states.failed}</Badge>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-base font-semibold tracking-tight">Failed jobs</h2>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={selected.length === 0 || retry.isPending}
          onClick={() => retry.mutate({ ids: selected })}
        >
          <RefreshCw />
          Retry selected
          {selected.length > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {selected.length}
            </Badge>
          ) : null}
        </Button>
      </div>

      {retry.error ? <InlineError className="mb-3" message={retry.error.message} /> : null}

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select every failed job"
                  checked={allSelected}
                  disabled={failedJobs.length === 0}
                  onCheckedChange={(checked) =>
                    setSelected(checked === true ? failedJobs.map((j) => j.id) : [])
                  }
                />
              </TableHead>
              <TableHead className="w-40">Kind</TableHead>
              <TableHead className="w-44">Finished</TableHead>
              <TableHead className="w-20">Tries</TableHead>
              <TableHead>Last error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {failedJobs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    className="border-0"
                    icon={<CircleCheck />}
                    title="Nothing has failed"
                    description="Failed jobs appear here with the error that stopped them."
                  />
                </TableCell>
              </TableRow>
            ) : null}

            {failedJobs.map((job) => (
              <TableRow key={job.id} aria-selected={selected.includes(job.id)}>
                <TableCell>
                  <Checkbox
                    aria-label={`Select job ${job.id}`}
                    checked={selected.includes(job.id)}
                    onCheckedChange={(checked) =>
                      setSelected((c) =>
                        checked === true ? [...c, job.id] : c.filter((x) => x !== job.id),
                      )
                    }
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">{job.kind}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {formatDate(job.finishedAt)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {job.attempts}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-normal">
                  {job.lastError ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
