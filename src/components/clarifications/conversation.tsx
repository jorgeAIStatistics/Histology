"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Circle, CircleDot, Hourglass, Minus, Plug, Send, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { UnknownValue } from "@/components/domain/honesty";
import { IdentityMark } from "@/components/domain/identity-mark";
import { IdText } from "@/components/domain/id-text";
import { Timestamp } from "@/components/domain/timestamp";
import type { ClarificationDetail, MessageView } from "@/server/queries/clarifications";
import type { EvidenceItem } from "@/server/domain/clarification";
import {
  AnswerFields,
  DeliveryFields,
  NoticeEditor,
  OwnSubmit,
  QuestionEditor,
  ReviewFields,
  onOwnSubmit,
  type AnswerDraft,
  type DeliveryDraft,
  type ReviewDraft,
  type SendDraft,
} from "./clarification-forms";
import { leadName } from "./ladder";

/**
 * The conversation record: what the lab asked, what reached the office, what
 * the office said, what the lead decided, in time order on one spine. Steps
 * not taken yet stay on the spine as "Not yet", and the open slot holds the
 * next contribution (the draft, an answer given by phone, the review note);
 * its commit is docked in the decision column.
 */

/**
 * Spine marks on the ladder: a notice that went out is a neutral "sent" (its
 * delivery outcome carries any amber), an answer still due is neutral
 * "waiting", and amber marks only a step that is overdue.
 */
type Mark = "done" | "sent" | "current" | "waiting" | "warning" | "pending" | "skipped";

export interface Forms {
  send: SendDraft;
  answer: AnswerDraft;
  review: ReviewDraft;
  delivery: DeliveryDraft;
}

const MARK_ICON = { done: Check, sent: Send, current: CircleDot, waiting: Hourglass, warning: TriangleAlert, pending: Circle, skipped: Minus };
const MARK_WORD: Record<Mark, string> = { done: "Done", sent: "Sent", current: "Open now", waiting: "Waiting", warning: "Overdue", pending: "Not yet", skipped: "Not recorded" };

function Entry({
  mark,
  title,
  aside,
  meta,
  arriving,
  children,
  id,
  compact,
}: {
  compact?: boolean;
  mark: Mark;
  title: ReactNode;
  aside?: ReactNode;
  meta?: ReactNode;
  arriving?: boolean;
  children?: ReactNode;
  id?: string;
}) {
  const Icon = MARK_ICON[mark];
  const quiet = mark === "pending" || mark === "skipped";
  return (
    <li
      id={id}
      className={cn(
        "relative grid scroll-mt-4 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 px-5 max-lg:px-4",
        // The spine: one hairline through every marker, from the first marker to the last.
        "before:absolute before:top-0 before:bottom-0 before:left-[calc(1.25rem+0.75rem-0.5px)] before:w-px before:bg-line-strong max-lg:before:left-[calc(1rem+0.75rem-0.5px)]",
        "first:before:top-5 last:before:bottom-auto last:before:h-5",
        quiet || compact ? "py-2" : "py-3.5",
        mark === "current" && "bg-surface-subtle",
        arriving && "animate-rise-in",
      )}
    >
      <span
        className={cn(
          "relative z-[1] mt-0.5 flex size-6 items-center justify-center rounded-full border bg-surface",
          (mark === "done" || mark === "sent" || mark === "waiting") && "border-line-strong text-ink-secondary",
          mark === "current" && "border-ink text-ink",
          mark === "warning" && "border-warning-border bg-warning-bg text-warning-solid",
          quiet && "border-line text-ink-muted",
        )}
      >
        <Icon className="size-3.5" strokeWidth={mark === "current" ? 2.5 : 2} aria-hidden />
        <span className="sr-only">{MARK_WORD[mark]}: </span>
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className={cn("min-w-0 leading-6", quiet ? "text-sm text-ink-muted" : compact ? "text-base text-ink" : "text-base font-semibold text-ink")}>{title}</p>
          {aside ? <span className={cn("shrink-0 text-sm", quiet ? "text-ink-muted" : "text-ink-secondary")}>{aside}</span> : null}
        </div>
        {meta ? <div className="text-sm text-ink-secondary">{meta}</div> : null}
        {children ? <div className="mt-2 space-y-3">{children}</div> : null}
      </div>
    </li>
  );
}

