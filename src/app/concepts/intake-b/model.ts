/**
 * Concept B ("Specimen atlas"): pure derivations from the real intake read
 * model. Nothing here writes; nothing here invents a value. Every sentence is
 * assembled from fields of IntakeBench / ItemDetail. Unknown stays "Unknown".
 */
import type { ContainerView, HoldView, IntakeBench, ItemDetail, OrderPartView, OrderView, RelatedView } from "@/server/queries/intake";
import { CLARIFICATION_CATEGORY, CLARIFICATION_STATE, RELATED_STATUS, ROUTING_STATUS } from "@/lib/domain";

export type NodeKey = string;

export interface AtlasData {
  bench: IntakeBench;
  /** Detail for each intake item linked to the selected one by a related-order candidate. */
  siblings: ItemDetail[];
}

/* ----------------------------------------------------------------- small helpers */

export const HOLD_BLOCK_LABEL: Record<string, string> = {
  gross_approval: "gross approval",
  processing: "processing",
  print: "label printing",
  tray_delivery: "tray delivery",
  accession_request: "accession request",
  all: "all downstream work",
};

export const HOLD_BLOCK_SHORT: Record<string, string> = {
  gross_approval: "gross approval",
  processing: "processing",
  print: "labels",
  tray_delivery: "tray",
  accession_request: "accession",
  all: "all downstream work",
};

