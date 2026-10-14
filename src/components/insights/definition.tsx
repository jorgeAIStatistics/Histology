import type { MetricDefinition } from "@/server/queries/insights";

/**
 * "Definition" disclosure (design-spec §6.8): numerator, denominator, start
 * and end events, exclusions, still-open and missing rules, data source.
 * Native <details> so it works without JavaScript and with the keyboard.
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
    <details className="group rounded-sm border border-line bg-surface-subtle text-sm">
      <summary className="cursor-pointer select-none px-3 py-1.5 font-medium text-ink-secondary hover:text-ink">
        Definition{def.id.startsWith("M") ? ` (${def.id})` : ""}
      </summary>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 border-t border-line px-3 py-2.5">
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
