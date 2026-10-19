"use client";

import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { Button, DisabledReason, type ButtonSize } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea, Checkbox } from "@/components/ui/field";
import { IdText } from "@/components/domain/id-text";
import { useCommand } from "@/lib/client/command";
import { useActor } from "@/lib/client/shell-context";
import type { ActionView, ClarificationDetail, HoldView } from "@/server/queries/clarifications";

/**
 * The dialogs behind the decisions that need protected focus (resolve,
 * cancel, release a hold). Each maps to one server command; the server
 * re-checks role, state and version. Disabled triggers always show the reason.
 */

/** Ctrl/Cmd+Enter inside a dialog runs its confirm button (the dialog owns its keys). */
function onDialogShortcut(run: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
      e.preventDefault();
      run();
    }
  };
}

/** Trigger styling: docked (the next step: full width, Ctrl+Enter target) or inline. */
interface TriggerProps {
  docked?: boolean;
  size?: ButtonSize;
  reasonId?: string;
}

// ------------------------------------------------------------------ resolve (with optional, separate hold releases)

export function ResolveDialog({ detail, action, docked, reasonId }: { detail: ClarificationDetail; action: ActionView } & TriggerProps) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(detail.resolutionCodes[0]?.code ?? "other");
  const [note, setNote] = useState("");
  const [release, setRelease] = useState<Record<string, boolean>>({});
  const [releaseReason, setReleaseReason] = useState("");
  const [touched, setTouched] = useState(false);
  const active = detail.holds.filter((h) => h.status === "active");
  const releaseIds = active.filter((h) => release[h.id]).map((h) => h.id);
  const cmd = useCommand<{ displayId: string; releasedHolds: { displayId: string }[]; holdsStillActive: { displayId: string }[] }, Record<string, unknown>>(
    "clarification.resolve",
    {
      successToast: (r) =>
        `${r.displayId} resolved.${r.releasedHolds.length ? ` Released ${r.releasedHolds.map((h) => h.displayId).join(", ")} (recorded separately).` : ""}${r.holdsStillActive.length ? ` Still on hold: ${r.holdsStillActive.map((h) => h.displayId).join(", ")}.` : ""}`,
      onSuccess: () => setOpen(false),
    },
  );
  const noteMissing = touched && !note.trim();
  const reasonMissing = touched && releaseIds.length > 0 && !releaseReason.trim();
  const submit = () => {
    setTouched(true);
    if (cmd.pending || !note.trim() || (releaseIds.length > 0 && !releaseReason.trim())) return;
    void cmd.run({
      clarificationId: detail.row.id,
      expectedVersion: detail.row.version,
      resolutionCode: code,
      note: note.trim(),
      releaseHoldIds: releaseIds.length ? releaseIds : undefined,
      releaseReason: releaseIds.length ? releaseReason.trim() : undefined,
    });
  };
  const confirmLabel = releaseIds.length ? (releaseIds.length === 1 ? "Resolve and release hold" : "Resolve and release holds") : active.length ? "Resolve, keep hold" : "Resolve";
  return (
    <>
      <Button
        variant="primary"
        size={docked ? "block" : "md"}
        disabled={!action.enabled}
        reasonId={!action.enabled ? reasonId : undefined}
        aria-keyshortcuts={docked ? "Control+Enter Meta+Enter" : undefined}
        data-clr-primary={docked ? "" : undefined}
        onClick={() => setOpen(true)}
      >
        Resolve
        {docked && action.enabled ? <CtrlEnterBadge onDark /> : null}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Resolve ${detail.row.displayId}?`}
        description={`${detail.row.categoryLabel} question on ${detail.row.affectedLabel}. Resolving closes the question. It does not release any hold by itself.`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={cmd.pending}>
              Keep open
            </Button>
            <Button variant="primary" onClick={submit} loading={cmd.pending} loadingLabel="Resolving..." aria-keyshortcuts="Control+Enter Meta+Enter">
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3" onKeyDown={onDialogShortcut(submit)}>
          <Field label="Resolution" required>
            <Select value={code} onChange={(e) => setCode(e.target.value)}>
              {detail.resolutionCodes.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Resolution note" required error={noteMissing ? "Write what was decided and why." : undefined}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {active.length ? (
            <fieldset className="hatch flex flex-col gap-2 rounded-md border border-hold-border px-3 py-2.5">
              <legend className="rounded-sm bg-surface px-1 text-sm font-semibold text-hold-fg">Holds linked to this clarification</legend>
              <p className="text-sm text-ink">
                Releasing is optional and recorded as a separate, audited hold release with its own reason. Leave unchecked to keep the hold (for example until an amended order arrives).
              </p>
              {active.map((h) => (
                <Checkbox
                  key={h.id}
                  checked={!!release[h.id]}
                  onChange={(e) => setRelease((r) => ({ ...r, [h.id]: e.target.checked }))}
                  label={
                    <span>
                      Also release <span className="id-mono font-medium">{h.displayId}</span> ({h.scopeLabel})
                    </span>
                  }
                  hint={`${h.scopeText} Blocks: ${h.blockLabels.join(", ")}.`}
                />
              ))}
              {releaseIds.length ? (
                <Field label="Hold release reason" required error={reasonMissing ? "Give a reason for releasing the hold." : undefined}>
                  <Textarea rows={2} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />
                </Field>
              ) : null}
            </fieldset>
          ) : (
            <p className="text-sm text-ink-secondary">No active hold is linked to this clarification.</p>
          )}
          <CommandError error={cmd.error} />
        </div>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ cancel

export function CancelDialog({ detail, action }: { detail: ClarificationDetail; action: ActionView }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const cmd = useCommand<{ displayId: string }, Record<string, unknown>>("clarification.cancel", {
    successToast: (r) => `${r.displayId} canceled. Linked holds stay until released separately.`,
    onSuccess: () => setOpen(false),
  });
  const activeHolds = detail.holds.filter((h) => h.status === "active");
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="quiet" size="sm" disabled={!action.enabled} onClick={() => setOpen(true)}>
        Cancel clarification
      </Button>
      {!action.enabled && action.reason ? <DisabledReason id={`${detail.row.id}-cancel-reason`}>{action.reason}</DisabledReason> : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Cancel ${detail.row.displayId}?`}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={cmd.pending}>
              Keep clarification
            </Button>
            <Button
              variant="destructive"
              loading={cmd.pending}
              loadingLabel="Canceling..."
              onClick={() => {
                setTouched(true);
                if (!reason.trim()) return;
                void cmd.run({ clarificationId: detail.row.id, reason: reason.trim(), expectedVersion: detail.row.version });
              }}
            >
              Cancel clarification
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            The question is closed without an answer.{" "}
            {activeHolds.length ? `${activeHolds.map((h) => h.displayId).join(", ")} stays active until it is released separately.` : "No hold is linked."}
          </p>
          <Field label="Reason" required error={touched && !reason.trim() ? "A reason is required to cancel." : undefined}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <CommandError error={cmd.error} />
        </div>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ hold release

