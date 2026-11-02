'use client';

import { trpc } from '@/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { WidgetEmpty, WidgetError, WidgetList, WidgetLoading, WidgetRow } from '../widget-parts';

/** Queue depth per job kind, with failures called out. */
export function ServicesWidget() {
  const summary = trpc.job.summary.useQuery(undefined, { refetchInterval: 30_000 });

  if (summary.isLoading) return <WidgetLoading rows={3} />;
  if (summary.error) return <WidgetError message={summary.error.message} />;

  const byKind = new Map<string, Record<string, number>>();
  for (const row of summary.data ?? []) {
    const current = byKind.get(row.kind) ?? {};
    current[row.state] = row.count;
    byKind.set(row.kind, current);
  }

  if (byKind.size === 0) return <WidgetEmpty>No jobs have been queued.</WidgetEmpty>;

  return (
    <WidgetList>
      {[...byKind].map(([kind, states]) => {
        const queued = states.queued ?? 0;
        const running = states.running ?? 0;
        const failed = states.failed ?? 0;
        return (
          <WidgetRow key={kind}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{kind}</span>
              {running > 0 ? <Badge variant="default">{running} running</Badge> : null}
              {queued > 0 ? <Badge variant="secondary">{queued} queued</Badge> : null}
              {failed > 0 ? <Badge variant="destructive">{failed} failed</Badge> : null}
              {running + queued + failed === 0 ? (
                <Badge variant="outline">idle</Badge>
              ) : null}
            </div>
          </WidgetRow>
        );
      })}
    </WidgetList>
  );
}
