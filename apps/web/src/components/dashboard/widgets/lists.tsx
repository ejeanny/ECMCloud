'use client';

import Link from 'next/link';
import { Folder, Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { formatBytes, formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import {
  DocumentLink,
  WidgetEmpty,
  WidgetError,
  WidgetList,
  WidgetLoading,
  WidgetRow,
} from '../widget-parts';

/** Workflow steps waiting on this user. */
export function TasksWidget() {
  const todos = trpc.workflow.myTodos.useQuery({ skip: 0, take: 6 });

  if (todos.isLoading) return <WidgetLoading />;
  if (todos.error) return <WidgetError message={todos.error.message} />;

  const items = todos.data?.items ?? [];
  if (items.length === 0) return <WidgetEmpty>Nothing is waiting on you.</WidgetEmpty>;

  return (
    <WidgetList>
      {items.map((todo) => (
        <WidgetRow key={todo.id}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {todo.task.name}
            </span>
            <Badge variant="secondary">{todo.task.type}</Badge>
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {todo.instance.node.name} · {todo.instance.workflow.name}
          </p>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}

/** What the application has told this user lately. */
export function NotificationsWidget() {
  const list = trpc.notification.list.useQuery({ skip: 0, take: 6, unreadOnly: false });

  if (list.isLoading) return <WidgetLoading />;
  if (list.error) return <WidgetError message={list.error.message} />;

  const items = list.data?.items ?? [];
  if (items.length === 0) return <WidgetEmpty>Nothing here.</WidgetEmpty>;

  return (
    <WidgetList>
      {items.map((n) => (
        <WidgetRow key={n.id}>
          <div className="flex items-start gap-2">
            {!n.isViewed ? (
              <span
                aria-label="Unread"
                className="bg-primary mt-1.5 size-1.5 shrink-0 rounded-full"
              />
            ) : (
              <span className="mt-1.5 size-1.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{n.message}</p>
              <p className="text-muted-foreground text-xs">{formatDate(n.created)}</p>
            </div>
          </div>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}

/** Documents this user holds the lock on. */
export function CheckoutsWidget() {
  const checkouts = trpc.version.myCheckOuts.useQuery();

  if (checkouts.isLoading) return <WidgetLoading />;
  if (checkouts.error) return <WidgetError message={checkouts.error.message} />;

  const items = checkouts.data ?? [];
  if (items.length === 0) {
    return <WidgetEmpty>You have nothing checked out.</WidgetEmpty>;
  }

  return (
    <WidgetList>
      {items.slice(0, 6).map((item) => (
        <WidgetRow key={item.checkoutId}>
          <DocumentLink node={item.node}>
            <Lock className="text-muted-foreground size-3 shrink-0" />
          </DocumentLink>
          <p className="text-muted-foreground mt-0.5 text-xs">
            since {formatDate(item.since)}
          </p>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}

/** The documents this user opened last. */
export function RecentWidget() {
  const recents = trpc.workspace.recents.useQuery({ skip: 0, take: 8 });

  if (recents.isLoading) return <WidgetLoading rows={5} />;
  if (recents.error) return <WidgetError message={recents.error.message} />;

  const items = recents.data?.items ?? [];
  if (items.length === 0) {
    return <WidgetEmpty>Documents you open will be listed here.</WidgetEmpty>;
  }

  return (
    <WidgetList>
      {items.map(({ node, viewedAt }) => (
        <WidgetRow key={node.id}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <DocumentLink node={node} />
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">
              {formatDate(viewedAt)}
            </span>
          </div>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}

/** Starred documents. */
export function FavoritesWidget() {
  const favorites = trpc.workspace.favorites.useQuery({ skip: 0, take: 6 });

  if (favorites.isLoading) return <WidgetLoading />;
  if (favorites.error) return <WidgetError message={favorites.error.message} />;

  const items = favorites.data?.items ?? [];
  if (items.length === 0) return <WidgetEmpty>No favourites yet.</WidgetEmpty>;

  return (
    <WidgetList>
      {items.map(({ node }) => (
        <WidgetRow key={node.id}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <DocumentLink node={node} />
            </div>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {formatBytes(node.byteLength)}
            </span>
          </div>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}

/** The cabinets this user can reach, pinned ones first. */
export function CabinetsWidget() {
  const cabinets = trpc.cabinet.list.useQuery();

  if (cabinets.isLoading) return <WidgetLoading rows={4} />;
  if (cabinets.error) return <WidgetError message={cabinets.error.message} />;

  const items = [...(cabinets.data ?? [])].sort(
    (a, b) => Number(b.isPinned) - Number(a.isPinned) || a.name.localeCompare(b.name),
  );
  if (items.length === 0) {
    return <WidgetEmpty>No cabinet is accessible to you.</WidgetEmpty>;
  }

  return (
    <WidgetList>
      {items.slice(0, 8).map((c) => (
        <WidgetRow key={c.id}>
          <Link
            href={`/c/${c.id}`}
            className="hover:text-primary flex items-center gap-2 text-sm hover:underline"
          >
            <Folder className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.isPinned ? <Badge variant="secondary">pinned</Badge> : null}
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {c.indexFieldCount} fields
            </span>
          </Link>
        </WidgetRow>
      ))}
    </WidgetList>
  );
}
