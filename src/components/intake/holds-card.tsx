"use client";

import { useState } from "react";
import { CirclePause, ListChecks } from "lucide-react";
import type { ItemDetail, BenchPermissions } from "@/server/queries/intake";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { IdChip } from "@/components/domain/chips";
import { HoldPill } from "@/components/domain/hold";
import { Timestamp } from "@/components/domain/timestamp";
import { CLARIFICATION_CATEGORY } from "@/lib/domain";
import { HOLD_BLOCK_WORDS, type ClarificationDraft } from "./clarification-dialog";
import { AcceptDiscrepancyDialog, type AcceptTarget } from "./accept-dialog";

/** Missing and extra containers per order part (expected vs received), with a scoped clarification offer. */
export function MissingContainersCard({
  item,
  permissions,
  onRaise,
}: {
  item: ItemDetail;
  permissions: BenchPermissions;
  onRaise: (d: ClarificationDraft) => void;
}) {
  const [accepting, setAccepting] = useState<AcceptTarget | null>(null);
  if (!item.missingParts.length && !item.extraParts.length) return null;
  const open = item.status !== "accessioned" && item.status !== "canceled";
  return (
    <Card
      id="missing"
      headingLevel={3}
      title={item.missingParts.length && !item.extraParts.length ? "Expected containers not received" : "Container count differs from the order"}
      description="Counted per order part (expected on the order vs containers linked to the part). Other parts of this item can continue."
      bodyClassName="space-y-2"
    >
      <ul className="space-y-2 text-sm">
        {item.missingParts.map((m) => {
          const order = item.orders.find((o) => o.sourceOrderId === m.orderRef);
          return (
            <li key={m.discrepancyId} className="flex flex-wrap items-center gap-2">
              <IdChip kind="ORD" id={m.orderRef} tenant={order?.tenantName} />
              <span className="font-semibold">Part {m.designation}</span>
              <span className="text-ink-secondary">
                expected {m.expected ?? "Unknown"}, received {m.received}
              </span>
              {m.clarification ? (
                <span className="inline-flex items-center gap-1 text-ink-secondary">
                  Asked in <IdChip kind="CLR" id={m.clarification.displayId} href={`/clarifications?selected=${encodeURIComponent(m.clarification.displayId)}`} />
                  <StatePill domain="clarification" state={m.clarification.state} />
                </span>
              ) : permissions.raiseClarification && item.status !== "accessioned" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    onRaise({
                      category: "missing_container",
                      refs: { intakeItemId: item.id, sourceOrderId: order?.id ?? null, orderPartId: m.orderPartId },
                      intakeDisplayId: item.displayId,
                      orderRef: m.orderRef,
                      partLabel: `Part ${m.designation}`,
                      subjectLabel: `Part ${m.designation} · ${m.orderRef}`,
                      question: `Order ${m.orderRef} lists part ${m.designation}, but no container for part ${m.designation} arrived with this delivery. Was it collected and sent separately?`,
                      evidence: [{ field: "Containers", order_value: `expected ${m.expected ?? "Unknown"}`, observed_value: `received ${m.received}`, requisition_value: null, source: "courier unpacking" }],
                      priority: "high",
                      hold: { scope: { type: "order_part", id: m.orderPartId }, scopeLabel: `Part ${m.designation} (${m.orderRef} · ${m.designation})`, blocks: ["gross_approval"] },
                    })
                  }
                >
                  Raise missing-container clarification
                </Button>
              ) : null}
            </li>
          );
        })}
        {item.extraParts.map((m) => {
          const order = item.orders.find((o) => o.sourceOrderId === m.orderRef);
          return (
            <li key={m.discrepancyId} className="flex flex-wrap items-center gap-2">
              <IdChip kind="ORD" id={m.orderRef} tenant={order?.tenantName} />
              <span className="font-semibold">Part {m.designation}</span>
              <span className="text-warning-fg">
                more containers than expected: expected {m.expected ?? "Unknown"}, received {m.received}
                {m.containerSeqs.length ? ` (containers ${m.containerSeqs.join(", ")})` : ""}
              </span>
              {m.clarification ? (
                <span className="inline-flex items-center gap-1 text-ink-secondary">
                  Asked in <IdChip kind="CLR" id={m.clarification.displayId} href={`/clarifications?selected=${encodeURIComponent(m.clarification.displayId)}`} />
                  <StatePill domain="clarification" state={m.clarification.state} />
                </span>
              ) : open ? (
                <>
                  {permissions.raiseClarification ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        onRaise({
                          category: "missing_container",
                          refs: { intakeItemId: item.id, sourceOrderId: order?.id ?? null, orderPartId: m.orderPartId },
                          intakeDisplayId: item.displayId,
                          orderRef: m.orderRef,
                          partLabel: `Part ${m.designation}`,
                          subjectLabel: `Part ${m.designation} · ${m.orderRef}`,
                          question: `Order ${m.orderRef} expects ${m.expected ?? "an unknown number of"} container(s) for part ${m.designation}, but ${m.received} arrived labeled for this part. Are they all part ${m.designation}, or does one belong to another specimen?`,
                          evidence: [{ field: "Containers", order_value: `expected ${m.expected ?? "Unknown"}`, observed_value: `received ${m.received}`, requisition_value: null, source: "courier unpacking" }],
                          priority: "high",
                          hold: { scope: { type: "order_part", id: m.orderPartId }, scopeLabel: `Part ${m.designation} (${m.orderRef} · ${m.designation})`, blocks: ["gross_approval"] },
                        })
                      }
                    >
                      Raise clarification
                    </Button>
                  ) : null}
                  {permissions.acceptDiscrepancy ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        setAccepting({
                          discrepancyId: m.discrepancyId,
                          version: m.version,
                          intakeDisplayId: item.displayId,
                          orderRef: m.orderRef,
                          subject: `Part ${m.designation}: more containers than expected`,
                          rows: [
                            { label: "Expected (order)", value: m.expected === null ? "Unknown" : String(m.expected) },
                            { label: "Received", value: String(m.received) },
                          ],
                        })
                      }
                    >
                      Accept with reason (lead)
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-secondary">A lead or supervisor can accept this with a reason.</span>
                  )}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {accepting ? <AcceptDiscrepancyDialog target={accepting} onClose={() => setAccepting(null)} /> : null}
    </Card>
  );
}

