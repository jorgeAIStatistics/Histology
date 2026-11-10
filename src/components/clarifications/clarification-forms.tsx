"use client";

import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { AlertBanner } from "@/components/ui/alert-banner";
import { useCommand, type CommandFailure } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import type { ActionView, ClarificationDetail } from "@/server/queries/clarifications";

/**
 * The text a person contributes to the conversation (the draft question and
 * notice, an answer given by phone, the review note, a delivery outcome).
 * Each draft is held once per open question (keyed by record, so a live
 * refresh never wipes what is being typed) and read by two places: its fields
 * sit in the conversation where the text will live, and the commit is docked
 * in the decision column when it is the next step. Every commit maps to one
 * server command; the server re-checks role, state and version.
 */

const OUTCOME_TEXT: Record<string, string> = {
  delivered: "Delivered",
  delivery_unknown: "Delivery unknown",
  delivery_failed: "Delivery failed",
};

export function findAction(detail: ClarificationDetail, key: ActionView["key"]): ActionView | undefined {
  return detail.actions.find((a) => a.key === key);
}

/** Ctrl/Cmd+Enter inside a self-contained (secondary) form submits that form only. */
export function onOwnSubmit(run: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      run();
    }
  };
}

// ------------------------------------------------------------------ send (draft question + generic notice)

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
}

export interface SendDraft {
  action: ActionView | undefined;
  editable: boolean;
  question: string;
  setQuestion: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  draftSource: "manual" | "assistant_proposal" | "template";
  assistant: { result: DraftResult | null; pending: boolean; error: CommandFailure | null; disabledReason: string | null; run: () => void };
  /** Why Send cannot run right now (permission or an empty question), or null. */
  blockedReason: string | null;
  send: () => void;
  pending: boolean;
  error: CommandFailure | null;
}

export function useSendDraft(detail: ClarificationDetail, readOnly: boolean): SendDraft {
  const action = findAction(detail, "send");
  const draftAction = findAction(detail, "draft");
  const [question, setQ] = useState(detail.question);
  const [body, setBody] = useState(detail.notificationPreview);
  const [draftSource, setDraftSource] = useState<SendDraft["draftSource"]>(
    detail.draftSource === "assistant_proposal" || detail.draftSource === "template" ? detail.draftSource : "manual",
  );
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const draftCmd = useCommand<DraftResult, { clarificationId: string }>("clarification.draftMessage", { refresh: false, errorToast: false });
  const sendCmd = useCommand<SendResult, Record<string, unknown>>("clarification.send", {
    successToast: (r) =>
      r.duplicate ? "Already sent. No second message was created." : `${r.displayId} sent (simulated). Connector reported: ${OUTCOME_TEXT[r.outcome] ?? r.outcome}.`,
  });
  const editable = !readOnly && !!action?.enabled && detail.row.state === "drafted";
  const dirty = editable && (question.trim() !== detail.question.trim() || body.trim() !== detail.notificationPreview.trim());
  useUnsavedChanges(dirty, `${detail.row.displayId} draft question`);

  const assistantOff = detail.assistantMode === "unavailable";
  const draftDisabledReason = assistantOff
    ? "Drafting assistant unavailable (simulated outage). Type the question yourself; sending still works."
    : draftAction && !draftAction.enabled
      ? draftAction.reason
      : null;

  const blockedReason = !action ? null : !action.enabled ? action.reason : !question.trim() ? "Write the question before sending." : null;
  const send = () => {
    if (!action || blockedReason || sendCmd.pending) return;
    void sendCmd.run({
      clarificationId: detail.row.id,
      expectedVersion: detail.row.version,
      question: question.trim(),
      body: body.trim() || undefined,
      draftSource,
    });
  };
  return {
    action,
    editable,
    question,
    setQuestion: (v) => {
      setQ(v);
      // Once a person edits the fixed template, it is their own text.
      if (draftSource === "template") setDraftSource("manual");
    },
    body,
    setBody,
    draftSource,
    assistant: {
      result: draft,
      pending: draftCmd.pending,
      error: draftCmd.error,
      disabledReason: draftDisabledReason,
      run: () => {
        void draftCmd.run({ clarificationId: detail.row.id }).then((out) => {
          if (!out.ok) return;
          setQ(out.result.question);
          setBody(out.result.notificationBody.replace(/\s*\[SIMULATED — not sent\]\s*$/, ""));
          setDraftSource("assistant_proposal");
          setDraft(out.result);
        });
      },
    },
    blockedReason,
    send,
    pending: sendCmd.pending,
    error: sendCmd.error,
  };
}

