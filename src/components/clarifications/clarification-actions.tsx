"use client";

import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Bot, ChevronRight, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/field";
import { AlertBanner } from "@/components/ui/alert-banner";
import { SimulatedLabel } from "@/components/domain/honesty";
import { useCommand } from "@/lib/client/command";
import { useToast } from "@/components/ui/toast";
import { useActor } from "@/lib/client/shell-context";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import type { ActionKey, ActionView, ClarificationDetail, HoldView } from "@/server/queries/clarifications";

/**
 * Actions for one clarification, next valid action first (spec §6.2).
 * Every control maps to one server command; the server re-checks role,
 * state and version. Disabled controls always show the reason in text.
 */

const OUTCOME_TEXT: Record<string, string> = {
  delivered: "Delivered",
  delivery_unknown: "Delivery unknown",
  delivery_failed: "Delivery failed",
};

function isPrimaryShortcut(e: ReactKeyboardEvent): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/** Ctrl/Cmd+Enter runs the current step's primary action (spec §8). Handled once: outer handlers skip prevented events. */
function onPrimaryShortcut(run: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (isPrimaryShortcut(e) && !e.defaultPrevented) {
      e.preventDefault();
      run();
    }
  };
}

function find(detail: ClarificationDetail, key: ActionKey): ActionView | undefined {
  return detail.actions.find((a) => a.key === key);
}

function Reason({ action }: { action?: ActionView }) {
  const id = useId();
  if (!action || action.enabled || !action.reason) return null;
  return <DisabledReason id={id}>{action.reason}</DisabledReason>;
}