/** Holds, clarifications and open tasks for this item: what is blocked, why, and who owns the next step. */
export function HoldsCard({ item, now }: { item: ItemDetail; now: string }) {
  const openClar = item.clarifications.filter((c) => c.state !== "resolved" && c.state !== "canceled");
  const closedClar = item.clarifications.filter((c) => c.state === "resolved" || c.state === "canceled");
  if (!item.holds.length && !item.clarifications.length && !item.tasks.length) return null;
  return (
    <Card
      id="holds"
      headingLevel={3}
      title={
        <span className="inline-flex items-center gap-2">
          <ListChecks className="size-4 text-ink-muted" aria-hidden />
          Holds, questions and next steps
        </span>
      }
      bodyClassName="space-y-3"
    >
      {item.holds.length ? (
        <ul className="space-y-2">
          {item.holds.map((h) => (
            <li key={h.id} className="hlo-hold-stripe rounded-md border border-l-4 border-hold-border border-l-hold-solid bg-hold-bg px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <CirclePause className="size-4 text-hold-solid" aria-hidden />
                <IdChip kind="HOLD" id={h.displayId} />
                <HoldPill scope={h.scopeLabel} />
                {h.clarificationDisplayId ? (
                  <IdChip kind="CLR" id={h.clarificationDisplayId} href={`/clarifications?selected=${encodeURIComponent(h.clarificationDisplayId)}`} />
                ) : null}
              </div>
              <p className="mt-1 text-ink">{h.reasonText}</p>
              <p className="text-xs text-ink-secondary">
                Blocks {h.blocks.map((b) => HOLD_BLOCK_WORDS[b] ?? b).join(", ")} for {h.scopeLabel} only.{" "}
                {h.blocksAccession ? "Accession is blocked until it is released." : "Accession is not blocked."} Placed by {h.placedByName ?? "Unknown"} at{" "}
                <Timestamp iso={h.placedAt} now={now} />. Released only by a lead or supervisor, with a reason.
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {openClar.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Open clarifications</p>
          <ul className="space-y-1.5 text-sm">
            {openClar.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <IdChip kind="CLR" id={c.displayId} href={`/clarifications?selected=${encodeURIComponent(c.displayId)}`} />
                <StatePill domain="clarification" state={c.state} />
                <span className="text-ink-secondary">{CLARIFICATION_CATEGORY[c.category as keyof typeof CLARIFICATION_CATEGORY] ?? c.category}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={c.question}>
                  {c.question}
                </span>
                <span className="text-xs text-ink-muted">Owner: {c.ownerName ?? "Unknown"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {closedClar.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-secondary">Closed clarifications ({closedClar.length})</summary>
          <ul className="mt-1 space-y-1">
            {closedClar.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <IdChip kind="CLR" id={c.displayId} href={`/clarifications?selected=${encodeURIComponent(c.displayId)}`} />
                <StatePill domain="clarification" state={c.state} />
                <span className="text-ink-secondary">{c.question}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {item.tasks.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Open tasks (who owns the next step)</p>
          <ul className="space-y-1 text-sm">
            {item.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2">
                <StatusPill tone={t.priority === "urgent" || t.priority === "high" ? "warning" : "neutral"} size="sm">
                  {t.priority === "routine" ? "Routine" : t.priority === "high" ? "High" : "Urgent"}
                </StatusPill>
                <span className="min-w-0 flex-1 text-ink">{t.title}</span>
                <span className="text-xs text-ink-muted">
                  Owner: {t.ownerName ?? (t.ownerRole ? `${t.ownerRole.replace(/_/g, " ")} (unassigned)` : "Unassigned")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