/** A disclosure inside an entry: a quiet link-like toggle, 44px tall on the bench tablet. */
const SUMMARY =
  "inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-brand hover:underline max-xl:min-h-11 [&::-webkit-details-marker]:hidden";

/** Text as recorded (question, notice, answer, notes): kept verbatim, never reflowed into other words. */
function Recorded({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "notice" }) {
  return (
    <blockquote
      className={cn(
        "whitespace-pre-wrap break-words",
        tone === "plain" ? "text-base leading-6 text-ink" : "rounded-md bg-surface-subtle px-3 py-2 text-sm leading-5 text-ink-secondary",
      )}
    >
      {children}
    </blockquote>
  );
}

function DeliveryWord({ m }: { m: MessageView }) {
  const warn = m.deliveryState === "failed" || m.deliveryState === "delivery_unknown";
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", warn ? "rounded-sm bg-warning-bg px-1.5 font-medium text-warning-fg" : "text-ink-secondary")}>
      {warn ? <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden /> : m.deliveryState === "delivered" ? <Check className="size-3.5 shrink-0 text-ink-muted" aria-hidden /> : null}
      {m.deliveryLabel}
    </span>
  );
}

// ------------------------------------------------------------------ evidence (aligned, both values kept)

const IDENTITY_FIELD = /\b(date of birth|dob|patient name|name|mrn)\b/i;
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

function Value({ v, unknownReason }: { v: string | null | undefined; unknownReason?: string }) {
  if (v === null || v === undefined || v === "") return <UnknownValue reason={unknownReason} />;
  return <span className="text-ink">{v}</span>;
}

