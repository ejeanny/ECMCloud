'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Pencil, Plus, Rocket, Workflow } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, InlineError, TableSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

export default function WorkflowsPage() {
  const { cabinetId } = useParams<{ cabinetId: string }>();
  const utils = trpc.useUtils();
  const workflows = trpc.workflow.list.useQuery({ cabinetId });

  const publish = trpc.workflow.publish.useMutation({
    onSuccess: () => utils.workflow.list.invalidate({ cabinetId }),
  });

  const header = (
    <PageHeader
      title="Workflows"
      description="A workflow has design revisions; one is published and is what triggers and manual starts run. Revisions are immutable once published."
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${cabinetId}`}>
              <ArrowLeft />
              Back to cabinet
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href={`/c/${cabinetId}/workflows/new`}>
              <Plus />
              New workflow
            </Link>
          </Button>
        </>
      }
    />
  );

  if (workflows.isLoading) {
    return (
      <>
        {header}
        <div className="bg-card rounded-xl border">
          <TableSkeleton />
        </div>
      </>
    );
  }
  if (workflows.error) {
    return (
      <>
        {header}
        <ErrorState message={workflows.error.message} />
      </>
    );
  }

  const items = workflows.data ?? [];

  return (
    <>
      {header}

      {items.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="No workflow is defined in this cabinet"
          description="The designer draws the same graph the API takes, so a workflow built on the canvas and one posted through the API are the same thing."
          action={
            <Button asChild size="sm">
              <Link href={`/c/${cabinetId}/workflows/new`}>
                <Plus />
                New workflow
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Published</TableHead>
                <TableHead className="w-24">Revisions</TableHead>
                <TableHead className="w-24">Instances</TableHead>
                <TableHead className="w-24">State</TableHead>
                <TableHead className="w-64" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((w) => {
                const unpublished = w.revisions.filter((r) => !r.published);
                return (
                  <TableRow key={w.id}>
                    <TableCell>
                      <span className="block truncate font-medium">{w.name}</span>
                      {w.description ? (
                        <span className="text-muted-foreground block truncate text-xs">
                          {w.description}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {w.publishedRevision ? (
                        <Badge variant="success" className="font-mono">
                          r{w.publishedRevision}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {w.revisions.length}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {w.instanceCount}
                    </TableCell>
                    <TableCell>
                      {w.inError ? (
                        <Badge variant="destructive">error</Badge>
                      ) : w.isLocked ? (
                        <Badge variant="warning">locked</Badge>
                      ) : (
                        <Badge variant="secondary">ok</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button asChild variant="outline" size="xs">
                          <Link href={`/c/${cabinetId}/workflows/${w.id}`}>
                            <Pencil />
                            Design
                          </Link>
                        </Button>

                        {unpublished.length > 0 ? (
                          <Select
                            value=""
                            onValueChange={(value) => {
                              const revision = Number(value);
                              if (revision) {
                                publish.mutate({
                                  cabinetId,
                                  workflowId: w.id,
                                  revision,
                                });
                              }
                            }}
                          >
                            <SelectTrigger size="sm" className="w-44">
                              <Rocket className="size-3.5" />
                              <SelectValue placeholder="Publish revision…" />
                            </SelectTrigger>
                            <SelectContent>
                              {unpublished.map((r) => (
                                <SelectItem key={r.id} value={String(r.revision)}>
                                  r{r.revision} — {formatDate(r.created)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {publish.error ? (
        <InlineError className="mt-3" message={publish.error.message} />
      ) : null}

      <p className="text-muted-foreground mt-4 max-w-prose text-xs">
        The designer draws the same graph <code className="font-mono">workflow.save</code>{' '}
        takes, so a workflow built on the canvas and one posted through the API are the
        same thing. Dokmee&apos;s canvas was Rappid/JointJS; this one is React Flow.
      </p>
    </>
  );
}
