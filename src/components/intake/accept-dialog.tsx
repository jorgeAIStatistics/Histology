"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Textarea } from "@/components/ui/field";
import { ProvisionalChip, IdChip } from "@/components/domain/chips";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";

export interface AcceptTarget {
  discrepancyId: string;
  version: number;
  intakeDisplayId: string;
  orderRef: string | null;
  subject: string;
  /** What was recorded, as found (kept unchanged by the acceptance). */
  rows: { label: string; value: string | null }[];
}

/**
 * Accessioning lead / supervisor accepts a recorded mismatch or extra
 * container with a reason. Values stay as found; the decision and the reason
 * are recorded beside them. Patient identity differences are refused by the
 * server (they need a resolved identity clarification).
 */
export function AcceptDiscrepancyDialog({ target, onClose }: { target: AcceptTarget; onClose: () => void }) {
  const [reason, setReason] = useState("");
  useUnsavedChanges(reason.trim().length > 0, `acceptance of ${target.subject}`);
  const cmd = useCommand<{ containerState: string | null }, { discrepancyId: string; expectedVersion: number; reason: string }>("intake.acceptDiscrepancy", {
    errorToast: false,
    successToast: (r) => `${target.subject}: accepted with your reason${r.containerState === "verified" ? "; the container counts as verified" : ""}. Values kept as found.`,
    onSuccess: () => onClose(),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Accept recorded discrepancy"
      description="For a lab-side decision, for example a typing error corrected against the physical label. Questions for the office go through a clarification instead."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it open
          </Button>
          <Button
            variant="primary"
            loading={cmd.pending}
            loadingLabel="Recording..."
            disabled={!reason.trim()}
            onClick={() => void cmd.run({ discrepancyId: target.discrepancyId, expectedVersion: target.version, reason: reason.trim() })}
          >
            Accept with this reason
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
          <ProvisionalChip id={target.intakeDisplayId} href={false} />
          {target.orderRef ? <IdChip kind="ORD" id={target.orderRef} /> : null}
          <span className="font-semibold">{target.subject}</span>
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          {target.rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-ink-muted">{r.label}</dt>
              <dd className="text-ink">{r.value ?? <span className="text-ink-muted">Not stated</span>}</dd>
            </div>
          ))}
        </dl>
        <Field label="Reason" required hint="Recorded with your name in the audit trail. The recorded values are not changed.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}
