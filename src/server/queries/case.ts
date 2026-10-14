/**
 * Read model for /cases/[id]: one multipart case with everything linked —
 * parts (physical and documentation tracks kept separate), material, source
 * documents with every version, related-order and correction records, tasks,
 * clarifications and the local audit history. Also a deterministic
 * "operational summary" computed from those records (not AI).
 */
import type { DB } from "@/server/db/db";
import { demoNow } from "@/server/core/clock";
import { computeReadiness, STAGE_SHORT, type PartReadiness } from "@/server/domain/readiness";
import {
  BLOCK_STATE, BLOCK_STATE_ORDER, CLARIFICATION_CATEGORY, CLARIFICATION_STATE, CUSTODY_STATE, GROSS_STATE, LABEL_STATE, PRINT_STATE,
  RELATED_STATUS, ROUTING_STATUS, SLIDE_STATE, SLIDE_STATE_ORDER, SOURCE_UPDATE_STATE, WORK_ORDER_STATUS, LATERALITY, PROCEDURE,
  type BlockState, type SlideState,
} from "@/lib/domain";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { fmtSmart, fmtAge } from "@/lib/time";
import { actionLabel } from "@/components/case/format";
import { plural, tidyPlurals } from "@/components/worklist/format";
import { caseIsComplete, loadCaseRow, loadSourceFreshness, type FreshnessSummary, type HoldEntry, type StainEntry, type WorklistRow } from "./worklist";

// ---------------------------------------------------------------- types

export type StepState = "done" | "current" | "todo" | "unknown" | "na";
export interface TrackStep {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
}

export interface CaseTask {
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
  completedAt: string | null;
  completedBy: string | null;
  /** Done or canceled: what closed it, from the record logged at that moment ("office answered (simulated)"). */
  closedNote: string | null;
  version: number;
  partDesignation: string | null;
  href: string | null;
}

export interface CasePart {
  partId: string;
  designation: string;
  originalDesignation: string;
  site: string;
  laterality: string | null;
  procedure: string | null;
  sourceOrderRef: string;
  sourceOrderTenant: string;
  status: string;
  stageLabel: string;
  physical: { steps: TrackStep[]; summary: string };
  documentation: { steps: TrackStep[]; grossState: string; grossRecordVersion: number | null; sourceUpdateState: string; summary: string };
  holds: HoldEntry[];
  eligible: string[];
  blockedBy: string[];
  explanation: string[];
  stains: StainEntry[];
  owner: CaseTask | null;
}

export interface MaterialSlide {
  id: string;
  label: string;
  identifier: string;
  stain: string;
  level: string | null;
  state: string;
  stateLabel: string;
  labelState: string;
  labelStateLabel: string;
  status: string;
  workOrder: string | null;
  printJob: { displayId: string; state: string; stateLabel: string } | null;
}

export interface MaterialBlock {
  id: string;
  label: string;
  identifier: string;
  state: string;
  stateLabel: string;
  piecesSubmitted: number | null;
  custody: string;
  location: { code: string; label: string; confirmedAt: string | null; confirmedBy: string | null } | null;
  labelState: string | null;
  printJob: { displayId: string; state: string; stateLabel: string } | null;
  slides: MaterialSlide[];
}

export interface QuantityLine {
  expected: number | null;
  prepared: number | null;
  verified: number | null;
  text: string;
}

export interface MaterialPart {
  partId: string;
  designation: string;
  /** Why the expected block count is Unknown, when it is. */
  expectedUnknownReason: string | null;
  blocks: MaterialBlock[];
  blockCounts: QuantityLine;
  slideCounts: QuantityLine;
}

export interface SourceOrderDoc {
  id: string;
  sourceOrderId: string;
  tenantName: string;
  status: string;
  currentVersion: number;
  sourceUpdatedAt: string;
  importedAt: string;
  reviewState: string;
  /**
   * The local review state as people should read it, derived from the review tasks for this order:
   * "Reviewed: ..." once the review task is done, "Review open: ..." while it waits, else the stored state.
   */
  reviewText: string;
  office: string;
  orderingClinician: string | null;
  clinicalNote: string | null;
  partDesignations: string[];
  /** First version received (the original values); null when no version payload is stored. */
  originalVersion: number | null;
  orderParts: {
    designation: string;
    /** Values in the FIRST version received from the source (kept unchanged). Null = Unknown (not in that payload). */
    original: { site: string | null; laterality: string | null; procedure: string | null; requestedStains: string[] } | null;
    /** The source's current values (version currentVersion). */
    current: { site: string; laterality: string | null; procedure: string | null; requestedStains: string[] };
    /** True when the current source value differs from the original for site, laterality or procedure. */
    changedSinceOriginal: boolean;
    /** The value on this case's part as issued (never silently changed); null when the order line is not on this case. */
    onCase: { site: string; laterality: string | null } | null;
    collectedAt: string | null;
    expectedContainers: number | null;
    status: string;
  }[];
  versions: {
    version: number;
    sourceUpdatedAt: string;
    importedAt: string;
    changeSummary: string | null;
    specimens: { designation: string; site: string | null; laterality: string | null; procedure: string | null; requestedStains: string[] }[];
    clinicalNote: string | null;
    raw: string;
  }[];
  events: { messageId: string; type: string; outcome: string; receivedAt: string; receiptCount: number; detail: string | null }[];
}

