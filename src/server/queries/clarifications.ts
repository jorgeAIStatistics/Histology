import type { DB } from "@/server/db/db";
import type { Role, Permission } from "@/lib/roles";
import { roleCan, rolesFor, ROLE_LABEL } from "@/lib/roles";
import { CLARIFICATION_CATEGORY, CLARIFICATION_STATE, OPEN_CLARIFICATION_STATES, type ClarificationState } from "@/lib/domain";
import { fmtSmart, minutesBetween } from "@/lib/time";
import {
  AWAITING_OFFICE_STATES,
  ANSWER_CHANNELS,
  escalationWindow,
  RESOLUTION_CODES,
  FOLLOW_UP_MINUTES,
  REMINDER_SUPPRESSION_MINUTES,
  formatWorkingHours,
  parseEvidence,
  parseWorkingHours,
  reminderWindow,
  selectContact,
  subjectContext,
  type ClarificationRow,
  type EvidenceItem,
} from "@/server/domain/clarification";
import { activeHolds, blockedTransitions, scopesForPart, type HoldRow, type Scope } from "@/server/domain/holds";
import { channelLabel, genericBody, isUnverifiedContact, simulateDeliveryOutcome, SIMULATED_TAG, type ContactRow } from "@/server/sim/notifications";
import { assistantMode } from "@/server/assist/drafter";

/**
 * Read model for /clarifications. Server components call these directly.
 * Everything returned is plain JSON (safe to pass to client components).
 */

// ------------------------------------------------------------------ filters

export const CLARIFICATION_FILTERS = [
  { key: "my_open", label: "My open", description: "Open clarifications you own or have a task on, and closed ones whose hold you release" },
  { key: "overdue", label: "Overdue", description: "Waiting on the office past the next follow-up time" },
  { key: "awaiting_office", label: "Awaiting office", description: "Sent, delivery pending or failed, or acknowledged" },
  { key: "needs_review", label: "Needs review", description: "Answered or reviewed, or closed with a hold still to release: a lead or supervisor acts next" },
  { key: "resolved", label: "Resolved", description: "Resolved or canceled" },
  { key: "all", label: "All", description: "Every clarification, open first" },
] as const;
export type ClarificationFilter = (typeof CLARIFICATION_FILTERS)[number]["key"];

export function parseFilter(v: string | undefined | null): ClarificationFilter | null {
  return CLARIFICATION_FILTERS.some((f) => f.key === v) ? (v as ClarificationFilter) : null;
}

// ------------------------------------------------------------------ shapes

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "hold";

export interface ClarificationListRow {
  id: string;
  displayId: string;
  version: number;
  category: string;
  categoryLabel: string;
  state: ClarificationState;
  stateLabel: string;
  stateTone: Tone;
  priority: string;
  subjectLabel: string;
  affectedLabel: string;
  officeName: string;
  contactName: string | null;
  contactRole: string;
  labOwnerId: string;
  labOwnerName: string;
  nextFollowUpAt: string | null;
  overdueMinutes: number | null;
  followUpText: string;
  lastEventAt: string;
  lastEventLabel: string;
  /** scopeShort (derived, read only): the scope in words, e.g. "Part B". */
  activeHolds: { id: string; displayId: string; scopeLabel: string; scopeShort: string }[];
  createdAt: string;
  isOpen: boolean;
  /** Derived (read only): the affected material as the bench reads it, for its label reference. */
  material: MaterialRef;
  /** Derived (read only): the lead who reviews answers and resolves (the review task goes to this person). */
  escalationOwnerName: string | null;
  /** Derived (read only): that lead's staff id (they also decide on releasing a closed question's hold). */
  escalationOwnerId: string | null;
  /**
   * Derived (read only): resolved or canceled, but a linked hold is still active. A lead still has
   * to release it with a reason, so the row stays on Needs review (and the lead's My open) until then.
   */
  holdToRelease: boolean;
}

/**
 * The affected material, structured for display (derived from the same joins as `affectedLabel`):
 * the label shown first is the official accession, else the provisional INT id, else the source order.
 */
export interface MaterialRef {
  kind: "accession" | "provisional" | "order" | "other";
  /** Identifier set as the label reference (D26-…, INT-…, ORD-…); the subject label for "other". */
  labelId: string;
  /** Part letter when the question is about one part. */
  part: string | null;
  /** "part": one part; "all_parts" / "all_containers": an identity question covers every part or container. */
  scope: "part" | "all_parts" | "all_containers" | "whole";
  /** Source order id when the label is not the order itself (shown beside a provisional id). */
  orderRef: string | null;
  /** Accession numbering namespace (official labels only), e.g. "EMA-SIM DERM". */
  namespace: string | null;
}

export interface ContactView {
  id: string;
  name: string;
  role: string;
  channel: string;
  channelLabel: string;
  outUntil: string | null;
  isOutNow: boolean;
  unverified: boolean;
}

export interface HoldView {
  id: string;
  displayId: string;
  status: "active" | "released";
  version: number;
  scopeLabel: string;
  /** Short scope in words, e.g. "Part B". */
  scopeShort: string;
  /** What else can continue, e.g. "Part A (ORD-77120) can continue." (empty when nothing else). */
  siblingNote: string;
  /** Full sentence: "Holding Part B only. Part A (ORD-77120) can continue." */
  scopeText: string;
  blocks: string[];
  blockLabels: string[];
  reasonText: string;
  placedAt: string;
  placedByName: string;
  releasedAt: string | null;
  releasedByName: string | null;
  releaseReason: string | null;
}

export interface TimelineStep {
  key: string;
  label: string;
  at: string | null;
  actorName: string | null;
  detail: string | null;
  status: "done" | "current" | "pending" | "skipped";
  tone: Tone;
}

export interface MessageView {
  id: string;
  direction: "outbound" | "inbound";
  kind: string;
  kindLabel: string;
  channelLabel: string;
  recipientName: string | null;
  body: string;
  deliveryState: string;
  deliveryLabel: string;
  createdAt: string;
  createdByName: string | null;
  simulated: boolean;
}

export interface HistoryEntry {
  seq: number;
  at: string;
  actorName: string;
  actorRoleLabel: string | null;
  origin: string;
  originLabel: string;
  action: string;
  summary: string;
  reason: string | null;
}

export type ActionKey =
  | "send"
  | "draft"
  | "recordDelivery"
  | "recordAck"
  | "recordAnswer"
  | "simulateAnswer"
  | "review"
  | "resolve"
  | "followUp"
  | "escalate"
  | "cancel"
  | "releaseHold";

