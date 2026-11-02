'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Plus, RotateCcw } from 'lucide-react';

import { Board, useLayoutPersistence } from '@/components/dashboard/board';
import { WIDGETS, WIDGET_IDS } from '@/components/dashboard/registry';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DEFAULT_LAYOUT,
  SETTINGS_KEY,
  hiddenFrom,
  normalizeLayout,
  serialize,
  type PlacedWidget,
  type WidgetId,
} from '@/lib/dashboard';
import { trpc } from '@/lib/trpc';

/**
 * The landing page: what a user sees the moment they sign in.
 *
 * The layout is per user and lives in the `workspace.settings` blob the API
 * already keeps, so it follows someone between browsers and machines rather
 * than living in the local storage of whichever one they happened to arrange
 * it on.
 */
export default function DashboardPage() {
  const me = trpc.session.me.useQuery();
  const settings = trpc.workspace.settings.useQuery();
  const utils = trpc.useUtils();

  const saveSettings = trpc.workspace.saveSettings.useMutation({
    onSuccess: () => utils.workspace.settings.invalidate(),
  });

  // Which widgets this user is allowed to be shown at all.
  const allowed = useMemo(() => {
    const rights = new Set(me.data?.systemRights ?? []);
    const isAdmin = me.data?.isAdministrator ?? false;
    return new Set(
      WIDGET_IDS.filter((id) => {
        const needs = WIDGETS[id].requires;
        return !needs || isAdmin || rights.has(needs);
      }),
    );
  }, [me.data]);

  const [layout, setLayout] = useState<PlacedWidget[] | null>(null);

  // The stored layout arrives after the first paint; adopt it once, then let
  // the board own the state so dragging never waits on a round trip.
  useEffect(() => {
    if (layout !== null || !settings.isSuccess || !me.isSuccess) return;
    setLayout(normalizeLayout(settings.data?.[SETTINGS_KEY], allowed));
  }, [layout, settings.isSuccess, settings.data, me.isSuccess, allowed]);

  // The rest of the settings blob, kept in a ref so `persist` has a stable
  // identity: it feeds an effect, and a new function every render would reset
  // the debounce timer forever and never write anything.
  const otherSettings = useRef<Record<string, unknown>>({});
  useEffect(() => {
    if (settings.data) otherSettings.current = settings.data;
  }, [settings.data]);

  /** Merge into the blob rather than replacing it; other preferences live there too. */
  const persist = useCallback(
    (dashboard: Record<string, unknown>) => {
      saveSettings.mutate({
        settings: { ...otherSettings.current, [SETTINGS_KEY]: dashboard },
      });
    },
    // `mutate` is stable across renders in react-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutPersistence(layout ?? [], allowed, persist, layout !== null);

  const hidden = layout ? hiddenFrom(layout, allowed) : [];

  function add(id: WidgetId) {
    setLayout((current) => [...(current ?? []), { id, size: WIDGETS[id].defaultSize }]);
  }

  function reset() {
    const fresh = DEFAULT_LAYOUT.filter((w) => allowed.has(w.id));
    setLayout(fresh);
    // Written straight through: the debounce would also do it, but a reset is
    // the one action where seeing it not stick would be alarming.
    persist(serialize(fresh, hiddenFrom(fresh, allowed)) as unknown as Record<string, unknown>);
  }

  const greeting = me.data
    ? `${me.data.user.firstName || me.data.user.userName}`.trim()
    : '';

  const header = (
    <PageHeader
      title={greeting ? `Welcome back, ${greeting}` : 'Dashboard'}
      description="Drag a widget by its grip to rearrange the board. The layout is saved against your account."
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={hidden.length === 0}>
                <Plus />
                Add widget
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                Not on your board
              </DropdownMenuLabel>
              {hidden.map((id) => (
                <DropdownMenuItem
                  key={id}
                  className="flex-col items-start gap-0.5"
                  onClick={() => add(id)}
                >
                  <span className="font-medium">{WIDGETS[id].title}</span>
                  <span className="text-muted-foreground text-xs">
                    {WIDGETS[id].description}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw />
            Reset layout
          </Button>
        </>
      }
    />
  );

  if (layout === null) {
    return (
      <>
        {header}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      {layout.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid />}
          title="Your board is empty"
          description="Add a widget to build the view you want, or put the default board back."
          action={
            <Button size="sm" onClick={reset}>
              <RotateCcw />
              Reset layout
            </Button>
          }
        />
      ) : (
        <Board layout={layout} allowed={allowed} onChange={setLayout} />
      )}
    </>
  );
}
