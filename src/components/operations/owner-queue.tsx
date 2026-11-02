"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { plural } from "@/components/worklist/format";
import type { OwnerQueue as OwnerQueueRow } from "@/server/queries/operations";

/**
 * Waiting work by owner: one horizontal stacked bar per person in the ordinal
 * age ramp (under 1 h → over 8 h, one hue light→dark, validated as ordinal),
 * a legend, direct labels only on dark segments with room, the total at the
 * bar end, a per-row hover/focus tooltip and a table view with the same
 * numbers. Sorted by name, unassigned last: not a ranking. No animation.
 * Each row opens the blocked list filtered to that person.
 */
const RAMP_BG = ["bg-[var(--hlo-age-1)]", "bg-[var(--hlo-age-2)]", "bg-[var(--hlo-age-3)]", "bg-[var(--hlo-age-4)]"] as const;
const LABEL_INSIDE = [false, false, true, true] as const;
const BAR_PX = 18;

export function OwnerQueue({ rows, bucketLabels, definition, activeKey = null }: { rows: OwnerQueueRow[]; bucketLabels: readonly string[]; definition: string; activeKey?: string | null }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section aria-labelledby="owners-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h2 id="owners-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Waiting by owner
        </h2>
        <div role="group" aria-label="Show as" className="inline-flex rounded-md border border-line p-0.5">
          {(["chart", "table"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-[calc(var(--hlo-target-min)-6px)] rounded-sm px-2.5 text-sm font-medium transition-colors duration-[var(--hlo-duration-fast)]",
                mode === m ? "bg-shell text-white" : "text-ink-secondary hover:bg-surface-subtle hover:text-ink",
              )}
            >
              {m === "chart" ? "Chart" : "Table"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-4 pt-2 pb-3">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nobody holds a blocked or waiting item right now.</p>
        ) : (
          <>
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary" aria-label="Legend: time waited">
              {bucketLabels.map((l, i) => (
                <li key={l} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={cn("inline-block size-3 rounded-[2px]", RAMP_BG[i])} />
                  {l}
                </li>
              ))}
            </ul>

            {mode === "chart" ? (
              <ul className="flex flex-col gap-0.5" aria-label="Blocked and waiting items per owner by time waited (chart). The table view lists the same numbers.">
                {rows.map((r, rowIndex) => {
                  const known = r.buckets.reduce((a, b) => a + b, 0);
                  // A one-segment bar already says its number at the bar end: no second label inside it.
                  const segments = r.buckets.filter((n) => n > 0).length + (r.unknown ? 1 : 0);
                  // Lower rows open the tooltip upward so it never covers the next section's heading.
                  const tipAbove = rowIndex >= Math.ceil(rows.length / 2);
                  const widthPct = (r.total / max) * 100;
                  const tip = `${r.owner}: ${plural(r.total, "item")}${r.holds ? `, ${r.holds} on hold` : ""}. ${r.buckets.map((n, i) => `${bucketLabels[i]}: ${n}`).join(", ")}${r.unknown ? `, Unknown: ${r.unknown}` : ""}. Longest ${r.oldestAge}.`;
                  return (
                    <li key={r.key} className="relative">
                      <Link
                        href={r.href}
                        scroll={false}
                        aria-label={`${tip} Show these items.`}
                        aria-current={activeKey === r.key ? "true" : undefined}
                        onPointerEnter={() => setHover(r.key)}
                        onPointerLeave={() => setHover((h) => (h === r.key ? null : h))}
                        onFocus={() => setHover(r.key)}
                        onBlur={() => setHover((h) => (h === r.key ? null : h))}
                        className={cn(
                          "group/bar grid min-h-[var(--hlo-target-min)] grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2rem] items-center gap-2.5 rounded-sm px-1 py-1 hover:bg-surface-subtle focus-visible:bg-surface-subtle",
                          activeKey === r.key && "bg-brand-50 shadow-[inset_0_0_0_1px_var(--hlo-brand-100)] hover:bg-brand-50",
                        )}
                      >
                        <span className={cn("min-w-0 text-sm leading-[1.1rem] group-hover/bar:underline underline-offset-2", r.unassigned ? "font-semibold text-ink" : "text-brand")}>{r.owner}</span>
                        <span className="flex min-w-0 gap-[2px]" style={{ width: `${widthPct}%`, height: BAR_PX }} aria-hidden>
                          {r.buckets.map((n, i) => {
                            if (!n) return null;
                            const segPct = (n / Math.max(1, known + r.unknown)) * 100;
                            const isLast = r.buckets.slice(i + 1).every((x) => x === 0) && r.unknown === 0;
                            const fits = segments > 1 && LABEL_INSIDE[i] && segPct * (widthPct / 100) > 12;
                            return (
                              <span
                                key={i}
                                className={cn("flex h-full min-w-[3px] items-center justify-center text-xs font-medium", RAMP_BG[i], isLast && "rounded-r-[4px]")}
                                style={{ width: `${segPct}%` }}
                              >
                                {fits ? <span className="text-white">{n}</span> : null}
                              </span>
                            );
                          })}
                          {r.unknown ? (
                            <span
                              className="flex h-full min-w-[3px] rounded-r-[4px] border border-line-strong bg-surface"
                              style={{ width: `${(r.unknown / Math.max(1, known + r.unknown)) * 100}%` }}
                            />
                          ) : null}
                        </span>
                        <span className="num-tabular text-right text-sm font-semibold text-ink">{r.total}</span>
                      </Link>
                      {hover === r.key ? (
                        <div role="presentation" className={cn(
                            "pointer-events-none absolute left-8 z-20 min-w-52 rounded-md border border-line bg-surface p-2 text-xs shadow-2 animate-fade-in",
                            tipAbove ? "bottom-full mb-0.5" : "top-full mt-0.5",
                          )}>
                          <p className="mb-1 font-semibold text-ink">{r.owner}</p>
                          <ul className="space-y-0.5">
                            {r.buckets.map((n, i) => (
                              <li key={i} className="flex items-center gap-2">
                                <span aria-hidden className={cn("inline-block h-0.5 w-3", RAMP_BG[i])} />
                                <span className="num-tabular w-4 text-right font-semibold text-ink">{n}</span>
                                <span className="text-ink-secondary">{bucketLabels[i]}</span>
                              </li>
                            ))}
                            {r.unknown ? (
                              <li className="flex items-center gap-2">
                                <span aria-hidden className="inline-block h-0.5 w-3 bg-line-strong" />
                                <span className="num-tabular w-4 text-right font-semibold text-ink">{r.unknown}</span>
                                <span className="text-ink-secondary">Unknown</span>
                              </li>
                            ) : null}
                          </ul>
                          <p className="mt-1 text-ink-secondary">
                            Longest <span className="font-semibold text-ink">{r.oldestAge}</span>
                            {r.holds ? `; ${r.holds} on hold` : ""}
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">Blocked and waiting items per owner by time waited</caption>
                <thead>
                  <tr className="text-left text-xs text-ink-secondary">
                    <th scope="col" className="border-b border-line px-1.5 py-1 font-medium">
                      Owner
                    </th>
                    {bucketLabels.map((l) => (
                      <th key={l} scope="col" className="border-b border-line px-1.5 py-1 text-right font-medium">
                        {l}
                      </th>
                    ))}
                    <th scope="col" className="border-b border-line px-1.5 py-1 text-right font-medium">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="border-b border-line px-1.5 py-1 text-left font-normal">
                        <Link href={r.href} scroll={false} className="text-brand underline-offset-2 hover:underline">
                          {r.owner}
                        </Link>
                      </th>
                      {r.buckets.map((n, i) => (
                        <td key={i} className={cn("num-tabular border-b border-line px-1.5 py-1 text-right", n ? "text-ink" : "text-ink-muted")}>
                          {n}
                        </td>
                      ))}
                      <td className="num-tabular border-b border-line px-1.5 py-1 text-right font-semibold">{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <p className="text-xs text-ink-muted">{definition}</p>
      </div>
    </section>
  );
}