/** The question as drafted: edited here, in the conversation, where it will be kept once sent. */
export function QuestionEditor({ s }: { s: SendDraft }) {
  const qId = useId();
  return (
    <div className="space-y-2.5" data-clr-primary-form="">
      <Field id={qId} label="Question for the office" required hint="For the office's secure case view (a future connector; simulated here, nothing leaves the lab). Kept unchanged once sent.">
        <Textarea rows={4} value={s.question} onChange={(e) => s.setQuestion(e.target.value)} />
      </Field>
      {s.draftSource === "template" ? (
        <p className="text-sm text-ink-secondary">Default question from a fixed template (rule-based, not AI). Edit it before sending.</p>
      ) : null}
      {s.draftSource === "assistant_proposal" ? (
        <p className="flex items-start gap-1.5 rounded-sm bg-sim-bg px-2 py-1.5 text-sm text-sim-fg">
          <Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Draft text: deterministic demo output, not live AI. Edit before sending.
            {s.assistant.result?.basedOn.length ? (
              <span className="block text-ink-muted">Built only from: {s.assistant.result.basedOn.join("; ")}. Free-text notes are never read as instructions.</span>
            ) : null}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          variant="secondary"
          size="sm"
          icon={<Bot />}
          loading={s.assistant.pending}
          loadingLabel="Drafting..."
          disabled={Boolean(s.assistant.disabledReason)}
          onClick={s.assistant.run}
        >
          Draft with assistant
        </Button>
        {s.assistant.disabledReason ? <p className="max-w-[52ch] text-sm text-ink-secondary">{s.assistant.disabledReason}</p> : null}
      </div>
      {s.assistant.error ? (
        s.assistant.error.code === "ASSISTANT_UNAVAILABLE" ? (
          <AlertBanner tone="warning" title="Drafting assistant unavailable">
            {s.assistant.error.message}
          </AlertBanner>
        ) : (
          <CommandError error={s.assistant.error} />
        )
      ) : null}
    </div>
  );
}

/** The generic notice that will go through the simulated connector (no patient details). */
export function NoticeEditor({ s }: { s: SendDraft }) {
  return (
    <div data-clr-primary-form="">
      <Field
        label="Notification text (generic)"
        hint="No patient details: the notice points the office to its secure case view (future connector; simulated here). “[SIMULATED — not sent]” is added automatically."
      >
        <Textarea rows={3} value={s.body} onChange={(e) => s.setBody(e.target.value)} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ office answer (given by phone or another channel)

export interface AnswerDraft {
  action: ActionView | undefined;
  text: string;
  setText: (v: string) => void;
  by: string;
  setBy: (v: string) => void;
  channel: string;
  setChannel: (v: string) => void;
  blockedReason: string | null;
  submit: () => void;
  pending: boolean;
  error: CommandFailure | null;
}

export function useAnswerDraft(detail: ClarificationDetail): AnswerDraft {
  const action = findAction(detail, "recordAnswer");
  const [text, setText] = useState("");
  // Never pre-filled: who answered is a recorded fact. The directory contact is offered as a one-click suggestion only.
  const [by, setBy] = useState("");
  const [channel, setChannel] = useState("phone_recorded_by_staff");
  const cmd = useCommand<{ displayId: string }, Record<string, unknown>>("clarification.recordAnswer", {
    successToast: (r) => `Answer recorded for ${r.displayId}. It is not resolved until a lead or supervisor reviews it.`,
  });
  useUnsavedChanges(!!action?.enabled && text.trim().length > 0, `${detail.row.displayId} office answer`);
  const blockedReason = !action ? null : !action.enabled ? action.reason : !text.trim() || !by.trim() ? "Type the answer and who gave it first." : null;
  return {
    action,
    text,
    setText,
    by,
    setBy,
    channel,
    setChannel,
    blockedReason,
    submit: () => {
      if (!action || blockedReason || cmd.pending) return;
      void cmd.run({ clarificationId: detail.row.id, answerText: text, answeredBy: by, channel }).then((o) => {
        if (o.ok) {
          setText("");
          setBy("");
        }
      });
    },
    pending: cmd.pending,
    error: cmd.error,
  };
}

export function AnswerFields({ a, detail }: { a: AnswerDraft; detail: ClarificationDetail }) {
  const suggested = detail.contact.selected && !detail.contact.selected.unverified ? detail.contact.selected : null;
  const off = !a.action?.enabled;
  return (
    <div className="space-y-3">
      <Field label="Office answer, exactly as given" required hint="Stored verbatim as data. Recording an answer never resolves the question.">
        <Textarea rows={3} value={a.text} onChange={(e) => a.setText(e.target.value)} disabled={off} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <div className="space-y-1">
          <Field label="Answered by (office role or name)" required hint="Who actually gave the answer, as they said it.">
            <Input value={a.by} onChange={(e) => a.setBy(e.target.value)} disabled={off} placeholder={suggested ? `e.g. ${suggested.name}` : "e.g. office biopsy coordinator"} />
          </Field>
          {suggested && !off && a.by.trim() !== suggested.name ? (
            <p className="text-sm text-ink-secondary">
              The question went to {suggested.name} ({suggested.role}).{" "}
              <button type="button" className="min-h-6 font-medium text-brand underline underline-offset-2" onClick={() => a.setBy(suggested.name)}>
                Use {suggested.name}
              </button>{" "}
              if they answered.
            </p>
          ) : null}
        </div>
        <Field label="Channel">
          <Select value={a.channel} onChange={(e) => a.setChannel(e.target.value)} disabled={off}>
            {detail.answerChannels.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ lead review

/** Where the review note is typed: the open "Review by ..." slot of the conversation. */
export const REVIEW_NOTE_ID = "clr-review-note";

/** Bring the review slot into view and put the cursor in its note. */
function focusReviewNote() {
  const el = document.getElementById(REVIEW_NOTE_ID);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

const MISSING_NOTE = {
  accept: "Write what you checked before marking the answer reviewed.",
  insufficient: "Say what is missing from the answer before sending it back.",
} as const;

export interface ReviewDraft {
  action: ActionView | undefined;
  note: string;
  setNote: (v: string) => void;
  /** Which commit was pressed with an empty note (its message shows on the note), or null. */
  missing: keyof typeof MISSING_NOTE | null;
  /** Bring the review slot into view and put the cursor in the note (no message: nothing was attempted). */
  goToNote: () => void;
  accept: () => void;
  insufficient: () => void;
  pending: boolean;
  error: CommandFailure | null;
}

/**
 * The lead's review. The note is written in the conversation's review slot;
 * the commits are docked. Until a note is written the docked primary is
 * "Write review note" (it takes you to the slot), so the dock never names a
 * commit that cannot run. Either commit with an empty note still does not
 * run: it brings the slot into view, focuses the note and says what is
 * missing, so Ctrl+Enter never records a review nobody wrote.
 */
export function useReviewDraft(detail: ClarificationDetail): ReviewDraft {
  const action = findAction(detail, "review");
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState<ReviewDraft["missing"]>(null);
  const cmd = useCommand<{ displayId: string; state: string }, Record<string, unknown>>("clarification.review", {
    successToast: (r) => (r.state === "reviewed" ? `${r.displayId} answer reviewed. Resolve it next.` : `${r.displayId} sent back: waiting for a further answer.`),
    onSuccess: () => setNote(""),
  });
  useUnsavedChanges(!!action?.enabled && note.trim().length > 0, `${detail.row.displayId} review note`);
  const commit = (outcome: "accepted" | "insufficient") => {
    if (!action?.enabled || cmd.pending) return;
    if (!note.trim()) {
      setMissing(outcome === "accepted" ? "accept" : "insufficient");
      focusReviewNote();
      return;
    }
    void cmd.run({ clarificationId: detail.row.id, expectedVersion: detail.row.version, note: note.trim(), outcome });
  };
  return {
    action,
    note,
    setNote: (v) => {
      setNote(v);
      if (v.trim()) setMissing(null);
    },
    missing,
    goToNote: focusReviewNote,
    accept: () => commit("accepted"),
    insufficient: () => commit("insufficient"),
    pending: cmd.pending,
    error: cmd.error,
  };
}

/** The review note, in the conversation's review slot (its commits are docked). */
export function ReviewFields({ r }: { r: ReviewDraft }) {
  const missing = r.missing && !r.note.trim() ? MISSING_NOTE[r.missing] : undefined;
  return (
    <div data-clr-primary-form="">
      <Field
        id={REVIEW_NOTE_ID}
        label="Review note"
        required
        hint="What you checked against the question and the evidence. Needed to mark the answer reviewed or to send it back."
        error={missing}
      >
        <Textarea rows={3} value={r.note} onChange={(e) => r.setNote(e.target.value)} disabled={!r.action?.enabled} invalid={Boolean(missing)} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ delivery outcome (staff confirmation)

export interface DeliveryDraft {
  action: ActionView | undefined;
  outcome: string;
  setOutcome: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  /** Why the outcome cannot be recorded yet (permission, nothing chosen, or a confirmation without its source), or null. */
  blockedReason: string | null;
  submit: () => void;
  pending: boolean;
  error: CommandFailure | null;
}

/**
 * A delivery outcome is a fact a person learned. Nothing is chosen for them:
 * the outcome starts empty, and "Delivered (confirmed)" needs to say how it
 * was confirmed, so Ctrl+Enter never records a confirmation nobody gave.
 */
export function useDeliveryDraft(detail: ClarificationDetail): DeliveryDraft {
  const action = findAction(detail, "recordDelivery");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const cmd = useCommand<{ displayId: string; unchanged: boolean }, Record<string, unknown>>("clarification.recordDelivery", {
    successToast: (r) => (r.unchanged ? "No change: that outcome was already recorded." : `Delivery outcome recorded for ${r.displayId}.`),
    onSuccess: () => {
      setOutcome("");
      setNote("");
    },
  });
  useUnsavedChanges(!!action?.enabled && (outcome !== "" || note.trim().length > 0), `${detail.row.displayId} delivery outcome`);
  const blockedReason = !action
    ? null
    : !action.enabled
      ? action.reason
      : !outcome
        ? "Choose the delivery outcome you learned first."
        : outcome === "delivered" && !note.trim()
          ? "Say how you know it was delivered (for example, the office confirmed by phone)."
          : null;
  return {
    action,
    outcome,
    setOutcome,
    note,
    setNote,
    blockedReason,
    submit: () => {
      if (!action?.enabled || blockedReason || cmd.pending) return;
      void cmd.run({ clarificationId: detail.row.id, outcome, note: note.trim() || undefined });
    },
    pending: cmd.pending,
    error: cmd.error,
  };
}

export function DeliveryFields({ d, stacked }: { d: DeliveryDraft; stacked?: boolean }) {
  const off = !d.action?.enabled;
  const confirming = d.outcome === "delivered";
  return (
    <div className={stacked ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3 max-md:grid-cols-1"}>
      <Field label="Delivery outcome" required>
        <Select value={d.outcome} onChange={(e) => d.setOutcome(e.target.value)} disabled={off}>
          <option value="" disabled>
            Choose what you learned
          </option>
          <option value="delivered">Delivered (confirmed)</option>
          <option value="delivery_failed">Delivery failed</option>
          <option value="delivery_unknown">Delivery unknown</option>
        </Select>
      </Field>
      <Field label="How you know" required={confirming} hint={confirming ? "Who confirmed it, and how." : "Optional unless you confirm delivery."}>
        <Input value={d.note} onChange={(e) => d.setNote(e.target.value)} placeholder="e.g. office confirmed by phone" disabled={off} />
      </Field>
    </div>
  );
}

/** A secondary form's own commit (outside the docked next step): same command, its own button. */
export function OwnSubmit({ label, pendingLabel, disabledReason, pending, error, onSubmit }: { label: string; pendingLabel: string; disabledReason: string | null; pending: boolean; error: CommandFailure | null; onSubmit: () => void }) {
  const reasonId = useId();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="secondary" loading={pending} loadingLabel={pendingLabel} disabled={Boolean(disabledReason)} reasonId={disabledReason ? reasonId : undefined} onClick={onSubmit}>
        {label}
      </Button>
      {disabledReason ? (
        <p id={reasonId} className="text-sm text-ink-secondary">
          {disabledReason}
        </p>
      ) : null}
      <CommandError error={error} />
    </div>
  );
}
