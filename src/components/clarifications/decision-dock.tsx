"use client";

import { useId, type ReactNode } from "react";
import { Eye, Hourglass, PencilLine, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { useToast } from "@/components/ui/toast";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { IdText } from "@/components/domain/id-text";
import type { ActionView, ClarificationDetail, HoldView } from "@/server/queries/clarifications";
import { CancelDialog, ReleaseHoldDialog, ResolveDialog } from "./clarification-actions";
import type { Forms } from "./conversation";
import { DeliveryFields } from "./clarification-forms";
import { stepCopy, waitingOn } from "./ladder";

/**
 * Decision column: the one next step (its heading names the action, its
 * commit is docked here with the Ctrl+Enter badge, or disabled with the
 * reason in words), who else is being waited on, the other things that can
 * be done now, and cancel at the foot. The step and its commit come first and
 * stay pinned at the top of the column while the rest of it scrolls, so the
 * next action is always in view (nothing is ever clipped).
 */

/** The docked commit of the primary action: a full-width block button, the Ctrl+Enter target. */
function Commit({
  label,
  icon,
  enabled,
  blockedReason,
  pending,
  pendingLabel,
  onRun,
  reasonId,
}: {
  label: string;
  icon?: ReactNode;
  enabled: boolean;
  blockedReason: string | null;
  pending: boolean;
  pendingLabel: string;
  onRun: () => void;
  reasonId: string;
}) {
  return (
    <Button
      variant="primary"
      size="block"
      icon={icon}
      loading={pending}
      loadingLabel={pendingLabel}
      disabled={!enabled}
      reasonId={blockedReason ? reasonId : undefined}
      aria-keyshortcuts="Control+Enter Meta+Enter"
      data-clr-primary=""
      onClick={onRun}
    >
      {label}
      {enabled ? <CtrlEnterBadge onDark /> : null}
    </Button>
  );
}

function Reason({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} className="text-sm text-ink-secondary">
      <IdText text={text} />
    </p>
  );
}