export interface ActionView {
  key: ActionKey;
  label: string;
  command: string;
  enabled: boolean;
  reason: string | null;
  primary: boolean;
  demo?: boolean;
}

export interface ClarificationDetail {
  row: ClarificationListRow;
  question: string;
  draftSource: string;
  evidence: EvidenceItem[];
  subject: {
    partDesignation: string | null;
    orderRef: string | null;
    sourceOrderId: string | null;
    accessionNumber: string | null;
    accessionId: string | null;
    intakeDisplayId: string | null;
    intakeItemId: string | null;
    patient: { name: string; mrn: string; tenant: string } | null;
    orderTenant: string | null;
  };
  office: { id: string; name: string; status: string; workingHoursText: string; timezone: string };
  contact: {
    selected: ContactView | null;
    primary: ContactView | null;
    backup: ContactView | null;
    escalation: ContactView | null;
    coverageNoteNow: string | null;
    /** Who the next message would go to right now (coverage applied). */
    currentRecipient: ContactView | null;
    routedToBackup: boolean;
    expectedOutcomeNow: { outcome: string; reason: string };
  };
  people: { labOwner: string; escalationOwner: string | null; createdBy: string; reviewer: string | null; resolvedBy: string | null };
  priorityRule: string;
  holds: HoldView[];
  timeline: TimelineStep[];
  messages: MessageView[];
  history: HistoryEntry[];
  /**
   * Timeline steps that carry a time but have no matching local audit event: they came with the seeded scenario
   * (recorded before the demo started), so History cannot list them. Labels, in timeline order.
   */
  stepsWithoutAudit: string[];
  answer: {
    text: string;
    by: string | null;
    channelLabel: string;
    at: string | null;
    /** True only when the office simulator wrote it (by record origin, never by its text). */
    simulated: boolean;
    /** A lead or supervisor marked this answer insufficient; the lab is waiting for a further answer. */
    markedInsufficient: boolean;
  } | null;
  review: { byName: string | null; at: string | null; note: string | null } | null;
  resolution: { code: string | null; codeLabel: string | null; note: string | null; byName: string | null; at: string | null } | null;
  cancelReason: string | null;
  reminder: { lastSentAt: string | null; nextAllowedAt: string | null; suppressedNow: boolean; count: number; suppressionMinutes: number };
  escalatedAt: string | null;
  /** The source order was amended after the question was raised (evidence annotated by the source import). */
  amendment: { label: string; at: string | null } | null;
  deliveryGuidance: { tone: Tone; title: string; body: string } | null;
  actions: ActionView[];
  assistantMode: "deterministic" | "unavailable";
  /** Generic notification text the office would receive (no patient identifiers). */
  notificationPreview: string;
  resolutionCodes: { code: string; label: string }[];
  answerChannels: { code: string; label: string }[];
}

// ------------------------------------------------------------------ helpers

const STATE_TONE: Record<ClarificationState, Tone> = {
  drafted: "neutral",
  sent: "info",
  delivery_unknown: "warning",
  delivery_failed: "danger",
  delivered: "info",
  acknowledged: "info",
  answered: "info",
  reviewed: "info",
  resolved: "success",
  canceled: "neutral",
};

/** Pill wording per design-spec §7 state vocabulary. */
export const CLARIFICATION_PILL: Record<ClarificationState, string> = {
  drafted: "Drafted",
  sent: "Sent",
  delivery_unknown: "Delivery unknown",
  delivery_failed: "Delivery failed",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
  answered: "Answered",
  reviewed: "Reviewed",
  resolved: "Resolved",
  canceled: "Canceled",
};

const TRANSITION_LABEL: Record<string, string> = {
  accession_request: "Accession request",
  routing_confirm: "Routing confirmation",
  gross_approval: "Gross approval",
  processing: "Processing",
  sectioning: "Sectioning",
  print: "Label printing",
  tray_delivery: "Tray delivery",
  all: "All steps",
};

const PERMISSION_FOR: Record<ActionKey, Permission | null> = {
  send: "clarification.send",
  draft: "clarification.send",
  followUp: "clarification.send",
  escalate: "clarification.send",
  recordDelivery: "clarification.record",
  recordAck: "clarification.record",
  recordAnswer: "clarification.record",
  simulateAnswer: null,
  review: "clarification.review",
  resolve: "clarification.resolve",
  cancel: "clarification.resolve",
  releaseHold: "hold.release",
};

function staffNames(db: DB): Map<string, { name: string; role: string }> {
  const rows = db.prepare("SELECT id, display_name, role FROM staff").all() as { id: string; display_name: string; role: string }[];
  const m = new Map<string, { name: string; role: string }>();
  for (const r of rows) m.set(r.id, { name: r.display_name, role: r.role });
  return m;
}

/** Audit / message author id used by the office simulator (src/server/sim/office.ts). */
const SIM_OFFICE_ACTOR_ID = "sim_office";

function actorName(staff: Map<string, { name: string; role: string }>, id: string | null | undefined): string {
  if (!id) return "Unknown";
  if (id === "sim_office") return "Simulated office";
  if (id === "sim_notify") return "Simulated notification connector";
  if (id === "sim_source") return "Simulated source (EMA-SIM)";
  if (id === "system") return "System";
  return staff.get(id)?.name ?? id;
}

function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function contactView(c: ContactRow | null, now: string): ContactView | null {
  if (!c) return null;
  return {
    id: c.id,
    name: c.display_name,
    role: c.contact_role,
    channel: c.channel,
    channelLabel: channelLabel(c.channel),
    outUntil: c.out_until,
    isOutNow: !!c.out_until && Date.parse(c.out_until) > Date.parse(now),
    unverified: isUnverifiedContact(c),
  };
}

interface BaseRow extends ClarificationRow {
  office_name: string;
  contact_name: string | null;
  owner_name: string | null;
  escalation_owner_name: string | null;
  accession_number: string | null;
  accession_namespace: string | null;
  intake_display: string | null;
  sp_designation: string | null;
  op_designation: string | null;
  order_ref: string | null;
  last_msg_at: string | null;
}

