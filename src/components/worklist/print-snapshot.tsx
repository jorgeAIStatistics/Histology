import { cn } from "@/lib/cn";
import type { PathologistColor } from "@/lib/domain";
import { DoctorSwatch, isPathologistColor } from "@/components/domain/doctor-chip";
import type { WorklistData } from "@/server/queries/worklist";
import { describeFilters } from "./views";
import { fmtSnapshotTime, plural } from "./format";

/**
 * Printed snapshot (downtime / transition fallback). Visible only in print.
 * Reads like the paper "bible" on a colour printer: a two-level header (title
 * and generation line, then view, filters, rows and the source data age), one
 * section per doctor opened by a heavy rule in the doctor's colour with the
 * swatch, name and colour word on a neutral ground (yellow stays PAS-only), and
 * PAS rows in pale yellow. It still works in grayscale: doctor sections carry
 * the color NAME, PAS is a bordered "PAS" box with its work order, material and
 * request source ("Source: Source order"), holds are a bordered "HOLD" box with
 * the scope, and canceled work needing review carries a bordered "REVIEW" box.
 * Stage is read from the Parts column, as on screen.
 */

/** The doctor's colour as the section's heavy top rule (never a fill: on paper too, yellow means PAS). */
const SECTION_RULE: Record<PathologistColor, string> = {
  teal: "border-t-dr-teal",
  violet: "border-t-dr-violet",
  amber: "border-t-dr-amber",
};
export interface PrintMeta {
  displayId: string | null;
  seq: number;
  generatedAt: string;
  generatedBy: string;
  dataAsOf: string | null;
  stale: boolean;
}

