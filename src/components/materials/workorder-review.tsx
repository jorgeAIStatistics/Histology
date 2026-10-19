"use client";

import { useState } from "react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { AccessionChip, IdChip } from "@/components/domain/chips";
import { PasTag } from "@/components/domain/pas-tag";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useActor, useCan } from "@/lib/client/shell-context";
import type { WorkOrderReviewView, listRecentWorkOrderReviews } from "@/server/queries/materials";
import { useReadOnly } from "./shared";

type Decision = "retain_prepared_material" | "void_unprepared" | "keep_active";

/** A label scan identifies a record; it never "verifies" anything (copy rule). */
const LABEL_STATE_TEXT: Record<string, string> = { none: "not printed", printed: "printed", applied: "applied", verified: "applied, scan matched", retired: "retired" };

const DECISIONS: { key: Decision; label: string; hint: string }[] = [
  { key: "retain_prepared_material", label: "Retain prepared material", hint: "Accept the cancellation. Prepared slides stay on record (retained, not delivered as ordered work); unused printed labels are retired." },
  { key: "void_unprepared", label: "Void unprepared work", hint: "Only when nothing was cut or stained. Planned slides are voided and unused labels retired." },
  { key: "keep_active", label: "Keep the work active", hint: "The work continues (for example, the amendment does not affect it). A note is required." },
];

function ReviewCard({ wo }: { wo: WorkOrderReviewView }) {
  const toast = useToast();
  const can = useCan("workorder.review");
  const actor = useActor();
  const readOnly = useReadOnly();
  const keepBlocked = wo.keepNeedsPathologist && actor.role !== "pathologist";
  const anyPrepared = wo.slides.some((s) => s.prepared);
  const [decision, setDecision] = useState<Decision>(anyPrepared ? "retain_prepared_material" : "void_unprepared");
  const [note, setNote] = useState("");
  const [blank, setBlank] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const cmd = useCommand<{ message: string }, { workOrderId: string; decision: Decision; note: string }>("workorder.reviewSourceChange", { errorToast: false });
  const isPas = (wo.stain ?? "").toUpperCase() === "PAS";
  const disabledReason = readOnly ?? (can.allowed ? null : `${can.reason} A histotechnologist, supervisor or dermatopathologist records the review.`);

  const submit = async () => {
    if (!note.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ workOrderId: wo.id, decision, note: note.trim() });
    if (out.ok) toast.show({ tone: "success", title: `${wo.displayId} review recorded`, body: out.result.message });
  };

  return (
    <li className="rounded-md border border-warning-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <IdChip kind="WO" id={wo.displayId} showKind />
        <AccessionChip accession={wo.accessionNumber} compact />
        {isPas ? <PasTag workOrder={wo.displayId} /> : <span className="text-sm font-medium">{wo.stain ?? wo.kind}</span>}
        <StatusPill tone="warning">{wo.statusLabel}</StatusPill>
      </div>
      <p className="mt-1 text-sm text-ink-secondary">
        Original authorization: {wo.sourceReference}.
        {wo.statusReason ? <> Source change: {wo.statusReason}</> : null}
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {wo.slides.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <span className="id-mono font-medium">{s.label}</span>
            <span className="text-ink-secondary">
              {s.prepared ? `Prepared (${s.physicalState.replace(/_/g, " ")})` : "Not yet cut"}, label {LABEL_STATE_TEXT[s.labelState] ?? s.labelState.replace(/_/g, " ")}
              {s.status === "canceled_needs_review" ? ", awaiting review (still on the worklist)" : ""}
            </span>
          </li>
        ))}
        {!wo.slides.length ? <li className="text-ink-secondary">No slides were planned for this work order.</li> : null}
      </ul>
      {wo.holds.length ? (
        <p className="mt-1 text-xs text-hold-fg">
          Active holds: {wo.holds.map((h) => `${h.displayId} (${h.scopeLabel}: ${h.reason})`).join("; ")}. This review does not release them; a lead or supervisor releases each one separately with a reason.
        </p>
      ) : null}
      {wo.openTasks.length ? <p className="mt-1 text-xs text-ink-muted">Open tasks: {wo.openTasks.map((t) => `${t.title}${t.owner ? ` (owner ${t.owner})` : ""}`).join("; ")}</p> : null}

      {!formOpen ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={!!disabledReason} reasonId={disabledReason ? `wor-${wo.id}` : undefined} onClick={() => setFormOpen(true)} aria-expanded={false}>
            Review {wo.displayId}…
          </Button>
          {disabledReason ? <DisabledReason id={`wor-${wo.id}`}>{disabledReason}</DisabledReason> : null}
        </div>
      ) : (
      <>
      <fieldset className="mt-3 flex flex-col gap-1.5" disabled={!!disabledReason}>
        <legend className="text-sm font-medium text-ink-secondary">Review decision</legend>
        {DECISIONS.map((d) => {
          const blocked = (d.key === "void_unprepared" && anyPrepared) || (d.key === "keep_active" && keepBlocked);
          return (
            <label key={d.key} className={`flex items-start gap-2 text-sm ${blocked ? "text-ink-disabled" : "text-ink"}`}>
              <input type="radio" name={`dec-${wo.id}`} value={d.key} checked={decision === d.key} disabled={blocked} onChange={() => setDecision(d.key)} className="mt-1 accent-[var(--hlo-brand)]" />
              <span>
                <span className="font-medium">{d.label}</span>
                <span className="block text-xs text-ink-muted">
                  {!blocked
                    ? d.key === "keep_active" && wo.keepNeedsPathologist
                      ? "The source canceled this work: keeping it records a new authorization by you as the dermatopathologist."
                      : d.hint
                    : d.key === "keep_active"
                      ? "Not available: the source canceled this work. Only the dermatopathologist can authorize keeping it."
                      : "Not available: material is already prepared and cannot be voided."}
                </span>
              </span>
            </label>
          );
        })}
        <Field label="Review note" required error={blank ? "Add a short note: what was decided and why." : undefined}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Stained PAS slide retained and filed with the case" />
        </Field>
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!!disabledReason} loading={cmd.pending} loadingLabel="Recording..." onClick={() => void submit()}>
          Record review decision
        </Button>
        <Button variant="quiet" size="sm" onClick={() => setFormOpen(false)}>
          Not now
        </Button>
      </div>
      </>
      )}
      <CommandError error={cmd.error} className="mt-1" />
    </li>
  );
}

