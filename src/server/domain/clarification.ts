import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import type { Role } from "@/lib/roles";
import { DomainError } from "../core/errors";
import { displayId as nextDisplayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { closeTasks, openTask } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { blockedTransitions, placeHold, releaseHold, type HoldRow, type HoldTransition, type Scope, type ScopeType } from "./holds";
import {
  CLARIFICATION_CATEGORY,
  CLARIFICATION_STATE,
  OPEN_CLARIFICATION_STATES,
  type ClarificationCategory,
  type ClarificationState,
} from "@/lib/domain";
import { fmtSmart, fmtTime, labDay, labLocalToIso, LAB_TZ } from "@/lib/time";
import {
  genericBody,
  recordInboundMessage,
  sendSimulatedNotification,
  channelLabel,
  type ContactRow,
  type DeliveryOutcome,
} from "../sim/notifications";
import { assistantMode, draftClarification, templateQuestion, type DraftOutput } from "../assist/drafter";

/**
 * Clarifications that close the loop (spec §6).
 *
 * States: drafted → sent → delivered | delivery_unknown | delivery_failed →
 * acknowledged → answered → reviewed → resolved, plus canceled. Sending a
 * message never moves a clarification past the send/delivery states; an
 * answer never resolves it; resolution requires a lead/supervisor review
 * first. Holds are released only by explicit, separately audited releases.
 * All office notifications are SIMULATED (src/server/sim/notifications.ts).
 */

// ------------------------------------------------------------------ constants

export type Priority = "routine" | "high" | "urgent";
export const FOLLOW_UP_MINUTES: Record<Priority, number> = { urgent: 15, high: 30, routine: 60 };
/** No second reminder (or escalation) within this window. */
export const REMINDER_SUPPRESSION_MINUTES = 30;
/** After this many reminders without an answer the escalation owner gets a task. */
export const ESCALATE_AFTER_REMINDERS = 2;

export const RESOLUTION_CODES = {
  confirmed_observed: "Office confirmed what we observed (container is correct)",
  confirmed_order: "Office confirmed the order is correct",
  source_amended: "Office amended the order in the source system",
  other: "Other (see note)",
} as const;
export type ResolutionCode = keyof typeof RESOLUTION_CODES;

export const ANSWER_CHANNELS = {
  phone_recorded_by_staff: "Phone call (recorded by staff)",
  simulated_portal: "Office portal (simulated)",
  simulated_ema_message: "EMA message (simulated)",
  other_recorded_by_staff: "Other channel (recorded by staff)",
} as const;
export type AnswerChannel = keyof typeof ANSWER_CHANNELS;

/** States in which the lab is waiting on the office. */
export const AWAITING_OFFICE_STATES: ClarificationState[] = ["sent", "delivery_unknown", "delivery_failed", "delivered", "acknowledged"];
const DELIVERY_FAMILY: ClarificationState[] = ["sent", "delivery_unknown", "delivery_failed", "delivered"];

export const TASK_KINDS = {
  followup: "clarification_followup",
  review: "clarification_review",
  escalation: "clarification_escalation",
  holdDecision: "hold_release_decision",
} as const;

// ------------------------------------------------------------------ rows

export interface ClarificationRow {
  id: string;
  display_id: string;
  category: ClarificationCategory;
  intake_item_id: string | null;
  source_order_id: string | null;
  order_part_id: string | null;
  container_id: string | null;
  accession_id: string | null;
  specimen_part_id: string | null;
  subject_label: string;
  question: string;
  evidence: string;
  office_id: string;
  contact_role: string;
  contact_id: string | null;
  lab_owner_id: string;
  escalation_owner_id: string | null;
  priority: Priority;
  state: ClarificationState;
  draft_source: string;
  created_at: string;
  created_by: string;
  sent_at: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  answered_at: string | null;
  reviewed_at: string | null;
  resolved_at: string | null;
  next_follow_up_at: string | null;
  follow_up_count: number;
  escalated_at: string | null;
  answer_text: string | null;
  answered_by_contact: string | null;
  answer_channel: string | null;
  reviewer_id: string | null;
  review_note: string | null;
  resolution_code: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  dedupe_key: string;
  version: number;
}

export interface EvidenceItem {
  field: string;
  order_value: string | null;
  observed_value: string | null;
  requisition_value?: string | null;
  source?: string | null;
  note?: string | null;
  /** Added by the source import (S6) when an amended order version changed this value, e.g. "ORD-77121 v2". */
  superseded_by_amendment?: string | null;
  /** The amended order value from that version (S6). */
  amended_order_value?: string | null;
  recorded_at?: string | null;
}

/** The row the source import appends to describe an amendment (it has no observed value by design). */
export function isAmendmentRow(e: EvidenceItem): boolean {
  return /^source amendment$/i.test(String(e.field ?? "").trim());
}

export interface ClarificationRefs {
  intakeItemId?: string | null;
  sourceOrderId?: string | null;
  orderPartId?: string | null;
  containerId?: string | null;
  accessionId?: string | null;
  specimenPartId?: string | null;
}

interface NormalRefs {
  intakeItemId: string | null;
  sourceOrderId: string | null;
  orderPartId: string | null;
  containerId: string | null;
  accessionId: string | null;
  specimenPartId: string | null;
}

// ------------------------------------------------------------------ lookups

export function findClarification(db: DB, idOrDisplay: string): ClarificationRow | undefined {
  return db.prepare("SELECT * FROM clarification WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as ClarificationRow | undefined;
}

export function getClarification(db: DB, idOrDisplay: string): ClarificationRow {
  const row = findClarification(db, idOrDisplay);
  if (!row) throw new DomainError("NOT_FOUND", `Clarification ${idOrDisplay} was not found`);
  return row;
}

export function parseEvidence(json: string | null | undefined): EvidenceItem[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as EvidenceItem[]) : [];
  } catch {
    return [];
  }
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Normalize evidence from any caller (intake, grossing, manual) into one shape. */
export function normalizeEvidence(items: Record<string, unknown>[]): EvidenceItem[] {
  return items
    .map((e) => ({
      field: toText(e.field ?? e.label ?? e.name) ?? "Field",
      order_value: toText(e.order_value ?? e.orderValue ?? e.order),
      observed_value: toText(e.observed_value ?? e.observedValue ?? e.observed),
      requisition_value: toText(e.requisition_value ?? e.requisitionValue ?? e.requisition),
      source: toText(e.source),
      note: toText(e.note),
    }))
    .filter((e) => e.field.trim().length > 0);
}

export function escalationOwnerId(db: DB): string | null {
  const row = db.prepare("SELECT id FROM staff WHERE role = 'accessioning_lead' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function staffName(db: DB, id: string | null | undefined): string {
  if (!id) return "Unassigned";
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

function officeName(db: DB, id: string): string {
  const r = db.prepare("SELECT name FROM office WHERE id = ?").get(id) as { name: string } | undefined;
  return r?.name ?? "Unknown office";
}

// ------------------------------------------------------------------ working hours

export type WorkingHours = Partial<Record<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat", [string, string][]>>;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, weekday: "short" });

export function parseWorkingHours(json: string | null | undefined): WorkingHours | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as WorkingHours;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function weekdayOf(day: string): (typeof WEEKDAYS)[number] {
  const w = weekdayFmt.format(new Date(labLocalToIso(day, "12:00"))).toLowerCase().slice(0, 3);
  return (WEEKDAYS as readonly string[]).includes(w) ? (w as (typeof WEEKDAYS)[number]) : "mon";
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** "Mon–Thu 08:00–17:00; Fri 08:00–16:00" */
export function formatWorkingHours(h: WorkingHours | null): string {
  if (!h) return "Unknown (no working hours on file)";
  const label: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const groups: { days: string[]; spec: string }[] = [];
  for (const d of order) {
    const spec = (h[d] ?? []).map(([a, b]) => `${a}–${b}`).join(", ");
    if (!spec) continue;
    const last = groups[groups.length - 1];
    const prevIdx = last ? order.indexOf(last.days[last.days.length - 1] as (typeof order)[number]) : -2;
    if (last && last.spec === spec && prevIdx === order.indexOf(d) - 1) last.days.push(d);
    else groups.push({ days: [d], spec });
  }
  if (!groups.length) return "No working hours on file";
  return groups
    .map((g) => `${g.days.length > 1 ? `${label[g.days[0]]}–${label[g.days[g.days.length - 1]]}` : label[g.days[0]]} ${g.spec}`)
    .join("; ");
}

/**
 * Add `minutes` of office working time to `startIso`. If the office is closed
 * (or closes before the time is used up), the clock continues at the next
 * opening. Hours are interpreted in America/New_York.
 */
export function addWorkingMinutes(startIso: string, minutes: number, hours: WorkingHours | null): { at: string; adjusted: boolean } {
  const plain = new Date(Date.parse(startIso) + minutes * 60_000).toISOString();
  if (!hours) return { at: plain, adjusted: false };
  let remaining = minutes;
  let cursor = Date.parse(startIso);
  let day = labDay(startIso);
  for (let i = 0; i < 21; i++) {
    const windows = (hours[weekdayOf(day)] ?? []).slice().sort((a, b) => a[0].localeCompare(b[0]));
    for (const [open, close] of windows) {
      const wStart = Date.parse(labLocalToIso(day, open));
      const wEnd = Date.parse(labLocalToIso(day, close));
      const s = Math.max(wStart, cursor);
      if (s >= wEnd) continue;
      const available = (wEnd - s) / 60_000;
      if (available >= remaining) {
        const at = new Date(s + remaining * 60_000).toISOString();
        return { at, adjusted: at !== plain };
      }
      remaining -= available;
      cursor = wEnd;
    }
    day = nextDay(day);
  }
  return { at: plain, adjusted: false };
}

export function computeNextFollowUp(db: DB, officeId: string, fromIso: string, priority: Priority): { at: string; note: string } {
  const office = db.prepare("SELECT working_hours FROM office WHERE id = ?").get(officeId) as { working_hours: string } | undefined;
  const hours = parseWorkingHours(office?.working_hours);
  const mins = FOLLOW_UP_MINUTES[priority] ?? 60;
  const { at, adjusted } = addWorkingMinutes(fromIso, mins, hours);
  const base = `${priority[0].toUpperCase()}${priority.slice(1)} priority: follow up ${mins} working minutes after ${fromIso === at ? "now" : "this point"}`;
  const note = !hours
    ? `${base}. Office hours unknown, so plain clock time is used.`
    : adjusted
      ? `${base}, within office hours (${formatWorkingHours(hours)}). Moved to ${fmtSmart(at, fromIso)} ET because the office is closed in between.`
      : `${base}, within office hours (${formatWorkingHours(hours)}).`;
  return { at, note };
}

// ------------------------------------------------------------------ contact / coverage

export interface ContactSelection {
  contact: ContactRow | null;
  primary: ContactRow | null;
  backup: ContactRow | null;
  escalation: ContactRow | null;
  usedBackup: boolean;
  primaryOut: boolean;
  coverageNote: string | null;
  contactRoleText: string;
}

function coversCategory(c: ContactRow, category: string): boolean {
  try {
    const list = JSON.parse(c.covers_categories) as string[];
    return !Array.isArray(list) || list.length === 0 || list.includes(category);
  } catch {
    return true;
  }
}

function isOut(c: ContactRow | null, now: string): boolean {
  return !!c?.out_until && Date.parse(c.out_until) > Date.parse(now);
}

/** "Biopsy coordinator (MA lead)" → "Biopsy coordinator, MA lead", so it can sit inside parentheses without doubling them. */
function flatRole(role: string): string {
  return role.replace(/\s*\(([^()]*)\)/g, ", $1");
}

/**
 * Pick the office contact from the directory with coverage: the primary
 * contact for this category, unless they are out (out_until > now), in which
 * case their backup receives it, and we say so.
 */
export function selectContact(db: DB, officeId: string, category: string, now: string): ContactSelection {
  const all = db.prepare("SELECT * FROM office_contact WHERE office_id = ? ORDER BY is_primary DESC, id").all(officeId) as ContactRow[];
  const escalation = all.find((c) => c.is_escalation === 1) ?? null;
  const regular = all.filter((c) => c.is_escalation !== 1 && coversCategory(c, category));
  const primary = regular.find((c) => c.is_primary === 1) ?? regular[0] ?? null;
  const backup = primary?.backup_contact_id ? (all.find((c) => c.id === primary.backup_contact_id) ?? null) : null;
  if (!primary) {
    return {
      contact: null, primary: null, backup: null, escalation, usedBackup: false, primaryOut: false,
      coverageNote: "No office contact on file for this category. Delivery cannot be confirmed; phone the office per local policy.",
      contactRoleText: "Office front desk (no contact on file)",
    };
  }
  const primaryOut = isOut(primary, now);
  if (primaryOut && backup && !isOut(backup, now)) {
    return {
      contact: backup, primary, backup, escalation, usedBackup: true, primaryOut,
      coverageNote: `${primary.display_name} (${flatRole(primary.contact_role)}) is out until ${fmtTime(primary.out_until)} ET. Routed to backup ${backup.display_name} (${flatRole(backup.contact_role)}).`,
      contactRoleText: backup.contact_role,
    };
  }
  if (primaryOut) {
    return {
      contact: primary, primary, backup, escalation, usedBackup: false, primaryOut,
      coverageNote: `${primary.display_name} (${flatRole(primary.contact_role)}) is out until ${fmtTime(primary.out_until)} ET and no available backup is on file. Expect delivery to fail; escalate or phone the office.`,
      contactRoleText: primary.contact_role,
    };
  }
  return { contact: primary, primary, backup, escalation, usedBackup: false, primaryOut: false, coverageNote: null, contactRoleText: primary.contact_role };
}

function contactById(db: DB, id: string | null): ContactRow | null {
  if (!id) return null;
  return (db.prepare("SELECT * FROM office_contact WHERE id = ?").get(id) as ContactRow | undefined) ?? null;
}

// ------------------------------------------------------------------ refs, subject, patient identifiers

function exists(db: DB, table: string, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

/** Fill in implied links (part → order, container → intake item, ...) and validate they exist and agree. */
export function normalizeRefs(db: DB, refs: ClarificationRefs): NormalRefs {
  const r: NormalRefs = {
    intakeItemId: refs.intakeItemId ?? null,
    sourceOrderId: refs.sourceOrderId ?? null,
    orderPartId: refs.orderPartId ?? null,
    containerId: refs.containerId ?? null,
    accessionId: refs.accessionId ?? null,
    specimenPartId: refs.specimenPartId ?? null,
  };
  if (!Object.values(r).some(Boolean)) {
    throw new DomainError("VALIDATION", "Name the affected material: an intake item, order, order part, container, case or part.");
  }
  const check = (table: string, id: string | null, what: string) => {
    if (id && !exists(db, table, id)) throw new DomainError("NOT_FOUND", `${what} ${id} was not found`);
  };
  check("intake_item", r.intakeItemId, "Intake item");
  check("source_order", r.sourceOrderId, "Source order");
  check("source_order_part", r.orderPartId, "Order part");
  check("container", r.containerId, "Container");
  check("accession", r.accessionId, "Case");
  check("specimen_part", r.specimenPartId, "Part");

  if (r.specimenPartId) {
    const sp = db.prepare("SELECT accession_id, source_order_id, source_order_part_id, container_id FROM specimen_part WHERE id = ?").get(r.specimenPartId) as {
      accession_id: string; source_order_id: string; source_order_part_id: string; container_id: string | null;
    };
    if (r.accessionId && r.accessionId !== sp.accession_id) throw new DomainError("VALIDATION", "The part does not belong to that case.");
    r.accessionId = sp.accession_id;
    r.orderPartId ??= sp.source_order_part_id;
    r.sourceOrderId ??= sp.source_order_id;
    r.containerId ??= sp.container_id;
  }
  if (r.containerId) {
    const c = db.prepare("SELECT intake_item_id, order_part_id FROM container WHERE id = ?").get(r.containerId) as { intake_item_id: string; order_part_id: string | null };
    if (r.intakeItemId && r.intakeItemId !== c.intake_item_id) throw new DomainError("VALIDATION", "The container does not belong to that intake item.");
    r.intakeItemId = c.intake_item_id;
    r.orderPartId ??= c.order_part_id;
  }
  if (r.orderPartId) {
    const p = db.prepare("SELECT source_order_id FROM source_order_part WHERE id = ?").get(r.orderPartId) as { source_order_id: string };
    if (r.sourceOrderId && r.sourceOrderId !== p.source_order_id) throw new DomainError("VALIDATION", "The order part does not belong to that order.");
    r.sourceOrderId = p.source_order_id;
  }
  if (r.intakeItemId) {
    const ii = db.prepare("SELECT accession_id FROM intake_item WHERE id = ?").get(r.intakeItemId) as { accession_id: string | null };
    r.accessionId ??= ii.accession_id;
    if (!r.sourceOrderId) {
      const links = db.prepare("SELECT source_order_id FROM intake_order_link WHERE intake_item_id = ?").all(r.intakeItemId) as { source_order_id: string }[];
      if (links.length === 1) r.sourceOrderId = links[0].source_order_id;
    }
  }
  if (r.orderPartId && !r.specimenPartId && r.accessionId) {
    const sp = db.prepare("SELECT id FROM specimen_part WHERE source_order_part_id = ? AND accession_id = ?").get(r.orderPartId, r.accessionId) as { id: string } | undefined;
    if (sp) r.specimenPartId = sp.id;
  }
  return r;
}

/** Primary target id plus every id that names the same physical subject (for dedupe). */
function subjectIds(db: DB, r: NormalRefs): { primary: string; equivalents: string[]; partLevel: boolean } {
  const ids = new Set<string>();
  if (r.specimenPartId || r.orderPartId || r.containerId) {
    if (r.specimenPartId) ids.add(r.specimenPartId);
    if (r.orderPartId) {
      ids.add(r.orderPartId);
      for (const s of db.prepare("SELECT id FROM specimen_part WHERE source_order_part_id = ?").all(r.orderPartId) as { id: string }[]) ids.add(s.id);
      for (const c of db.prepare("SELECT id FROM container WHERE order_part_id = ?").all(r.orderPartId) as { id: string }[]) ids.add(c.id);
    }
    if (r.containerId) ids.add(r.containerId);
    const primary = r.specimenPartId ?? r.orderPartId ?? (r.containerId as string);
    return { primary, equivalents: [...ids], partLevel: true };
  }
  const primary = (r.intakeItemId ?? r.sourceOrderId ?? r.accessionId) as string;
  return { primary, equivalents: [primary], partLevel: false };
}

export function findOpenDuplicate(db: DB, category: string, r: NormalRefs): ClarificationRow | undefined {
  const { equivalents, partLevel } = subjectIds(db, r);
  const keys = equivalents.map((id) => `${category}:${id}`);
  const ph = keys.map(() => "?").join(",");
  const open = "state NOT IN ('resolved','canceled')";
  const byKey = db.prepare(`SELECT * FROM clarification WHERE ${open} AND dedupe_key IN (${ph}) ORDER BY created_at LIMIT 1`).get(...keys) as ClarificationRow | undefined;
  if (byKey) return byKey;
  if (partLevel) {
    const eph = equivalents.map(() => "?").join(",");
    const byPart = db
      .prepare(
        `SELECT * FROM clarification WHERE ${open} AND category = ?
           AND (specimen_part_id IN (${eph}) OR order_part_id IN (${eph}) OR container_id IN (${eph})) ORDER BY created_at LIMIT 1`,
      )
      .get(category, ...equivalents, ...equivalents, ...equivalents) as ClarificationRow | undefined;
    if (byPart) return byPart;
  }
  // Same question asked at another level of the same material: an item-level question covers its parts and a
  // part-level question already covers the item. Matched on the intake item, else the order, else the case.
  const anchor: [string, string] | null = r.intakeItemId
    ? ["intake_item_id", r.intakeItemId]
    : r.sourceOrderId
      ? ["source_order_id", r.sourceOrderId]
      : r.accessionId
        ? ["accession_id", r.accessionId]
        : null;
  if (!anchor) return undefined;
  const itemLevelOnly = partLevel ? "AND specimen_part_id IS NULL AND order_part_id IS NULL AND container_id IS NULL" : "";
  return db
    .prepare(`SELECT * FROM clarification WHERE ${open} AND category = ? AND ${anchor[0]} = ? ${itemLevelOnly} ORDER BY created_at LIMIT 1`)
    .get(category, anchor[1]) as ClarificationRow | undefined;
}

function patientRefIds(db: DB, clr: Pick<ClarificationRow, "source_order_id" | "accession_id" | "intake_item_id">): string[] {
  const ids = new Set<string>();
  if (clr.source_order_id) {
    const r = db.prepare("SELECT patient_ref_id FROM source_order WHERE id = ?").get(clr.source_order_id) as { patient_ref_id: string } | undefined;
    if (r) ids.add(r.patient_ref_id);
  }
  if (clr.accession_id) {
    const r = db.prepare("SELECT patient_ref_id FROM accession WHERE id = ?").get(clr.accession_id) as { patient_ref_id: string } | undefined;
    if (r) ids.add(r.patient_ref_id);
  }
  if (clr.intake_item_id) {
    const rows = db
      .prepare("SELECT so.patient_ref_id FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id WHERE l.intake_item_id = ?")
      .all(clr.intake_item_id) as { patient_ref_id: string }[];
    for (const r of rows) ids.add(r.patient_ref_id);
  }
  return [...ids];
}

/** Which patient identifiers (if any) appear in an outbound notification text. */
export function patientIdentifiersIn(db: DB, clr: Pick<ClarificationRow, "source_order_id" | "accession_id" | "intake_item_id">, text: string): string[] {
  const found = new Set<string>();
  const hay = text.toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay);
  for (const pid of patientRefIds(db, clr)) {
    const p = db.prepare("SELECT family_name, given_name, birth_date, source_mrn FROM patient_ref WHERE id = ?").get(pid) as
      | { family_name: string; given_name: string; birth_date: string; source_mrn: string }
      | undefined;
    if (!p) continue;
    if (p.family_name.length >= 2 && word(p.family_name)) found.add("patient name");
    if (p.given_name.length >= 3 && word(p.given_name)) found.add("patient name");
    if (p.source_mrn && hay.includes(p.source_mrn.toLowerCase())) found.add("MRN");
    const [y, m, d] = p.birth_date.split("-");
    const variants = [p.birth_date, `${Number(m)}/${Number(d)}/${y}`, `${m}/${d}/${y}`, `${m}-${d}-${y}`];
    if (variants.some((v) => hay.includes(v.toLowerCase()))) found.add("date of birth");
  }
  return [...found];
}

/** Part designation, order id and accession number to show with a clarification. */
export function subjectContext(db: DB, clr: Pick<ClarificationRow, "order_part_id" | "specimen_part_id" | "source_order_id" | "accession_id" | "intake_item_id">): {
  partDesignation: string | null; orderRef: string | null; accessionNumber: string | null; intakeDisplayId: string | null;
} {
  let partDesignation: string | null = null;
  if (clr.specimen_part_id) {
    partDesignation = (db.prepare("SELECT designation FROM specimen_part WHERE id = ?").get(clr.specimen_part_id) as { designation: string } | undefined)?.designation ?? null;
  }
  if (!partDesignation && clr.order_part_id) {
    partDesignation = (db.prepare("SELECT designation FROM source_order_part WHERE id = ?").get(clr.order_part_id) as { designation: string } | undefined)?.designation ?? null;
  }
  const orderRef = clr.source_order_id
    ? ((db.prepare("SELECT source_order_id s FROM source_order WHERE id = ?").get(clr.source_order_id) as { s: string } | undefined)?.s ?? null)
    : null;
  const accessionNumber = clr.accession_id
    ? ((db.prepare("SELECT accession_number n FROM accession WHERE id = ?").get(clr.accession_id) as { n: string } | undefined)?.n ?? null)
    : null;
  const intakeDisplayId = clr.intake_item_id
    ? ((db.prepare("SELECT display_id d FROM intake_item WHERE id = ?").get(clr.intake_item_id) as { d: string } | undefined)?.d ?? null)
    : null;
  return { partDesignation, orderRef, accessionNumber, intakeDisplayId };
}

// ------------------------------------------------------------------ drafting (deterministic, no patient details)

type DraftSubject = Pick<ClarificationRow, "display_id" | "category" | "evidence" | "order_part_id" | "specimen_part_id" | "source_order_id" | "accession_id" | "intake_item_id">;

/**
 * Deterministic draft for a clarification, built from the recorded evidence.
 * Belt and braces on patient details: if any patient identifier of the linked
 * order or case still appears in the question, it is redrafted without quoting
 * any value. Throws nothing; the caller checks the assistant switch.
 */
export function draftForClarification(db: DB, clr: DraftSubject): DraftOutput {
  const info = subjectContext(db, clr);
  const base = {
    displayId: clr.display_id,
    category: clr.category,
    partDesignation: info.partDesignation,
    orderRef: info.orderRef,
    accessionNumber: info.accessionNumber,
    evidence: parseEvidence(clr.evidence),
  };
  const draft = draftClarification(base);
  if (!patientIdentifiersIn(db, clr, draft.question).length) return draft;
  return draftClarification({ ...base, withholdValues: true });
}

// ------------------------------------------------------------------ hold scope helpers

/** Accession / intake item a hold scope belongs to (for audit, worklist and display). Throws NOT_FOUND. */
export function scopeContext(db: DB, scope: Scope): { accessionId: string | null; intakeItemId: string | null } {
  const one = <T>(sql: string): T | undefined => db.prepare(sql).get(scope.id) as T | undefined;
  switch (scope.type) {
    case "accession": {
      if (!one("SELECT id FROM accession WHERE id = ?")) throw new DomainError("NOT_FOUND", `Case ${scope.id} was not found`);
      return { accessionId: scope.id, intakeItemId: null };
    }
    case "specimen_part": {
      const r = one<{ accession_id: string }>("SELECT accession_id FROM specimen_part WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Part ${scope.id} was not found`);
      return { accessionId: r.accession_id, intakeItemId: null };
    }
    case "block": {
      const r = one<{ accession_id: string }>("SELECT accession_id FROM block WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Block ${scope.id} was not found`);
      return { accessionId: r.accession_id, intakeItemId: null };
    }
    case "slide": {
      const r = one<{ accession_id: string }>("SELECT accession_id FROM slide WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Slide ${scope.id} was not found`);
      return { accessionId: r.accession_id, intakeItemId: null };
    }
    case "work_order": {
      const r = one<{ accession_id: string }>("SELECT accession_id FROM work_order WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Work order ${scope.id} was not found`);
      return { accessionId: r.accession_id, intakeItemId: null };
    }
    case "intake_item": {
      const r = one<{ accession_id: string | null }>("SELECT accession_id FROM intake_item WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Intake item ${scope.id} was not found`);
      return { accessionId: r.accession_id, intakeItemId: scope.id };
    }
    case "container": {
      const r = one<{ intake_item_id: string }>("SELECT intake_item_id FROM container WHERE id = ?");
      if (!r) throw new DomainError("NOT_FOUND", `Container ${scope.id} was not found`);
      const ii = db.prepare("SELECT accession_id FROM intake_item WHERE id = ?").get(r.intake_item_id) as { accession_id: string | null } | undefined;
      return { accessionId: ii?.accession_id ?? null, intakeItemId: r.intake_item_id };
    }
    case "order_part": {
      if (!one("SELECT id FROM source_order_part WHERE id = ?")) throw new DomainError("NOT_FOUND", `Order part ${scope.id} was not found`);
      const c = db.prepare("SELECT intake_item_id FROM container WHERE order_part_id = ? ORDER BY id LIMIT 1").get(scope.id) as { intake_item_id: string } | undefined;
      const viaLink = c
        ? undefined
        : (db
            .prepare("SELECT l.intake_item_id FROM intake_order_link l JOIN source_order_part p ON p.source_order_id = l.source_order_id WHERE p.id = ? LIMIT 1")
            .get(scope.id) as { intake_item_id: string } | undefined);
      const intakeItemId = c?.intake_item_id ?? viaLink?.intake_item_id ?? null;
      const sp = db.prepare("SELECT accession_id FROM specimen_part WHERE source_order_part_id = ? LIMIT 1").get(scope.id) as { accession_id: string } | undefined;
      return { accessionId: sp?.accession_id ?? null, intakeItemId };
    }
    default:
      throw new DomainError("VALIDATION", `Unknown hold scope type ${(scope as Scope).type}`);
  }
}

function pathologistOf(db: DB, accessionId: string | null): string | null {
  if (!accessionId) return null;
  return (db.prepare("SELECT assigned_pathologist_id p FROM accession WHERE id = ?").get(accessionId) as { p: string | null } | undefined)?.p ?? null;
}

/** Close every open task about this hold (release decision, "amended order received: review and release", ...), credited to the releasing person. */
function closeHoldTasks(ctx: Ctx, holdId: string): void {
  const kinds = ctx.db
    .prepare("SELECT DISTINCT kind FROM task WHERE entity_type = 'hold' AND entity_id = ? AND status IN ('open','in_progress')")
    .all(holdId) as { kind: string }[];
  for (const k of kinds) closeTasks(ctx, k.kind, "hold", holdId, "done");
}

export function holdsForClarification(db: DB, clarificationId: string, status?: "active" | "released"): HoldRow[] {
  return db
    .prepare(`SELECT * FROM hold WHERE clarification_id = ? ${status ? "AND status = ?" : ""} ORDER BY placed_at, display_id`)
    .all(...(status ? [clarificationId, status] : [clarificationId])) as HoldRow[];
}

// ------------------------------------------------------------------ shared plumbing

function stateLabel(s: string): string {
  return (CLARIFICATION_STATE as Record<string, string>)[s] ?? s;
}

function categoryLabel(c: string): string {
  return (CLARIFICATION_CATEGORY as Record<string, string>)[c] ?? c;
}

/** Stale-edit detection comes before any state rule: the user must see what changed first. */
function assertVersion(clr: ClarificationRow, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && clr.version !== expectedVersion) {
    throw new DomainError(
      "CONFLICT",
      `${clr.display_id} was changed by someone else after you opened it (you had version ${expectedVersion}, current is ${clr.version}; now "${stateLabel(clr.state)}"). Review the latest version before saving.`,
      { table: "clarification", id: clr.id, expectedVersion, currentVersion: clr.version, current: clr },
    );
  }
}

function assertState(clr: ClarificationRow, allowed: ClarificationState[], action: string, hint?: string): void {
  if (!allowed.includes(clr.state)) {
    throw new DomainError(
      "BLOCKED",
      `Cannot ${action} ${clr.display_id} while it is "${stateLabel(clr.state)}".${hint ? ` ${hint}` : ""}`,
      { state: clr.state, allowed },
    );
  }
}

function clrAudit(ctx: Ctx, clr: ClarificationRow, action: string, summary: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}): void {
  audit(ctx, {
    action,
    entityType: "clarification",
    entityId: clr.id,
    accessionId: clr.accession_id,
    intakeItemId: clr.intake_item_id,
    summary,
    before: extra.before,
    after: extra.after,
    reason: extra.reason ?? null,
  });
}

function update(ctx: Ctx, clr: ClarificationRow, expectedVersion: number | undefined, fields: Record<string, unknown>): ClarificationRow {
  return updateVersioned(ctx.db, "clarification", clr.id, expectedVersion, fields) as unknown as ClarificationRow;
}

function closeClarificationTasks(ctx: Ctx, clrId: string, kinds: string[], status: "done" | "canceled" = "done"): void {
  for (const k of kinds) closeTasks(ctx, k, "clarification", clrId, status);
}

function ownerTask(ctx: Ctx, clr: ClarificationRow, kind: string, title: string, ownerId: string | null, ownerRole: string | null, dueAt: string | null, priority?: Priority): string {
  closeTasks(ctx, kind, "clarification", clr.id, "done");
  return openTask(ctx, {
    kind,
    entityType: "clarification",
    entityId: clr.id,
    title,
    ownerId,
    ownerRole,
    priority: priority ?? clr.priority,
    dueAt,
    accessionId: clr.accession_id,
    intakeItemId: clr.intake_item_id,
  });
}

function worklistNote(ctx: Ctx, clr: ClarificationRow, summary: string): void {
  if (!clr.accession_id) return;
  recordWorklistChange(ctx, { accessionId: clr.accession_id, pathologistId: pathologistOf(ctx.db, clr.accession_id), type: "changed", summary });
}

function followUpTaskTitle(clr: ClarificationRow, outcome: string, dueAt: string | null, now: string): string {
  if (outcome === "delivery_failed") return `${clr.display_id}: delivery failed (simulated). Phone the office or escalate.`;
  if (outcome === "delivery_unknown") return `${clr.display_id}: no delivery confirmation. Follow up by phone per local policy.`;
  return `Follow up ${clr.display_id} if no answer by ${dueAt ? `${fmtSmart(dueAt, now)} ET` : "the follow-up time"}`;
}

/** Audit context for the simulated notification connector (not the person who pressed Send). */
export const NOTIFY_CONNECTOR_ACTOR_ID = "sim_notify";
function simulatorCtx(ctx: Ctx): Ctx {
  // actor_role is stored as readable text (not a staff role): other views print it verbatim.
  return { ...ctx, origin: "simulator", actor: { id: NOTIFY_CONNECTOR_ACTOR_ID, name: "Simulated notification connector", role: "Simulated connector" as unknown as Role } };
}

/** Apply a delivery outcome reported by the (simulated) connector. */
function applyDeliveryOutcome(ctx: Ctx, clr: ClarificationRow, outcome: DeliveryOutcome, reason: string, source: "simulator" | "staff"): ClarificationRow {
  const next: ClarificationState = outcome;
  const fields: Record<string, unknown> = { state: next };
  if (outcome === "delivered" && !clr.delivered_at) fields.delivered_at = ctx.now;
  const updated = update(ctx, clr, undefined, fields);
  const actx = source === "simulator" ? simulatorCtx(ctx) : ctx;
  clrAudit(
    actx,
    updated,
    "clarification.delivery_outcome",
    source === "simulator"
      ? `${clr.display_id}: simulated notification connector reported "${stateLabel(next)}". ${reason}`
      : `${clr.display_id}: ${ctx.actor.name} recorded delivery outcome "${stateLabel(next)}". ${reason}`,
    { before: { state: clr.state }, after: { state: next } },
  );
  return updated;
}

// ------------------------------------------------------------------ create

export interface CreateClarificationInput {
  category: ClarificationCategory;
  refs: ClarificationRefs;
  subjectLabel: string;
  question?: string;
  evidence: Record<string, unknown>[];
  priority: Priority;
  hold?: { scope: Scope; scopeLabel: string; blocks: HoldTransition[] } | null;
  officeId?: string | null;
  labOwnerId?: string | null;
}

export interface CreateClarificationResult {
  clarificationId: string;
  displayId: string;
  duplicate: boolean;
  state: ClarificationState;
  version: number;
  holdId: string | null;
  holdDisplayId: string | null;
  contact: { id: string | null; name: string | null; role: string; channel: string | null } | null;
  coverageNote: string | null;
  nextFollowUpAt: string | null;
  followUpNote: string | null;
  message: string;
}

/** Place the hold a create request asked for, linked to the clarification. Idempotent per (scope, category, clarification). */
function placeClarificationHold(
  ctx: Ctx,
  clr: Pick<ClarificationRow, "id" | "display_id" | "category">,
  hold: NonNullable<CreateClarificationInput["hold"]>,
  evidence: EvidenceItem[],
  refs: NormalRefs,
): { hold: HoldRow; placedNow: boolean } {
  const sc = scopeContext(ctx.db, hold.scope);
  const existing = ctx.db
    .prepare("SELECT id FROM hold WHERE status = 'active' AND scope_type = ? AND scope_id = ? AND reason_code = ? AND clarification_id = ?")
    .get(hold.scope.type, hold.scope.id, clr.category, clr.id) as { id: string } | undefined;
  const ev = evidence.find((e) => !isAmendmentRow(e));
  const reasonText = ev
    ? `${ev.field}: order ${ev.order_value ?? "(not stated)"}, observed ${ev.observed_value ?? "(not stated)"} (${clr.display_id})`
    : `${categoryLabel(clr.category)} question open (${clr.display_id})`;
  const row = placeHold(ctx, {
    scope: hold.scope,
    scopeLabel: hold.scopeLabel,
    blocks: hold.blocks,
    reasonCode: clr.category,
    reasonText,
    clarificationId: clr.id,
    intakeItemId: sc.intakeItemId ?? refs.intakeItemId,
    accessionId: sc.accessionId ?? refs.accessionId,
  });
  return { hold: row, placedNow: !existing };
}

export function createClarification(ctx: Ctx, input: CreateClarificationInput): CreateClarificationResult {
  const { db } = ctx;
  const refs = normalizeRefs(db, input.refs);
  const evidence = normalizeEvidence(input.evidence);
  const dup = findOpenDuplicate(db, input.category, refs);
  if (dup) {
    // No second clarification. A requested hold is still honored (linked to the open one): the material must not
    // stay unprotected just because someone else asked the question first.
    let hold: HoldRow | undefined = holdsForClarification(db, dup.id, "active")[0];
    let holdNote = "";
    if (input.hold) {
      const placed = placeClarificationHold(ctx, dup, input.hold, evidence.length ? evidence : parseEvidence(dup.evidence), refs);
      hold = placed.hold;
      if (placed.placedNow) {
        clrAudit(ctx, dup, "clarification.hold_added", `${placed.hold.display_id} placed on ${placed.hold.scope_label} and linked to open ${dup.display_id} (requested again by ${ctx.actor.name}; no second clarification).`);
        worklistNote(ctx, dup, `${placed.hold.display_id} placed on ${placed.hold.scope_label} for ${dup.display_id}`);
        holdNote = ` ${placed.hold.display_id} was placed on ${placed.hold.scope_label} and linked to it.`;
      } else {
        holdNote = ` ${placed.hold.display_id} already holds ${placed.hold.scope_label} for it.`;
      }
    }
    return {
      clarificationId: dup.id, displayId: dup.display_id, duplicate: true, state: dup.state, version: dup.version,
      holdId: hold?.id ?? null, holdDisplayId: hold?.display_id ?? null,
      contact: null, coverageNote: null, nextFollowUpAt: dup.next_follow_up_at, followUpNote: null,
      message: `${dup.display_id} is already open for this ${categoryLabel(dup.category).toLowerCase()} question (${stateLabel(dup.state)}). No second clarification was created.${holdNote}`,
    };
  }

  // Responsible office.
  let officeId = input.officeId ?? null;
  if (!officeId && refs.sourceOrderId) officeId = (db.prepare("SELECT office_id o FROM source_order WHERE id = ?").get(refs.sourceOrderId) as { o: string }).o;
  if (!officeId && refs.intakeItemId) officeId = (db.prepare("SELECT office_id o FROM intake_item WHERE id = ?").get(refs.intakeItemId) as { o: string | null }).o;
  if (!officeId && refs.accessionId) officeId = (db.prepare("SELECT office_id o FROM accession WHERE id = ?").get(refs.accessionId) as { o: string }).o;
  if (!officeId) {
    throw new DomainError("VALIDATION", "The submitting office is unknown, so there is no one to ask. Resolve the routing exception or choose the office first.");
  }
  if (!exists(db, "office", officeId)) throw new DomainError("NOT_FOUND", `Office ${officeId} was not found`);

  // People: the person raising it owns it (also in demo rehearsal), unless they are not staff (system, simulators).
  const escalationOwner = escalationOwnerId(db);
  let labOwner: string | null = input.labOwnerId ?? ctx.actor.id;
  if (labOwner && !exists(db, "staff", labOwner)) {
    if (input.labOwnerId) throw new DomainError("NOT_FOUND", `Staff member ${labOwner} was not found`);
    labOwner = null;
  }
  labOwner ??= escalationOwner;
  if (!labOwner) throw new DomainError("VALIDATION", "No lab owner could be assigned.");

  const sel = selectContact(db, officeId, input.category, ctx.now);
  const follow = computeNextFollowUp(db, officeId, ctx.now, input.priority);
  const { primary } = subjectIds(db, refs);
  const dedupeKey = `${input.category}:${primary}`;
  const ctxInfo = subjectContext(db, {
    order_part_id: refs.orderPartId, specimen_part_id: refs.specimenPartId, source_order_id: refs.sourceOrderId, accession_id: refs.accessionId, intake_item_id: refs.intakeItemId,
  });
  // A caller-supplied question is the person's own text. Without one, a fixed rule-based template is used and
  // recorded as such ('template'), never as manual text. It quotes no patient identifier.
  let question = input.question?.trim() ?? "";
  let draftSource = "manual";
  if (!question) {
    draftSource = "template";
    const tplInput = { category: input.category, partDesignation: ctxInfo.partDesignation, orderRef: ctxInfo.orderRef, accessionNumber: ctxInfo.accessionNumber, evidence };
    const available = assistantMode(db) !== "unavailable";
    question = templateQuestion(tplInput, { assistantAvailable: available });
    const refsForLeak = { source_order_id: refs.sourceOrderId, accession_id: refs.accessionId, intake_item_id: refs.intakeItemId };
    if (patientIdentifiersIn(db, refsForLeak, question).length) question = templateQuestion(tplInput, { assistantAvailable: false });
  }

  const id = newId(db, "clr");
  const display = nextDisplayId(db, "CLR", 4);
  db.prepare(
    `INSERT INTO clarification (id, display_id, category, intake_item_id, source_order_id, order_part_id, container_id, accession_id, specimen_part_id,
       subject_label, question, evidence, office_id, contact_role, contact_id, lab_owner_id, escalation_owner_id, priority, state, draft_source,
       created_at, created_by, next_follow_up_at, follow_up_count, dedupe_key, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?, ?, ?, 0, ?, 1)`,
  ).run(
    id, display, input.category, refs.intakeItemId, refs.sourceOrderId, refs.orderPartId, refs.containerId, refs.accessionId, refs.specimenPartId,
    input.subjectLabel.trim(), question, JSON.stringify(evidence), officeId, sel.contactRoleText, sel.contact?.id ?? null, labOwner, escalationOwner,
    input.priority, draftSource, ctx.now, ctx.actor.id, follow.at, dedupeKey,
  );
  let clr = getClarification(db, id);

  const contactText = sel.contact ? `${sel.contact.display_name} (${sel.contact.contact_role})` : sel.contactRoleText;
  clrAudit(
    ctx,
    clr,
    "clarification.created",
    `${display} drafted for ${clr.subject_label} (${categoryLabel(clr.category)}, ${clr.priority}). Office: ${officeName(db, officeId)}; contact ${contactText}. Lab owner ${staffName(db, labOwner)}.${draftSource === "template" ? " Question from the fixed template (rule-based, not AI)." : ""}${sel.coverageNote ? ` Coverage: ${sel.coverageNote}` : ""}`,
    { after: { evidence, question, dedupeKey, draftSource } },
  );

  const holdRow = input.hold ? placeClarificationHold(ctx, clr, input.hold, evidence, refs).hold : null;

  ownerTask(ctx, clr, TASK_KINDS.followup, `Send ${display} to ${officeName(db, officeId)} (drafted, not yet sent)`, labOwner, null, follow.at);
  worklistNote(ctx, clr, `${display} opened: ${categoryLabel(clr.category)} question on ${clr.subject_label}`);
  clr = getClarification(db, id);
  return {
    clarificationId: id,
    displayId: display,
    duplicate: false,
    state: clr.state,
    version: clr.version,
    holdId: holdRow?.id ?? null,
    holdDisplayId: holdRow?.display_id ?? null,
    contact: { id: sel.contact?.id ?? null, name: sel.contact?.display_name ?? null, role: sel.contactRoleText, channel: sel.contact?.channel ?? null },
    coverageNote: sel.coverageNote,
    nextFollowUpAt: follow.at,
    followUpNote: follow.note,
    message: `${display} drafted. Nothing has been sent yet.`,
  };
}

// ------------------------------------------------------------------ send

export interface SendResult {
  clarificationId: string;
  displayId: string;
  duplicate: boolean;
  state: ClarificationState;
  version: number;
  outcome: DeliveryOutcome;
  outcomeReason: string;
  messageId: string;
  body: string;
  contact: { id: string | null; name: string | null; role: string; channel: string | null };
  coverageNote: string | null;
  nextFollowUpAt: string | null;
}

export function sendClarification(
  ctx: Ctx,
  input: { clarificationId: string; expectedVersion: number; body?: string | null; question?: string | null; draftSource?: "manual" | "assistant_proposal" | "template" },
): SendResult {
  const { db } = ctx;
  let clr = getClarification(db, input.clarificationId);
  const idemKey = `${clr.id}:initial`;
  const prior = db.prepare("SELECT id, body, delivery_state FROM clarification_message WHERE idempotency_key = ?").get(idemKey) as
    | { id: string; body: string; delivery_state: string }
    | undefined;
  if (prior && clr.state !== "drafted") {
    const c = contactById(db, clr.contact_id);
    return {
      clarificationId: clr.id, displayId: clr.display_id, duplicate: true, state: clr.state, version: clr.version,
      outcome: prior.delivery_state === "delivered" ? "delivered" : prior.delivery_state === "failed" ? "delivery_failed" : "delivery_unknown",
      outcomeReason: `Already sent at ${fmtSmart(clr.sent_at, ctx.now)} ET. No second message was created.`, messageId: prior.id, body: prior.body,
      contact: { id: c?.id ?? null, name: c?.display_name ?? null, role: clr.contact_role, channel: c?.channel ?? null }, coverageNote: null,
      nextFollowUpAt: clr.next_follow_up_at,
    };
  }
  assertVersion(clr, input.expectedVersion);
  assertState(clr, ["drafted"], "send");

  const question = input.question && input.question.trim() ? input.question.trim() : clr.question;
  if (!question.trim()) throw new DomainError("VALIDATION", "Write the question before sending.");
  const body = input.body && input.body.trim() ? input.body.trim() : genericBody("initial", clr.display_id);
  const leaks = patientIdentifiersIn(db, clr, body);
  if (leaks.length) {
    throw new DomainError(
      "VALIDATION",
      `The notification text contains patient identifiers (${leaks.join(", ")}). Notifications are generic by default: keep details in the question (meant for the office's secure case view, a future connector; simulated here).`,
      { leaks },
    );
  }

  // Coverage is re-checked at send time (someone may be out now).
  const sel = selectContact(db, clr.office_id, clr.category, ctx.now);
  const follow = computeNextFollowUp(db, clr.office_id, ctx.now, clr.priority);
  clr = update(ctx, clr, input.expectedVersion, {
    state: "sent",
    sent_at: ctx.now,
    question,
    draft_source: input.draftSource ?? clr.draft_source,
    contact_id: sel.contact?.id ?? clr.contact_id,
    contact_role: sel.contactRoleText,
    next_follow_up_at: follow.at,
  });
  const recipient = sel.contact ? `${sel.contact.display_name}, ${sel.contact.contact_role}` : sel.contactRoleText;
  clrAudit(
    ctx,
    clr,
    "clarification.sent",
    `${clr.display_id} sent (simulated) to ${recipient}, ${officeName(db, clr.office_id)}, via ${channelLabel(sel.contact?.channel)}. Generic notice only; the question itself is not in the notice.${sel.coverageNote ? ` Coverage: ${sel.coverageNote}` : ""}`,
    { after: { question, body, draftSource: input.draftSource ?? clr.draft_source } },
  );
  const msg = sendSimulatedNotification(ctx, { clarificationId: clr.id, kind: "initial", contact: sel.contact, body, idempotencyKey: idemKey });
  clr = applyDeliveryOutcome(ctx, clr, msg.outcome, msg.reason, "simulator");
  ownerTask(ctx, clr, TASK_KINDS.followup, followUpTaskTitle(clr, msg.outcome, follow.at, ctx.now), clr.lab_owner_id, null, msg.outcome === "delivered" ? follow.at : ctx.now);
  return {
    clarificationId: clr.id, displayId: clr.display_id, duplicate: false, state: clr.state, version: clr.version,
    outcome: msg.outcome, outcomeReason: msg.reason, messageId: msg.messageId, body: msg.body,
    contact: { id: sel.contact?.id ?? null, name: sel.contact?.display_name ?? null, role: sel.contactRoleText, channel: sel.contact?.channel ?? null },
    coverageNote: sel.coverageNote, nextFollowUpAt: follow.at,
  };
}

// ------------------------------------------------------------------ delivery / acknowledgement / answer

export function recordDelivery(ctx: Ctx, input: { clarificationId: string; outcome: DeliveryOutcome; note?: string | null }) {
  let clr = getClarification(ctx.db, input.clarificationId);
  assertState(clr, DELIVERY_FAMILY, "record a delivery outcome for", "Delivery outcomes apply only after sending and before an acknowledgement or answer.");
  if (clr.state === input.outcome) {
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, unchanged: true };
  }
  const n = (ctx.db.prepare("SELECT COUNT(*) n FROM clarification_message WHERE clarification_id = ? AND kind = 'delivery_receipt'").get(clr.id) as { n: number }).n;
  recordInboundMessage(ctx, {
    clarificationId: clr.id, kind: "delivery_receipt", channel: "staff_recorded", contactId: clr.contact_id,
    body: `Delivery outcome recorded by ${ctx.actor.name}: ${stateLabel(input.outcome)}.${input.note ? ` Note: ${input.note}` : ""}`,
    idempotencyKey: `${clr.id}:receipt:${n + 1}`, deliveryState: input.outcome === "delivery_failed" ? "failed" : input.outcome,
  });
  clr = applyDeliveryOutcome(ctx, clr, input.outcome, input.note ? `Note: ${input.note}` : "", "staff");
  ownerTask(ctx, clr, TASK_KINDS.followup, followUpTaskTitle(clr, input.outcome, clr.next_follow_up_at, ctx.now), clr.lab_owner_id, null, input.outcome === "delivered" ? clr.next_follow_up_at : ctx.now);
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, unchanged: false };
}

export function recordAck(ctx: Ctx, input: { clarificationId: string; note?: string | null; channel?: string | null }) {
  let clr = getClarification(ctx.db, input.clarificationId);
  // Already acknowledged, or already answered (the answer implies it): nothing to record twice.
  if (clr.state === "acknowledged" || clr.state === "answered" || clr.state === "reviewed" || clr.state === "resolved") {
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, duplicate: true };
  }
  assertState(clr, DELIVERY_FAMILY, "record an acknowledgement for", clr.state === "drafted" ? "Send the clarification first." : undefined);
  const simulated = ctx.origin === "simulator";
  recordInboundMessage(ctx, {
    clarificationId: clr.id, kind: "acknowledgement", channel: input.channel ?? (simulated ? "simulated_ema_message" : "staff_recorded"), contactId: clr.contact_id,
    body: simulated ? "Simulated office acknowledgement: message opened in the secure case view." : `Acknowledgement recorded by ${ctx.actor.name}.${input.note ? ` Note: ${input.note}` : ""}`,
    idempotencyKey: `${clr.id}:ack`,
  });
  const before = clr.state;
  clr = update(ctx, clr, undefined, { state: "acknowledged", acknowledged_at: ctx.now });
  clrAudit(
    ctx,
    clr,
    "clarification.acknowledged",
    simulated ? `${clr.display_id} acknowledged by the office (simulated). Not answered yet.` : `${ctx.actor.name} recorded that the office acknowledged ${clr.display_id}. Not answered yet.`,
    { before: { state: before }, after: { state: "acknowledged" } },
  );
  ownerTask(ctx, clr, TASK_KINDS.followup, `Follow up ${clr.display_id} if no answer by ${clr.next_follow_up_at ? `${fmtSmart(clr.next_follow_up_at, ctx.now)} ET` : "the follow-up time"} (acknowledged)`, clr.lab_owner_id, null, clr.next_follow_up_at);
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, duplicate: false };
}

export function recordAnswer(
  ctx: Ctx,
  input: { clarificationId: string; answerText: string; answeredBy: string; channel: string },
): { clarificationId: string; displayId: string; state: ClarificationState; version: number; duplicate: boolean; message: string } {
  let clr = getClarification(ctx.db, input.clarificationId);
  const answerText = input.answerText.trim();
  if (!answerText) throw new DomainError("VALIDATION", "Enter the office's answer exactly as given.");
  if (clr.state === "answered" && clr.answer_text === answerText) {
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, duplicate: true, message: "This answer is already recorded." };
  }
  assertState(clr, AWAITING_OFFICE_STATES, "record an answer for", clr.state === "drafted" ? "Send the clarification first." : clr.state === "answered" ? "An answer is waiting for lab review. Review it (or mark it insufficient) first." : undefined);
  const n = (ctx.db.prepare("SELECT COUNT(*) n FROM clarification_message WHERE clarification_id = ? AND kind = 'answer'").get(clr.id) as { n: number }).n;
  recordInboundMessage(ctx, {
    clarificationId: clr.id, kind: "answer", channel: input.channel, contactId: clr.contact_id, body: answerText, idempotencyKey: `${clr.id}:answer:${n + 1}`,
  });
  const before = clr.state;
  clr = update(ctx, clr, undefined, {
    state: "answered",
    answered_at: ctx.now,
    // acknowledged_at stays as recorded: an answer without a separate acknowledgement is shown as "not recorded".
    answer_text: answerText,
    answered_by_contact: input.answeredBy.trim() || "Office (name not given)",
    answer_channel: input.channel,
    next_follow_up_at: null,
  });
  const simulated = ctx.origin === "simulator";
  const preview = answerText.length > 140 ? `${answerText.slice(0, 139)}…` : answerText;
  clrAudit(
    ctx,
    clr,
    "clarification.answered",
    `${simulated ? "Simulated office reply" : `Office answer recorded by ${ctx.actor.name}`} for ${clr.display_id} (${(ANSWER_CHANNELS as Record<string, string>)[input.channel] ?? input.channel}). Awaiting lab review; not resolved. Answer: "${preview}"`,
    { before: { state: before }, after: { state: "answered", answeredBy: input.answeredBy, channel: input.channel } },
  );
  closeClarificationTasks(ctx, clr.id, [TASK_KINDS.followup, TASK_KINDS.escalation]);
  ownerTask(ctx, clr, TASK_KINDS.review, `Review office answer for ${clr.display_id} (${categoryLabel(clr.category).toLowerCase()})`, clr.escalation_owner_id, "accessioning_lead", ctx.now);
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, duplicate: false, message: "Answer recorded. A lead or supervisor must review it before the clarification can be resolved." };
}

// ------------------------------------------------------------------ review / resolve / cancel

/** The office answer a review or resolution is based on (the latest recorded answer message). */
function latestAnswerMessage(db: DB, clrId: string): { id: string; created_at: string; channel: string } | null {
  return (
    (db
      .prepare("SELECT id, created_at, channel FROM clarification_message WHERE clarification_id = ? AND kind = 'answer' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(clrId) as { id: string; created_at: string; channel: string } | undefined) ?? null
  );
}

export function reviewClarification(
  ctx: Ctx,
  input: { clarificationId: string; expectedVersion: number; note?: string | null; outcome?: "accepted" | "insufficient" },
) {
  let clr = getClarification(ctx.db, input.clarificationId);
  assertVersion(clr, input.expectedVersion);
  assertState(clr, ["answered"], "review", clr.state === "reviewed" ? "It has already been reviewed; resolve it next." : "There is no office answer to review yet.");
  const outcome = input.outcome ?? "accepted";
  const note = (input.note ?? "").trim();
  const answer = latestAnswerMessage(ctx.db, clr.id);
  const answerRef = { answerMessageId: answer?.id ?? null, answeredAt: clr.answered_at, answerChannel: clr.answer_channel };
  const beforeState = { state: clr.state, version: clr.version };
  if (outcome === "insufficient") {
    if (!note) throw new DomainError("VALIDATION", "Say what is missing from the answer.");
    const follow = computeNextFollowUp(ctx.db, clr.office_id, ctx.now, clr.priority);
    clr = update(ctx, clr, input.expectedVersion, { state: "acknowledged", review_note: note, reviewer_id: ctx.actor.id, next_follow_up_at: follow.at });
    clrAudit(ctx, clr, "clarification.answer_insufficient", `${ctx.actor.name} marked the office answer for ${clr.display_id} as insufficient. Waiting for a further answer.`, {
      reason: note,
      before: beforeState,
      after: { state: "acknowledged", version: clr.version, outcome, ...answerRef, nextFollowUpAt: follow.at },
    });
    closeClarificationTasks(ctx, clr.id, [TASK_KINDS.review]);
    ownerTask(ctx, clr, TASK_KINDS.followup, `Ask the office again for ${clr.display_id}: answer was insufficient`, clr.lab_owner_id, null, ctx.now);
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version };
  }
  clr = update(ctx, clr, input.expectedVersion, { state: "reviewed", reviewed_at: ctx.now, reviewer_id: ctx.actor.id, review_note: note || null });
  clrAudit(ctx, clr, "clarification.reviewed", `${ctx.actor.name} reviewed the office answer for ${clr.display_id}. Not resolved yet.`, {
    reason: note || null,
    before: beforeState,
    after: { state: "reviewed", version: clr.version, outcome, ...answerRef },
  });
  closeClarificationTasks(ctx, clr.id, [TASK_KINDS.followup, TASK_KINDS.escalation]);
  ownerTask(ctx, clr, TASK_KINDS.review, `Resolve ${clr.display_id}: answer reviewed by ${ctx.actor.name}`, clr.escalation_owner_id ?? ctx.actor.id, "accessioning_lead", ctx.now);
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version };
}

function openHoldDecisionTasks(ctx: Ctx, clr: ClarificationRow, holds: HoldRow[], why: string): void {
  for (const h of holds) {
    openTask(ctx, {
      kind: TASK_KINDS.holdDecision,
      entityType: "hold",
      entityId: h.id,
      title: `${clr.display_id} ${why}. Decide whether to release ${h.display_id} (${h.scope_label}).`,
      ownerId: clr.escalation_owner_id,
      ownerRole: "accessioning_lead",
      priority: clr.priority,
      dueAt: ctx.now,
      accessionId: h.accession_id ?? clr.accession_id,
      intakeItemId: h.intake_item_id ?? clr.intake_item_id,
    });
  }
}

export function resolveClarification(
  ctx: Ctx,
  input: { clarificationId: string; expectedVersion: number; resolutionCode: ResolutionCode; note: string; releaseHoldIds?: string[]; releaseReason?: string | null },
) {
  const { db } = ctx;
  let clr = getClarification(db, input.clarificationId);
  assertVersion(clr, input.expectedVersion);
  assertState(
    clr,
    ["reviewed"],
    "resolve",
    clr.state === "answered"
      ? "The office answer has not been reviewed yet. A lead or supervisor must review it first."
      : clr.state === "resolved" || clr.state === "canceled"
        ? undefined
        : "No office answer has been recorded and reviewed yet. An answer alone never resolves a clarification.",
  );
  const note = input.note.trim();
  if (!note) throw new DomainError("VALIDATION", "A resolution note is required.");
  const releaseIds = [...new Set(input.releaseHoldIds ?? [])];
  const linked = holdsForClarification(db, clr.id);
  for (const hid of releaseIds) {
    const h = linked.find((x) => x.id === hid || x.display_id === hid);
    if (!h) throw new DomainError("VALIDATION", `Hold ${hid} is not linked to ${clr.display_id}. Release other holds separately.`);
  }
  if (releaseIds.length && !(input.releaseReason ?? "").trim()) {
    throw new DomainError("VALIDATION", "Give a reason for releasing the hold. The release is recorded separately from the resolution.");
  }
  const answer = latestAnswerMessage(db, clr.id);
  const beforeState = { state: clr.state, version: clr.version, reviewerId: clr.reviewer_id };
  clr = update(ctx, clr, input.expectedVersion, {
    state: "resolved",
    resolved_at: ctx.now,
    resolved_by: ctx.actor.id,
    resolution_code: input.resolutionCode,
    resolution_note: note,
    next_follow_up_at: null,
  });
  clrAudit(ctx, clr, "clarification.resolved", `${ctx.actor.name} resolved ${clr.display_id}: ${RESOLUTION_CODES[input.resolutionCode]}.`, {
    reason: note,
    before: beforeState,
    after: {
      state: "resolved",
      version: clr.version,
      resolutionCode: input.resolutionCode,
      category: clr.category,
      answerMessageId: answer?.id ?? null,
      answeredAt: clr.answered_at,
      holdReleasesRequested: releaseIds,
    },
  });

  const released: { id: string; displayId: string; scopeLabel: string }[] = [];
  for (const hid of releaseIds) {
    const h = linked.find((x) => x.id === hid || x.display_id === hid)!;
    if (h.status !== "active") continue;
    releaseHold(ctx, h.id, (input.releaseReason ?? "").trim());
    closeHoldTasks(ctx, h.id);
    released.push({ id: h.id, displayId: h.display_id, scopeLabel: h.scope_label });
  }
  const stillActive = holdsForClarification(db, clr.id, "active");
  closeClarificationTasks(ctx, clr.id, [TASK_KINDS.followup, TASK_KINDS.review, TASK_KINDS.escalation]);
  openHoldDecisionTasks(ctx, clr, stillActive, "is resolved");
  worklistNote(ctx, clr, `${clr.display_id} resolved${stillActive.length ? `; ${stillActive.map((h) => h.display_id).join(", ")} still active` : ""}`);
  return {
    clarificationId: clr.id,
    displayId: clr.display_id,
    state: clr.state,
    version: clr.version,
    releasedHolds: released,
    holdsStillActive: stillActive.map((h) => ({ id: h.id, displayId: h.display_id, scopeLabel: h.scope_label })),
  };
}

export function cancelClarification(ctx: Ctx, input: { clarificationId: string; reason: string; expectedVersion: number }) {
  let clr = getClarification(ctx.db, input.clarificationId);
  assertVersion(clr, input.expectedVersion);
  assertState(clr, OPEN_CLARIFICATION_STATES, "cancel");
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required to cancel a clarification.");
  const before = clr.state;
  clr = update(ctx, clr, input.expectedVersion, { state: "canceled", resolution_note: reason, next_follow_up_at: null });
  clrAudit(ctx, clr, "clarification.canceled", `${ctx.actor.name} canceled ${clr.display_id} (was ${stateLabel(before)}).`, { reason, before: { state: before } });
  closeClarificationTasks(ctx, clr.id, [TASK_KINDS.followup, TASK_KINDS.review, TASK_KINDS.escalation], "canceled");
  const stillActive = holdsForClarification(ctx.db, clr.id, "active");
  openHoldDecisionTasks(ctx, clr, stillActive, "was canceled");
  worklistNote(ctx, clr, `${clr.display_id} canceled`);
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, holdsStillActive: stillActive.map((h) => ({ id: h.id, displayId: h.display_id })) };
}

