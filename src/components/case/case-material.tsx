import { Card, StatePill, StatusPill } from "@/components/ui";
import { IdChip, Timestamp, UnknownValue } from "@/components/domain";
import type { CaseDetail } from "@/server/queries/case";

/**
 * Material tree: part → cassette/block → slides. Each node has its ID chip,
 * label and print state and last confirmed location. Expected, prepared and
 * verified counts are kept separate; Unknown is never shown as 0.
 */
export function CaseMaterial({ c }: { c: CaseDetail }) {
  const now = c.generatedAt;
  const acc = c.identity.accessionNumber;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Locations are the last confirmed location, not live tracking. A scan identifies a label; it does not verify tissue. Label and print states come from the simulated printers.
      </p>
      {c.material.map((p) => (
        <Card
          key={p.partId}
          title={`Part ${p.designation}`}
          description={
            <>
              {p.blockCounts.text}. {p.slideCounts.text}.
            </>
          }
          flush
        >
          {p.blocks.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-secondary">
              No cassettes yet. Blocks appear when the gross record allocates cassettes. Expected blocks:{" "}
              {p.blockCounts.expected === null ? `Unknown (${p.expectedUnknownReason ?? "not recorded"})` : p.blockCounts.expected}.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {p.blocks.map((b) => (
                <li key={b.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <IdChip kind="BLOCK" id={`${acc} ${b.label}`} />
                    <span className="text-ink">{b.stateLabel}</span>
                    <span className="text-ink-muted">·</span>
                    <span className="text-ink-secondary">Pieces submitted: {b.piecesSubmitted === null ? <UnknownValue /> : b.piecesSubmitted}</span>
                    <span className="text-ink-muted">·</span>
                    <span className="text-ink-secondary">{b.custody}</span>
                    {b.labelState ? <StatusPill tone={b.labelState === "verified" ? "success" : "neutral"}>Cassette label {b.labelState === "verified" ? "scanned and matched" : b.labelState}</StatusPill> : <StatusPill tone="neutral">No cassette label recorded</StatusPill>}
                    {b.printJob ? (
                      <span className="inline-flex items-center gap-1">
                        <IdChip kind="PJ" id={b.printJob.displayId} href={`/materials?tab=print&selected=${encodeURIComponent(b.printJob.displayId)}`} />
                        <StatePill domain="print" state={b.printJob.state} />
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-ink-secondary">
                    {b.location ? (
                      <>
                        Last confirmed location: <span className="id-mono text-ink">{b.location.code}</span> ({b.location.label})
                        {b.location.confirmedAt ? (
                          <>
                            , confirmed <Timestamp iso={b.location.confirmedAt} now={now} />
                          </>
                        ) : null}
                        {b.location.confirmedBy ? ` by ${b.location.confirmedBy}` : ""}. Not live tracking; the block may have moved since.
                      </>
                    ) : (
                      <>
                        Last confirmed location: <UnknownValue reason="no location recorded" />
                      </>
                    )}
                  </p>
                  {b.slides.length ? (
                    <table className="mt-2 w-full border-separate border-spacing-0 text-sm">
                      <caption className="sr-only">Slides from block {b.label}</caption>
                      <thead>
                        <tr className="text-left text-xs text-ink-secondary">
                          <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Slide</th>
                          <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Stain / level</th>
                          <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Physical state</th>
                          <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Label</th>
                          <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Print job (simulated)</th>
                          <th scope="col" className="border-b border-line py-1 font-medium">Work order</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.slides.map((s) => (
                          <tr key={s.id} className={s.status !== "active" ? "text-ink-muted" : undefined}>
                            <td className="border-b border-line py-1 pr-3">
                              <IdChip kind="SLIDE" id={`${acc} ${s.label} ${s.stain === "H&E" ? "HE" : s.stain}`} />
                            </td>
                            <td className="border-b border-line py-1 pr-3">
                              {s.stain}
                              {s.level ? ` · ${s.level}` : ""}
                            </td>
                            <td className="border-b border-line py-1 pr-3">
                              {s.stateLabel}
                              {s.status === "canceled_needs_review" ? (
                                <span className="block text-xs font-semibold text-warning-fg">Work canceled or amended at source: needs review (kept visible)</span>
                              ) : s.status === "void" ? (
                                <span className="block text-xs">Void</span>
                              ) : null}
                            </td>
                            <td className="border-b border-line py-1 pr-3">{s.labelState === "verified" ? "Scanned and matched" : s.labelStateLabel}</td>
                            <td className="border-b border-line py-1 pr-3">
                              {s.printJob ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="id-mono text-xs">{s.printJob.displayId}</span>
                                  <StatePill domain="print" state={s.printJob.state} />
                                </span>
                              ) : (
                                <span className="text-ink-muted">None</span>
                              )}
                            </td>
                            <td className="border-b border-line py-1">{s.workOrder ? <span className="id-mono text-xs">{s.workOrder}</span> : <span className="text-ink-muted">Routine</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="mt-1 text-xs text-ink-muted">No slides planned yet for this block.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
