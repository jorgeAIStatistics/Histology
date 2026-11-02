import type { ReactNode } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { LabelRef } from "@/components/domain/specimen-label";
import { IdText } from "@/components/domain/id-text";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { CaseDetail, SourceOrderDoc } from "@/server/queries/case";

/** "needs_reconciliation" → "Needs reconciliation" (sentence case for stored state words). */
function sentence(v: string): string {
  const t = v.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type LineValue = { site: string | null; laterality: string | null; procedure?: string | null } | null;

/** Site, side and procedure stacked so the columns compare value by value. */
function LineCell({ v }: { v: LineValue }) {
  if (!v) return null;
  return (
    <span className="flex flex-col">
      <span>{v.site ?? <UnknownValue reason="site" />}</span>
      <span className="text-ink-secondary">Laterality {v.laterality ? v.laterality.toLowerCase() : "Unknown"}</span>
      {v.procedure !== undefined ? <span className="text-ink-secondary">{v.procedure ? v.procedure.charAt(0).toUpperCase() + v.procedure.slice(1) : "Procedure Unknown"}</span> : null}
    </span>
  );
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group/d mt-1">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-brand-ink hover:underline [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform duration-[var(--hlo-duration-fast)] group-open/d:rotate-90" aria-hidden />
        {summary}
      </summary>
      {children}
    </details>
  );
}

