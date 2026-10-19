/**
 * Read model for the digital doctor/PAS worklist (replaces the information
 * role of the printed "bible"). Everything here is DERIVED from the database
 * on each request: readiness from server/domain/readiness.ts, PAS only from
 * explicit work orders / order lines (never from diagnosis or note text),
 * change tags from the append-only worklist_change feed, and source
 * freshness from the (simulated) integration sources.
 */
import type { DB } from "@/server/db/db";
import { demoNow } from "@/server/core/clock";
import { currentWorklistSeq } from "@/server/core/feed";
import { computeReadiness, STAGE_SHORT, type CaseReadiness, type PartReadiness } from "@/server/domain/readiness";
import { activeHolds, blockedTransitions, scopesForIntake } from "@/server/domain/holds";
import { AUTHORIZATION_SOURCE, ROUTING_STATUS, type Stage } from "@/lib/domain";
import { fmtTime, fmtSmart, fmtFull, labDay, minutesBetween, fmtAge } from "@/lib/time";
import {
  FRESHNESS_DELAYED_AFTER_MIN,
  FRESHNESS_STALE_AFTER_MIN,
  VIEW_COLUMNS,
  VIEW_LABEL,
  type ColumnKey,
  type WorklistFilters,
  type WorklistView,
} from "@/components/worklist/views";
import { partsText, tidyPlurals } from "@/components/worklist/format";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";

// ---------------------------------------------------------------- types

export type ChangeTag = "new" | "changed" | "canceled";
export type UpdateOrigin = "Local" | "Source (simulated)";

export interface SourceFreshness {
  id: string;
  name: string;
  tenantId: string | null;
  tenantName: string | null;
  status: string;
  state: "current" | "delayed" | "offline" | "unknown";
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  ageMinutes: number | null;
  stale: boolean;
  text: string;
}

export interface FreshnessSummary {
  sources: SourceFreshness[];
  /** True when any tenant source is offline or past the stale threshold. */
  stale: boolean;
  /** Oldest last-successful-sync time across tenant sources; null = Unknown. */
  dataAsOf: string | null;
  /** Banner text when stale (null otherwise). */
  banner: string | null;
}

export interface StainEntry {
  workOrderId: string | null;
  workOrder: string | null;
  stain: string;
  kind: string;
  isPas: boolean;
  status: string;
  /** canceled or canceled-at-source review: shown struck through with the word "Canceled". */
  canceled: boolean;
  needsReview: boolean;
  target: string;
  authorization: string;
  sourceReference: string;
  /** Explicit text, e.g. "PAS (WO-2213) · A1-2 · Source: Source order (ORD-77120 v1 · part A)". */
  text: string;
}

export interface HoldEntry {
  id: string;
  displayId: string;
  scopeLabel: string;
  reasonText: string;
  blocks: string[];
  clarificationId: string | null;
  /** Display id of the linked clarification (CLR-0457), used in links. */
  clarificationDisplayId?: string | null;
  placedAt: string;
}

export interface TaskEntry {
  id: string;
  kind: string;
  title: string;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerRole: string | null;
  priority: string;
  dueAt: string | null;
  createdAt: string;
  version: number;
}

export interface PartTrackView {
  partId: string;
  designation: string;
  site: string;
  laterality: string | null;
  procedure: string | null;
  sourceOrderRef: string;
  status: string;
  stage: Stage;
  stageLabel: string;
  /** "ready" | "hold" | stage word: the short word used in "A ready · B hold". */
  word: string;
  physical: { state: string; blocks: { id: string; label: string; state: string }[]; slidesActive: number; slidesTotal: number };
  documentation: { grossState: string; grossRecordVersion: number | null; sourceUpdateState: string };
  blocksPrepared: number;
  blocksExpected: number | null;
  holds: HoldEntry[];
  eligible: string[];
  blockedBy: string[];
  stains: StainEntry[];
}

export interface WorklistRow {
  kind: "case" | "intake";
  id: string;
  accessionNumber: string | null;
  provisionalId: string | null;
  href: string;
  pathologistId: string | null;
  patientLabel: string;
  mrnLabel: string;
  office: string;
  clinician: string | null;
  priority: string;
  receivedDay: string | null;
  stage: Stage | "intake";
  stageLabel: string;
  partsSummary: string;
  parts: PartTrackView[];
  holds: HoldEntry[];
  stains: StainEntry[];
  /** Every PAS entry (active and canceled), for display. */
  pas: StainEntry[];
  /** At least one PAS that is still to be done (requested, in progress or on the order). Canceled PAS never counts. */
  hasPas: boolean;
  /** A PAS was canceled or amended at source and prepared/printed material needs review. Shown separately, never as an active PAS. */
  pasNeedsReview: boolean;
  readinessText: string;
  eligibleShort: string[];
  blockedShort: string[];
  isComplete: boolean;
  blocks: { prepared: number; expected: number | null; expectedLowerBound: number | null; text: string };
  sourceEntry: { text: string; pendingParts: string[]; attestedParts: string[] };
  tasks: TaskEntry[];
  owner: TaskEntry | null;
  ownerText: string;
  lastUpdate: { at: string | null; origin: UpdateOrigin | null; by: string | null; summary: string | null; text: string };
  /** Primary tag (used for counts): canceled, then new, then changed. */
  change: ChangeTag | null;
  /** Every tag that applies, so a new row with a canceled stain shows both "New" and "Canceled". */
  changeTags: ChangeTag[];
  changeSummaries: string[];
  routing: { status: string; explanation: string } | null;
  openClarifications: number;
  /**
   * Derived, read only: the case label's DataMatrix payload (encodeLabel, kind C), so the side panel can set the
   * case as its printed label. Null for intake items, which have no official number.
   */
  labelPayload: string | null;
}

export interface WorklistGroup {
  key: string;
  /** doctor = an active assigned dermatopathologist; routing_exception = intake items with no approved rule; no_doctor = a case whose assigned doctor is missing or inactive. */
  kind: "doctor" | "routing_exception" | "no_doctor";
  pathologistId: string | null;
  name: string;
  colorToken: string | null;
  colorName: string | null;
  /** True for the two groups without a doctor color. */
  isException: boolean;
  /** pas = rows with a PAS still to do; pasReview = rows with a canceled/amended PAS whose material needs review. */
  counts: { rows: number; pas: number; pasReview: number; onHold: number };
  rows: WorklistRow[];
}

export interface WorklistData {
  view: WorklistView;
  viewLabel: string;
  columns: ColumnKey[];
  filters: WorklistFilters;
  staffId: string;
  generatedAt: string;
  /** Worklist version = latest worklist_change.seq when this read was taken. */
  seq: number;
  ack: { ackedSeq: number; ackedAt: string | null; never: boolean };
  changes: { new: number; changed: number; canceled: number; total: number };
  freshness: FreshnessSummary;
  groups: WorklistGroup[];
  totals: { inScope: number; shown: number; allCases: number };
  doctors: { id: string; name: string; colorToken: string | null }[];
  /**
   * The latest snapshot this user printed or downloaded of this view (derived, read only), and how many rows
   * in the view's scope changed after it, so the screen can say what the paper copy no longer shows. Null when
   * the user has never taken one.
   */
  lastSnapshot: LastSnapshot | null;
}