// ------------------------------------------------------------------ follow-up and escalation

function lastOutbound(db: DB, clrId: string, kinds: string[]): { created_at: string } | undefined {
  const ph = kinds.map(() => "?").join(",");
  return db
    .prepare(`SELECT created_at FROM clarification_message WHERE clarification_id = ? AND direction = 'outbound' AND kind IN (${ph}) ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(clrId, ...kinds) as { created_at: string } | undefined;
}

export function reminderWindow(db: DB, clr: ClarificationRow, now: string, kinds = ["initial", "reminder"]): { lastSentAt: string | null; nextAllowedAt: string | null; suppressed: boolean } {
  const last = lastOutbound(db, clr.id, kinds) ?? (clr.sent_at && kinds.includes("initial") ? { created_at: clr.sent_at } : undefined);
  if (!last) return { lastSentAt: null, nextAllowedAt: null, suppressed: false };
  const next = new Date(Date.parse(last.created_at) + REMINDER_SUPPRESSION_MINUTES * 60_000).toISOString();
  return { lastSentAt: last.created_at, nextAllowedAt: next, suppressed: Date.parse(now) < Date.parse(next) };
}

/** Escalation duplicate window: the last escalation message, or the last escalation recorded without one (no contact on file). */
export function escalationWindow(db: DB, clr: ClarificationRow, now: string): { lastSentAt: string | null; nextAllowedAt: string | null; suppressed: boolean } {
  const msg = lastOutbound(db, clr.id, ["escalation"])?.created_at ?? null;
  const last = [msg, clr.escalated_at].filter((x): x is string => !!x).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  if (!last) return { lastSentAt: null, nextAllowedAt: null, suppressed: false };
  const next = new Date(Date.parse(last) + REMINDER_SUPPRESSION_MINUTES * 60_000).toISOString();
  return { lastSentAt: last, nextAllowedAt: next, suppressed: Date.parse(now) < Date.parse(next) };
}

export function followUpClarification(ctx: Ctx, input: { clarificationId: string }) {
  const { db } = ctx;
  let clr = getClarification(db, input.clarificationId);
  assertState(clr, AWAITING_OFFICE_STATES, "send a reminder for", clr.state === "drafted" ? "Send the clarification first." : "Reminders apply only while waiting on the office.");
  const win = reminderWindow(db, clr, ctx.now);
  if (win.suppressed) {
    const message = `A message for ${clr.display_id} was already sent at ${fmtSmart(win.lastSentAt, ctx.now)} ET. Next reminder allowed at ${fmtSmart(win.nextAllowedAt, ctx.now)} ET. No second reminder was sent.`;
    clrAudit(ctx, clr, "clarification.reminder_suppressed", message);
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, suppressed: true, lastSentAt: win.lastSentAt, nextAllowedAt: win.nextAllowedAt, message, outcome: null as DeliveryOutcome | null };
  }
  const sel = selectContact(db, clr.office_id, clr.category, ctx.now);
  const n = clr.follow_up_count + 1;
  const msg = sendSimulatedNotification(ctx, { clarificationId: clr.id, kind: "reminder", contact: sel.contact, body: genericBody("reminder", clr.display_id), idempotencyKey: `${clr.id}:reminder:${n}` });
  const follow = computeNextFollowUp(db, clr.office_id, ctx.now, clr.priority);
  const before = clr.state;
  clr = update(ctx, clr, undefined, {
    follow_up_count: n,
    next_follow_up_at: follow.at,
    contact_id: sel.contact?.id ?? clr.contact_id,
    contact_role: sel.contactRoleText,
  });
  clrAudit(
    ctx,
    clr,
    "clarification.reminder_sent",
    `Reminder ${n} for ${clr.display_id} sent (simulated) to ${sel.contact ? `${sel.contact.display_name}, ${sel.contact.contact_role}` : sel.contactRoleText}. Connector reported "${stateLabel(msg.outcome)}". Next follow-up ${fmtSmart(follow.at, ctx.now)} ET.${sel.coverageNote ? ` Coverage: ${sel.coverageNote}` : ""}`,
  );
  // The delivery state only moves forward: an earlier delivered or acknowledged message is not undone by a failed reminder.
  if (before === "sent" || before === "delivery_unknown" || before === "delivery_failed") {
    if (msg.outcome !== before && (msg.outcome === "delivered" || before === "sent")) clr = applyDeliveryOutcome(ctx, clr, msg.outcome, msg.reason, "simulator");
  }
  ownerTask(ctx, clr, TASK_KINDS.followup, followUpTaskTitle(clr, msg.outcome, follow.at, ctx.now), clr.lab_owner_id, null, msg.outcome === "delivered" ? follow.at : ctx.now);
  if (n >= ESCALATE_AFTER_REMINDERS && !clr.escalated_at) {
    ownerTask(ctx, clr, TASK_KINDS.escalation, `${clr.display_id}: ${n} reminders without an answer. Consider escalating to the office's escalation contact.`, clr.escalation_owner_id, "accessioning_lead", ctx.now, "high");
  }
  return {
    clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, suppressed: false,
    lastSentAt: ctx.now, nextAllowedAt: new Date(Date.parse(ctx.now) + REMINDER_SUPPRESSION_MINUTES * 60_000).toISOString(),
    message: `Reminder ${n} sent (simulated). ${msg.reason}`, outcome: msg.outcome as DeliveryOutcome | null,
  };
}

