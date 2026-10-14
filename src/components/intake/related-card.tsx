"use client";

import { useState } from "react";
import { CircleCheck, TriangleAlert, Link2 } from "lucide-react";
import type { ItemDetail, RelatedView, BenchPermissions } from "@/server/queries/intake";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { IdChip, ProvisionalChip, AccessionChip } from "@/components/domain/chips";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { RELATED_STATUS } from "@/lib/domain";
import { fmtDate } from "@/lib/time";
import type { ClarificationDraft } from "./clarification-dialog";

type Decision = "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";

const DECISIONS: { value: Decision; label: string; hint: string }[] = [
  { value: "single_accession_approved", label: "Link as related: one accession, parts kept with their original orders", hint: "Both orders stay separate source records. Nothing is merged." },
  { value: "keep_separate", label: "Keep separate (separate cases)", hint: "Each item is requested as its own accession." },
  { value: "not_related", label: "Not related", hint: "The match was coincidental." },
  { value: "escalated_to_office", label: "Ask the office first", hint: "Accession waits until a decision is recorded." },
];

const TONE: Record<string, "warning" | "success" | "info" | "neutral"> = {
  pending_review: "warning",
  single_accession_approved: "success",
  keep_separate: "info",
  not_related: "neutral",
  escalated_to_office: "warning",
};

