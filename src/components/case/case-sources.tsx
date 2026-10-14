import { Card, StatusPill } from "@/components/ui";
import { IdChip, SimulatedLabel, Timestamp, UnknownValue } from "@/components/domain";
import type { CaseDetail } from "@/server/queries/case";

/** "needs_reconciliation" → "Needs reconciliation" (sentence case for stored state words). */
function sentence(v: string): string {
  const t = v.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
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
    <div className="flex flex-col gap-4">
      {stale.length ? (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-ink">
          {stale.map((s) => s.text).join(" ")} Source documents below are as of their import times; later source changes are not shown.
        </p>
      ) : null}
      {c.sourceDocuments.map((d) => (
        <Card
          key={d.id}
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Source order <IdChip kind="ORD" id={d.sourceOrderId} tenant={d.tenantName} />
            </span>
          }
          description={`Parts on this case from this order: ${d.partDesignations.length ? d.partDesignations.join(", ") : "none (linked at intake)"}.`}
          actions={<SimulatedLabel connector={d.tenantName} />}
        >
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-ink-muted">Status at source</dt>
              <dd className="text-ink">{sentence(d.status)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Current version</dt>
              <dd className="num-tabular text-ink">v{d.currentVersion}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Source updated</dt>
              <dd className="text-ink">
                <Timestamp iso={d.sourceUpdatedAt} now={now} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Imported here</dt>
              <dd className="text-ink">
                <Timestamp iso={d.importedAt} now={now} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Submitting office</dt>
              <dd className="text-ink">{d.office}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Ordering clinician</dt>
              <dd className="text-ink">{d.orderingClinician ?? <UnknownValue />}</dd>
            </div>
            <div className="col-span-2 max-sm:col-span-1">
              <dt className="text-xs text-ink-muted">Local review state</dt>
              <dd className="text-ink">{d.reviewText}</dd>
            </div>
          </dl>

          {d.clinicalNote ? (
            <div className="mt-3 rounded-sm border border-line bg-surface-subtle p-2">
              <p className="text-xs font-medium text-ink-muted">Clinical note (untrusted free text from the source, shown as text only; never used for PAS, routing or any decision)</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{d.clinicalNote}</p>
            </div>
          ) : null}

          <h3 className="mt-4 text-sm font-semibold text-ink">Order lines: original values, current source values and the value on this case</h3>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Original = the first version received ({d.originalVersion !== null ? `v${d.originalVersion}` : "Unknown"}), kept unchanged. Current = the source&apos;s latest version (v{d.currentVersion}).
            On this case = the part as issued; a source change never edits it silently (it opens a correction review).
          </p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">Order lines for {d.sourceOrderId}: original, current and on-case values</caption>
              <thead>
                <tr className="text-left text-xs text-ink-secondary">
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Part</th>
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">
                    Original ({d.originalVersion !== null ? `v${d.originalVersion}` : "version Unknown"})
                  </th>
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Current source value (v{d.currentVersion})</th>
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">On this case (as issued)</th>
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Collected</th>
                  <th scope="col" className="border-b border-line py-1 pr-3 font-medium">Expected containers</th>
                  <th scope="col" className="border-b border-line py-1 font-medium">Requested stains (original → current)</th>
                </tr>
              </thead>
              <tbody>
                {d.orderParts.map((op) => {
                  const fmt = (v: { site: string | null; laterality: string | null; procedure?: string | null } | null) =>
                    v ? `${v.site ?? "site Unknown"}; laterality ${v.laterality ?? "Unknown"}${v.procedure !== undefined ? `; ${v.procedure ?? "procedure Unknown"}` : ""}` : null;
                  const origStains = op.original ? (op.original.requestedStains.length ? op.original.requestedStains.join(", ") : "None") : "Unknown";
                  const curStains = op.current.requestedStains.length ? op.current.requestedStains.join(", ") : "None";
                  return (
                    <tr key={op.designation} className={op.status !== "active" ? "text-ink-muted" : undefined}>
                      <td className="border-b border-line py-1 pr-3 align-top font-medium">
                        {op.designation}
                        {op.status !== "active" ? <span className="block text-xs">{sentence(op.status)} at source</span> : null}
                      </td>
                      <td className="border-b border-line py-1 pr-3 align-top">{fmt(op.original) ?? <UnknownValue reason="not in the stored first version" />}</td>
                      <td className="border-b border-line py-1 pr-3 align-top">
                        {fmt(op.current)}
                        {op.changedSinceOriginal ? (
                          <span className="ml-1 inline-flex rounded-sm border border-warning-border bg-warning-bg px-1 text-xs font-semibold text-warning-fg">Changed since original</span>
                        ) : null}
                      </td>
                      <td className="border-b border-line py-1 pr-3 align-top">{op.onCase ? fmt(op.onCase) : <span className="text-ink-muted">Not on this case</span>}</td>
                      <td className="border-b border-line py-1 pr-3 align-top">{op.collectedAt ? <Timestamp iso={op.collectedAt} now={now} /> : <UnknownValue />}</td>
                      <td className="border-b border-line py-1 pr-3 align-top num-tabular">{op.expectedContainers ?? <UnknownValue />}</td>
                      <td className="border-b border-line py-1 align-top">{origStains === curStains ? curStains : `${origStains} → ${curStains}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3 className="mt-4 text-sm font-semibold text-ink">All versions received ({d.versions.length})</h3>
          <ol className="mt-1 flex flex-col gap-2">
            {d.versions.map((v) => (
              <li key={v.version} className="rounded-sm border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num-tabular font-semibold text-ink">v{v.version}</span>
                  {v.version === d.currentVersion ? <StatusPill tone="info" size="sm">Current</StatusPill> : <StatusPill tone="neutral" size="sm">Earlier version, kept unchanged</StatusPill>}
                  <span className="text-xs text-ink-secondary">
                    Source updated <Timestamp iso={v.sourceUpdatedAt} now={now} /> · imported <Timestamp iso={v.importedAt} now={now} />
                  </span>
                </div>
                {v.changeSummary ? <p className="mt-1 text-xs text-ink-secondary">{v.changeSummary}</p> : null}
                <ul className="mt-1 text-xs text-ink">
                  {v.specimens.map((sp) => (
                    <li key={sp.designation}>
                      Part {sp.designation}: {sp.site ?? "site Unknown"}, {sp.laterality ?? "laterality Unknown"}, {sp.procedure ?? "procedure Unknown"}
                      {sp.requestedStains.length ? `, requested stains: ${sp.requestedStains.join(", ")}` : ""}
                    </li>
                  ))}
                </ul>
                {v.clinicalNote ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-secondary">Note (as received): {v.clinicalNote}</p> : null}
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-brand">Raw payload as received (simulated, untrusted)</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-subtle p-2 text-xs text-ink">{v.raw}</pre>
                </details>
              </li>
            ))}
          </ol>

          {d.events.length ? (
            <>
              <h3 className="mt-4 text-sm font-semibold text-ink">Integration events for this order (simulated feed)</h3>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-secondary">
                {d.events.map((e) => (
                  <li key={e.messageId}>
                    <span className="id-mono text-ink">{e.messageId}</span> · {e.type} · {sentence(e.outcome).toLowerCase()}
                    {e.receiptCount > 1 ? ` (received ${e.receiptCount} times, applied once)` : ""} · <Timestamp iso={e.receivedAt} now={now} />
                    {e.detail ? ` · ${e.detail}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ))}

      <section id="related" className="scroll-mt-40">
        <Card title="Related-order review" description="Candidate grouping is a reviewed decision record. Orders and patients are never merged.">
          {c.related.length === 0 ? (
            <p className="text-sm text-ink-secondary">No related-order candidate involves this case&apos;s orders.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {c.related.map((r) => (
                <li key={r.id} className="text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <IdChip kind="OTHER" id={r.displayId} />
                    <StatusPill tone={r.status === "pending_review" ? "warning" : "info"}>{r.statusLabel}</StatusPill>
                  </p>
                  <p className="mt-1 font-medium text-ink">{r.statement}</p>
                  {r.decisionReason ? <p className="text-ink-secondary">Reason recorded: {r.decisionReason}</p> : null}
                  {r.reasons.length ? <p className="mt-1 text-xs text-ink-secondary">Why proposed: {r.reasons.map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join("; ")}</p> : null}
                  {r.conflicts.length ? <p className="text-xs text-ink-secondary">Conflicts shown to the reviewer: {r.conflicts.map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join("; ")}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section id="corrections" className="scroll-mt-40">
        <Card title="Correction reviews and cross-references" description="Discrepancies found after accessioning keep the original references. The authorized correction happens in the source system.">
          {c.corrections.length === 0 ? (
            <p className="text-sm text-ink-secondary">None recorded for this case.</p>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {c.corrections.map((x) => (
                <li key={x.id}>
                  <p className="flex flex-wrap items-center gap-2">
                    <IdChip kind="OTHER" id={x.displayId} />
                    <span className="text-ink">{sentence(x.kind)}</span>
                    <StatusPill tone={x.status.startsWith("open") ? "warning" : "neutral"}>{sentence(x.status)}</StatusPill>
                    {x.relatedAccession ? <span className="text-ink-secondary">Related case: <span className="id-mono">{x.relatedAccession}</span></span> : null}
                  </p>
                  <p className="mt-0.5 text-ink">{x.description}</p>
                  <p className="text-xs text-ink-secondary">
                    Opened by {x.requestedBy}, <Timestamp iso={x.requestedAt} now={now} />. {x.statement}
                  </p>
                  {x.outcomeNote ? <p className="text-xs text-ink-secondary">Outcome: {x.outcomeNote}</p> : null}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-medium text-brand">Original references at the time</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-sm bg-surface-subtle p-2 text-xs">{x.originalRefs}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