function Evidence({ detail, now }: { detail: ClarificationDetail; now: string }) {
  const s = detail.subject;
  const rows = detail.evidence;
  const withReq = rows.some((e) => e.requisition_value);
  const observedFrom = rows.find((e) => e.source && !/^source amendment$/i.test(e.field.trim()))?.source ?? null;
  const result = (e: EvidenceItem) => {
    if (/^source amendment$/i.test(e.field.trim())) return null;
    if (!e.order_value || !e.observed_value) return { tone: "muted" as const, text: "Not comparable" };
    if (norm(e.order_value) === norm(e.observed_value)) return { tone: "muted" as const, text: "Same" };
    return IDENTITY_FIELD.test(e.field) ? { tone: "danger" as const, text: "Patient identity differs" } : { tone: "warning" as const, text: "Differs" };
  };
  return (
    <div className="space-y-2">
      {detail.amendment ? (
        <p className="rounded-md border border-info-border bg-info-bg px-3 py-2 text-sm text-info-fg">
          The source order was amended: <IdText text={detail.amendment.label} /> received from the simulated source
          {detail.amendment.at ? (
            <>
              {" "}
              at <Timestamp iso={detail.amendment.at} now={now} />
            </>
          ) : null}
          . The original order value is kept and marked as superseded; the amended value is shown with it. The question and answer are unchanged.
        </p>
      ) : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Evidence for the question, kept as recorded: what the order says beside what was observed</caption>
            <thead className="bg-surface-subtle text-left align-bottom">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium text-ink-secondary">
                  Field
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium text-ink-secondary">
                  Order says
                  {s.orderRef ? (
                    <span className="font-normal text-ink-muted">
                      {" "}
                      <span className="id-mono whitespace-nowrap">{s.orderRef}</span>
                    </span>
                  ) : null}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium text-ink-secondary">
                  Observed
                  {observedFrom ? <span className="font-normal text-ink-muted"> ({observedFrom})</span> : null}
                </th>
                {withReq ? (
                  <th scope="col" className="px-3 py-1.5 font-medium text-ink-secondary">
                    Requisition
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-1.5 font-medium text-ink-secondary">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => {
                const amendmentRow = /^source amendment$/i.test(e.field.trim());
                const res = result(e);
                return (
                  <tr key={i} className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                      <span className="whitespace-nowrap">{e.field}</span>
                      {e.source && e.source !== observedFrom ? <span className="block font-normal text-ink-muted">From: {e.source}</span> : null}
                    </th>
                    <td className="px-3 py-2">
                      <Value v={e.order_value} unknownReason="not stated on the order" />
                      {e.superseded_by_amendment && !amendmentRow ? (
                        <>
                          <span className="mt-0.5 block w-fit rounded-sm border border-line bg-surface-subtle px-1.5 text-sm font-medium text-ink-secondary">
                            Superseded by <IdText text={e.superseded_by_amendment} />
                          </span>
                          <span className="block text-ink-secondary">
                            Amended order value: <Value v={e.amended_order_value} unknownReason="not given in the amendment" />
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {amendmentRow && !e.observed_value ? (
                        <span className="text-ink-secondary">Not applicable (source change, nothing observed)</span>
                      ) : (
                        <Value v={e.observed_value} unknownReason="not recorded" />
                      )}
                    </td>
                    {withReq ? <td className="px-3 py-2">{e.requisition_value ? <span className="text-ink">{e.requisition_value}</span> : <span className="text-ink-muted">None recorded</span>}</td> : null}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {res ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            res.tone === "danger" && "font-medium text-danger-fg",
                            res.tone === "warning" && "font-medium text-warning-fg",
                            res.tone === "muted" && "text-ink-muted",
                          )}
                        >
                          {res.tone === "danger" ? <IdentityMark className="size-4" /> : null}
                          {res.tone === "warning" ? <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden /> : null}
                          {res.text}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">No structured evidence was recorded with this question.</p>
      )}
      <p className="text-sm text-ink-muted">Both values are kept. Nothing is corrected automatically.</p>
    </div>
  );
}

// ------------------------------------------------------------------ the record

/** Keys of the entries that can arrive while a question is open (messages, acknowledgement, review, resolution). */
function entryKeys(d: ClarificationDetail): Set<string> {
  const k = new Set(d.messages.map((m) => `m-${m.id}`));
  if (d.timeline.find((t) => t.key === "acknowledged")?.at) k.add("ack");
  if (d.review) k.add("review");
  if (d.row.state === "answered") k.add("review-open");
  if (d.resolution) k.add("resolution");
  if (d.row.state === "reviewed") k.add("resolution-open");
  return k;
}

export function Conversation({
  detail,
  now,
  forms,
  primaryKey,
  readOnly,
}: {
  detail: ClarificationDetail;
  now: string;
  forms: Forms;
  primaryKey: string | null;
  readOnly: boolean;
}) {
  const r = detail.row;
  const office = detail.office.name;
  const lead = leadName(r);
  const step = (key: string) => detail.timeline.find((t) => t.key === key);
  const drafted = r.state === "drafted";
  const awaiting = ["sent", "delivery_unknown", "delivery_failed", "delivered", "acknowledged"].includes(r.state);

  // Entries that were not on screen when this question opened arrive with a short rise (a person caused them).
  const [initialKeys] = useState(() => entryKeys(detail));
  const isNew = (key: string) => key !== "question" && !initialKeys.has(key);

  const sentStep = step("sent");
  const answers = detail.messages.filter((m) => m.direction === "inbound" && m.kind === "answer");
  const latestAnswer = answers[answers.length - 1] ?? null;
  const lastOutbound = [...detail.messages].reverse().find((m) => m.direction === "outbound") ?? null;
  const ackStep = step("acknowledged");
  const hasAckMessage = detail.messages.some((m) => m.kind === "acknowledgement");
  // An acknowledgement recorded without its own message is shown on the notice it acknowledged.
  const ackHost =
    ackStep?.at && !hasAckMessage
      ? ([...detail.messages].reverse().find((m) => m.direction === "outbound" && Date.parse(m.createdAt) <= Date.parse(ackStep.at!)) ?? null)
      : null;
  const s = forms.send;
  const answerPrimary = primaryKey === "recordAnswer" && !readOnly;
  const deliveryPrimary = primaryKey === "recordDelivery" && !readOnly;

  const items: ReactNode[] = [];

  // 1. The question, as drafted or as sent (kept unchanged once sent), with its evidence aligned.
  items.push(
    <Entry
      key="question"
      mark={drafted ? "current" : "done"}
      arriving={isNew("question")}
      title={drafted ? "Question (draft)" : `Question to ${office}`}
      aside={drafted ? <span className="font-medium text-ink">Not sent</span> : sentStep?.at ? <Timestamp iso={sentStep.at} now={now} /> : null}
      meta={
        drafted ? (
          <>
            Drafted by {detail.people.createdBy} at <Timestamp iso={step("drafted")?.at} now={now} />. Nothing has left the lab.
          </>
        ) : (
          <>
            Drafted by {detail.people.createdBy}
            {sentStep?.actorName && sentStep.actorName !== detail.people.createdBy ? `; sent by ${sentStep.actorName}` : ""}. Sent through the simulated connector; kept unchanged once sent.
          </>
        )
      }
    >
      {s.editable ? <QuestionEditor s={s} /> : <Recorded>{detail.question}</Recorded>}
      {!s.editable && detail.draftSource === "assistant_proposal" ? <p className="text-sm text-ink-muted">Started from deterministic demo draft text, accepted and edited by a person.</p> : null}
      {!s.editable && detail.draftSource === "template" ? <p className="text-sm text-ink-muted">Default question from a fixed template (rule-based, not AI).</p> : null}
      <Evidence detail={detail} now={now} />
    </Entry>,
  );

  // 2. Drafted: the generic notice that will go when someone sends it.
  if (drafted) {
    const to = detail.contact.currentRecipient;
    items.push(
      <Entry
        key="notice-draft"
        mark="current"
        title={`Notice to ${office}`}
        aside={<span className="font-medium text-ink">Not sent</span>}
        meta={to ? `Will go to ${to.name}, ${to.role}, by ${to.channelLabel}.` : `No contact on file for ${office}.`}
      >
        {s.editable ? <NoticeEditor s={s} /> : <Recorded tone="notice">{detail.notificationPreview}</Recorded>}
      </Entry>,
    );
  }

  // 3. Messages in time order: notices with their simulated delivery outcomes, acknowledgements, answers.
  const timed: { at: string; key: string; node: ReactNode }[] = [];
  for (const m of detail.messages) {
    const key = `m-${m.id}`;
    const arriving = isNew(key);
    if (m.direction === "outbound") {
      const isLast = m === lastOutbound;
      const ownDelivery = isLast && !readOnly && !deliveryPrimary && forms.delivery.action?.enabled;
      timed.push({
        at: m.createdAt,
        key,
        node: (
          <Entry
            key={key}
            mark="sent"
            arriving={arriving}
            title={`${m.kindLabel} to ${m.recipientName ?? office}`}
            aside={<Timestamp iso={m.createdAt} now={now} />}
            meta={
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span>
                  {m.channelLabel}
                  {m.createdByName ? `, sent by ${m.createdByName}` : ""}
                </span>
                <DeliveryWord m={m} />
                {m === ackHost && ackStep?.at ? (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <Check className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
                    Acknowledged <Timestamp iso={ackStep.at} now={now} />
                  </span>
                ) : null}
                <details className="group/n open:basis-full">
                  <summary className={SUMMARY}>
                    Notice text
                    <ChevronDown className="size-3.5 transition-transform duration-[var(--hlo-duration-fast)] group-open/n:rotate-180" aria-hidden />
                  </summary>
                  <div className="mt-1 mb-1">
                    <Recorded tone="notice">{m.body}</Recorded>
                    <p className="mt-1 text-sm text-ink-muted">Generic notice: no patient details, no question text.</p>
                  </div>
                </details>
                {ownDelivery ? (
                  <details id="clr-delivery-form" className="group/d open:basis-full" data-clr-own-submit="" onKeyDown={onOwnSubmit(forms.delivery.submit)}>
                    <summary className={SUMMARY}>
                      Record a delivery outcome
                      <ChevronDown className="size-3.5 transition-transform duration-[var(--hlo-duration-fast)] group-open/d:rotate-180" aria-hidden />
                    </summary>
                    <div className="mt-2 mb-1 space-y-3 text-base text-ink">
                      <DeliveryFields d={forms.delivery} />
                      <OwnSubmit
                        label="Record delivery outcome"
                        pendingLabel="Recording..."
                        disabledReason={forms.delivery.blockedReason}
                        pending={forms.delivery.pending}
                        error={forms.delivery.error}
                        onSubmit={forms.delivery.submit}
                      />
                    </div>
                  </details>
                ) : null}
              </div>
            }
          />
        ),
      });
    } else if (m.kind === "answer") {
      const latest = m === latestAnswer;
      const a = detail.answer;
      timed.push({
        at: m.createdAt,
        key,
        node: (
          <Entry
            key={key}
            mark="done"
            arriving={arriving}
            title={`Answer from ${office}`}
            aside={<Timestamp iso={m.createdAt} now={now} />}
            meta={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {latest && a ? (
                  <span>
                    Given by {a.by ?? "Unknown responder"}, {a.channelLabel}
                  </span>
                ) : (
                  <span>{m.channelLabel}</span>
                )}
                {m.createdByName && m.createdByName !== "Simulated office" ? <span>Recorded by {m.createdByName}</span> : null}
              </span>
            }
          >
            <Recorded>{m.body}</Recorded>
            {latest && r.state === "answered" ? <p className="text-sm text-ink-secondary">Not resolved: a lead or supervisor must review this answer.</p> : null}
          </Entry>
        ),
      });
    } else {
      const title = m.kind === "acknowledgement" ? `${office} acknowledged it` : m.kind === "delivery_receipt" ? `Delivery outcome: ${m.deliveryLabel}` : m.kindLabel;
      timed.push({
        at: m.createdAt,
        key,
        node: (
          <Entry key={key} compact mark="done" arriving={arriving} title={title} aside={<Timestamp iso={m.createdAt} now={now} />} meta={m.createdByName ? `Recorded by ${m.createdByName}` : m.channelLabel}>
            {m.body ? <Recorded tone="notice">{m.body}</Recorded> : null}
          </Entry>
        ),
      });
    }
  }
  if (ackStep?.at && !hasAckMessage && !ackHost) {
    timed.push({
      at: ackStep.at,
      key: "ack",
      node: <Entry key="ack" compact mark="done" arriving={isNew("ack")} title={`${office} acknowledged it`} aside={<Timestamp iso={ackStep.at} now={now} />} meta={ackStep.actorName ? `Recorded by ${ackStep.actorName}` : null} />,
    });
  }
  // A review that sent the answer back (marked insufficient) sits after the answer it judged.
  if (detail.review && (r.state === "reviewed" || r.state === "resolved" || detail.answer?.markedInsufficient)) {
    const insufficient = !!detail.answer?.markedInsufficient;
    const at = detail.review.at ?? latestAnswer?.createdAt ?? now;
    timed.push({
      at: insufficient && !detail.review.at ? (latestAnswer?.createdAt ?? now) : at,
      key: "review",
      node: (
        <Entry
          key="review"
          mark="done"
          arriving={isNew("review")}
          title={insufficient ? `Marked insufficient by ${detail.review.byName ?? "Unknown"}` : `Reviewed by ${detail.review.byName ?? "Unknown"}`}
          aside={detail.review.at ? <Timestamp iso={detail.review.at} now={now} /> : null}
          meta={insufficient ? `Waiting for a further answer from ${office}.` : r.state === "reviewed" ? "Not resolved yet." : null}
        >
          {detail.review.note ? <Recorded>{detail.review.note}</Recorded> : <p className="text-sm text-ink-muted">No review note.</p>}
        </Entry>
      ),
    });
  }
  timed.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  for (const t of timed) items.push(t.node);

  // 4. The office answer still to come (open slot while waiting on the office).
  if (awaiting) {
    // Amber only once the answer is overdue; a delivery problem is told on the notice's outcome.
    const overdue = r.overdueMinutes !== null;
    const ownAnswer = !readOnly && !answerPrimary && forms.answer.action?.enabled;
    items.push(
      <Entry
        key="answer-open"
        mark={overdue ? "warning" : answerPrimary ? "current" : "waiting"}
        title={`Answer from ${office}`}
        aside={overdue ? <span className="font-medium text-warning-fg">{r.followUpText}</span> : <span>Not received yet</span>}
        meta={
          r.nextFollowUpAt && !overdue ? (
            <>
              Next follow-up <Timestamp iso={r.nextFollowUpAt} now={now} /> by {r.labOwnerName}.
            </>
          ) : overdue ? (
            `Past the follow-up time. ${r.labOwnerName} follows up.`
          ) : null
        }
      >
        {answerPrimary ? (
          <div data-clr-primary-form="">
            <AnswerFields a={forms.answer} detail={detail} />
          </div>
        ) : ownAnswer ? (
          <details id="clr-answer-form" className="group/a -mt-1.5" data-clr-own-submit="" onKeyDown={onOwnSubmit(forms.answer.submit)}>
            <summary className={SUMMARY}>
              Record an answer given by phone or another channel
              <ChevronDown className="size-3.5 transition-transform duration-[var(--hlo-duration-fast)] group-open/a:rotate-180" aria-hidden />
            </summary>
            <div className="mt-2 space-y-3">
              <AnswerFields a={forms.answer} detail={detail} />
              <OwnSubmit
                label="Record office answer"
                pendingLabel="Recording..."
                disabledReason={forms.answer.blockedReason}
                pending={forms.answer.pending}
                error={forms.answer.error}
                onSubmit={forms.answer.submit}
              />
            </div>
          </details>
        ) : null}
      </Entry>,
    );
  } else if (drafted) {
    items.push(<Entry key="answer-future" mark="pending" title={`Answer from ${office}`} aside="Not yet" />);
  }

  // 5. The lead's review: the open slot once the office has answered.
  if (r.state === "answered") {
    const canReview = !readOnly && !!forms.review.action?.enabled;
    items.push(
      <Entry
        key="review-open"
        mark="current"
        arriving={isNew("review-open")}
        title={`Review by ${lead}`}
        aside="Not reviewed yet"
        meta={canReview ? "Nothing is resolved until the answer is reviewed." : "A lead or supervisor reviews the answer before anything is resolved."}
      >
        {canReview ? <ReviewFields r={forms.review} /> : null}
      </Entry>,
    );
  } else if (drafted || awaiting) {
    items.push(<Entry key="review-future" mark="pending" title={`Review by ${lead}`} aside="Not yet" />);
  }

  // 6. The resolution (and a cancel, which closes the question without an answer).
  if (detail.resolution) {
    items.push(
      <Entry
        key="resolution"
        mark="done"
        arriving={isNew("resolution")}
        title={`Resolved by ${detail.resolution.byName ?? "Unknown"}: ${detail.resolution.codeLabel ?? "no code"}.`}
        aside={<Timestamp iso={detail.resolution.at} now={now} />}
        meta={detail.holds.some((h) => h.status === "active") ? "Resolving did not release the hold; a lead releases it separately, with a reason." : null}
      >
        {detail.resolution.note ? <Recorded>{detail.resolution.note}</Recorded> : null}
      </Entry>,
    );
  } else if (r.state === "canceled") {
    const c = step("canceled");
    items.push(
      <Entry key="canceled" mark="skipped" title={`Canceled${c?.actorName ? ` by ${c.actorName}` : ""}`} aside={c?.at ? <Timestamp iso={c.at} now={now} /> : null}>
        <p className="text-sm text-ink-secondary">Reason: {detail.cancelReason ?? "Unknown"}</p>
      </Entry>,
    );
  } else if (r.state === "reviewed") {
    items.push(
      <Entry key="resolution-open" mark="current" arriving={isNew("resolution-open")} title="Resolution" aside="Not resolved yet" meta="Resolving closes the question. A hold is released separately, with a reason." />,
    );
  } else {
    items.push(<Entry key="resolution-future" mark="pending" title="Resolution" aside="Not yet" />);
  }

  return (
    <section aria-labelledby="clr-conversation-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-5 py-3 max-lg:px-4">
        <h3 id="clr-conversation-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
          Conversation with {office}
        </h3>
        <p className="flex items-center gap-1.5 text-sm text-ink-muted">
          <Plug className="size-3.5 shrink-0" aria-hidden />
          Simulated: nothing here reaches a real office
        </p>
      </div>
      <ol aria-label={`Conversation with ${office}, in time order`} className="py-1.5">
        {items}
      </ol>
      {detail.reminder.count > 0 || detail.reminder.lastSentAt || detail.escalatedAt ? (
        <p className="border-t border-line px-5 py-2.5 text-sm text-ink-muted max-lg:px-4">
          Reminders sent: {detail.reminder.count}. No second reminder within {detail.reminder.suppressionMinutes} min
          {detail.reminder.nextAllowedAt && detail.reminder.suppressedNow ? (
            <>
              ; next allowed at <Timestamp iso={detail.reminder.nextAllowedAt} now={now} />
            </>
          ) : null}
          .{detail.escalatedAt ? <> Escalated <Timestamp iso={detail.escalatedAt} now={now} />.</> : null}
        </p>
      ) : null}
    </section>
  );
}