function CandidateBlock({
  item,
  cand,
  permissions,
  now,
  onRaise,
}: {
  item: ItemDetail;
  cand: RelatedView;
  permissions: BenchPermissions;
  now: string;
  onRaise: (draft: ClarificationDraft) => void;
}) {
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  useUnsavedChanges(reason.trim().length > 0, `decision on ${cand.displayId}`);
  const review = useCommand<{ status: string }, { candidateId: string; expectedVersion: number; decision: Decision; reason: string }>("related.review", {
    successToast: (r) => `${cand.displayId}: ${RELATED_STATUS[r.status as keyof typeof RELATED_STATUS] ?? r.status}`,
    errorToast: false,
    onSuccess: () => {
      setDecision("");
      setReason("");
    },
  });
  const accessioned = item.status === "accessioned" || cand.otherItems.some((o) => o.status === "accessioned");
  const canDecide = permissions.reviewRelated && !accessioned;
  const decided = !!cand.reviewedAt && cand.status !== "pending_review";
  const groupName = `rel-${cand.id}`;
  const decisionForm = (
    <fieldset className="space-y-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-ink">Reviewer decision ({cand.displayId})</legend>
      <div className="space-y-1.5">
        {DECISIONS.map((d) => (
          <label key={d.value} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name={groupName}
              value={d.value}
              checked={decision === d.value}
              disabled={cand.duplicateRecordKind && d.value === "single_accession_approved"}
              onChange={() => setDecision(d.value)}
              className="mt-0.5 size-4 accent-[var(--hlo-brand)]"
            />
            <span>
              <span className="text-ink">{d.label}</span>
              <span className="block text-xs text-ink-muted">{d.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <Field label="Reason" required hint="Recorded in the audit trail with your name.">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Button
        variant="primary"
        size="sm"
        loading={review.pending}
        loadingLabel="Recording..."
        disabled={!decision || !reason.trim()}
        onClick={() => decision && void review.run({ candidateId: cand.id, expectedVersion: cand.version, decision, reason: reason.trim() })}
      >
        Record decision
      </Button>
      <CommandError error={review.error && review.error.code !== "CONFLICT" ? review.error : null} />
    </fieldset>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <IdChip kind="OTHER" id={cand.displayId} showKind={false} />
        <StatusPill tone={TONE[cand.status] ?? "neutral"}>{cand.status === "pending_review" ? "Needs review" : RELATED_STATUS[cand.status as keyof typeof RELATED_STATUS] ?? cand.status}</StatusPill>
        {cand.orders.map((o) => (
          <IdChip key={o.id} kind="ORD" id={o.sourceOrderId} tenant={o.tenantName} />
        ))}
        {cand.otherItems.map((o) => (
          <ProvisionalChip key={o.id} id={o.displayId} compact />
        ))}
      </div>
      <p className="text-sm text-ink">
        {cand.duplicateRecordKind
          ? "Possible duplicate patient record (different patient references with the same name, birth date and office). This app never joins different patient records."
          : "Possible related order. Linking does not merge records: both source orders and both intake items are kept."}
      </p>
      <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Reasons</p>
          <ul className="space-y-1 text-sm">
            {cand.reasons.map((r) => (
              <li key={r.code} className="flex items-start gap-1.5">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-solid" aria-hidden />
                <span>
                  {r.label}
                  {r.detail ? <span className="text-ink-secondary">: {r.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Conflicts and notes</p>
          {cand.conflicts.length ? (
            <ul className="space-y-1 text-sm">
              {cand.conflicts.map((r) => (
                <li key={r.code} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                  <span>
                    {r.label}
                    {r.detail ? <span className="text-ink-secondary">: {r.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">None listed.</p>
          )}
        </div>
      </div>
      <p className="text-xs text-ink-muted">
        Detected <Timestamp iso={cand.detectedAt} now={now} /> by rule: {cand.detectionRule.replace(/^[a-z0-9_]+:\s*/, "")}
      </p>

      {cand.reviewedAt ? (
        <p className="text-sm text-ink">
          Decision by {cand.reviewedByName ?? "Unknown"} at <Timestamp iso={cand.reviewedAt} now={now} />: {RELATED_STATUS[cand.status as keyof typeof RELATED_STATUS] ?? cand.status}.
          {cand.decisionReason ? <span className="text-ink-secondary"> Reason: {cand.decisionReason}</span> : null}
        </p>
      ) : null}

      {cand.status === "escalated_to_office" && permissions.raiseClarification && !accessioned ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onRaise({
              category: "related_orders",
              refs: { intakeItemId: item.id, sourceOrderId: item.orders[0]?.id ?? null },
              intakeDisplayId: item.displayId,
              orderRef: cand.orders.map((o) => o.sourceOrderId).join(" + "),
              partLabel: null,
              subjectLabel: `${cand.displayId} · ${cand.orders.map((o) => o.sourceOrderId).join(" + ")}`,
              question: `Orders ${cand.orders.map((o) => o.sourceOrderId).join(" and ")} appear to come from the same visit. Should they be one case with separate parts, or separate cases?`,
              evidence: cand.reasons.map((r) => ({ field: r.label, order_value: r.detail || null, observed_value: null, requisition_value: null, source: "related-order detection" })),
              priority: "high",
              hold: { scope: { type: "intake_item", id: item.id }, scopeLabel: `${item.displayId} (related orders question)`, blocks: ["accession_request"] },
            })
          }
        >
          Raise a related-orders clarification
        </Button>
      ) : null}

      {accessioned ? (
        <p className="text-xs text-ink-secondary">Already accessioned. Changes now go through a correction review on the case.</p>
      ) : canDecide ? (
        decided ? (
          // Already decided: keep the record in front, and the form one click away (a lead may revise it with a new reason).
          <details className="group/chg rounded-md border border-line">
            <summary className="flex min-h-9 cursor-pointer list-none items-center px-3 text-sm font-medium text-brand hover:bg-surface-subtle [&::-webkit-details-marker]:hidden">
              Change decision on {cand.displayId}
            </summary>
            <div className="border-t border-line p-2">{decisionForm}</div>
          </details>
        ) : (
          decisionForm
        )
      ) : decided && cand.status !== "escalated_to_office" ? null : (
        <p className="rounded-md bg-surface-subtle px-3 py-2 text-sm text-ink-secondary">
          Who may decide: the accessioning lead (Kim Nguyen) or the operations supervisor (Tanya Brooks). Your demo role can view the candidate but not decide; the server checks this on every request.
        </p>
      )}
    </div>
  );
}

export function RelatedCard({
  item,
  permissions,
  now,
  onRaise,
}: {
  item: ItemDetail;
  permissions: BenchPermissions;
  now: string;
  onRaise: (draft: ClarificationDraft) => void;
}) {
  if (!item.related.length && !item.separateEncounters.length) return null;
  return (
    <Card
      id="related-orders"
      headingLevel={3}
      title={
        <span className="inline-flex items-center gap-2">
          <Link2 className="size-4 text-ink-muted" aria-hidden />
          Related orders
        </span>
      }
      description="Candidate grouping is a review, not a merge. Source-scoped patient reference, encounter, office and collection date are compared within one tenant only."
      bodyClassName="space-y-4"
    >
      {item.related.map((c) => (
        <CandidateBlock key={c.id} item={item} cand={c} permissions={permissions} now={now} onRaise={onRaise} />
      ))}
      {item.separateEncounters.length ? (
        <div className={item.related.length ? "border-t border-line pt-3" : undefined}>
          <h4 className="text-sm font-semibold text-ink">Other orders for this patient — separate encounter</h4>
          <p className="mb-2 text-xs text-ink-muted">Not proposed as related: a different encounter is a separate visit and stays a separate case.</p>
          <ul className="space-y-1.5 text-sm">
            {item.separateEncounters.map((s) => (
              <li key={s.orderId} className="flex flex-wrap items-center gap-2">
                <IdChip kind="ORD" id={s.sourceOrderId} />
                <span className="text-ink-secondary">
                  Encounter <span className="id-mono">{s.encounter ?? "Unknown"}</span>
                  {s.encounterAt ? `, ${fmtDate(s.encounterAt)}` : ""} · {s.officeName}
                </span>
                {s.accessionNumber ? (
                  <AccessionChip accession={s.accessionNumber} compact />
                ) : s.intakeDisplay ? (
                  <ProvisionalChip id={s.intakeDisplay} compact />
                ) : (
                  <span className="text-xs text-ink-muted">Not received yet</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