/** The docked step for staff: commit for the primary action, with its reason when it cannot run. */
function StaffCommit({ a, detail, forms, hold }: { a: ActionView; detail: ClarificationDetail; forms: Forms; hold: HoldView | null }) {
  const toast = useToast();
  const reasonId = useId();
  const id = detail.row.id;
  switch (a.key) {
    case "send": {
      const s = forms.send;
      return (
        <div className="space-y-1.5">
          <Commit label="Send (simulated)" icon={<Send />} enabled={!s.blockedReason} blockedReason={s.blockedReason} pending={s.pending} pendingLabel="Sending..." onRun={s.send} reasonId={reasonId} />
          <Reason id={reasonId} text={s.blockedReason} />
          <CommandError error={s.error} />
        </div>
      );
    }
    case "recordAnswer": {
      const f = forms.answer;
      return (
        <div className="space-y-1.5">
          <Commit label="Record office answer" enabled={!f.blockedReason} blockedReason={f.blockedReason} pending={f.pending} pendingLabel="Recording..." onRun={f.submit} reasonId={reasonId} />
          <Reason id={reasonId} text={f.blockedReason} />
          <CommandError error={f.error} />
        </div>
      );
    }
    case "recordDelivery": {
      // Nothing is pre-chosen: the commit waits for an outcome (and, to confirm delivery, how it was confirmed).
      const f = forms.delivery;
      const reason = a.enabled ? f.blockedReason : a.reason;
      return (
        <div className="space-y-1.5">
          {a.enabled ? (
            <div className="pb-1.5">
              <DeliveryFields d={f} stacked />
            </div>
          ) : null}
          <Commit label="Record delivery outcome" enabled={a.enabled && !f.blockedReason} blockedReason={reason} pending={f.pending} pendingLabel="Recording..." onRun={f.submit} reasonId={reasonId} />
          <Reason id={reasonId} text={reason} />
          <CommandError error={f.error} />
        </div>
      );
    }
    case "review": {
      // The note is written in the conversation's review slot. Until it has text, the docked primary takes you
      // there ("Write review note"); only a written note turns it into the commit "Mark answer reviewed".
      const f = forms.review;
      const reason = a.enabled ? null : a.reason;
      const written = f.note.trim().length > 0;
      return (
        <div className="space-y-2">
          {a.enabled && !written ? (
            <Button variant="primary" size="block" icon={<PencilLine />} aria-keyshortcuts="Control+Enter Meta+Enter" data-clr-primary="" onClick={f.goToNote}>
              Write review note
              <CtrlEnterBadge onDark />
            </Button>
          ) : (
            <Commit label="Mark answer reviewed" enabled={a.enabled} blockedReason={reason} pending={f.pending} pendingLabel="Saving..." onRun={f.accept} reasonId={reasonId} />
          )}
          <Reason id={reasonId} text={reason} />
          {a.enabled ? (
            <>
              <Button variant="secondary" size="block" disabled={f.pending} onClick={f.insufficient}>
                Answer is insufficient
              </Button>
              <p className="text-sm text-ink-secondary">
                {written ? "Your note sits under the office answer in the conversation." : "The note goes in the conversation, under the office answer. Marking the answer reviewed needs it."}
              </p>
            </>
          ) : null}
          <CommandError error={f.error} />
        </div>
      );
    }
    case "resolve":
      return (
        <div className="space-y-1.5">
          <ResolveDialog detail={detail} action={a} docked reasonId={reasonId} />
          <Reason id={reasonId} text={a.enabled ? null : a.reason} />
        </div>
      );
    case "releaseHold":
      return hold ? <ReleaseHoldDialog hold={hold} clarificationOpen={detail.row.isOpen} clarificationLabel={detail.row.displayId} action={a} docked /> : null;
    case "followUp":
      return (
        <span data-clr-primary="" className="contents">
          <CommandButton
            command="clarification.followUp"
            input={{ clarificationId: id }}
            variant="primary"
            size="block"
            wrapperClassName="w-full"
            pendingLabel="Sending..."
            disabledReason={a.enabled ? undefined : a.reason}
            successToast={(r: { suppressed: boolean; message: string }) => (r.suppressed ? null : r.message)}
            onSuccess={(r: { suppressed: boolean; message: string }) => {
              if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
            }}
          >
            {a.label}
            {a.enabled ? <CtrlEnterBadge onDark /> : null}
          </CommandButton>
        </span>
      );
    case "escalate":
      return (
        <span data-clr-primary="" className="contents">
          <CommandButton
            command="clarification.escalate"
            input={{ clarificationId: id }}
            variant="primary"
            size="block"
            wrapperClassName="w-full"
            pendingLabel="Escalating..."
            disabledReason={a.enabled ? undefined : a.reason}
            successToast={(r: { message: string; suppressed: boolean }) => (r.suppressed ? null : r.message)}
            onSuccess={(r: { message: string; suppressed: boolean }) => {
              if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
            }}
            confirm={escalateConfirm(detail)}
          >
            Escalate
            {a.enabled ? <CtrlEnterBadge onDark /> : null}
          </CommandButton>
        </span>
      );
    default:
      return null;
  }
}

function escalateConfirm(detail: ClarificationDetail) {
  return {
    title: `Escalate ${detail.row.displayId}?`,
    body: detail.contact.escalation
      ? `A generic notice goes to ${detail.contact.escalation.name} (${detail.contact.escalation.role}) through the simulated connector, and ${detail.people.escalationOwner ?? "the accessioning lead"} gets a follow-up task. No real office is contacted.`
      : `No escalation contact is on file for ${detail.office.name}. ${detail.people.escalationOwner ?? "The accessioning lead"} gets a follow-up task; phone the office per local policy.`,
    confirmLabel: "Escalate",
    cancelLabel: "Not now",
  };
}

