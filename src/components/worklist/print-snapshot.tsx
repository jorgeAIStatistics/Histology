import type { WorklistData } from "@/server/queries/worklist";
import { describeFilters } from "./views";
import { fmtSnapshotTime, plural } from "./format";

/**
 * Printed snapshot (downtime / transition fallback). Visible only in print.
 * Works in grayscale: doctor sections carry the color NAME, PAS is a bordered
 * "PAS" box with its work order, material and request source ("Source: Source
 * order"), holds are a bordered "HOLD" box with the scope, and canceled work
 * needing review carries a bordered "REVIEW" box.
 */
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
  return (
    <section className="print-only text-[11px] leading-snug text-ink" aria-hidden="true">
      <header className="mb-2 border-b-2 border-ink pb-1">
        <p className="text-[13px] font-semibold">
          Worklist snapshot v{meta.seq}. Generated {fmtSnapshotTime(meta.generatedAt)} by {meta.generatedBy}. Not updated after printing.
        </p>
        <p>
          {meta.displayId ? `Snapshot ${meta.displayId} recorded. ` : "Not recorded as a snapshot (use \"Print snapshot\" to record version and time). "}
          View: {data.viewLabel}. Filters: {describeFilters(data.filters, doctorName)}. {plural(rows, "row")}.
        </p>
        <p>
          Source data as of {meta.dataAsOf ? fmtSnapshotTime(meta.dataAsOf) : "Unknown"}
          {meta.stale ? ". STALE: a simulated source system was unreachable or out of date when this was generated." : "."}
        </p>
      </header>
      {data.groups.map((g) => (
        <div key={g.key} className="mb-3 break-inside-avoid-page">
          <h2 className="mb-1 border-b border-ink text-[12px] font-semibold">
            {g.kind === "routing_exception" ? "Unassigned: routing exception (no doctor color)" : g.kind === "no_doctor" ? `${g.name} (no doctor color)` : `${g.name} (${g.colorName ?? "no color"})`} ·{" "}
            {plural(g.counts.rows, g.kind === "routing_exception" ? "item" : "case")}, {g.counts.pas} PAS, {g.counts.onHold} on hold
            {g.counts.pasReview ? `, ${g.counts.pasReview} canceled or amended PAS to review` : ""}
          </h2>
          {/* Fixed column widths so every doctor's section lines up on paper. */}
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[9%]" />
              <col className="w-[6%]" />
              <col className="w-[13%]" />
              <col className="w-[10%]" />
              <col className="w-[22%]" />
              <col className="w-[10%]" />
              <col className="w-[16%]" />
              <col className="w-[6%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="text-left">
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Case</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Change</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Parts</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Stage</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Stains (work orders)</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Holds</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Readiness</th>
                <th className="border-b border-ink py-0.5 pr-2 font-semibold">Owner</th>
                <th className="border-b border-ink py-0.5 font-semibold">Last update</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="border-b border-line py-0.5 pr-2">
                    <span className="id-mono font-semibold">{r.accessionNumber ?? r.provisionalId}</span>
                    {r.accessionNumber ? null : <span className="block">(provisional)</span>}
                  </td>
                  <td className="border-b border-line py-0.5 pr-2">{r.changeTags.map((t) => t[0].toUpperCase() + t.slice(1)).join(", ")}</td>
                  <td className="border-b border-line py-0.5 pr-2">{r.partsSummary}</td>
                  <td className="border-b border-line py-0.5 pr-2">{r.stageLabel}</td>
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
