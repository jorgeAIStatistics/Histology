"use client";

import { useId, useState, type ReactNode } from "react";
import { Table2, ChartColumn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, THead, TBody, TH, TR, TD } from "@/components/ui/table";
import { IllustrativeTag } from "@/components/domain/honesty";

export interface ChartTable {
  caption: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, ReactNode>[];
}

/**
 * One measure as one evidence sheet: the title with its honesty tag, a
 * "Show as table" toggle (every chart has a table view, design-spec §6.8 and
 * §9), the chart with today's figures beside it behind a hairline (never a
 * box inside the sheet), full-width comparisons below, and the Definition
 * disclosure in the footer.
 */
export function ChartCard({
  id,
  title,
  tag = "Illustrative: synthetic prior-day data",
  subtitle,
  chart,
  table,
  definition,
  aside,
  below,
  footnote,
}: {
  id: string;
  title: string;
  /** Honesty tag shown next to the title. */
  tag?: string;
  subtitle?: ReactNode;
  chart: ReactNode;
  table: ChartTable;
  definition?: ReactNode;
  /** Content beside the chart (today's figures), behind a hairline. */
  aside?: ReactNode;
  /** Full-width content under the chart (the prior-day vs today comparison). */
  below?: ReactNode;
  footnote?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  // Animate only a swap the person asked for, never the first paint.
  const [swapped, setSwapped] = useState(false);
  const regionId = useId();
  return (
    <Card
      id={id}
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{title}</span>
          <IllustrativeTag className="font-medium tracking-normal">{tag}</IllustrativeTag>
        </span>
      }
      description={subtitle}
      actions={
        <Button
          size="sm"
          variant="secondary"
          aria-pressed={asTable}
          aria-controls={regionId}
          icon={asTable ? <ChartColumn /> : <Table2 />}
          onClick={() => {
            setAsTable((v) => !v);
            setSwapped(true);
          }}
        >
          {asTable ? "Show as chart" : "Show as table"}
        </Button>
      }
      footer={definition}
    >
      <div className={aside ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)] xl:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)]" : undefined}>
        {/* Keyed on the view so the swap the person asked for is visible (reduced motion removes it). */}
        <div id={regionId} key={asTable ? "table" : "chart"} className={swapped ? "min-w-0 animate-swap-in" : "min-w-0"}>
          {asTable ? (
            <Table caption={table.caption} maxHeight="320px">
              <THead>
                <TR>
                  {table.columns.map((c) => (
                    <TH key={c.key} align={c.numeric ? "right" : "left"}>
                      {c.label}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {table.rows.map((r, i) => (
                  <TR key={i}>
                    {table.columns.map((c) => (
                      <TD key={c.key} numeric={c.numeric}>
                        {r[c.key]}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            chart
          )}
        </div>
        {aside ? <div className="min-w-0 border-t border-line pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">{aside}</div> : null}
      </div>
      {below ? <div className="mt-4">{below}</div> : null}
      {footnote ? <div className="mt-3 max-w-[100ch] text-sm text-ink-secondary">{footnote}</div> : null}
    </Card>
  );
}
