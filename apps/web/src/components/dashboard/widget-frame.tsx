'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Check, GripVertical, MoreVertical, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SIZES, SIZE_LABEL, type WidgetSize } from '@/lib/dashboard';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  /** A count or status shown beside the title. */
  badge?: ReactNode;
  href?: string;
  size: WidgetSize;
  children: ReactNode;
  /** Drag handle wiring from dnd-kit; absent while the board is locked. */
  handleProps?: Record<string, unknown>;
  dragging?: boolean;
  onResize: (size: WidgetSize) => void;
  onRemove: () => void;
  className?: string;
}

/**
 * The card every widget lives in.
 *
 * Only the grip is draggable, not the whole card: a widget is full of links
 * and scrollable lists, and making the card itself the drag target would mean
 * every attempt to click a document started a drag instead.
 */
export function WidgetFrame({
  title,
  badge,
  href,
  size,
  children,
  handleProps,
  dragging,
  onResize,
  onRemove,
  className,
}: Props) {
  return (
    <section
      aria-label={title}
      className={cn(
        'bg-card flex h-full min-h-0 flex-col rounded-xl border shadow-sm transition-shadow',
        dragging && 'ring-primary/40 shadow-lg ring-2',
        className,
      )}
    >
      <header className="flex items-center gap-1.5 border-b px-3 py-2">
        {handleProps ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Move ${title}`}
                className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 -ml-1 grid size-6 shrink-0 cursor-grab place-items-center rounded-md outline-none focus-visible:ring-[3px] active:cursor-grabbing"
                {...handleProps}
              >
                <GripVertical className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Drag to move, or focus and use the arrow keys</TooltipContent>
          </Tooltip>
        ) : null}

        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>

        {badge}

        {href ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" asChild>
                <Link href={href} aria-label={`See all — ${title}`}>
                  <ArrowRight />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>See all</TooltipContent>
          </Tooltip>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`${title} options`}>
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Width
            </DropdownMenuLabel>
            {SIZES.map((option) => (
              <DropdownMenuItem key={option} onClick={() => onResize(option)}>
                {option === size ? <Check /> : <span className="size-4" />}
                {SIZE_LABEL[option]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <X />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin [&>*]:min-h-full">{children}</div>
    </section>
  );
}
