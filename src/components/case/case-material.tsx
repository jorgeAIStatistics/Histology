import { TriangleAlert } from "lucide-react";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatePill } from "@/components/ui/status-pill";
import { LabelRef, SpecimenLabel } from "@/components/domain/specimen-label";
import { PasTag } from "@/components/domain/pas-tag";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { CaseDetail, MaterialPart, QuantityLine } from "@/server/queries/case";
import { partDescription } from "./format";

function Count({ n, reason }: { n: number | null; reason?: string | null }) {
  return n === null ? <UnknownValue reason={reason ?? undefined} /> : <span className="num-tabular">{n}</span>;
}

/** Expected, prepared and scanned counts aligned for comparison; Unknown is never shown as 0. */
function Counts({ part, label }: { part: MaterialPart; label: string }) {
  const row = (name: string, q: QuantityLine, reason?: string | null) => (
    <tr>
      <th scope="row" className="py-1 pr-6 text-left font-medium text-ink">
        {name}
      </th>
      <td className="py-1 pr-6 text-ink">
        <Count n={q.expected} reason={reason} />
      </td>
      <td className="py-1 pr-6 text-ink">
        <Count n={q.prepared} />
      </td>
      <td className="py-1 text-ink">
        <Count n={q.verified} />
      </td>
    </tr>
  );
  return (
    <table className="text-sm">
      <caption className="sr-only">Counts for {label}: expected, prepared and labels scanned and matched</caption>
      <thead>
        <tr className="text-left text-xs text-ink-muted">
          <th scope="col" className="pr-6 pb-0.5 font-medium">
            <span className="sr-only">Material</span>
          </th>
          <th scope="col" className="pr-6 pb-0.5 font-medium">
            Expected
          </th>
          <th scope="col" className="pr-6 pb-0.5 font-medium">
            Prepared
          </th>
          <th scope="col" className="pb-0.5 font-medium">
            Labels scanned and matched
          </th>
        </tr>
      </thead>
      <tbody>
        {row("Blocks", part.blockCounts, part.expectedUnknownReason)}
        {row("Slides", part.slideCounts, part.slideCounts.expected === null ? "none planned yet" : null)}
      </tbody>
    </table>
  );
}

/**
 * Material: part → blocks → slides, each in the shared table. Every block
 * shows its last confirmed location (never live tracking), label and print
 * state; slides keep canceled or amended work visible. PAS is the yellow tag
 * with the word.
 */
