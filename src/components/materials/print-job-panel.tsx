"use client";

import Link from "next/link";
import { useState } from "react";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { BLOCK_STATE, SLIDE_STATE, type BlockState, type SlideState } from "@/lib/domain";
import { Printer, RotateCcw, FlaskConical, Ban, Send } from "lucide-react";
import { SidePanel } from "@/components/ui/side-panel";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { FactList } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Timeline, sourceFromOrigin } from "@/components/ui/timeline";
import { useToast } from "@/components/ui/toast";
import { IdChip } from "@/components/domain/chips";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useCan } from "@/lib/client/shell-context";
import { useScan } from "@/lib/client/scan";
import type { PrintJobDetail, LabelView } from "@/server/queries/materials";
import { LabelPreviewPanel } from "./label-preview-panel";
import { OrderAdditionalDialog, ReasonDialog, ReprintDialog } from "./print-dialogs";
import { printerName, SectionTitle, useReadOnly } from "./shared";

const RECONCILIATION_TEXT: Record<string, string> = {
  printed_ok: "Checked at the printer: label printed",
  not_printed: "Checked at the printer: not printed",
  printed_damaged: "Checked: printed but damaged",
  cant_tell: "Could not tell — escalated to a supervisor",
};

const LABEL_TONE: Record<string, "neutral" | "info" | "success"> = { printed: "neutral", applied: "info", verified: "success", retired: "neutral" };
const LABEL_TEXT: Record<string, string> = { printed: "Printed", applied: "Applied", verified: "Scan matched", retired: "Retired" };

type ReconcileInput = { printJobId: string; expectedVersion: number; outcome: string; note: string };

/**
 * A person records what came out of the printer: for a job with an unknown outcome
 * (simulated timeout), or for a job a printer acknowledged without reporting completion.
 * No label record exists until this is done (an acknowledgement is not proof of output).
 */
function OutputCheck({ detail, now }: { detail: PrintJobDetail; now: string }) {
  const { job } = detail;
  const toast = useToast();
  const can = useCan("print.reconcile");
  const readOnly = useReadOnly();
  const [note, setNote] = useState("");
  const [needNote, setNeedNote] = useState<string | null>(null);
  const cmd = useCommand<{ message: string; state: string }, ReconcileInput>("print.reconcile", { errorToast: false });
  const record = async (outcome: string) => {
    if ((outcome === "cant_tell" || outcome === "printed_damaged") && !note.trim()) {
      setNeedNote(outcome === "cant_tell" ? "Describe what you checked so the supervisor can follow up." : "Describe the damage (for example: smudged code).");
      return;
    }
    setNeedNote(null);
    const out = await cmd.run({ printJobId: job.id, expectedVersion: job.version, outcome, note: note.trim() });
    if (out.ok) {
      toast.show({ tone: out.result.state === "unknown_outcome" ? "warning" : "success", title: `${job.displayId} reconciled`, body: out.result.message });
      setNote("");
    }
  };
  const disabledReason = readOnly ?? (can.allowed ? null : `${can.reason} A histotechnologist, histology assistant or supervisor records the outcome.`);
  const escalated = job.reconciliation === "cant_tell";
  const unknown = job.state === "unknown_outcome";
  return (
    <AlertBanner
      tone={unknown ? "warning" : "info"}
      title={
        unknown
          ? job.acknowledgedAt
            ? `${job.displayId}: outcome unknown. The printer acknowledged the job (simulated), but nobody could tell whether a label came out.`
            : `${job.displayId}: printer did not confirm after 30 s (simulated timeout). Outcome unknown.`
          : `${job.displayId}: the printer acknowledged the job (simulated) but does not report completion.`
      }
    >
      <p>
        {unknown
          ? "Check the printer output before retrying. A retry is not possible until the outcome is recorded."
          : "Check the printer output and record what came out. The label can be applied only after it is recorded as printed."}
      </p>
      {escalated ? (
        <p className="mt-1 text-warning-fg">
          Escalated by {job.reconciledBy ?? "Unknown"}{job.reconciledAt ? <> at <Timestamp iso={job.reconciledAt} now={now} /></> : null}: {job.reconciliationNote}
        </p>
      ) : null}
      <div className="mt-2 flex flex-col gap-2">
        <Field label="What you checked (needed for Can't tell or damaged)" error={needNote ?? undefined}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={!!disabledReason} placeholder={`For example: output tray empty, no label for ${detail.target.label}`} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!!disabledReason || cmd.pending} onClick={() => void record("printed_ok")}>
            Label printed
          </Button>
          <Button size="sm" variant="secondary" disabled={!!disabledReason || cmd.pending} onClick={() => void record("not_printed")}>
            Not printed
          </Button>
          <Button size="sm" variant="secondary" disabled={!!disabledReason || cmd.pending} onClick={() => void record("cant_tell")}>
            Can&apos;t tell (escalate)
          </Button>
          <Button size="sm" variant="secondary" disabled={!!disabledReason || cmd.pending} onClick={() => void record("printed_damaged")}>
            Printed but damaged
          </Button>
        </div>
        {disabledReason ? <DisabledReason id={`rec-${job.id}`}>{disabledReason}</DisabledReason> : null}
        <CommandError error={cmd.error} />
      </div>
    </AlertBanner>
  );
}

