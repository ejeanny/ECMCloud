'use client';

import { useState } from 'react';
import { CircleCheck, CircleX, File as FileIcon, Inbox, Loader2 } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, InlineError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function InboxPage() {
  const utils = trpc.useUtils();
  const todos = trpc.workflow.myTodos.useQuery({ skip: 0, take: 100 });
  const [comment, setComment] = useState<Record<string, string>>({});

  const complete = trpc.workflow.completeTodo.useMutation({
    onSuccess() {
      void utils.workflow.myTodos.invalidate();
    },
  });

  const header = (
    <PageHeader
      title="My tasks"
      description="Workflow steps waiting on a decision from you."
    />
  );

  if (todos.isLoading) {
    return (
      <>
        {header}
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      </>
    );
  }
  if (todos.error) {
    return (
      <>
        {header}
        <ErrorState message={todos.error.message} />
      </>
    );
  }

  const items = todos.data?.items ?? [];

  return (
    <>
      {header}

      {complete.error ? (
        <InlineError className="mb-3" message={complete.error.message} />
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="Nothing is waiting on you"
          description="When a workflow routes a document to you, the step appears here."
        />
      ) : (
        <div className="space-y-3">
          {items.map((todo) => (
            <Card key={todo.id} className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span>{todo.task.name}</span>
                  <Badge variant="secondary">{todo.task.type}</Badge>
                </CardTitle>
                <p className="text-muted-foreground text-xs">
                  {todo.instance.workflow.name} · started{' '}
                  {formatDate(todo.instance.started)}
                </p>
              </CardHeader>

              <CardContent className="space-y-3 px-5">
                <a
                  href={`/file/${todo.instance.node.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary inline-flex items-center gap-2 text-sm hover:underline"
                >
                  <FileIcon className="text-muted-foreground size-4 shrink-0" />
                  {todo.instance.node.name}
                </a>

                <div className="space-y-2">
                  <Label htmlFor={`c-${todo.id}`} className="text-muted-foreground text-xs">
                    Comment (optional)
                  </Label>
                  <Input
                    id={`c-${todo.id}`}
                    placeholder="Recorded against your decision"
                    value={comment[todo.id] ?? ''}
                    onChange={(e) =>
                      setComment((c) => ({ ...c, [todo.id]: e.target.value }))
                    }
                  />
                </div>
              </CardContent>

              <CardFooter className="gap-2 px-5">
                <Button
                  disabled={complete.isPending}
                  onClick={() =>
                    complete.mutate({
                      todoId: todo.id,
                      decision: 'approve',
                      comment: comment[todo.id] || undefined,
                    })
                  }
                >
                  {complete.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CircleCheck />
                  )}
                  Approve
                </Button>
                <Button
                  variant="destructive"
                  disabled={complete.isPending}
                  onClick={() =>
                    complete.mutate({
                      todoId: todo.id,
                      decision: 'reject',
                      comment: comment[todo.id] || undefined,
                    })
                  }
                >
                  <CircleX />
                  Reject
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