/** Opens a secondary form that lives in the conversation and puts the cursor in it. */
function openForm(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLDetailsElement)) return;
  el.open = true;
  el.scrollIntoView({ block: "nearest" });
  window.setTimeout(() => el.querySelector<HTMLElement>("textarea, input, select")?.focus(), 0);
}

/** One-click secondary actions and links to the secondary forms in the conversation. */
function AlsoPossible({ detail, rest, readOnly }: { detail: ClarificationDetail; rest: ActionView[]; readOnly: boolean }) {
  const toast = useToast();
  const id = detail.row.id;
  if (readOnly) return null;
  const items = rest.filter((a) => ["followUp", "escalate", "recordAck", "recordAnswer", "recordDelivery"].includes(a.key));
  if (!items.length) return null;
  return (
    <section aria-labelledby="clr-also-title" className="shrink-0 border-t border-line px-4 pt-3 pb-3 max-xl:px-3">
      <h3 id="clr-also-title" className="text-sm font-semibold text-ink">
        Also possible
      </h3>
      <ul className="mt-2 space-y-2">
        {items.map((a) => (
          <li key={a.key}>
            {a.key === "followUp" ? (
              <CommandButton
                command="clarification.followUp"
                input={{ clarificationId: id }}
                size="sm"
                pendingLabel="Sending..."
                disabledReason={a.enabled ? undefined : a.reason}
                successToast={(r: { suppressed: boolean; message: string }) => (r.suppressed ? null : r.message)}
                onSuccess={(r: { suppressed: boolean; message: string }) => {
                  if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
                }}
              >
                {a.label}
              </CommandButton>
            ) : a.key === "escalate" ? (
              <CommandButton
                command="clarification.escalate"
                input={{ clarificationId: id }}
                size="sm"
                pendingLabel="Escalating..."
                disabledReason={a.enabled ? undefined : a.reason}
                successToast={(r: { message: string; suppressed: boolean }) => (r.suppressed ? null : r.message)}
                onSuccess={(r: { message: string; suppressed: boolean }) => {
                  if (r.suppressed) toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
                }}
                confirm={escalateConfirm(detail)}
              >
                Escalate
              </CommandButton>
            ) : a.key === "recordAck" ? (
              <CommandButton
                command="clarification.recordAck"
                input={{ clarificationId: id }}
                size="sm"
                pendingLabel="Recording..."
                disabledReason={a.enabled ? undefined : a.reason}
                successToast="Acknowledgment recorded. Still waiting for the answer."
              >
                Record acknowledgment
              </CommandButton>
            ) : a.enabled ? (
              <Button size="sm" variant="secondary" onClick={() => openForm(a.key === "recordAnswer" ? "clr-answer-form" : "clr-delivery-form")}>
                {a.key === "recordAnswer" ? "Record an answer given by phone" : "Record a delivery outcome"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Read-only roles: what the next step is and who can take it; no disabled forms. */
function ReadOnlyStep({ detail, primary, readOnlyNote }: { detail: ClarificationDetail; primary: ActionView | null; readOnlyNote: string }) {
  const steps = detail.actions.filter((a) => !["draft", "simulateAnswer", "cancel"].includes(a.key));
  const byWho = new Map<string, string[]>();
  for (const a of steps) {
    const m = a.reason ? /Allowed:\s*(.+?)\.?$/.exec(a.reason) : null;
    const who = m ? m[1] : "Lab staff";
    byWho.set(who, [...(byWho.get(who) ?? []), a.label]);
  }
  return (
    <div className="space-y-2.5 px-4 pb-3.5 max-xl:px-3">
      <p className="text-sm text-ink-secondary">{readOnlyNote}</p>
      {primary && byWho.size ? (
        <dl className="space-y-1.5 text-sm">
          {[...byWho.entries()].map(([who, labels]) => (
            <div key={who}>
              <dt className="font-medium text-ink">{labels.join(", ")}</dt>
              <dd className="text-ink-secondary">{who}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function DecisionDock({
  detail,
  forms,
  primary,
  readOnlyNote,
  now,
}: {
  detail: ClarificationDetail;
  forms: Forms;
  primary: ActionView | null;
  readOnlyNote: string | null;
  now: string;
}) {
  const readOnly = !!readOnlyNote;
  const activeHolds = detail.holds.filter((h) => h.status === "active");
  const hold = primary?.key === "releaseHold" ? (activeHolds[0] ?? null) : null;
  const copy = primary ? stepCopy(primary, detail, hold, now) : null;
  const rest = detail.actions.filter((a) => a !== primary && a.key !== "draft" && a.key !== "releaseHold" && a.key !== "simulateAnswer");
  const cancel = rest.find((a) => a.key === "cancel");
  const waiting = waitingOn(detail, now);
  const closedNote =
    detail.row.state === "resolved"
      ? `Resolved by ${detail.resolution?.byName ?? "Unknown"}. ${detail.holds.length ? "Every linked hold is released." : "No hold is linked."}`
      : detail.row.state === "canceled"
        ? `Canceled. ${detail.holds.length ? "Every linked hold is released." : "No hold is linked."}`
        : "";

  return (
    <aside
      aria-label="Decision"
      className="relative flex min-h-0 min-w-0 flex-col border-l border-line bg-surface-subtle max-lg:order-first max-lg:border-b max-lg:border-l-0 lg:overflow-y-auto"
    >
      {/* Pinned at the top of the column: scrolling Waiting on or Also possible never hides the next step. */}
      <div className="z-[2] shrink-0 bg-surface-subtle px-3 pt-3 pb-1 max-xl:px-2 max-xl:pt-2 max-lg:pb-2 lg:sticky lg:top-0">
        <section
          aria-labelledby="clr-step-title"
          key={primary?.key ?? "idle"}
          className="animate-swap-in flex min-h-0 flex-col rounded-lg border border-line bg-surface shadow-1"
        >
          <h3 id="clr-step-title" className="flex items-start gap-2 px-4 pt-3.5 pb-1.5 text-md leading-6 font-bold tracking-[-0.01em] text-balance text-ink max-xl:px-3">
            {readOnly ? <Eye className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden /> : null}
            <span>{copy ? <IdText text={copy.title} /> : "Nothing left to do"}</span>
          </h3>
          {readOnly ? (
            <ReadOnlyStep detail={detail} primary={primary} readOnlyNote={readOnlyNote} />
          ) : (
            <>
              <p className="px-4 pb-3 text-sm text-ink-secondary max-xl:px-3">
                <IdText text={copy ? copy.detail : closedNote} />
              </p>
              {primary?.key === "send" && detail.contact.coverageNoteNow ? <p className="px-4 pb-3 text-sm text-ink-secondary max-xl:px-3">{detail.contact.coverageNoteNow}</p> : null}
              {primary ? (
                <div className="border-t border-line px-4 pt-3 pb-3.5 max-xl:px-3">
                  <StaffCommit a={primary} detail={detail} forms={forms} hold={hold} />
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="clr-waiting-title" className="shrink-0 px-4 pt-3 pb-3 max-xl:px-3">
        <h3 id="clr-waiting-title" className="text-sm font-semibold text-ink">
          Waiting on
        </h3>
        {waiting.length ? (
          <ul className="mt-1 space-y-1.5">
            {waiting.map((w) => (
              <li key={`${w.who}-${w.what}`} className="flex items-start gap-2 text-sm">
                <Hourglass className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
                <span>
                  <span className="font-semibold text-ink">{w.who}</span>{" "}
                  <span className="text-ink-secondary">
                    <IdText text={w.what} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Nobody: this question is closed.</p>
        )}
      </section>

      <AlsoPossible detail={detail} rest={rest} readOnly={readOnly} />
      {!readOnly && cancel ? (
        <div className={cn("shrink-0 border-t border-line px-4 py-2 max-xl:px-3", "mt-auto")}>
          <CancelDialog detail={detail} action={cancel} />
        </div>
      ) : null}
    </aside>
  );
}