export function escalateClarification(ctx: Ctx, input: { clarificationId: string; note?: string | null }) {
  const { db } = ctx;
  let clr = getClarification(db, input.clarificationId);
  assertState(clr, AWAITING_OFFICE_STATES, "escalate", clr.state === "drafted" ? "Send the clarification first." : "Escalation applies only while waiting on the office.");
  const win = escalationWindow(db, clr, ctx.now);
  if (win.suppressed) {
    const message = `${clr.display_id} was already escalated at ${fmtSmart(win.lastSentAt, ctx.now)} ET. Next escalation allowed at ${fmtSmart(win.nextAllowedAt, ctx.now)} ET.`;
    clrAudit(ctx, clr, "clarification.escalation_suppressed", message);
    return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, suppressed: true, message, outcome: null as DeliveryOutcome | null };
  }
  const sel = selectContact(db, clr.office_id, clr.category, ctx.now);
  const n = (db.prepare("SELECT COUNT(*) n FROM clarification_message WHERE clarification_id = ? AND kind = 'escalation'").get(clr.id) as { n: number }).n + 1;
  let outcome: DeliveryOutcome | null = null;
  let detail: string;
  if (sel.escalation) {
    const msg = sendSimulatedNotification(ctx, { clarificationId: clr.id, kind: "escalation", contact: sel.escalation, body: genericBody("escalation", clr.display_id), idempotencyKey: `${clr.id}:escalation:${n}` });
    outcome = msg.outcome;
    detail = `Escalation sent (simulated) to ${sel.escalation.display_name}, ${sel.escalation.contact_role}. Connector reported "${stateLabel(msg.outcome)}".`;
  } else {
    detail = "No escalation contact is on file for this office. Escalated internally only; phone the office per local policy.";
  }
  const before = clr.state;
  clr = update(ctx, clr, undefined, { escalated_at: ctx.now });
  const owner = clr.escalation_owner_id;
  clrAudit(ctx, clr, "clarification.escalated", `${ctx.actor.name} escalated ${clr.display_id}. ${detail} Lab escalation owner: ${staffName(db, owner)}.`, { reason: input.note ?? null });
  if (outcome === "delivered" && (before === "sent" || before === "delivery_unknown" || before === "delivery_failed")) {
    clr = applyDeliveryOutcome(ctx, clr, "delivered", "The escalation contact received the notice (simulated).", "simulator");
  }
  ownerTask(ctx, clr, TASK_KINDS.escalation, `${clr.display_id} escalated${sel.escalation ? ` to ${sel.escalation.display_name} (${sel.escalation.contact_role})` : ""}. Follow up until answered.`, owner, "accessioning_lead", computeNextFollowUp(db, clr.office_id, ctx.now, clr.priority).at, "high");
  return { clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, suppressed: false, message: detail, outcome };
}