const BASE_SQL = `
  SELECT c.*, o.name AS office_name, oc.display_name AS contact_name, s.display_name AS owner_name,
         eo.display_name AS escalation_owner_name, a.namespace AS accession_namespace,
         a.accession_number, ii.display_id AS intake_display, sp.designation AS sp_designation,
         op.designation AS op_designation, so.source_order_id AS order_ref,
         (SELECT MAX(m.created_at) FROM clarification_message m WHERE m.clarification_id = c.id) AS last_msg_at
    FROM clarification c
    JOIN office o ON o.id = c.office_id
    LEFT JOIN office_contact oc ON oc.id = c.contact_id
    LEFT JOIN staff s ON s.id = c.lab_owner_id
    LEFT JOIN staff eo ON eo.id = c.escalation_owner_id
    LEFT JOIN accession a ON a.id = c.accession_id
    LEFT JOIN intake_item ii ON ii.id = c.intake_item_id
    LEFT JOIN specimen_part sp ON sp.id = c.specimen_part_id
    LEFT JOIN source_order_part op ON op.id = c.order_part_id
    LEFT JOIN source_order so ON so.id = c.source_order_id`;

function affectedLabel(r: BaseRow): string {
  // An identity question is about the whole requisition (every container), never one part.
  if (r.category === "identity_conflict") {
    if (r.accession_number) return `${r.accession_number} (all parts)`;
    if (r.intake_display) return `${r.intake_display} (all containers)${r.order_ref ? ` · ${r.order_ref}` : ""}`;
  }
  const part = r.sp_designation ?? r.op_designation;
  if (r.accession_number) return `${r.accession_number}${part ? ` Part ${part}` : ""}`;
  if (r.intake_display && r.order_ref) return `${r.intake_display} · ${r.order_ref}${part ? ` Part ${part}` : ""}`;
  if (r.order_ref) return `${r.order_ref}${part ? ` Part ${part}` : ""}`;
  if (r.intake_display) return r.intake_display;
  return r.subject_label;
}

/** The affected material, structured (same precedence as `affectedLabel`). */
function materialRef(r: BaseRow): MaterialRef {
  const part = r.sp_designation ?? r.op_designation;
  const identity = r.category === "identity_conflict";
  if (r.accession_number)
    return { kind: "accession", labelId: r.accession_number, part: identity ? null : part, scope: identity ? "all_parts" : part ? "part" : "whole", orderRef: null, namespace: r.accession_namespace };
  if (r.intake_display)
    return { kind: "provisional", labelId: r.intake_display, part: identity ? null : part, scope: identity ? "all_containers" : part ? "part" : "whole", orderRef: r.order_ref, namespace: null };
  if (r.order_ref) return { kind: "order", labelId: r.order_ref, part, scope: part ? "part" : "whole", orderRef: null, namespace: null };
  return { kind: "other", labelId: r.subject_label, part: null, scope: "whole", orderRef: null, namespace: null };
}

const LAST_EVENT_FIELDS: [keyof ClarificationRow, string][] = [
  ["created_at", "Drafted"],
  ["sent_at", "Sent (simulated)"],
  ["delivered_at", "Delivered"],
  ["acknowledged_at", "Acknowledged"],
  ["answered_at", "Answered"],
  ["reviewed_at", "Reviewed"],
  ["resolved_at", "Resolved"],
  ["escalated_at", "Escalated"],
];

function toListRow(r: BaseRow, holds: Map<string, HoldRow[]>, now: string, shortOf: (h: HoldRow) => string = (h) => h.scope_label): ClarificationListRow {
  const isOpen = OPEN_CLARIFICATION_STATES.includes(r.state);
  const awaiting = AWAITING_OFFICE_STATES.includes(r.state);
  const overdueMinutes = awaiting && r.next_follow_up_at && Date.parse(r.next_follow_up_at) <= Date.parse(now) ? minutesBetween(r.next_follow_up_at, now) : null;
  let followUpText: string;
  if (!isOpen) followUpText = r.state === "resolved" ? "None (resolved)" : "None (canceled)";
  else if (r.state === "drafted") followUpText = "Not sent yet";
  else if (r.state === "answered") followUpText = "None: awaiting lab review";
  else if (r.state === "reviewed") followUpText = "None: ready to resolve";
  else if (overdueMinutes !== null) followUpText = `Overdue ${overdueMinutes < 60 ? `${overdueMinutes} min` : `${Math.floor(overdueMinutes / 60)} h ${String(overdueMinutes % 60).padStart(2, "0")} min`}`;
  else if (r.next_follow_up_at) followUpText = `${fmtSmart(r.next_follow_up_at, now)} ET`;
  else followUpText = "Unknown (no follow-up time set)";

  let lastEventAt = r.created_at;
  let lastEventLabel = "Drafted";
  for (const [field, label] of LAST_EVENT_FIELDS) {
    const v = r[field] as string | null;
    if (v && Date.parse(v) >= Date.parse(lastEventAt)) {
      lastEventAt = v;
      lastEventLabel = label;
    }
  }
  if (r.last_msg_at && Date.parse(r.last_msg_at) > Date.parse(lastEventAt)) {
    lastEventAt = r.last_msg_at;
    lastEventLabel = "Message logged";
  }
  if (r.state === "canceled") lastEventLabel = "Canceled";

  return {
    id: r.id,
    displayId: r.display_id,
    version: r.version,
    category: r.category,
    categoryLabel: (CLARIFICATION_CATEGORY as Record<string, string>)[r.category] ?? r.category,
    state: r.state,
    stateLabel: CLARIFICATION_PILL[r.state] ?? r.state,
    stateTone: STATE_TONE[r.state] ?? "neutral",
    priority: r.priority,
    subjectLabel: r.subject_label,
    affectedLabel: affectedLabel(r),
    officeName: r.office_name,
    contactName: r.contact_name,
    contactRole: r.contact_role,
    labOwnerId: r.lab_owner_id,
    labOwnerName: r.owner_name ?? "Unassigned",
    nextFollowUpAt: r.next_follow_up_at,
    overdueMinutes,
    followUpText,
    lastEventAt,
    lastEventLabel,
    activeHolds: (holds.get(r.id) ?? []).map((h) => ({ id: h.id, displayId: h.display_id, scopeLabel: h.scope_label, scopeShort: shortOf(h) })),
    createdAt: r.created_at,
    isOpen,
    material: materialRef(r),
    escalationOwnerName: r.escalation_owner_name ?? null,
    escalationOwnerId: r.escalation_owner_id ?? null,
    holdToRelease: !isOpen && (holds.get(r.id) ?? []).length > 0,
  };
}

/**
 * `myTasks` holds the clarification ids and the hold ids the actor has an open task on. A closed
 * question whose hold is still active is the releasing lead's work: it counts as theirs.
 */
