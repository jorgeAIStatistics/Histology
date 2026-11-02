/**
 * Intake workstation plan: pure derivations from the intake read model (no I/O,
 * no writes, nothing written for one fixture item). The server query calls
 * `buildPlan()` for the item on screen and the person acting, so the screen can
 * say, in plain words:
 *   - the current finding and what the accession waits on (two tones),
 *   - the hold scope for every part of the submission (this item and its
 *     possibly related items),
 *   - the five-step path to accession, each step with its owner and blocker,
 *   - "your next step" for THIS actor, the other things they can do now, and
 *     who else is being waited on,
 *   - the accession request's state and its precise reason.
 * Identifiers are kept apart as `{ id }` segments so the client sets them in mono.
 */
import type { Blocker } from "@/server/domain/accession";
import type { BenchPermissions, ContainerView, ItemDetail, QueueItem, SiblingView, SourceConflictView } from "@/server/queries/intake";
import { OPEN_CLARIFICATION_STATES, RELATED_STATUS } from "@/lib/domain";
import { fmtTime } from "@/lib/time";

// ------------------------------------------------------------------ text helpers

/** A run of text where identifiers are kept apart so they can be set in mono. */
export type Seg = string | { id: string };

const ID_RE = /\b((?:INT|ORD|CLR|REL|AR|CR|ENC|REQ-SIM-ORD|H|D\d{2})-\d[0-9A-Z-]*)/g;