export interface LastSnapshot {
  displayId: string;
  seq: number;
  generatedAt: string;
  format: string;
  /** Rows in the view's scope (any filter) with a new, changed or canceled entry after the snapshot's version. */
  changedRows: number;
}

// ---------------------------------------------------------------- source freshness

interface SourceRow {
  id: string;
  name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  status: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

/** Freshness of the simulated source systems (one per tenant). Unknown is never shown as current. */
export function loadSourceFreshness(db: DB, now: string = demoNow(db)): FreshnessSummary {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.tenant_id, t.name AS tenant_name, s.status, s.last_success_at, s.last_attempt_at, s.last_error
         FROM integration_source s LEFT JOIN source_tenant t ON t.id = s.tenant_id
        WHERE s.tenant_id IS NOT NULL ORDER BY s.id`,
    )
    .all() as SourceRow[];
  const sources: SourceFreshness[] = rows.map((r) => {
    const age = r.last_success_at ? Math.max(0, minutesBetween(r.last_success_at, now)) : null;
    let state: SourceFreshness["state"];
    if (r.status === "offline") state = "offline";
    else if (age === null) state = "unknown";
    else if (r.status === "degraded" || age > FRESHNESS_DELAYED_AFTER_MIN) state = "delayed";
    else state = "current";
    const stale = state === "offline" || (age !== null && age > FRESHNESS_STALE_AFTER_MIN);
    const label = r.tenant_name ?? r.name;
    const last = r.last_success_at ? `${fmtTime(r.last_success_at)} ET (${fmtAge(r.last_success_at, now)} ago)` : "Unknown";
    const text =
      state === "offline"
        ? `${label} unreachable (simulated outage). Last successful sync ${last}. Showing last confirmed data.`
        : state === "unknown"
          ? `${label}: sync status unknown (no successful sync recorded)`
          : state === "delayed"
            ? `${label}: last sync ${last}${stale ? ". Data may be out of date." : ""}`
            : `${label}: synced ${last}`;
    return {
      id: r.id, name: r.name, tenantId: r.tenant_id, tenantName: r.tenant_name, status: r.status, state,
      lastSuccessAt: r.last_success_at, lastAttemptAt: r.last_attempt_at, lastError: r.last_error, ageMinutes: age, stale, text,
    };
  });
  const stale = sources.some((s) => s.stale);
  const dataAsOf = sources.some((s) => !s.lastSuccessAt)
    ? null
    : sources.reduce<string | null>((min, s) => (min === null || Date.parse(s.lastSuccessAt!) < Date.parse(min) ? s.lastSuccessAt : min), null);
  const staleOnes = sources.filter((s) => s.stale);
  const banner = staleOnes.length
    ? staleOnes
        .map((s) =>
          s.state === "offline"
            ? `${s.tenantName ?? s.name} unreachable (simulated outage) since its last successful sync at ${s.lastSuccessAt ? `${fmtTime(s.lastSuccessAt)} ET (${fmtAge(s.lastSuccessAt, now)} ago)` : "an unknown time"}. Showing last confirmed data; new orders and source changes since then are not shown.`
            : `${s.tenantName ?? s.name} has not synced since ${s.lastSuccessAt ? `${fmtTime(s.lastSuccessAt)} ET (${fmtAge(s.lastSuccessAt, now)} ago)` : "an unknown time"}. Data may be out of date.`,
        )
        .join(" ")
    : null;
  return { sources, stale, dataAsOf, banner };
}

// ---------------------------------------------------------------- helpers

const PART_WORD_STAGE: Partial<Record<Stage, string>> = {
  awaiting_gross: "awaiting gross",
  gross_in_progress: "gross in progress",
  processing: "processing",
  embedding: "embedding",
  sectioning: "sectioning",
  staining: "staining",
  qc: "QC",
  ready_for_tray: "ready for tray",
  delivered: "delivered",
  canceled: "canceled",
};

const SOURCE_ENTRY_WORD: Record<string, string> = {
  not_started: "no approved record",
  pending_entry: "entry pending",
  entered_attested: "entered (staff attested), awaiting source acknowledgment",
  source_acknowledged: "acknowledged by source (simulated)",
  failed: "source update failed",
};

/** Turn readiness phrases into the compact table form; falls back to the original text. */
export function shortEligible(s: string): string {
  let m = s.match(/^(.+) eligible for the next processing run$/);
  if (m) return `${m[1]} for processing`;
  m = s.match(/^Part (\w+): ready for grossing$/);
  if (m) return `Part ${m[1]} for grossing`;
  m = s.match(/^Sectioning: (.+)$/);
  if (m) return `${m[1].replace(/ \(\d+ planned\)/g, "")} for sectioning`;
  m = s.match(/^(\d+) slide\(s\) ready for tray$/);
  if (m) return `${m[1]} ${m[1] === "1" ? "slide" : "slides"} for tray`;
  m = s.match(/^Part (\w+): enter approved gross description in source system \(pending\)$/);
  if (m) return `Part ${m[1]} source-system entry`;
  return s;
}

/**
 * Group short eligible phrases by what they are eligible for, so a row reads "Parts A, B, C for grossing"
 * instead of repeating the action per part. Phrases without a " for " action are kept as they are.
 */
export function groupEligible(items: string[]): string[] {
  const order: string[] = [];
  const by = new Map<string, string[]>();
  for (const s of items) {
    const m = /^(.+?) for (.+)$/.exec(s);
    const key = m ? `for ${m[2]}` : `\u0000${s}`;
    if (!by.has(key)) {
      by.set(key, []);
      order.push(key);
    }
    by.get(key)!.push(m ? m[1] : s);
  }
  return order.map((key) => {
    const subjects = by.get(key)!;
    if (key.startsWith("\u0000")) return subjects[0];
    const letters = subjects.map((x) => /^Part (\w+)$/.exec(x)?.[1]);
    const who = letters.every(Boolean) ? (letters.length > 1 ? `Parts ${letters.join(", ")}` : `Part ${letters[0]}`) : subjects.join(", ");
    return `${who} ${key}`;
  });
}

/** Letters of parts whose approved gross description still has to be entered in the source system. */
function sourceEntryLetters(documentation: string[]): string[] {
  return documentation.map((d) => /^Part (\w+) source-system entry$/.exec(d)?.[1] ?? d);
}

function isDocumentationEligible(s: string): boolean {
  return /source system/i.test(s);
}

function shortBlocked(part: PartReadiness): string[] {
  const out: string[] = [];
  if (part.holds.length) out.push(`Part ${part.designation} on hold (${part.holds.map((h) => h.displayId).join(", ")})`);
  for (const b of part.blockedBy) {
    if (/^H-\d+ on /.test(b) || /cannot be approved/.test(b) || /held from processing/.test(b) || /Sectioning held/.test(b)) continue; // covered by the hold line
    const m = b.match(/^(.+) loaded but not eligible for processing: gross record not approved/);
    if (m) out.push(`${m[1]} waiting for gross record approval`);
    else if (/^Review needed:/.test(b)) out.push(`Part ${part.designation}: review canceled/amended work`);
    else out.push(b.length > 90 ? `${b.slice(0, 87)}...` : b);
  }
  return out;
}

function stainText(s: { isPas: boolean; stain: string; kind: string; workOrder: string | null; target: string; authorization: string; sourceReference: string; status: string }): string {
  const name = s.kind === "levels" ? `Levels ${s.stain}` : s.kind === "recut" ? `Recut ${s.stain}` : s.stain;
  const wo = s.workOrder ? `(${s.workOrder})` : "(no work order yet)";
  return `${name} ${wo} · ${s.target} · Source: ${s.authorization} — ${s.sourceReference}`;
}

const AUTH_LABEL = AUTHORIZATION_SOURCE as Record<string, string>;

interface PartStainSourceRow {
  part_id: string;
  designation: string;
  requested_stains: string;
  src_order: string;
  source_version: number;
}

function buildStains(part: PartReadiness, orderLine: PartStainSourceRow | undefined): StainEntry[] {
  const out: StainEntry[] = part.workOrders
    .filter((w) => w.stain || w.kind !== "stain")
    .map((w) => {
      const stain = w.stain ?? w.kind;
      const isPas = stain.toUpperCase() === "PAS";
      const canceled = w.status === "canceled" || w.status === "cancel_review";
      const needsReview = w.status === "cancel_review" || w.status === "amended_review";
      const target = w.slideLabels.length ? w.slideLabels.join(", ") : w.targetBlockLabel ?? `Part ${part.designation} (block not yet assigned)`;
      const authorization = AUTH_LABEL[w.authorizationSource] ?? w.authorizationSource;
      const e = { workOrderId: w.id, workOrder: w.displayId, stain, kind: w.kind, isPas, status: w.status, canceled, needsReview, target, authorization, sourceReference: w.sourceReference };
      return { ...e, text: stainText(e) };
    });
  // Stains requested on the source order line that have no work order yet (explicit order data, never inferred).
  if (orderLine) {
    let requested: { stain?: string }[] = [];
    try {
      requested = JSON.parse(orderLine.requested_stains) as { stain?: string }[];
    } catch {
      requested = [];
    }
    for (const r of requested) {
      const stain = (r.stain ?? "").trim();
      if (!stain) continue;
      const covered = part.workOrders.some((w) => (w.stain ?? "").toUpperCase() === stain.toUpperCase() && w.kind === "stain");
      if (covered) continue;
      const e = {
        workOrderId: null, workOrder: null, stain, kind: "stain", isPas: stain.toUpperCase() === "PAS", status: "requested_on_order",
        canceled: false, needsReview: false, target: `Part ${part.designation} (block not yet assigned)`, authorization: AUTH_LABEL.source_order,
        sourceReference: `${orderLine.src_order} v${orderLine.source_version} · part ${orderLine.designation} (requested on order; work order not created yet)`,
      };
      out.push({ ...e, text: stainText(e) });
    }
  }
  return out;
}

function holdEntries(list: { id: string; displayId: string; scopeLabel: string; reasonText: string; blocks: string[]; clarificationId: string | null; placedAt: string }[]): HoldEntry[] {
  return [...new Map(list.map((h) => [h.id, { ...h }])).values()];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, routine: 2 };

function pickOwnerTask(tasks: TaskEntry[]): TaskEntry | null {
  if (!tasks.length) return null;
  return [...tasks].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )[0];
}

function ownerText(t: TaskEntry | null, count: number): string {
  if (!t) return "None (no open task)";
  const who = t.ownerName ?? `Unassigned${t.ownerRole ? ` (${t.ownerRole.replace(/_/g, " ")})` : ""}`;
  return `${who}: ${t.title}${count > 1 ? ` (+${count - 1} more)` : ""}`;
}

function mrnLabel(mrn: string, tenant: string): string {
  return `MRN ${mrn}, ${tenant}`;
}

// ---------------------------------------------------------------- main query

interface AccRow {
  id: string;
  accession_number: string;
  namespace: string;
  assigned_pathologist_id: string | null;
  priority: string;
  received_day: string;
  case_status: string;
  issued_at: string;
  updated_at: string;
  office_name: string;
  clinician_name: string | null;
  clinician_credential: string | null;
  family_name: string;
  given_name: string;
  source_mrn: string;
  tenant_name: string;
}

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_role: string | null;
  priority: string;
  due_at: string | null;
  created_at: string;
  version: number;
  accession_id: string | null;
  intake_item_id: string | null;
}

function toTask(t: TaskRow): TaskEntry {
  return {
    id: t.id, kind: t.kind, title: t.title, status: t.status, ownerId: t.owner_id, ownerName: t.owner_name, ownerRole: t.owner_role,
    priority: t.priority, dueAt: t.due_at, createdAt: t.created_at, version: t.version,
  };
}

const NON_CONFIRMING_ACTIONS = /^(task\.|worklist\.|command\.)/;

/** The worklist version (seq) right now. */
export function worklistVersion(db: DB): number {
  return currentWorklistSeq({ db });
}

/** Options for loadWorklistRows: restrict to one accession (case page), or skip routing-exception intake rows. */
export interface LoadRowsOptions {
  /** One accession (any status, on today's list or not). Change tags still come from ackedSeq. */
  accessionId?: string;
  /** Include intake items in routing exception (default true; ignored when accessionId is set). */
  includeIntake?: boolean;
}

/**
 * Every case on today's worklist with derived readiness, before view/filters:
 * cases received today, open older cases, older cases with open work orders,
 * and older cases whose approved gross record still awaits source-system entry
 * (Sam's late-entry queue). Plus intake items in routing exception.
 */
export function loadWorklistRows(db: DB, ackedSeq: number, now: string, opts: LoadRowsOptions = {}): WorklistRow[] {
  const one = opts.accessionId ?? null;
  const accessions = db
    .prepare(
      `SELECT a.id, a.accession_number, a.namespace, a.assigned_pathologist_id, a.priority, a.received_day, a.case_status, a.issued_at, a.updated_at,
              o.name AS office_name, c.display_name AS clinician_name, c.credential AS clinician_credential,
              p.family_name, p.given_name, p.source_mrn, t.name AS tenant_name
         FROM accession a
         JOIN office o ON o.id = a.office_id
         JOIN patient_ref p ON p.id = a.patient_ref_id
         JOIN source_tenant t ON t.id = p.tenant_id
         LEFT JOIN clinician c ON c.id = a.ordering_clinician_id
        WHERE ${
          one
            ? "a.id = @one"
            : `a.case_status <> 'canceled' AND (a.is_prior_day = 0 OR a.case_status = 'open'
           OR EXISTS (SELECT 1 FROM work_order wo WHERE wo.accession_id = a.id AND wo.status IN ('requested','in_progress','cancel_review','amended_review'))
           OR EXISTS (SELECT 1 FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id
                       WHERE sp.accession_id = a.id AND sp.status = 'active' AND gr.state = 'approved_for_downstream' AND gr.source_update_state IN ('pending_entry','failed')))`
        }
        ORDER BY a.accession_number`,
    )
    .all(one ? { one } : {}) as AccRow[];
  const ids = accessions.map((a) => a.id);
  const readiness = computeReadiness(db, ids);
  const accClause = one ? "AND accession_id = @one" : "";
  const accParams = one ? { one } : {};

  // Open tasks (owner = who holds the next step).
  const openTasks = db
    .prepare(
      `SELECT t.id, t.kind, t.title, t.status, t.owner_id, s.display_name AS owner_name, t.owner_role, t.priority, t.due_at, t.created_at, t.version,
              t.accession_id, t.intake_item_id
         FROM task t LEFT JOIN staff s ON s.id = t.owner_id
        WHERE t.status IN ('open','in_progress') ${one ? "AND t.accession_id = @one" : ""}`,
    )
    .all(accParams) as TaskRow[];
  const tasksByAcc = new Map<string, TaskEntry[]>();
  const tasksByIntake = new Map<string, TaskEntry[]>();
  for (const t of openTasks) {
    if (t.accession_id) (tasksByAcc.get(t.accession_id) ?? tasksByAcc.set(t.accession_id, []).get(t.accession_id)!).push(toTask(t));
    else if (t.intake_item_id) (tasksByIntake.get(t.intake_item_id) ?? tasksByIntake.set(t.intake_item_id, []).get(t.intake_item_id)!).push(toTask(t));
  }

  // Change feed since the user's acknowledgment.
  const changes = db
    .prepare(`SELECT seq, accession_id, intake_item_id, change_type, summary FROM worklist_change WHERE seq > @acked ${accClause} ORDER BY seq`)
    .all({ acked: ackedSeq, ...accParams }) as { seq: number; accession_id: string | null; intake_item_id: string | null; change_type: ChangeTag; summary: string }[];
  const changeByKey = new Map<string, { types: Set<ChangeTag>; summaries: string[] }>();
  for (const c of changes) {
    const key = c.accession_id ? `a:${c.accession_id}` : c.intake_item_id ? `i:${c.intake_item_id}` : null;
    if (!key) continue;
    const entry = changeByKey.get(key) ?? { types: new Set<ChangeTag>(), summaries: [] };
    entry.types.add(c.change_type);
    entry.summaries.push(tidyPlurals(c.summary));
    changeByKey.set(key, entry);
  }
  const tagFor = (key: string): RowTag => {
    const e = changeByKey.get(key);
    if (!e) return { change: null, tags: [], summaries: [] };
    // Canceled work outranks "new" so it can never be hidden behind it; every applicable tag is still listed.
    const change: ChangeTag = e.types.has("canceled") ? "canceled" : e.types.has("new") ? "new" : "changed";
    const tags: ChangeTag[] = [];
    if (e.types.has("new")) tags.push("new");
    if (e.types.has("canceled")) tags.push("canceled");
    if (!tags.length) tags.push("changed");
    return { change, tags, summaries: e.summaries };
  };

  // Last confirmed update candidates.
  const staffNames = new Map(
    (db.prepare("SELECT id, display_name FROM staff").all() as { id: string; display_name: string }[]).map((s) => [s.id, s.display_name]),
  );
  const lastByAcc = new Map<string, LastUpdate>();
  // `laterWinsTie`: audit rows arrive in log order (seq), so with the demo clock paused (several events at
  // one timestamp) the LATER logged event is the last update, not the first (e.g. "approved", not "draft started").
  const consider = (accId: string, at: string | null, origin: UpdateOrigin, by: string | null, summary: string, laterWinsTie = false) => {
    if (!at) return;
    const cur = lastByAcc.get(accId);
    const t = Date.parse(at);
    const c = cur ? Date.parse(cur.at) : -Infinity;
    if (!cur || t > c || (laterWinsTie && t === c)) lastByAcc.set(accId, { at, origin, by, summary: tidyPlurals(summary) });
  };
  if (ids.length) {
    const auditRows = db
      .prepare(
        `SELECT accession_id, at, origin, actor_id, action, summary FROM audit_event
          WHERE accession_id IS NOT NULL AND action NOT LIKE 'task.%' AND action NOT LIKE 'worklist.%' AND action NOT LIKE 'command.%' ${accClause}
          ORDER BY seq`,
      )
      .all(accParams) as { accession_id: string; at: string; origin: string; actor_id: string | null; action: string; summary: string }[];
    for (const r of auditRows) {
      if (NON_CONFIRMING_ACTIONS.test(r.action)) continue;
      const origin: UpdateOrigin = r.origin === "import" || r.origin === "simulator" ? "Source (simulated)" : "Local";
      consider(r.accession_id, r.at, origin, r.actor_id && staffNames.has(r.actor_id) ? staffNames.get(r.actor_id)! : null, r.summary, true);
    }
    const grossRows = db
      .prepare(
        `SELECT sp.accession_id, sp.designation, gr.updated_at, gr.approved_at, gr.source_entry_at, gr.source_ack_at, gr.approved_by, gr.source_entry_by, gr.grosser_id, gr.state
           FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id WHERE gr.state <> 'superseded' ${one ? "AND sp.accession_id = @one" : ""}`,
      )
      .all(accParams) as { accession_id: string; designation: string; updated_at: string; approved_at: string | null; source_entry_at: string | null; source_ack_at: string | null; approved_by: string | null; source_entry_by: string | null; grosser_id: string | null; state: string }[];
    for (const g of grossRows) {
      consider(g.accession_id, g.updated_at, "Local", g.grosser_id ? staffNames.get(g.grosser_id) ?? null : null, `Gross record part ${g.designation} updated (${g.state.replace(/_/g, " ")})`);
      consider(g.accession_id, g.approved_at, "Local", g.approved_by ? staffNames.get(g.approved_by) ?? null : null, `Gross record part ${g.designation} approved for downstream use`);
      consider(g.accession_id, g.source_entry_at, "Local", g.source_entry_by ? staffNames.get(g.source_entry_by) ?? null : null, `Part ${g.designation} gross description entered in source system (staff attested)`);
      consider(g.accession_id, g.source_ack_at, "Source (simulated)", null, `Part ${g.designation} source-system entry acknowledged (simulated)`);
    }
    const blockRows = db
      .prepare(`SELECT accession_id, label_text, location_confirmed_at, location_confirmed_by FROM block WHERE location_confirmed_at IS NOT NULL AND status = 'active' ${accClause}`)
      .all(accParams) as { accession_id: string; label_text: string; location_confirmed_at: string; location_confirmed_by: string | null }[];
    for (const b of blockRows) consider(b.accession_id, b.location_confirmed_at, "Local", b.location_confirmed_by ? staffNames.get(b.location_confirmed_by) ?? null : null, `Block ${b.label_text} location confirmed`);
    // A source version counts from when the lab RECEIVED it (imported_at), not the source's own timestamp:
    // after an outage the late import is what the lab actually saw.
    const srcRows = db
      .prepare(
        `SELECT DISTINCT sp.accession_id, so.source_order_id, so.source_version, so.source_updated_at, so.imported_at
           FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id ${one ? "WHERE sp.accession_id = @one" : ""}`,
      )
      .all(accParams) as { accession_id: string; source_order_id: string; source_version: number; source_updated_at: string; imported_at: string }[];
    for (const s of srcRows) {
      consider(
        s.accession_id, s.imported_at, "Source (simulated)", null,
        `Order ${s.source_order_id} v${s.source_version} received from the source (simulated; source time ${fmtTime(s.source_updated_at)} ET)`,
      );
    }
  }

  // Stains requested on order lines (to show PAS requested on the order before a work order exists).
  const orderLines = db
    .prepare(
      `SELECT sp.id AS part_id, sop.designation, sop.requested_stains, so.source_order_id AS src_order, so.source_version
         FROM specimen_part sp JOIN source_order_part sop ON sop.id = sp.source_order_part_id JOIN source_order so ON so.id = sp.source_order_id
        ${one ? "WHERE sp.accession_id = @one" : ""}`,
    )
    .all(accParams) as PartStainSourceRow[];
  const orderLineByPart = new Map(orderLines.map((r) => [r.part_id, r]));

  const clrDisplay = new Map((db.prepare("SELECT id, display_id FROM clarification").all() as { id: string; display_id: string }[]).map((r) => [r.id, r.display_id]));

  // Open clarifications per accession.
  const clarCounts = new Map(
    (db
      .prepare(
        `SELECT accession_id, COUNT(*) AS n FROM clarification WHERE accession_id IS NOT NULL AND state NOT IN ('resolved','canceled') ${accClause} GROUP BY accession_id`,
      )
      .all(accParams) as { accession_id: string; n: number }[]).map((r) => [r.accession_id, r.n]),
  );

  const rows: WorklistRow[] = [];
  for (const a of accessions) {
    const r = readiness.get(a.id);
    if (!r) continue;
    const row = buildCaseRow(a, r, tasksByAcc.get(a.id) ?? [], tagFor(`a:${a.id}`), lastByAcc.get(a.id) ?? null, orderLineByPart, clarCounts.get(a.id) ?? 0, now);
    for (const h of [...row.holds, ...row.parts.flatMap((p) => p.holds)]) h.clarificationDisplayId = h.clarificationId ? clrDisplay.get(h.clarificationId) ?? null : null;
    rows.push(row);
  }
  if (one || opts.includeIntake === false) return rows;

  // Intake items in routing exception (no approved rule): their own group, never a guessed doctor.
  const exceptions = db
    .prepare(
      `SELECT ii.id, ii.display_id, ii.office_id, ii.observed_office_text, ii.received_at, ii.status, ii.updated_at,
              o.name AS office_name, rd.status AS routing_status, rd.explanation
         FROM intake_item ii
         JOIN routing_decision rd ON rd.intake_item_id = ii.id AND rd.status = 'exception'
         LEFT JOIN office o ON o.id = ii.office_id
        WHERE ii.status NOT IN ('accessioned','canceled')
        ORDER BY ii.received_at, ii.display_id`,
    )
    .all() as { id: string; display_id: string; office_id: string | null; observed_office_text: string | null; received_at: string; status: string; updated_at: string; office_name: string | null; routing_status: string; explanation: string }[];
  for (const e of exceptions) {
    const holds = activeHolds(db, scopesForIntake(db, e.id)).map((h) => ({
      id: h.id, displayId: h.display_id, scopeLabel: h.scope_label, reasonText: h.reason_text, blocks: blockedTransitions(h), clarificationId: h.clarification_id,
      clarificationDisplayId: h.clarification_id ? clrDisplay.get(h.clarification_id) ?? null : null, placedAt: h.placed_at,
    }));
    const tasks = tasksByIntake.get(e.id) ?? [];
    const owner = pickOwnerTask(tasks);
    const last = db
      .prepare(
        `SELECT at, origin, actor_id, summary FROM audit_event WHERE intake_item_id = ? AND action NOT LIKE 'task.%' AND action NOT LIKE 'worklist.%' ORDER BY at DESC, seq DESC LIMIT 1`,
      )
      .get(e.id) as { at: string; origin: string; actor_id: string | null; summary: string } | undefined;
    // No audit evidence: the receipt time is known, but who/what made the last change is not.
    const lastAt = last?.at ?? e.updated_at ?? e.received_at;
    const lastOrigin: UpdateOrigin | null = !last ? null : last.origin === "import" || last.origin === "simulator" ? "Source (simulated)" : "Local";
    const lastBy = last?.actor_id ? staffNames.get(last.actor_id) ?? null : null;
    const order = db
      .prepare(
        `SELECT p.family_name, p.given_name, p.source_mrn, t.name AS tenant_name, c.display_name AS clinician_name
           FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id JOIN patient_ref p ON p.id = so.patient_ref_id
           JOIN source_tenant t ON t.id = p.tenant_id LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
          WHERE l.intake_item_id = ? LIMIT 1`,
      )
      .get(e.id) as { family_name: string; given_name: string; source_mrn: string; tenant_name: string; clinician_name: string | null } | undefined;
    const tag = tagFor(`i:${e.id}`);
    const office = e.office_name ?? e.observed_office_text ?? "Unknown office";
    rows.push({
      kind: "intake", id: e.id, accessionNumber: null, provisionalId: e.display_id, href: `/intake?item=${encodeURIComponent(e.display_id)}`, pathologistId: null,
      patientLabel: order ? `${order.family_name}, ${order.given_name}` : "Unknown (no linked order)", mrnLabel: order ? mrnLabel(order.source_mrn, order.tenant_name) : "MRN Unknown",
      office, clinician: order?.clinician_name ?? null, priority: "routine", receivedDay: labDay(e.received_at),
      stage: "intake", stageLabel: "Intake: routing exception", partsSummary: "Not accessioned", parts: [], holds,
      stains: [], pas: [], hasPas: false, pasNeedsReview: false,
      readinessText: `Not ready: no approved routing rule for ${office}. A lead must assign a dermatopathologist with a reason.`,
      eligibleShort: [], blockedShort: [`Routing exception: ${office}`], isComplete: false,
      blocks: { prepared: 0, expected: null, expectedLowerBound: null, text: "Unknown (not accessioned)" },
      sourceEntry: { text: "Not applicable (not accessioned)", pendingParts: [], attestedParts: [] },
      tasks, owner, ownerText: ownerText(owner, tasks.length),
      lastUpdate: {
        at: lastAt, origin: lastOrigin, by: lastBy, summary: last?.summary ?? "Received (no later recorded change)",
        text: `${fmtSmart(lastAt, now)} ET · ${lastOrigin ?? "origin Unknown"}`,
      },
      change: tag.change, changeTags: tag.tags, changeSummaries: tag.summaries,
      routing: { status: ROUTING_STATUS.exception, explanation: e.explanation },
      openClarifications: (db.prepare("SELECT COUNT(*) n FROM clarification WHERE intake_item_id = ? AND state NOT IN ('resolved','canceled')").get(e.id) as { n: number }).n,
      labelPayload: null,
    });
  }
  return rows;
}

/** One case as a worklist row (no change tags), whether or not it is on today's list. Used by the case page. */
export function loadCaseRow(db: DB, accessionId: string, now: string = demoNow(db)): WorklistRow | null {
  return loadWorklistRows(db, Number.MAX_SAFE_INTEGER, now, { accessionId })[0] ?? null;
}

interface RowTag {
  change: ChangeTag | null;
  tags: ChangeTag[];
  summaries: string[];
}

interface LastUpdate {
  at: string;
  origin: UpdateOrigin;
  by: string | null;
  summary: string;
}

/** Work-order statuses that keep a case open: still to do, or canceled/amended at source and awaiting review. */
const OPEN_WO_STATUSES = new Set(["requested", "in_progress", "cancel_review", "amended_review"]);

/**
 * A case is complete only when every active part is delivered AND no work
 * order is still open (including canceled/amended work awaiting review).
 * computeReadiness() alone looks at parts only.
 */
export function caseIsComplete(r: CaseReadiness): boolean {
  return r.isComplete && !r.parts.some((p) => p.workOrders.some((w) => OPEN_WO_STATUSES.has(w.status)));
}

function buildCaseRow(
  a: AccRow,
  r: CaseReadiness,
  tasks: TaskEntry[],
  tag: RowTag,
  last: LastUpdate | null,
  orderLineByPart: Map<string, PartStainSourceRow>,
  openClarifications: number,
  now: string,
): WorklistRow {
  const parts: PartTrackView[] = r.parts.map((p) => {
    const holds = holdEntries(p.holds.map((h) => ({ ...h, blocks: h.blocks as string[] })));
    const stains = buildStains(p, orderLineByPart.get(p.partId));
    const physicalEligible = p.eligible.filter((e) => !isDocumentationEligible(e));
    const word =
      p.status === "canceled" ? "canceled"
      : holds.length ? "hold"
      : p.stage === "delivered" ? "delivered"
      : p.stage === "awaiting_gross" ? "awaiting gross"
      : physicalEligible.length ? "ready"
      : PART_WORD_STAGE[p.stage] ?? STAGE_SHORT[p.stage].toLowerCase();
    return {
      partId: p.partId, designation: p.designation, site: p.site, laterality: p.laterality, procedure: p.procedure, sourceOrderRef: p.sourceOrderRef,
      status: p.status, stage: p.stage, stageLabel: STAGE_SHORT[p.stage], word,
      physical: {
        state: p.physicalState,
        blocks: p.blocks.map((b) => ({ id: b.id, label: b.label, state: b.state })),
        slidesActive: p.slideCounts.active, slidesTotal: p.slideCounts.total,
      },
      documentation: { grossState: p.grossState, grossRecordVersion: p.grossRecordVersion, sourceUpdateState: p.sourceUpdateState },
      blocksPrepared: p.blocks.length, blocksExpected: p.blocksExpected, holds, eligible: p.eligible, blockedBy: p.blockedBy, stains,
    };
  });
  const holds = holdEntries(parts.flatMap((p) => p.holds));
  const stains = parts.flatMap((p) => p.stains);
  const pas = stains.filter((s) => s.isPas);
  const hasPas = pas.some((s) => !s.canceled);
  const pasNeedsReview = pas.some((s) => s.needsReview);

  // Readiness (derived, explained). One finished part never completes the case, and neither does open extra work.
  const eligibleAll = r.parts.flatMap((p) => p.eligible);
  const physical = eligibleAll.filter((e) => !isDocumentationEligible(e)).map(shortEligible);
  const documentation = eligibleAll.filter(isDocumentationEligible).map(shortEligible);
  const blockedShort = r.parts.flatMap(shortBlocked);
  const openWos = stains.filter((s) => s.workOrder && OPEN_WO_STATUSES.has(s.status));
  const isComplete = caseIsComplete(r);
  const eligibleShort = [...physical, ...documentation];
  let readinessText: string;
  const grouped = groupEligible(physical);
  const entryText = documentation.length ? `source entry pending: ${sourceEntryLetters(documentation).join(", ")}` : "";
  if (isComplete && !blockedShort.length) {
    readinessText = entryText ? `All parts delivered; ${entryText}` : "All parts delivered";
  } else {
    const bits: string[] = [];
    if (grouped.length) bits.push(`Eligible: ${grouped.slice(0, 2).join("; ")}${grouped.length > 2 ? ` (+${grouped.length - 2} more)` : ""}`);
    if (blockedShort.length) bits.push(`${bits.length ? "not ready" : "Not ready"}: ${blockedShort[0]}${blockedShort.length > 1 ? ` (+${blockedShort.length - 1} more)` : ""}`);
    if (!bits.length && entryText) bits.push(entryText.charAt(0).toUpperCase() + entryText.slice(1));
    if (!bits.length && r.isComplete && openWos.length) bits.push(`Parts delivered; additional work open: ${openWos.map((w) => w.workOrder).join(", ")}`);
    readinessText = bits.length ? bits.join("; ") : "No eligible work right now";
  }

  // Blocks prepared vs expected (known + unknown = unknown).
  const prepared = parts.reduce((n, p) => n + p.blocksPrepared, 0);
  const activeParts = parts.filter((p) => p.status !== "canceled");
  const knownExpected = activeParts.filter((p) => p.blocksExpected !== null);
  const expected = activeParts.length && knownExpected.length === activeParts.length ? knownExpected.reduce((n, p) => n + (p.blocksExpected ?? 0), 0) : null;
  const lower = knownExpected.length && expected === null ? knownExpected.reduce((n, p) => n + (p.blocksExpected ?? 0), 0) : null;
  const anyGrossRecord = activeParts.some((p) => p.documentation.grossState !== "not_started");
  const blocksText =
    expected !== null ? `${prepared} of ${expected}`
    : lower !== null ? `${prepared} of at least ${lower} (some Unknown)`
    : prepared ? `${prepared} prepared, expected Unknown`
    : anyGrossRecord ? "Unknown (gross record has no cassette count yet)"
    : "Unknown (no gross record yet)";

  const pendingParts = parts.filter((p) => p.documentation.grossState === "approved_for_downstream" && p.documentation.sourceUpdateState === "pending_entry").map((p) => p.designation);
  const attestedParts = parts.filter((p) => p.documentation.sourceUpdateState === "entered_attested").map((p) => p.designation);
  const sourceEntryText = parts
    .map((p) => `${p.designation}: ${p.documentation.grossState === "approved_for_downstream" ? SOURCE_ENTRY_WORD[p.documentation.sourceUpdateState] ?? p.documentation.sourceUpdateState : "no approved record"}`)
    .join(" · ");

  const owner = pickOwnerTask(tasks);
  // No recorded evidence for this case: the row's own update time is known, its origin is not.
  const lastAt = last?.at ?? a.updated_at;
  const lastOrigin: UpdateOrigin | null = last?.origin ?? null;
  return {
    kind: "case",
    id: a.id,
    accessionNumber: a.accession_number,
    provisionalId: null,
    href: `/cases/${encodeURIComponent(a.accession_number)}`,
    pathologistId: a.assigned_pathologist_id,
    patientLabel: `${a.family_name}, ${a.given_name}`,
    mrnLabel: mrnLabel(a.source_mrn, a.tenant_name),
    office: a.office_name,
    clinician: a.clinician_name ? `${a.clinician_name}${a.clinician_credential && !a.clinician_name.startsWith("Dr.") ? `, ${a.clinician_credential}` : ""}` : null,
    priority: a.priority,
    receivedDay: a.received_day,
    stage: r.stage,
    stageLabel: r.stageLabel,
    partsSummary: partsText(parts),
    parts,
    holds,
    stains,
    pas,
    hasPas,
    pasNeedsReview,
    readinessText,
    eligibleShort,
    blockedShort,
    isComplete,
    blocks: { prepared, expected, expectedLowerBound: lower, text: blocksText },
    sourceEntry: { text: sourceEntryText, pendingParts, attestedParts },
    tasks,
    owner,
    ownerText: ownerText(owner, tasks.length),
    lastUpdate: {
      at: lastAt, origin: lastOrigin, by: last?.by ?? null, summary: last?.summary ?? "No recorded change found for this case",
      text: `${fmtSmart(lastAt, now)} ET · ${lastOrigin ?? "origin Unknown"}`,
    },
    change: tag.change,
    changeTags: tag.tags,
    changeSummaries: tag.summaries,
    routing: null,
    openClarifications,
    labelPayload: encodeLabel({ kind: "C", namespace: namespaceCode(a.namespace), accession: a.accession_number }),
  };
}

// ---------------------------------------------------------------- view scope + filters

function inViewScope(view: WorklistView, row: WorklistRow, today: string, filters: WorklistFilters): boolean {
  if (filters.scope === "all") return true;
  if (view === "operations") return true;
  if (row.kind === "intake") return view === "accessioning";
  const stages = new Set(row.parts.map((p) => p.stage));
  switch (view) {
    case "accessioning":
      return row.receivedDay === today || row.holds.length > 0 || row.openClarifications > 0;
    case "grossing":
      if (filters.queue === "gross_pending") return hasGrossPending(row);
      if (filters.queue === "source_entry") return row.sourceEntry.pendingParts.length > 0;
      if (filters.queue === "source_attested") return row.sourceEntry.attestedParts.length > 0;
      return stages.has("awaiting_gross") || stages.has("gross_in_progress") || row.sourceEntry.pendingParts.length > 0;
    case "histotech":
      return (
        ["processing", "embedding", "sectioning", "staining", "qc", "ready_for_tray"].some((s) => stages.has(s as Stage)) ||
        row.stains.some((s) => s.workOrder && OPEN_WO_STATUSES.has(s.status)) ||
        row.parts.some((p) => p.blockedBy.some((b) => /^Review needed/.test(b)))
      );
  }
  return true;
}

/** A part awaiting grossing or with a gross record not yet approved (the Operations "awaiting an approved gross record" count). */
export function isGrossPending(p: { status: string; stage: Stage; documentation: { grossState: string } }): boolean {
  return p.status !== "canceled" && p.documentation.grossState !== "approved_for_downstream" && (p.stage === "awaiting_gross" || p.stage === "gross_in_progress");
}
function hasGrossPending(row: WorklistRow): boolean {
  return row.parts.some(isGrossPending);
}

function matchesFilters(row: WorklistRow, f: WorklistFilters, staffId: string, activeDoctorIds: Set<string>): boolean {
  if (f.doctor) {
    if (f.doctor === "unassigned") {
      // Rows outside every active doctor's group: routing exceptions and cases whose doctor is missing or inactive.
      if (row.pathologistId !== null && activeDoctorIds.has(row.pathologistId)) return false;
    } else if (row.pathologistId !== f.doctor) return false;
  }
  if (f.stage && !(row.stage === f.stage || row.parts.some((p) => p.stage === f.stage))) return false;
  // PAS still to do, plus canceled/amended PAS whose prepared material needs review (shown as canceled, never as active PAS).
  if (f.pasOnly && !row.hasPas && !row.pasNeedsReview) return false;
  if (f.onHold && !row.holds.length) return false;
  if (f.mine && !row.tasks.some((t) => t.ownerId === staffId)) return false;
  if (f.changedOnly && !row.change) return false;
  if (f.queue === "gross_pending" && !hasGrossPending(row)) return false;
  if (f.queue === "source_entry" && !row.sourceEntry.pendingParts.length) return false;
  if (f.queue === "source_attested" && !row.sourceEntry.attestedParts.length) return false;
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    const hay = [row.accessionNumber, row.provisionalId, row.office, row.clinician, ...row.stains.map((s) => s.workOrder)].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function defaultSort(a: WorklistRow, b: WorklistRow): number {
  const ha = a.holds.length ? 0 : 1;
  const hb = b.holds.length ? 0 : 1;
  if (ha !== hb) return ha - hb;
  const ka = a.accessionNumber ?? a.provisionalId ?? "";
  const kb = b.accessionNumber ?? b.provisionalId ?? "";
  return ka.localeCompare(kb);
}

const COLOR_ORDER = ["teal", "violet", "amber"];

export interface GetWorklistOptions {
  staffId: string;
  view: WorklistView;
  filters?: WorklistFilters;
}

/** The worklist as one user sees it in one view, with change tags relative to their acknowledgment. */
export function getWorklist(db: DB, opts: GetWorklistOptions): WorklistData {
  const filters = opts.filters ?? {};
  const now = demoNow(db);
  const seq = currentWorklistSeq({ db });
  const ackRow = db.prepare("SELECT acked_seq, acked_at FROM worklist_ack WHERE staff_id = ? AND view = ?").get(opts.staffId, opts.view) as
    | { acked_seq: number; acked_at: string }
    | undefined;
  const ackedSeq = ackRow?.acked_seq ?? 0;
  const all = loadWorklistRows(db, ackedSeq, now);
  const today = labDay(now);

  const doctors = (db
    .prepare("SELECT id, display_name AS name, color_token FROM staff WHERE role = 'pathologist' AND active = 1")
    .all() as { id: string; name: string; color_token: string | null }[])
    .map((d) => ({ id: d.id, name: d.name, colorToken: d.color_token }))
    .sort((x, y) => COLOR_ORDER.indexOf(x.colorToken ?? "") - COLOR_ORDER.indexOf(y.colorToken ?? "") || x.name.localeCompare(y.name));
  const activeDoctorIds = new Set(doctors.map((d) => d.id));

  const inScope = all.filter((r) => inViewScope(opts.view, r, today, filters));
  const shown = inScope.filter((r) => matchesFilters(r, filters, opts.staffId, activeDoctorIds)).sort(defaultSort);

  const changes = { new: 0, changed: 0, canceled: 0, total: 0 };
  for (const r of inScope) {
    if (!r.change) continue;
    changes[r.change] += 1;
    changes.total += 1;
  }

  const groups: WorklistGroup[] = [];
  const counts = (rows: WorklistRow[]) => ({
    rows: rows.length,
    pas: rows.filter((r) => r.hasPas).length,
    pasReview: rows.filter((r) => r.pasNeedsReview).length,
    onHold: rows.filter((r) => r.holds.length > 0).length,
  });
  // Routing exceptions: intake items with no approved rule. Never a guessed doctor, never a doctor color.
  const exceptions = shown.filter((r) => r.kind === "intake");
  if (exceptions.length) {
    groups.push({
      key: "unassigned", kind: "routing_exception", pathologistId: null, name: "Unassigned: routing exception", colorToken: null, colorName: null, isException: true,
      counts: counts(exceptions), rows: exceptions,
    });
  }
  // Accessioned cases whose assigned doctor is missing or no longer active: a data problem, not a routing exception.
  const noDoctor = shown.filter((r) => r.kind === "case" && (r.pathologistId === null || !activeDoctorIds.has(r.pathologistId)));
  if (noDoctor.length) {
    groups.push({
      key: "no_doctor", kind: "no_doctor", pathologistId: null, name: "No active assigned dermatopathologist", colorToken: null, colorName: null, isException: true,
      counts: counts(noDoctor), rows: noDoctor,
    });
  }
  for (const d of doctors) {
    const rows = shown.filter((r) => r.kind === "case" && r.pathologistId === d.id);
    if (!rows.length) continue;
    groups.push({ key: d.id, kind: "doctor", pathologistId: d.id, name: d.name, colorToken: d.colorToken, colorName: d.colorToken, isException: false, counts: counts(rows), rows });
  }

  return {
    view: opts.view,
    viewLabel: VIEW_LABEL[opts.view],
    columns: VIEW_COLUMNS[opts.view],
    filters,
    staffId: opts.staffId,
    generatedAt: now,
    seq,
    ack: { ackedSeq, ackedAt: ackRow?.acked_at ?? null, never: !ackRow },
    changes,
    freshness: loadSourceFreshness(db, now),
    groups,
    totals: { inScope: inScope.length, shown: shown.length, allCases: all.length },
    doctors,
    lastSnapshot: loadLastSnapshot(db, opts.staffId, opts.view, inScope),
  };
}

/** The user's latest snapshot of this view and how many in-scope rows changed after its version (read only). */
function loadLastSnapshot(db: DB, staffId: string, view: WorklistView, inScope: WorklistRow[]): LastSnapshot | null {
  const snap = db
    .prepare("SELECT display_id, seq, generated_at, format FROM worklist_snapshot WHERE generated_by = ? AND view = ? ORDER BY seq DESC, generated_at DESC, display_id DESC LIMIT 1")
    .get(staffId, view) as { display_id: string; seq: number; generated_at: string; format: string } | undefined;
  if (!snap) return null;
  const keys = new Set(inScope.map((r) => (r.kind === "case" ? `a:${r.id}` : `i:${r.id}`)));
  const changed = new Set<string>();
  for (const c of db.prepare("SELECT accession_id, intake_item_id FROM worklist_change WHERE seq > ?").all(snap.seq) as { accession_id: string | null; intake_item_id: string | null }[]) {
    const key = c.accession_id ? `a:${c.accession_id}` : c.intake_item_id ? `i:${c.intake_item_id}` : null;
    if (key && keys.has(key)) changed.add(key);
  }
  return { displayId: snap.display_id, seq: snap.seq, generatedAt: snap.generated_at, format: snap.format, changedRows: changed.size };
}

/** Find one row on today's worklist (any view, unfiltered), as one user sees it. */
export function findWorklistRow(db: DB, staffId: string, key: string): WorklistRow | null {
  const data = getWorklist(db, { staffId, view: "operations", filters: { scope: "all" } });
  for (const g of data.groups) for (const r of g.rows) if (r.id === key || r.accessionNumber === key || r.provisionalId === key) return r;
  return null;
}

// ---------------------------------------------------------------- saved filters

export interface SavedFilter {
  id: string;
  name: string;
  view: WorklistView;
  filters: WorklistFilters;
  createdAt: string;
}

export function listSavedFilters(db: DB, staffId: string, view?: WorklistView): SavedFilter[] {
  const rows = (view
    ? db.prepare("SELECT id, name, view, filters, created_at FROM saved_filter WHERE staff_id = ? AND view = ? ORDER BY name").all(staffId, view)
    : db.prepare("SELECT id, name, view, filters, created_at FROM saved_filter WHERE staff_id = ? ORDER BY view, name").all(staffId)) as {
    id: string; name: string; view: WorklistView; filters: string; created_at: string;
  }[];
  return rows.map((r) => {
    let filters: WorklistFilters = {};
    try {
      filters = JSON.parse(r.filters) as WorklistFilters;
    } catch {
      filters = {};
    }
    return { id: r.id, name: r.name, view: r.view, filters, createdAt: r.created_at };
  });
}

// ---------------------------------------------------------------- snapshots + CSV

export interface SnapshotRecord {
  id: string;
  displayId: string;
  generatedAt: string;
  generatedBy: string;
  generatedByName: string;
  seq: number;
  view: string;
  filters: string | null;
  format: string;
  rowCount: number;
  dataAsOf: string | null;
}

export function getSnapshot(db: DB, id: string): SnapshotRecord | null {
  const r = db
    .prepare(
      `SELECT ws.*, s.display_name AS by_name FROM worklist_snapshot ws JOIN staff s ON s.id = ws.generated_by WHERE ws.id = ? OR ws.display_id = ?`,
    )
    .get(id, id) as
    | { id: string; display_id: string; generated_at: string; generated_by: string; by_name: string; seq: number; view: string; filters: string | null; format: string; row_count: number; data_as_of: string | null }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, displayId: r.display_id, generatedAt: r.generated_at, generatedBy: r.generated_by, generatedByName: r.by_name, seq: r.seq, view: r.view,
    filters: r.filters, format: r.format, rowCount: r.row_count, dataAsOf: r.data_as_of,
  };
}

/** Flatten the visible rows for print/CSV (doctor group order kept). */
export function snapshotRows(data: WorklistData): { group: WorklistGroup; row: WorklistRow }[] {
  return data.groups.flatMap((g) => g.rows.map((row) => ({ group: g, row })));
}

/** Guard against spreadsheet formula injection and quote every cell. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export interface SnapshotMeta {
  displayId: string;
  generatedAt: string;
  generatedBy: string;
  seq: number;
  dataAsOf: string | null;
  stale: boolean;
}

/**
 * CSV downtime/transition fallback. Header lines state the generation time
 * (ET, full), the worklist version, the source data age and that the data is
 * synthetic. The file is a copy: it is not updated after download.
 */
export function buildWorklistCsv(data: WorklistData, meta: SnapshotMeta, describe: string): string {
  const lines: string[] = [];
  const asOf = meta.dataAsOf ? fmtFullEt(meta.dataAsOf) : "Unknown";
  lines.push(`# Histology Lab OS worklist snapshot ${meta.displayId} (${data.viewLabel} view)`);
  lines.push(`# Generated: ${fmtFullEt(meta.generatedAt)} by ${meta.generatedBy}`);
  lines.push(`# Worklist version: v${meta.seq}`);
  lines.push(`# Source data as of: ${asOf}${meta.stale ? " (STALE: a simulated source was unreachable or out of date at generation)" : ""}`);
  lines.push(`# Filters: ${describe}. Rows: ${snapshotRows(data).length}`);
  lines.push("# Synthetic demo data. Fictional people and offices. Not updated after download. Not a clinical record.");
  const header = [
    "Assigned dermatopathologist", "Color", "Case", "Provisional intake ID", "Change since acknowledgment", "Parts", "Stage", "Stains (work orders)",
    "Holds", "Readiness", "Blocks prepared / expected", "Source-system entry", "Current task owner", "Last confirmed update", "Update origin",
    "Submitting office", "Ordering clinician",
  ];
  lines.push(header.map(csvCell).join(","));
  for (const { group, row } of snapshotRows(data)) {
    lines.push(
      [
        group.name,
        group.colorName ?? "none",
        row.accessionNumber ?? "",
        row.provisionalId ?? "",
        row.changeTags.map((t) => t[0].toUpperCase() + t.slice(1)).join(", "),
        row.partsSummary,
        row.stageLabel,
        row.stains.length ? row.stains.map((s) => `${s.canceled ? "CANCELED: " : ""}${s.text}${s.needsReview ? " (REVIEW NEEDED: material may already be printed or prepared)" : ""}`).join(" | ") : "None",
        row.holds.length ? row.holds.map((h) => `${h.displayId} ${h.scopeLabel}: ${h.reasonText}`).join(" | ") : "None",
        row.readinessText,
        row.blocks.text,
        row.sourceEntry.text,
        row.ownerText,
        row.lastUpdate.at ? fmtFullEt(row.lastUpdate.at) : "Unknown",
        row.lastUpdate.origin ?? "Unknown",
        row.office,
        row.clinician ?? "Unknown",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function fmtFullEt(iso: string): string {
  return fmtFull(iso);
}