function SourceOrder({ d, now }: { d: SourceOrderDoc; now: string }) {
  const facts: { label: string; value: ReactNode; wide?: boolean }[] = [
    { label: "Status at source", value: sentence(d.status) },
    { label: "Current version", value: <span className="num-tabular">v{d.currentVersion}</span> },
    { label: "Source updated", value: <Timestamp iso={d.sourceUpdatedAt} now={now} /> },
    { label: "Imported here", value: <Timestamp iso={d.importedAt} now={now} /> },
    { label: "Submitting office", value: d.office },
    { label: "Ordering clinician", value: d.orderingClinician ?? <UnknownValue /> },
    { label: "Local review state", value: <IdText text={d.reviewText} />, wide: true },
  ];
  return (
    <section id={`order-${d.sourceOrderId}`} aria-labelledby={`order-${d.sourceOrderId}-title`} className="scroll-mt-40 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 max-xl:px-4">
        <h2 id={`order-${d.sourceOrderId}-title`} className="flex items-center gap-2 text-md font-bold text-ink">
          Source order <LabelRef id={d.sourceOrderId} />
        </h2>
        <p className="text-sm text-ink-secondary">
          Parts on this case: {d.partDesignations.length ? d.partDesignations.join(", ") : "none (linked at intake)"}
        </p>
        <SimulatedLabel connector={d.tenantName} className="ml-auto" />
      </header>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-2 px-5 py-3 text-sm max-xl:px-4">
        {facts.map((f) => (
          <div key={f.label} className={f.wide ? "col-span-2 max-sm:col-span-1" : undefined}>
            <dt className="text-xs text-ink-muted">{f.label}</dt>
            <dd className="text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>

      {d.clinicalNote ? (
        <div className="border-t border-line bg-surface-subtle px-5 py-2.5 max-xl:px-4">
          <p className="text-xs text-ink-muted">Clinical note as received. Untrusted free text, shown as text only; never used for PAS, routing or any decision.</p>
          <p className="mt-0.5 max-w-[90ch] text-sm break-words whitespace-pre-wrap text-ink">{d.clinicalNote}</p>
        </div>
      ) : null}

      <div className="border-t border-line px-5 pt-3 pb-2 max-xl:px-4">
        <h3 className="text-sm font-semibold text-ink">Order lines: the first version, the source now and this case</h3>
        <p className="mt-0.5 max-w-[100ch] text-xs text-ink-secondary">
          Original is the first version received ({d.originalVersion !== null ? `v${d.originalVersion}` : "Unknown"}), kept unchanged. Current is the source&apos;s latest version (v{d.currentVersion}). On this case is the part as
          issued; a source change never edits it silently, it opens a correction review.
        </p>
      </div>
      <Table caption={`Order lines for ${d.sourceOrderId}: original, current and on-case values`} wrapperClassName="rounded-none border-x-0" className="min-w-[48rem]">
        <THead>
          <tr>
            <TH>Part</TH>
            <TH>Original ({d.originalVersion !== null ? `v${d.originalVersion}` : "version Unknown"})</TH>
            <TH>Current at source (v{d.currentVersion})</TH>
            <TH>On this case (as issued)</TH>
            <TH>Collected</TH>
            <TH align="right">Containers expected</TH>
            <TH>Requested stains</TH>
          </tr>
        </THead>
        <TBody>
          {d.orderParts.map((op) => {
            const origStains = op.original ? (op.original.requestedStains.length ? op.original.requestedStains.join(", ") : "None") : "Unknown";
            const curStains = op.current.requestedStains.length ? op.current.requestedStains.join(", ") : "None";
            return (
              <TR key={op.designation} canceled={op.status !== "active"} className="[&>td]:align-top [&>td]:py-2">
                <TD className="font-semibold">
                  {op.designation}
                  {op.status !== "active" ? <span className="block text-xs font-normal">{sentence(op.status)} at source</span> : null}
                </TD>
                <TD wrap>{op.original ? <LineCell v={op.original} /> : <UnknownValue reason="not in the stored first version" />}</TD>
                <TD wrap className={op.changedSinceOriginal ? "bg-warning-bg" : undefined}>
                  <LineCell v={op.current} />
                  {op.changedSinceOriginal ? (
                    <span className="mt-1 flex items-center gap-1 text-xs font-semibold text-warning-fg">
                      <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
                      Changed since original
                    </span>
                  ) : null}
                </TD>
                <TD wrap>{op.onCase ? <LineCell v={op.onCase} /> : <span className="text-ink-muted">Not on this case</span>}</TD>
                <TD>{op.collectedAt ? <Timestamp iso={op.collectedAt} now={now} /> : <UnknownValue />}</TD>
                <TD numeric>{op.expectedContainers ?? <UnknownValue />}</TD>
                <TD wrap>{origStains === curStains ? curStains : `${origStains} at first, now ${curStains}`}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <div className="px-5 py-3 max-xl:px-4">
        <h3 className="text-sm font-semibold text-ink">All versions received ({d.versions.length})</h3>
        <ol className="mt-1 divide-y divide-line">
          {d.versions.map((v) => (
            <li key={v.version} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 py-2.5 text-sm">
              <span className="num-tabular pt-0.5 text-md font-bold text-ink">v{v.version}</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {v.version === d.currentVersion ? <StatusPill tone="info" size="sm">Current</StatusPill> : <StatusPill tone="neutral" size="sm">Earlier version, kept unchanged</StatusPill>}
                  <span className="text-ink-secondary">
                    Source updated <Timestamp iso={v.sourceUpdatedAt} now={now} className="text-ink" />
                  </span>
                  <span className="text-ink-secondary">
                    Imported <Timestamp iso={v.importedAt} now={now} className="text-ink" />
                  </span>
                </p>
                {v.changeSummary ? (
                  <p className="mt-1 text-ink">
                    <IdText text={v.changeSummary} />
                  </p>
                ) : null}
                <ul className="mt-1 text-ink-secondary">
                  {v.specimens.map((sp) => (
                    <li key={sp.designation}>
                      <span className="font-semibold text-ink">Part {sp.designation}</span> {sp.site ?? "site Unknown"}, {sp.laterality ? sp.laterality.toLowerCase() : "laterality Unknown"},{" "}
                      {sp.procedure ?? "procedure Unknown"}
                      {sp.requestedStains.length ? `; requested stains ${sp.requestedStains.join(", ")}` : ""}
                    </li>
                  ))}
                </ul>
                {v.clinicalNote ? <p className="mt-1 break-words whitespace-pre-wrap text-ink-secondary">Note as received: {v.clinicalNote}</p> : null}
                <Disclosure summary="Raw payload as received (simulated, untrusted)">
                  <pre className="mt-1 max-h-64 overflow-auto rounded-sm bg-surface-subtle p-2 font-mono text-xs break-words whitespace-pre-wrap text-ink">{v.raw}</pre>
                </Disclosure>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {d.events.length ? (
        <>
          <h3 className="border-t border-line px-5 pt-3 pb-1.5 text-sm font-semibold text-ink max-xl:px-4">Integration events for this order (simulated feed)</h3>
          <Table caption={`Integration events for ${d.sourceOrderId}`} wrapperClassName="rounded-none border-x-0 border-b-0">
            <THead>
              <tr>
                <TH>Message</TH>
                <TH>Type</TH>
                <TH>Outcome</TH>
                <TH>Received</TH>
                <TH>Detail</TH>
              </tr>
            </THead>
            <TBody>
              {d.events.map((e) => (
                <TR key={e.messageId}>
                  <TD>
                    <span className="id-mono text-sm">{e.messageId}</span>
                  </TD>
                  <TD>{e.type}</TD>
                  <TD wrap>
                    {sentence(e.outcome)}
                    {e.receiptCount > 1 ? <span className="block text-xs text-ink-muted">Received {e.receiptCount} times, applied once</span> : null}
                  </TD>
                  <TD>
                    <Timestamp iso={e.receivedAt} now={now} />
                  </TD>
                  <TD wrap className="min-w-48">
                    {e.detail ? <IdText text={e.detail} /> : <span className="text-ink-muted">None</span>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      ) : null}
    </section>
  );
}

/**
 * Source documents: every source order with ALL versions and original values,
 * source update time and import time, the related-order review record ("not
 * merged") and any correction / cross-reference reviews (never a renumbering).
 * Free text from the source is untrusted data and is shown as plain text only.
 */
export function CaseSources({ c }: { c: CaseDetail }) {
  const now = c.generatedAt;
  // An offline source already has the page-level stale banner; here only "delayed" needs saying.
  const stale = c.freshness.sources.filter((s) => s.stale && s.state !== "offline");
  return (
    <div className="flex flex-col gap-5">
      {stale.length ? (
        <p className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
          <span>{stale.map((s) => s.text).join(" ")} Source documents below are as of their import times; later source changes are not shown.</span>
        </p>
      ) : null}
      {c.sourceDocuments.map((d) => (
        <SourceOrder key={d.id} d={d} now={now} />
      ))}

      <section aria-labelledby="reviews-title" className="rounded-lg border border-line bg-surface">
        <header className="border-b border-line px-5 py-3 max-xl:px-4">
          <h2 id="reviews-title" className="text-md font-bold text-ink">
            Related orders and corrections
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Reviewed decision records. Orders and patients are never merged, and a case is never renumbered here.</p>
        </header>
        <div id="related" className="scroll-mt-40 px-5 py-3 max-xl:px-4">
          <h3 className="text-sm font-semibold text-ink">Related-order review</h3>
          {c.related.length === 0 ? (
            <p className="mt-1 text-sm text-ink-secondary">No related-order candidate involves this case&apos;s orders.</p>
          ) : (
            <ul className="mt-1 divide-y divide-line">
              {c.related.map((r) => (
                <li key={r.id} className="py-2 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <LabelRef id={r.displayId} />
                    <StatusPill tone={r.status === "pending_review" ? "warning" : "neutral"}>{r.statusLabel}</StatusPill>
                  </p>
                  <p className="mt-1 font-medium text-ink">
                    <IdText text={r.statement} />
                  </p>
                  {r.decisionReason ? (
                    <p className="text-ink-secondary">
                      Reason recorded: <IdText text={r.decisionReason} />
                    </p>
                  ) : null}
                  {r.reasons.length ? <p className="mt-1 text-xs text-ink-secondary">Why proposed: {r.reasons.map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join("; ")}</p> : null}
                  {r.conflicts.length ? <p className="text-xs text-ink-secondary">Conflicts shown to the reviewer: {r.conflicts.map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join("; ")}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div id="corrections" className="scroll-mt-40 border-t border-line px-5 py-3 max-xl:px-4">
          <h3 className="text-sm font-semibold text-ink">Correction reviews and cross-references</h3>
          <p className="mt-0.5 text-xs text-ink-secondary">Discrepancies found after accessioning keep the original references. The authorized correction happens in the source system.</p>
          {c.corrections.length === 0 ? (
            <p className="mt-1 text-sm text-ink-secondary">None recorded for this case.</p>
          ) : (
            <ul className="mt-1 divide-y divide-line text-sm">
              {c.corrections.map((x) => (
                <li key={x.id} className="py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <LabelRef id={x.displayId} />
                    <span className="text-ink">{sentence(x.kind)}</span>
                    <StatusPill tone={x.status.startsWith("open") ? "warning" : "neutral"}>{sentence(x.status)}</StatusPill>
                    {x.relatedAccession ? (
                      <span className="text-ink-secondary">
                        Related case <span className="id-mono">{x.relatedAccession}</span>
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-ink">{x.description}</p>
                  <p className="text-xs text-ink-secondary">
                    Opened by {x.requestedBy}, <Timestamp iso={x.requestedAt} now={now} />. <IdText text={x.statement} />
                  </p>
                  {x.outcomeNote ? <p className="text-xs text-ink-secondary">Outcome: {x.outcomeNote}</p> : null}
                  <Disclosure summary="Original references at the time">
                    <pre className="mt-1 rounded-sm bg-surface-subtle p-2 font-mono text-xs break-words whitespace-pre-wrap">{x.originalRefs}</pre>
                  </Disclosure>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