// ------------------------------------------------------------------ holds (commands hold.place / hold.release)

export function placeManualHold(
  ctx: Ctx,
  input: { scope: { type: ScopeType; id: string }; scopeLabel: string; blocks: HoldTransition[]; reasonCode?: string; reasonText: string; clarificationId?: string | null },
) {
  const sc = scopeContext(ctx.db, input.scope);
  if (input.clarificationId) getClarification(ctx.db, input.clarificationId);
  const reasonCode = input.reasonCode?.trim() || "manual";
  const before = ctx.db
    .prepare("SELECT * FROM hold WHERE status = 'active' AND scope_type = ? AND scope_id = ? AND reason_code = ? AND COALESCE(clarification_id,'') = COALESCE(?, '')")
    .get(input.scope.type, input.scope.id, reasonCode, input.clarificationId ?? null) as HoldRow | undefined;
  if (before) {
    const have = [...new Set(blockedTransitions(before))].sort();
    const want = [...new Set(input.blocks)].sort();
    if (have.join(",") !== want.join(",")) {
      throw new DomainError(
        "BLOCKED",
        `${before.display_id} already holds ${before.scope_label} for this reason and blocks ${have.join(", ")}. The requested steps (${want.join(", ")}) were not applied. Release ${before.display_id} with a reason, then place the hold again with the steps you need.`,
        { holdId: before.id, displayId: before.display_id, blocks: have, requested: want },
      );
    }
    return { holdId: before.id, displayId: before.display_id, version: before.version, duplicate: true, message: `${before.display_id} already holds ${before.scope_label} for this reason. No second hold was placed.` };
  }
  const h = placeHold(ctx, {
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    blocks: input.blocks,
    reasonCode,
    reasonText: input.reasonText.trim(),
    clarificationId: input.clarificationId ?? null,
    intakeItemId: sc.intakeItemId,
    accessionId: sc.accessionId,
  });
  return { holdId: h.id, displayId: h.display_id, version: h.version, duplicate: false, message: `${h.display_id} placed on ${h.scope_label}.` };
}

