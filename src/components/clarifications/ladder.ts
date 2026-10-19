import { fmtSmart } from "@/lib/time";
import type { ActionView, ClarificationDetail, ClarificationListRow, HoldView, MaterialRef } from "@/server/queries/clarifications";

/**
 * Words and severity for /clarifications, on the shared ladder
 * (docs/redesign/visual-system.md): amber with words when something may be
 * wrong (overdue, delivery failed or unknown), hatched ink for a hold with its
 * scope, neutral ink with the person's name for waiting, a quiet check for
 * done. Red is reserved for patient identity and is never used here.
 * Pure functions: the queue row, the status band and the docked step all
 * read the same sentences.
 */
export type Rung = "warning" | "waiting" | "draft" | "done" | "muted";

export interface Flag {
  rung: Rung;
  text: string;
}

const at = (iso: string | null | undefined, now: string) => (iso ? `${fmtSmart(iso, now)} ET` : "an unknown time");

/** "Overdue 23 min" → "overdue 23 min" (inside a sentence). */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The lead who reviews and resolves (the review task goes to the escalation owner). */
export function leadName(r: Pick<ClarificationListRow, "escalationOwnerName">): string {
  return r.escalationOwnerName ?? "The accessioning lead";
}

/** "Part B", "All containers", "All parts", or null for the whole item. */
export function materialWords(m: MaterialRef): string | null {
  if (m.scope === "all_containers") return "All containers";
  if (m.scope === "all_parts") return "All parts";
  return m.part ? `Part ${m.part}` : null;
}

/** Hold scope in words for a chip: "Part B", "all containers", "the Part B container". */
export function holdScopeWords(scope: string): string {
  if (/\(all containers\)/i.test(scope)) return "all containers";
  if (/\(all parts\)/i.test(scope)) return "all parts";
  const part = /\bpart ([A-Z])\b/i.exec(scope);
  if (part && !/container/i.test(scope)) return `Part ${part[1].toUpperCase()}`;
  return scope;
}

/** The state of one queue row on the ladder, in words. Drafted never reads as sent. */
export function rowFlag(r: ClarificationListRow): Flag {
  // Closed, but a linked hold is still active: the lead still has to release it (named, neutral; the hold chip carries the scope).
  if (r.holdToRelease) return { rung: "waiting", text: `Hold to release · ${leadName(r)}` };
  if (!r.isOpen) return r.state === "resolved" ? { rung: "done", text: "Resolved" } : { rung: "muted", text: "Canceled" };
  const overdue = r.overdueMinutes !== null ? r.followUpText : null;
  if (r.state === "delivery_failed") return { rung: "warning", text: overdue ? `Delivery failed, ${lower(overdue)}` : "Delivery failed" };
  if (r.state === "delivery_unknown") return { rung: "warning", text: overdue ? `Delivery unknown, ${lower(overdue)}` : "Delivery unknown" };
  if (overdue) return { rung: "warning", text: `${overdue}, no answer` };
  switch (r.state) {
    case "drafted":
      return { rung: "draft", text: "Drafted, not sent" };
    case "answered":
      return { rung: "waiting", text: `${leadName(r)} to review` };
    case "reviewed":
      return { rung: "waiting", text: `${leadName(r)} to resolve` };
    case "acknowledged":
      return { rung: "waiting", text: "Acknowledged, no answer yet" };
    case "delivered":
      return { rung: "waiting", text: "Delivered, no answer yet" };
    default:
      return { rung: "waiting", text: "Sent, no answer yet" };
  }
}

/** The right-hand time on a queue row: the next follow-up, who sends a draft, or nothing. */
export function rowWhen(r: ClarificationListRow): string | null {
  if (r.holdToRelease) return r.state === "resolved" ? "Resolved" : "Canceled";
  if (!r.isOpen) return null;
  if (r.state === "drafted") return `${r.labOwnerName} to send`;
  if (r.overdueMinutes !== null || r.state === "answered" || r.state === "reviewed") return null;
  return r.nextFollowUpAt ? `Follow-up ${r.followUpText}` : r.followUpText;
}

