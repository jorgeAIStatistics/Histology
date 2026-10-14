"use client";

import { ArrowDownLeft, ArrowUpRight, Check, Circle, CircleDot, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { SidePanel } from "@/components/ui/side-panel";
import { StatePill } from "@/components/ui/status-pill";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Timeline, sourceFromOrigin, type TimelineEvent } from "@/components/ui/timeline";
import { AccessionChip, IdChip, ProvisionalChip } from "@/components/domain/chips";
import { HoldBanner } from "@/components/domain/hold";
import { SimulatedLabel, SyntheticTag, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { ClarificationActions, ReleaseHoldDialog } from "./clarification-actions";
import type { ClarificationDetail, ContactView, TimelineStep } from "@/server/queries/clarifications";

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Value({ v, unknownReason }: { v: string | null | undefined; unknownReason?: string }) {
  if (v === null || v === undefined || v === "") return <UnknownValue reason={unknownReason} />;
  return <span className="text-ink">{v}</span>;
}

const STEP_ICON = { done: Check, current: CircleDot, pending: Circle, skipped: Minus };
const STEP_TONE: Record<string, string> = {
  neutral: "text-ink-secondary",
  info: "text-info-solid",
  success: "text-success-solid",
  warning: "text-warning-solid",
  danger: "text-danger-solid",
  hold: "text-hold-solid",
};

function StateSteps({ steps, now }: { steps: TimelineStep[]; now: string }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s) => {
        const Icon = STEP_ICON[s.status];
        return (
          <li key={s.key} className="grid grid-cols-[1.25rem_1fr_auto] items-start gap-x-2 py-1">
            <Icon className={cn("mt-0.5 size-4", s.status === "pending" || s.status === "skipped" ? "text-ink-muted" : STEP_TONE[s.tone])} aria-hidden />
            <div className="min-w-0">
              <p className={cn("text-sm", s.status === "pending" ? "text-ink-muted" : "text-ink", s.status === "current" && "font-semibold")}>
                {s.label}
                <span className="sr-only">
                  {s.status === "done" ? ", done" : s.status === "current" ? ", current state" : s.status === "skipped" ? ", not recorded" : ", not yet"}
                </span>
              </p>
              {s.actorName || s.detail ? (
                <p className="text-xs text-ink-secondary">
                  {[s.actorName, s.detail].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {s.status === "skipped" && !s.detail ? <p className="text-xs text-ink-muted">Not recorded</p> : null}
            </div>
            {s.at ? <Timestamp iso={s.at} now={now} className="text-xs text-ink-muted" /> : <span className="text-xs text-ink-muted">{s.status === "pending" ? "Not yet" : ""}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function ContactLine({ label, c, now, emptyText = "None on file" }: { label: string; c: ContactView | null; now: string; emptyText?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-2 py-0.5">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="min-w-0">
        {c ? (
          <>
            <span className="text-ink">{c.name}</span>
            <span className="text-ink-secondary">, {c.role}</span>
            <span className="block text-xs text-ink-muted">{c.channelLabel}</span>
            {c.isOutNow && c.outUntil ? (
              <span className="block text-xs font-medium text-warning-fg">
                Out until <Timestamp iso={c.outUntil} now={now} />
              </span>
            ) : null}
            {c.unverified ? <span className="block text-xs font-medium text-warning-fg">Unverified contact (new office)</span> : null}
          </>
        ) : (
          <span className="text-ink-muted">{emptyText}</span>
        )}
      </dd>
    </div>
  );
}

export function ClarificationPanel({
  detail,
  now,
  closeHref,
  readOnlyNote,
  preserveFocus,
}: {
  detail: ClarificationDetail;
  now: string;
  closeHref: string;
  readOnlyNote: string | null;
  preserveFocus?: boolean;
}) {
  const r = detail.row;
  const s = detail.subject;
  const activeHolds = detail.holds.filter((h) => h.status === "active");
  const releasedHolds = detail.holds.filter((h) => h.status === "released");
  const releaseAction = detail.actions.find((a) => a.key === "releaseHold");
  const historyEvents: TimelineEvent[] = detail.history.map((h) => ({
    id: String(h.seq),
    at: h.at,
    actorName: h.actorName,
    actorRole: h.actorRoleLabel,
    summary: h.summary,
    source: h.origin === "simulator" && h.actorName === "Simulated office" ? "office" : sourceFromOrigin(h.origin),
    reason: h.reason,
  }));

  return (
    <SidePanel
      title={`${r.categoryLabel} question: ${r.affectedLabel}`}
      identity={<IdChip id={r.displayId} kind="CLR" showKind />}
      status={<StatePill domain="clarification" state={r.state} />}
      fullRecordHref={s.accessionNumber ? `/cases/${encodeURIComponent(s.accessionNumber)}` : undefined}
      closeHref={closeHref}
      focusKey={r.id}
      preserveFocus={preserveFocus}
    >
      <div className="flex flex-col gap-3">
        {/* Identity stays visible while acting on the record. */}
        <div className="flex flex-col gap-1 rounded-md bg-surface-subtle px-3 py-2 text-sm">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {s.accessionNumber ? <AccessionChip accession={s.accessionNumber} compact href={false} /> : s.intakeDisplayId ? <ProvisionalChip id={s.intakeDisplayId} compact href={false} /> : null}
            {s.partDesignation ? <span className="font-medium text-ink">Part {s.partDesignation}</span> : null}
            {r.category === "identity_conflict" ? <span className="font-medium text-ink">{s.accessionNumber ? "All parts" : "All containers"}</span> : null}
            {s.orderRef ? <IdChip id={s.orderRef} kind="ORD" tenant={s.orderTenant ?? undefined} /> : null}
          </p>
          {s.patient ? (
            <p className="text-ink-secondary">
              <span className="text-ink">{s.patient.name}</span> <SyntheticTag /> · MRN <span className="id-mono">{s.patient.mrn}</span>, {s.patient.tenant}
            </p>
          ) : null}
          <p className="text-ink-secondary">
            {detail.office.name} · Lab owner <span className="text-ink">{detail.people.labOwner}</span> · Priority {r.priority} ·{" "}
            {r.overdueMinutes !== null ? <span className="font-medium text-danger-fg">{r.followUpText}</span> : <span>Next follow-up: {r.followUpText}</span>}
          </p>
        </div>

        {detail.deliveryGuidance ? (
          <AlertBanner tone={detail.deliveryGuidance.tone === "danger" ? "danger" : detail.deliveryGuidance.tone === "warning" ? "warning" : "info"} title={detail.deliveryGuidance.title}>
            {detail.deliveryGuidance.body}
          </AlertBanner>
        ) : null}

        {detail.answer ? (
          <section aria-label="Office answer" className="flex flex-col gap-1 rounded-md border border-info-border bg-info-bg px-3 py-2">
            <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-info-fg">
              {detail.answer.simulated ? <SimulatedLabel size="xs">Simulated office reply</SimulatedLabel> : <span>Office answer</span>}
              <span>
                received <Timestamp iso={detail.answer.at} now={now} /> · {detail.answer.by ?? "Unknown responder"} · {detail.answer.channelLabel}
              </span>
            </p>
            <blockquote className="whitespace-pre-wrap text-sm text-ink">{detail.answer.text}</blockquote>
            <p className="text-xs text-ink-secondary">
              {detail.answer.markedInsufficient
                ? `Marked insufficient by ${detail.review?.byName ?? "Unknown"}${detail.review?.note ? `: “${detail.review.note}”` : ""}. Waiting for a further answer from the office.`
                : r.state === "answered"
                ? "Not resolved: a lead or supervisor must review this answer."
                : r.state === "reviewed"
                  ? `Reviewed by ${detail.review?.byName ?? "Unknown"}${detail.review?.note ? `: “${detail.review.note}”` : ""}. Not resolved yet.`
                  : detail.resolution
                    ? `Resolved by ${detail.resolution.byName ?? "Unknown"}: ${detail.resolution.codeLabel ?? "no code"}.`
                    : null}
            </p>
          </section>
        ) : null}

        {detail.resolution ? (
          <section aria-label="Resolution" className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm">
            <p className="font-semibold text-success-fg">
              Resolved <Timestamp iso={detail.resolution.at} now={now} /> by {detail.resolution.byName ?? "Unknown"}
            </p>
            <p className="text-ink">{detail.resolution.codeLabel}</p>
            {detail.resolution.note ? <p className="mt-0.5 text-ink-secondary">Note: {detail.resolution.note}</p> : null}
          </section>
        ) : null}
        {detail.cancelReason ? (
          <AlertBanner tone="info" title="Canceled">
            Reason: {detail.cancelReason}
          </AlertBanner>
        ) : null}

        {/* Keyed by record only: a refresh after someone else's change must not wipe what is being typed (stale saves get CONFLICT). */}
        <ClarificationActions key={r.id} detail={detail} readOnlyNote={readOnlyNote} />

        {/* Hold scope: only the affected material. */}
        {activeHolds.map((h) => (
          <HoldBanner
            key={h.id}
            scope={h.scopeShort}
            reason={h.reasonText}
            otherScopeNote={h.siblingNote || undefined}
            evidence={<span className="text-ink-secondary">Holds: {h.blockLabels.join(", ")}. Placed <Timestamp iso={h.placedAt} now={now} /> by {h.placedByName}.</span>}
            clarification={{ displayId: r.displayId }}
            owner={r.isOpen ? detail.people.labOwner : `${detail.people.escalationOwner ?? "Accessioning lead"} (release decision)`}
            nextFollowUpAt={r.isOpen ? r.nextFollowUpAt : null}
            now={now}
          >
            <p className="mt-1 text-xs text-ink-secondary">
              <span className="id-mono">{h.displayId}</span>. Not released by sending, an answer, or resolution alone: a lead or supervisor releases it with a reason.
            </p>
            <div className="mt-2">
              <ReleaseHoldDialog hold={h} clarificationOpen={r.isOpen} clarificationLabel={r.displayId} action={releaseAction} />
            </div>
          </HoldBanner>
        ))}
        {releasedHolds.map((h) => (
          <p key={h.id} className="rounded-md border border-line px-3 py-2 text-xs text-ink-secondary">
            <span className="id-mono text-ink">{h.displayId}</span> on {h.scopeLabel} released <Timestamp iso={h.releasedAt} now={now} /> by {h.releasedByName ?? "Unknown"}.
            {h.releaseReason ? ` Reason: ${h.releaseReason}` : ""}
          </p>
        ))}
        {!detail.holds.length ? <p className="text-xs text-ink-secondary">No hold is linked to this clarification. Other work on this material is not blocked by it.</p> : null}

        <Section title="Question (original text)">
          <p className="whitespace-pre-wrap text-sm text-ink">{detail.question}</p>
          {detail.draftSource === "assistant_proposal" ? <p className="text-xs text-ink-muted">Started from deterministic demo draft text, accepted and edited by a person.</p> : null}
          {detail.draftSource === "template" ? <p className="text-xs text-ink-muted">Default question from a fixed template (rule-based, not AI). No one has written it yet; edit it before sending.</p> : null}
        </Section>

        <Section title="Evidence">
          {detail.amendment ? (
            <p className="rounded-sm border border-info-border bg-info-bg px-2 py-1.5 text-xs text-info-fg">
              The source order was amended: {detail.amendment.label} received from the simulated source
              {detail.amendment.at ? (
                <>
                  {" "}
                  at <Timestamp iso={detail.amendment.at} now={now} />
                </>
              ) : null}
              . The original order value is kept and marked as superseded; the amended value is shown with it. The question and answer are unchanged.
            </p>
          ) : null}
          {detail.evidence.length ? (
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Conflicting values, kept as recorded</caption>
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="pb-1 pr-2 font-medium">Field</th>
                  <th scope="col" className="pb-1 pr-2 font-medium">Order says{s.orderRef ? ` (${s.orderRef})` : ""}</th>
                  <th scope="col" className="pb-1 font-medium">Observed</th>
                </tr>
              </thead>
              <tbody>
                {detail.evidence.map((e, i) => {
                  const amendmentRow = /^source amendment$/i.test(e.field.trim());
                  return (
                    <tr key={i} className="align-top">
                      <th scope="row" className="py-1 pr-2 text-left font-medium text-ink-secondary">
                        {e.field}
                        {/* Where the evidence was recorded from (not a value): kept with the field, not under the observed value. */}
                        {e.source ? <span className="block text-xs font-normal text-ink-muted">From: {e.source}</span> : null}
                      </th>
                      <td className="py-1 pr-2">
                        <Value v={e.order_value} unknownReason="not stated on the order" />
                        {e.superseded_by_amendment && !amendmentRow ? (
                          <>
                            <span className="mt-0.5 block w-fit rounded-sm border border-line bg-surface-subtle px-1.5 text-xs font-medium text-ink-secondary">
                              Superseded by {e.superseded_by_amendment}
                            </span>
                            <span className="block text-xs text-ink-secondary">
                              Amended order value: <Value v={e.amended_order_value} unknownReason="not given in the amendment" />
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td className="py-1">
                        {amendmentRow && !e.observed_value ? (
                          <span className="text-ink-secondary">Not applicable (source change, nothing observed)</span>
                        ) : (
                          <Value v={e.observed_value} unknownReason="not recorded" />
                        )}
                        {e.requisition_value ? <span className="block text-xs text-ink-muted">Requisition: {e.requisition_value}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-ink-secondary">No structured evidence was recorded with this question.</p>
          )}
          <p className="text-xs text-ink-muted">Both values are kept. Nothing is corrected automatically.</p>
        </Section>

        <Section title="State timeline">
          <StateSteps steps={detail.timeline} now={now} />
        </Section>

        <Section title="Office contact and coverage" aside={<SimulatedLabel size="xs" connector="notifications" />}>
          <dl className="text-sm">
            <ContactLine
              label={r.state === "drafted" ? "Will go to" : "Sent to"}
              c={detail.contact.selected}
              now={now}
              emptyText={r.state === "drafted" ? "No named contact chosen yet" : "No named contact recorded (sent to the office)"}
            />
            {r.isOpen && r.state !== "drafted" && detail.contact.currentRecipient && detail.contact.currentRecipient.name !== detail.contact.selected?.name ? (
              <div className="grid grid-cols-[7.5rem_1fr] gap-x-2 py-0.5">
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
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-2 py-0.5">
              <dt className="text-ink-secondary">Office hours</dt>
              <dd className="text-ink">{detail.office.workingHoursText} (ET)</dd>
            </div>
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-2 py-0.5">
              <dt className="text-ink-secondary">Lab escalation</dt>
              <dd className="text-ink">{detail.people.escalationOwner ?? "None assigned"}</dd>
            </div>
          </dl>
          {detail.contact.routedToBackup ? <p className="text-xs font-medium text-warning-fg">Routed to the backup contact because the primary contact was out.</p> : null}
          {detail.contact.coverageNoteNow ? <p className="text-xs text-warning-fg">Now: {detail.contact.coverageNoteNow}</p> : null}
          <p className="text-xs text-ink-muted">
            {detail.priorityRule} Fictional directory, read-only here. Faster answers need an agreement with each office about ownership and escalation; more notifications alone add noise.
          </p>
        </Section>

        <Section title="Messages" aside={<SimulatedLabel size="xs">Simulated: never sent to a real office</SimulatedLabel>}>
          {detail.messages.length ? (
            <ol className="flex flex-col gap-2">
              {detail.messages.map((m) => (
                <li key={m.id} className="rounded-md border border-line px-2.5 py-2">
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-secondary">
                    {m.direction === "outbound" ? <ArrowUpRight className="size-3.5 text-ink-muted" aria-hidden /> : <ArrowDownLeft className="size-3.5 text-ink-muted" aria-hidden />}
                    <span className="font-medium text-ink">{m.kindLabel}</span>
                    <span>{m.direction === "outbound" ? (m.recipientName ? `to ${m.recipientName}` : "to the office (no named contact recorded)") : "from office"}</span>
                    <span>· {m.channelLabel}</span>
                    <Timestamp iso={m.createdAt} now={now} />
                    <span className={cn(m.deliveryState === "failed" ? "text-danger-fg" : m.deliveryState === "delivery_unknown" ? "text-warning-fg" : "")}>· {m.deliveryLabel}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{m.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-secondary">No messages yet. Nothing has been sent.</p>
          )}
          {detail.reminder.count > 0 || detail.reminder.lastSentAt ? (
            <p className="text-xs text-ink-muted">
              Reminders sent: {detail.reminder.count}. No second reminder within {detail.reminder.suppressionMinutes} min
              {detail.reminder.nextAllowedAt && detail.reminder.suppressedNow ? (
                <>
                  ; next allowed at <Timestamp iso={detail.reminder.nextAllowedAt} now={now} />
                </>
              ) : null}
              .{detail.escalatedAt ? <> Escalated <Timestamp iso={detail.escalatedAt} now={now} />.</> : null}
            </p>
          ) : null}
        </Section>

        <Section title="Linked records">
          <div className="flex flex-wrap items-center gap-2">
            {s.intakeDisplayId ? <ProvisionalChip id={s.intakeDisplayId} /> : null}
            {s.accessionNumber ? <AccessionChip accession={s.accessionNumber} /> : null}
            {s.orderRef ? <IdChip id={s.orderRef} kind="ORD" tenant={s.orderTenant ?? undefined} showKind /> : null}
            {!s.intakeDisplayId && !s.accessionNumber && !s.orderRef ? <span className="text-sm text-ink-secondary">{r.subjectLabel}</span> : null}
          </div>
        </Section>

        <section aria-label="History" className="border-t border-line pt-3">
          <Timeline title="History" events={historyEvents} now={now} emptyText="No local events recorded yet." />
          {detail.stepsWithoutAudit.length ? (
            <p className="mt-2 rounded-sm bg-surface-subtle px-2 py-1.5 text-xs text-ink-secondary">
              Seeded with the demo scenario before the demo clock started: {detail.stepsWithoutAudit.join(", ")}{" "}
              {detail.stepsWithoutAudit.length === 1 ? "appears" : "appear"} in the State timeline only. History lists the events recorded in this
              demo.
            </p>
          ) : null}
        </section>
      </div>
    </SidePanel>
  );
}

export function ClarificationNotFound({ selected, closeHref }: { selected: string; closeHref: string }) {
  return (
    <SidePanel title="Clarification not found" closeHref={closeHref}>
      <AlertBanner tone="warning" title={`No clarification matches “${selected}”`}>
        Check the ID (for example CLR-0457) or pick a row from the list. Nothing was changed.
      </AlertBanner>
    </SidePanel>
  );
}