function matches(row: ClarificationListRow, filter: ClarificationFilter, actorId: string, myTasks: Set<string>): boolean {
  switch (filter) {
    case "my_open":
      if (row.holdToRelease) return row.escalationOwnerId === actorId || row.activeHolds.some((h) => myTasks.has(h.id));
      return row.isOpen && (row.labOwnerId === actorId || myTasks.has(row.id));
    case "overdue":
      return row.overdueMinutes !== null;
    case "awaiting_office":
      return AWAITING_OFFICE_STATES.includes(row.state);
    case "needs_review":
      return row.state === "answered" || row.state === "reviewed" || row.holdToRelease;
    case "resolved":
      return row.state === "resolved" || row.state === "canceled";
    default:
      return true;
  }
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, routine: 2 };

function rank(r: ClarificationListRow): number {
  // A closed question with a hold still to release is lead work, after the answers to review.
  if (r.holdToRelease) return 3.5;
  if (!r.isOpen) return 9;
  if (r.overdueMinutes !== null) return 0;
  if (r.state === "delivery_failed") return 1;
  if (r.state === "delivery_unknown") return 2;
  if (r.state === "answered" || r.state === "reviewed") return 3;
  if (r.state === "drafted") return 4;
  return 5;
}

function sortRows(rows: ClarificationListRow[], filter: ClarificationFilter): ClarificationListRow[] {
  if (filter === "resolved") return rows.sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.overdueMinutes ?? 0) - (a.overdueMinutes ?? 0) ||
      (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
      (a.nextFollowUpAt ? Date.parse(a.nextFollowUpAt) : Infinity) - (b.nextFollowUpAt ? Date.parse(b.nextFollowUpAt) : Infinity) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

function activeHoldsByClarification(db: DB): Map<string, HoldRow[]> {
  const rows = db.prepare("SELECT * FROM hold WHERE status = 'active' AND clarification_id IS NOT NULL ORDER BY display_id").all() as HoldRow[];
  const m = new Map<string, HoldRow[]>();
  for (const h of rows) {
    const list = m.get(h.clarification_id!) ?? [];
    list.push(h);
    m.set(h.clarification_id!, list);
  }
  return m;
}

// ------------------------------------------------------------------ list

export interface ClarificationQueue {
  filter: ClarificationFilter;
  rows: ClarificationListRow[];
  counts: Record<ClarificationFilter, number>;
  total: number;
  now: string;
  sortNote: string;
}

export function listClarifications(db: DB, opts: { filter?: ClarificationFilter | null; actorId: string; now: string }): ClarificationQueue {
  const base = db.prepare(BASE_SQL).all() as BaseRow[];
  const holds = activeHoldsByClarification(db);
  const all = base.map((r) => toListRow(r, holds, opts.now, (h) => holdScope(db, h).short));
  const myTasks = new Set(
    (db
      .prepare("SELECT entity_id FROM task WHERE entity_type IN ('clarification','hold') AND status IN ('open','in_progress') AND owner_id = ?")
      .all(opts.actorId) as { entity_id: string }[]).map((t) => t.entity_id),
  );
  const counts = Object.fromEntries(
    CLARIFICATION_FILTERS.map((f) => [f.key, all.filter((r) => matches(r, f.key, opts.actorId, myTasks)).length]),
  ) as Record<ClarificationFilter, number>;
  const filter: ClarificationFilter = opts.filter ?? (counts.my_open > 0 ? "my_open" : "all");
  const rows = sortRows(all.filter((r) => matches(r, filter, opts.actorId, myTasks)), filter);
  return {
    filter,
    rows,
    counts,
    total: all.length,
    now: opts.now,
    sortNote: filter === "resolved" ? "Sorted: most recently closed first" : "Sorted: overdue and delivery problems first, then lead reviews and releases, then follow-ups",
  };
}

/**
 * What needs attention across the whole desk (derived, read only), for the
 * landing pane when no question is open: overdue or undelivered questions
 * first, then office answers a lead must review or resolve. Takes the rows of
 * the "all" list (already in urgency order); never changes anything.
 */
export interface DeskAttention {
  /** Open, and overdue or with a failed or unknown delivery. */
  problems: ClarificationListRow[];
  /** Answered or reviewed (and not already listed above): a lead acts next. */
  toReview: ClarificationListRow[];
  /** Resolved or canceled, but a hold it placed is still active: a lead releases it, with a reason. */
  toRelease: ClarificationListRow[];
}

export function deskAttention(allRows: ClarificationListRow[]): DeskAttention {
  const open = allRows.filter((r) => r.isOpen);
  const problems = open.filter((r) => r.overdueMinutes !== null || r.state === "delivery_failed" || r.state === "delivery_unknown");
  const listed = new Set(problems.map((r) => r.id));
  return {
    problems,
    toReview: open.filter((r) => (r.state === "answered" || r.state === "reviewed") && !listed.has(r.id)),
    toRelease: allRows.filter((r) => !r.isOpen && r.holdToRelease),
  };
}

// ------------------------------------------------------------------ detail

/** Other active holds that apply to these scopes (excluding the hold being described). */
function otherHolds(db: DB, scopes: Scope[], exceptId: string): HoldRow[] {
  return activeHolds(db, scopes).filter((x) => x.id !== exceptId);
}

function orderPartScopes(db: DB, orderPartId: string): Scope[] {
  const scopes: Scope[] = [{ type: "order_part", id: orderPartId }];
  for (const c of db.prepare("SELECT id FROM container WHERE order_part_id = ?").all(orderPartId) as { id: string }[]) scopes.push({ type: "container", id: c.id });
  for (const sp of db.prepare("SELECT id FROM specimen_part WHERE source_order_part_id = ?").all(orderPartId) as { id: string }[]) scopes.push(...scopesForPart(db, sp.id));
  return scopes;
}

/** "Part A (ORD-77120) can continue." / "Part C is held separately (H-0461)." */
function siblingSentence(sibs: { label: string; holds: HoldRow[] }[]): string {
  const free = sibs.filter((x) => !x.holds.length).map((x) => x.label);
  const held = sibs.filter((x) => x.holds.length);
  const parts: string[] = [];
  if (free.length) parts.push(`${joinNames(free)} can continue.`);
  for (const x of held) parts.push(`${x.label} is held separately (${x.holds.map((h) => h.display_id).join(", ")}).`);
  return parts.join(" ");
}

function holdScope(db: DB, h: HoldRow): { short: string; note: string } {
  if (h.scope_type === "specimen_part") {
    const p = db.prepare("SELECT accession_id, designation FROM specimen_part WHERE id = ?").get(h.scope_id) as { accession_id: string; designation: string } | undefined;
    if (!p) return { short: h.scope_label, note: "" };
    const sib = db.prepare("SELECT id, designation FROM specimen_part WHERE accession_id = ? AND id <> ? AND status = 'active' ORDER BY designation").all(p.accession_id, h.scope_id) as { id: string; designation: string }[];
    return {
      short: `Part ${p.designation}`,
      note: sib.length ? siblingSentence(sib.map((x) => ({ label: `Part ${x.designation}`, holds: otherHolds(db, scopesForPart(db, x.id), h.id) }))) : "It is the only part on this case.",
    };
  }
  if (h.scope_type === "order_part" || h.scope_type === "container") {
    const opId =
      h.scope_type === "order_part"
        ? h.scope_id
        : ((db.prepare("SELECT order_part_id FROM container WHERE id = ?").get(h.scope_id) as { order_part_id: string | null } | undefined)?.order_part_id ?? null);
    if (!opId) return { short: h.scope_label, note: "Other containers are not held by it." };
    const p = db
      .prepare("SELECT p.designation, p.source_order_id, o.encounter_id, o.patient_ref_id FROM source_order_part p JOIN source_order o ON o.id = p.source_order_id WHERE p.id = ?")
      .get(opId) as { designation: string; source_order_id: string; encounter_id: string | null; patient_ref_id: string } | undefined;
    if (!p) return { short: h.scope_label, note: "" };
    // Sibling parts: same order, or another order from the same patient encounter (e.g. parts A/B entered as two orders).
    const sib = db
      .prepare(
        `SELECT DISTINCT p.id, p.designation, so.source_order_id AS ord FROM source_order_part p JOIN source_order so ON so.id = p.source_order_id
          WHERE p.id <> ? AND p.status = 'active'
            AND (p.source_order_id = ? OR (so.encounter_id IS NOT NULL AND so.encounter_id = ? AND so.patient_ref_id = ?))
          ORDER BY p.designation`,
      )
      .all(opId, p.source_order_id, p.encounter_id, p.patient_ref_id) as { id: string; designation: string; ord: string }[];
    const short = h.scope_type === "container" ? `the Part ${p.designation} container` : `Part ${p.designation}`;
    return { short, note: siblingSentence(sib.map((x) => ({ label: `Part ${x.designation} (${x.ord})`, holds: otherHolds(db, orderPartScopes(db, x.id), h.id) }))) };
  }
  if (h.scope_type === "intake_item") return { short: h.scope_label, note: "Other intake items are not held by it." };
  if (h.scope_type === "accession") return { short: `the whole case (${h.scope_label})`, note: "" };
  return { short: h.scope_label, note: "" };
}

function holdScopeText(db: DB, h: HoldRow): string {
  const { short, note } = holdScope(db, h);
  return h.scope_type === "accession" ? `Holding ${short}.` : `Holding ${short} only.${note ? ` ${note}` : ""}`;
}

function holdView(db: DB, staff: Map<string, { name: string; role: string }>, h: HoldRow): HoldView {
  const blocks = blockedTransitions(h);
  const scope = holdScope(db, h);
  return {
    id: h.id,
    displayId: h.display_id,
    status: h.status,
    version: h.version,
    scopeLabel: h.scope_label,
    scopeShort: scope.short,
    siblingNote: scope.note,
    scopeText: holdScopeText(db, h),
    blocks,
    blockLabels: blocks.map((b) => TRANSITION_LABEL[b] ?? b),
    reasonText: h.reason_text,
    placedAt: h.placed_at,
    placedByName: actorName(staff, h.placed_by),
    releasedAt: h.released_at,
    releasedByName: h.released_by ? actorName(staff, h.released_by) : null,
    releaseReason: h.release_reason,
  };
}

const KIND_LABEL: Record<string, string> = {
  initial: "Initial notice",
  reminder: "Reminder",
  escalation: "Escalation",
  answer: "Office answer",
  acknowledgement: "Acknowledgement",
  delivery_receipt: "Delivery outcome",
};

const DELIVERY_LABEL: Record<string, string> = {
  delivered: "Delivered (simulated)",
  delivery_unknown: "Delivery unknown",
  failed: "Delivery failed (simulated)",
  simulated_sent: "Sent (simulated)",
  received: "Received",
};

const ORIGIN_LABEL: Record<string, string> = {
  user: "Local",
  system: "System",
  simulator: "Simulated",
  assistant: "Demo assistant",
  import: "Source (simulated)",
  demo: "Demo control",
};

interface TimelineFacts {
  lastOutboundState: string | null;
  lastOutboundAt: string | null;
  simulatedAnswer: boolean;
  /** The answer on file was marked insufficient by a reviewer (the clarification went back to waiting on the office). */
  answerInsufficient: boolean;
}

/** Audit actions that record each timeline step (a step can be recorded by either). */
const STEP_AUDIT: Record<string, string[]> = {
  sent: ["clarification.sent"],
  delivery: ["clarification.delivery_outcome", "clarification.sent"],
  acknowledged: ["clarification.acknowledged"],
  answered: ["clarification.answered"],
  reviewed: ["clarification.reviewed", "clarification.answer_insufficient"],
  resolved: ["clarification.resolved"],
};

function buildTimeline(r: ClarificationRow, staff: Map<string, { name: string; role: string }>, audits: { action: string; actor_id: string | null; at: string }[], facts: TimelineFacts): TimelineStep[] {
  const latest = (action: string) => {
    for (let i = audits.length - 1; i >= 0; i--) if (audits[i].action === action) return audits[i];
    return undefined;
  };
  const actorFor = (action: string) => {
    const a = latest(action);
    return a ? actorName(staff, a.actor_id) : null;
  };
  const { lastOutboundState, lastOutboundAt } = facts;
  const order: ClarificationState[] = ["drafted", "sent", "delivered", "acknowledged", "answered", "reviewed", "resolved"];
  const deliveryState: ClarificationState | null =
    r.state === "delivery_failed" || r.state === "delivery_unknown" ? r.state : r.delivered_at ? "delivered" : lastOutboundState === "failed" ? "delivery_failed" : lastOutboundState === "delivery_unknown" ? "delivery_unknown" : null;
  const currentIdx = (() => {
    if (r.state === "canceled") return -1;
    const s = r.state === "delivery_failed" || r.state === "delivery_unknown" ? "delivered" : r.state;
    return order.indexOf(s);
  })();
  const steps: TimelineStep[] = [];
  const push = (key: string, label: string, at: string | null, actor: string | null, detail: string | null, idx: number, tone: Tone) => {
    const status: TimelineStep["status"] = at ? (idx === currentIdx ? "current" : "done") : idx === currentIdx ? "current" : idx < currentIdx ? "skipped" : "pending";
    steps.push({ key, label, at, actorName: actor, detail, status, tone });
  };
  push(
    "drafted",
    "Drafted",
    r.created_at,
    actorName(staff, r.created_by),
    r.draft_source === "assistant_proposal"
      ? "Question started from the deterministic demo drafter, edited by a person"
      : r.draft_source === "template"
        ? "Question from the fixed template (rule-based, not AI)"
        : null,
    0,
    "neutral",
  );
  push("sent", "Sent (simulated)", r.sent_at, actorFor("clarification.sent"), r.sent_at ? "Generic notice only; the question itself is not in the notice" : null, 1, "info");
  const deliveryLabel = deliveryState === "delivery_failed" ? "Delivery failed" : deliveryState === "delivery_unknown" ? "Delivery unknown" : "Delivered";
  const deliveryAt = deliveryState === "delivered" ? r.delivered_at : deliveryState ? lastOutboundAt : null;
  push(
    "delivery",
    deliveryLabel,
    deliveryAt,
    // Whoever reported the latest outcome: the simulated connector, or a staff member who confirmed it.
    deliveryAt ? actorFor("clarification.delivery_outcome") : null,
    deliveryState === "delivery_unknown" ? "No delivery confirmation" : deliveryState === "delivery_failed" ? "Not delivered" : null,
    2,
    deliveryState === "delivery_failed" ? "danger" : deliveryState === "delivery_unknown" ? "warning" : "info",
  );
  push(
    "acknowledged",
    "Acknowledged",
    r.acknowledged_at,
    r.acknowledged_at ? actorFor("clarification.acknowledged") : null,
    !r.acknowledged_at && r.answered_at ? "Not recorded separately; the office answered directly" : null,
    3,
    "info",
  );
  const reviewer = r.reviewer_id ? actorName(staff, r.reviewer_id) : "Unknown";
  push(
    "answered",
    facts.answerInsufficient ? "Answered (marked insufficient)" : "Answered",
    r.answered_at,
    r.answered_by_contact,
    r.answered_at
      ? facts.answerInsufficient
        ? `${reviewer} marked it insufficient${r.review_note ? `: ${r.review_note}` : ""}. Waiting for a further answer.`
        : facts.simulatedAnswer
          ? "Simulated office reply"
          : ((ANSWER_CHANNELS as Record<string, string>)[r.answer_channel ?? ""] ?? r.answer_channel)
      : null,
    4,
    facts.answerInsufficient ? "warning" : "info",
  );
  push("reviewed", "Reviewed", r.reviewed_at, r.reviewed_at && r.reviewer_id ? actorName(staff, r.reviewer_id) : null, null, 5, "info");
  push("resolved", "Resolved", r.resolved_at, r.resolved_by ? actorName(staff, r.resolved_by) : null, null, 6, "success");
  if (r.state === "canceled") {
    const a = latest("clarification.canceled");
    steps.push({ key: "canceled", label: "Canceled", at: a?.at ?? null, actorName: a ? actorName(staff, a.actor_id) : null, detail: r.resolution_note, status: "current", tone: "neutral" });
  }
  return steps;
}

function action(key: ActionKey, label: string, command: string, role: Role, primary = false, extra: { reason?: string | null; demo?: boolean; disabled?: boolean } = {}): ActionView {
  const perm = PERMISSION_FOR[key];
  let enabled = !extra.disabled;
  let reason = extra.reason ?? null;
  if (perm && !roleCan(role, perm)) {
    enabled = false;
    reason = `Not allowed for ${ROLE_LABEL[role]}. Allowed: ${rolesFor(perm).map((r) => ROLE_LABEL[r]).join(", ")}.`;
  }
  return { key, label, command, enabled, reason: enabled ? null : reason, primary, demo: extra.demo };
}

function buildActions(
  r: ClarificationRow,
  role: Role,
  activeHolds: number,
  reminder: { suppressedNow: boolean; lastSentAt: string | null; nextAllowedAt: string | null },
  escalation: { suppressed: boolean; lastSentAt: string | null; nextAllowedAt: string | null },
  now: string,
): ActionView[] {
  const suppressedReason = reminder.suppressedNow
    ? `A message was already sent at ${fmtSmart(reminder.lastSentAt, now)} ET. Next reminder allowed at ${fmtSmart(reminder.nextAllowedAt, now)} ET.`
    : null;
  const escalationReason = escalation.suppressed
    ? `Already escalated at ${fmtSmart(escalation.lastSentAt, now)} ET. Next escalation allowed at ${fmtSmart(escalation.nextAllowedAt, now)} ET.`
    : null;
  const followUp = (primary = false) => action("followUp", "Send reminder (simulated)", "clarification.followUp", role, primary, { disabled: reminder.suppressedNow, reason: suppressedReason });
  // Past the follow-up time the next step is a reminder (unless one was just sent), not waiting for an answer.
  const overdue = !!r.next_follow_up_at && Date.parse(r.next_follow_up_at) <= Date.parse(now) && !reminder.suppressedNow;
  const recordDelivery = (primary = false) => action("recordDelivery", "Record delivery outcome", "clarification.recordDelivery", role, primary);
  const escalate = (primary = false) => action("escalate", "Escalate", "clarification.escalate", role, primary, { disabled: escalation.suppressed, reason: escalationReason });
  const cancel = action("cancel", "Cancel clarification", "clarification.cancel", role);
  const sim = (disabled = false, reason: string | null = null) =>
    action("simulateAnswer", "Simulate office answer (demo)", "clarification.simulateOfficeAnswer", role, false, { demo: true, disabled, reason });
  const release = action("releaseHold", "Release hold", "hold.release", role, true);
  switch (r.state) {
    case "drafted":
      return [
        action("send", "Send (simulated)", "clarification.send", role, true),
        action("draft", "Draft with assistant", "clarification.draftMessage", role),
        sim(true, "Send the clarification first. The office can only answer a sent question."),
        cancel,
      ];
    case "delivery_failed":
      return [
        escalate(true),
        followUp(),
        action("recordAnswer", "Record office answer", "clarification.recordAnswer", role),
        recordDelivery(),
        sim(true, "The simulated office never received this message (delivery failed)."),
        cancel,
      ];
    case "delivery_unknown":
      // No confirmation from the connector: phone the office (spec §6.2), then record what you learned.
      return [
        recordDelivery(true),
        action("recordAnswer", "Record office answer", "clarification.recordAnswer", role),
        action("recordAck", "Record acknowledgment", "clarification.recordAck", role),
        followUp(),
        escalate(),
        sim(),
        cancel,
      ];
    case "sent":
    case "delivered":
      return [
        ...(overdue ? [followUp(true)] : []),
        action("recordAnswer", "Record office answer", "clarification.recordAnswer", role, !overdue),
        action("recordAck", "Record acknowledgment", "clarification.recordAck", role),
        ...(overdue ? [] : [followUp()]),
        escalate(),
        ...(r.state !== "delivered" ? [recordDelivery()] : []),
        sim(),
        cancel,
      ];
    case "acknowledged":
      return overdue
        ? [followUp(true), action("recordAnswer", "Record office answer", "clarification.recordAnswer", role), escalate(), sim(), cancel]
        : [action("recordAnswer", "Record office answer", "clarification.recordAnswer", role, true), followUp(), escalate(), sim(), cancel];
    case "answered":
      return [action("review", "Review answer", "clarification.review", role, true), cancel];
    case "reviewed":
      return [action("resolve", "Resolve", "clarification.resolve", role, true), cancel];
    default:
      return activeHolds ? [release] : [];
  }
}

export function getClarificationDetail(db: DB, idOrDisplay: string, opts: { now: string; role: Role }): ClarificationDetail | null {
  const r = db.prepare(`${BASE_SQL} WHERE c.id = ? OR c.display_id = ?`).get(idOrDisplay, idOrDisplay) as BaseRow | undefined;
  if (!r) return null;
  const { now, role } = opts;
  const staff = staffNames(db);
  const holdsAll = db.prepare("SELECT * FROM hold WHERE clarification_id = ? ORDER BY placed_at, display_id").all(r.id) as HoldRow[];
  const activeMap = new Map<string, HoldRow[]>([[r.id, holdsAll.filter((h) => h.status === "active")]]);
  const row = toListRow(r, activeMap, now, (h) => holdScope(db, h).short);
  const info = subjectContext(db, r);

  // Patient (synthetic) and tenant, for identity while editing.
  const pat = (r.source_order_id
    ? db
        .prepare("SELECT p.given_name, p.family_name, p.source_mrn, t.name tenant FROM source_order o JOIN patient_ref p ON p.id = o.patient_ref_id JOIN source_tenant t ON t.id = p.tenant_id WHERE o.id = ?")
        .get(r.source_order_id)
    : r.accession_id
      ? db
          .prepare("SELECT p.given_name, p.family_name, p.source_mrn, t.name tenant FROM accession a JOIN patient_ref p ON p.id = a.patient_ref_id JOIN source_tenant t ON t.id = p.tenant_id WHERE a.id = ?")
          .get(r.accession_id)
      : undefined) as { given_name: string; family_name: string; source_mrn: string; tenant: string } | undefined;

  const office = db.prepare("SELECT id, name, status, working_hours, timezone FROM office WHERE id = ?").get(r.office_id) as { id: string; name: string; status: string; working_hours: string; timezone: string };
  const sel = selectContact(db, r.office_id, r.category, now);
  const selected = r.contact_id ? ((db.prepare("SELECT * FROM office_contact WHERE id = ?").get(r.contact_id) as ContactRow | undefined) ?? null) : null;
  const expected = simulateDeliveryOutcome(db, sel.contact, now);

  const messagesRaw = db.prepare("SELECT * FROM clarification_message WHERE clarification_id = ? ORDER BY created_at, id").all(r.id) as {
    id: string; direction: "outbound" | "inbound"; kind: string; channel: string; recipient_contact_id: string | null; body: string; delivery_state: string; is_simulated: number; created_at: string; created_by: string | null;
  }[];
  const contactNames = new Map(
    (db.prepare("SELECT id, display_name FROM office_contact WHERE office_id = ?").all(r.office_id) as { id: string; display_name: string }[]).map((c) => [c.id, c.display_name]),
  );
  const messages: MessageView[] = messagesRaw.map((m) => ({
    id: m.id,
    direction: m.direction,
    kind: m.kind,
    kindLabel: KIND_LABEL[m.kind] ?? m.kind,
    channelLabel: m.channel === "staff_recorded" ? "Recorded by staff" : (ANSWER_CHANNELS as Record<string, string>)[m.channel] ?? channelLabel(m.channel),
    recipientName: m.recipient_contact_id ? (contactNames.get(m.recipient_contact_id) ?? null) : null,
    body: m.body,
    deliveryState: m.delivery_state,
    deliveryLabel: DELIVERY_LABEL[m.delivery_state] ?? m.delivery_state,
    createdAt: m.created_at,
    createdByName: m.created_by ? actorName(staff, m.created_by) : null,
    simulated: m.is_simulated === 1,
  }));
  const lastOutbound = [...messagesRaw].reverse().find((m) => m.direction === "outbound");

  const holdIds = holdsAll.map((h) => h.id);
  const ids = [r.id, ...holdIds];
  const auditRows = db
    .prepare(
      `SELECT seq, at, actor_id, actor_role, origin, action, summary, reason FROM audit_event
        WHERE (entity_id IN (${ids.map(() => "?").join(",")}))
           OR (entity_type = 'source_order' AND entity_id = ? AND action LIKE 'simulator.%')
        ORDER BY seq`,
    )
    .all(...ids, r.source_order_id ?? "") as { seq: number; at: string; actor_id: string | null; actor_role: string | null; origin: string; action: string; summary: string; reason: string | null }[];
  const history: HistoryEntry[] = auditRows
    .map((a) => ({
      seq: a.seq,
      at: a.at,
      actorName: actorName(staff, a.actor_id),
      actorRoleLabel: a.actor_id && (a.actor_id.startsWith("sim_") || a.actor_id === "system") ? null : a.actor_role && (ROLE_LABEL as Record<string, string>)[a.actor_role] ? (ROLE_LABEL as Record<string, string>)[a.actor_role] : null,
      origin: a.origin,
      originLabel: ORIGIN_LABEL[a.origin] ?? a.origin,
      action: a.action,
      summary: a.summary,
      reason: a.reason,
    }))
    .reverse();

  const win = reminderWindow(db, r, now);
  const reminder = { lastSentAt: win.lastSentAt, nextAllowedAt: win.nextAllowedAt, suppressedNow: win.suppressed && AWAITING_OFFICE_STATES.includes(r.state), count: r.follow_up_count, suppressionMinutes: REMINDER_SUPPRESSION_MINUTES };

  let deliveryGuidance: ClarificationDetail["deliveryGuidance"] = null;
  if (r.state === "delivery_unknown") {
    deliveryGuidance = { tone: "warning", title: "Delivery unknown", body: "No delivery confirmation from the simulated notification connector. Follow up by phone per local policy." };
  } else if (r.state === "delivery_failed") {
    deliveryGuidance = {
      tone: "danger",
      title: "Delivery failed (simulated)",
      body: `The simulated connector could not deliver the last notice.${sel.coverageNote ? ` Now: ${sel.coverageNote}` : ""} Send a reminder, escalate to the office's escalation contact, or phone the office per local policy, then record the answer.`,
    };
  } else if (r.state === "drafted") {
    deliveryGuidance = { tone: "info", title: "Not sent yet", body: "Nothing has left the lab. Sending uses the simulated notification connector; no real office is contacted." };
  }

  const audits = auditRows.map((a) => ({ action: a.action, actor_id: a.actor_id, at: a.at }));
  // Where the answer came from is decided by the record (who wrote the answer message), never by the answer's text.
  const lastAnswerMsg = [...messagesRaw].reverse().find((m) => m.direction === "inbound" && m.kind === "answer");
  const simulatedAnswer = lastAnswerMsg?.created_by === SIM_OFFICE_ACTOR_ID;
  // The only way back from "answered" to waiting on the office is a review that marked the answer insufficient.
  const answerInsufficient = !!r.answer_text && AWAITING_OFFICE_STATES.includes(r.state);
  const evidence = parseEvidence(r.evidence);
  const amendmentRow = evidence.find((e) => e.superseded_by_amendment);
  const escalationWin = escalationWindow(db, r, now);
  const timeline = buildTimeline(r, staff, audits, {
    lastOutboundState: lastOutbound?.delivery_state ?? null,
    lastOutboundAt: lastOutbound?.created_at ?? null,
    simulatedAnswer,
    answerInsufficient,
  });
  return {
    row,
    question: r.question,
    draftSource: r.draft_source,
    evidence,
    subject: {
      // Identity questions cover every container of the item; do not present them as one part's question.
      partDesignation: r.category === "identity_conflict" ? null : info.partDesignation,
      orderRef: info.orderRef,
      sourceOrderId: r.source_order_id,
      accessionNumber: info.accessionNumber,
      accessionId: r.accession_id,
      intakeDisplayId: info.intakeDisplayId,
      intakeItemId: r.intake_item_id,
      patient: pat ? { name: `${pat.given_name} ${pat.family_name}`, mrn: pat.source_mrn, tenant: pat.tenant } : null,
      orderTenant: pat?.tenant ?? null,
    },
    office: { id: office.id, name: office.name, status: office.status, workingHoursText: formatWorkingHours(parseWorkingHours(office.working_hours)), timezone: office.timezone },
    contact: {
      selected: contactView(selected, now),
      primary: contactView(sel.primary, now),
      backup: contactView(sel.backup, now),
      escalation: contactView(sel.escalation, now),
      coverageNoteNow: sel.coverageNote,
      currentRecipient: contactView(sel.contact, now),
      routedToBackup: !!selected && !!sel.primary && selected.id !== sel.primary.id && sel.primary.backup_contact_id === selected.id,
      expectedOutcomeNow: expected,
    },
    people: {
      labOwner: actorName(staff, r.lab_owner_id),
      escalationOwner: r.escalation_owner_id ? actorName(staff, r.escalation_owner_id) : null,
      createdBy: actorName(staff, r.created_by),
      reviewer: r.reviewer_id ? actorName(staff, r.reviewer_id) : null,
      resolvedBy: r.resolved_by ? actorName(staff, r.resolved_by) : null,
    },
    priorityRule: `${r.priority[0].toUpperCase()}${r.priority.slice(1)}: follow up ${FOLLOW_UP_MINUTES[r.priority as keyof typeof FOLLOW_UP_MINUTES] ?? 60} working minutes after each message, within office hours.`,
    holds: holdsAll.map((h) => holdView(db, staff, h)),
    timeline,
    stepsWithoutAudit: timeline
      .filter((st) => st.at && STEP_AUDIT[st.key] && !STEP_AUDIT[st.key].some((act) => auditRows.some((a) => a.action === act)))
      .map((st) => st.label),
    messages,
    history,
    answer: r.answer_text
      ? {
          text: r.answer_text,
          by: r.answered_by_contact,
          channelLabel: simulatedAnswer ? "Simulated office reply" : (ANSWER_CHANNELS as Record<string, string>)[r.answer_channel ?? ""] ?? r.answer_channel ?? "Unknown channel",
          at: r.answered_at,
          simulated: simulatedAnswer,
          markedInsufficient: answerInsufficient,
        }
      : null,
    review: r.reviewed_at || r.review_note ? { byName: r.reviewer_id ? actorName(staff, r.reviewer_id) : null, at: r.reviewed_at, note: r.review_note } : null,
    resolution:
      r.state === "resolved"
        ? { code: r.resolution_code, codeLabel: r.resolution_code ? ((RESOLUTION_CODES as Record<string, string>)[r.resolution_code] ?? r.resolution_code) : null, note: r.resolution_note, byName: r.resolved_by ? actorName(staff, r.resolved_by) : null, at: r.resolved_at }
        : null,
    cancelReason: r.state === "canceled" ? r.resolution_note : null,
    reminder,
    escalatedAt: r.escalated_at,
    amendment: amendmentRow?.superseded_by_amendment
      ? { label: amendmentRow.superseded_by_amendment, at: evidence.find((e) => e.recorded_at)?.recorded_at ?? null }
      : null,
    deliveryGuidance,
    actions: buildActions(r, role, holdsAll.filter((h) => h.status === "active").length, reminder, escalationWin, now),
    assistantMode: assistantMode(db),
    notificationPreview: genericBody("initial", r.display_id).replace(` ${SIMULATED_TAG}`, ""),
    resolutionCodes: Object.entries(RESOLUTION_CODES).map(([code, label]) => ({ code, label })),
    answerChannels: Object.entries(ANSWER_CHANNELS).map(([code, label]) => ({ code, label })),
  };
}

/** Label for the full state name (used in panel headers and announcements). */
export function clarificationStateText(state: ClarificationState): string {
  return CLARIFICATION_STATE[state] ?? state;
}
