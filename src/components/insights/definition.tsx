import { ChevronRight } from "lucide-react";
import type { MetricDefinition } from "@/server/queries/insights";

/**
 * "Definition" disclosure (design-spec §6.8): numerator, denominator, start
 * and end events, exclusions, still-open and missing rules, data source.
 * Native <details> so it works without JavaScript and with the keyboard. It
 * sits in the footer of its chart sheet, under a hairline, not in a box.
 */
export function DefinitionDisclosure({ def }: { def: MetricDefinition }) {
  const rows: [string, string][] = [
    ["Numerator", def.numerator],
    ["Denominator", def.denominator],
    ["Start event", def.startEvent],
    ["End event", def.endEvent],
    ["Exclusions", def.exclusions],
    ["Still-open items", def.stillOpen],
    ["Missing events", def.missing],
    ["Data source", def.dataSource],
    ["Summary", def.summary],
    ["Relates to", def.relatesTo],
  ];
  return (
    <details className="group text-sm">
      <summary className="-mx-1 flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer list-none items-center gap-1.5 rounded-sm px-1 font-medium text-ink-secondary select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform duration-[var(--hlo-duration-fast)] group-open:rotate-90" aria-hidden />
        Definition: {def.name}
        {def.id.startsWith("M") ? <span className="font-normal text-ink-muted">({def.id})</span> : null}
      </summary>
      <dl className="mt-1 mb-2 grid max-w-[110ch] grid-cols-[minmax(7.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 pl-6">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
