"use client";

import Link from "next/link";
import { ChevronDown, CirclePause, Hourglass, ListOrdered, Minus, PencilLine, Plug, TriangleAlert, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { AlertBanner } from "@/components/ui/alert-banner";
import { CommandButton } from "@/components/ui/command-button";
import { PresenterControls } from "@/components/ui/presenter-controls";
import { Timeline, sourceFromOrigin, type TimelineEvent } from "@/components/ui/timeline";
import { HoldBanner } from "@/components/domain/hold";
import { SyntheticTag } from "@/components/domain/honesty";
import { IdText } from "@/components/domain/id-text";
import { LabelRef, SpecimenLabel } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import type { ActionView, ClarificationDetail, ContactView } from "@/server/queries/clarifications";
import { ReleaseHoldDialog } from "./clarification-actions";
import { useAnswerDraft, useDeliveryDraft, useReviewDraft, useSendDraft } from "./clarification-forms";
import { Conversation, type Forms } from "./conversation";
import { DecisionDock } from "./decision-dock";
import { holdScopeWords, materialWords, statusSentence, type Rung } from "./ladder";

const PRIORITY_WORD: Record<string, string> = { urgent: "Urgent", high: "High priority", routine: "Routine" };

/** The affected material set as its label: dashed provisional INT id, solid accession with its DataMatrix. */
function MaterialLabel({ detail }: { detail: ClarificationDetail }) {
  const m = detail.row.material;
  const words = materialWords(m);
  const parts = m.part ? [m.part] : [];
  if (m.kind === "accession") {
    return (
      <SpecimenLabel
        size="md"
        status="official"
        id={m.labelId}
        parts={parts}
        payload={m.namespace ? encodeLabel({ kind: "C", namespace: namespaceCode(m.namespace), accession: m.labelId }) : undefined}
        lines={[m.scope === "all_parts" ? "All parts of the case" : (m.namespace ?? "Official number"), detail.subject.orderRef ? <>Order <span className="id-mono">{detail.subject.orderRef}</span></> : null].filter(Boolean)}
      />
    );
  }
  if (m.kind === "provisional") {
    return (
      <SpecimenLabel
        size="md"
        status="provisional"
        id={m.labelId}
        parts={parts}
        lines={[
          m.orderRef ? (
            <>
              Order <span className="id-mono">{m.orderRef}</span>
              {m.scope === "all_containers" ? ", all containers" : ""}
            </>
          ) : (
            (words ?? "No source order linked")
          ),
          "Official number: not issued",
        ]}
      />
    );
  }
  return (
    <span className="flex items-center gap-2">
      <LabelRef id={m.labelId} />
      {words ? <span className="text-base font-semibold text-ink">{words}</span> : null}
    </span>
  );
}

const RUNG_ICON: Record<Rung, typeof Check> = { warning: TriangleAlert, waiting: Hourglass, draft: PencilLine, done: Check, muted: Minus };

/**
 * Identity band (the material in hand and the question about it) and the
 * status band (one sentence on the ladder, the hold with its scope). Both
 * stay pinned above the conversation and the decision column.
 */
function Bands({ detail, now, queueCount, queueOpen, onToggleQueue }: { detail: ClarificationDetail; now: string; queueCount: number; queueOpen: boolean; onToggleQueue: () => void }) {
  const r = detail.row;
  const s = detail.subject;
  const status = statusSentence(detail, now);
  const Icon = RUNG_ICON[status.rung];
  const held = detail.holds.filter((h) => h.status === "active");
  const openHref = s.accessionNumber ? `/cases/${encodeURIComponent(s.accessionNumber)}` : s.intakeDisplayId ? `/intake?item=${encodeURIComponent(s.intakeDisplayId)}` : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-5 py-2.5 max-xl:gap-x-4 max-xl:px-4">
        <button
          type="button"
          onClick={onToggleQueue}
          aria-expanded={queueOpen}
          aria-controls="clr-queue"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-subtle xl:hidden"
        >
          <ListOrdered className="size-4" aria-hidden />
          Queue <span className="num-tabular font-normal text-ink-muted">({queueCount})</span>
        </button>
        <MaterialLabel detail={detail} />
        <div className="min-w-0 flex-1 leading-5">
          <h2
            id="clr-record-heading"
            tabIndex={-1}
            aria-label={`${r.categoryLabel} question: ${r.affectedLabel}`}
            className="rounded-sm text-lg leading-7 font-bold tracking-[-0.015em] text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {r.categoryLabel} question
          </h2>
          {/* The state is told once, in words on the ladder, by the status band below. */}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-ink-secondary">
            <span className="id-mono font-semibold text-ink">{r.displayId}</span>
            <span>{PRIORITY_WORD[r.priority] ?? r.priority}</span>
          </p>
          {s.patient ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-secondary">
              <span className="font-semibold text-ink">{s.patient.name}</span>
              <SyntheticTag />
              <span>
                MRN <span className="id-mono text-ink">{s.patient.mrn}</span>, {s.patient.tenant}
              </span>
            </p>
          ) : null}
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 text-sm leading-5 max-lg:basis-full">
          <dt className="text-ink-muted">Office</dt>
          <dd className="min-w-0 text-ink">{detail.office.name}</dd>
          <dt className="text-ink-muted">Owner</dt>
          <dd className="min-w-0 text-ink">{detail.people.labOwner}</dd>
          {openHref ? (
            <>
              <dt className="sr-only">Record</dt>
              <dd className="col-start-2">
                <Link href={openHref} className="inline-flex min-h-6 items-center font-medium text-brand underline-offset-2 hover:underline">
                  {s.accessionNumber ? (
                    <>
                      Open case <span className="id-mono ml-1">{s.accessionNumber}</span>
                    </>
                  ) : (
                    <>
                      Open <span className="id-mono mx-1">{s.intakeDisplayId}</span> in Intake
                    </>
                  )}
                </Link>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5 border-b border-line bg-surface px-5 py-2.5 max-xl:px-4">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-base leading-6">
          <Icon
            className={cn(
              "mt-1 size-4 shrink-0",
              status.rung === "warning" ? "text-warning-solid" : status.rung === "done" || status.rung === "muted" ? "text-ink-muted" : "text-ink-secondary",
            )}
            aria-hidden
          />
          <span className="min-w-0">
            <span className={cn("font-semibold", status.rung === "warning" ? "text-warning-fg" : "text-ink")}>
              <IdText text={status.lead} />
            </span>{" "}
            {status.rest ? (
              <span className="text-ink-secondary">
                <IdText text={status.rest} />
              </span>
            ) : null}
          </span>
        </p>
        {held.map((h) => (
          <a
            key={h.id}
            href={`#hold-${h.id}`}
            className="hatch inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-sm border border-hold-border px-2 text-sm font-medium text-hold-fg underline-offset-2 hover:underline"
          >
            <CirclePause className="size-3.5 shrink-0 text-hold-solid" aria-hidden />
            <span className="id-mono">{h.displayId}</span> holds {holdScopeWords(h.scopeShort)} only
          </a>
        ))}
      </div>
    </>
  );
}

function ContactLine({ label, c, now, emptyText = "None on file" }: { label: string; c: ContactView | null; now: string; emptyText?: string }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 py-1 max-md:grid-cols-1">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="min-w-0">
        {c ? (
          <>
            <span className="text-ink">{c.name}</span>
            <span className="text-ink-secondary">, {c.role}</span>
            <span className="block text-ink-muted">{c.channelLabel}</span>
            {c.isOutNow && c.outUntil ? (
              <span className="mt-0.5 flex items-center gap-1 font-medium text-warning-fg">
                <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
                Out until <Timestamp iso={c.outUntil} now={now} />
              </span>
            ) : null}
            {c.unverified ? (
              <span className="mt-0.5 flex items-center gap-1 font-medium text-warning-fg">
                <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
                Unverified contact (new office)
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-ink-muted">{emptyText}</span>
        )}
      </dd>
    </div>
  );
}

/** Office contact and coverage, then History: one sheet, separated by a hairline. */
function OfficeAndHistory({ detail, now }: { detail: ClarificationDetail; now: string }) {
  const r = detail.row;
  const events: TimelineEvent[] = detail.history.map((h) => ({
    id: String(h.seq),
    at: h.at,
    actorName: h.actorName,
    actorRole: h.actorRoleLabel,
    summary: h.summary,
    source: h.origin === "simulator" && h.actorName === "Simulated office" ? "office" : sourceFromOrigin(h.origin),
    reason: h.reason,
  }));
  return (
    <div className="rounded-lg border border-line bg-surface">
      <section aria-labelledby="clr-office-title" className="px-5 py-4 max-lg:px-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="clr-office-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
            Office contact and coverage
          </h3>
        </div>
        <dl className="text-sm">
          <ContactLine
            label={r.state === "drafted" ? "Will go to" : "Sent to"}
            c={detail.contact.selected}
            now={now}
            emptyText={r.state === "drafted" ? "No named contact chosen yet" : "No named contact recorded (sent to the office)"}
          />
          {r.isOpen && r.state !== "drafted" && detail.contact.currentRecipient && detail.contact.currentRecipient.name !== detail.contact.selected?.name ? (
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 py-1 max-md:grid-cols-1">
              <dt className="text-ink-secondary">Next message</dt>
              <dd className="min-w-0 font-medium text-ink">
                {detail.contact.currentRecipient.name}
                <span className="font-normal text-ink-secondary">
                  , {detail.contact.currentRecipient.role}
                  {detail.contact.backup && detail.contact.backup.name === detail.contact.currentRecipient.name ? " (backup)" : ""}
                </span>
              </dd>
            </div>
          ) : null}
          <ContactLine label="Primary" c={detail.contact.primary} now={now} />
          <ContactLine label="Backup" c={detail.contact.backup} now={now} />
          <ContactLine label="Escalation" c={detail.contact.escalation} now={now} />
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 py-1 max-md:grid-cols-1">
            <dt className="text-ink-secondary">Office hours</dt>
            <dd className="text-ink">{detail.office.workingHoursText} (ET)</dd>
          </div>
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 py-1 max-md:grid-cols-1">
            <dt className="text-ink-secondary">Lab escalation</dt>
            <dd className="text-ink">{detail.people.escalationOwner ?? "None assigned"}</dd>
          </div>
        </dl>
        {detail.contact.routedToBackup ? <p className="mt-1 text-sm text-ink-secondary">Routed to the backup contact because the primary contact was out.</p> : null}
        {detail.contact.coverageNoteNow ? <p className="mt-1 text-sm text-ink-secondary">Now: {detail.contact.coverageNoteNow}</p> : null}
        <p className="mt-2 max-w-[72ch] text-sm text-ink-muted">
          {detail.priorityRule} Fictional directory, read-only here. Faster answers need an agreement with each office about ownership and escalation; more notifications alone add noise.
        </p>
      </section>
      <details className="group/h border-t border-line">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-5 text-md font-semibold tracking-[-0.01em] text-ink hover:bg-surface-subtle max-lg:px-4 [&::-webkit-details-marker]:hidden">
          History
          <span className="num-tabular text-sm font-normal text-ink-muted">({detail.history.length} recorded events)</span>
          <ChevronDown className="ml-auto size-4 text-ink-muted transition-transform duration-[var(--hlo-duration-fast)] group-open/h:rotate-180" aria-hidden />
        </summary>
        <section aria-label="History" className="px-5 pb-4 max-lg:px-4">
          <Timeline title="History" events={events} now={now} emptyText="No local events recorded yet." />
          {detail.stepsWithoutAudit.length ? (
            <p className="mt-2 rounded-sm bg-surface-subtle px-2 py-1.5 text-sm text-ink-secondary">
              Seeded with the demo scenario before the demo clock started: {detail.stepsWithoutAudit.join(", ")} {detail.stepsWithoutAudit.length === 1 ? "appears" : "appear"} in the conversation only.
              History lists the events recorded in this demo.
            </p>
          ) : null}
        </section>
      </details>
    </div>
  );
}

/** Holds placed with this question: scope named, what continues, how it is released. */
function Holds({ detail, now, dockedHoldId }: { detail: ClarificationDetail; now: string; dockedHoldId: string | null }) {
  const r = detail.row;
  const release = detail.actions.find((a) => a.key === "releaseHold");
  const active = detail.holds.filter((h) => h.status === "active");
  const released = detail.holds.filter((h) => h.status === "released");
  if (!detail.holds.length) {
    return <p className="px-1 text-sm text-ink-secondary">No hold is linked to this question. Other work on this material is not blocked by it.</p>;
  }
  return (
    <div className="space-y-2">
      {active.map((h) => (
        <div key={h.id} id={`hold-${h.id}`} className="scroll-mt-4">
          <HoldBanner
            scope={h.scopeShort}
            reason={h.reasonText}
            otherScopeNote={h.siblingNote || undefined}
            evidence={
              <span className="text-ink-secondary">
                Holds: {h.blockLabels.join(", ")}. Placed <Timestamp iso={h.placedAt} now={now} /> by {h.placedByName}.
              </span>
            }
            clarification={{ displayId: r.displayId }}
            owner={r.isOpen ? detail.people.labOwner : `${detail.people.escalationOwner ?? "Accessioning lead"} (release decision)`}
            nextFollowUpAt={r.isOpen ? r.nextFollowUpAt : null}
            now={now}
          >
            <p className="mt-1 text-sm text-ink-secondary">
              <span className="id-mono">{h.displayId}</span>. Not released by sending, an answer, or resolution alone: a lead or supervisor releases it with a reason.
            </p>
            {dockedHoldId === h.id ? (
              <p className="mt-1 text-sm font-medium text-ink">Releasing it is this question&rsquo;s next step, in the decision column.</p>
            ) : (
              <div className="mt-2">
                <ReleaseHoldDialog hold={h} clarificationOpen={r.isOpen} clarificationLabel={r.displayId} action={release} />
              </div>
            )}
          </HoldBanner>
        </div>
      ))}
      {released.map((h) => (
        <p key={h.id} className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-secondary">
          <span className="id-mono text-ink">{h.displayId}</span> on {h.scopeLabel} released <Timestamp iso={h.releasedAt} now={now} /> by {h.releasedByName ?? "Unknown"}.
          {h.releaseReason ? ` Reason: ${h.releaseReason}` : ""}
        </p>
      ))}
    </div>
  );
}

/** Demo controls the presenter uses (the simulated office), in the shared presenter disclosure; a real bench does not have them. */
function OfficeSimulator({ detail }: { detail: ClarificationDetail }) {
  const sim = detail.actions.find((a) => a.key === "simulateAnswer");
  // The simulated office can only answer a question that was sent.
  if (!sim || detail.row.state === "drafted") return null;
  return (
    <PresenterControls>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CommandButton
            command="clarification.simulateOfficeAnswer"
          input={{ clarificationId: detail.row.id }}
          variant="secondary"
          size="sm"
          pendingLabel="Simulating..."
          disabledReason={sim.enabled ? undefined : sim.reason}
          successToast={(r: { message: string }) => r.message}
        >
          Simulate office answer (demo)
        </CommandButton>
        {sim.enabled ? (
          <span className="inline-flex items-center gap-1 text-sm text-ink-muted">
            <Plug className="size-3.5 shrink-0" aria-hidden />
            The reply is labeled simulated
          </span>
        ) : null}
      </div>
    </PresenterControls>
  );
}

/** The primary (next) action: the server lists the next valid action first and marks it primary. */
export function primaryAction(detail: ClarificationDetail): ActionView | null {
  const candidates = detail.actions.filter((a) => !["draft", "simulateAnswer", "cancel"].includes(a.key));
  return candidates.find((a) => a.primary) ?? candidates[0] ?? null;
}

/**
 * One open question: the bands, then the conversation (with its hold, office
 * coverage and history) beside the decision column. Its drafts live here,
 * once per question, read by both the conversation and the docked commit.
 */
export function ClarificationRecord({
  detail,
  now,
  readOnlyNote,
  busy,
  queueCount,
  queueOpen,
  onToggleQueue,
}: {
  detail: ClarificationDetail;
  now: string;
  readOnlyNote: string | null;
  busy: boolean;
  queueCount: number;
  queueOpen: boolean;
  onToggleQueue: () => void;
}) {
  const readOnly = !!readOnlyNote;
  const forms: Forms = {
    send: useSendDraft(detail, readOnly),
    answer: useAnswerDraft(detail),
    review: useReviewDraft(detail),
    delivery: useDeliveryDraft(detail),
  };
  const primary = primaryAction(detail);
  const dockedHoldId = primary?.key === "releaseHold" && !readOnly ? (detail.holds.find((h) => h.status === "active")?.id ?? null) : null;
  return (
    <section aria-labelledby="clr-record-heading" aria-busy={busy || undefined} className="animate-swap-in flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-[var(--hlo-duration-base)]", busy && "opacity-55 delay-150")}>
        <Bands detail={detail} now={now} queueCount={queueCount} queueOpen={queueOpen} onToggleQueue={onToggleQueue} />
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_336px] min-[1400px]:grid-cols-[minmax(0,1fr)_352px]">
          <div className="min-h-0 min-w-0 space-y-4 p-4 lg:overflow-y-auto max-xl:p-3">
            <Conversation detail={detail} now={now} forms={forms} primaryKey={readOnly ? null : (primary?.key ?? null)} readOnly={readOnly} />
            <Holds detail={detail} now={now} dockedHoldId={dockedHoldId} />
            <OfficeAndHistory detail={detail} now={now} />
            <OfficeSimulator detail={detail} />
          </div>
          <DecisionDock detail={detail} forms={forms} primary={primary} readOnlyNote={readOnlyNote} now={now} />
        </div>
      </div>
    </section>
  );
}

export function ClarificationNotFound({ selected, closeHref }: { selected: string; closeHref: string }) {
  return (
    <div className="p-4">
      <AlertBanner
        tone="warning"
        title={`No clarification matches “${selected}”`}
        action={
          <Link href={closeHref} scroll={false} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Back to the list
          </Link>
        }
      >
        Check the ID (for example <span className="id-mono">CLR-0457</span>) or pick a question from the list. Nothing was changed.
      </AlertBanner>
    </div>
  );
}