export function PrintSnapshot({ data, meta }: { data: WorklistData; meta: PrintMeta }) {
  const doctorName = (id: string) => data.doctors.find((d) => d.id === id)?.name;
  const rows = data.groups.reduce((n, g) => n + g.rows.length, 0);
  const filtersText = describeFilters(data.filters, doctorName);
  return (
    <section className="print-only text-[11px] leading-snug text-ink [print-color-adjust:exact] [-webkit-print-color-adjust:exact]" aria-hidden="true">
      <header className="mb-3 border-b-2 border-ink pb-2">
        {/* Level one: what this paper is and when it was made. DOM order keeps the title and its generation line as one sentence run. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-6">
          <p className="col-start-1 row-start-1 text-[20px] font-bold leading-tight tracking-[-0.01em]">
            Worklist snapshot v{meta.seq}
            <span className="sr-only">.</span>
          </p>
          <p className="col-start-1 row-start-2 text-[12px]">
            Generated {fmtSnapshotTime(meta.generatedAt)} by {meta.generatedBy}. <span className="font-semibold">Not updated after printing.</span>
          </p>
          <p className="col-start-2 row-span-2 row-start-1 self-start text-right text-[12px]">
            {meta.displayId ? (
              <>
                Snapshot <span className="id-mono font-semibold">{meta.displayId}</span> recorded.
              </>
            ) : (
              "Not recorded as a snapshot (use \"Print snapshot\" to record version and time)."
            )}
          </p>
        </div>
        {/* Level two: what the paper shows and how old its source data is. */}
        <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-0.5 border-t border-line pt-1">
          <p>
            <span className="font-semibold">View</span> {data.viewLabel}
          </p>
          <p>
            <span className="font-semibold">Filters</span> {filtersText === "no filters" ? "None" : filtersText}
          </p>
          <p>
            <span className="font-semibold">Rows</span> {rows}
          </p>
          <p className={cn(meta.stale && "font-semibold")}>
            Source data as of {meta.dataAsOf ? fmtSnapshotTime(meta.dataAsOf) : "Unknown"}
            {meta.stale ? (
              <>
                . <span className="border border-ink px-0.5">STALE</span> a simulated source system was unreachable or out of date when this was generated.
              </>
            ) : (
              ". Simulated source."
            )}
          </p>
        </div>
      </header>
      {data.groups.map((g) => (
        <div key={g.key} className="mb-4 break-inside-avoid-page">
          <h2
            className={cn(
              "flex items-center gap-2 border-b border-ink bg-surface-subtle px-1.5 py-1",
              isPathologistColor(g.colorToken) ? cn("border-t-4", SECTION_RULE[g.colorToken]) : "border-t-2 border-dashed border-t-ink",
            )}
          >
            <DoctorSwatch color={g.colorToken} className="size-3.5" />
            <span className="text-[14px] font-bold">
              {g.kind === "routing_exception" ? "Unassigned: routing exception" : g.name}
              <span className="font-normal"> ({g.kind === "doctor" ? g.colorName ?? "no color" : "no doctor color"})</span>
            </span>
            <span className="ml-auto text-[11px] font-normal">
              {plural(g.counts.rows, g.kind === "routing_exception" ? "item" : "case")}, {g.counts.pas} PAS, {g.counts.onHold} on hold
              {g.counts.pasReview ? `, ${g.counts.pasReview} canceled or amended PAS to review` : ""}
            </span>
          </h2>
          {/* Fixed column widths so every doctor's section lines up on paper. */}
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[9%]" />
              <col className="w-[6%]" />
              <col className="w-[16%]" />
              <col className="w-[24%]" />
              <col className="w-[11%]" />
              <col className="w-[18%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
            </colgroup>
            <thead>
              <tr className="text-left">
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Case</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Change</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Parts and stage</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Stains (work orders)</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Holds</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Readiness</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Owner</th>
                <th className="border-b border-ink py-0.5 font-semibold">Last update</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id} className={cn("align-top", r.hasPas && "bg-pas-row")}>
                  <td className="border-b border-line py-0.5 pr-2">
                    <span className="id-mono font-semibold">{r.accessionNumber ?? r.provisionalId}</span>
                    {r.accessionNumber ? null : <span className="block">(provisional)</span>}
                  </td>
                  <td className="border-b border-line py-0.5 pr-2">{r.changeTags.map((t) => t[0].toUpperCase() + t.slice(1)).join(", ")}</td>
                  <td className="border-b border-line py-0.5 pr-2">{r.partsSummary}</td>
                  <td className="border-b border-line py-0.5 pr-2">
                    {r.stains.length
                      ? r.stains.map((s, i) => (
                          <span key={i} className="mr-1 inline-block">
                            {s.isPas ? (
                              <span className={`border border-ink px-0.5 font-semibold ${s.canceled ? "line-through" : ""}`}>PAS</span>
                            ) : (
                              <span className={s.canceled ? "line-through" : ""}>{s.kind === "levels" ? `Levels ${s.stain}` : s.kind === "recut" ? `Recut ${s.stain}` : s.stain}</span>
                            )}{" "}
                            <span className="id-mono">{s.workOrder ?? "on order"}</span> {s.target} · Source: {s.authorization}
                            {s.canceled ? " CANCELED" : ""}
                            {s.needsReview ? <span className="ml-0.5 border border-ink px-0.5 font-semibold">REVIEW</span> : null}
                          </span>
                        ))
                      : "None"}
                  </td>
                  <td className="border-b border-line py-0.5 pr-2">
                    {r.holds.length
                      ? r.holds.map((h) => (
                          <span key={h.id} className="mr-1 inline-block">
                            <span className="border border-ink px-0.5 font-semibold">HOLD</span> {h.displayId} {h.scopeLabel}
                          </span>
                        ))
                      : "None"}
                  </td>
                  <td className="border-b border-line py-0.5 pr-2">{r.readinessText}</td>
                  <td className="border-b border-line py-0.5 pr-2">{r.owner ? r.owner.ownerName ?? "Unassigned" : "None"}</td>
                  <td className="border-b border-line py-0.5">{r.lastUpdate.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <footer className="mt-2 border-t border-ink pt-1">
        Demo: synthetic data. Fictional people and offices. Not a clinical record. Worklist v{meta.seq}.
      </footer>
    </section>
  );
}
