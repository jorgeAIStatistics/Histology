"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { SimulatedLabel } from "@/components/domain/honesty";
import { useToast } from "@/components/ui/toast";
import { fieldErrors, useCommand } from "@/lib/client/command";
import { useActor } from "@/lib/client/shell-context";

interface PrintResult {
  outcome: string;
  displayId: string;
  state: string;
  message: string;
  printerUnavailable?: boolean;
  retireLabelId?: string | null;
}

/**
 * Reprint: a new job for the SAME slide/block/case. A reason is required; the
 * original job is linked. When a physical label is being replaced, retiring it
 * is an explicit, separately recorded step (checkbox), never implied.
 */
export function ReprintDialog({
  open,
  onClose,
  job,
  activeLabelId,
  canRetire,
}: {
  open: boolean;
  onClose: () => void;
  job: { id: string; displayId: string; targetLabel: string; state: string };
  activeLabelId: string | null;
  canRetire: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [retire, setRetire] = useState(false);
  const reprint = useCommand<PrintResult, { printJobId: string; reason: string }>("print.reprint", { errorToast: false });
  const retireCmd = useCommand<{ message: string }, { labelId: string; reason: string }>("label.retire", { errorToast: false });
  const [blank, setBlank] = useState(false);

  const submit = async () => {
    if (!reason.trim()) {
      setBlank(true);
      return;
    }
    const out = await reprint.run({ printJobId: job.id, reason: reason.trim() });
    if (!out.ok) return;
    const retireId = out.result.retireLabelId ?? null;
    if (retire && retireId) {
      const r = await retireCmd.run({ labelId: retireId, reason: `Replaced by ${out.result.displayId}: ${reason.trim()}` });
      if (!r.ok) {
        toast.show({ tone: "warning", title: `${out.result.displayId} created, but the old label was not retired`, body: r.error.message });
        onClose();
        return;
      }
    }
    toast.show({
      tone: out.result.outcome === "duplicate_prevented" || out.result.printerUnavailable || out.result.state === "unknown_outcome" ? "warning" : "success",
      title:
        out.result.outcome === "duplicate_prevented"
          ? "No second job created"
          : out.result.state === "unknown_outcome"
            ? `${out.result.displayId}: reprint of ${job.displayId}, outcome unknown (simulated timeout)`
            : `${out.result.displayId}: reprint of ${job.displayId}`,
      body: out.result.message,
    });
    setReason("");
    setRetire(false);
    setBlank(false);
    onClose();
    // Follow the new job so its outcome can be recorded; the original stays linked from its history.
    if (out.result.displayId && out.result.displayId !== job.displayId) {
      router.push(`/materials?tab=print&selected=${encodeURIComponent(out.result.displayId)}`, { scroll: false });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reprint label ${job.targetLabel}`}
      description={`Creates a new print job linked to ${job.displayId} for the same record. No new slide, block or specimen is created.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep current label
          </Button>
          <Button variant="primary" loading={reprint.pending || retireCmd.pending} loadingLabel="Reprinting..." onClick={() => void submit()}>
            Reprint with reason
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Reason for reprint" required error={blank ? "Give a reason, for example: label smudged by solvent." : fieldErrors(reprint.error).reason}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Label smudged by solvent; code unreadable" />
        </Field>
        {activeLabelId ? (
          canRetire ? (
            <Checkbox
              checked={retire}
              onChange={(e) => setRetire(e.target.checked)}
              label="Retire the old label now"
              hint="Only if it was removed from the material and destroyed. Otherwise a task to retire it stays open."
            />
          ) : (
            <p className="text-xs text-ink-secondary">The old label must be retired by a histotechnologist or supervisor; a task will stay open.</p>
          )
        ) : null}
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <SimulatedLabel connector="printer" size="xs" /> The print goes to a simulated printer.
        </p>
        <CommandError error={reprint.error} />
        <CommandError error={retireCmd.error} />
      </div>
    </Dialog>
  );
}

export const STAIN_OPTIONS = ["H&E", "PAS", "GMS", "Giemsa", "Melan-A", "Other"] as const;

/** Order an additional slide: new authorized work order + new planned slide (NOT a reprint). */
export function OrderAdditionalDialog({ open, onClose, blockId, blockLabel }: { open: boolean; onClose: () => void; blockId: string; blockLabel: string }) {
  const toast = useToast();
  const [stain, setStain] = useState<string>("H&E");
  const [other, setOther] = useState("");
  const [level, setLevel] = useState("");
  const [reason, setReason] = useState("");
  const [requestReference, setRequestReference] = useState("");
  const [blank, setBlank] = useState(false);
  // Only the dermatopathologist's own order is recorded as a pathologist request; anyone else says who asked and how.
  const byPathologist = useActor().role === "pathologist";
  const cmd = useCommand<
    { workOrderDisplayId: string; slideLabel: string; message: string },
    { blockId: string; stain: string; level: string | null; reason: string; requestReference: string | null }
  >("slide.orderAdditional", { errorToast: false });
  const submit = async () => {
    const s = stain === "Other" ? other.trim() : stain;
    if (!reason.trim() || !s || (!byPathologist && requestReference.trim().length < 3)) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ blockId, stain: s, level: level.trim() || null, reason: reason.trim(), requestReference: byPathologist ? null : requestReference.trim() });
    if (out.ok) {
      toast.show({ tone: "success", title: `${out.result.workOrderDisplayId}: ${out.result.slideLabel} planned`, body: out.result.message });
      setReason("");
      setLevel("");
      setRequestReference("");
      setBlank(false);
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Order an additional slide on ${blockLabel}`}
      description="Creates a new work order and a new planned slide on this block. This is not a reprint: use Reprint for a damaged label on an existing slide."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Do not order
          </Button>
          <Button variant="primary" loading={cmd.pending} loadingLabel="Ordering..." onClick={() => void submit()}>
            Order additional slide
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Stain" required>
          <Select value={stain} onChange={(e) => setStain(e.target.value)}>
            {STAIN_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        {stain === "Other" ? (
          <Field label="Stain name" required error={blank && !other.trim() ? "Name the stain." : undefined}>
            <Input value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
        ) : (
          <Field label="Level (optional)" hint='For example "deeper L2"'>
            <Input value={level} onChange={(e) => setLevel(e.target.value)} />
          </Field>
        )}
        <Field label="Reason" required className="col-span-2" error={blank && !reason.trim() ? "Say why the slide is needed." : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Deeper level to see the margin" />
        </Field>
        {byPathologist ? null : (
          <Field
            label="Who asked, and how"
            required
            className="col-span-2"
            hint="The work order is recorded as entered by you on this request, not as the dermatopathologist's own order."
            error={blank && requestReference.trim().length < 3 ? "Say who asked for this slide and how." : undefined}
          >
            <Input value={requestReference} onChange={(e) => setRequestReference(e.target.value)} maxLength={200} placeholder="Dr. Marsh, by phone at 10:40" />
          </Field>
        )}
        <CommandError error={cmd.error} className="col-span-2" />
      </div>
    </Dialog>
  );
}

/** A reason is required for cancel / retire / not-found style actions. */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  label,
  placeholder,
  confirmLabel,
  cancelLabel,
  command,
  buildInput,
  successTitle,
  destructive,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  command: string;
  buildInput: (reason: string) => unknown;
  successTitle: (result: { message?: string }) => string;
  destructive?: boolean;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<{ message?: string }, unknown>(command, { errorToast: false });
  const submit = async () => {
    if (!reason.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run(buildInput(reason.trim()));
    if (out.ok) {
      toast.show({ tone: "success", title: successTitle(out.result), body: out.result.message });
      setReason("");
      setBlank(false);
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "primary"} loading={cmd.pending} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Field label={label} required error={blank ? "This needs a short note." : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={placeholder} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}
