"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import type { ItemDetail } from "@/server/queries/intake";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Textarea } from "@/components/ui/field";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { cn } from "@/lib/cn";
import { Segs, useBackToScan } from "./bits";
import { segs, type NextAction } from "./plan";

type ReviewAction = Extract<NextAction, { kind: "review_source_conflict" }>;

interface ReviewResult {
  taskId: string;
  status: string;
  message: string;
}

/** The one decision this review can record (src/server/domain/sourceConflict.ts). */
const DECISION = "details_on_file_confirmed" as const;
const DECISION_LABEL = "The patient details on file are correct (nothing is changed or merged)";

/**
 * Review a source conflict (accessioning lead or supervisor): the source sent
 * patient or order-level details that differ from what is on file, and the
 * accession waits. The conflict is said in words, then the one decision this
 * review records, with a required reason. Nothing is merged, relinked or
 * overwritten; anything else is a patient identity question for the office.
 */
export function SourceConflictDialog({ action, item, onClose }: { action: ReviewAction; item: ItemDetail; onClose: () => void }) {
  const router = useRouter();
  const backToScan = useBackToScan();
  const [chosen, setChosen] = useState(false);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const decisionRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const decisionErrId = useId();
  useUnsavedChanges(reason.trim().length > 0, "source-conflict review");
  const cmd = useCommand<ReviewResult, { taskId: string; expectedVersion: number; decision: typeof DECISION; reason: string }>("sourceConflict.review", {
    errorToast: false,
    conflict: false,
    successToast: (r) => r.message,
    onSuccess: () => {
      onClose();
      backToScan();
    },
    // A review that changed or closed meanwhile: show the latest state behind the dialog.
    onError: (e) => {
      if (e.code === "CONFLICT" || e.code === "INVARIANT" || e.code === "NOT_FOUND") router.refresh();
    },
  });
  const decisionError = attempted && !chosen ? "Choose the decision to record it." : null;
  const reasonError = attempted && !reason.trim() ? "A reason is required: say what you checked and why the details on file stand." : null;
  const record = () => {
    if (!chosen || !reason.trim()) {
      setAttempted(true);
      (!chosen ? decisionRef.current : reasonRef.current)?.focus();
      return;
    }
    void cmd.run({ taskId: action.taskId, expectedVersion: action.version, decision: DECISION, reason: reason.trim() });
  };
  const p = item.patient;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Review source conflict"
      description="Accession waits for this review. Recording it closes the review only: the patient record, the order and its link are never changed or merged."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={cmd.pending} loadingLabel="Recording..." onClick={record}>
            Record review
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <section aria-label="What the source sent" className="space-y-1.5 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5">
          <p className="flex items-start gap-2 text-base font-semibold text-warning-fg">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
            <span>
              <Segs value={segs(action.conflict)} />
            </span>
          </p>
          {action.detail ? (
            <p className="pl-6 text-sm text-ink">
              <Segs value={segs(action.detail)} />
            </p>
          ) : null}
          {action.orderRefs.length ? (
            <p className="pl-6 text-sm text-ink-secondary">
              Holds back the accession of <span className="id-mono">{item.displayId}</span> (order <Segs value={segs(action.orderRefs.join(", "))} />).
            </p>
          ) : null}
        </section>

        {p ? (
          <div>
            <h3 className="text-sm font-semibold text-ink">On file (kept as it is)</h3>
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt className="text-ink-muted">Patient</dt>
              <dd className="text-ink">{p.name}</dd>
              <dt className="text-ink-muted">Date of birth</dt>
              <dd>
                <span className="id-mono text-ink">{p.birthDate}</span>
              </dd>
              <dt className="text-ink-muted">MRN</dt>
              <dd className="text-ink">
                <span className="id-mono">{p.mrn}</span> <span className="text-ink-muted">in {p.tenantName}</span>
              </dd>
            </dl>
          </div>
        ) : null}

        <fieldset aria-describedby={decisionError ? decisionErrId : undefined} className="space-y-1">
          <legend className="text-sm font-medium text-ink-secondary">
            Decision <span className="font-normal text-ink-muted">(required)</span>
          </legend>
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm",
              chosen ? "border-brand bg-brand-50" : decisionError ? "border-warning-solid bg-warning-bg" : "border-line-strong hover:bg-surface-subtle",
            )}
          >
            <input
              ref={decisionRef}
              type="radio"
              name={`srcconf-${action.taskId}`}
              value={DECISION}
              checked={chosen}
              aria-invalid={decisionError ? true : undefined}
              onChange={() => setChosen(true)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--hlo-brand)]"
            />
            <span className="font-medium text-ink">{DECISION_LABEL}</span>
          </label>
          {decisionError ? (
            <p id={decisionErrId} className="flex items-start gap-1 text-xs font-medium text-warning-fg">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-solid" aria-hidden />
              <span>{decisionError}</span>
            </p>
          ) : null}
          <p className="text-sm text-ink-secondary">
            If the details on file are wrong, or the order is for a different patient, do not record this: raise a patient identity question with the office
            instead. This review never decides who the patient is.
          </p>
        </fieldset>

        <Field label="Reason, recorded with your name" required error={reasonError}>
          <Textarea ref={reasonRef} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}
