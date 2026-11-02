import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons and links that act on the whole page. */
  actions?: ReactNode;
  className?: string;
}

/**
 * One heading treatment for every page, so a module is recognisable as part of
 * the application before you read the title.
 */
export function PageHeader({ title, description, actions, className }: Props) {
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