/** Why this person cannot release the hold now, or null. Mirrors the server rule (the server decides). */
export function releaseBlockedReason(role: string, hold: HoldView, clarificationOpen: boolean, clarificationLabel: string, action?: ActionView): string | null {
  const isSupervisor = role === "supervisor";
  const permitted = action ? action.enabled : role === "accessioning_lead" || isSupervisor;
  if (!permitted) return action?.reason ?? "Only an accessioning lead or operations supervisor can release a hold.";
  if (clarificationOpen && !isSupervisor) return `Resolve ${clarificationLabel} first. Only the operations supervisor can release a hold while its clarification is open (override with reason).`;
  return null;
}

export function ReleaseHoldDialog({
  hold,
  clarificationOpen,
  clarificationLabel,
  action,
  docked,
}: {
  hold: HoldView;
  clarificationOpen: boolean;
  clarificationLabel: string;
  action?: ActionView;
} & TriggerProps) {
  const actor = useActor();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [touched, setTouched] = useState(false);
  const reasonId = `${hold.id}-release-reason`;
  const cmd = useCommand<{ displayId: string; alreadyReleased: boolean }, Record<string, unknown>>("hold.release", {
    successToast: (r) => (r.alreadyReleased ? `${r.displayId} was already released.` : `${r.displayId} released. The release and its reason are in History.`),
    onSuccess: () => setOpen(false),
  });
  const blockedReason = releaseBlockedReason(actor.role, hold, clarificationOpen, clarificationLabel, action);
  return (
    <div className={cn("flex flex-col items-start gap-1", docked && "w-full")}>
      <Button
        variant={docked || !clarificationOpen ? "primary" : "secondary"}
        size={docked ? "block" : "sm"}
        disabled={Boolean(blockedReason)}
        reasonId={blockedReason ? reasonId : undefined}
        aria-keyshortcuts={docked ? "Control+Enter Meta+Enter" : undefined}
        data-clr-primary={docked ? "" : undefined}
        onClick={() => setOpen(true)}
      >
        Release {hold.displayId}
        {docked && !blockedReason ? <CtrlEnterBadge onDark /> : null}
      </Button>
      {blockedReason ? (
        <p id={reasonId} className="max-w-[56ch] text-sm text-ink-secondary">
          <IdText text={blockedReason} />
        </p>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Release ${hold.displayId} on ${hold.scopeShort}?`}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={cmd.pending}>
              Keep hold
            </Button>
            <Button
              variant="primary"
              loading={cmd.pending}
              loadingLabel="Releasing..."
              disabled={clarificationOpen && !override}
              onClick={() => {
                setTouched(true);
                if (!reason.trim()) return;
                void cmd.run({ holdId: hold.id, expectedVersion: hold.version, reason: reason.trim(), overrideOpenClarification: clarificationOpen ? override : undefined });
              }}
            >
              Release hold
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            This lets {hold.scopeShort} continue: {hold.blockLabels.join(", ")}. {hold.siblingNote}
          </p>
          {clarificationOpen ? (
            <Checkbox
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              label={`Supervisor override: release before ${clarificationLabel} is resolved`}
              hint="Recorded as an override in History."
            />
          ) : null}
          <Field label="Release reason" required error={touched && !reason.trim() ? "A release reason is required." : undefined}>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <CommandError error={cmd.error} />
        </div>
      </Dialog>
    </div>
  );
}
