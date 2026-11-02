'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  SIZE_SPAN,
  hiddenFrom,
  serialize,
  type PlacedWidget,
  type WidgetId,
  type WidgetSize,
} from '@/lib/dashboard';
import { WIDGETS } from './registry';
import { WidgetFrame } from './widget-frame';
import { cn } from '@/lib/utils';

interface Props {
  layout: PlacedWidget[];
  allowed: ReadonlySet<WidgetId>;
  onChange: (next: PlacedWidget[]) => void;
}

/**
 * The widget board.
 *
 * dnd-kit rather than a grid library: its keyboard sensor means a widget can
 * be moved with the arrow keys from the grip, which matters in an application
 * whose file list is already fully keyboard-driven, and it brings no
 * stylesheet of its own to fight with Tailwind.
 */
export function Board({ layout, allowed, onChange }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);

  const sensors = useSensors(
    // A few pixels of slop, or every click on a grip would start a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => layout.map((w) => w.id), [layout]);

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id as WidgetId);
    const to = ids.indexOf(over.id as WidgetId);
    if (from === -1 || to === -1) return;
    onChange(arrayMove(layout, from, to));
  }

  function resize(id: WidgetId, size: WidgetSize) {
    onChange(layout.map((w) => (w.id === id ? { ...w, size } : w)));
  }

  function remove(id: WidgetId) {
    onChange(layout.filter((w) => w.id !== id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToWindowEdges]}
      onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over
              ? `${titleOf(active.id)} is over ${titleOf(over.id)}.`
              : `${titleOf(active.id)} is no longer over a slot.`,
          onDragEnd: ({ active, over }) =>
            over
              ? `${titleOf(active.id)} dropped onto ${titleOf(over.id)}.`
              : `${titleOf(active.id)} returned to where it was.`,
          onDragCancel: ({ active }) => `Move of ${titleOf(active.id)} cancelled.`,
        },
      }}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="grid auto-rows-[minmax(13rem,auto)] grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {layout
            .filter((w) => allowed.has(w.id))
            .map((widget) => (
              <SortableWidget
                key={widget.id}
                widget={widget}
                dragging={dragging === widget.id}
                onResize={(size) => resize(widget.id, size)}
                onRemove={() => remove(widget.id)}
              />
            ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function titleOf(id: string | number): string {
  return WIDGETS[id as WidgetId]?.title ?? String(id);
}

function SortableWidget({
  widget,
  dragging,
  onResize,
  onRemove,
}: {
  widget: PlacedWidget;
  dragging: boolean;
  onResize: (size: WidgetSize) => void;
  onRemove: () => void;
}) {
  const meta = WIDGETS[widget.id];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.id });

  const Body = meta.Body;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        SIZE_SPAN[widget.size],
        'min-h-0',
        // The original keeps its place in the flow but gets out of the way
        // visually, so the gap the widget will land in is the thing on screen.
        isDragging && 'z-10 opacity-60',
      )}
    >
      <WidgetFrame
        title={meta.title}
        href={meta.href}
        size={widget.size}
        dragging={dragging || isDragging}
        handleProps={{ ...attributes, ...listeners }}
        onResize={onResize}
        onRemove={onRemove}
      >
        <Body />
      </WidgetFrame>
    </div>
  );
}

/** Keeps the saved layout in step with the board, without saving on every frame. */
export function useLayoutPersistence(
  layout: PlacedWidget[],
  allowed: ReadonlySet<WidgetId>,
  save: (value: Record<string, unknown>) => void,
  ready: boolean,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef<string>('');

  const flush = useCallback(
    (next: PlacedWidget[]) => {
      const payload = serialize(next, hiddenFrom(next, allowed));
      const encoded = JSON.stringify(payload);
      if (encoded === last.current) return;
      last.current = encoded;
      save(payload as unknown as Record<string, unknown>);
    },
    [allowed, save],
  );

  useEffect(() => {
    if (!ready) return;
    if (timer.current) clearTimeout(timer.current);
    // A drag emits one change, but resizing and adding can come in bursts;
    // half a second collapses those into a single write.
    timer.current = setTimeout(() => flush(layout), 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [layout, ready, flush]);
}
