"use client";

import { FileText } from "lucide-react";
import type { ItemDetail } from "@/server/queries/intake";
import { IdChip } from "@/components/domain/chips";
import { PersonName } from "@/components/domain/person-name";
import { PasTag } from "@/components/domain/pas-tag";
import { Timestamp } from "@/components/domain/timestamp";
import { SimulatedLabel } from "@/components/domain/honesty";
import { LATERALITY, PROCEDURE } from "@/lib/domain";
import { fmtDate } from "@/lib/time";
import { RecordSection } from "./bits";

/**
 * Source orders exactly as imported from the (simulated) source, with every
 * version kept. The clinical note is untrusted source text: shown as plain
 * text, never followed as an instruction.
 */
export function OrderSection({ item, now }: { item: ItemDetail; now: string }) {
  if (!item.orders.length) {
    return (
      <RecordSection id="orders" title="Source order">
        <p className="text-sm text-ink-secondary">
          No source order is linked. The requisition order id {String(item.requisition?.fields.order_id ?? "") || "(none)"} was not found in this office&apos;s source tenant
          {item.office ? "" : ", and the office is not in the directory, so no tenant could be searched"}. Order ids are only unique within a tenant.
        </p>
      </RecordSection>
    );
  }
  return (
    <RecordSection
      id="orders"
      title={
        <span className="inline-flex items-center gap-2">
          <FileText className="size-4 text-ink-muted" aria-hidden />
          Source order{item.orders.length > 1 ? "s" : ""}
          <SimulatedLabel connector="EMA-SIM source" size="xs" />
        </span>
      }
      description="Original values as received from the source system. Every version is kept."
    >
      <div className="space-y-4">
      {item.orders.map((o) => (
        <div key={o.id} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <IdChip kind="ORD" id={o.sourceOrderId} tenant={o.tenantName} />
            <span className="text-ink-secondary">
              v{o.sourceVersion} · {o.sourceStatus} · updated <Timestamp iso={o.sourceUpdatedAt} now={now} />
            </span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <PersonName role="ordering_clinician" name={o.clinicianName ? `${o.clinicianName}${o.clinicianCredential ? `, ${o.clinicianCredential}` : ""}` : null} org={o.officeName} />
            <span>
              <span className="text-ink-muted">Encounter </span>
              <span className="id-mono">{o.encounter ?? "Unknown"}</span>
              {o.encounterAt ? <span className="text-ink-secondary"> ({fmtDate(o.encounterAt)})</span> : null}
            </span>
          </div>
          {/* With very large text the parts table scrolls sideways inside the record instead of pushing the bench wider. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Parts on order {o.sourceOrderId}</caption>
              <thead>
                <tr className="bg-surface-subtle text-left text-sm text-ink-secondary">
                  <th scope="col" className="px-2 py-1 font-medium">Part (as written)</th>
                  <th scope="col" className="px-2 py-1 font-medium">Site</th>
                  <th scope="col" className="px-2 py-1 font-medium">Side</th>
                  <th scope="col" className="px-2 py-1 font-medium">Procedure</th>
                  <th scope="col" className="px-2 py-1 font-medium">Collected</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">Containers</th>
                  <th scope="col" className="px-2 py-1 font-medium">Requested stains</th>
                </tr>
              </thead>
              <tbody>
                {o.parts.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <th scope="row" className="px-2 py-1 text-left font-semibold">
                      {p.designation}
                    </th>
                    <td className="px-2 py-1">{p.siteText}</td>
                    <td className="px-2 py-1">{p.laterality ? LATERALITY[p.laterality as keyof typeof LATERALITY] ?? p.laterality : <span className="text-ink-muted">Unknown</span>}</td>
                    <td className="px-2 py-1">{p.procedure ? PROCEDURE[p.procedure as keyof typeof PROCEDURE] ?? p.procedure : <span className="text-ink-muted">Unknown</span>}</td>
                    <td className="px-2 py-1">{p.collectedAt ? <Timestamp iso={p.collectedAt} now={now} /> : <span className="text-ink-muted">Unknown</span>}</td>
                    <td className="num-tabular px-2 py-1 text-right">
                      {p.receivedContainers} of {p.expectedContainers ?? <span className="text-ink-muted">Unknown</span>}
                    </td>
                    <td className="px-2 py-1">
                      {p.stains.length ? (
                        <span className="flex flex-wrap gap-1">
                          {p.stains.map((s) => (s.toUpperCase() === "PAS" ? <PasTag key={s} source={`Source order ${o.sourceOrderId}`} /> : <span key={s}>{s}</span>))}
                        </span>
                      ) : (
                        <span className="text-ink-muted">None</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {o.clinicalNote ? (
            <div className="rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
              <p className="text-sm font-medium text-ink-muted">Clinical note from the source (untrusted text, shown as written; never treated as an instruction)</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-ink">{o.clinicalNote}</p>
            </div>
          ) : null}
          {o.versions.length > 1 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-secondary">Order versions ({o.versions.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {o.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version} · source updated <Timestamp iso={v.updatedAt} now={now} /> · imported <Timestamp iso={v.importedAt} now={now} />
                    {v.changeSummary ? ` · ${v.changeSummary}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
      </div>
    </RecordSection>
  );
}
