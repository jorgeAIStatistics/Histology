"use client";

import { useId, useState, type ReactNode } from "react";
import { Table2, ChartColumn } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, THead, TBody, TH, TR, TD } from "@/components/ui/table";
import { IllustrativeTag } from "@/components/domain/honesty";

export interface ChartTable {
  caption: string;
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, ReactNode>[];
}

/**
 * A titled chart region with the honesty tag in the title row, a
 * "Show as table" toggle (every chart has a table view, design-spec §6.8 and
 * §9), and slots for the Definition disclosure and notes.
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
  /** Content beside the chart (stat tiles, today's live figures). */
  aside?: ReactNode;
  /** Full-width content under the chart (e.g. stat tiles too wide for the side column). */
  below?: ReactNode;
  footnote?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const regionId = useId();
  return (
    <Card
      id={id}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>{title}</span>
          <IllustrativeTag>{tag}</IllustrativeTag>
        </span>
      }
      description={subtitle}
      actions={
        <button
          type="button"
          aria-pressed={asTable}
          aria-controls={regionId}
          onClick={() => setAsTable((v) => !v)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium text-ink hover:bg-surface-subtle"
        >
          {asTable ? <ChartColumn className="size-4" aria-hidden /> : <Table2 className="size-4" aria-hidden />}
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      }
    >
      <div className={aside ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)] xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]" : undefined}>
        <div id={regionId} className="min-w-0">
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
        {aside ? <div className="min-w-0">{aside}</div> : null}
      </div>
      {below ? <div className="mt-4">{below}</div> : null}
      {footnote ? <div className="mt-3 text-sm text-ink-secondary">{footnote}</div> : null}
      {definition ? <div className="mt-3">{definition}</div> : null}
    </Card>
  );
}