/** Collapsible secondary form (native <details>: keyboard and screen reader friendly). */
function Expander({ label, children, defaultOpen }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group/exp rounded-md border border-line" open={defaultOpen}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 px-3 text-sm font-medium text-ink hover:bg-surface-subtle [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-ink-muted transition-transform duration-[var(--hlo-duration-fast)] group-open/exp:rotate-90" aria-hidden />
        {label}
      </summary>
      <div className="border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}

// ------------------------------------------------------------------ send (with drafting assistant)

interface DraftResult {
  question: string;
  notificationBody: string;
  label: string;
  generator: string;
  basedOn: string[];
}

interface SendResult {
  displayId: string;
  duplicate: boolean;
  state: string;
  outcome: string;
  outcomeReason: string;
  contact: { name: string | null; role: string };
  coverageNote: string | null;
}

function SendForm({ detail, send, draftAction }: { detail: ClarificationDetail; send: ActionView; draftAction?: ActionView }) {
  const [question, setQuestion] = useState(detail.question);
  const [body, setBody] = useState(detail.notificationPreview);
  const [draftSource, setDraftSource] = useState<"manual" | "assistant_proposal" | "template">(
    detail.draftSource === "assistant_proposal" || detail.draftSource === "template" ? detail.draftSource : "manual",
  );
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const qId = useId();
  const draftCmd = useCommand<DraftResult, { clarificationId: string }>("clarification.draftMessage", { refresh: false, errorToast: false });
  const sendCmd = useCommand<SendResult, Record<string, unknown>>("clarification.send", {
    successToast: (r) =>
      r.duplicate ? "Already sent. No second message was created." : `${r.displayId} sent (simulated). Connector reported: ${OUTCOME_TEXT[r.outcome] ?? r.outcome}.`,
  });
  const dirty = question.trim() !== detail.question.trim() || body.trim() !== detail.notificationPreview.trim();
  useUnsavedChanges(dirty, `${detail.row.displayId} draft question`);

  const recipient = detail.contact.currentRecipient;
  const assistantOff = detail.assistantMode === "unavailable";
  const draftDisabledReason = assistantOff
    ? "Drafting assistant unavailable (simulated outage). Type the question yourself; sending still works."
    : draftAction && !draftAction.enabled
      ? draftAction.reason
      : null;

  const runDraft = async () => {
    const out = await draftCmd.run({ clarificationId: detail.row.id });
    if (out.ok) {
      setQuestion(out.result.question);
      setBody(out.result.notificationBody.replace(/\s*\[SIMULATED — not sent\]\s*$/, ""));
      setDraftSource("assistant_proposal");
      setDraft(out.result);
    }
  };

  const canSend = send.enabled && question.trim().length > 0;
  const doSend = () => {
    if (!canSend || sendCmd.pending) return;
    void sendCmd.run({
      clarificationId: detail.row.id,
      expectedVersion: detail.row.version,
      question: question.trim(),
      body: body.trim() || undefined,
      draftSource,
    });
  };
  return (
    <div className="flex flex-col gap-3" onKeyDown={onPrimaryShortcut(doSend)}>
      <Field
        id={qId}
        label="Question for the office"
        required
        hint="For the office's secure case view (a future connector; simulated here, nothing leaves the lab). Edit before sending. Kept unchanged once sent."
      >
        <Textarea
          rows={4}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            // Once a person edits the fixed template, it is their own text.
            if (draftSource === "template") setDraftSource("manual");
          }}
        />
      </Field>
      {draftSource === "template" ? (
        <p className="rounded-sm border border-dashed border-line px-2 py-1.5 text-xs text-ink-secondary">
          Default question from a fixed template (rule-based, not AI). Edit before sending.
        </p>
      ) : null}
      {draftSource === "assistant_proposal" ? (
        <p className="flex items-start gap-1.5 rounded-sm border border-dashed border-sim-border bg-sim-bg px-2 py-1.5 text-xs text-sim-fg">
          <Bot className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Draft text: deterministic demo output, not live AI. Edit before sending.
            {draft?.basedOn.length ? <span className="block text-ink-muted">Built only from: {draft.basedOn.join("; ")}. Free-text notes are never read as instructions.</span> : null}
          </span>
        </p>
      ) : null}
      <Field label="Notification text (generic)" hint="Sent through the simulated connector. No patient details: the notice points the office to its secure case view (future connector; simulated here). “[SIMULATED — not sent]” is added automatically.">
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <p className="text-xs text-ink-secondary">
        Recipient now:{" "}
        {recipient ? (
          <span className="text-ink">
            {recipient.name}, {recipient.role} ({detail.office.name}) via {recipient.channelLabel}
          </span>
        ) : (
          <span className="text-ink">No contact on file for {detail.office.name}</span>
        )}
        {detail.contact.coverageNoteNow ? <span className="block text-warning-fg">{detail.contact.coverageNoteNow}</span> : null}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex flex-col items-start gap-1">
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              icon={<Send className="size-4" aria-hidden />}
              loading={sendCmd.pending}
              loadingLabel="Sending..."
              disabled={!canSend}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={doSend}
            >
              Send (simulated)
            </Button>
            <SimulatedLabel connector="notifications" />
          </div>
          {!send.enabled && send.reason ? <p className="max-w-[48ch] text-xs text-ink-secondary">{send.reason}</p> : null}
          {send.enabled && !question.trim() ? <p className="text-xs text-ink-secondary">Write the question before sending.</p> : null}
        </div>
        <div className="flex flex-col items-start gap-1">
          <Button
            variant="secondary"
            icon={<Bot className="size-4" aria-hidden />}
            loading={draftCmd.pending}
            loadingLabel="Drafting..."
            disabled={Boolean(draftDisabledReason)}
            onClick={() => void runDraft()}
          >
            Draft with assistant
          </Button>
          {draftDisabledReason ? <p className="max-w-[44ch] text-xs text-ink-secondary">{draftDisabledReason}</p> : null}
        </div>
      </div>
      <CommandError error={sendCmd.error} />
      {draftCmd.error ? (
        draftCmd.error.code === "ASSISTANT_UNAVAILABLE" ? (
          <AlertBanner tone="warning" title="Drafting assistant unavailable">
            {draftCmd.error.message}
          </AlertBanner>
        ) : (
          <CommandError error={draftCmd.error} />
        )
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ answer

function AnswerForm({ detail, action }: { detail: ClarificationDetail; action: ActionView }) {
  const [text, setText] = useState("");
  // Never pre-filled: who answered is a recorded fact. The directory contact is offered as a one-click suggestion only.
  const [by, setBy] = useState("");
  const suggested = detail.contact.selected && !detail.contact.selected.unverified ? detail.contact.selected : null;
  const [channel, setChannel] = useState("phone_recorded_by_staff");
  const cmd = useCommand<{ displayId: string }, Record<string, unknown>>("clarification.recordAnswer", {
    successToast: (r) => `Answer recorded for ${r.displayId}. It is not resolved until a lead or supervisor reviews it.`,
  });
  useUnsavedChanges(text.trim().length > 0, `${detail.row.displayId} office answer`);
  const submit = () => {
    if (!action.enabled || !text.trim() || !by.trim() || cmd.pending) return;
    void cmd.run({ clarificationId: detail.row.id, answerText: text, answeredBy: by, channel }).then((o) => {
      if (o.ok) setText("");
    });
  };
  return (
    <form
      className="flex flex-col gap-3"
      onKeyDown={onPrimaryShortcut(submit)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Office answer, exactly as given" required hint="Stored verbatim as data. Recording an answer never resolves the clarification.">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={!action.enabled} />
      </Field>
      {/* Stacked: the panel is narrow and channel names are long ("Phone call (recorded by staff)"). */}
      <div className="grid grid-cols-1 gap-3">
        <Field label="Answered by (office role or name)" required hint="Who actually gave the answer, as they said it.">
          <Input value={by} onChange={(e) => setBy(e.target.value)} disabled={!action.enabled} placeholder={suggested ? `e.g. ${suggested.name}` : "e.g. office biopsy coordinator"} />
        </Field>
        {suggested && action.enabled && by.trim() !== suggested.name ? (
          <p className="-mt-2 text-xs text-ink-secondary">
            The question went to {suggested.name} ({suggested.role}).{" "}
            <button type="button" className="font-medium text-brand underline underline-offset-2" onClick={() => setBy(suggested.name)}>
              Use {suggested.name}
            </button>{" "}
            if they answered.
          </p>
        ) : null}
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!action.enabled}>
            {detail.answerChannels.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-col items-start gap-1">
        <Button type="submit" variant={action.primary ? "primary" : "secondary"} loading={cmd.pending} loadingLabel="Recording..." disabled={!action.enabled || !text.trim() || !by.trim()}>
          Record office answer
        </Button>
        <Reason action={action} />
        <CommandError error={cmd.error} />
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ review

function ReviewForm({ detail, action }: { detail: ClarificationDetail; action: ActionView }) {
  const [note, setNote] = useState("");
  const [needNote, setNeedNote] = useState(false);
  const cmd = useCommand<{ displayId: string; state: string }, Record<string, unknown>>("clarification.review", {
    successToast: (r) => (r.state === "reviewed" ? `${r.displayId} answer reviewed. Resolve it next.` : `${r.displayId} sent back: waiting for a further answer.`),
  });
  const accept = () => {
    if (!action.enabled || cmd.pending) return;
    void cmd.run({ clarificationId: detail.row.id, expectedVersion: detail.row.version, note: note.trim() || undefined, outcome: "accepted" });
  };
  return (
    <div className="flex flex-col gap-3" onKeyDown={onPrimaryShortcut(accept)}>
      <Field label="Review note" hint="What you checked. Required when the answer is insufficient.">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={!action.enabled} invalid={needNote && !note.trim()} />
      </Field>
      <div className="flex flex-wrap items-start gap-2">
        <Button
          variant="primary"
          loading={cmd.pending}
          loadingLabel="Saving..."
          disabled={!action.enabled}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={accept}
        >
          Mark answer reviewed
        </Button>
        <Button
          variant="secondary"
          disabled={!action.enabled || cmd.pending}
          onClick={() => {
            if (!note.trim()) {
              setNeedNote(true);
              return;
            }
            void cmd.run({ clarificationId: detail.row.id, expectedVersion: detail.row.version, note: note.trim(), outcome: "insufficient" });
          }}
        >
          Answer is insufficient
        </Button>
      </div>
      {needNote && !note.trim() ? <p className="text-xs font-medium text-danger-fg">Say what is missing from the answer before sending it back.</p> : null}
      <Reason action={action} />
      <CommandError error={cmd.error} />
    </div>
  );
}

// ------------------------------------------------------------------ resolve (with optional, separate hold releases)

function ResolveDialog({ detail, action }: { detail: ClarificationDetail; action: ActionView }) {
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
    <div className="flex flex-col items-start gap-1">
      <Button variant="primary" disabled={!action.enabled} onClick={() => setOpen(true)}>
        Resolve
      </Button>
      <Reason action={action} />
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
        <div className="flex flex-col gap-3" onKeyDown={onPrimaryShortcut(submit)}>
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
            <fieldset className="flex flex-col gap-2 rounded-md border border-hold-border bg-hold-bg px-3 py-2.5">
              <legend className="px-1 text-sm font-semibold text-hold-fg">Holds linked to this clarification</legend>
              <p className="text-xs text-ink-secondary">
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
            <p className="text-xs text-ink-secondary">No active hold is linked to this clarification.</p>
          )}
          <CommandError error={cmd.error} />
        </div>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ cancel

function CancelDialog({ detail, action }: { detail: ClarificationDetail; action: ActionView }) {
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
      <Reason action={action} />
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

// ------------------------------------------------------------------ delivery outcome

function DeliveryForm({ detail, action, primary }: { detail: ClarificationDetail; action: ActionView; primary?: boolean }) {
  const [outcome, setOutcome] = useState("delivered");
  const [note, setNote] = useState("");
  const cmd = useCommand<{ displayId: string; unchanged: boolean }, Record<string, unknown>>("clarification.recordDelivery", {
    successToast: (r) => (r.unchanged ? "No change: that outcome was already recorded." : `Delivery outcome recorded for ${r.displayId}.`),
  });
  return (
    <div className="flex flex-col gap-3">
      {/* Stacked: the side panel is narrow and option labels are long. */}
      <div className="grid grid-cols-1 gap-3">
        <Field label="Delivery outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={!action.enabled}>
            <option value="delivered">Delivered (confirmed)</option>
            <option value="delivery_failed">Delivery failed</option>
            <option value="delivery_unknown">Delivery unknown</option>
          </Select>
        </Field>
        <Field label="How you know">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. office confirmed by phone" disabled={!action.enabled} />
        </Field>
      </div>
      <div className="flex flex-col items-start gap-1">
        <Button
          variant={primary ? "primary" : "secondary"}
          loading={cmd.pending}
          loadingLabel="Recording..."
          disabled={!action.enabled}
          onClick={() => void cmd.run({ clarificationId: detail.row.id, outcome, note: note.trim() || undefined })}
        >
          Record delivery outcome
        </Button>
        <Reason action={action} />
        <CommandError error={cmd.error} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ hold release

export function ReleaseHoldDialog({ hold, clarificationOpen, clarificationLabel, action }: { hold: HoldView; clarificationOpen: boolean; clarificationLabel: string; action?: ActionView }) {
  const actor = useActor();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [touched, setTouched] = useState(false);
  const cmd = useCommand<{ displayId: string; alreadyReleased: boolean }, Record<string, unknown>>("hold.release", {
    successToast: (r) => (r.alreadyReleased ? `${r.displayId} was already released.` : `${r.displayId} released. The release and its reason are in History.`),
    onSuccess: () => setOpen(false),
  });
  const isSupervisor = actor.role === "supervisor";
  const permitted = action ? action.enabled : actor.role === "accessioning_lead" || isSupervisor;
  const blockedReason = !permitted
    ? (action?.reason ?? "Only an accessioning lead or operations supervisor can release a hold.")
    : clarificationOpen && !isSupervisor
      ? `Resolve ${clarificationLabel} first. Only the operations supervisor can release a hold while its clarification is open (override with reason).`
      : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={clarificationOpen ? "secondary" : "primary"} size="sm" disabled={Boolean(blockedReason)} onClick={() => setOpen(true)}>
        Release {hold.displayId}
      </Button>
      {blockedReason ? <p className="max-w-[52ch] text-xs text-ink-secondary">{blockedReason}</p> : null}
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

// ------------------------------------------------------------------ the action area

/** "Not allowed for X. Allowed: A, B." → "A, B" (who can take the step), else the full reason. */
function whoCan(reason: string | null): string | null {
  if (!reason) return null;
  const m = /Allowed:\s*(.+?)\.?$/.exec(reason);
  return m ? m[1] : reason;
}

/**
 * Read-only roles (Director, Medical director): no disabled forms, just what
 * the next step is and who can take it. The simulated office answer stays
 * available as a demo control for any role.
 */
function ReadOnlyActions({ detail, readOnlyNote }: { detail: ClarificationDetail; readOnlyNote: string }) {
  const actions = detail.actions.filter((a) => a.key !== "draft" && a.key !== "releaseHold");
  if (!actions.length) return null;
  const primary = actions.find((a) => a.primary) ?? actions[0];
  const sim = actions.find((a) => a.key === "simulateAnswer" && a.enabled);
  const staffSteps = actions.filter((a) => a.key !== "simulateAnswer" && a.key !== "cancel");
  // Steps that the same roles may take are listed together: "Record office answer, Send reminder: Accessioner, ...".
  const byWho = new Map<string, string[]>();
  for (const a of staffSteps) {
    const who = whoCan(a.reason) ?? "Lab staff";
    byWho.set(who, [...(byWho.get(who) ?? []), a.label]);
  }
  const groups = [...byWho.entries()];
  return (
    <section aria-label="Next step" className="flex flex-col gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2.5">
      <h3 className="text-sm font-semibold text-ink">
        Next step: <span className="font-normal">{primary.label}</span>
      </h3>
      <p className="text-xs text-ink-secondary">{readOnlyNote}</p>
      {groups.length ? (
        <dl className="flex flex-col gap-1 text-xs">
          {groups.map(([who, labels]) => (
            <div key={who}>
              <dt className="inline font-medium text-ink">{labels.join(", ")}:</dt> <dd className="inline text-ink-secondary">{who}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sim ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2">
          <CommandButton
            command="clarification.simulateOfficeAnswer"
            input={{ clarificationId: detail.row.id }}
            variant="ghost"
            size="sm"
            pendingLabel="Simulating..."
            successToast={(r: { message: string }) => r.message}
          >
            Simulate office answer (demo)
          </CommandButton>
          <SimulatedLabel size="xs">Demo control: labeled simulated reply</SimulatedLabel>
        </div>
      ) : null}
    </section>
  );
}

export function ClarificationActions({ detail, readOnlyNote }: { detail: ClarificationDetail; readOnlyNote: string | null }) {
  if (readOnlyNote) return <ReadOnlyActions detail={detail} readOnlyNote={readOnlyNote} />;
  return <StaffActions detail={detail} />;
}

function StaffActions({ detail }: { detail: ClarificationDetail }) {
  const toast = useToast();
  const primaryRef = useRef<HTMLDivElement>(null);
  const id = detail.row.id;
  const actions = detail.actions.filter((a) => a.key !== "draft" && a.key !== "releaseHold");
  if (!actions.length) return null;
  const primary = actions.find((a) => a.primary) ?? actions[0];
  const rest = actions.filter((a) => a !== primary);

  const render = (a: ActionView, isPrimary: boolean): ReactNode => {
    switch (a.key) {
      case "send":
        return <SendForm key={a.key} detail={detail} send={a} draftAction={find(detail, "draft")} />;
      case "recordAnswer":
        return isPrimary ? (
          <AnswerForm key={a.key} detail={detail} action={a} />
        ) : (
          <Expander key={a.key} label="Record office answer (phone or other channel)">
            <AnswerForm detail={detail} action={a} />
          </Expander>
        );
      case "review":
        return <ReviewForm key={a.key} detail={detail} action={a} />;
      case "resolve":
        return <ResolveDialog key={a.key} detail={detail} action={a} />;
      case "recordDelivery":
        return isPrimary ? (
          <DeliveryForm key={a.key} detail={detail} action={a} primary />
        ) : (
          <Expander key={a.key} label="Record delivery outcome (staff confirmation)">
            <DeliveryForm detail={detail} action={a} />
          </Expander>
        );
      case "cancel":
        return <CancelDialog key={a.key} detail={detail} action={a} />;
      case "recordAck":
        return (
          <CommandButton
            key={a.key}
            command="clarification.recordAck"
            input={{ clarificationId: id }}
            variant="secondary"
            size="sm"
            pendingLabel="Recording..."
            disabledReason={a.enabled ? undefined : a.reason}
            successToast="Acknowledgment recorded. Still waiting for the answer."
          >
            Record acknowledgment
          </CommandButton>
        );
      case "followUp":
        return (
          <CommandButton
            key={a.key}
            command="clarification.followUp"
            input={{ clarificationId: id }}
            variant={isPrimary ? "primary" : "secondary"}
            size={isPrimary ? "md" : "sm"}
            pendingLabel="Sending..."
            disabledReason={a.enabled ? undefined : a.reason}
            successToast={(r: { suppressed: boolean; message: string }) => (r.suppressed ? null : r.message)}
            onSuccess={(r: { suppressed: boolean; message: string }) => {
              if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
            }}
          >
            {a.label}
          </CommandButton>
        );
      case "escalate":
        return (
          <CommandButton
            key={a.key}
            command="clarification.escalate"
            input={{ clarificationId: id }}
            variant={isPrimary ? "primary" : "secondary"}
            size={isPrimary ? "md" : "sm"}
            pendingLabel="Escalating..."
            disabledReason={a.enabled ? undefined : a.reason}
            successToast={(r: { message: string; suppressed: boolean }) => (r.suppressed ? null : r.message)}
            onSuccess={(r: { message: string; suppressed: boolean }) => {
              if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
            }}
            confirm={{
              title: `Escalate ${detail.row.displayId}?`,
              body: detail.contact.escalation
                ? `A generic notice goes to ${detail.contact.escalation.name} (${detail.contact.escalation.role}) through the simulated connector, and ${detail.people.escalationOwner ?? "the accessioning lead"} gets a follow-up task. No real office is contacted.`
                : `No escalation contact is on file for ${detail.office.name}. ${detail.people.escalationOwner ?? "The accessioning lead"} gets a follow-up task; phone the office per local policy.`,
              confirmLabel: "Escalate",
              cancelLabel: "Not now",
            }}
          >
            Escalate
          </CommandButton>
        );
      case "simulateAnswer":
        return (
          <div key={a.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <CommandButton
              command="clarification.simulateOfficeAnswer"
              input={{ clarificationId: id }}
              variant="ghost"
              size="sm"
              pendingLabel="Simulating..."
              disabledReason={a.enabled ? undefined : a.reason}
              successToast={(r: { message: string }) => r.message}
            >
              Simulate office answer (demo)
            </CommandButton>
            {a.enabled ? <SimulatedLabel size="xs">Demo control: labeled simulated reply</SimulatedLabel> : null}
          </div>
        );
      default:
        return null;
    }
  };

  // Secondary work actions sit in one row; demo controls and cancel sit apart, below a divider, so they never compete with the next step.
  const inlineRest = rest.filter((a) => ["recordAck", "followUp", "escalate", "resolve"].includes(a.key));
  // The simulated office can only answer a question that was sent: hide the demo control on a draft instead of showing a dead button.
  const otherRest = rest.filter((a) => (a.key === "simulateAnswer" && detail.row.state !== "drafted") || a.key === "cancel");
  const blockRest = rest.filter((a) => !inlineRest.includes(a) && !["simulateAnswer", "cancel"].includes(a.key));
  // Forms (send, answer, review, resolve dialog) handle Ctrl/Cmd+Enter themselves; otherwise the shortcut presses the
  // primary control (opens Resolve, Escalate's confirmation, or sends the reminder).
  const onSectionKeyDown = (e: ReactKeyboardEvent) => {
    if (!isPrimaryShortcut(e) || e.defaultPrevented || !primary.enabled) return;
    // Never reach past an open dialog (cancel, release, escalate confirmation): those own their keys.
    if (e.target instanceof Element && e.target.closest("dialog")) return;
    if (!["resolve", "escalate", "followUp"].includes(primary.key)) return;
    const btn = primaryRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    if (!btn) return;
    e.preventDefault();
    btn.click();
  };
  return (
    <section aria-label="Next step" className="flex flex-col gap-3" onKeyDown={onSectionKeyDown}>
      <h3 className="text-sm font-semibold text-ink">
        Next step: <span className="font-normal">{primary.label}</span>
      </h3>
      <div
        ref={primaryRef}
        className={cn(["send", "recordAnswer", "review", "recordDelivery"].includes(primary.key) ? "rounded-md border border-line bg-surface p-3" : "")}
      >
        {render(primary, true)}
      </div>
      {blockRest.length ? <div className="flex flex-col gap-2">{blockRest.map((a) => render(a, false))}</div> : null}
      {inlineRest.length ? <div className="flex flex-wrap items-start gap-2">{inlineRest.map((a) => render(a, false))}</div> : null}
      {otherRest.length ? (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-t border-line pt-2">{otherRest.map((a) => render(a, false))}</div>
      ) : null}
    </section>
  );
}
