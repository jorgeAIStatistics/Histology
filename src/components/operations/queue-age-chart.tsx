"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { plural } from "@/components/worklist/format";
import { Tabs, TabPanel } from "@/components/ui";
import type { QueueAgeRow } from "@/server/queries/operations";

/**
 * Queue age by stage: horizontal stacked bars in the ordinal age ramp
 * (under 1 h → over 8 h), one tooltip per stage listing every bucket, a
 * legend, sparing direct labels (only where they fit), a total at the bar tip,
 * and a table view with the same numbers. No animation. Light theme only (v1).
 * Every stage row opens the worklist filtered to that stage, which also counts the parts it matched.
 */
const RAMP_BG = ["bg-[var(--hlo-age-1)]", "bg-[var(--hlo-age-2)]", "bg-[var(--hlo-age-3)]", "bg-[var(--hlo-age-4)]"] as const;
/** Only the two dark steps carry an inside label (white clears contrast there); steps 1-2 rely on the tooltip and table. */
const LABEL_INSIDE = [false, false, true, true] as const;
const BAR_PX = 20; // <= 24px thick
const stageHref = (stage: string) => `/worklist?view=operations&stage=${encodeURIComponent(stage)}`;

export function QueueAgeChart({ rows, bucketLabels, definition, partsCounted }: { rows: QueueAgeRow[]; bucketLabels: readonly string[]; definition: string; partsCounted: number }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const unknownTotal = rows.reduce((n, r) => n + r.unknown, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary" aria-label="Legend: age since last recorded event">
          {bucketLabels.map((l, i) => (
            <li key={l} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("inline-block size-3 rounded-[2px]", RAMP_BG[i])} />
              {l}
            </li>
          ))}
        </ul>
        <Tabs
          items={[
            { key: "chart", label: "Chart" },
            { key: "table", label: "Table" },
          ]}
          active={mode}
          onChange={(k) => setMode(k as "chart" | "table")}
          label="Queue age display"
          idBase="queue-age"
          size="sm"
        />
      </div>

      <TabPanel idBase="queue-age" tabKey="chart" active={mode === "chart"}>
        <div className="flex flex-col gap-1.5" role="list" aria-label="Parts per stage by age (chart). The table view lists the same numbers.">
          {rows.map((r) => {
            const known = r.buckets.reduce((a, b) => a + b, 0);
            const widthPct = (r.total / max) * 100;
            const tip = `${r.label}: ${plural(r.total, "part")}. ${r.buckets.map((n, i) => `${bucketLabels[i]}: ${n}`).join(", ")}${r.unknown ? `, age Unknown: ${r.unknown}` : ""}.`;
            const rowClass = "grid grid-cols-[9.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-sm px-1 py-0.5";
            const cells = (
              <>
                <span className={cn("truncate text-sm", r.total ? "text-brand underline-offset-2 group-hover/bar:underline" : "text-ink-secondary")}>{r.label}</span>
                <div className="flex min-w-0 items-center">
                  {r.total === 0 ? (
                    <span className="text-xs text-ink-muted">None</span>
                  ) : (
                    <>
                      <div className="flex min-w-0 gap-[2px]" style={{ width: `${widthPct}%`, height: BAR_PX }} aria-hidden>
                        {r.buckets.map((n, i) => {
                          if (!n) return null;
                          const segPct = (n / Math.max(1, known + r.unknown)) * 100;
                          const isLast = r.buckets.slice(i + 1).every((x) => x === 0) && r.unknown === 0;
                          const fits = LABEL_INSIDE[i] && segPct * (widthPct / 100) > 6; // only label dark segments with room on both sides
                          return (
                            <span
                              key={i}
                              className={cn("flex h-full min-w-[3px] items-center justify-center text-xs font-medium", RAMP_BG[i], isLast && "rounded-r-[4px]", hover === r.stage && "brightness-110")}
                              style={{ width: `${segPct}%` }}
                            >
                              {fits ? <span className="text-white">{n}</span> : null}
                            </span>
                          );
                        })}
                        {r.unknown ? (
                          <span
                            className="flex h-full min-w-[3px] rounded-r-[4px] border border-dashed border-line-strong bg-surface"
                            style={{ width: `${(r.unknown / Math.max(1, known + r.unknown)) * 100}%` }}
                          />
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
                <span className="num-tabular text-right text-sm font-medium text-ink">{r.total || ""}</span>
              </>
            );
            return (
              <div key={r.stage} role="listitem" className="relative">
                {r.total ? (
                  <Link
                    href={stageHref(r.stage)}
                    aria-label={`${tip} Open these parts on the worklist.`}
                    onPointerEnter={() => setHover(r.stage)}
                    onPointerLeave={() => setHover((h) => (h === r.stage ? null : h))}
                    onFocus={() => setHover(r.stage)}
                    onBlur={() => setHover((h) => (h === r.stage ? null : h))}
                    className={cn(rowClass, "group/bar hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-2")}
                  >
                    {cells}
                  </Link>
                ) : (
                  <div className={rowClass}>
                    {cells}
                  </div>
                )}
                {hover === r.stage && r.total > 0 ? (
                  <div role="presentation" className="pointer-events-none absolute left-40 top-full z-20 mt-1 min-w-48 rounded-md border border-line bg-surface p-2 text-xs shadow-2">
                    <p className="mb-1 font-semibold text-ink">{r.label}</p>
                    <ul className="space-y-0.5">
                      {r.buckets.map((n, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span aria-hidden className={cn("inline-block h-0.5 w-3", RAMP_BG[i])} />
                          <span className="num-tabular font-semibold text-ink">{n}</span>
                          <span className="text-ink-secondary">{bucketLabels[i]}</span>
                        </li>
                      ))}
                      {r.unknown ? (
                        <li className="flex items-center gap-2">
                          <span aria-hidden className="inline-block h-0.5 w-3 border-t border-dashed border-line-strong" />
                          <span className="num-tabular font-semibold text-ink">{r.unknown}</span>
                          <span className="text-ink-secondary">Age Unknown</span>
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </TabPanel>

      <TabPanel idBase="queue-age" tabKey="table" active={mode === "table"}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Parts per stage by age since the last recorded event</caption>
          <thead>
            <tr className="text-left text-xs text-ink-secondary">
              <th scope="col" className="border-b border-line px-2 py-1 font-medium">Stage</th>
              {bucketLabels.map((l) => (
                <th key={l} scope="col" className="border-b border-line px-2 py-1 text-right font-medium">
                  {l}
                </th>
              ))}
              <th scope="col" className="border-b border-line px-2 py-1 text-right font-medium">Age Unknown</th>
              <th scope="col" className="border-b border-line px-2 py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage}>
                <th scope="row" className="border-b border-line px-2 py-1 text-left font-normal text-ink">
                  {r.total ? (
                    <Link href={stageHref(r.stage)} className="font-medium text-brand underline-offset-2 hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </th>
                {r.buckets.map((n, i) => (
                  <td key={i} className="num-tabular border-b border-line px-2 py-1 text-right">
                    {n}
                  </td>
                ))}
                <td className="num-tabular border-b border-line px-2 py-1 text-right">{r.unknown}</td>
                <td className="num-tabular border-b border-line px-2 py-1 text-right font-medium">{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabPanel>

      <p className="text-xs text-ink-muted">
        {plural(partsCounted, "part")} counted{unknownTotal ? `; ${unknownTotal} with Unknown age (no recorded event)` : ""}. Each stage opens its parts on the worklist. {definition}
      </p>
    </div>
  );
}