function VerifyForm({ label }: { label: LabelView }) {
  const [value, setValue] = useState("");
  const toast = useToast();
  const scan = useScan();
  const cmd = useCommand<{ verified: boolean; message: string }, { labelId: string; scannedPayload: string }>("label.verify", { errorToast: false });
  const submit = async (payload: string) => {
    if (!payload.trim()) return;
    const out = await cmd.run({ labelId: label.id, scannedPayload: payload.trim() });
    if (out.ok) {
      scan.setResult(
        out.result.verified ? { tone: "success", message: out.result.message } : { tone: "danger", alert: true, message: out.result.message },
        payload,
      );
      toast.show({ tone: out.result.verified ? "success" : "warning", title: out.result.verified ? "Label scan matched its record" : "Label scan not accepted", body: out.result.message });
      setValue("");
    }
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <Field label="Scan the applied label" className="flex-1">
          <Input size="sm" mono value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit(value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Button size="sm" variant="secondary" loading={cmd.pending} onClick={() => void submit(value)}>
          Check scan
        </Button>
      </div>
      <Button size="sm" variant="quiet" className="self-start" onClick={() => void submit(label.payload)}>
        Simulate scanning this label
      </Button>
      <CommandError error={cmd.error} />
    </div>
  );
}

function LabelRow({ label, now }: { label: LabelView; now: string }) {
  const [retireOpen, setRetireOpen] = useState(false);
  const canApply = useCan("label.apply");
  const canRetire = useCan("label.retire");
  const readOnly = useReadOnly();
  return (
    <li className="rounded-md border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="id-mono text-sm font-medium">{label.text}</span>
        <StatusPill size="sm" tone={LABEL_TONE[label.state] ?? "neutral"}>
          {LABEL_TEXT[label.state] ?? label.state}
        </StatusPill>
        {label.printJobDisplayId ? <span className="text-xs text-ink-muted">from {label.printJobDisplayId}</span> : null}
        {label.replacesLabelId ? <span className="text-xs text-ink-muted">· replaces an earlier label</span> : null}
      </div>
      <p className="mt-1 text-xs text-ink-secondary">
        Output confirmed <Timestamp iso={label.createdAt} now={now} />
        {label.appliedAt ? <> · applied by {label.appliedBy ?? "Unknown"} <Timestamp iso={label.appliedAt} now={now} /></> : " · not applied"}
        {label.verifiedAt ? <> · scan matched for {label.verifiedBy ?? "Unknown"} <Timestamp iso={label.verifiedAt} now={now} /></> : null}
        {label.retiredAt ? <> · retired by {label.retiredBy ?? "Unknown"}: {label.retireReason}</> : null}
      </p>
      {label.state !== "retired" && !readOnly ? (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          {label.state === "printed" ? (
            <CommandButton
              command="label.apply"
              input={{ labelId: label.id }}
              size="sm"
              pendingLabel="Recording..."
              disabledReason={canApply.allowed ? undefined : canApply.reason}
              successToast={(r: { message: string }) => r.message}
            >
              Record label applied
            </CommandButton>
          ) : null}
          <Button size="sm" variant="quiet" disabled={!canRetire.allowed} onClick={() => setRetireOpen(true)}>
            Retire label
          </Button>
        </div>
      ) : null}
      {label.state === "applied" && !readOnly && canApply.allowed ? <VerifyForm label={label} /> : null}
      <ReasonDialog
        open={retireOpen}
        onClose={() => setRetireOpen(false)}
        title={`Retire label ${label.text}?`}
        description="Records that this physical label was removed and destroyed (or never used). The slide or block record is not changed."
        label="Reason"
        placeholder="Damaged label removed and destroyed at the bench"
        confirmLabel="Retire label"
        cancelLabel="Keep label"
        command="label.retire"
        buildInput={(reason) => ({ labelId: label.id, reason })}
        successTitle={() => `Label ${label.text} retired`}
        destructive
      />
    </li>
  );
}

export function PrintJobPanel({ detail, now, closeHref }: { detail: PrintJobDetail; now: string; closeHref: string }) {
  const { job, target, printer } = detail;
  const [reprintOpen, setReprintOpen] = useState(false);
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const canPrint = useCan("print.request");
  const canRetire = useCan("label.retire");
  const canOrder = useCan("workorder.review");
  const readOnly = useReadOnly();
  const activeLabel = detail.labels.find((l) => l.state !== "retired" && l.printJobDisplayId === job.displayId) ?? null;
  const replacedBy = detail.head && detail.head.id !== job.id ? detail.head : null;

  const reprintBlocked =
    job.state === "unknown_outcome"
      ? "Reconcile the unknown outcome first (check the printer)."
      : job.needsOutputCheck
        ? "Record what came out of the printer first (Label printed / Not printed / Printed but damaged)."
        : job.state === "queued" || job.state === "planned" || job.state === "submitted"
          ? "Still in the print queue: release or cancel it instead."
          : job.state === "canceled"
            ? "Canceled before printing: print the label again from the record."
            : replacedBy
              ? `Already replaced by ${replacedBy.displayId}. If that label also needs replacing, reprint from ${replacedBy.displayId}.`
              : target.status && target.status !== "active"
                ? "The record is not active (canceled or under review)."
                : null;
  const reprintReason = readOnly ?? (canPrint.allowed ? reprintBlocked : canPrint.reason);

  return (
    <SidePanel
      title={target.label}
      identity={<IdChip kind="PJ" id={job.displayId} showKind />}
      status={<StatePill domain="print" state={job.state} />}
      fullRecordHref={target.accessionNumber ? `/cases/${target.accessionNumber}` : undefined}
      closeHref={closeHref}
      focusKey={job.id}
    >
      {/* relative: keeps visually hidden (absolutely positioned) text inside the panel's scroll area */}
      <div className="relative flex flex-col gap-4">
        {job.state === "unknown_outcome" || job.needsOutputCheck ? <OutputCheck detail={detail} now={now} /> : null}
        {replacedBy ? (
          <AlertBanner tone="info" title={`Replaced by ${replacedBy.displayId}`}>
            A newer job exists for this label.{" "}
            <Link href={`/materials?tab=print&selected=${encodeURIComponent(replacedBy.displayId)}`} scroll={false} className="font-medium text-brand underline-offset-2 hover:underline">
              Open {replacedBy.displayId}
            </Link>
          </AlertBanner>
        ) : null}
        {(job.state === "queued" || job.state === "planned") && job.failureDetail ? (
          <AlertBanner
            tone="danger"
            title={`${printer ? printerName(printer.name) : "Printer"} is unavailable (simulated). ${job.displayId} is kept in the queue.`}
            action={
              readOnly ? null : (
                <CommandButton command="print.release" input={{ printJobId: job.id }} size="sm" pendingLabel="Releasing..." successToast={(r: { message: string }) => r.message} icon={<Send className="size-4" aria-hidden />}>
                  Release to printer
                </CommandButton>
              )
            }
          >
            It will not print until it is released. Nothing is lost.
          </AlertBanner>
        ) : null}
        {job.state === "failed" && !replacedBy ? (
          <AlertBanner tone="info" title={job.reconciliation === "not_printed" ? "Recorded as not printed. A reprint with a reason is now allowed." : "This job failed. A reprint with a reason is allowed."} />
        ) : null}

        <FactList
          items={[
            {
              label: target.type === "block" ? "Block" : "Slide",
              value: target.physicalState
                ? `${(target.type === "block" ? BLOCK_STATE[target.physicalState as BlockState] : SLIDE_STATE[target.physicalState as SlideState]) ?? target.physicalState.replace(/_/g, " ")}${
                    target.physicalState === "planned" ? " (not yet cut)" : ""
                  }${target.status && target.status !== "active" ? ` · ${target.status.replace(/_/g, " ")}` : ""}`
                : <UnknownValue reason="no slide or block record" />,
            },
            ...(target.workOrder ? [{ label: "Work order", value: `${target.workOrder.displayId} · ${target.workOrder.statusLabel}` }] : []),
            { label: "Purpose", value: job.purposeLabel },
            { label: "Printer", value: <span className="inline-flex flex-wrap items-center gap-1.5">{printerName(printer?.name ?? job.printerName)} <SimulatedLabel connector="printer" size="xs" /></span> },
            { label: "Requested", value: <>{job.requestedBy}, <Timestamp iso={job.createdAt} now={now} /></> },
            { label: "Submitted", value: job.submittedAt ? <Timestamp iso={job.submittedAt} now={now} /> : "Not submitted" },
            {
              label: "Printer reply (simulated)",
              value: job.completedAt ? (
                <>Printer reported completion <Timestamp iso={job.completedAt} now={now} /></>
              ) : job.acknowledgedAt ? (
                <>Acknowledged <Timestamp iso={job.acknowledgedAt} now={now} /> (this printer does not report completion)</>
              ) : job.submittedAt ? (
                <UnknownValue reason="no reply within 30 s" />
              ) : (
                "None (not submitted)"
              ),
            },
            ...(job.reprintOfDisplayId ? [{ label: "Reprint of", value: <><span className="id-mono">{job.reprintOfDisplayId}</span>: {job.reprintReason}</> }] : []),
            ...(job.reconciliation
              ? [
                  {
                    label: "Output checked by a person",
                    value: (
                      <>
                        {RECONCILIATION_TEXT[job.reconciliation] ?? job.reconciliation} · {job.reconciledBy ?? "Unknown"}
                        {job.reconciledAt ? <>, <Timestamp iso={job.reconciledAt} now={now} /></> : null}
                        {job.reconciliationNote ? `: ${job.reconciliationNote}` : ""}
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />

        {!readOnly ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" icon={<RotateCcw className="size-4" aria-hidden />} disabled={!!reprintReason} reasonId={reprintReason ? `rp-${job.id}` : undefined} onClick={() => setReprintOpen(true)}>
                Reprint with reason
              </Button>
              {(job.state === "queued" || job.state === "planned") && !job.failureDetail ? (
                <CommandButton command="print.release" input={{ printJobId: job.id }} size="sm" icon={<Printer className="size-4" aria-hidden />} successToast={(r: { message: string }) => r.message}>
                  Release to printer
                </CommandButton>
              ) : null}
              {job.state === "queued" || job.state === "planned" ? (
                <Button size="sm" variant="quiet" icon={<Ban className="size-4" aria-hidden />} onClick={() => setCancelOpen(true)}>
                  Cancel job
                </Button>
              ) : null}
              {target.blockId ? (
                <Button size="sm" variant="secondary" icon={<FlaskConical className="size-4" aria-hidden />} disabled={!canOrder.allowed} onClick={() => setAdditionalOpen(true)}>
                  Order additional slide
                </Button>
              ) : null}
            </div>
            {reprintReason ? <DisabledReason id={`rp-${job.id}`}>Reprint: {reprintReason}</DisabledReason> : null}
            {!canOrder.allowed && target.blockId ? <p className="text-xs text-ink-secondary">Ordering an additional slide: {canOrder.reason}</p> : null}
            <p className="text-xs text-ink-muted">Reprint replaces a label on the same record. &quot;Order additional slide&quot; creates a new work order and a new slide.</p>
          </div>
        ) : (
          <p className="text-sm text-ink-secondary">{readOnly}</p>
        )}

        {detail.openTasks.length ? (
          <section className="flex flex-col gap-1.5">
            <SectionTitle>Who owns the next step</SectionTitle>
            <ul className="flex flex-col gap-1 text-sm">
              {detail.openTasks.map((t) => (
                <li key={t.id}>
                  {t.title} · <span className="text-ink-secondary">Owner: {t.owner ?? (t.ownerRole ? `Unassigned (${ROLE_LABEL[t.ownerRole as Role] ?? t.ownerRole.replace(/_/g, " ")} on duty)` : "Unassigned")}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <SectionTitle aside="Printing, applying and scanning are separate events">Physical labels for this record</SectionTitle>
          {detail.labels.length ? (
            <ul className="flex flex-col gap-1.5">
              {detail.labels.map((l) => (
                <LabelRow key={l.id} label={l} now={now} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">
              No label is recorded as printed for this record
              {job.state === "unknown_outcome" ? " (the outcome of this job is unknown)" : job.needsOutputCheck ? " (the printer acknowledged the job; nobody has recorded what came out yet)" : ""}.
            </p>
          )}
        </section>

        <LabelPreviewPanel payload={job.payload} text={detail.recordCheck.recordText ?? target.label} check={detail.recordCheck} />

        {detail.chain.length > 1 ? (
          <section className="flex flex-col gap-1.5">
            <SectionTitle>Print history for this label</SectionTitle>
            <ol className="flex flex-col gap-1 text-sm">
              {detail.chain.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className={c.isThis ? "id-mono font-semibold" : "id-mono"}>{c.displayId}</span>
                  <StatePill domain="print" state={c.state} size="sm" />
                  <span className="text-ink-secondary">{c.purposeLabel}</span>
                  {c.reprintReason ? <span className="text-ink-muted">· {c.reprintReason}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <Timeline
          title="History"
          now={now}
          events={detail.history.map((h, i) => ({ id: `${i}-${h.at}`, at: h.at, actorName: h.actor, actorRole: h.role, summary: h.summary, source: sourceFromOrigin(h.origin), reason: h.reason }))}
          emptyText="No recorded events for this job in this demo session (seeded jobs start without history)."
        />
      </div>

      <ReprintDialog
        open={reprintOpen}
        onClose={() => setReprintOpen(false)}
        job={{ id: job.id, displayId: job.displayId, targetLabel: target.label, state: job.state }}
        activeLabelId={activeLabel?.id ?? null}
        canRetire={canRetire.allowed}
      />
      {target.blockId ? (
        <OrderAdditionalDialog open={additionalOpen} onClose={() => setAdditionalOpen(false)} blockId={target.blockId} blockLabel={target.label.split(" ").slice(0, 2).join(" ").replace(/-\d+$/, "")} />
      ) : null}
      <ReasonDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel ${job.displayId} for ${target.label}?`}
        description="Nothing has been printed for this job. Canceling removes it from the queue; the job record is kept."
        label="Reason"
        placeholder="Printed on the backup printer instead"
        confirmLabel="Cancel print job"
        cancelLabel="Keep job"
        command="print.cancel"
        buildInput={(reason) => ({ printJobId: job.id, reason })}
        successTitle={() => `${job.displayId} canceled`}
        destructive
      />
    </SidePanel>
  );
}
