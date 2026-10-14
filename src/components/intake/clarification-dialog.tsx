"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Select, Textarea, Checkbox } from "@/components/ui/field";
import { ProvisionalChip, IdChip } from "@/components/domain/chips";
import { HoldPill } from "@/components/domain/hold";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { useToast } from "@/components/ui/toast";
import { CLARIFICATION_CATEGORY } from "@/lib/domain";

export const HOLD_BLOCK_WORDS: Record<string, string> = {
  accession_request: "accession request",
  routing_confirm: "routing confirmation",
  gross_approval: "gross approval",
  processing: "processing",
  sectioning: "sectioning",
  print: "label printing",
  tray_delivery: "tray delivery",
  all: "every step",
};

export interface ClarificationDraft {
  category: keyof typeof CLARIFICATION_CATEGORY;
  refs: { intakeItemId: string; sourceOrderId?: string | null; orderPartId?: string | null; containerId?: string | null };
  /** Identity shown at the top of the dialog (never changes while it is open). */
  intakeDisplayId: string;
  orderRef?: string | null;
  partLabel?: string | null;
  subjectLabel: string;
  question: string;
  evidence: { field: string; order_value: string | null; observed_value: string | null; requisition_value: string | null; source: string }[];
  priority: "routine" | "high" | "urgent";
  hold: { scope: { type: string; id: string }; scopeLabel: string; blocks: string[] } | null;
}

interface CreateResult {
  clarificationId: string;
  displayId: string;
  duplicate?: boolean;
}

/**
 * "Raise clarification" from a differing comparison row (or a missing
 * container / related-order question). Calls the clarifications slice's
 * `clarification.create` with the evidence and a hold scoped to the affected
 * material. Notifications are simulated and happen later from /clarifications.
 */
export function RaiseClarificationDialog({ draft, onClose }: { draft: ClarificationDraft | null; onClose: () => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<string>("other");
  const [priority, setPriority] = useState<string>("high");
  const [withHold, setWithHold] = useState(true);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const { run, pending, error, reset } = useCommand<CreateResult, unknown>("clarification.create", { errorToast: false });

  useEffect(() => {
    if (!draft) return;
    setQuestion(draft.question);
    setCategory(draft.category);
    setPriority(draft.priority);
    setWithHold(!!draft.hold);
    setCreated(null);
    reset();
  }, [draft, reset]);

  const dirty = !!draft && !created && question.trim() !== draft.question.trim();
  useUnsavedChanges(dirty, draft ? `clarification for ${draft.subjectLabel}` : "clarification");

  if (!draft) return null;

  const submit = async () => {
    const out = await run({
      category,
      refs: draft.refs,
      subjectLabel: draft.subjectLabel,
      question: question.trim(),
      evidence: draft.evidence,
      priority,
      ...(withHold && draft.hold ? { hold: draft.hold } : {}),
    });
    if (out.ok) {
      setCreated(out.result);
      toast.show({
        tone: out.result.duplicate ? "info" : "success",
        title: out.result.duplicate
          ? `${out.result.displayId} is already open for this question. No duplicate was created.`
          : `Clarification ${out.result.displayId} created${withHold && draft.hold ? ` with a hold on ${draft.hold.scopeLabel}` : ""}`,
      });
    }
  };

  return (
    <Dialog
      open={!!draft}
      onClose={onClose}
      size="lg"
      title="Raise clarification"
      description="Creates a specimen-specific question owned by the lab. Messages to the office are simulated and are sent from Clarifications."
      footer={
        created ? (
          <>
            <Link className="text-sm font-medium text-brand underline-offset-2 hover:underline" href={`/clarifications?selected=${encodeURIComponent(created.displayId)}`}>
              Open {created.displayId} in Clarifications
            </Link>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close without raising
            </Button>
            <Button variant="primary" loading={pending} loadingLabel="Raising..." disabled={!question.trim()} onClick={() => void submit()}>
              Raise clarification
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
          <ProvisionalChip id={draft.intakeDisplayId} href={false} />
          {draft.orderRef ? <IdChip kind="ORD" id={draft.orderRef} /> : null}
          {draft.partLabel ? <span className="font-semibold">{draft.partLabel}</span> : null}
          <span className="text-ink-muted">Subject: {draft.subjectLabel}</span>
        </div>

        {created ? (
          <p className="text-sm text-ink">
            {created.duplicate ? "An open clarification already covers this question: " : "Created "}
            <IdChip kind="CLR" id={created.displayId} href={`/clarifications?selected=${encodeURIComponent(created.displayId)}`} />.
            {" "}Accession can be requested once every discrepancy on this item is covered by a clarification and the other checks pass.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Field label="Category" required>
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {Object.entries(CLARIFICATION_CATEGORY).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" required>
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="routine">Routine</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </Field>
            </div>
            <Field label="Question for the office" required hint="Plain words. The simulated notification itself will not contain patient details.">
              <Textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
            </Field>
            {draft.evidence.length ? (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">Evidence kept with the clarification (original values)</p>
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">Discrepancy evidence</caption>
                  <thead>
                    <tr className="bg-surface-subtle text-left text-xs text-ink-secondary">
                      <th scope="col" className="px-2 py-1 font-medium">Field</th>
                      <th scope="col" className="px-2 py-1 font-medium">Order (source)</th>
                      <th scope="col" className="px-2 py-1 font-medium">Bottle (observed)</th>
                      <th scope="col" className="px-2 py-1 font-medium">Requisition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.evidence.map((e) => (
                      <tr key={e.field} className="border-t border-line">
                        <th scope="row" className="px-2 py-1 text-left font-medium">{e.field}</th>
                        <td className="px-2 py-1">{e.order_value ?? <span className="text-ink-muted">Not stated</span>}</td>
                        <td className="px-2 py-1">{e.observed_value ?? <span className="text-ink-muted">Not on label</span>}</td>
                        <td className="px-2 py-1">{e.requisition_value ?? <span className="text-ink-muted">Not on requisition</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {draft.hold ? (
              <div className="rounded-md border border-hold-border bg-hold-bg px-3 py-2">
                <Checkbox
                  checked={withHold}
                  onChange={(e) => setWithHold(e.target.checked)}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      Place a scoped hold <HoldPill scope={draft.hold.scopeLabel} />
                    </span>
                  }
                  hint={`Blocks ${draft.hold.blocks.map((b) => HOLD_BLOCK_WORDS[b] ?? b).join(", ")} for ${draft.hold.scopeLabel} only. ${
                    draft.hold.blocks.includes("accession_request") || draft.hold.blocks.includes("all")
                      ? "Accession is blocked until the hold is released."
                      : "Accession is not blocked; the hold follows the part onto the case."
                  } Only a lead or supervisor can release it, with a reason.`}
                />
              </div>
            ) : null}
            <CommandError error={error} />
            {error?.code === "NOT_FOUND" && /Unknown command/.test(error.message) ? (
              <p className="text-xs text-ink-secondary">The clarifications module is not available in this build. Nothing was created.</p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