export function WorkOrderReviews({ items, recent, now }: { items: WorkOrderReviewView[]; recent: ReturnType<typeof listRecentWorkOrderReviews>; now: string }) {
  if (!items.length && !recent.length) return null;
  return (
    <section aria-labelledby="wo-review-title" className="flex flex-col gap-2">
      {items.length ? (
        <AlertBanner tone="warning" title={`${items.length} work order${items.length === 1 ? "" : "s"} changed at the source after material was printed or prepared`} headingLevel={2}>
          Nothing is deleted. Record a review decision for each; prepared slides stay on record with their disposition.
        </AlertBanner>
      ) : null}
      <h2 id="wo-review-title" className="sr-only">
        Source changes to review
      </h2>
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((wo) => (
            <ReviewCard key={wo.id} wo={wo} />
          ))}
        </ul>
      ) : null}
      {recent.length ? (
        <details className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-ink-secondary">Recently reviewed source changes ({recent.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {recent.map((r) => (
              <li key={r.displayId}>
                <span className="id-mono font-medium">{r.displayId}</span> for <span className="id-mono">{r.accessionNumber}</span>: {r.decision?.replace(/_/g, " ")} by {r.reviewedBy ?? "Unknown"}{" "}
                {r.reviewedAt ? <Timestamp iso={r.reviewedAt} now={now} /> : null}
                <span className="block text-xs text-ink-muted">
                  {r.slides.map((s) => `${s.label}: ${s.disposition}`).join("; ") || "No slides"}. Note: {r.note}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