export function releaseHoldWithChecks(ctx: Ctx, input: { holdId: string; expectedVersion: number; reason: string; overrideOpenClarification?: boolean }) {
  const { db } = ctx;
  const h = db.prepare("SELECT * FROM hold WHERE id = ? OR display_id = ?").get(input.holdId, input.holdId) as HoldRow | undefined;
  if (!h) throw new DomainError("NOT_FOUND", `Hold ${input.holdId} was not found`);
  if (h.status === "released") {
    return { holdId: h.id, displayId: h.display_id, status: h.status, version: h.version, alreadyReleased: true, message: `${h.display_id} was already released at ${fmtSmart(h.released_at, ctx.now)} ET.` };
  }
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A release reason is required.");
  let overrideOf: ClarificationRow | null = null;
  if (h.clarification_id) {
    const clr = findClarification(db, h.clarification_id);
    if (clr && clr.state !== "resolved" && clr.state !== "canceled") {
      const supervisorOverride = input.overrideOpenClarification === true && ctx.actor.role === "supervisor";
      overrideOf = clr;
      if (!supervisorOverride) {
        throw new DomainError(
          "BLOCKED",
          `${h.display_id} is linked to open clarification ${clr.display_id} (${stateLabel(clr.state)}). Resolve the clarification first, or ask the operations supervisor to release it with an override reason.`,
          { clarificationId: clr.id, state: clr.state },
        );
      }
    }
  }
  const updated = releaseHold(ctx, h.id, reason, input.expectedVersion);
  // Recorded only when the override was actually what allowed the release (the clarification was still open).
  if (overrideOf) {
    audit(ctx, {
      action: "hold.release_override",
      entityType: "hold",
      entityId: h.id,
      accessionId: h.accession_id,
      intakeItemId: h.intake_item_id,
      summary: `${ctx.actor.name} released ${h.display_id} while ${overrideOf.display_id} was still open (${stateLabel(overrideOf.state)}): supervisor override.`,
      reason,
    });
  }
  closeHoldTasks(ctx, h.id);
  return { holdId: updated.id, displayId: updated.display_id, status: updated.status, version: updated.version, alreadyReleased: false, message: `${h.display_id} released (${h.scope_label}).` };
}
