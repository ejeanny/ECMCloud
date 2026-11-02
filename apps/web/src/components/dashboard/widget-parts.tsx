'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { File as FileIcon } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { openHrefFor } from '@/components/row-actions';
import { cn } from '@/lib/utils';

/** The body every widget shows while its query is in flight. */
export function WidgetLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Nothing to show — kept quiet, since a dashboard is mostly empty states. */
export function WidgetEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-3 py-6">
      <p className="text-muted-foreground text-center text-xs">{children}</p>
    </div>
  );
}

export function WidgetError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-destructive px-3 py-6 text-center text-xs">
      {message}
    </p>
  );
}

export function WidgetList({ children }: { children: ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}

export function WidgetRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <li className={cn('hover:bg-muted/50 px-3 py-2 transition-colors', className)}>
      {children}
    </li>
  );
}

/** A document, linked the way the rest of the application links one. */
export function DocumentLink({
  node,
  children,
}: {
  node: { id: string; name: string; ext: string | null };
  children?: ReactNode;
}) {
  return (
    <Link
      href={openHrefFor(node)}
      title={node.name}
      className="hover:text-primary flex min-w-0 items-center gap-2 text-sm hover:underline"
    >
      <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {children}
    </Link>
  );
}
