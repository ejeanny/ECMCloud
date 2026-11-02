'use client';

import { Bell, BellOff, Check, CheckCheck } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

export default function NotificationsPage() {
  const utils = trpc.useUtils();
  const list = trpc.notification.list.useQuery({ skip: 0, take: 100, unreadOnly: false });

  const markViewed = trpc.notification.markViewed.useMutation({
    onSuccess: () => utils.notification.list.invalidate(),
  });
  const markAll = trpc.notification.markAllViewed.useMutation({
    onSuccess: () => utils.notification.list.invalidate(),
  });

  const unread = list.data?.unread ?? 0;

  const header = (
    <PageHeader
      title="Notifications"
      description="What the application and its workflows have told you."
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!unread || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          <CheckCheck />
          Mark all read
          {unread > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {unread}
            </Badge>
          ) : null}
        </Button>
      }
    />
  );

  if (list.isLoading) {
    return (
      <>
        {header}
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      </>
    );
  }
  if (list.error) {
    return (
      <>
        {header}
        <ErrorState message={list.error.message} />
      </>
    );
  }

  const items = list.data?.items ?? [];

  return (
    <>
      {header}

      {items.length === 0 ? (
        <EmptyState
          icon={<BellOff />}
          title="Nothing here"
          description="Workflow steps and shared documents show up on this page."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card
                className={cn(
                  'gap-2 py-4',
                  !n.isViewed && 'border-l-primary border-l-[3px]',
                )}
              >
                <div className="flex flex-wrap items-center gap-2 px-4">
                  {!n.isViewed ? (
                    <Bell className="text-primary size-3.5 shrink-0" />
                  ) : null}
                  <Badge variant="secondary">{n.type}</Badge>
                  <Badge variant="outline">{n.action}</Badge>
                  <span className="flex-1" />
                  <span className="text-muted-foreground text-xs">
                    {formatDate(n.created)}
                  </span>
                  {!n.isViewed ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={markViewed.isPending}
                      onClick={() => markViewed.mutate({ ids: [n.id] })}
                    >
                      <Check />
                      Mark read
                    </Button>
                  ) : null}
                </div>
                <p className="px-4 text-sm">{n.message}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