/** One sentence on where the open question stands, for the status band. */
export function statusSentence(d: ClarificationDetail, now: string): { rung: Rung; lead: string; rest: string | null } {
  const r = d.row;
  const office = d.office.name;
  const lead = leadName(r);
  const followUp = r.nextFollowUpAt ? `next follow-up ${at(r.nextFollowUpAt, now)}` : "no follow-up time set";
  const coverage = d.contact.coverageNoteNow ? ` ${d.contact.coverageNoteNow}` : "";
  switch (r.state) {
    case "drafted":
      return { rung: "draft", lead: "Drafted, not sent.", rest: `Nothing has left the lab. ${r.labOwnerName} to send.` };
    case "delivery_failed":
      return {
        rung: "warning",
        lead: r.overdueMinutes !== null ? `Delivery failed (simulated), ${lower(r.followUpText)}.` : "Delivery failed (simulated).",
        rest: `${office} did not get the last notice.${coverage}`,
      };
    case "delivery_unknown":
      return {
        rung: "warning",
        lead: r.overdueMinutes !== null ? `Delivery unknown, ${lower(r.followUpText)}.` : "Delivery unknown.",
        rest: `The simulated connector did not confirm that ${office} got the notice; ${followUp}.`,
      };
    case "answered":
      return { rung: "waiting", lead: `${office} answered ${at(d.answer?.at, now)}.`, rest: `${lead} to review.` };
    case "reviewed":
      return { rung: "waiting", lead: `Answer reviewed by ${d.review?.byName ?? "Unknown"}.`, rest: `${lead} to resolve.` };
    case "resolved": {
      const held = d.holds.filter((h) => h.status === "active");
      return {
        rung: "done",
        lead: `Resolved ${at(d.resolution?.at, now)} by ${d.resolution?.byName ?? "Unknown"}.`,
        rest: held.length
          ? `${held.map((h) => h.displayId).join(", ")} still ${held.length === 1 ? "holds" : "hold"} ${holdScopeWords(held[0].scopeShort)} until a lead releases it with a reason.`
          : d.resolution?.codeLabel
            ? `${d.resolution.codeLabel}.`
            : null,
      };
    }
    case "canceled":
      return { rung: "muted", lead: "Canceled.", rest: d.cancelReason ? `Reason: ${d.cancelReason}` : null };
    default: {
      if (r.overdueMinutes !== null) return { rung: "warning", lead: `${r.followUpText}: no answer from ${office}.`, rest: `Sent ${at(lastOutboundAt(d), now)} (simulated).` };
      if (d.answer?.markedInsufficient)
        return { rung: "waiting", lead: "Answer marked insufficient.", rest: `Waiting on ${office} for a further answer; ${followUp}.` };
      const word = r.state === "acknowledged" ? `${office} acknowledged it.` : r.state === "delivered" ? "Delivered (simulated)." : `Sent ${at(lastOutboundAt(d), now)} (simulated).`;
      return { rung: "waiting", lead: word, rest: `Waiting on ${office} to answer; ${followUp}.` };
    }
  }
}

function lastOutboundAt(d: ClarificationDetail): string | null {
  for (let i = d.messages.length - 1; i >= 0; i--) if (d.messages[i].direction === "outbound") return d.messages[i].createdAt;
  return null;
}

/** Docked step heading and what it does, for the primary action. */
export function stepCopy(a: ActionView, d: ClarificationDetail, hold: HoldView | null, now: string): { title: string; detail: string } {
  const r = d.row;
  const office = d.office.name;
  switch (a.key) {
    case "send": {
      const to = d.contact.currentRecipient;
      return {
        title: `Send ${r.displayId} to ${office}`,
        detail: `${to ? `Goes to ${to.name}, ${to.role}, by ${to.channelLabel}.` : `No contact on file for ${office}: the notice goes to the office.`} The notice carries no patient details; the question waits in the office's secure case view (a future connector, simulated here).`,
      };
    }
    case "followUp":
      return {
        title: `Send a reminder to ${office}`,
        detail: `No answer since the notice at ${at(lastOutboundAt(d), now)} (simulated). A reminder is a generic notice; no second one within ${d.reminder.suppressionMinutes} min.`,
      };
    case "escalate":
      return {
        title: `Escalate ${r.displayId}`,
        detail: d.contact.escalation
          ? `The last notice did not reach ${office}. A generic notice goes to ${d.contact.escalation.name}, ${d.contact.escalation.role}, and ${d.people.escalationOwner ?? "the accessioning lead"} gets a follow-up task. No real office is contacted.`
          : `No escalation contact is on file for ${office}. ${d.people.escalationOwner ?? "The accessioning lead"} gets a follow-up task; phone the office per local policy.`,
      };
    case "recordDelivery":
      return {
        title: `Confirm delivery with ${office}`,
        detail: "The simulated connector did not confirm delivery. Phone the office per local policy, then record what you learned here.",
      };
    case "recordAnswer":
      return {
        title: `Record the answer from ${office}`,
        detail: "Type the answer in the conversation exactly as given, and who gave it. Recording an answer never resolves the question.",
      };
    case "review":
      return {
        title: `Review the answer from ${office}`,
        detail: "Read the answer against the question and the evidence, write what you checked in the review note under the answer, then mark it reviewed. Mark it insufficient to send it back to the office.",
      };
    case "resolve":
      return {
        title: `Resolve ${r.displayId}`,
        detail: `Answer reviewed by ${d.review?.byName ?? "Unknown"}. Resolving closes the question; it does not release a hold by itself.`,
      };
    case "releaseHold":
      return hold
        ? { title: `Release ${hold.displayId} on ${hold.scopeShort}`, detail: `${hold.scopeText} A release needs a reason and is recorded in History.` }
        : { title: "Release the hold", detail: "A release needs a reason and is recorded in History." };
    default:
      return { title: a.label, detail: "" };
  }
}

/** Who acts next on this question, in words (the decision column's "Waiting on"). */
export function waitingOn(d: ClarificationDetail, now: string): { who: string; what: string }[] {
  const r = d.row;
  const lead = leadName(r);
  const held = d.holds.filter((h) => h.status === "active");
  switch (r.state) {
    case "drafted":
      return [{ who: r.labOwnerName, what: `to send ${r.displayId}` }];
    case "answered":
      return [{ who: lead, what: "to review the answer" }];
    case "reviewed":
      return [{ who: lead, what: `to resolve ${r.displayId}` }];
    case "resolved":
    case "canceled":
      return held.map((h) => ({ who: lead, what: `to release ${h.displayId} with a reason` }));
    default: {
      const when = r.overdueMinutes !== null ? `${lower(r.followUpText)}` : r.nextFollowUpAt ? `next follow-up ${at(r.nextFollowUpAt, now)}` : "no follow-up time set";
      return [
        { who: d.office.name, what: r.state === "delivery_failed" ? "has not received the notice (delivery failed)" : "to answer" },
        { who: r.labOwnerName, what: `to follow up (${when})` },
      ];
    }
  }
}
