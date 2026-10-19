import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { PathologistColor } from "@/lib/domain";
import { DoctorSwatch, isPathologistColor } from "@/components/domain/doctor-chip";
import type { WorklistData, WorklistRow } from "@/server/queries/worklist";
import { describeFilters } from "./views";
import { fmtSnapshotTime, holdStepsShort, plural } from "./format";

/**
 * Printed snapshot (downtime / transition fallback). Visible only in print.
 * Reads like the paper "bible" on a colour printer: a two-level header (title
 * and generation line, then view, filters, rows and the source data age), one
 * section per doctor opened by a heavy rule in the doctor's colour with the
 * swatch, name and colour word on a neutral ground (yellow stays PAS-only), and
 * PAS rows in pale yellow. It still works in grayscale: doctor sections carry
 * the color NAME, PAS is a bordered "PAS" box with its work order, material and
 * request source ("Source: Source order"), holds are a bordered "HOLD" box with
 * the scope and the steps they stop, and canceled work needing review carries a
 * bordered "REVIEW" box. Stage is read from the Parts column, as on screen.
 *
 * Paper rules (checked as print-to-PDF on US Letter by tests/e2e/print.spec.ts):
 *  - the doctor heading is part of each table's repeated header, so every page a doctor's section runs over
 *    names the doctor and colour again, and the heading never ends a page without rows;
 *  - every page carries the snapshot version, id, generation time, "synthetic data" and "Page N of M"
 *    (page margin boxes; browsers without them still print the first-page header and the last-page footer);
 *  - fixed column widths that fit the printable width of Letter portrait with 12 mm margins; identifiers
 *    (case, work order, block, slide, tray, hold) never break inside, other text wraps.
 */

/** The doctor's colour as the section's heavy top rule (never a fill: on paper too, yellow means PAS). */
const SECTION_RULE: Record<PathologistColor, string> = {
  teal: "border-t-dr-teal",
  violet: "border-t-dr-violet",
  amber: "border-t-dr-amber",
};

/**
 * Column widths of every doctor's table (sum 100%), sized for 725 px of printable width (Letter, 12 mm margins):
 * Case fits a provisional id ("INT-1014-022", 92 px at 12 px mono) with room to spare, Owner fits "Unassigned",
 * Last update fits "10:06 AM ET" on one line.
 */
const COLUMNS: { label: string; width: string }[] = [
  { label: "Case", width: "w-[14.5%]" },
  { label: "Parts and stage", width: "w-[14.5%]" },
  { label: "Stains (work orders)", width: "w-[19.5%]" },
  { label: "Holds", width: "w-[13%]" },
  { label: "Readiness", width: "w-[18%]" },
  { label: "Owner", width: "w-[10%]" },
  { label: "Last update", width: "w-[10.5%]" },
];