export function listText(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function clarState(state: string): string {
  return (CLARIFICATION_STATE as Record<string, string>)[state] ?? state;
}
export function clarCategory(cat: string): string {
  return (CLARIFICATION_CATEGORY as Record<string, string>)[cat] ?? cat;
}
export function relatedState(s: string): string {
  return (RELATED_STATUS as Record<string, string>)[s] ?? s;
}
export function routingState(s: string): string {
  return (ROUTING_STATUS as Record<string, string>)[s] ?? s;
}

export function holdBlocksText(h: HoldView): string {
  return listText(h.blocks.map((b) => HOLD_BLOCK_LABEL[b] ?? b.replace(/_/g, " ")));
}

/** Short scope phrase for a hold, e.g. "Part B only". */
export function holdScopeShort(h: HoldView): string {
  if (h.scopeType === "order_part") {
    const m = /^Part\s+([A-Z])/.exec(h.scopeLabel);
    return m ? `Part ${m[1]} only` : `${h.scopeLabel} only`;
  }
  if (h.scopeType === "intake_item") return "whole intake item";
  return h.scopeLabel;
}

export const DOCTOR_SWATCH: Record<string, string> = {
  teal: "#0f7f79",
  violet: "#6a4fa6",
  amber: "#a8740c",
};

/* ----------------------------------------------------------------- items & parts */

export interface PartRef {
  item: ItemDetail;
  order: OrderView;
  part: OrderPartView;
  containers: ContainerView[];
  holds: HoldView[];
  missing: boolean;
}

export function partsOf(item: ItemDetail): PartRef[] {
  const out: PartRef[] = [];
  for (const order of item.orders) {
    for (const part of order.parts) {
      const containers = item.containers.filter((c) => c.orderPartId === part.id);
      const holds = item.holds.filter(
        (h) => (h.scopeType === "order_part" && h.scopeLabel.includes(`${order.sourceOrderId}`) && h.scopeLabel.includes(`· ${part.designation}`)) || h.scopeType === "intake_item",
      );
      out.push({
        item,
        order,
        part,
        containers,
        holds,
        missing: item.missingParts.some((m) => m.orderPartId === part.id),
      });
    }
  }
  return out;
}

export function differingRows(c: ContainerView) {
  return c.comparison.filter((r) => r.status === "differs");
}

export function partHasDifference(p: PartRef): boolean {
  return p.containers.some((c) => differingRows(c).length > 0);
}

/** Open clarifications that touch a part (or its containers). */
export function clarificationsFor(p: PartRef) {
  const cids = new Set(p.containers.map((c) => c.id));
  return p.item.clarifications.filter(
    (q) => q.state !== "resolved" && q.state !== "canceled" && (q.orderPartId === p.part.id || (q.containerId && cids.has(q.containerId)) || (!q.orderPartId && !q.containerId)),
  );
}

/* ----------------------------------------------------------------- headline + finding */

function quote(s: string | null | undefined): string {
  return s ? `“${s}”` : "nothing";
}

/** The pale second line of the identity headline: what the part is, or the open question. */
export function partQuestion(p: PartRef): string {
  if (p.missing && p.containers.length === 0) return `No container arrived for part ${p.part.designation}`;
  const c = p.containers[0];
  const diff = c ? differingRows(c)[0] : undefined;
  if (diff) {
    if (diff.field === "laterality") {
      const site = c!.comparison.find((r) => r.field === "site");
      const core = site?.order.normalized ?? site?.observed.normalized ?? "";
      const a = diff.order.normalized ?? diff.requisition.normalized;
      const b = diff.observed.normalized;
      if (a && b) return `${cap(a)} or ${b} ${core}?`.replace(/\s+\?$/, "?");
    }
    const a = diff.order.original ?? diff.requisition.original ?? "Unknown";
    const b = diff.observed.original ?? "Unknown";
    const lead: Record<string, string> = { birth_date: "Born ", mrn: "MRN ", part_designation: "Part ", collection_date: "Collected " };
    return `${lead[diff.field] ?? ""}${diff.field === "procedure" ? cap(a) : a} or ${b}?`;
  }
  const proc = p.part.procedure ? `, ${p.part.procedure}` : "";
  return `${p.part.siteText}${proc}`;
}

export interface Finding {
  sentence: string;
  /** A quieter follow-up line: who recorded it and what was kept. */
  context: string | null;
  tone: "differs" | "missing" | "exception" | "pending" | "clear";
}

export function notComparedNote(c: ContainerView | undefined): string {
  if (!c) return "";
  const nc = c.comparison
    .filter((r) => r.status === "not_compared")
    .map((r, i) => {
      const l = r.label.replace(/ and tenant$/, "");
      return i === 0 || /^[A-Z]{2,}/.test(l) ? l : l[0].toLowerCase() + l.slice(1);
    });
  if (!nc.length) return "";
  return ` ${listText(nc)} ${nc.length > 1 ? "are" : "is"} not compared: only one source states ${nc.length > 1 ? "them" : "it"}.`;
}

export function findingFor(p: PartRef): Finding {
  const finding = findingCore(p);
  if ((finding.tone === "pending" || finding.tone === "clear") && p.containers[0]) {
    const extra = notComparedNote(p.containers[0]).trim();
    if (extra) finding.context = finding.context ? `${finding.context} ${extra}` : extra;
  }
  return finding;
}

function findingCore(p: PartRef): Finding {
  const item = p.item;
  const c = p.containers[0];
  const diffs = c ? differingRows(c) : [];
  const req = item.requisition;
  if (diffs.length) {
    const d = diffs[0];
    const siteStyle = d.field === "laterality" || d.field === "site";
    const siteRow = c!.comparison.find((r) => r.field === "site");
    const pick = (cell: "order" | "observed" | "requisition") => (siteStyle ? siteRow?.[cell].original ?? d[cell].original : d[cell].original);
    const bottle = pick("observed");
    const order = pick("order");
    const reqv = pick("requisition");
    let sentence = siteStyle ? `The bottle says ${quote(bottle)}. ` : `The bottle's ${d.label.toLowerCase()} reads ${quote(bottle)}. `;
    if (order && reqv && (siteStyle ? d.order.normalized === d.requisition.normalized : order === reqv)) sentence += `The order and the paper requisition both say ${quote(order)}.`;
    else {
      sentence += `The order says ${quote(order)}`;
      sentence += reqv ? ` and the requisition says ${quote(reqv)}.` : req ? "; the requisition does not state it." : "; no requisition was received.";
    }
    if (diffs.length > 1) sentence += ` ${diffs.length - 1} more field${diffs.length > 2 ? "s" : ""} also differ${diffs.length > 2 ? "" : "s"}.`;
    const who = c!.verifiedByName ? `${c!.verifiedByName} checked the bottle at ${timeShort(c!.verifiedAt)} and recorded the difference.` : "The difference is recorded.";
    return { sentence, context: `${who} Both values are kept; nothing is corrected automatically.`, tone: "differs" };
  }
  if (p.missing && p.containers.length === 0) {
    const del = item.delivery?.displayId ?? "this delivery";
    return {
      sentence: `Order ${p.order.sourceOrderId} expects part ${p.part.designation}, ${p.part.siteText.toLowerCase()}. No container for it arrived in courier ${del}.`,
      context: "The other parts can continue under local policy. A missing-container question goes to the office.",
      tone: "missing",
    };
  }
  if (item.routing?.status === "exception") {
    return {
      sentence: `${item.office?.name ?? item.observedOfficeText ?? "This office"} is not in the routing directory, so no dermatopathologist is suggested.`,
      context: "An accessioning lead or supervisor assigns one, with a reason. Nothing is guessed.",
      tone: "exception",
    };
  }
  if (c && c.verificationState === "unverified") {
    return {
      sentence: "Not yet checked against the physical container.",
      context: "The fields compared so far agree. A scan only finds the record; it does not show what is in the bottle.",
      tone: "pending",
    };
  }
  const pending = item.related.find((r) => r.status === "pending_review" || r.status === "escalated_to_office");
  if (pending) {
    const who = c?.verifiedByName ? ` and ${c.verifiedByName} verified the bottle` : "";
    return {
      sentence: `Every compared field agrees${who}. Accession waits for the review of possible related orders ${pending.displayId}.`,
      context: `The review belongs to ${reviewOwner(item, pending) ?? "the accessioning lead"}; ${pending.status === "escalated_to_office" ? "the office was asked." : "no decision is recorded yet."}`,
      tone: "pending",
    };
  }
  if (item.readiness.ready) return { sentence: "Everything compared agrees and the bottle is staff verified. Ready to request accession.", context: null, tone: "clear" };
  const first = item.readiness.blockers[0];
  return { sentence: first ? first.message : "No open findings on this part.", context: null, tone: first ? "pending" : "clear" };
}

export function timeShort(iso: string | null | undefined): string {
  if (!iso) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " ET";
}

export function reviewOwner(item: ItemDetail, r: RelatedView): string | null {
  const t = item.tasks.find((t) => t.kind === "related_order_review" && t.title.includes(r.displayId));
  return t?.ownerName ?? null;
}

/* ----------------------------------------------------------------- open items (short list, ids right-aligned) */

export interface OpenLine {
  key: string;
  text: string;
  id: string | null;
  note: string | null;
  tone: "differs" | "hold" | "pending" | "missing" | "exception";
}

export function openLinesFor(item: ItemDetail, siblings: ItemDetail[]): OpenLine[] {
  const out: OpenLine[] = [];
  for (const q of item.clarifications.filter((q) => q.state !== "resolved" && q.state !== "canceled")) {
    out.push({
      key: q.id,
      text: `${clarCategory(q.category)} question for the office`,
      id: q.displayId,
      note: `${clarState(q.state)}${q.state === "drafted" ? ", not sent" : ""}${q.ownerName && q.state !== "drafted" ? `. Owner ${q.ownerName}` : ""}`,
      tone: "differs",
    });
  }
  for (const h of item.holds) {
    const others = siblings.flatMap((s) => s.orders.flatMap((o) => o.parts.map((p) => `Part ${p.designation}`)));
    const free = h.scopeType === "order_part" && others.length ? `. ${listText(others)} can continue` : "";
    out.push({
      key: h.id,
      text: `Hold on ${holdScopeShort(h)}${free}`,
      id: h.displayId,
      note: (() => {
        const rest = h.blocks.filter((b) => b !== "accession_request").map((b) => HOLD_BLOCK_SHORT[b] ?? b.replace(/_/g, " "));
        return `${h.blocksAccession ? "Blocks accession" : "Not accession"}${rest.length ? `. Holds ${listText(rest)}` : ""}`;
      })(),
      tone: "hold",
    });
  }
  for (const r of item.related.filter((r) => r.status === "pending_review" || r.status === "escalated_to_office")) {
    const owner = reviewOwner(item, r);
    out.push({
      key: r.id,
      text: r.status === "pending_review" ? "Possible related orders, lead's review" : "Related orders, office asked",
      id: r.displayId,
      note: `${owner ? `${owner} reviews` : relatedState(r.status)}. Accession waits`,
      tone: "pending",
    });
  }
  for (const m of item.missingParts) {
    out.push({ key: m.discrepancyId, text: `No container for part ${m.designation}`, id: m.orderRef, note: m.clarification ? `${m.clarification.displayId} ${clarState(m.clarification.state)}` : "No question raised yet", tone: "missing" });
  }
  if (item.routing?.status === "exception") out.push({ key: "routing", text: "No approved routing rule for this office", id: null, note: "A lead assigns a dermatopathologist, with a reason", tone: "exception" });
  return out;
}

/* ----------------------------------------------------------------- next step */

export interface NextStep {
  primary: { label: string; detail: string | null } | null;
  owner: string | null;
  ownerNote: string | null;
  accession: { allowed: boolean; reason: string | null };
}

export function nextStepFor(item: ItemDetail, bench: IntakeBench): NextStep {
  const me = bench.actor.name;
  const officeName = item.office?.name ?? item.observedOfficeText ?? "the office";
  let primary: NextStep["primary"] = null;
  const drafted = item.clarifications.find((q) => q.state === "drafted");
  const unverified = item.containers.find((c) => c.verificationState === "unverified");
  if (drafted && (drafted.ownerName === me || bench.permissions.raiseClarification)) {
    primary = { label: `Send ${drafted.displayId} to ${officeName} (simulated)`, detail: drafted.nextFollowUpAt ? `Drafted, not sent. Follow up by ${timeShort(drafted.nextFollowUpAt)}.` : "Drafted, not sent." };
  } else if (item.missingParts.some((m) => !m.clarification) && bench.permissions.raiseClarification) {
    const m = item.missingParts.find((x) => !x.clarification)!;
    primary = { label: `Raise a missing-container question for part ${m.designation}`, detail: `${m.orderRef} expects ${m.expected ?? "Unknown"} container${m.expected === 1 ? "" : "s"} for part ${m.designation}; ${m.received} arrived.` };
  } else if (unverified && bench.permissions.verify) {
    primary = { label: `Check container ${unverified.seq} against the physical bottle`, detail: "Record what you see. A scan alone does not count." };
  } else if (item.routing?.status === "suggested" && bench.permissions.confirmRouting) {
    primary = { label: `Accept routing to ${item.routing.suggested?.name ?? "Unknown"}`, detail: item.routing.explanation };
  } else if (item.readiness.ready && bench.permissions.requestAccession) {
    primary = { label: "Request accession (simulated source)", detail: "The accession number is issued by EMA-SIM (simulated)." };
  }
  const othersTask = item.tasks.find((t) => t.ownerName && t.ownerName !== me);
  const relTask = othersTask?.kind === "related_order_review" ? item.related.find((r) => othersTask.title.includes(r.displayId)) : undefined;
  const accReason = item.readiness.ready ? null : (item.readiness.blockers[0]?.message ?? (item.status === "accessioned" ? "Already accessioned" : "Not ready"));
  return {
    primary,
    owner: othersTask?.ownerName ?? null,
    ownerNote: othersTask ? (relTask ? `${othersTask.ownerName} reviews possible related orders ${relTask.displayId}; the decision is the lead's.` : othersTask.title) : null,
    accession: { allowed: item.readiness.ready && bench.permissions.requestAccession, reason: accReason },
  };
}

/* ----------------------------------------------------------------- downstream sequence (progress by tone) */

export type StepState = "done" | "flagged" | "current" | "blocked" | "held" | "future";
export interface Step {
  key: string;
  label: string;
  state: StepState;
  note: string | null;
}

export function sequenceFor(p: PartRef): Step[] {
  const item = p.item;
  const c = p.containers[0];
  const steps: Step[] = [];
  const heldFor = (code: string) => p.holds.find((h) => h.blocks.includes(code) || h.blocks.includes("all"));
  steps.push({ key: "received", label: "Received", state: c ? "done" : "blocked", note: c ? timeShort(item.receivedAt) : "No container" });
  let checked: StepState = "current";
  let checkedNote: string | null = "Not yet checked";
  if (!c) {
    checked = "future";
    checkedNote = null;
  } else if (c.verificationState === "verified") {
    checked = "done";
    checkedNote = `Staff verified, ${c.verifiedByName ?? "Unknown"}`;
  } else if (c.verificationState === "discrepancy") {
    checked = "flagged";
    checkedNote = `${differingRows(c).map((r) => r.label).join(", ") || "Discrepancy"} differs`;
  }
  steps.push({ key: "checked", label: "Checked against bottle", state: checked, note: checkedNote });
  const r = item.routing;
  steps.push({
    key: "routed",
    label: "Routed",
    state: !r ? "future" : r.status === "confirmed" || r.status === "overridden" ? "done" : r.status === "exception" ? "blocked" : "current",
    note: !r ? null : r.status === "exception" ? "No rule" : (r.final ?? r.suggested)?.name ?? null,
  });
  const rel = item.related[0];
  if (rel) {
    const pending = rel.status === "pending_review" || rel.status === "escalated_to_office";
    steps.push({ key: "related", label: "Related-order review", state: pending ? "current" : "done", note: pending ? `${rel.displayId} waiting` : relatedState(rel.status) });
  }
  const accHeld = heldFor("accession_request");
  const accessioned = !!item.accession;
  steps.push({
    key: "accession",
    label: "Accession",
    state: accessioned ? "done" : accHeld ? "held" : item.readiness.ready ? "current" : "blocked",
    note: accessioned ? item.accession!.number : accHeld ? accHeld.displayId : item.readiness.ready ? "Ready to request" : "Not requested",
  });
  for (const [code, label] of [
    ["gross_approval", "Gross approval"],
    ["processing", "Processing"],
    ["print", "Labels"],
    ["tray_delivery", "Tray delivery"],
  ] as const) {
    const h = heldFor(code);
    steps.push({ key: code, label, state: h ? "held" : "future", note: h ? h.displayId : null });
  }
  return steps;
}
