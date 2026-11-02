'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface Props {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  /** Shown beside the page count, e.g. "1–50 of 312". */
  summary?: string;
}

/** Previous/next paging, one component so every list pages the same way. */
export function Pager({ page, pageCount, onPage, summary }: Props) {
  if (pageCount <= 1) {
    return summary ? (
      <p className="text-muted-foreground mt-3 text-xs">{summary}</p>
    ) : null;
  }

  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs">
        {summary ?? `Page ${page + 1} of ${pageCount}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
          Previous
        </Button>
        <span className="text-muted-foreground text-xs tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page + 1 >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
