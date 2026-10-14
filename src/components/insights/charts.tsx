"use client";

import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AGE_BUCKET_LABELS, AGE_LABEL_INSIDE, AGE_RAMP, CHART, DOCTOR_COLORS } from "@/lib/tokens";
import type { PathologistColor } from "@/lib/domain";

/**
 * Insight charts (design-spec §6.8, dataviz method): one axis, no animation,
 * thin bars (max 24px) with 4px rounded data ends, recessive grid, hover and
 * focus tooltips, colors from the token mirror only. Every chart sits in a
 * ChartCard that also offers a table view.
 */

const AXIS_TICK = { fill: CHART.tick, fontSize: 12 } as const;
const AXIS_LINE = { stroke: CHART.axis } as const;
const INITIAL = { width: 640, height: 220 } as const;

interface TipRow {
  value?: unknown;
  name?: unknown;
  color?: string;
  payload?: Record<string, unknown>;
}
interface TipProps {
  active?: boolean;
  payload?: readonly TipRow[];
  label?: unknown;
}

function TooltipBox({ title, lines }: { title: ReactNode; lines: ReactNode[] }) {
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink shadow-2">
      <p className="font-semibold">{title}</p>
      {lines.map((l, i) => (
        <p key={i} className="text-ink-secondary">
          {l}
        </p>
      ))}
    </div>
  );
}

function Frame({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  return (
    <figure aria-label={label} className="m-0 w-full" style={{ height }}>
      {children}
      <figcaption className="sr-only">{label}. Use “Show as table” for every value.</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ arrivals by hour

export function ArrivalsChart({ bins, days }: { bins: { label: string; priorMean: number; priorTotal: number }[]; days: number }) {
  return (
    <Frame label={`Mean arrivals per day by hour, ${days} illustrative prior days`} height={230}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
        <BarChart data={bins} margin={{ top: 16, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} interval={0} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} width={36} />
          <Tooltip
            cursor={{ fill: CHART.grid, opacity: 0.6 }}
            content={(p) => {
              const t = p as unknown as TipProps;
              if (!t.active || !t.payload?.length) return null;
              const row = t.payload[0].payload as { label: string; priorMean: number; priorTotal: number };
              return <TooltipBox title={`${row.label} ET hour`} lines={[`${row.priorMean} per day on average`, `${row.priorTotal} over ${days} days`]} />;
            }}
          />
          <Bar dataKey="priorMean" name="Mean per day" fill={CHART.brand} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Frame>
  );
}

// ------------------------------------------------------------------ single-series columns (histogram / time of day)

export function ColumnChart({
  data,
  label,
  valueLabel,
  titleSuffix = "",
  labelTips = true,
}: {
  data: { label: string; count: number }[];
  label: string;
  valueLabel: string;
  /** Appended to the category in the tooltip title, e.g. " ET". */
  titleSuffix?: string;
  labelTips?: boolean;
}) {
  return (
    <Frame label={label} height={220}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} interval={0} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            cursor={{ fill: CHART.grid, opacity: 0.6 }}
            content={(p) => {
              const t = p as unknown as TipProps;
              if (!t.active || !t.payload?.length) return null;
              const row = t.payload[0].payload as { label: string; count: number };
              return <TooltipBox title={`${row.label}${titleSuffix}`} lines={[`${row.count} ${valueLabel}`]} />;
            }}
          />
          {/* minPointSize: recharts drops zero-height bars and their labels, so an empty bucket would read as missing data. */}
          <Bar dataKey="count" name={valueLabel} fill={CHART.brand} maxBarSize={24} radius={[4, 4, 0, 0]} minPointSize={labelTips ? 1 : 0} isAnimationActive={false}>
            {labelTips ? <LabelList dataKey="count" position="top" fill={CHART.text} fontSize={12} /> : null}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Frame>
  );
}

// ------------------------------------------------------------------ unresolved work age (stacked, ordinal ramp)

export interface WorkAgeChartRow {
  label: string;
  buckets: [number, number, number, number];
  count: number;
  ageUnknown: number;
}

export function WorkAgeLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary" aria-label="Age buckets">
      {AGE_BUCKET_LABELS.map((l, i) => (
        <li key={l} className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <rect width="12" height="12" rx="2" fill={AGE_RAMP[i]} />
          </svg>
          {l}
        </li>
      ))}
    </ul>
  );
}

const AGE_KEYS = ["b0", "b1", "b2", "b3"] as const;

/** Largest non-empty age bucket of a row (first one on a tie), or null for an empty row. */
function largestBucket(b: readonly number[]): number | null {
  let best: number | null = null;
  b.forEach((v, i) => {
    if (v > 0 && (best === null || v > b[best])) best = i;
  });
  return best;
}