export function CaseMaterial({ c }: { c: CaseDetail }) {
  const now = c.generatedAt;
  const acc = c.identity.accessionNumber;
  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-secondary">
        <span>Locations are the last confirmed location, not live tracking. A scan identifies a label; it does not verify tissue.</span>
        <SimulatedLabel connector="printers" />
      </p>
      {c.material.map((p) => {
        const casePart = c.parts.find((x) => x.partId === p.partId);
        const slides = p.blocks.flatMap((b) => b.slides.map((s) => ({ ...s, block: b.label })));
        return (
          <section key={p.partId} id={`material-${p.designation}`} aria-labelledby={`material-${p.designation}-title`} className="scroll-mt-40 overflow-hidden rounded-lg border border-line bg-surface">
            <header className="flex flex-wrap items-start gap-x-8 gap-y-3 border-b border-line px-5 py-3 max-xl:px-4">
              <h2 id={`material-${p.designation}-title`} className="sr-only">
                Part {p.designation}
              </h2>
              <div className="flex min-w-0 items-center gap-4">
                <SpecimenLabel size="md" status="official" id={acc} parts={[p.designation]} />
                {casePart ? <p className="text-md font-semibold text-ink">{partDescription(casePart.site, casePart.laterality, casePart.procedure)}</p> : null}
              </div>
              <div className="ml-auto max-md:ml-0">
                <Counts part={p} label={`Part ${p.designation}`} />
              </div>
            </header>

            {p.blocks.length === 0 ? (
              <p className="px-5 py-3 text-sm text-ink-secondary max-xl:px-4">
                No cassettes yet. Blocks appear when the gross record allocates cassettes.
              </p>
            ) : (
              <>
                <h3 className="px-5 pt-3 pb-1.5 text-sm font-semibold text-ink max-xl:px-4">Blocks</h3>
                <Table caption={`Blocks of ${acc} part ${p.designation}`} wrapperClassName="rounded-none border-x-0 border-b-0">
                  <THead>
                    <tr>
                      <TH>Block</TH>
                      <TH>Physical state and custody</TH>
                      <TH>Last confirmed location</TH>
                      <TH align="right">Pieces</TH>
                      <TH>Cassette label</TH>
                      <TH>Print job</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {p.blocks.map((b) => (
                      <TR key={b.id}>
                        <TD>
                          <LabelRef id={`${acc} ${b.label}`} />
                        </TD>
                        <TD wrap className="min-w-44">
                          {b.stateLabel}
                          <span className="block text-xs text-ink-muted">{b.custody}</span>
                        </TD>
                        <TD wrap className="min-w-48">
                          {b.location ? (
                            <>
                              <span className="id-mono text-ink">{b.location.code}</span> <span className="text-ink-secondary">{b.location.label}</span>
                              {b.location.confirmedAt || b.location.confirmedBy ? (
                                <span className="block text-xs text-ink-muted">
                                  {b.location.confirmedAt ? (
                                    <>
                                      Confirmed <Timestamp iso={b.location.confirmedAt} now={now} />
                                    </>
                                  ) : (
                                    "Confirmed"
                                  )}
                                  {b.location.confirmedBy ? ` by ${b.location.confirmedBy}` : ""}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <UnknownValue reason="no location recorded" />
                          )}
                        </TD>
                        <TD numeric>{b.piecesSubmitted === null ? <UnknownValue /> : b.piecesSubmitted}</TD>
                        <TD>{b.labelState === "verified" ? "Scanned and matched" : b.labelState ? b.labelState.charAt(0).toUpperCase() + b.labelState.slice(1) : <span className="text-ink-muted">None recorded</span>}</TD>
                        <TD wrap>
                          {b.printJob ? (
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <LabelRef id={b.printJob.displayId} href={`/materials?tab=print&selected=${encodeURIComponent(b.printJob.displayId)}`} />
                              <StatePill domain="print" state={b.printJob.state} />
                            </span>
                          ) : (
                            <span className="text-ink-muted">None</span>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {slides.length ? (
                  <>
                    <h3 className="border-t border-line px-5 pt-3 pb-1.5 text-sm font-semibold text-ink max-xl:px-4">Slides</h3>
                    <Table caption={`Slides of ${acc} part ${p.designation}`} wrapperClassName="rounded-none border-x-0 border-b-0">
                      <THead>
                        <tr>
                          <TH>Slide</TH>
                          <TH>Stain and level</TH>
                          <TH>Physical state</TH>
                          <TH>Label</TH>
                          <TH>Print job</TH>
                          <TH>Work order</TH>
                        </tr>
                      </THead>
                      <TBody>
                        {slides.map((s) => {
                          const pas = s.stain.toUpperCase() === "PAS";
                          return (
                            <TR key={s.id} pas={pas && s.status === "active"} canceled={s.status !== "active"}>
                              <TD>
                                <LabelRef id={`${acc} ${s.label} ${s.stain === "H&E" ? "HE" : s.stain}`} />
                              </TD>
                              <TD>
                                {pas ? <PasTag /> : s.stain}
                                {s.level ? <span className="ml-1.5 text-ink-secondary">{s.level}</span> : null}
                              </TD>
                              <TD wrap className="min-w-40">
                                {s.stateLabel}
                                {s.status === "canceled_needs_review" ? (
                                  <span className="mt-0.5 flex items-start gap-1 text-xs font-semibold text-warning-fg">
                                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-solid" aria-hidden />
                                    Work canceled or amended at source: needs review (kept visible)
                                  </span>
                                ) : s.status === "void" ? (
                                  <span className="block text-xs">Void</span>
                                ) : null}
                              </TD>
                              <TD>{s.labelState === "verified" ? "Scanned and matched" : s.labelStateLabel}</TD>
                              <TD wrap>
                                {s.printJob ? (
                                  <span className="inline-flex flex-wrap items-center gap-1.5">
                                    <span className="id-mono text-sm">{s.printJob.displayId}</span>
                                    <StatePill domain="print" state={s.printJob.state} />
                                  </span>
                                ) : (
                                  <span className="text-ink-muted">None</span>
                                )}
                              </TD>
                              <TD>{s.workOrder ? <span className="id-mono text-sm">{s.workOrder}</span> : <span className="text-ink-muted">Routine</span>}</TD>
                            </TR>
                          );
                        })}
                      </TBody>
                    </Table>
                  </>
                ) : (
                  <p className="border-t border-line px-5 py-3 text-sm text-ink-secondary max-xl:px-4">No slides planned yet for this part.</p>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