/** Split free text into segments, marking identifiers (INT-, ORD-, CLR-, REL-, H-, D26-...) for mono. */
export function segs(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(ID_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push({ id: m[1] });
    last = i + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Plain text of segments (tests, aria labels). */
export function segText(s: Seg[]): string {
  return s.map((x) => (typeof x === "string" ? x : x.id)).join("");
}

export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Words for the steps a hold stops (shared with the clarification dialog). */
export const HOLD_BLOCK_WORDS: Record<string, string> = {
  accession_request: "accession request",
  routing_confirm: "routing confirmation",
  gross_approval: "gross approval",
  processing: "processing",
  sectioning: "sectioning",
  print: "label printing",
  tray_delivery: "tray delivery",
  all: "every step",
};

const IDENTITY = new Set(["patient_name", "birth_date", "mrn"]);
const SHORT_FIELD: Record<string, string> = {
  patient_name: "patient name",
  birth_date: "date of birth",
  mrn: "MRN",
  site: "site",
  laterality: "laterality",
  procedure: "procedure",
  part_designation: "part designation",
  collection_date: "collection date",
};
const OPEN_CLR = new Set<string>(OPEN_CLARIFICATION_STATES);

// ------------------------------------------------------------------ queue

export type Severity = "danger" | "warning" | "hold" | "waiting" | "neutral";

export interface QueueFlag {
  kind: "identity" | "differs" | "count" | "link" | "office" | "source" | "routing" | "hold" | "related" | "asked_office" | "other";
  severity: Severity;
  text: string;
  id: string | null;
}

const RANK: Record<Severity, number> = { danger: 0, warning: 1, hold: 2, waiting: 3, neutral: 4 };

/**
 * Lane reasons as flags ranked by the severity ladder: patient identity (danger),
 * a field or count that differs between sources (warning), holds (hatched ink),
 * then waiting on someone (neutral, with the owner's name). A routing exception
 * is not a disagreement between sources: it waits for a person to assign a
 * dermatopathologist, so it sits on the neutral rung with that person named.
 */
export function queueFlags(
  reasons: string[],
  related: { displayId: string; ownerName: string | null } | null = null,
  routingOwnerName: string | null = null,
): QueueFlag[] {
  const out: QueueFlag[] = [];
  for (const r of reasons) {
    const hold = /^Hold (\S+)$/.exec(r);
    if (r === "Identity conflict") out.push({ kind: "identity", severity: "danger", text: "Patient identity differs", id: null });
    else if (r.startsWith("Discrepancy: ")) {
      const fields = r.slice("Discrepancy: ".length);
      out.push({ kind: "differs", severity: "warning", text: `${cap(fields)} ${fields.includes(",") ? "differ" : "differs"}`, id: null });
    } else if (r === "Discrepancy recorded") out.push({ kind: "differs", severity: "warning", text: r, id: null });
    else if (r === "Missing container" || r === "Extra container") out.push({ kind: "count", severity: "warning", text: r, id: null });
    else if (r === "Container not matched to a part" || r === "No order linked") out.push({ kind: "link", severity: "warning", text: r, id: null });
    else if (r === "Office not in directory") out.push({ kind: "office", severity: "warning", text: r, id: null });
    else if (r === "Source conflict") out.push({ kind: "source", severity: "warning", text: "Source conflict", id: null });
    else if (r === "Routing exception") out.push({ kind: "routing", severity: "waiting", text: routingOwnerName ? `Needs routing · ${routingOwnerName}` : "Needs routing", id: null });
    else if (hold) out.push({ kind: "hold", severity: "hold", text: "Hold", id: hold[1] });
    else if (r === "Related orders: needs review")
      out.push({ kind: "related", severity: "waiting", text: related?.ownerName ? `Waits for ${related.ownerName}` : "Related orders review", id: related?.displayId ?? null });
    else if (r === "Related orders: asked the office") out.push({ kind: "asked_office", severity: "waiting", text: "Asked the office", id: related?.displayId ?? null });
    else out.push({ kind: "other", severity: "neutral", text: r, id: null });
  }
  return out.map((f, i) => ({ f, i })).sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i).map((x) => x.f);
}

function keepRelatedTogether(rows: QueueItem[]): QueueItem[] {
  const out: QueueItem[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    if (used.has(r.id)) continue;
    out.push(r);
    used.add(r.id);
    if (!r.related) continue;
    for (const o of rows) {
      if (!used.has(o.id) && o.related?.displayId === r.related.displayId) {
        out.push(o);
        used.add(o.id);
      }
    }
  }
  return out;
}

/** The queue as the bench works it: exceptions first, then routine review, then done; members of one related review kept together. */
export function laneGroups(queue: QueueItem[]): { exceptions: QueueItem[]; to_review: QueueItem[]; done: QueueItem[] } {
  return {
    exceptions: keepRelatedTogether(queue.filter((q) => q.lane === "exceptions")),
    to_review: keepRelatedTogether(queue.filter((q) => q.lane === "to_review")),
    done: queue.filter((q) => q.lane === "done"),
  };
}

/** Open items in working order (what J / K and "next item" walk through). */
export function openOrder(queue: QueueItem[]): QueueItem[] {
  const g = laneGroups(queue);
  return [...g.exceptions, ...g.to_review];
}

// ------------------------------------------------------------------ comparison

export type CompareRow = ContainerView["comparison"][number];
export type SourceKey = "order" | "observed" | "requisition";
const SOURCE_WORD: Record<SourceKey, string> = { order: "order", observed: "bottle", requisition: "requisition" };

/** Differing rows first (patient identity first among them), then agreeing rows, then fields only one source states. */
export function orderedRows(rows: CompareRow[]): CompareRow[] {
  const rank = (r: CompareRow) => (r.status === "differs" ? (IDENTITY.has(r.field) ? 0 : 1) : r.status === "match" ? 2 : 3);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** The source(s) that disagree with the majority (none when there is no majority). */
export function oddSources(row: CompareRow): SourceKey[] {
  if (row.status !== "differs") return [];
  const groups = new Map<string, SourceKey[]>();
  for (const k of ["order", "observed", "requisition"] as SourceKey[]) {
    const v = row[k].normalized;
    if (v === null) continue;
    groups.set(v, [...(groups.get(v) ?? []), k]);
  }
  if (groups.size < 2) return [];
  const sorted = [...groups.values()].sort((a, b) => a.length - b.length);
  return sorted[0].length < sorted[sorted.length - 1].length ? sorted[0] : [];
}

function spoken(row: CompareRow, key: SourceKey): string {
  const c = row[key];
  if (row.field === "laterality" || row.field === "procedure") return c.normalized ?? "nothing";
  return c.original ? `“${c.original}”` : "nothing";
}

/** One plain sentence for a differing comparison row: "Laterality differs: the bottle says left; the order and the requisition say right." */
export function differSentence(row: CompareRow): string {
  const keys: SourceKey[] = ["order", "observed", "requisition"];
  const groups = new Map<string, SourceKey[]>();
  for (const k of keys) {
    const v = row[k].normalized;
    if (v === null) continue;
    groups.set(v, [...(groups.get(v) ?? []), k]);
  }
  const label = cap(SHORT_FIELD[row.field] ?? row.label.toLowerCase());
  if (groups.size < 2) return `${label} differs between the sources.`;
  const g = [...groups.values()].sort((a, b) => a.length - b.length);
  if (g.length === 2 && g[0].length === 1 && g[1].length === 2) {
    const odd = g[0][0];
    const [m1, m2] = g[1];
    return `${label} differs: the ${SOURCE_WORD[odd]} says ${spoken(row, odd)}; the ${SOURCE_WORD[m1]} and the ${SOURCE_WORD[m2]} say ${spoken(row, m1)}.`;
  }
  if (g.length === 2) {
    const a = g[0][0];
    const b = g[1][0];
    return `${label} differs: the ${SOURCE_WORD[a]} says ${spoken(row, a)}; the ${SOURCE_WORD[b]} says ${spoken(row, b)}.`;
  }
  return `${label} differs across all three sources.`;
}

type Clar = ItemDetail["clarifications"][number];

function openFirst(list: Clar[]): Clar | null {
  return list.find((q) => q.state !== "resolved") ?? list[0] ?? null;
}

/** The clarification that covers a differing row (identity questions cover the whole item). Null = nobody has asked yet. */
export function coveringClarification(item: ItemDetail, c: ContainerView, row: CompareRow): Clar | null {
  const live = item.clarifications.filter((q) => q.state !== "canceled");
  if (IDENTITY.has(row.field)) return openFirst(live.filter((q) => q.category === "identity_conflict"));
  return openFirst(live.filter((q) => q.category !== "identity_conflict" && (q.containerId === c.id || (!!c.orderPartId && q.orderPartId === c.orderPartId))));
}

/** "Drafted, not sent" — never let a drafted question read as asked. */
export function clarificationWords(state: string): string {
  switch (state) {
    case "drafted":
      return "drafted, not sent";
    case "sent":
      return "sent (simulated)";
    case "delivered":
      return "delivered (simulated), waiting for the office";
    case "delivery_unknown":
      return "delivery unknown";
    case "delivery_failed":
      return "delivery failed";
    case "acknowledged":
      return "acknowledged, waiting for the answer";
    case "answered":
      return "answered, waiting for a lead's review";
    case "reviewed":
      return "answer reviewed, not resolved";
    case "resolved":
      return "resolved";
    default:
      return state.replace(/_/g, " ");
  }
}

// ------------------------------------------------------------------ parts and holds

/** Part letters on this item (containers first, else the order's parts). */
export function partsOf(item: ItemDetail): string[] {
  const list = [...new Set(item.containers.map((c) => c.designation).filter((d): d is string => !!d))].sort();
  if (list.length) return list;
  return [...new Set(item.orders.flatMap((o) => o.parts.map((p) => p.designation)))].sort();
}

interface HoldLike {
  displayId: string;
  scopeType: string;
  scopeLabel: string;
  blocks: string[];
  blocksAccession: boolean;
}

function holdScopeWords(h: HoldLike, itemDisplay: string): string {
  if (h.scopeType === "order_part" || h.scopeType === "specimen_part") return `${h.scopeLabel.split(" (")[0]} only`;
  if (h.scopeType === "intake_item") return /all containers/.test(h.scopeLabel) ? `all containers of ${itemDisplay}` : h.scopeLabel;
  return h.scopeLabel;
}

function heldParts(h: HoldLike, memberParts: string[]): string[] {
  if (h.scopeType === "order_part" || h.scopeType === "specimen_part") {
    const m = /^Part (\w+)/.exec(h.scopeLabel);
    return m ? [m[1]] : [];
  }
  if (h.scopeType === "intake_item" || h.scopeType === "accession") return memberParts;
  return [];
}

/** The scope a hold chip names in a few words: "Part B", "all containers", "INT-1014-032". */
function holdChipScope(h: HoldLike, memberDisplay: string, itemDisplay: string): string {
  if (h.scopeType === "order_part" || h.scopeType === "specimen_part") return h.scopeLabel.split(" (")[0];
  if (h.scopeType === "intake_item") return memberDisplay === itemDisplay ? (/all containers/.test(h.scopeLabel) ? "all containers" : h.scopeLabel.split(" (")[0]) : memberDisplay;
  if (h.scopeType === "accession") return "the whole case";
  return h.scopeLabel;
}

export interface HoldLine {
  held: boolean;
  /** The whole line as one plain sentence (screen-reader text, tests): "Hold H-0090 applies to Part B only: ... Part A can continue." */
  text: Seg[];
  /** One chip per hold (hatched ink on screen): its id, the scope in a few words, and what it stops. */
  holds: { id: string; scope: string; effect: Seg[] }[];
  /** What is free to continue ("Part A can continue."), or "No holds on ..." when nothing is held. */
  tail: Seg[];
}

/**
 * The hold scope for every part of the submission (this item and its possibly
 * related items): "Hold H-0090 applies to Part B only: gross approval,
 * processing, label printing, tray delivery. Accession is not held. Part A can continue."
 * On screen each hold leads as a chip ("Hold H-0090 · Part B") followed by what it stops.
 */
export function holdLine(item: ItemDetail, siblings: SiblingView[]): HoldLine {
  const members = [
    { displayId: item.displayId, parts: partsOf(item), holds: item.holds as HoldLike[] },
    ...siblings.map((s) => ({ displayId: s.displayId, parts: s.part ? [s.part] : [], holds: s.holds as HoldLike[] })),
  ];
  const seen = new Set<string>();
  const sentences: string[] = [];
  const chips: HoldLine["holds"] = [];
  const held = new Set<string>();
  for (const m of members) {
    for (const h of m.holds) {
      for (const p of heldParts(h, m.parts)) held.add(p);
      if (seen.has(h.displayId)) continue;
      seen.add(h.displayId);
      const words = h.blocks.map((b) => HOLD_BLOCK_WORDS[b] ?? b.replace(/_/g, " "));
      const notAccession = h.blocksAccession ? "" : " Accession is not held.";
      sentences.push(`Hold ${h.displayId} applies to ${holdScopeWords(h, m.displayId)}: ${words.join(", ")}.${notAccession}`);
      const stops = words.includes("every step") ? "every step" : joinWords(words.map((w) => (w === "accession request" ? "the accession request" : w)));
      chips.push({ id: h.displayId, scope: holdChipScope(h, m.displayId, item.displayId), effect: segs(`Stops ${stops}.${notAccession}`) });
    }
  }
  const allParts = [...new Set(members.flatMap((m) => m.parts))].sort();
  if (!sentences.length) {
    const text = segs(allParts.length > 1 ? `No holds on ${joinWords(allParts.map((p) => `Part ${p}`))}.` : "No holds on this item.");
    return { held: false, text, holds: [], tail: text };
  }
  const free = allParts.filter((p) => !held.has(p));
  const tail = free.length ? `${joinWords(free.map((p) => `Part ${p}`))} can continue.` : "";
  if (tail) sentences.push(tail);
  return { held: true, text: segs(sentences.join(" ")), holds: chips, tail: segs(tail) };
}

// ------------------------------------------------------------------ accession

export interface AccessionPlan {
  state: "issued" | "ready" | "blocked" | "offline" | "not_allowed" | "closed";
  label: string;
  ids: string[];
  candidateId: string | null;
  /** One precise sentence: why it cannot be requested, or that it can. */
  reason: Seg[];
  /** Every blocker in full (for "Show all"). */
  blockers: Seg[][];
  /** "Hold H-0090 does not block it." when a hold is present but does not stop the request. */
  holdNote: Seg[] | null;
  /** Items approved as one accession are requested together. */
  groupNote: Seg[] | null;
  /** A submitted request that the source has not answered yet. */
  pendingNote: Seg[] | null;
}

function relOwner(item: ItemDetail): string | null {
  return item.tasks.find((t) => t.kind === "related_order_review")?.ownerName ?? null;
}

function containerWhere(b: Blocker, item: ItemDetail): string {
  const m = /container (\d+)(?: \(([^)]+)\))?/.exec(b.message);
  const own = (b.itemDisplay ?? item.displayId) === item.displayId;
  if (own && item.containers.length === 1) return "the bottle";
  return m ? `${own ? "" : `${b.itemDisplay} `}container ${m[1]}${m[2] ? ` (${m[2]})` : ""}` : own ? "the bottle" : `${b.itemDisplay}`;
}

/**
 * What the accession waits for, in a few words and with the owner's name when
 * there is one ("Kim Nguyen's review of REL-0112", "your review of REL-0112").
 * Lower-case so it reads after "waits for".
 */
export function waitPhrase(b: Blocker, item: ItemDetail, actorName: string | null = null): string {
  const mine = (owner: string | null) => (owner && owner === actorName ? "your" : owner ? `${owner}'s` : "a lead's");
  switch (b.code) {
    case "related_pending": {
      const rel = /REL-\d+/.exec(b.message)?.[0] ?? "the related orders";
      return /escalated/.test(b.message) ? `the office's answer about ${rel}` : `${mine(relOwner(item))} review of ${rel}`;
    }
    case "container_unverified":
      return containerWhere(b, item) === "the bottle" ? "a check of the bottle against the order" : `a check of ${containerWhere(b, item)} against its bottle`;
    case "verification_stale":
      return `a new check of ${containerWhere(b, item)} (the order changed)`;
    case "discrepancy_uncovered":
      return "a clarification for the difference";
    case "identity_unresolved":
      return "a lead to resolve the patient identity question";
    case "missing_container":
      return `a missing-container question (${/for (\S+ part \w+)/.exec(b.message)?.[1] ?? "a part"})`;
    case "extra_container":
      return "a decision on the extra container";
    case "unmatched_container":
      return `${containerWhere(b, item)} to be matched to an order part`;
    case "routing_not_confirmed":
      return "routing to be accepted";
    case "routing_exception": {
      const owner = item.tasks.find((t) => t.kind === "routing_exception")?.ownerName ?? null;
      return owner === actorName && owner ? "your assignment of a dermatopathologist" : owner ? `${owner}'s assignment of a dermatopathologist` : "a lead to assign a dermatopathologist";
    }
    case "hold":
      return `hold ${/^(H-\d+)/.exec(b.message)?.[1] ?? ""} to be released`.replace("hold  ", "a hold ");
    case "office_unknown":
      return "the office to be identified";
    case "order_not_linked":
      return "a linked source order";
    case "related_request_together":
      return "the related items to be requested together";
    case "source_conflict_open":
      return `${mine(item.sourceConflicts[0]?.ownerName ?? null)} review of the source conflict`;
    default:
      return b.message.replace(`${item.displayId}: `, "");
  }
}

/** Short words for the step rail ("REL-0112", "identity", "routing", "H-0088", "source conflict"). */
export function waitNoun(b: Pick<Blocker, "code" | "message">): string {
  switch (b.code) {
    case "related_pending":
    case "related_request_together":
    case "related_kept_separate":
      return /REL-\d+/.exec(b.message)?.[0] ?? "related orders";
    case "container_unverified":
    case "verification_stale":
      return "container check";
    case "identity_unresolved":
      return "identity";
    case "discrepancy_uncovered":
    case "unmatched_container":
      return "differences";
    case "missing_container":
    case "extra_container":
      return "container count";
    case "routing_not_confirmed":
    case "routing_exception":
    case "routing_differs":
      return "routing";
    case "hold":
      return /^(H-\d+)/.exec(b.message)?.[1] ?? "hold";
    case "source_conflict_open":
      return "source conflict";
    case "order_not_linked":
      return "order link";
    case "office_unknown":
      return "office";
    case "order_canceled":
      return "canceled order";
    case "pending_request":
      return "pending request";
    case "not_grouped":
    case "different_patients":
      return "grouping";
    case "status":
    case "not_found":
      return "item status";
    default:
      return "a review";
  }
}

/** Distinct "waits for" phrases (one per kind of blocker; container checks counted). */
export function waitPhrases(blockers: Blocker[], item: ItemDetail, actorName: string | null = null): string[] {
  const out: string[] = [];
  const unchecked = blockers.filter((b) => b.code === "container_unverified");
  const seen = new Set<string>();
  for (const b of blockers) {
    if (b.code === "container_unverified" && unchecked.length > 1) {
      if (seen.has(b.code)) continue;
      seen.add(b.code);
      out.push(`checks of ${unchecked.length} containers against the physical bottles`);
      continue;
    }
    const ph = waitPhrase(b, item, actorName);
    if (!out.includes(ph)) out.push(ph);
  }
  return out;
}

function accessionPlan(item: ItemDetail, permissions: BenchPermissions, sourceAvailable: boolean, actorName: string): AccessionPlan {
  if (item.accession) {
    return {
      state: "issued",
      label: "Accession issued",
      ids: [item.id],
      candidateId: null,
      reason: segs(`${item.accession.number} issued by ${item.accession.issuedBy}. Later changes go through a correction review on the case.`),
      blockers: [],
      holdNote: null,
      groupNote: null,
      pendingNote: null,
    };
  }
  const group = item.readiness.group;
  const ids = group ? group.ids : [item.id];
  const blockers = group ? group.blockers : item.readiness.blockers;
  const pending = item.latestRequest?.status === "submitted" ? item.latestRequest : null;
  const label = group
    ? `${pending ? "Retry accession request" : "Request accession"} for ${group.displayIds.join(" + ")} together (simulated source)`
    : `${pending ? `Retry accession request ${pending.displayId}` : "Request accession"} (simulated source)`;
  const groupNote = group
    ? segs(`One accession approved in ${item.related.find((r) => r.id === group.candidateId)?.displayId ?? "the related-order review"}; parts keep their original orders and designations.`)
    : null;
  const pendingNote = pending
    ? segs(`Request ${pending.displayId} was submitted at ${fmtTime(pending.requestedAt)} and nothing was issued${pending.failureDetail ? ` (${pending.failureDetail})` : ""}. Retrying uses the same request; no duplicate is created.`)
    : null;
  const nonBlockingHold = item.holds.find((h) => !h.blocksAccession);
  const holdNote = nonBlockingHold && !item.holds.some((h) => h.blocksAccession) ? segs(`Hold ${nonBlockingHold.displayId} does not block it.`) : null;
  const base = { label, ids, candidateId: group?.candidateId ?? null, groupNote, pendingNote, holdNote };
  if (item.status === "canceled") return { ...base, state: "closed", reason: segs("This intake item was canceled."), blockers: [] };
  if (!permissions.requestAccession) {
    return { ...base, state: "not_allowed", reason: segs("Your demo role cannot request an accession. Accessioners, the accessioning lead and supervisors can."), blockers: blockers.map((b) => segs(b.message)) };
  }
  if (!sourceAvailable) {
    return {
      ...base,
      state: "offline",
      reason: segs("Source system unreachable (simulated outage). Your verification is saved locally. Request the accession when the source is back."),
      blockers: blockers.map((b) => segs(b.message)),
    };
  }
  if (!blockers.length) {
    return { ...base, state: "ready", reason: segs("Ready: every check passed. The number is issued by the simulated source, never typed here."), blockers: [] };
  }
  const phrases = waitPhrases(blockers, item, actorName);
  const shown = phrases.slice(0, 3);
  return {
    ...base,
    state: "blocked",
    reason: segs(`Cannot request yet: waits for ${joinWords(shown)}${phrases.length > 3 ? ` (and ${phrases.length - 3} more)` : ""}.`),
    blockers: blockers.map((b) => segs(b.message)),
  };
}

// ------------------------------------------------------------------ work items (who does what next)

export type NextAction =
  | { kind: "verify"; containerId: string; seq: number; version: number; orderPartId: string | null; needsPart: boolean; stale: boolean; designation: string | null; orderRef: string | null; total: number }
  | { kind: "raise"; containerId: string; field: string; fieldLabel: string }
  | { kind: "raise_missing"; orderPartId: string; orderRef: string; designation: string }
  | { kind: "send"; clarificationId: string; displayId: string; version: number; officeName: string; question: string; category: string; followUpAt: string | null; notice: string }
  | { kind: "open_clarification"; displayId: string; label: string }
  | { kind: "review_related"; candidateId: string; displayId: string; version: number; members: string[]; duplicateRecordKind: boolean }
  | { kind: "review_source_conflict"; taskId: string; version: number; about: "patient" | "order"; conflict: string; detail: string | null; orderRefs: string[] }
  | { kind: "resolve_routing" }
  | { kind: "accept_routing"; doctorName: string; doctorColor: string | null; ruleSetVersion: number | null }
  | { kind: "request" };

export interface WorkItem {
  key: string;
  action: NextAction | null;
  /** Person (or office/system) this waits on; null = anyone at the bench with the permission. */
  owner: string | null;
  /** Who may do it when nobody is named ("An accessioner", "Accessioning lead"). */
  ownerRole: string | null;
  actorCan: boolean;
  /** Ctrl/Cmd+Enter may run it. Never true for the container check (an attestation is always a deliberate click). */
  ctrlEnter: boolean;
  title: Seg[];
  detail: Seg[];
  /** What others read under "Waiting on <owner> to ...", when the title alone does not say why. */
  waitText?: Seg[];
}

export type StepKey = "check" | "differences" | "related" | "routing" | "accession";
export type StepState = "done" | "mine" | "waiting" | "todo" | "blocked" | "none";
export type StepTone = "done" | "ink" | "danger" | "warning" | "neutral";

export interface PathStep {
  key: StepKey;
  label: string;
  state: StepState;
  tone: StepTone;
  /** One line under the label: the state, the owner or the blocker, in full (accessible name, tests). */
  status: Seg[];
  /** The same in a few words for the rail ("CLR-0457 · not sent"); never more than two short lines at 1366. */
  short: Seg[];
  owner: string | null;
  /** The container was checked against an older order version. */
  stale: boolean;
}

export interface WaitingOn {
  key: string;
  who: string;
  what: Seg[];
}

export interface IntakePlan {
  finding: { tone: "danger" | "warning" | "neutral" | "done"; lead: Seg[]; then: Seg[] };
  holdLine: HoldLine;
  steps: PathStep[];
  /** The one step of the rail that holds this actor's next step (filled on screen, aria-current); null when nothing is theirs. */
  current: StepKey | null;
  /** This actor's next step (null = nothing for them on this item now). */
  next: WorkItem | null;
  /** Shown when `next` is null: why, and the next item in the queue. */
  idle: { title: Seg[]; detail: Seg[] } | null;
  nextItem: { displayId: string; patientName: string | null } | null;
  /** Other things this actor can do on the item now. */
  also: WorkItem[];
  waitingOn: WaitingOn[];
  accession: AccessionPlan;
  readOnly: boolean;
}

export interface PlanInput {
  item: ItemDetail;
  siblings: SiblingView[];
  actor: { id: string; name: string; role: string };
  permissions: BenchPermissions;
  sourceAvailable: boolean;
  readOnly: boolean;
  nextItem: { displayId: string; patientName: string | null } | null;
}

const ROLE_WORD = { bench: "An accessioner", lead: "Accessioning lead" } as const;

function officeName(item: ItemDetail): string {
  return item.office?.name ?? item.observedOfficeText ?? "the office";
}

function lowerFirstText(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * A source conflict in one sentence, from the importer's task title: what the
 * source sent and what was kept ("New order ORD-77990 gives different details
 * for MRN 448210 (date of birth 1961-03-22 → 1901-01-01).").
 */
export function sourceConflictWords(t: Pick<SourceConflictView, "title" | "about">): string {
  const head = t.title.split(" — ")[0].trim();
  if (head) return head.endsWith(".") ? head : `${head}.`;
  return t.about === "patient"
    ? "The source sent patient details that differ from the patient on file."
    : "A newer order version changed order-level details that were not applied.";
}

function workItems(input: PlanInput, acc: AccessionPlan): WorkItem[] {
  const { item, permissions: p, readOnly } = input;
  const can = (x: boolean) => x && !readOnly;
  const work: WorkItem[] = [];
  if (item.status === "accessioned" || item.status === "canceled") return work;
  const office = officeName(item);
  const parts = item.orders.flatMap((o) => o.parts);

  // 1. The container check against the physical bottle (never a scan, never Ctrl+Enter).
  const check = item.containers.find((c) => c.verificationState === "unverified") ?? item.containers.find((c) => c.orderChangedSinceVerification);
  if (check) {
    const stale = check.verificationState !== "unverified" && check.orderChangedSinceVerification;
    work.push({
      key: `verify-${check.id}`,
      action: {
        kind: "verify",
        containerId: check.id,
        seq: check.seq,
        version: check.version,
        orderPartId: check.orderPartId ?? (parts.length === 1 ? parts[0].id : null),
        needsPart: !check.orderPartId && parts.length > 1,
        stale,
        designation: check.designation,
        orderRef: check.orderRef,
        total: item.containers.length,
      },
      owner: null,
      ownerRole: ROLE_WORD.bench,
      actorCan: can(p.verify) && parts.length > 0,
      ctrlEnter: false,
      title: segs(
        stale
          ? `Check container ${check.seq} again: ${check.orderRef ?? "the order"} changed after the last check (v${check.lastVerification?.orderVersion ?? "?"} → v${check.currentOrderVersion ?? "?"})`
          : `Check container ${check.seq}${check.designation ? `, Part\u00a0${check.designation},` : ""} against the order`,
      ),
      detail: segs(
        parts.length
          ? "Compare the bottle in your hand with the order and the requisition. A field that differs is recorded as a discrepancy, never corrected."
          : "No order part can be compared: no source order is linked. Raise a clarification with the office.",
      ),
    });
  }

  // 2. Differences that nobody has asked about yet.
  const asked = new Set<string>();
  for (const c of item.containers) {
    for (const row of c.comparison) {
      if (row.status !== "differs") continue;
      const key = IDENTITY.has(row.field) ? `identity` : `${c.id}-${row.field}`;
      if (asked.has(key)) continue;
      asked.add(key);
      if (coveringClarification(item, c, row)) continue;
      if (c.acceptedMismatches.some((a) => a.field === row.field) && !c.openMismatches.some((m) => m.field === row.field)) continue;
      work.push({
        key: `raise-${key}`,
        action: { kind: "raise", containerId: c.id, field: row.field, fieldLabel: row.label },
        owner: null,
        ownerRole: ROLE_WORD.bench,
        actorCan: can(p.raiseClarification),
        ctrlEnter: true,
        title: segs(`Ask ${office} about the ${SHORT_FIELD[row.field] ?? row.label.toLowerCase()}${IDENTITY.has(row.field) ? " (patient identity)" : ""}`),
        detail: segs(`${differSentence(row)} Nobody has asked yet. Raising a clarification keeps both values and can hold only the affected material.`),
      });
    }
  }
  for (const m of item.missingParts) {
    if (m.clarification) continue;
    work.push({
      key: `missing-${m.orderPartId}`,
      action: { kind: "raise_missing", orderPartId: m.orderPartId, orderRef: m.orderRef, designation: m.designation },
      owner: null,
      ownerRole: ROLE_WORD.bench,
      actorCan: can(p.raiseClarification),
      ctrlEnter: true,
      title: segs(`Ask ${office} about the missing container for ${m.orderRef} part ${m.designation}`),
      detail: segs(`The order expects ${m.expected ?? "an unknown number of"} container${m.expected === 1 ? "" : "s"} for part ${m.designation}; ${m.received} arrived. Other parts can continue.`),
    });
  }

  // 2b. Source conflicts: the source sent patient or order-level details that differ from what is on file.
  // Only a lead or supervisor records that the details on file stand; nothing is merged or changed.
  for (const t of item.sourceConflicts) {
    const conflict = sourceConflictWords(t);
    work.push({
      key: `srcconf-${t.id}`,
      action: { kind: "review_source_conflict", taskId: t.id, version: t.version, about: t.about, conflict, detail: t.detail, orderRefs: t.orderRefs },
      owner: t.ownerName,
      ownerRole: ROLE_WORD.lead,
      actorCan: can(p.reviewSourceConflict),
      ctrlEnter: true,
      title: segs("Review source conflict"),
      detail: segs(`${conflict} Accession waits for this review; nothing is merged or changed.`),
      waitText: segs(`review the source conflict: ${lowerFirstText(conflict)}`),
    });
  }

  // 3. Clarifications: drafted ones to send, the office's answer, the lead's review.
  for (const q of item.clarifications) {
    if (!OPEN_CLR.has(q.state)) continue;
    if (q.state === "drafted") {
      work.push({
        key: `send-${q.id}`,
        action: { kind: "send", clarificationId: q.id, displayId: q.displayId, version: q.version, officeName: office, question: q.question, category: q.category, followUpAt: q.nextFollowUpAt, notice: q.noticePreview ?? "" },
        owner: q.ownerName,
        ownerRole: ROLE_WORD.bench,
        actorCan: can(p.sendClarification),
        ctrlEnter: true,
        title: segs(`Send ${q.displayId} to ${office}`),
        detail: segs(`Drafted, not sent. ${q.ownerName ? `Owner ${q.ownerName}.` : ""}`.trim()),
      });
    } else if (q.state === "delivery_failed" || q.state === "delivery_unknown") {
      work.push({
        key: `delivery-${q.id}`,
        action: { kind: "open_clarification", displayId: q.displayId, label: `Open ${q.displayId} in Clarifications` },
        owner: q.ownerName,
        ownerRole: ROLE_WORD.bench,
        actorCan: can(p.sendClarification),
        ctrlEnter: true,
        title: segs(`${q.displayId}: ${clarificationWords(q.state)}; record the outcome or send again`),
        detail: segs("The simulated connector did not confirm delivery. The office may not have the question."),
      });
    } else if (q.state === "answered" || q.state === "reviewed") {
      const task = item.tasks.find((t) => t.kind === "clarification_followup" && t.title.includes(q.displayId));
      work.push({
        key: `answer-${q.id}`,
        action: { kind: "open_clarification", displayId: q.displayId, label: `Open ${q.displayId} in Clarifications` },
        owner: task?.ownerName ?? (q.state === "answered" ? null : q.ownerName),
        ownerRole: ROLE_WORD.lead,
        actorCan: can(p.reviewClarification),
        ctrlEnter: true,
        title: segs(q.state === "answered" ? `Review the office's answer to ${q.displayId}` : `Resolve ${q.displayId} (answer reviewed)`),
        detail: segs("An answer never resolves the question by itself; a lead reviews and resolves it, and releasing a hold is a separate step."),
      });
    } else {
      work.push({
        key: `office-${q.id}`,
        action: null,
        owner: office,
        ownerRole: null,
        actorCan: false,
        ctrlEnter: false,
        title: segs(`answer ${q.displayId}${q.nextFollowUpAt ? ` (follow-up ${fmtTime(q.nextFollowUpAt)})` : ""}`),
        detail: [],
      });
    }
  }

  // 4. Related orders: a review, never a merge.
  for (const rel of item.related) {
    const accessioned = rel.otherItems.some((o) => o.status === "accessioned");
    if (rel.status === "pending_review") {
      const members = [item.displayId, ...rel.otherItems.map((o) => o.displayId)].sort();
      work.push({
        key: `rel-${rel.id}`,
        action: { kind: "review_related", candidateId: rel.id, displayId: rel.displayId, version: rel.version, members, duplicateRecordKind: rel.duplicateRecordKind },
        owner: relOwner(item),
        ownerRole: ROLE_WORD.lead,
        actorCan: can(p.reviewRelated) && !accessioned,
        ctrlEnter: true,
        title: segs(`Decide ${rel.displayId}: one case or two?`),
        detail: [],
      });
    } else if (rel.status === "escalated_to_office") {
      work.push({ key: `rel-office-${rel.id}`, action: null, owner: office, ownerRole: null, actorCan: false, ctrlEnter: false, title: segs(`answer about ${rel.displayId} (asked the office)`), detail: [] });
    }
  }

  // 5. Routing to an assigned dermatopathologist.
  const r = item.routing;
  if (r?.status === "exception") {
    work.push({
      key: "routing-exception",
      action: { kind: "resolve_routing" },
      owner: item.tasks.find((t) => t.kind === "routing_exception")?.ownerName ?? null,
      ownerRole: ROLE_WORD.lead,
      actorCan: can(p.resolveException),
      ctrlEnter: true,
      title: segs("Assign a dermatopathologist (no routing rule for this office)"),
      detail: segs("No approved rule applies, so nobody is suggested. Assigning records routing for this item only, with your reason; it creates no rule."),
    });
  } else if (r?.status === "suggested" && r.suggested) {
    work.push({
      key: "routing-accept",
      action: { kind: "accept_routing", doctorName: r.suggested.name, doctorColor: r.suggested.color, ruleSetVersion: r.ruleSetVersion },
      owner: null,
      ownerRole: ROLE_WORD.bench,
      actorCan: can(p.confirmRouting),
      ctrlEnter: true,
      title: segs(`Accept routing to ${r.suggested.name}`),
      detail: segs(r.explanation),
    });
  }

  // 6. The accession request (the number comes from the simulated source).
  if (acc.state === "ready") {
    work.push({
      key: "request",
      action: { kind: "request" },
      owner: null,
      ownerRole: ROLE_WORD.bench,
      actorCan: can(p.requestAccession),
      ctrlEnter: true,
      title: segs(acc.ids.length > 1 ? "Request one accession for the related items" : "Request the accession"),
      detail: segs("Every check has passed. The request is at the foot of this column; the official number comes from the source system."),
    });
  } else if (acc.state === "offline" && !(item.readiness.group?.blockers ?? item.readiness.blockers).length) {
    work.push({ key: "source", action: null, owner: "EMA-SIM (simulated source)", ownerRole: null, actorCan: false, ctrlEnter: false, title: segs("come back online before the number can be issued"), detail: [] });
  }
  return work;
}

// ------------------------------------------------------------------ the five steps

const DIFF_CODES = new Set(["discrepancy_uncovered", "identity_unresolved", "missing_container", "extra_container", "unmatched_container", "source_conflict_open"]);

/** "Dr. Elena Marsh" → "Dr. Marsh" (the rail is narrow; the full name stays in the accessible name). */
export function shortDoctor(name: string): string {
  const m = /^(Dr\.?)\s+(?:\S+\s+)+(\S+)$/.exec(name.trim());
  return m ? `${m[1]} ${m[2]}` : name;
}

/** Short field words for the rail ("DOB differs"). */
const RAIL_FIELD: Record<string, string> = { ...SHORT_FIELD, birth_date: "DOB", part_designation: "part letter", collection_date: "collection date" };

/** Short nouns for what the accession waits on, in the rail ("check", "routing", "REL-0112"). */
function railNoun(b: Blocker): string {
  const n = waitNoun(b);
  return n === "container check" ? "check" : n === "container count" ? "count" : n;
}

function stepsFor(input: PlanInput, work: WorkItem[], acc: AccessionPlan): PathStep[] {
  const { item, actor } = input;
  const done = item.status === "accessioned";
  const blockers = item.readiness.group?.blockers ?? item.readiness.blockers;
  const byKey = (prefix: string) => work.filter((w) => w.key.startsWith(prefix));
  const stateFor = (w: WorkItem | undefined): StepState => (!w ? "todo" : w.actorCan && (w.owner === null || w.owner === actor.name) ? "mine" : w.owner ? "waiting" : "todo");
  const ownerOf = (w: WorkItem | undefined) => (w ? w.owner ?? (w.actorCan ? null : w.ownerRole) : null);
  const step = (key: StepKey, label: string, state: StepState, tone: StepTone, status: string, short: string, owner: string | null = null, stale = false): PathStep => ({
    key,
    label,
    state,
    tone,
    status: segs(status),
    short: segs(short),
    owner,
    stale,
  });

  // 1. Container check
  const check = ((): PathStep => {
    const label = "Container check";
    if (!item.containers.length) return step("check", label, "blocked", "warning", "No container received", "None received");
    const stale = item.containers.filter((c) => c.verificationState !== "unverified" && c.orderChangedSinceVerification);
    const unchecked = item.containers.filter((c) => c.verificationState === "unverified");
    const w = byKey("verify-")[0];
    if (!done && stale.length) {
      const c = stale[0];
      return step("check", label, stateFor(w), "warning", `Order changed (v${c.lastVerification?.orderVersion ?? "?"} → v${c.currentOrderVersion ?? "?"}): check again`, "Order changed · check again", ownerOf(w), true);
    }
    if (!done && unchecked.length) {
      const st = stateFor(w);
      const count = unchecked.length === item.containers.length ? (item.containers.length === 1 ? "Not checked yet" : `None of ${item.containers.length} checked`) : `${unchecked.length} of ${item.containers.length} not checked`;
      const who = (ownerOf(w) ?? "an accessioner").replace(/^An? /, (m) => m.toLowerCase());
      const waiting = st === "waiting" || st === "todo";
      return step("check", label, st, st === "mine" ? "ink" : "neutral", count + (waiting ? `; ${who}` : ""), waiting && ownerOf(w) && !/^An? /.test(ownerOf(w)!) ? `${count} · ${ownerOf(w)}` : count, ownerOf(w));
    }
    const last = [...item.containers].filter((c) => c.verifiedAt).sort((a, b) => (a.verifiedAt! < b.verifiedAt! ? 1 : -1))[0];
    const full = last?.verifiedByName ? `${last.verifiedByName}, ${fmtTime(last.verifiedAt)}` : "Checked; name not on record";
    return step("check", label, "done", "done", full, last?.verifiedByName ? `${last.verifiedByName} · ${fmtTime(last.verifiedAt)}` : "Checked");
  })();

  // 2. Differences between order, bottle and requisition
  const differences = ((): PathStep => {
    const label = "Differences";
    type Issue = { identity: boolean; text: string; short: string; w: WorkItem | undefined; clr: Clar | null };
    const issues: Issue[] = [];
    const seen = new Set<string>();
    for (const c of item.containers) {
      for (const row of c.comparison) {
        if (row.status !== "differs") continue;
        const identity = IDENTITY.has(row.field);
        const key = identity ? "identity" : `${c.id}-${row.field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const clr = coveringClarification(item, c, row);
        const accepted = c.acceptedMismatches.some((a) => a.field === row.field) && !c.openMismatches.some((m) => m.field === row.field);
        if (accepted || clr?.state === "resolved") continue;
        issues.push({
          identity,
          text: `${cap(SHORT_FIELD[row.field] ?? row.label)} differs`,
          short: `${cap(RAIL_FIELD[row.field] ?? row.label)} differs`,
          w: work.find((x) => x.key === `raise-${key}`),
          clr,
        });
      }
    }
    for (const m of item.missingParts) issues.push({ identity: false, text: `Part ${m.designation} container missing`, short: `Part ${m.designation} missing`, w: work.find((x) => x.key === `missing-${m.orderPartId}`), clr: null });
    for (const m of item.extraParts) issues.push({ identity: false, text: `Part ${m.designation}: extra container`, short: `Part ${m.designation} extra`, w: undefined, clr: null });
    const diffBlockers = blockers.filter((b) => DIFF_CODES.has(b.code));
    // A source conflict (the source sent other patient or order details) is a difference a lead reviews.
    const conflicts = done ? [] : item.sourceConflicts;
    if (!issues.length && conflicts.length) {
      const w = work.find((x) => x.key === `srcconf-${conflicts[0].id}`);
      const st = stateFor(w);
      const who = ownerOf(w);
      const more = conflicts.length > 1 ? ` (+${conflicts.length - 1})` : "";
      const moreShort = conflicts.length > 1 ? ` +${conflicts.length - 1}` : "";
      return st === "mine"
        ? step("differences", label, st, "warning", `Source conflict: your review${more}`, `Source conflict · yours${moreShort}`, who)
        : step("differences", label, st, "warning", `Source conflict: ${who ?? "a lead"} reviews${more}`, `Source conflict · ${who ?? "a lead"}${moreShort}`, who);
    }
    if (!issues.length && !diffBlockers.length) {
      const resolved = item.clarifications.find((q) => q.state === "resolved");
      return step("differences", label, "done", "done", resolved ? `Settled (${resolved.displayId} resolved)` : "None found", resolved ? `${resolved.displayId} · resolved` : "None found");
    }
    if (!issues.length) {
      return step("differences", label, "todo", "warning", `Waits for ${waitPhrase(diffBlockers[0], item, actor.name)}`, `Waits for ${railNoun(diffBlockers[0])}`);
    }
    const top = issues.find((i) => i.identity) ?? issues[0];
    const tone: StepTone = issues.some((i) => i.identity) ? "danger" : "warning";
    const others = issues.length - 1 + conflicts.length;
    const more = others > 0 ? ` (+${others})` : "";
    const moreShort = others > 0 ? ` +${others}` : "";
    if (!top.clr) {
      return step("differences", label, stateFor(top.w), tone, `${top.text}; not asked yet${more}`, `${top.short} · not asked${moreShort}`, ownerOf(top.w));
    }
    const q = top.clr;
    const sendW = work.find((x) => x.key === `send-${q.id}` || x.key === `answer-${q.id}` || x.key === `delivery-${q.id}`);
    const officeW = work.find((x) => x.key === `office-${q.id}`);
    const w = sendW ?? officeW;
    const st = w ? stateFor(w) : "waiting";
    const who = w ? ownerOf(w) : null;
    const full: Record<string, string> = {
      drafted: st === "waiting" && who ? `drafted; ${who} to send` : "drafted, not sent",
      sent: "sent; office to answer",
      delivered: "sent; office to answer",
      acknowledged: "office acknowledged",
      delivery_unknown: "delivery unknown",
      delivery_failed: "delivery failed",
      answered: `answered; ${st === "mine" ? "you review" : `${who ?? "a lead"} reviews`}`,
      reviewed: `reviewed; ${who && st !== "mine" ? `${who} resolves` : st === "mine" ? "you resolve" : "a lead resolves"}`,
    };
    const short: Record<string, string> = {
      drafted: st === "waiting" && who ? `${who}` : "not sent",
      sent: "office to answer",
      delivered: "office to answer",
      acknowledged: "acknowledged",
      delivery_unknown: "delivery unknown",
      delivery_failed: "delivery failed",
      answered: st === "mine" ? "you review" : `${who ?? "a lead"}`,
      reviewed: st === "mine" ? "you resolve" : `${who ?? "a lead"}`,
    };
    return step(
      "differences",
      label,
      st,
      tone,
      `${q.displayId} ${full[q.state] ?? clarificationWords(q.state)}${more}`,
      `${q.displayId} · ${short[q.state] ?? clarificationWords(q.state)}${moreShort}`,
      who,
    );
  })();

  // 3. Related orders
  const related = ((): PathStep => {
    const label = "Related orders";
    if (!item.related.length) return step("related", label, "none", "done", "None proposed", "None proposed");
    const pending = item.related.find((r) => r.status === "pending_review" || r.status === "escalated_to_office");
    if (!pending) {
      const r = item.related[0];
      const word = r.status === "single_accession_approved" ? "one accession" : r.status === "keep_separate" ? "kept separate" : (RELATED_STATUS[r.status as keyof typeof RELATED_STATUS] ?? r.status).toLowerCase();
      return step("related", label, "done", "done", `${r.displayId}: ${word}`, `${r.displayId} · ${word}`);
    }
    const w = work.find((x) => x.key === `rel-${pending.id}` || x.key === `rel-office-${pending.id}`);
    const st = stateFor(w);
    const tone: StepTone = st === "mine" ? "ink" : "neutral";
    if (pending.status === "escalated_to_office") return step("related", label, st, tone, `${pending.displayId}: asked the office`, `${pending.displayId} · asked office`, ownerOf(w));
    if (st === "mine") return step("related", label, st, tone, `${pending.displayId}: your decision`, `${pending.displayId} · yours`, ownerOf(w));
    return step("related", label, st, tone, `${pending.displayId}: ${ownerOf(w) ?? "a lead"} decides`, `${pending.displayId} · ${ownerOf(w) ?? "a lead"}`, ownerOf(w));
  })();

  // 4. Routing
  const routing = ((): PathStep => {
    const label = "Routing";
    const r = item.routing;
    if (!r) return step("routing", label, "todo", "neutral", "No routing decision yet", "Not decided");
    if (r.status === "exception") {
      const w = work.find((x) => x.key === "routing-exception");
      const st = stateFor(w);
      return st === "mine"
        ? step("routing", label, st, "ink", "No rule; you assign", "No rule · yours", ownerOf(w))
        : step("routing", label, st, "neutral", `No rule; ${ownerOf(w) ?? "a lead"} assigns`, `No rule · ${ownerOf(w) ?? "a lead"}`, ownerOf(w));
    }
    if (r.status === "suggested") {
      const w = work.find((x) => x.key === "routing-accept");
      const st = stateFor(w);
      const name = r.suggested?.name ?? "Unknown";
      return step("routing", label, st, st === "mine" ? "ink" : "neutral", `Suggested: ${name}`, `Suggested: ${shortDoctor(name)}`, ownerOf(w));
    }
    const who = r.final?.name ?? r.suggested?.name ?? "Unknown";
    return r.status === "overridden"
      ? step("routing", label, "done", "done", `${who} (overridden)`, `${shortDoctor(who)} · overridden`)
      : step("routing", label, "done", "done", `${who}${r.ruleSetVersion ? `, rule v${r.ruleSetVersion}` : ""}`, `${shortDoctor(who)}${r.ruleSetVersion ? ` · rule v${r.ruleSetVersion}` : ""}`);
  })();

  // 5. Accession
  const accession = ((): PathStep => {
    const label = "Accession";
    if (acc.state === "issued") return step("accession", label, "done", "done", `${item.accession!.number} issued`, `${item.accession!.number} issued`);
    if (acc.state === "closed") return step("accession", label, "none", "neutral", "Canceled", "Canceled");
    if (item.latestRequest?.status === "submitted")
      return step("accession", label, "waiting", "neutral", `${item.latestRequest.displayId} waits for the source`, `${item.latestRequest.displayId} · at the source`, "EMA-SIM (simulated)");
    if (acc.state === "offline") return step("accession", label, "blocked", "neutral", "Source offline (simulated)", "Source offline");
    if (!blockers.length) {
      const w = work.find((x) => x.key === "request");
      const mine = !!w && w.actorCan;
      return step("accession", label, mine ? "mine" : "todo", mine ? "ink" : "neutral", "Ready to request", "Ready to request");
    }
    const nouns = [...new Set(blockers.map(waitNoun))];
    const shortNouns = [...new Set(blockers.map(railNoun))];
    return step(
      "accession",
      label,
      "blocked",
      "neutral",
      `${nouns.length === 1 ? "Waits for" : "Waits:"} ${nouns.slice(0, 3).join(", ")}${nouns.length > 3 ? ` +${nouns.length - 3}` : ""}`,
      `${shortNouns.length === 1 ? "Waits for" : "Waits:"} ${shortNouns.slice(0, 2).join(", ")}${shortNouns.length > 2 ? ` +${shortNouns.length - 2}` : ""}`,
    );
  })();

  return [check, differences, related, routing, accession];
}

// ------------------------------------------------------------------ the finding

function finding(item: ItemDetail, acc: AccessionPlan, actorName: string): IntakePlan["finding"] {
  if (item.accession) {
    return {
      tone: "done",
      lead: segs(`Accessioned as ${item.accession.number} by the source system (EMA-SIM, simulated).`),
      then: segs("Parts keep their original orders; nothing was merged or renumbered."),
    };
  }
  if (item.status === "canceled") return { tone: "neutral", lead: segs("This intake item was canceled."), then: segs("Nothing more happens at intake.") };

  const differing = item.containers.flatMap((c) => c.comparison.filter((r) => r.status === "differs").map((r) => ({ c, r })));
  const identity = differing.filter((d) => IDENTITY.has(d.r.field));
  const field = differing.filter((d) => !IDENTITY.has(d.r.field));
  const stale = item.containers.filter((c) => c.verificationState !== "unverified" && c.orderChangedSinceVerification);
  const unchecked = item.containers.filter((c) => c.verificationState === "unverified");
  let tone: IntakePlan["finding"]["tone"] = "neutral";
  let lead: string;
  if (identity.length) {
    tone = "danger";
    const first = identity[0];
    const same = identity.filter((d) => d.r.field === first.r.field).length;
    const where = same > 1 ? (same === item.containers.length ? (same === 2 ? " on both containers" : ` on all ${same} containers`) : ` on ${same} containers`) : "";
    lead = differSentence(first.r).replace(/^(.+?) differs:/, `$1 differs${where}:`);
    const otherFields = new Set(differing.map((d) => d.r.field));
    otherFields.delete(first.r.field);
    if (otherFields.size) lead += ` ${otherFields.size} more field${otherFields.size > 1 ? "s differ" : " differs"}.`;
  } else if (field.length) {
    tone = "warning";
    lead = differSentence(field[0].r);
    const more = new Set(field.map((d) => d.r.field)).size - 1;
    if (more > 0) lead += ` ${more} more field${more > 1 ? "s differ" : " differs"}.`;
  } else if (item.missingParts.length) {
    tone = "warning";
    const m = item.missingParts[0];
    lead = `Order ${m.orderRef} expects ${m.expected ?? "an unknown number of"} container${m.expected === 1 ? "" : "s"} for part ${m.designation}; ${m.received === 0 ? "none has" : `${m.received} ha${m.received === 1 ? "s" : "ve"}`} arrived.`;
  } else if (item.extraParts.length) {
    tone = "warning";
    const m = item.extraParts[0];
    lead = `Order ${m.orderRef} expects ${m.expected ?? "an unknown number of"} container${m.expected === 1 ? "" : "s"} for part ${m.designation}; ${m.received} arrived.`;
  } else if (stale.length) {
    tone = "warning";
    const c = stale[0];
    lead = `${c.orderRef ?? "The order"} changed after container ${c.seq} was checked (v${c.lastVerification?.orderVersion ?? "?"} → v${c.currentOrderVersion ?? "?"}); the check must be repeated.`;
  } else if (item.sourceConflicts.length) {
    tone = "warning";
    const t = item.sourceConflicts[0];
    lead = `${sourceConflictWords(t)} The ${t.about === "patient" ? "patient details" : "order details"} on file were kept; nothing was merged.`;
  } else if (!item.orders.length) {
    tone = "warning";
    lead = item.office ? "No source order was found for the requisition's order id in this office's tenant." : `${item.observedOfficeText ?? "The office"} is not in the office directory, so no order could be looked up.`;
  } else if (item.routing?.status === "exception") {
    lead = `${officeName(item)} has no routing rule, so no dermatopathologist is suggested.`;
  } else if (unchecked.length) {
    lead =
      unchecked.length === item.containers.length
        ? `${item.containers.length === 1 ? "The container has not" : `None of the ${item.containers.length} containers has`} been checked against the physical bottle yet.`
        : `${unchecked.length} of ${item.containers.length} containers have not been checked against the physical bottle yet.`;
  } else {
    const by = item.containers[0]?.verifiedByName;
    lead = `Order, bottle and requisition agree on every field they share${by ? `; checked by ${by} at ${fmtTime(item.containers[0].verifiedAt)}` : ""}.`;
    if (!item.requisition) lead = lead.replace("Order, bottle and requisition agree", "Order and bottle agree");
  }

  let then: string;
  if (acc.state === "ready") then = "Nothing blocks the accession request.";
  else if (acc.state === "offline") then = "The source system is offline (simulated); the accession request waits for it.";
  else if (item.latestRequest?.status === "submitted") then = `Accession request ${item.latestRequest.displayId} waits for the source.`;
  else {
    const phrases = waitPhrases(item.readiness.group?.blockers ?? item.readiness.blockers, item, actorName);
    then = phrases.length ? `Accession waits for ${joinWords(phrases.slice(0, 3))}${phrases.length > 3 ? ` (and ${phrases.length - 3} more)` : ""}.` : "";
  }
  return { tone, lead: segs(lead), then: segs(then) };
}

// ------------------------------------------------------------------ the plan

/** Which step of the rail an action belongs to. */
const STEP_OF: Record<NextAction["kind"], StepKey> = {
  verify: "check",
  raise: "differences",
  raise_missing: "differences",
  send: "differences",
  open_clarification: "differences",
  review_related: "related",
  review_source_conflict: "differences",
  resolve_routing: "routing",
  accept_routing: "routing",
  request: "accession",
};

export function buildPlan(input: PlanInput): IntakePlan {
  const { item, siblings, actor, permissions, sourceAvailable, readOnly, nextItem } = input;
  const acc = accessionPlan(item, permissions, sourceAvailable, actor.name);
  const work = workItems(input, acc);
  const mineNow = (w: WorkItem) => w.actorCan && (w.owner === null || w.owner === actor.name);
  const next = work.find((w) => w.actorCan && w.owner === actor.name) ?? work.find((w) => w.actorCan && w.owner === null) ?? null;
  const also = work.filter((w) => w !== next && w.action && mineNow(w)).slice(0, 3);
  const waitingOn: WaitingOn[] = work
    .filter((w) => w !== next && !mineNow(w))
    .map((w) => ({ key: w.key, who: w.owner ?? w.ownerRole ?? "Someone at the bench", what: w.waitText ?? (w.owner && !w.action ? w.title : lowerFirst(w.title)) }));

  let idle: IntakePlan["idle"] = null;
  if (!next) {
    if (item.accession) idle = { title: segs(`Accessioned as ${item.accession.number}`), detail: segs("Nothing left at intake. Open the case to continue; later changes go through a correction review.") };
    else if (item.status === "canceled") idle = { title: segs("Canceled"), detail: segs("Nothing left at intake for this item.") };
    else if (readOnly) idle = { title: segs("Read only"), detail: segs("You can view this item but not change it. The people below can act on it.") };
    else if (waitingOn.length) idle = { title: segs("Nothing for you on this item right now"), detail: segs(`It waits for ${joinWords([...new Set(waitingOn.map((w) => w.who))])}. Other items in the queue can continue.`) };
    else idle = { title: segs("Nothing for you on this item right now"), detail: segs("Other items in the queue can continue.") };
  }
  return {
    finding: finding(item, acc, actor.name),
    holdLine: holdLine(item, siblings),
    steps: stepsFor(input, work, acc),
    current: next?.action ? STEP_OF[next.action.kind] : null,
    next,
    idle,
    nextItem,
    also,
    waitingOn,
    accession: acc,
    readOnly,
  };
}

function lowerFirst(s: Seg[]): Seg[] {
  if (!s.length || typeof s[0] !== "string") return s;
  const [h, ...rest] = s;
  return [h[0].toLowerCase() + h.slice(1), ...rest];
}

// ------------------------------------------------------------------ identity band facts

export interface IdentityFacts {
  /** Patient name and DOB as written on the bottle (the material in hand); order values when the bottle states none. */
  name: { value: string | null; from: "bottle" | "order" | null; orderValue: string | null; differs: boolean };
  dob: { value: string | null; from: "bottle" | "order" | null; orderValue: string | null; differs: boolean };
  /** The side in question, named only ("Side: right or left?"), when the order and the bottle disagree on it; the finding says who says what. */
  sideWarning: string | null;
  /** "Dorsal forearm, punch" (without the side when it differs). */
  site: string | null;
}

export function identityFacts(item: ItemDetail): IdentityFacts {
  const c = item.containers[0];
  const row = (f: string) => c?.comparison.find((r) => r.field === f);
  const fact = (f: string) => {
    const r = row(f);
    const bottle = r?.observed.original ?? null;
    const order = r?.order.original ?? null;
    const differs = item.containers.some((x) => x.comparison.some((y) => y.field === f && y.status === "differs"));
    return { value: bottle ?? order, from: bottle ? ("bottle" as const) : order ? ("order" as const) : null, orderValue: order, differs };
  };
  const lat = row("laterality");
  const sides = lat ? [...new Set([lat.order.normalized, lat.observed.normalized, lat.requisition.normalized].filter((v): v is string => !!v).map((v) => v.toLowerCase()))] : [];
  const sideWarning =
    lat && lat.status === "differs" && lat.pairs.includes("order≠observed") ? `Side: ${sides.length > 1 ? `${sides.slice(0, -1).join(", ")} or ${sides[sides.length - 1]}` : "unclear"}?` : null;
  const part = c?.orderPartId ? item.orders.flatMap((o) => o.parts).find((p) => p.id === c.orderPartId) : item.orders[0]?.parts[0];
  const site = part ? `${sideWarning ? cap(part.siteText.replace(/^(right|left|rt|lt|r|l)\.?\s+/i, "")) : part.siteText}${part.procedure ? `, ${part.procedure.toLowerCase()}` : ""}` : (c?.observed.site_text ?? null);
  return { name: fact("patient_name"), dob: fact("birth_date"), sideWarning, site };
}

// ------------------------------------------------------------------ what the screen already says

/**
 * Identifiers the finding band, the step rail and the decision column already
 * state for this person (e.g. "CLR-0457 · not sent", "Send CLR-0457 to ..."),
 * so the evidence does not say the same question and its state again.
 */
export function statedIds(plan: IntakePlan): Set<string> {
  const out = new Set<string>();
  const add = (v: Seg[] | undefined) => v?.forEach((x) => typeof x !== "string" && out.add(x.id));
  for (const st of plan.steps) {
    add(st.short);
    add(st.status);
  }
  add(plan.next?.title);
  add(plan.next?.detail);
  for (const w of plan.also) add(w.title);
  for (const w of plan.waitingOn) add(w.what);
  return out;
}