interface SegmentLabelProps {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: unknown;
  index?: number;
}

export function WorkAgeChart({ rows }: { rows: WorkAgeChartRow[] }) {
  // The count is part of the category label so every row shows its total, even when a bucket is empty.
  const data = rows.map((r) => ({
    label: `${r.label} (${r.count})`,
    b0: r.buckets[0],
    b1: r.buckets[1],
    b2: r.buckets[2],
    b3: r.buckets[3],
    count: r.count,
    ageUnknown: r.ageUnknown,
    largest: largestBucket(r.buckets),
  }));
  // Direct label on each row's largest segment (design-spec §6.8); the legend names the buckets.
  const segmentLabel = (bucket: number) =>
    function SegmentLabel(p: SegmentLabelProps) {
      const row = typeof p.index === "number" ? data[p.index] : undefined;
      const [x, y, w, h] = [Number(p.x), Number(p.y), Number(p.width), Number(p.height)];
      if (!row || row.largest !== bucket || ![x, y, w, h].every(Number.isFinite) || w < 18) return null;
      const inside = AGE_LABEL_INSIDE[bucket];
      // Light steps take dark text on a surface-colored halo so the label keeps its contrast.
      return (
        <text
          x={x + w / 2}
          y={y + h / 2}
          dy="0.35em"
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill={inside ?? CHART.text}
          stroke={inside ? undefined : CHART.surface}
          strokeWidth={inside ? undefined : 3}
          paintOrder="stroke"
        >
          {String(p.value)}
        </text>
      );
    };
  const height = Math.max(160, rows.length * 34 + 40);
  return (
    <div className="flex flex-col gap-2">
      <WorkAgeLegend />
      <Frame label="Open work items by type and age bucket" height={height}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }} barCategoryGap={8}>
            <CartesianGrid horizontal={false} stroke={CHART.grid} />
            <XAxis type="number" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="label" tick={{ ...AXIS_TICK, fill: CHART.text }} axisLine={false} tickLine={false} width={270} />
            <Tooltip
              cursor={{ fill: CHART.grid, opacity: 0.6 }}
              content={(p) => {
                const t = p as unknown as TipProps;
                if (!t.active || !t.payload?.length) return null;
                const row = t.payload[0].payload as (typeof data)[number];
                return (
                  <TooltipBox
                    title={row.label}
                    lines={[
                      ...AGE_BUCKET_LABELS.map((l, i) => `${l}: ${[row.b0, row.b1, row.b2, row.b3][i]}`),
                      ...(row.ageUnknown ? [`Age unknown: ${row.ageUnknown}`] : []),
                    ]}
                  />
                );
              }}
            />
            {AGE_KEYS.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="age" name={AGE_BUCKET_LABELS[i]} fill={AGE_RAMP[i]} stroke={CHART.surface} strokeWidth={2} maxBarSize={22} isAnimationActive={false}>
                <LabelList dataKey={k} content={segmentLabel(i)} />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Frame>
    </div>
  );
}

// ------------------------------------------------------------------ cases by assigned dermatopathologist

export function DoctorChart({ rows, days }: { rows: { name: string; color: string | null; priorMean: number; priorTotal: number }[]; days: number }) {
  const height = Math.max(120, rows.length * 40 + 30);
  return (
    <Frame label={`Mean cases per day by assigned dermatopathologist over ${days} illustrative prior days`} height={height}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }} barCategoryGap={10}>
          <CartesianGrid horizontal={false} stroke={CHART.grid} />
          <XAxis type="number" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
          <YAxis type="category" dataKey="name" tick={{ ...AXIS_TICK, fill: CHART.text }} axisLine={false} tickLine={false} width={150} />
          <Tooltip
            cursor={{ fill: CHART.grid, opacity: 0.6 }}
            content={(p) => {
              const t = p as unknown as TipProps;
              if (!t.active || !t.payload?.length) return null;
              const row = t.payload[0].payload as (typeof rows)[number];
              return <TooltipBox title={row.name} lines={[`${row.priorMean} cases per day on average`, `${row.priorTotal} over ${days} days`]} />;
            }}
          />
          <Bar dataKey="priorMean" name="Mean cases per day" maxBarSize={22} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((r) => {
              const c = r.color && r.color in DOCTOR_COLORS ? DOCTOR_COLORS[r.color as PathologistColor].swatch : null;
              return <Cell key={r.name} fill={c ?? CHART.surface} stroke={c ? undefined : CHART.axis} strokeDasharray={c ? undefined : "4 2"} />;
            })}
            <LabelList dataKey="priorMean" position="right" fill={CHART.text} fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Frame>
  );
}