const CHANGE_WORD: Record<string, string> = { new: "NEW", changed: "CHANGED", canceled: "CANCELED" };

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
    <>
      <style dangerouslySetInnerHTML={{ __html: pageMarginCss(meta) }} />
      <section className="print-only text-[12px] leading-snug text-ink [print-color-adjust:exact] [-webkit-print-color-adjust:exact]" aria-hidden="true">
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
            <p className="col-start-2 row-span-2 row-start-1 max-w-[16rem] self-start text-right text-[12px]">
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
          <div key={g.key} className="mb-4">
            {/* Fixed column widths so every doctor's section lines up on paper. A long section spans pages (rows never
                split); its header group, doctor heading included, repeats on each page and never ends a page alone. */}
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                {COLUMNS.map((c) => (
                  <col key={c.label} className={c.width} />
                ))}
              </colgroup>
              <thead className="break-inside-avoid break-after-avoid">
                <tr>
                  <th colSpan={COLUMNS.length} className="p-0 text-left font-normal">
                    <h2
                      className={cn(
                        "flex break-after-avoid flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-ink bg-surface-subtle px-1.5 py-1",
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
                  </th>
                </tr>
                <tr className="text-left">
                  {COLUMNS.map((c, i) => (
                    <th key={c.label} className={cn("border-b border-ink py-0.5 font-semibold", i < COLUMNS.length - 1 && "pr-2")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id} className={cn("break-inside-avoid align-top", r.hasPas && "bg-pas-row")}>
                    <td className="border-b border-line py-0.5 pr-2">
                      <span className="id-mono font-semibold">{r.accessionNumber ?? r.provisionalId}</span>
                      {r.accessionNumber ? null : <span className="block">(provisional)</span>}
                      {r.changeTags.length || r.priority === "rush" ? (
                        <span className="mt-0.5 flex flex-wrap gap-0.5">
                          {r.priority === "rush" ? <Box>RUSH</Box> : null}
                          {r.changeTags.map((t) => (
                            <Box key={t}>{CHANGE_WORD[t] ?? t.toUpperCase()}</Box>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td className="border-b border-line py-0.5 pr-2 [overflow-wrap:anywhere]">{r.partsSummary}</td>
                    <td className="border-b border-line py-0.5 pr-2 [overflow-wrap:anywhere]">
                      {r.stains.length
                        ? r.stains.map((s, i) => (
                            <span key={i} className="mr-1 inline-block">
                              {s.isPas ? (
                                <span className={`border border-ink px-0.5 font-semibold ${s.canceled ? "line-through" : ""}`}>PAS</span>
                              ) : (
                                <span className={s.canceled ? "line-through" : ""}>{s.kind === "levels" ? `Levels ${s.stain}` : s.kind === "recut" ? `Recut ${s.stain}` : s.stain}</span>
                              )}{" "}
                              <span className="id-mono">{s.workOrder ?? "on order"}</span> {keepIds(s.target)} · Source: {s.authorization}
                              {s.canceled ? " CANCELED" : ""}
                              {s.needsReview ? <span className="ml-0.5 border border-ink px-0.5 font-semibold">REVIEW</span> : null}
                            </span>
                          ))
                        : "None"}
                    </td>
                    <td className="border-b border-line py-0.5 pr-2 [overflow-wrap:anywhere]">
                      {r.holds.length
                        ? r.holds.map((h) => (
                            // "HOLD H-0089 Part B (gross approval)": the word, the hold, its exact scope and the steps it stops.
                            <span key={h.id} className="mb-0.5 block">
                              <span className="whitespace-nowrap">
                                <Box>HOLD</Box> {h.displayId}
                              </span>{" "}
                              {keepIds(h.target ?? paperScope(h.scopeLabel))}
                              {h.blocks.length ? ` (${holdStepsShort(h.blocks)})` : ""}
                            </span>
                          ))
                        : "None"}
                    </td>
                    <td className="border-b border-line py-0.5 pr-2 [overflow-wrap:anywhere]">{keepIds(readinessForPaper(r))}</td>
                    <td className="border-b border-line py-0.5 pr-2 [overflow-wrap:anywhere]">{ownerForPaper(r)}</td>
                    <td className="border-b border-line py-0.5 [overflow-wrap:anywhere]">
                      <LastUpdate row={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <footer className="mt-2 break-inside-avoid border-t border-ink pt-1">
          Demo: synthetic data. Fictional people and offices. Not a clinical record. Worklist v{meta.seq}.
        </footer>
      </section>
    </>
  );
}

/** A bordered word (works in grayscale and on a monochrome laser). */
function Box({ children }: { children: ReactNode }) {
  return <span className="border border-ink px-0.5 font-semibold">{children}</span>;
}

/**
 * Identifiers inside running text ("A1-3", "TRY-M-03", "WO-2150", "H-0089", "D26-04804") never break at their
 * hyphens on paper ("A1-" / "3" reads as two things); the words around them still wrap.
 */
function keepIds(text: string): ReactNode {
  const parts = text.split(/(\b[A-Z0-9]+(?:-[A-Z0-9]+)+\b)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 ? (
      <span key={i} className="whitespace-nowrap">
        {p}
      </span>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

/** Paper cannot be expanded: a "(+2 more)" of blocked items is written out in full. */
function readinessForPaper(r: WorklistRow): string {
  const [first, ...rest] = r.blockedShort;
  if (!first || !rest.length) return r.readinessText;
  return r.readinessText.replace(`${first} (+${rest.length} more)`, r.blockedShort.join("; "));
}

/** "D26-04804 part B" → "Part B" (as on screen); any other scope in full, never cut short on paper. */
function paperScope(label: string): string {
  const m = label.match(/\bpart ([A-Z])\b/i);
  return m ? `Part ${m[1].toUpperCase()}` : label;
}

function ownerForPaper(r: WorklistRow): string {
  if (!r.owner) return r.unownedOwner ?? "None";
  return r.owner.ownerName ?? `Unassigned${r.owner.ownerRole ? ` (${r.owner.ownerRole.replace(/_/g, " ")})` : ""}`;
}

/** "10:06 AM ET" on one line (never "10:06 AM" / "ET"), then where it came from on its own line; an unknown time says so. */
function LastUpdate({ row }: { row: WorklistRow }) {
  const cut = row.lastUpdate.text.indexOf(" · ");
  const when = row.lastUpdate.at ? (cut >= 0 ? row.lastUpdate.text.slice(0, cut) : row.lastUpdate.text) : "Time unknown";
  const origin = row.lastUpdate.origin ?? "origin Unknown";
  return (
    <>
      <span className="block">{when.replace(/ (AM|PM|ET)\b/g, "\u00a0$1")}</span>
      <span className="block">{origin}</span>
    </>
  );
}

/**
 * Running page footer for every printed page (CSS page margin boxes): what this paper is and that it is synthetic on
 * the left, "Page N of M" on the right, so a loose page still names its snapshot and a missing page shows.
 * Rendered only with the worklist, so other screens print as before. Only plain characters reach the CSS string.
 */
function pageMarginCss(meta: PrintMeta): string {
  // Short enough for one line beside "Page N of M" at 8 pt on Letter portrait.
  const text = [
    `Worklist v${meta.seq}${meta.displayId ? ` ${meta.displayId}` : " (not recorded)"}`,
    fmtSnapshotTime(meta.generatedAt),
    meta.stale ? "STALE source data" : null,
    "Synthetic demo data, not a clinical record",
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/[^\w .,:()·-]/g, "");
  const box = "font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 8pt; color: #151A30; vertical-align: top; padding-top: 2mm;";
  return `@media print { @page { @bottom-left { content: "${text}"; ${box} } @bottom-right { content: "Page " counter(page) " of " counter(pages); white-space: nowrap; ${box} } } }`;
}
