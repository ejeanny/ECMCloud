'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { trpc } from '@/lib/trpc';
import { WidgetEmpty, WidgetError, WidgetLoading } from '../widget-parts';

const DAYS = 30;

/** Bar geometry, in the SVG's own user units. */
const H = 132;
const PAD_TOP = 14;
const PAD_BOTTOM = 18;
const PAD_LEFT = 30;
const GAP = 2; // the surface gap that separates adjacent bars
const MAX_BAR = 24;

interface Day {
  key: string;
  date: Date;
  count: number;
}

/**
 * Events per day, over the last thirty days.
 *
 * One series — the day's total — because the endpoint also breaks the count
 * down by action and there are twenty-one of those: stacking them would mean
 * cycling hues past the point where anyone can tell them apart. The breakdown
 * is a click away in the audit log, which is also this chart's table view.
 *
 * Inline SVG rather than a chart library: it is one series of bars, and the
 * axis and the hit targets are a dozen lines of arithmetic.
 */
export function ActivityWidget() {
  const activity = trpc.audit.activity.useQuery({ days: DAYS });
  const [hover, setHover] = useState<number | null>(null);

  // The SVG is drawn at its own pixel size rather than scaled to fit, so the
  // 24px cap on a bar is 24 real pixels. A viewBox stretched across a wide
  // widget would scale the bars up with it and quietly break that.
  //
  // A callback ref rather than useRef + useEffect: the element does not exist
  // until the query resolves, and an effect that ran on mount would find
  // nothing to observe and leave the chart at its fallback width forever.
  const [width, setWidth] = useState(360);
  const observer = useRef<ResizeObserver | null>(null);
  const box = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => {
      setWidth(Math.max(240, Math.round(entry!.contentRect.width)));
    });
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const days = useMemo<Day[]>(() => {
    // A continuous axis: a day with no events is a zero-height bar, not a gap.
    const byDay = new Map<string, number>();
    for (const row of activity.data ?? []) {
      // There is no superjson transformer on this API, so a `Date` in the
      // router's return type is an ISO string by the time it arrives here.
      const date = new Date(row.day as unknown as string);
      if (Number.isNaN(date.getTime())) continue;
      const key = date.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + row.count);
    }

    const out: Day[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = DAYS - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      out.push({ key, date, count: byDay.get(key) ?? 0 });
    }
    return out;
  }, [activity.data]);

  if (activity.isLoading) return <WidgetLoading rows={4} />;
  if (activity.error) return <WidgetError message={activity.error.message} />;

  const total = days.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) {
    return <WidgetEmpty>No activity has been recorded in the last 30 days.</WidgetEmpty>;
  }

  const peak = Math.max(...days.map((d) => d.count));
  const top = niceCeiling(peak);
  const peakIndex = days.findIndex((d) => d.count === peak);

  const W = width;
  const plotW = W - PAD_LEFT;
  const band = plotW / days.length;
  const barW = Math.min(MAX_BAR, Math.max(2, band - GAP));
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const y = (value: number) => PAD_TOP + plotH - (value / top) * plotH;

  const shown = hover !== null ? days[hover] : null;

  return (
    <div className="p-3" ref={box}>
      {/* The readout: the hovered day, or the period's headline when idle. */}
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">
          {shown ? shown.count : total}
        </span>
        <span className="text-muted-foreground text-xs">
          {shown
            ? `event${shown.count === 1 ? '' : 's'} on ${shown.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
            : `events in the last ${DAYS} days`}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full"
        role="img"
        aria-label={`Audit events per day for the last ${DAYS} days. ${total} in total, peaking at ${peak} on ${days[peakIndex]?.date.toLocaleDateString()}.`}
        onPointerLeave={() => setHover(null)}
      >
        {/* Gridlines: hairline, solid, one step off the surface. */}
        {[0, top / 2, top].map((value) => (
          <g key={value}>
            <line
              x1={PAD_LEFT}
              x2={W}
              y1={y(value)}
              y2={y(value)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 6}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {value}
            </text>
          </g>
        ))}

        {days.map((d, i) => {
          const x = PAD_LEFT + i * band + (band - barW) / 2;
          const height = Math.max(d.count > 0 ? 2 : 0, PAD_TOP + plotH - y(d.count));
          const active = hover === i;
          return (
            <g key={d.key}>
              {d.count > 0 ? (
                <path
                  d={barPath(x, PAD_TOP + plotH - height, barW, height)}
                  className={
                    active ? 'fill-foreground' : 'fill-[var(--chart-1)] transition-colors'
                  }
                />
              ) : null}
              {/* A full-height transparent band, so the hit target is the day
                  rather than the few pixels the bar happens to occupy. */}
              <rect
                x={PAD_LEFT + i * band}
                y={PAD_TOP}
                width={band}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
              >
                <title>{`${d.date.toLocaleDateString()}: ${d.count} event${d.count === 1 ? '' : 's'}`}</title>
              </rect>
            </g>
          );
        })}

        {/* One direct label, on the extreme — never a number on every bar. */}
        {peak > 0 && hover === null ? (
          <text
            x={PAD_LEFT + peakIndex * band + band / 2}
            y={y(peak) - 4}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px] font-medium tabular-nums"
          >
            {peak}
          </text>
        ) : null}

        <line
          x1={PAD_LEFT}
          x2={W}
          y1={PAD_TOP + plotH}
          y2={PAD_TOP + plotH}
          className="stroke-border"
          strokeWidth={1}
        />

        {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
          <text
            key={i}
            x={PAD_LEFT + i * band + band / 2}
            y={H - 5}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            className="fill-muted-foreground text-[9px]"
          >
            {days[i]?.date.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
            })}
          </text>
        ))}
      </svg>
    </div>
  );
}

/**
 * A bar: rounded at the data end, square where it meets the baseline, so the
 * eye reads the bar as growing out of the axis rather than floating above it.
 */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return [
    `M ${x} ${y + h}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h}`,
    'Z',
  ].join(' ');
}

/** A round number at or above the peak, so the axis reads 0 / 10 / 20. */
function niceCeiling(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}
