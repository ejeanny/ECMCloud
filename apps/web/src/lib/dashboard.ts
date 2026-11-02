import type { ComponentType } from 'react';

/**
 * The dashboard's layout model.
 *
 * A widget is identified by a stable id and carries a width; the order of the
 * array is the order on screen. That is the whole model — deliberately not
 * free-form x/y coordinates, because those have to be re-solved every time the
 * viewport changes and this grid has to survive a phone.
 */
export type WidgetId =
  | 'tasks'
  | 'notifications'
  | 'checkouts'
  | 'recent'
  | 'favorites'
  | 'cabinets'
  | 'activity'
  | 'services';

export type WidgetSize = 'sm' | 'md' | 'lg';

export interface PlacedWidget {
  id: WidgetId;
  size: WidgetSize;
}

/** Columns a size occupies in the three-column grid. */
export const SIZE_SPAN: Record<WidgetSize, string> = {
  sm: 'md:col-span-1',
  md: 'md:col-span-2 xl:col-span-1',
  lg: 'md:col-span-2 xl:col-span-3',
};

export const SIZE_LABEL: Record<WidgetSize, string> = {
  sm: 'Small',
  md: 'Medium',
  lg: 'Wide',
};

export const SIZES: WidgetSize[] = ['sm', 'md', 'lg'];

export interface WidgetMeta {
  id: WidgetId;
  title: string;
  description: string;
  /** Where "See all" goes, when the widget is a summary of a fuller page. */
  href?: string;
  /** Rights gate; undefined means every signed-in user may see it. */
  requires?: 'View_Audit_Log' | 'Services_Logs';
  defaultSize: WidgetSize;
  Body: ComponentType;
}

/** What a user who has never touched the dashboard sees. */
export const DEFAULT_LAYOUT: PlacedWidget[] = [
  { id: 'tasks', size: 'sm' },
  { id: 'checkouts', size: 'sm' },
  { id: 'notifications', size: 'sm' },
  { id: 'recent', size: 'md' },
  { id: 'cabinets', size: 'md' },
  { id: 'favorites', size: 'sm' },
  { id: 'activity', size: 'lg' },
  { id: 'services', size: 'sm' },
];

/** The key this layout occupies inside the per-user settings blob. */
export const SETTINGS_KEY = 'dashboard';

interface StoredDashboard {
  widgets?: unknown;
}

/**
 * Turns whatever is stored into a layout that can actually be rendered.
 *
 * Stored layouts outlive the code that wrote them: a widget can be renamed or
 * withdrawn, a user can lose the right that let them see one, and the blob is
 * typed `Json` so it can be anything at all. Rather than trusting it, the
 * stored order is treated as a preference applied over the known widgets —
 * unknown ids are dropped, and widgets added to the application since the
 * layout was saved appear at the end instead of silently never showing up.
 */
export function normalizeLayout(
  stored: unknown,
  allowed: ReadonlySet<WidgetId>,
): PlacedWidget[] {
  const raw = (stored as StoredDashboard | undefined)?.widgets;
  const fromStore: PlacedWidget[] = Array.isArray(raw)
    ? raw.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { id, size } = entry as { id?: unknown; size?: unknown };
        if (typeof id !== 'string' || !allowed.has(id as WidgetId)) return [];
        return [
          {
            id: id as WidgetId,
            size: SIZES.includes(size as WidgetSize) ? (size as WidgetSize) : 'sm',
          },
        ];
      })
    : [];

  // A stored layout is a statement about the widgets it names, not about the
  // ones it has never seen; `hidden` is what the user actually removed.
  const seen = new Set(fromStore.map((w) => w.id));
  const everStored = new Set(
    Array.isArray(raw)
      ? raw.flatMap((e) =>
          typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string'
            ? [(e as { id: string }).id]
            : [],
        )
      : [],
  );
  const hidden = new Set(
    (stored as { hidden?: unknown } | undefined)?.hidden instanceof Array
      ? ((stored as { hidden: unknown[] }).hidden.filter(
          (h) => typeof h === 'string',
        ) as string[])
      : [],
  );

  const appended = DEFAULT_LAYOUT.filter(
    (w) => allowed.has(w.id) && !seen.has(w.id) && !hidden.has(w.id) && !everStored.has(w.id),
  );

  const layout = [...fromStore, ...appended];
  // Nothing stored yet, and nothing deliberately hidden: start from the default.
  if (layout.length === 0 && hidden.size === 0) {
    return DEFAULT_LAYOUT.filter((w) => allowed.has(w.id));
  }
  return layout;
}

/** The widgets a user has removed — everything allowed that is not placed. */
export function hiddenFrom(
  layout: PlacedWidget[],
  allowed: ReadonlySet<WidgetId>,
): WidgetId[] {
  const placed = new Set(layout.map((w) => w.id));
  return [...allowed].filter((id) => !placed.has(id));
}

export function serialize(layout: PlacedWidget[], hidden: WidgetId[]) {
  return { widgets: layout, hidden };
}