export interface RelatedRecord {
  id: string;
  displayId: string;
  status: string;
  statusLabel: string;
  orders: string[];
  reasons: { label: string; detail?: string }[];
  conflicts: { label: string; detail?: string }[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  statement: string;
}

export interface CorrectionRecord {
  id: string;
  displayId: string;
  kind: string;
  status: string;
  description: string;
  relatedAccession: string | null;
  originalRefs: string;
  requestedBy: string;
  requestedAt: string;
  outcomeNote: string | null;
  statement: string;
}

export interface CaseClarification {
  id: string;
  displayId: string;
  category: string;
  state: string;
  stateLabel: string;
  subject: string;
  question: string;
  labOwner: string | null;
  priority: string;
  nextFollowUpAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  open: boolean;
  href: string;
}

export interface HistoryEvent {
  id: string;
  seq: number;
  at: string;
  actorName: string;
  actorRole: string | null;
  origin: string;
  originLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  reason: string | null;
  before: string | null;
  after: string | null;
  parts: string[];
}

export interface SummaryItem {
  text: string;
  evidence: { label: string; href: string }[];
}

export interface CaseDetail {
  generatedAt: string;
  identity: {
    accessionId: string;
    accessionNumber: string;
    namespace: string;
    sourceCaseId: string;
    issuedAt: string;
    issuedBySystem: string;
    patientLabel: string;
    birthDate: string;
    mrn: string;
    tenantName: string;
    officeName: string;
    priority: string;
    caseStatus: string;
    receivedDay: string;
    version: number;
    intakeIds: { id: string; displayId: string }[];
  };
  people: {
    orderingClinician: string | null;
    assignedPathologist: { id: string; name: string; colorToken: string | null } | null;
    routing: { status: string; explanation: string; overrideReason: string | null } | null;
    accessioners: string[];
    currentOwners: { part: string | null; name: string; task: string }[];
  };
  summary: { isComplete: boolean; text: string; stageLabel: string; partsSummary: string; holdCount: number; readinessText: string };
  parts: CasePart[];
  material: MaterialPart[];
  sourceDocuments: SourceOrderDoc[];
  related: RelatedRecord[];
  corrections: CorrectionRecord[];
  tasks: CaseTask[];
  clarifications: CaseClarification[];
  holdsAll: (HoldEntry & { status: string; releasedAt: string | null; releasedBy: string | null; releaseReason: string | null })[];
  history: HistoryEvent[];
  historyFilters: { parts: string[]; actors: string[]; origins: string[] };
  operationalSummary: { label: string; items: SummaryItem[] };
  freshness: FreshnessSummary;
  worklistRow: WorklistRow | null;
}

// ---------------------------------------------------------------- helpers

/** Lower-case words for use mid-sentence, keeping acronyms and identifiers ("QC reviewed" → "QC reviewed", "Sent (simulated)" → "sent (simulated)"). */
function lowerWords(t: string): string {
  return t.replace(/\b([A-Z])([a-z]+)\b/g, (_, a: string, b: string) => a.toLowerCase() + b);
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const ORIGIN_LABEL: Record<string, string> = {
  user: "Local",
  system: "Local (system)",
  import: "Source (simulated)",
  simulator: "Source (simulated)",
  assistant: "Assistant (deterministic demo)",
};

/**
 * Origin "demo" is used both by the seed (history written before the demo day
 * started; ids "aud_seed_...") and by the guided demo when it runs staff actions
 * through the real commands (rehearsal). They are labeled differently.
 */
function originLabel(origin: string, action: string, eventId: string): string {
  if (origin === "simulator" && /clarification/.test(action)) return "Simulated office reply";
  if (origin === "demo") return eventId.startsWith("aud_seed_") ? "Seeded history (synthetic)" : "Demo rehearsal (staff action run by the guided demo)";
  return ORIGIN_LABEL[origin] ?? origin;
}

/** Non-staff actors that appear in the audit log. Never shown as raw ids. */
const SIM_ACTOR_NAME: Record<string, string> = {
  system: "System",
  sim_office: "Simulated office",
  sim_notify: "Simulated notification connector",
  sim_source: "Simulated source system",
};

/** Decode a route segment once, safely: a stray "%" never throws. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const blockIdx = (s: string) => BLOCK_STATE_ORDER.indexOf(s as BlockState);
const slideIdx = (s: string) => SLIDE_STATE_ORDER.indexOf(s as SlideState);

function physicalSteps(p: PartReadiness): TrackStep[] {
  const blocks = p.blocks;
  const slides = p.slides.filter((s) => s.status === "active");
  const nb = blocks.length;
  const blockStep = (key: string, label: string, minState: BlockState): TrackStep => {
    if (!nb) return { key, label, state: "todo", detail: "No blocks yet" };
    const reached = blocks.filter((b) => blockIdx(b.state) >= blockIdx(minState)).length;
    return { key, label, state: reached === nb ? "done" : reached > 0 ? "current" : "todo", detail: `${reached} of ${plural(nb, "block")}` };
  };
  const slideStep = (key: string, label: string, minState: SlideState): TrackStep => {
    if (!slides.length) return { key, label, state: "todo", detail: "No slides planned yet" };
    const reached = slides.filter((s) => slideIdx(s.state) >= slideIdx(minState)).length;
    return { key, label, state: reached === slides.length ? "done" : reached > 0 ? "current" : "todo", detail: `${reached} of ${plural(slides.length, "slide")}` };
  };
  const grossed = p.physicalState === "grossed" || nb > 0;
  const processingStep = blockStep("processing", "Processed", "processed");
  if (nb && processingStep.state !== "done" && blocks.some((b) => b.state === "processing")) processingStep.state = "current";
  return [
    { key: "received", label: "Received", state: p.status === "canceled" ? "na" : "done" },
    { key: "grossed", label: "Grossed", state: grossed ? "done" : "todo", detail: grossed ? plural(nb, "cassette") : "Not grossed yet" },
    processingStep,
    blockStep("embedded", "Embedded", "embedded"),
    blockStep("sectioned", "Sectioned", "sectioned"),
    slideStep("stained", "Stained", "stained"),
    slideStep("qc", "QC reviewed", "qc_reviewed"),
    slideStep("delivered", "Delivered", "delivered"),
  ];
}

function documentationSteps(p: PartReadiness): TrackStep[] {
  const g = p.grossState;
  const has = g !== "not_started";
  const reviewed = g === "operator_reviewed" || g === "approved_for_downstream";
  const approved = g === "approved_for_downstream";
  const su = p.sourceUpdateState;
  const sourceLabel =
    !approved ? "Source-system update: not started"
    : su === "pending_entry" || su === "not_started" ? "Source-system update: pending entry"
    : su === "entered_attested" ? "Source-system update: entered (staff attested), awaiting acknowledgment"
    : su === "source_acknowledged" ? "Source-system update: acknowledged (simulated)"
    : "Source-system update: failed";
  return [
    { key: "draft", label: "Gross record started", state: has ? "done" : "todo", detail: has ? `${GROSS_STATE[g as keyof typeof GROSS_STATE] ?? g}${p.grossRecordVersion ? `, v${p.grossRecordVersion}` : ""}` : undefined },
    // "Operator reviewed" is the stored state name; on screen it says who reviews: the person who grossed it.
    { key: "reviewed", label: "Reviewed by the grosser", state: reviewed ? "done" : g === "needs_clarification" ? "current" : "todo", detail: g === "needs_clarification" ? "Needs clarification" : undefined },
    { key: "approved", label: "Approved for downstream use", state: approved ? "done" : "todo" },
    { key: "source", label: sourceLabel, state: su === "source_acknowledged" ? "done" : approved && (su === "pending_entry" || su === "entered_attested" || su === "not_started") ? "current" : su === "failed" ? "current" : "todo" },
  ];
}

function quantity(expected: number | null, prepared: number | null, verified: number | null, noun: string): QuantityLine {
  const f = (n: number | null) => (n === null ? "Unknown" : String(n));
  // "Verified" is avoided on purpose: a label scan identifies a record, it does not verify tissue.
  return { expected, prepared, verified, text: `${noun}: ${f(expected)} expected, ${f(prepared)} prepared, ${f(verified)} ${verified === 1 ? "label" : "labels"} scanned and matched` };
}

/** Link to the record a task is about, using display ids (the scan field's URL convention). */
function taskHref(db: DB, kind: string, entityType: string, entityId: string): string | null {
  const lookup = (table: string) => (db.prepare(`SELECT display_id AS d FROM ${table} WHERE id = ?`).get(entityId) as { d: string } | undefined)?.d;
  switch (entityType) {
    case "clarification": {
      const d = lookup("clarification");
      return d ? `/clarifications?selected=${encodeURIComponent(d)}` : null;
    }
    case "print_job": {
      const d = lookup("print_job");
      return d ? `/materials?tab=print&selected=${encodeURIComponent(d)}` : null;
    }
    case "tray": {
      const d = lookup("tray");
      return d ? `/materials?tab=trays&selected=${encodeURIComponent(d)}` : null;
    }
    case "retrieval_request": {
      const d = lookup("retrieval_request");
      return d ? `/materials?tab=retrieval&selected=${encodeURIComponent(d)}` : null;
    }
    case "intake_item": {
      const d = lookup("intake_item");
      return d ? `/intake?item=${encodeURIComponent(d)}` : null;
    }
    case "specimen_part":
    case "gross_record": {
      // Source-system entry happens in Sam's queue; other grossing work opens the exact part (?part=D26-04817-A).
      if (kind === "source_entry") return "/grossing?view=source";
      const part = db
        .prepare(
          entityType === "specimen_part"
            ? "SELECT a.accession_number AS acc, sp.designation AS d FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.id = ?"
            : "SELECT a.accession_number AS acc, sp.designation AS d FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id JOIN accession a ON a.id = sp.accession_id WHERE gr.id = ?",
        )
        .get(entityId) as { acc: string; d: string } | undefined;
      return part ? `/grossing?part=${encodeURIComponent(`${part.acc}-${part.d}`)}` : "/grossing";
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- main

/** Resolve an accession number (e.g. D26-04817, any case) or internal id. */
export function resolveCaseId(db: DB, idOrNumber: string): string | null {
  // The caller passes an already-decoded value (decoding twice breaks ids containing "%").
  const key = idOrNumber.trim();
  if (!key) return null;
  const row = db.prepare("SELECT id FROM accession WHERE id = ? OR UPPER(accession_number) = UPPER(?) ORDER BY issued_at LIMIT 1").get(key, key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Audit summaries are written by several modules; a few carry stored codes ("blocks gross_approval,
 * tray_delivery"). The history shows them in words, the same words the hold banner uses.
 */
function readableSummary(summary: string): string {
  return tidyPlurals(summary.replace(/\(blocks ([a-z_]+(?:, [a-z_]+)*)\)/g, (_m, list: string) => `(blocks ${list.replace(/_/g, " ")})`));
}

/** Actions that close a task, in words for the Tasks table ("Done 11:12 AM ET · office answered (simulated)"). */
const CLOSED_BY: Record<string, string> = {
  "clarification.sent": "question sent (simulated)",
  "clarification.acknowledged": "office acknowledged (simulated)",
  "clarification.answered": "office answered (simulated)",
  "clarification.reviewed": "answer reviewed",
  "clarification.resolved": "clarification resolved",
  "clarification.canceled": "clarification canceled",
  "hold.released": "hold released",
};

/**
 * Task titles are written when the task opens. Once it is closed, a state note in the title that is no
 * longer true ("drafted, not yet sent") is dropped, and nested parentheses are flattened.
 */
function taskTitle(title: string, open: boolean): string {
  let t = title.replace(/\((Part \w+) \(([^()]+)\)\)/g, "($1, $2)");
  if (!open) t = t.replace(/\s*\(drafted, not yet sent\)$/, "").replace(/\s*\(acknowledged\)$/, " (after the office acknowledged)");
  return t;
}

const REVIEW_TASK_KINDS = new Set(["order_change_review", "correction_review", "source_conflict"]);

/** Local review state of one source order, derived from its review tasks so it never contradicts them. */
function reviewText(
  stored: string,
  sourceOrderId: string,
  versionCount: number,
  tasks: { kind: string; title: string; detail: string | null; status: string; completed_at: string | null; completed_by: string | null }[],
  nameOf: (id: string | null) => string | null,
  now: string,
): string {
  const mine = tasks.filter((t) => REVIEW_TASK_KINDS.has(t.kind) && `${t.title} ${t.detail ?? ""}`.includes(sourceOrderId));
  const open = mine.find((t) => t.status === "open" || t.status === "in_progress");
  if (open) return `Review open: ${open.title}`;
  const done = mine.filter((t) => t.status === "done" && t.completed_at).sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!))[0];
  if (done) return `Reviewed${done.completed_by && nameOf(done.completed_by) ? ` by ${nameOf(done.completed_by)}` : ""}, ${fmtSmart(done.completed_at!, now)} ET (${done.title})`;
  if (stored === "unreviewed" && versionCount <= 1) return "Nothing to review (initial version only)";
  return stored.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function getCase(db: DB, idOrNumber: string): CaseDetail | null {
  const accId = resolveCaseId(db, idOrNumber);
  if (!accId) return null;
  const now = demoNow(db);
  const a = db
    .prepare(
      `SELECT a.*, o.name AS office_name, p.family_name, p.given_name, p.birth_date, p.source_mrn, t.name AS tenant_name,
              c.display_name AS clinician_name, c.credential AS clinician_credential, co.name AS clinician_office,
              s.display_name AS path_name, s.color_token
         FROM accession a JOIN office o ON o.id = a.office_id JOIN patient_ref p ON p.id = a.patient_ref_id
         JOIN source_tenant t ON t.id = p.tenant_id LEFT JOIN clinician c ON c.id = a.ordering_clinician_id
         LEFT JOIN office co ON co.id = c.office_id LEFT JOIN staff s ON s.id = a.assigned_pathologist_id
        WHERE a.id = ?`,
    )
    .get(accId) as {
    id: string; accession_number: string; namespace: string; source_case_id: string; issued_at: string; issued_by_system: string; office_name: string;
    family_name: string; given_name: string; birth_date: string; source_mrn: string; tenant_name: string; clinician_name: string | null;
    clinician_credential: string | null; clinician_office: string | null; path_name: string | null; color_token: string | null;
    assigned_pathologist_id: string | null; routing_decision_id: string | null; priority: string; case_status: string; received_day: string; version: number;
  };
  const staff = new Map(
    (db.prepare("SELECT id, display_name, role FROM staff").all() as { id: string; display_name: string; role: Role }[]).map((s) => [s.id, s]),
  );
  const nameOf = (id: string | null | undefined) => (id ? staff.get(id)?.display_name ?? SIM_ACTOR_NAME[id] ?? "Unknown person" : null);

  const readiness = computeReadiness(db, [accId]).get(accId)!;
  // The case's own row (stains, holds, readiness text), whether or not it is on today's worklist.
  const worklistRow = loadCaseRow(db, accId, now);

  const intakeIds = db
    .prepare("SELECT id, display_id, received_by, received_at FROM intake_item WHERE accession_id = ? ORDER BY display_id")
    .all(accId) as { id: string; display_id: string; received_by: string | null; received_at: string }[];
  const partRows = db.prepare("SELECT * FROM specimen_part WHERE accession_id = ? ORDER BY designation").all(accId) as {
    id: string; designation: string; original_designation: string; source_order_id: string; source_order_part_id: string; container_id: string | null;
    site_text: string; laterality: string | null;
  }[];
  const orderIds = [...new Set(partRows.map((p) => p.source_order_id))];
  for (const i of intakeIds) {
    for (const l of db.prepare("SELECT source_order_id FROM intake_order_link WHERE intake_item_id = ?").all(i.id) as { source_order_id: string }[]) {
      if (!orderIds.includes(l.source_order_id)) orderIds.push(l.source_order_id);
    }
  }

  // ---- tasks (all, open first)
  const intakeIdList = intakeIds.map((i) => i.id);
  const blockRows = db.prepare("SELECT id, part_id, label_text FROM block WHERE accession_id = ?").all(accId) as { id: string; part_id: string; label_text: string }[];
  const slideRows = db.prepare("SELECT s.id, b.part_id FROM slide s JOIN block b ON b.id = s.block_id WHERE s.accession_id = ?").all(accId) as { id: string; part_id: string }[];
  const partOfEntity = new Map<string, string>();
  for (const p of partRows) {
    partOfEntity.set(p.id, p.designation);
    partOfEntity.set(p.source_order_part_id, p.designation);
    if (p.container_id) partOfEntity.set(p.container_id, p.designation);
  }
  const desigByPartId = new Map(partRows.map((p) => [p.id, p.designation]));
  for (const b of blockRows) partOfEntity.set(b.id, desigByPartId.get(b.part_id) ?? "");
  for (const s of slideRows) partOfEntity.set(s.id, desigByPartId.get(s.part_id) ?? "");
  const grossIds = db.prepare("SELECT gr.id, sp.designation FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id WHERE sp.accession_id = ?").all(accId) as { id: string; designation: string }[];
  for (const g of grossIds) partOfEntity.set(g.id, g.designation);
  const woRows = db.prepare("SELECT id, display_id, target_part_id FROM work_order WHERE accession_id = ?").all(accId) as { id: string; display_id: string; target_part_id: string | null }[];
  for (const w of woRows) if (w.target_part_id) partOfEntity.set(w.id, desigByPartId.get(w.target_part_id) ?? "");

  // Clarifications and holds that concern one part (so their tasks show under that part's owner).
  if (partRows.length) {
    const pIds = partRows.map((p) => p.id);
    const opIds = partRows.map((p) => p.source_order_part_id);
    const clarParts = db
      .prepare(
        `SELECT id, specimen_part_id, order_part_id FROM clarification WHERE specimen_part_id IN (${pIds.map(() => "?").join(",")}) OR order_part_id IN (${opIds.map(() => "?").join(",")})`,
      )
      .all(...pIds, ...opIds) as { id: string; specimen_part_id: string | null; order_part_id: string | null }[];
    for (const cp of clarParts) {
      const d = (cp.specimen_part_id && partOfEntity.get(cp.specimen_part_id)) || (cp.order_part_id && partOfEntity.get(cp.order_part_id));
      if (d) partOfEntity.set(cp.id, d);
    }
    const holdParts = db.prepare("SELECT id, scope_id FROM hold WHERE accession_id = ? OR scope_id IN (" + [...pIds, ...opIds].map(() => "?").join(",") + ")").all(accId, ...pIds, ...opIds) as { id: string; scope_id: string }[];
    for (const hp of holdParts) {
      const d = partOfEntity.get(hp.scope_id);
      if (d) partOfEntity.set(hp.id, d);
    }
  }

  const taskRows = db
    .prepare(
      `SELECT * FROM task WHERE accession_id = ? ${intakeIdList.length ? `OR intake_item_id IN (${intakeIdList.map(() => "?").join(",")})` : ""}
        ORDER BY CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END, created_at`,
    )
    .all(accId, ...intakeIdList) as {
    id: string; kind: string; title: string; status: string; owner_id: string | null; owner_role: string | null; priority: string; due_at: string | null;
    created_at: string; completed_at: string | null; completed_by: string | null; version: number; entity_type: string; entity_id: string; detail: string | null;
  }[];
  // What closed a task: the record logged on its entity at the moment it closed (tasks are closed by that action).
  const closingEvent = db.prepare("SELECT action FROM audit_event WHERE entity_id = ? AND at = ? ORDER BY seq DESC LIMIT 1");
  const tasks: CaseTask[] = taskRows.map((t) => {
    const open = t.status === "open" || t.status === "in_progress";
    const closedBy = !open && t.completed_at ? (closingEvent.get(t.entity_id, t.completed_at) as { action: string } | undefined)?.action ?? null : null;
    const simulatedCloser = !!t.completed_by && /^sim_/.test(t.completed_by);
    return {
      id: t.id, kind: t.kind, title: taskTitle(t.title, open), status: t.status, ownerId: t.owner_id, ownerName: nameOf(t.owner_id), ownerRole: t.owner_role,
      priority: t.priority, dueAt: t.due_at, createdAt: t.created_at, completedAt: t.completed_at,
      // A simulator closing a lab task is shown as the event that closed it, never as "done by Simulated office".
      completedBy: simulatedCloser ? null : nameOf(t.completed_by),
      closedNote: open ? null : (closedBy && CLOSED_BY[closedBy]) ?? (simulatedCloser ? "closed by a simulated event" : null),
      version: t.version,
      partDesignation: partOfEntity.get(t.entity_id) || null,
      href: taskHref(db, t.kind, t.entity_type, t.entity_id),
    };
  });
  const openTasks = tasks.filter((t) => t.status === "open" || t.status === "in_progress");

  // ---- parts
  const orderTenant = new Map(
    (db.prepare(`SELECT so.id, t.name FROM source_order so JOIN source_tenant t ON t.id = so.tenant_id WHERE so.id IN (${orderIds.map(() => "?").join(",") || "''"})`).all(...orderIds) as { id: string; name: string }[]).map((r) => [r.id, r.name]),
  );
  const parts: CasePart[] = readiness.parts.map((p) => {
    const row = partRows.find((r) => r.id === p.partId)!;
    const wp = worklistRow?.parts.find((x) => x.partId === p.partId);
    const physical = physicalSteps(p);
    const documentation = documentationSteps(p);
    const partTasks = openTasks.filter((t) => t.partDesignation === p.designation);
    const owner = partTasks[0] ?? null;
    const explanation: string[] = [];
    for (const e of p.eligible) {
      if (/eligible for the next processing run/.test(e)) explanation.push(`${e}: gross record approved for downstream use and cassette loaded; no hold blocks processing.`);
      else if (/ready for grossing/.test(e)) explanation.push(`${e}: case issued, no hold blocks grossing documentation.`);
      else if (/source system/.test(e)) explanation.push(`${e}. This is a manual entry in the source system; approval here does not write to it.`);
      else explanation.push(e);
    }
    for (const b of p.blockedBy) explanation.push(`Blocked: ${b.replace(/_/g, " ")}`);
    if (!explanation.length) explanation.push("No eligible next step right now.");
    const physicalSummary = physical.filter((s) => s.state === "done").map((s) => s.label).pop() ?? "Not started";
    return {
      partId: p.partId, designation: p.designation, originalDesignation: row.original_designation, site: p.site,
      laterality: p.laterality ? LATERALITY[p.laterality as keyof typeof LATERALITY] ?? p.laterality : null,
      procedure: p.procedure ? PROCEDURE[p.procedure as keyof typeof PROCEDURE] ?? p.procedure : null,
      sourceOrderRef: p.sourceOrderRef, sourceOrderTenant: orderTenant.get(p.sourceOrderId) ?? "Unknown tenant", status: p.status,
      stageLabel: STAGE_SHORT[p.stage],
      physical: { steps: physical, summary: `Last physical step reached: ${physicalSummary}` },
      documentation: {
        steps: documentation, grossState: p.grossState, grossRecordVersion: p.grossRecordVersion, sourceUpdateState: p.sourceUpdateState,
        summary: p.grossState === "not_started" ? "No gross record yet" : `${GROSS_STATE[p.grossState as keyof typeof GROSS_STATE] ?? p.grossState}; ${SOURCE_UPDATE_STATE[p.sourceUpdateState as keyof typeof SOURCE_UPDATE_STATE] ?? p.sourceUpdateState}`,
      },
      holds: wp?.holds ?? p.holds.map((h) => ({ ...h, blocks: h.blocks as string[] })), eligible: p.eligible, blockedBy: p.blockedBy, explanation,
      stains: wp?.stains ?? [], owner,
    };
  });

  // ---- material tree
  const printJobs = db
    .prepare("SELECT target_type, target_id, display_id, state, created_at FROM print_job WHERE accession_id = ? ORDER BY created_at, display_id")
    .all(accId) as { target_type: string; target_id: string; display_id: string; state: string; created_at: string }[];
  const latestJob = new Map<string, { displayId: string; state: string; stateLabel: string }>();
  for (const j of printJobs) latestJob.set(`${j.target_type}:${j.target_id}`, { displayId: j.display_id, state: j.state, stateLabel: PRINT_STATE[j.state as keyof typeof PRINT_STATE] ?? j.state });
  const blockFull = db
    .prepare(
      `SELECT b.*, l.code AS loc_code, l.label AS loc_label FROM block b LEFT JOIN storage_location l ON l.id = b.current_location_id
        WHERE b.accession_id = ? ORDER BY b.label_text`,
    )
    .all(accId) as {
    id: string; part_id: string; label_text: string; identifier: string; physical_state: string; pieces_submitted: number | null; custody_state: string;
    loc_code: string | null; loc_label: string | null; location_confirmed_at: string | null; location_confirmed_by: string | null; status: string;
  }[];
  const blockLabels = new Map(
    (db.prepare("SELECT target_id, state FROM label WHERE target_type = 'block' AND state IN ('printed','applied','verified')").all() as { target_id: string; state: string }[]).map((r) => [r.target_id, r.state]),
  );
  const slideFull = db
    .prepare(
      `SELECT s.*, b.label_text AS block_label, wo.display_id AS wo_display FROM slide s JOIN block b ON b.id = s.block_id LEFT JOIN work_order wo ON wo.id = s.work_order_id
        WHERE s.accession_id = ? ORDER BY b.label_text, s.slide_seq`,
    )
    .all(accId) as {
    id: string; block_id: string; block_label: string; slide_seq: number; stain: string; level_label: string | null; physical_state: string; label_state: string;
    status: string; wo_display: string | null; identifier: string;
  }[];
  const material: MaterialPart[] = readiness.parts.map((p) => {
    const expectedUnknownReason =
      p.blocksExpected !== null ? null
      : p.grossState === "not_started" ? "no gross record yet"
      : "the gross record does not state a cassette count yet";
    const blocks: MaterialBlock[] = blockFull
      .filter((b) => b.part_id === p.partId && b.status === "active")
      .map((b) => ({
        id: b.id, label: b.label_text, identifier: b.identifier, state: b.physical_state, stateLabel: BLOCK_STATE[b.physical_state as BlockState] ?? b.physical_state,
        piecesSubmitted: b.pieces_submitted, custody: CUSTODY_STATE[b.custody_state as keyof typeof CUSTODY_STATE] ?? b.custody_state,
        location: b.loc_code ? { code: b.loc_code, label: b.loc_label ?? b.loc_code, confirmedAt: b.location_confirmed_at, confirmedBy: nameOf(b.location_confirmed_by) } : null,
        labelState: blockLabels.get(b.id) ?? null,
        printJob: latestJob.get(`block:${b.id}`) ?? null,
        slides: slideFull
          .filter((s) => s.block_id === b.id)
          .map((s) => ({
            id: s.id, label: `${s.block_label}-${s.slide_seq}`, identifier: s.identifier, stain: s.stain, level: s.level_label, state: s.physical_state,
            stateLabel: SLIDE_STATE[s.physical_state as SlideState] ?? s.physical_state, labelState: s.label_state,
            labelStateLabel: LABEL_STATE[s.label_state as keyof typeof LABEL_STATE] ?? s.label_state, status: s.status, workOrder: s.wo_display,
            printJob: latestJob.get(`slide:${s.id}`) ?? null,
          })),
      }));
    const activeSlides = blocks.flatMap((b) => b.slides).filter((s) => s.status === "active");
    const blockExpected = p.blocksExpected;
    // Counts of things that exist are known (0 when none exist); an expectation is Unknown until something sets it.
    const blockVerified = blocks.filter((b) => b.labelState === "verified").length;
    const slideExpected = activeSlides.length ? activeSlides.length : null; // planned slides are the expectation; none planned = Unknown
    const slidePrepared = activeSlides.filter((s) => slideIdx(s.state) >= slideIdx("sectioned")).length;
    const slideVerified = activeSlides.filter((s) => s.labelState === "verified").length;
    return {
      partId: p.partId, designation: p.designation, blocks, expectedUnknownReason,
      blockCounts: quantity(blockExpected, blocks.length, blockVerified, "Blocks"),
      slideCounts: quantity(slideExpected, slidePrepared, slideVerified, "Slides"),
    };
  });

  // ---- source documents (every version, original values kept)
  const sourceDocuments: SourceOrderDoc[] = orderIds.map((oid) => {
    const so = db
      .prepare(
        `SELECT so.*, t.name AS tenant_name, o.name AS office_name, c.display_name AS clinician_name FROM source_order so
           JOIN source_tenant t ON t.id = so.tenant_id JOIN office o ON o.id = so.office_id LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
          WHERE so.id = ?`,
      )
      .get(oid) as {
      id: string; source_order_id: string; tenant_id: string; tenant_name: string; source_status: string; source_version: number; source_updated_at: string;
      imported_at: string; review_state: string; office_name: string; clinician_name: string | null; clinical_note: string | null;
    };
    const versions = (db.prepare("SELECT * FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC").all(oid) as {
      source_version: number; source_updated_at: string; imported_at: string; change_summary: string | null; payload: string;
    }[]).map((v) => {
      const payload = parseJson<{ clinical_note?: string | null; specimens?: { designation?: string; site?: string; laterality?: string | null; procedure?: string | null; requested_stains?: string[] }[] }>(v.payload, {});
      return {
        version: v.source_version, sourceUpdatedAt: v.source_updated_at, importedAt: v.imported_at, changeSummary: v.change_summary,
        specimens: (payload.specimens ?? []).map((s) => ({ designation: s.designation ?? "?", site: s.site ?? null, laterality: s.laterality ?? null, procedure: s.procedure ?? null, requestedStains: s.requested_stains ?? [] })),
        clinicalNote: payload.clinical_note ?? null,
        raw: v.payload,
      };
    });
    // Original values come from the FIRST version received (versions are append-only). source_order_part
    // holds the source's CURRENT values (the import mirrors each newer version onto it).
    const first = versions.length ? versions[versions.length - 1] : null;
    const orderParts = (db.prepare("SELECT * FROM source_order_part WHERE source_order_id = ? ORDER BY designation").all(oid) as {
      id: string; designation: string; site_text: string; laterality: string | null; procedure: string | null; collected_at: string | null;
      expected_containers: number | null; requested_stains: string; status: string;
    }[]).map((op) => {
      const o = first?.specimens.find((x) => x.designation === op.designation) ?? null;
      const current = {
        site: op.site_text, laterality: op.laterality, procedure: op.procedure,
        requestedStains: parseJson<{ stain?: string }[]>(op.requested_stains, []).map((r) => r.stain ?? "").filter(Boolean),
      };
      const original = o ? { site: o.site, laterality: o.laterality, procedure: o.procedure, requestedStains: o.requestedStains } : null;
      const casePart = partRows.find((p) => p.source_order_part_id === op.id);
      return {
        designation: op.designation, original, current,
        changedSinceOriginal: !!original && (original.site !== current.site || original.laterality !== current.laterality || original.procedure !== current.procedure),
        onCase: casePart ? { site: casePart.site_text, laterality: casePart.laterality } : null,
        collectedAt: op.collected_at, expectedContainers: op.expected_containers, status: op.status,
      };
    });
    const events = (db
      .prepare(
        `SELECT message_id, message_type, outcome, received_at, receipt_count, detail FROM integration_event
          WHERE entity_key = ? ORDER BY received_at`,
      )
      .all(`${so.tenant_id}:${so.source_order_id}`) as { message_id: string; message_type: string; outcome: string; received_at: string; receipt_count: number; detail: string | null }[]).map((e) => ({
      messageId: e.message_id, type: e.message_type, outcome: e.outcome, receivedAt: e.received_at, receiptCount: e.receipt_count, detail: e.detail,
    }));
    return {
      id: so.id, sourceOrderId: so.source_order_id, tenantName: so.tenant_name, status: so.source_status, currentVersion: so.source_version,
      sourceUpdatedAt: so.source_updated_at, importedAt: so.imported_at, reviewState: so.review_state,
      reviewText: reviewText(so.review_state, so.source_order_id, versions.length, taskRows, nameOf, now),
      office: so.office_name, orderingClinician: so.clinician_name,
      clinicalNote: so.clinical_note, partDesignations: partRows.filter((p) => p.source_order_id === oid).map((p) => p.designation),
      originalVersion: first?.version ?? null, orderParts, versions, events,
    };
  });

  // ---- related-order review records (never a merge)
  const related: RelatedRecord[] = orderIds.length
    ? (db
        .prepare(
          `SELECT r.*, oa.source_order_id AS a_ref, ob.source_order_id AS b_ref FROM related_order_candidate r
             JOIN source_order oa ON oa.id = r.order_a_id JOIN source_order ob ON ob.id = r.order_b_id
            WHERE r.order_a_id IN (${orderIds.map(() => "?").join(",")}) OR r.order_b_id IN (${orderIds.map(() => "?").join(",")})`,
        )
        .all(...orderIds, ...orderIds) as {
        id: string; display_id: string; status: string; reasons: string; conflicts: string; reviewed_by: string | null; reviewed_at: string | null; decision_reason: string | null; a_ref: string; b_ref: string;
      }[]).map((r) => {
        const by = nameOf(r.reviewed_by);
        const statusLabel = RELATED_STATUS[r.status as keyof typeof RELATED_STATUS] ?? r.status;
        const statement =
          r.status === "pending_review" ? `Possible related orders ${r.a_ref} and ${r.b_ref}. Needs review. Linking never merges records.`
          : r.status === "single_accession_approved" ? `Linked as related by ${by ?? "Unknown"}${r.reviewed_at ? `, ${fmtSmart(r.reviewed_at, now)} ET` : ""}. Not merged: ${r.a_ref} and ${r.b_ref} both stay attached to their parts.`
          : `${statusLabel}${by ? ` (decided by ${by}${r.reviewed_at ? `, ${fmtSmart(r.reviewed_at, now)} ET` : ""})` : ""}. Not merged.`;
        return {
          id: r.id, displayId: r.display_id, status: r.status, statusLabel, orders: [r.a_ref, r.b_ref],
          reasons: parseJson<{ label: string; detail?: string }[]>(r.reasons, []), conflicts: parseJson<{ label: string; detail?: string }[]>(r.conflicts, []),
          reviewedBy: by, reviewedAt: r.reviewed_at, decisionReason: r.decision_reason, statement,
        };
      })
    : [];

  // ---- correction / cross-reference reviews (no renumbering)
  const corrections: CorrectionRecord[] = (db
    .prepare(
      `SELECT cr.*, ra.accession_number AS related_number FROM correction_review cr LEFT JOIN accession ra ON ra.id = cr.related_accession_id
        WHERE cr.accession_id = ? OR cr.related_accession_id = ? ORDER BY cr.requested_at`,
    )
    .all(accId, accId) as {
    id: string; display_id: string; kind: string; status: string; description: string; related_number: string | null; original_refs: string; requested_by: string;
    requested_at: string; outcome_note: string | null;
  }[]).map((c) => ({
    id: c.id, displayId: c.display_id, kind: c.kind.replace(/_/g, " "), status: c.status.replace(/_/g, " "), description: c.description, relatedAccession: c.related_number,
    originalRefs: c.original_refs, requestedBy: nameOf(c.requested_by) ?? c.requested_by, requestedAt: c.requested_at, outcomeNote: c.outcome_note,
    statement: `Cross-reference record, not a renumbering. ${a.accession_number} keeps its number and parts; the authorized correction happens in the source system.`,
  }));

  // ---- clarifications
  const partIds = partRows.map((p) => p.id);
  const orderPartIds = partRows.map((p) => p.source_order_part_id);
  const clarWhere = ["accession_id = ?"];
  const clarParams: unknown[] = [accId];
  if (intakeIdList.length) {
    clarWhere.push(`intake_item_id IN (${intakeIdList.map(() => "?").join(",")})`);
    clarParams.push(...intakeIdList);
  }
  if (partIds.length) {
    clarWhere.push(`specimen_part_id IN (${partIds.map(() => "?").join(",")})`);
    clarParams.push(...partIds);
    clarWhere.push(`order_part_id IN (${orderPartIds.map(() => "?").join(",")})`);
    clarParams.push(...orderPartIds);
  }
  const clarifications: CaseClarification[] = (db.prepare(`SELECT * FROM clarification WHERE ${clarWhere.join(" OR ")} ORDER BY created_at`).all(...clarParams) as {
    id: string; display_id: string; category: string; state: string; subject_label: string; question: string; lab_owner_id: string | null; priority: string;
    next_follow_up_at: string | null; created_at: string; resolved_at: string | null;
  }[]).map((c) => ({
    id: c.id, displayId: c.display_id, category: CLARIFICATION_CATEGORY[c.category as keyof typeof CLARIFICATION_CATEGORY] ?? c.category, state: c.state,
    stateLabel: CLARIFICATION_STATE[c.state as keyof typeof CLARIFICATION_STATE] ?? c.state, subject: c.subject_label, question: c.question,
    labOwner: nameOf(c.lab_owner_id), priority: c.priority, nextFollowUpAt: c.next_follow_up_at, createdAt: c.created_at, resolvedAt: c.resolved_at,
    open: !["resolved", "canceled"].includes(c.state), href: `/clarifications?selected=${encodeURIComponent(c.display_id)}`,
  }));

  // ---- holds (active and released, with scope)
  const holdScopeIds = [accId, ...partIds, ...orderPartIds, ...partRows.map((p) => p.container_id).filter(Boolean) as string[], ...blockRows.map((b) => b.id), ...slideRows.map((s) => s.id), ...woRows.map((w) => w.id), ...intakeIdList];
  const holdsAll = (db
    .prepare(
      `SELECT * FROM hold WHERE accession_id = ? OR scope_id IN (${holdScopeIds.map(() => "?").join(",")}) ORDER BY placed_at`,
    )
    .all(accId, ...holdScopeIds) as {
    id: string; display_id: string; scope_label: string; reason_text: string; blocks: string; clarification_id: string | null; placed_at: string; status: string;
    released_at: string | null; released_by: string | null; release_reason: string | null;
  }[]).map((h) => ({
    id: h.id, displayId: h.display_id, scopeLabel: h.scope_label, reasonText: h.reason_text, blocks: parseJson<string[]>(h.blocks, ["all"]), clarificationId: h.clarification_id,
    placedAt: h.placed_at, status: h.status, releasedAt: h.released_at, releasedBy: nameOf(h.released_by), releaseReason: h.release_reason,
  }));

  // ---- history (local audit log)
  const entityIds = [...partOfEntity.keys(), ...woRows.map((w) => w.id), ...holdsAll.map((h) => h.id), ...clarifications.map((c) => c.id), ...tasks.map((t) => t.id), ...related.map((r) => r.id), ...corrections.map((c) => c.id)];
  const histWhere = ["accession_id = ?"];
  const histParams: unknown[] = [accId];
  if (intakeIdList.length) {
    histWhere.push(`intake_item_id IN (${intakeIdList.map(() => "?").join(",")})`);
    histParams.push(...intakeIdList);
  }
  if (entityIds.length) {
    histWhere.push(`entity_id IN (${entityIds.map(() => "?").join(",")})`);
    histParams.push(...entityIds);
  }
  const auditRows = db
    .prepare(`SELECT * FROM audit_event WHERE ${histWhere.join(" OR ")} ORDER BY at DESC, seq DESC LIMIT 500`)
    .all(...histParams) as {
    id: string; seq: number; at: string; actor_id: string | null; actor_role: string | null; origin: string; action: string; entity_type: string; entity_id: string;
    summary: string; reason: string | null; before_json: string | null; after_json: string | null;
  }[];
  const designations = new Set(partRows.map((p) => p.designation));
  // Some commands write one identical audit row per intake item (same time, action, record and text).
  // The case history shows that action once.
  const seenAudit = new Set<string>();
  const uniqueAuditRows = auditRows.filter((e) => {
    const k = `${e.at}|${e.action}|${e.entity_id}|${e.actor_id ?? ""}|${e.summary}`;
    if (seenAudit.has(k)) return false;
    seenAudit.add(k);
    return true;
  });
  const history: HistoryEvent[] = uniqueAuditRows.map((e) => {
    // Part membership comes from the event's entity (part, block, slide, gross record, work order,
    // clarification or hold on that part). Summary text is only a fallback for events with no part
    // entity, because a summary about part A can mention part B ("part B still awaiting grossing").
    const ps = new Set<string>();
    const direct = partOfEntity.get(e.entity_id);
    if (direct) ps.add(direct);
    else for (const m of e.summary.matchAll(/\b[Pp]art ([A-Z])\b/g)) if (designations.has(m[1])) ps.add(m[1]);
    const role = e.actor_role as Role | null;
    const staffActor = !!e.actor_id && staff.has(e.actor_id);
    return {
      id: e.id, seq: e.seq, at: e.at,
      actorName: staffActor
        ? nameOf(e.actor_id)!
        : e.actor_id && SIM_ACTOR_NAME[e.actor_id] && e.actor_id !== "system"
          ? SIM_ACTOR_NAME[e.actor_id]
          : e.origin === "simulator" || e.origin === "import"
            ? "Simulated source system"
            : e.actor_id && e.actor_id !== "system"
              ? "Unknown actor"
              : "System",
      actorRole: staffActor && role && ROLE_LABEL[role] ? ROLE_LABEL[role] : null,
      origin: e.origin, originLabel: originLabel(e.origin, e.action, e.id), action: e.action, entityType: e.entity_type, entityId: e.entity_id, summary: readableSummary(e.summary),
      reason: e.reason, before: e.before_json, after: e.after_json, parts: [...ps].sort(),
    };
  });
  const historyFilters = {
    parts: [...designations].sort(),
    actors: [...new Set(history.map((h) => h.actorName))].sort(),
    origins: [...new Set(history.map((h) => h.originLabel))].sort(),
  };

  // ---- people by role (four different roles, never inferred from each other)
  const routing = a.routing_decision_id
    ? (db.prepare("SELECT status, explanation, override_reason FROM routing_decision WHERE id = ?").get(a.routing_decision_id) as { status: string; explanation: string; override_reason: string | null } | undefined)
    : undefined;
  const accessioners = [...new Set(intakeIds.map((i) => nameOf(i.received_by)).filter(Boolean) as string[])];
  const currentOwners = openTasks.map((t) => ({ part: t.partDesignation, name: t.ownerName ?? `Unassigned${t.ownerRole ? ` (${t.ownerRole.replace(/_/g, " ")})` : ""}`, task: t.title }));

  // ---- case-level summary (never "complete" while any part is incomplete or extra work is open)
  const activeParts = parts.filter((p) => p.status !== "canceled");
  const delivered = readiness.parts.filter((p) => p.stage === "delivered").length;
  const isComplete = caseIsComplete(readiness);
  const openWork = parts.flatMap((p) => p.stains).filter((s) => s.workOrder && ["requested", "in_progress", "cancel_review", "amended_review"].includes(s.status));
  const summaryText = isComplete
    ? `${activeParts.length === 1 ? "The only part is" : `All ${activeParts.length} parts`} delivered; no additional work open.`
    : readiness.isComplete
      ? `Not complete: ${activeParts.length === 1 ? "the only part is" : `all ${activeParts.length} parts`} delivered, but additional work is open: ${openWork.map((w) => `${w.workOrder} (${WORK_ORDER_STATUS[w.status as keyof typeof WORK_ORDER_STATUS] ?? w.status})`).join(", ")}.`
      // The parts line and readiness under it say each part's stage; the headline gives the count once.
      : `Not complete: ${delivered} of ${plural(activeParts.length, "part")} delivered${readiness.parts.some((p) => p.holds.length) ? `, ${plural(readiness.parts.filter((p) => p.holds.length).length, "part")} on hold` : ""}.`;

  const detail: CaseDetail = {
    generatedAt: now,
    identity: {
      accessionId: a.id, accessionNumber: a.accession_number, namespace: a.namespace, sourceCaseId: a.source_case_id, issuedAt: a.issued_at,
      issuedBySystem: a.issued_by_system, patientLabel: `${a.family_name}, ${a.given_name}`, birthDate: a.birth_date, mrn: a.source_mrn,
      tenantName: a.tenant_name, officeName: a.office_name, priority: a.priority, caseStatus: a.case_status, receivedDay: a.received_day, version: a.version,
      intakeIds: intakeIds.map((i) => ({ id: i.id, displayId: i.display_id })),
    },
    people: {
      orderingClinician: a.clinician_name ? `${a.clinician_name}${a.clinician_credential && !a.clinician_name.startsWith("Dr.") ? `, ${a.clinician_credential}` : ""}${a.clinician_office ? ` (${a.clinician_office})` : ""}` : null,
      assignedPathologist: a.assigned_pathologist_id ? { id: a.assigned_pathologist_id, name: a.path_name ?? a.assigned_pathologist_id, colorToken: a.color_token } : null,
      routing: routing ? { status: ROUTING_STATUS[routing.status as keyof typeof ROUTING_STATUS] ?? routing.status, explanation: routing.explanation, overrideReason: routing.override_reason } : null,
      accessioners,
      currentOwners,
    },
    summary: {
      isComplete, text: summaryText, stageLabel: readiness.stageLabel, partsSummary: worklistRow?.partsSummary ?? readiness.partsSummary,
      holdCount: readiness.holdCount, readinessText: worklistRow?.readinessText ?? readiness.readinessText,
    },
    parts, material, sourceDocuments, related, corrections, tasks, clarifications, holdsAll, history, historyFilters,
    operationalSummary: { label: "Computed summary (deterministic demo) — not AI", items: [] },
    freshness: loadSourceFreshness(db, now),
    worklistRow,
  };
  detail.operationalSummary.items = buildOperationalSummary(detail, new Map(grossIds.map((g) => [g.id, g.designation])), now);
  return detail;
}

// ---------------------------------------------------------------- deterministic operational summary


function buildOperationalSummary(c: CaseDetail, grossRecordPart: Map<string, string>, now: string): SummaryItem[] {
  const items: SummaryItem[] = [];
  const ev = (h: HistoryEvent) => ({ label: `${actionLabel(h.action)}, ${fmtSmart(h.at, now)} ET`, href: `?tab=history#ev-${h.id}` });
  const findEvent = (pred: (h: HistoryEvent) => boolean) => c.history.find(pred);

  const issued = findEvent((h) => /accession\.(issued|request)/.test(h.action));
  const orders = c.sourceDocuments.map((d) => d.sourceOrderId);
  items.push({
    text: `Accession ${c.identity.accessionNumber} issued ${fmtSmart(c.identity.issuedAt, now)} ET by ${c.identity.issuedBySystem.replace(/^Authoritative source simulator \((.+)\)$/, "$1")} (simulated source) from ${orders.length} source ${orders.length === 1 ? "order" : "orders"}: ${orders.join(", ")}. ${c.parts.length} ${c.parts.length === 1 ? "part" : "parts"}: ${c.parts.map((p) => `${p.designation} (${p.sourceOrderRef})`).join(", ")}.`,
    evidence: [...(issued ? [ev(issued)] : []), { label: "Source documents", href: "?tab=source" }],
  });

  for (const r of c.related) {
    const e = findEvent((h) => h.entityId === r.id);
    items.push({ text: `${r.displayId}: ${r.statement}`, evidence: [...(e ? [ev(e)] : []), { label: r.displayId, href: "?tab=source#related" }] });
  }

  for (const h of c.holdsAll) {
    const placed = findEvent((x) => x.entityId === h.id && /placed/.test(x.action));
    const released = findEvent((x) => x.entityId === h.id && /released/.test(x.action));
    const clar = h.clarificationId ? c.clarifications.find((x) => x.id === h.clarificationId) : undefined;
    const text =
      h.status === "active"
        ? `${h.displayId} holds ${h.scopeLabel} since ${fmtSmart(h.placedAt, now)} ET (${fmtAge(h.placedAt, now)}): ${h.reasonText}. Blocks ${h.blocks.join(", ").replace(/_/g, " ")}.${clar ? ` Linked clarification ${clar.displayId} is ${lowerWords(clar.stateLabel)}.` : ""} Released only by an authorized person with a reason.`
        : `${h.displayId} on ${h.scopeLabel} was released ${h.releasedAt ? `${fmtSmart(h.releasedAt, now)} ET` : "at an unknown time"}${h.releasedBy ? ` by ${h.releasedBy}` : ""}${h.releaseReason ? `, reason: "${h.releaseReason}"` : ""}. It was placed for: ${h.reasonText}.`;
    items.push({
      text,
      evidence: [
        ...(placed ? [ev(placed)] : []),
        ...(released ? [ev(released)] : []),
        ...(clar ? [{ label: clar.displayId, href: clar.href }] : []),
        ...(!placed && !released && !clar ? [{ label: "Overview: holds", href: "?tab=overview#holds" }] : []),
      ],
    });
  }

  for (const cl of c.clarifications.filter((x) => !c.holdsAll.some((h) => h.clarificationId === x.id))) {
    items.push({ text: `${cl.displayId} (${cl.category}): ${cl.stateLabel}.`, evidence: [{ label: cl.displayId, href: cl.href }] });
  }

  for (const p of c.parts) {
    // Evidence must be an approval of THIS part's gross record (by entity), never an event that merely mentions the part.
    const approved = findEvent(
      (h) =>
        /^gross\.approved?$/.test(h.action) &&
        ((h.entityType === "gross_record" && grossRecordPart.get(h.entityId) === p.designation) ||
          // Seeded history records one case-level approval listing its parts: "approved for downstream use (A, B)".
          (h.entityType === "accession" && (/\(([A-Z](?:, [A-Z])*)\)\s*$/.exec(h.summary)?.[1].split(", ") ?? []).includes(p.designation))),
    );
    const doc = p.documentation;
    const physicalDone = p.physical.steps.filter((s) => s.state === "done").map((s) => s.label);
    const text =
      doc.grossState === "not_started"
        ? `Part ${p.designation}: ${lowerWords(p.stageLabel)}; no gross record yet.${p.holds.length ? ` On hold (${p.holds.map((h) => h.displayId).join(", ")}).` : ""}`
        : `Part ${p.designation}: physical ${physicalDone.length ? lowerWords(physicalDone[physicalDone.length - 1]) : "not started"}; documentation ${lowerWords(doc.summary)}.${p.eligible.length ? ` Eligible: ${p.eligible.join("; ")}.` : ""}`;
    items.push({
      text,
      evidence: [...(approved ? [ev(approved)] : []), { label: `Part ${p.designation} tracks`, href: `?tab=overview#part-${p.designation}` }],
    });
  }

  for (const s of c.parts.flatMap((p) => p.stains).filter((s) => s.needsReview || s.canceled)) {
    items.push({ text: `${s.text}: ${WORK_ORDER_STATUS[s.status as keyof typeof WORK_ORDER_STATUS] ?? s.status}. Prepared or printed material stays visible until reviewed.`, evidence: [{ label: s.workOrder ?? "Work order", href: "?tab=material" }] });
  }

  for (const x of c.corrections) items.push({ text: `${x.displayId} (${x.kind}): ${x.status}. ${x.statement}`, evidence: [{ label: x.displayId, href: "?tab=source#corrections" }] });

  const open = c.tasks.filter((t) => t.status === "open" || t.status === "in_progress");
  if (open.length) {
    items.push({
      text: `Next steps (${open.length} open ${open.length === 1 ? "task" : "tasks"}): ${open.map((t) => `${t.ownerName ?? `Unassigned${t.ownerRole ? ` (${t.ownerRole.replace(/_/g, " ")})` : ""}`}: ${t.title}`).join("; ")}.`,
      evidence: [{ label: "Tasks and clarifications", href: "?tab=tasks" }],
    });
  } else {
    items.push({ text: "No open tasks on this case.", evidence: [{ label: "Tasks and clarifications", href: "?tab=tasks" }] });
  }
  items.push({
    text: c.summary.isComplete ? "All parts delivered; no additional work open." : `Case not complete: ${c.summary.text.replace(/^Not complete: /, "")}`,
    evidence: [{ label: "Overview", href: "?tab=overview" }],
  });
  return items;
}
