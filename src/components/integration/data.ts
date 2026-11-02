/**
 * Read model for the /integration screen (server only). It writes nothing.
 *
 * It builds on, and never replaces, the reconciliation read model (src/server/integration/reconciliation.ts):
 * every comparison row comes from loadReconciliation. This file only
 *   - groups the rows by what the operator must do (needs review, waiting on the source, failed and retryable,
 *     informational);
 *   - turns the work each row touches into links (Intake, Case, Clarify) and names who owns the review;
 *   - adds the per-source status (sourceFreshness, the same helper Settings and Operations use);
 *   - adds open review tasks the importer opened that no comparison row already covers (so nothing a person must
 *     do is missing), and the most recent messages (one line per message id, however often it was delivered);
 *   - attaches the stored message, verbatim, for the "as received" disclosure (shown as data, never interpreted).
 *
 * Callers must hold view.integration (clinical data: patient details, accession numbers).
 */
import type { DB } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { loadReconciliation, type ReconKind, type ReconRow, type ReconStatus } from "@/server/integration/reconciliation";
import { CONTRACT_VERSION, type ContractError } from "@/server/integration/contract";
import { failureErrors } from "@/server/integration/inbound";
import { sourceFreshness, seedClockStart, type FreshnessState } from "@/server/queries/settings";
import { ROLE_LABEL, rolesFor, type Role } from "@/lib/roles";
import { LATERALITY } from "@/lib/domain";

export type ActionGroup = "review" | "waiting" | "failed" | "info";

export const GROUP_ORDER: ActionGroup[] = ["review", "waiting", "failed", "info"];

export const GROUP_TITLE: Record<ActionGroup, string> = {
  review: "Needs review",
  waiting: "Waiting on the source",
  failed: "Failed and retryable",
  info: "Informational",
};

/** One link to the work a row touches. */
export interface WorkLink {
  /** Where it opens. */
  screen: "Intake" | "Case" | "Clarify" | "Hold" | "Order";
  /** The identifier as the bench shows it (INT-1014-029, D26-04817 part A, CLR-0453, H-0091). */
  label: string;
  href: string | null;
  /** Plain status words, when known. */
  status?: string;
}

export interface ScreenRow {
  key: string;
  /** A reconciliation kind; "order_change" is an open import review no comparison covers; "source_status" is a source that is unavailable or slow. */
  kind: ReconKind | "order_change" | "source_status";
  group: ActionGroup;
  status: ReconStatus;
  /** Patient identity (name, date of birth or MRN) disagrees: the red rung of the severity ladder. */
  identity: boolean;
  /** "Patient details", "Specimen parts", … */
  what: string;
  /** What the row is about (an order and version, a part, a message id). */
  subject: string;
  sourceId: string | null;
  sourceName: string | null;
  externalAssertion: string;
  localState: string;
  difference: string | null;
  sourceEventTime: string | null;
  localReceivedTime: string | null;
  messageId: string | null;
  work: WorkLink[];
  review: {
    required: boolean;
    /** Who decides: "Kim Nguyen (Accessioning lead)", or role words when nobody is named. */
    owner: string;
    /** What the person does, in one sentence. */
    action: string;
    /** The review record, when there is one (a task title, a correction review, a clarification). */
    record: string | null;
  };
  /** The stored message, verbatim (pretty-printed when it is JSON). Null when the row has no single message. */
  raw: string | null;
  /** Failed rows: the stored event that a supervisor may retry (processing failures only: invalid data would fail again). */
  retryEventId: string | null;
  /** Failed rows: why. Invalid data names each field (the inbound endpoint's own checks); a processing failure is retryable. */
  failure: { kind: "invalid_data" | "processing"; errors: ContractError[] } | null;
}

export interface SourceView {
  id: string;
  /** Without the "(simulated …)" suffix: "EMA-SIM Sunrise Coast". */
  name: string;
  status: string;
  /** Connected | Unavailable | Slow link. */
  statusWord: string;
  freshness: FreshnessState;
  lastContactAt: string | null;
  lastSuccessAt: string | null;
  offlineSince: string | null;
  /** The last connection error in plain words; null when none is recorded. */
  lastError: string | null;
  /** Messages the simulated source holds, due and not delivered (the backlog an outage builds). */
  waiting: number;
  /** Rows per action group that came from this source. */
  counts: Record<ActionGroup, number>;
  /** Whether this source also issues accession numbers (the simulated issuer). */
  issuesAccessions: boolean;
}

export interface MessageView {
  eventId: string;
  sourceName: string;
  messageId: string;
  /** "New order", "Amended order", … */
  what: string;
  subject: string;
  outcome: string;
  outcomeWords: string;
  detail: string | null;
  sourceEventTime: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
  deliveries: number;
  /** Received before this demo session started (written by the seed). */
  seeded: boolean;
  raw: string;
}

export interface IntegrationScreen {
  now: string;
  sources: SourceView[];
  rows: ScreenRow[];
  counts: Record<ActionGroup, number>;
  messages: { shown: MessageView[]; total: number };
  /** Orders compared with the local record, and how many agree (from the reconciliation summary). */
  compared: { orders: number; inSync: number };
  includeInSync: boolean;
}

const KIND_WHAT: Record<ScreenRow["kind"], string> = {
  patient: "Patient details",
  parts: "Specimen parts",
  site_laterality: "Site, laterality and procedure",
  cancellation: "Canceled at source",
  accession: "Accession number",
  failed_import: "Message not applied",
  stale_ignored: "Older version received late",
  source_conflict: "Source conflict",
  correction_review: "Correction review",
  order_change: "Order changed at source",
  source_status: "Source unavailable",
};

const MESSAGE_WHAT: Record<string, string> = {
  "order.upsert": "Order",
  "order.amend": "Amended order",
  "order.cancel": "Order canceled",
  "specimen.submitted": "Specimen submitted",
  "accession.issued": "Accession issued",
  "accession.acknowledged": "Accession acknowledged",
};

const OUTCOME_WORDS: Record<string, string> = {
  applied: "Accepted and applied",
  duplicate_ignored: "Duplicate, ignored",
  stale_ignored: "Older version, ignored",
  failed: "Not applied",
  conflict_review: "Held for review",
};

const OPEN_TASK = new Set(["open", "in_progress"]);
const RAW_LIMIT = 24_000;

/** The stored payload as readable data: pretty JSON when it parses, else the text as received (capped). */
function prettyRaw(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not JSON: shown verbatim */
  }
  return out.length > RAW_LIMIT ? `${out.slice(0, RAW_LIMIT)}\n… (${out.length - RAW_LIMIT} more characters not shown)` : out;
}

const plainName = (name: string) => name.replace(/\s*\((?:simulated[^)]*|deterministic demo)\)\s*$/i, "");

function plainError(raw: string | null): string | null {
  if (!raw) return null;
  if (/^simulated outage$/i.test(raw)) return "Not reachable (simulated outage).";
  if (/^simulated degraded connection/i.test(raw)) return "Slow link (simulated): messages arrive about 5 minutes late.";
  return raw;
}

function roleWords(roles: readonly Role[]): string {
  const labels = roles.map((r) => ROLE_LABEL[r]);
  if (labels.length <= 1) return labels[0] ?? "Unassigned";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1].replace(/^./, (c) => c.toLowerCase())}`;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const lat = (v: string | null | undefined) => (v ? (LATERALITY as Record<string, string>)[v] ?? v : "Unknown");
const show = (v: string | null | undefined) => (v && v.trim() ? v : "Unknown");

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function splitName(name: string): [string, string] {
  const [family, ...rest] = name.split(",");
  return [family.trim() || name.trim(), rest.join(",").trim() || "Unknown"];
}

/** "payload.patient.birth_date" (required) → "patient.birth_date is missing". */
function errorWords(e: ContractError): string {
  const path = e.path.replace(/^payload\./, "");
  return e.code === "required" ? `${path} is missing` : `${path}: ${e.message.replace(/\.$/, "")}`;
}

interface OrderPayload {
  patient?: { mrn?: string; name?: string; birth_date?: string };
  specimens?: { designation?: string; site?: string; laterality?: string | null; procedure?: string | null }[];
}

function humanStatus(s: string | undefined): string | undefined {
  return s ? s.replace(/_/g, " ") : undefined;
}

interface TaskInfo {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  title: string;
  owner_id: string | null;
  owner_role: string | null;
  status: string;
  intake_item_id: string | null;
  accession_id: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * Build the screen. `includeInSync` also lists the comparisons that agree (informational), and `allMessages`
 * lists every received message instead of the latest few.
 */
export function loadIntegrationScreen(db: DB, opts: { includeInSync?: boolean; allMessages?: boolean; messageLimit?: number } = {}): IntegrationScreen {
  const now = readClock(db).now;
  const recon = loadReconciliation(db, { includeInSync: true });

  // ------------------------------------------------------------------ lookups (prepared once)
  const staff = new Map((db.prepare("SELECT id, display_name, role FROM staff").all() as { id: string; display_name: string; role: string }[]).map((s) => [s.id, s]));
  const taskStmt = db.prepare("SELECT * FROM task WHERE id = ?");
  const task = (id: string | null | undefined) => (id ? (taskStmt.get(id) as TaskInfo | undefined) : undefined);
  const intakeById = db.prepare("SELECT id, display_id, status FROM intake_item WHERE id = ?");
  const accessionById = db.prepare("SELECT id, accession_number FROM accession WHERE id = ?");
  const specimenPart = db.prepare("SELECT sp.designation, a.accession_number FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.id = ?");
  const holdById = db.prepare("SELECT id, display_id, scope_label, intake_item_id, accession_id, status FROM hold WHERE id = ?");
  const correctionById = db.prepare("SELECT cr.id, cr.display_id, cr.status, a.accession_number FROM correction_review cr JOIN accession a ON a.id = cr.accession_id WHERE cr.id = ?");
  const clarificationById = db.prepare("SELECT id, display_id, state, lab_owner_id FROM clarification WHERE id = ?");
  const eventPayload = db.prepare("SELECT id, payload, outcome FROM integration_event WHERE source_id = ? AND message_id = ?");
  const ordersForPatient = db.prepare("SELECT id FROM source_order WHERE patient_ref_id = ?");
  const orderByKey = db.prepare("SELECT id FROM source_order WHERE tenant_id || ':' || source_order_id = ?");
  const itemsForOrder = db.prepare(
    "SELECT ii.id, ii.display_id, ii.status FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id WHERE l.source_order_id = ? ORDER BY ii.display_id",
  );
  const accessionsForOrder = db.prepare(
    "SELECT DISTINCT a.accession_number FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.source_order_id = ? ORDER BY a.accession_number",
  );
  const eventById = db.prepare("SELECT entity_key FROM integration_event WHERE id = ?");
  const eventRow = db.prepare("SELECT id, source_id, message_id, message_type, source_updated_at, payload FROM integration_event WHERE id = ?");
  const sourceById = db.prepare("SELECT id, name FROM integration_source WHERE id = ?");
  const patientRef = db.prepare("SELECT id, source_mrn, family_name, given_name, birth_date FROM patient_ref WHERE id = ?");
  const orderById = db.prepare("SELECT id, tenant_id, source_order_id, source_version FROM source_order WHERE id = ?");
  const latestVersion = db.prepare("SELECT source_version, payload FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC LIMIT 1");
  const versionPayload = db.prepare("SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = ?");
  const appliedEventFor = db.prepare(
    "SELECT source_id, message_id, source_updated_at, received_at, payload FROM integration_event WHERE entity_key = ? AND source_version = ? AND outcome = 'applied' ORDER BY received_at DESC, rowid DESC LIMIT 1",
  );
  const orderPartById = db.prepare("SELECT id, source_order_id, designation FROM source_order_part WHERE id = ?");

  const intakeLink = (displayId: string, status?: string): WorkLink => ({ screen: "Intake", label: displayId, href: `/intake?item=${encodeURIComponent(displayId)}`, status: humanStatus(status) });
  const caseLink = (accession: string, part?: string, status?: string): WorkLink => ({
    screen: "Case",
    label: part ? `${accession} part ${part}` : accession,
    href: `/cases/${encodeURIComponent(accession)}${part ? `?part=${encodeURIComponent(part)}` : ""}`,
    status: humanStatus(status),
  });

  /** Intake items and cases reached from source orders (for reviews that name a patient or an order, not an item). */
  function workForOrders(orderIds: string[]): WorkLink[] {
    const out: WorkLink[] = [];
    for (const id of orderIds) {
      for (const i of itemsForOrder.all(id) as { id: string; display_id: string; status: string }[]) out.push(intakeLink(i.display_id, i.status));
      for (const a of accessionsForOrder.all(id) as { accession_number: string }[]) out.push(caseLink(a.accession_number));
    }
    return out;
  }

  function workForTask(t: TaskInfo | undefined): WorkLink[] {
    if (!t) return [];
    const out: WorkLink[] = [];
    if (t.intake_item_id) {
      const i = intakeById.get(t.intake_item_id) as { display_id: string; status: string } | undefined;
      if (i) out.push(intakeLink(i.display_id, i.status));
    }
    if (t.accession_id) {
      const a = accessionById.get(t.accession_id) as { accession_number: string } | undefined;
      if (a) out.push(caseLink(a.accession_number));
    }
    if (!out.length) {
      if (t.entity_type === "patient_ref") out.push(...workForOrders((ordersForPatient.all(t.entity_id) as { id: string }[]).map((o) => o.id)));
      else if (t.entity_type === "source_order") out.push(...workForOrders([t.entity_id]));
      else if (t.entity_type === "integration_event") {
        const e = eventById.get(t.entity_id) as { entity_key: string } | undefined;
        const o = e ? (orderByKey.get(e.entity_key) as { id: string } | undefined) : undefined;
        if (o) out.push(...workForOrders([o.id]));
      } else if (t.entity_type === "hold") {
        const h = holdById.get(t.entity_id) as { display_id: string; intake_item_id: string | null; accession_id: string | null } | undefined;
        if (h?.intake_item_id) {
          const i = intakeById.get(h.intake_item_id) as { display_id: string; status: string } | undefined;
          if (i) out.push(intakeLink(i.display_id, i.status));
        }
        if (h?.accession_id) {
          const a = accessionById.get(h.accession_id) as { accession_number: string } | undefined;
          if (a) out.push(caseLink(a.accession_number));
        }
      } else if (t.entity_type === "specimen_part") {
        const sp = specimenPart.get(t.entity_id) as { designation: string; accession_number: string } | undefined;
        if (sp) out.push(caseLink(sp.accession_number, sp.designation));
      }
    }
    return out;
  }

  function ownerOfTask(t: TaskInfo): string {
    const s = t.owner_id ? staff.get(t.owner_id) : undefined;
    if (s) return `${s.display_name} (${ROLE_LABEL[s.role as Role] ?? s.role.replace(/_/g, " ")})`;
    if (t.owner_role && t.owner_role in ROLE_LABEL) return ROLE_LABEL[t.owner_role as Role];
    return "Unassigned";
  }

  function dedupe(links: WorkLink[]): WorkLink[] {
    const seen = new Map<string, WorkLink>();
    for (const l of links) {
      const k = `${l.screen}:${l.label}`;
      if (!seen.has(k)) seen.set(k, l);
    }
    // A case link with a part makes the bare case link redundant.
    return [...seen.values()].filter((l) => !(l.screen === "Case" && !l.label.includes(" part ") && [...seen.values()].some((o) => o.screen === "Case" && o.label.startsWith(`${l.label} part `))));
  }

  // ------------------------------------------------------------------ comparison rows
  const groupOf = (s: ReconStatus): ActionGroup => (s === "review_open" || s === "attention" ? "review" : s === "waiting" ? "waiting" : s === "failed" ? "failed" : "info");
  const covered = new Set<string>();
  const rows: ScreenRow[] = [];

  for (const r of recon.rows) {
    if (r.status === "in_sync" && !opts.includeInSync) continue;
    const t = task(r.review.taskId);
    // A task counts as covered only when a shown row IS its review; a task merely listed as touched work gets its own row below.
    if (r.status !== "in_sync" && r.review.taskId) covered.add(r.review.taskId);
    rows.push(fromRecon(r, t));
  }

  function fromRecon(r: ReconRow, t: TaskInfo | undefined): ScreenRow {
    const work: WorkLink[] = [];
    for (const i of r.impactedWork.intakeItems) work.push(intakeLink(i.label, i.status));
    for (const p of r.impactedWork.parts) {
      const sp = specimenPart.get(p.id) as { designation: string; accession_number: string } | undefined;
      if (sp) work.push(caseLink(sp.accession_number, sp.designation, p.status));
      else work.push({ screen: "Order", label: p.label, href: null, status: humanStatus(p.status) });
    }
    for (const h of r.impactedWork.holds) {
      const hold = holdById.get(h.id) as { display_id: string; intake_item_id: string | null; accession_id: string | null } | undefined;
      let href: string | null = null;
      if (hold?.intake_item_id) {
        const i = intakeById.get(hold.intake_item_id) as { display_id: string } | undefined;
        if (i) href = `/intake?item=${encodeURIComponent(i.display_id)}`;
      } else if (hold?.accession_id) {
        const a = accessionById.get(hold.accession_id) as { accession_number: string } | undefined;
        if (a) href = `/cases/${encodeURIComponent(a.accession_number)}`;
      }
      work.push({ screen: "Hold", label: h.label, href, status: humanStatus(h.status) });
    }
    for (const x of r.impactedWork.tasks) work.push(...workForTask(task(x.id)));
    if (t) work.push(...workForTask(t));
    if (r.kind === "source_conflict" && r.entity.type === "patient_ref") work.push(...workForOrders((ordersForPatient.all(r.entity.id) as { id: string }[]).map((o) => o.id)));
    if (r.kind === "source_conflict" && r.entity.type === "source_order") work.push(...workForOrders([r.entity.id]));

    let owner = "Nobody: no action needed";
    let action = r.review.note ?? "";
    let record: string | null = null;
    if (t) {
      owner = ownerOfTask(t);
      record = t.title;
      action = OPEN_TASK.has(t.status) ? "Review it on the linked screen; what is on file stays in effect until then." : `Reviewed (${humanStatus(t.status)}).`;
    } else if (r.review.correctionReviewId) {
      const c = correctionById.get(r.review.correctionReviewId) as { display_id: string; status: string; accession_number: string } | undefined;
      owner = roleWords(rolesFor("correction.close"));
      record = c ? `Correction review ${c.display_id} (${humanStatus(c.status)})` : `Correction review ${r.review.correctionDisplayId ?? ""}`.trim();
      if (c) work.push(caseLink(c.accession_number));
      action = r.review.required ? "Close the correction review on the case; the issued part is never changed by a message." : r.review.note ?? "Correction review closed.";
    } else if (r.review.clarificationId) {
      const c = clarificationById.get(r.review.clarificationId) as { display_id: string; state: string; lab_owner_id: string } | undefined;
      const s = c ? staff.get(c.lab_owner_id) : undefined;
      owner = s ? `${s.display_name} (${ROLE_LABEL[s.role as Role] ?? s.role})` : "The clarification's owner";
      record = `Clarification ${r.review.clarificationDisplayId}${c ? ` (${humanStatus(c.state)})` : ""}`;
      if (r.review.clarificationDisplayId) work.push({ screen: "Clarify", label: r.review.clarificationDisplayId, href: `/clarifications?selected=${encodeURIComponent(r.review.clarificationDisplayId)}`, status: humanStatus(c?.state) });
      action = r.review.note ?? "Waiting on the office's answer.";
    } else if (r.status === "failed") {
      owner = `${roleWords(rolesFor("integration.manage"))} (retry), or the source re-sends`;
      action = r.review.note ?? "";
    } else if (r.status === "waiting") {
      owner = `${r.sourceName ? plainName(r.sourceName) : "The source"} (simulated)`;
      action = r.review.note ?? "Nothing to do here: the source's reply is awaited.";
    } else if (r.status === "attention") {
      owner = `Not assigned: ${roleWords(rolesFor(r.kind === "patient" ? "identity.resolve" : "correction.close"))}`;
    } else if (r.status === "ignored") {
      owner = "Nobody: nothing was applied";
      action = "No action: the newer stored version stays in effect.";
    }

    // A failed or late message: link to the order it names, when that order is on file.
    if ((r.kind === "failed_import" || r.kind === "stale_ignored") && r.entity.type === "integration_event") {
      const key = (eventById.get(r.entity.id) as { entity_key: string } | undefined)?.entity_key;
      const o = key ? (orderByKey.get(key) as { id: string } | undefined) : undefined;
      if (o) work.push(...workForOrders([o.id]));
    }

    const refined = refine(r);

    const identity =
      !!refined.difference &&
      (r.kind === "patient" || (r.kind === "source_conflict" && (r.entity.type === "patient_ref" || /\b(MRN|patient|date of birth)\b/i.test(`${r.externalAssertion} ${r.difference}`))));
    const stored =
      refined.raw !== undefined
        ? { payload: refined.raw }
        : refined.sourceId && refined.messageId
          ? (eventPayload.get(refined.sourceId, refined.messageId) as { id: string; payload: string } | undefined)
          : undefined;
    if (refined.failure?.kind === "invalid_data") {
      owner = `${roleWords(rolesFor("integration.manage"))}, with the source`;
      action = "A retry here re-checks the same stored data and would fail again: the source must re-send corrected data under the same message id.";
    }
    return {
      key: r.key,
      kind: r.kind,
      group: groupOf(r.status),
      status: r.status,
      identity,
      what: refined.failure?.kind === "invalid_data" ? "Rejected: missing or invalid data" : KIND_WHAT[r.kind],
      subject: refined.subject,
      sourceId: refined.sourceId,
      sourceName: refined.sourceName ? plainName(refined.sourceName) : null,
      externalAssertion: refined.externalAssertion,
      localState: refined.localState,
      difference: refined.difference,
      sourceEventTime: refined.sourceEventTime,
      localReceivedTime: refined.localReceivedTime,
      messageId: refined.messageId,
      work: dedupe(work),
      review: { required: r.review.required, owner, action, record },
      raw: prettyRaw(stored?.payload),
      retryEventId: r.status === "failed" && refined.failure?.kind !== "invalid_data" ? r.entity.id : null,
      failure: refined.failure,
    };
  }

  /**
   * Page-level detail the comparison rows leave implicit, read from the same records: the incoming patient behind
   * a patient-level conflict (and the message that brought it), what a container was checked against before an
   * amendment, and the field-by-field reasons a message was rejected (the inbound endpoint's own checks).
   */
  function refine(r: ReconRow): {
    subject: string;
    sourceId: string | null;
    sourceName: string | null;
    externalAssertion: string;
    localState: string;
    difference: string | null;
    sourceEventTime: string | null;
    localReceivedTime: string | null;
    messageId: string | null;
    /** The stored message when it is not the row's own (undefined: look it up by message id). */
    raw?: string;
    failure: ScreenRow["failure"];
  } {
    const base = {
      subject: r.entity.label,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      externalAssertion: r.externalAssertion,
      localState: r.localState,
      difference: r.difference,
      sourceEventTime: r.sourceEventTime,
      localReceivedTime: r.localReceivedTime,
      messageId: r.messageId,
      failure: null as ScreenRow["failure"],
    };

    // A patient-level conflict: the order that named the MRN on file with other details, side by side with the patient on file.
    if (r.kind === "source_conflict" && r.entity.type === "patient_ref") {
      const pr = patientRef.get(r.entity.id) as { source_mrn: string; family_name: string; given_name: string; birth_date: string } | undefined;
      if (!pr) return base;
      for (const { id } of ordersForPatient.all(r.entity.id) as { id: string }[]) {
        const so = orderById.get(id) as { tenant_id: string; source_order_id: string; source_version: number } | undefined;
        const v = latestVersion.get(id) as { source_version: number; payload: string } | undefined;
        const p = parseJson<OrderPayload>(v?.payload)?.patient;
        if (!so || !v || !p) continue;
        const [family, given] = splitName(p.name ?? "");
        const diffs: string[] = [];
        if (norm(p.mrn) !== norm(pr.source_mrn)) diffs.push(`MRN ${pr.source_mrn} → ${show(p.mrn)}`);
        if (norm(family) !== norm(pr.family_name) || norm(given) !== norm(pr.given_name)) diffs.push(`name ${pr.family_name}, ${pr.given_name} → ${show(p.name)}`);
        if (norm(p.birth_date) !== norm(pr.birth_date)) diffs.push(`date of birth ${pr.birth_date} → ${show(p.birth_date)}`);
        if (!diffs.length) continue;
        const ev = appliedEventFor.get(`${so.tenant_id}:${so.source_order_id}`, v.source_version) as
          | { source_id: string; message_id: string; source_updated_at: string | null; received_at: string; payload: string }
          | undefined;
        const src = ev ? (sourceById.get(ev.source_id) as { id: string; name: string } | undefined) : undefined;
        const sentence = diffs.join("; ");
        return {
          ...base,
          subject: `MRN ${pr.source_mrn}, patient on file`,
          sourceId: src?.id ?? base.sourceId,
          sourceName: src?.name ?? base.sourceName,
          externalAssertion: `Order ${so.source_order_id} v${v.source_version}: MRN ${show(p.mrn)} · ${show(p.name)} · born ${show(p.birth_date)}`,
          localState: `MRN ${pr.source_mrn} · ${pr.family_name}, ${pr.given_name} · born ${pr.birth_date} (kept as it is)`,
          difference: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. The order was linked to the patient on file by MRN; nothing was merged or overwritten.`,
          sourceEventTime: ev?.source_updated_at ?? base.sourceEventTime,
          localReceivedTime: ev?.received_at ?? base.localReceivedTime,
          messageId: ev?.message_id ?? null,
          raw: ev?.payload,
        };
      }
      return base;
    }

    // Before accession: what the container was checked against, and what the source changed since.
    if (r.kind === "site_laterality" && r.entity.type === "source_order_part" && r.difference) {
      const m = /checked against v(\d+); the source is now at v(\d+)/.exec(r.difference);
      const part = orderPartById.get(r.entity.id) as { source_order_id: string; designation: string } | undefined;
      if (!m || !part) return base;
      const line = (payload: string | undefined) =>
        parseJson<OrderPayload>(payload)?.specimens?.find((s) => (s.designation ?? "").toUpperCase() === part.designation.toUpperCase());
      const before = line((versionPayload.get(part.source_order_id, Number(m[1])) as { payload: string } | undefined)?.payload);
      const after = line((versionPayload.get(part.source_order_id, Number(m[2])) as { payload: string } | undefined)?.payload);
      if (!before) return base;
      const changes: string[] = [];
      if (after) {
        if (norm(before.site) !== norm(after.site)) changes.push(`site ${show(before.site)} → ${show(after.site)}`);
        if (norm(before.laterality) !== norm(after.laterality)) changes.push(`laterality ${lat(before.laterality)} → ${lat(after.laterality)}`);
        if (norm(before.procedure) !== norm(after.procedure)) changes.push(`procedure ${show(before.procedure)} → ${show(after.procedure)}`);
      }
      const changed = changes.join("; ");
      return {
        ...base,
        localState: `As checked (v${m[1]}): Part ${part.designation}: ${show(before.site)} · ${lat(before.laterality)} · ${show(before.procedure)}. ${r.localState.charAt(0).toUpperCase()}${r.localState.slice(1)}.`,
        difference: changes.length ? `Changed at source after the check: ${changed}. ${r.difference.charAt(0).toUpperCase()}${r.difference.slice(1)}` : r.difference,
      };
    }

    // A failed or late message: name the order and version, not the message id; say why it failed, field by field.
    if ((r.kind === "failed_import" || r.kind === "stale_ignored") && r.entity.type === "integration_event") {
      const m = /^(\S+) (.+)$/.exec(r.externalAssertion);
      const type = m?.[1] ?? "";
      const label = m?.[2] ?? r.externalAssertion;
      const what = MESSAGE_WHAT[type] ?? type;
      const out = { ...base, subject: label, externalAssertion: `${what} ${label}${r.kind === "stale_ignored" ? ", sent after a newer version" : ""}` };
      if (r.kind === "failed_import") {
        const ev = eventRow.get(r.entity.id) as { source_id: string; message_id: string; message_type: string; source_updated_at: string | null; payload: string } | undefined;
        const src = ev ? (sourceById.get(ev.source_id) as { id: string; name: string } | undefined) : undefined;
        let errors: ContractError[] = [];
        try {
          errors =
            ev && src
              ? failureErrors(db, src, { contract_version: CONTRACT_VERSION, source_id: ev.source_id, message_id: ev.message_id, message_type: ev.message_type, sent_at: ev.source_updated_at, payload: ev.payload })
              : [];
        } catch {
          errors = [];
        }
        if (errors.length) {
          const reasons = errors.slice(0, 6).map(errorWords);
          return {
            ...out,
            difference: `Rejected: ${reasons.join("; ")}${errors.length > 6 ? `; and ${errors.length - 6} more` : ""}. Nothing was applied.`,
            failure: { kind: "invalid_data", errors },
          };
        }
        return { ...out, failure: { kind: "processing", errors: [] } };
      }
      return out;
    }
    return base;
  }

  // ------------------------------------------------------------------ open import reviews no comparison row covers
  const sourceForTenant = new Map<string, { id: string; name: string }>();
  for (const s of db.prepare("SELECT id, name, tenant_id FROM integration_source WHERE tenant_id IS NOT NULL ORDER BY id").all() as { id: string; name: string; tenant_id: string }[]) {
    if (!sourceForTenant.has(s.tenant_id)) sourceForTenant.set(s.tenant_id, { id: s.id, name: s.name });
  }
  const extra = db
    .prepare("SELECT * FROM task WHERE kind IN ('order_change_review','source_conflict') AND status IN ('open','in_progress') ORDER BY created_at, id")
    .all() as TaskInfo[];
  for (const t of extra) {
    if (covered.has(t.id)) continue;
    covered.add(t.id);
    const tenantOfTask = (() => {
      const viaOrder = (orderId: string) => (db.prepare("SELECT tenant_id FROM source_order WHERE id = ?").get(orderId) as { tenant_id: string } | undefined)?.tenant_id;
      if (t.entity_type === "source_order") return viaOrder(t.entity_id);
      const viaColumn = (table: "source_order_part" | "work_order" | "specimen_part") => {
        const p = db.prepare(`SELECT source_order_id FROM ${table} WHERE id = ?`).get(t.entity_id) as { source_order_id: string | null } | undefined;
        return p?.source_order_id ? viaOrder(p.source_order_id) : undefined;
      };
      if (t.entity_type === "source_order_part" || t.entity_type === "work_order" || t.entity_type === "specimen_part") return viaColumn(t.entity_type);
      return undefined;
    })();
    const src = tenantOfTask ? sourceForTenant.get(tenantOfTask) : undefined;
    rows.push({
      key: `task:${t.id}`,
      kind: "order_change",
      group: "review",
      status: "review_open",
      identity: t.kind === "source_conflict" && /\b(MRN|patient|date of birth)\b/i.test(t.title),
      what: t.kind === "source_conflict" ? KIND_WHAT.source_conflict : KIND_WHAT.order_change,
      subject: t.title.split(" — ")[0],
      sourceId: src?.id ?? null,
      sourceName: src ? plainName(src.name) : null,
      externalAssertion: t.title,
      localState: "Work already done here is kept as it is until a person reviews the change.",
      difference: t.detail,
      sourceEventTime: null,
      localReceivedTime: t.created_at,
      messageId: null,
      work: dedupe(workForTask(t)),
      review: { required: true, owner: ownerOfTask(t), action: "Review it on the linked screen; nothing was changed automatically.", record: t.title },
      raw: null,
      retryEventId: null,
      failure: null,
    });
  }

  // ------------------------------------------------------------------ sources
  const fresh = sourceFreshness(db, now);
  const sources: SourceView[] = fresh.map((f) => ({
    id: f.sourceId,
    name: f.tenantName ?? plainName(f.name),
    status: f.status,
    statusWord: f.status === "offline" ? "Unavailable" : f.status === "degraded" ? "Slow link" : "Connected",
    freshness: f.state,
    lastContactAt: f.lastAttemptAt,
    lastSuccessAt: f.lastSuccessAt,
    offlineSince: f.offlineSince,
    lastError: plainError(f.lastError),
    waiting: f.backlog,
    counts: { review: 0, waiting: 0, failed: 0, info: 0 },
    issuesAccessions: f.sourceId === "src_ema",
  }));

  // An unavailable or slow source with messages held back: the operator waits on the source.
  for (const s of sources) {
    if (s.status === "connected" && s.freshness !== "stale") continue;
    const unavailable = s.status === "offline";
    rows.push({
      key: `source:${s.id}`,
      kind: "source_status",
      group: "waiting",
      status: "waiting",
      identity: false,
      what: unavailable ? "Source unavailable" : s.status === "degraded" ? "Slow link" : "No recent sync",
      subject: s.name,
      sourceId: s.id,
      sourceName: s.name,
      externalAssertion: unavailable
        ? "Nothing can be received while it is unreachable (simulated outage)."
        : s.status === "degraded"
          ? "Messages arrive about 5 minutes late (simulated)."
          : "No successful sync for more than 15 minutes.",
      localState: `${s.waiting} message${s.waiting === 1 ? "" : "s"} waiting at the source; nothing from ${s.waiting === 1 ? "it" : "them"} has been applied here.`,
      difference: unavailable
        ? "New orders, amendments and accession replies cannot arrive. Screens show the last confirmed data. Waiting messages are applied once, in order, when the source is back."
        : "Source-derived data may be out of date.",
      sourceEventTime: null,
      localReceivedTime: s.lastSuccessAt,
      messageId: null,
      work: [],
      review: { required: false, owner: `${s.name} (simulated)`, action: "Nothing to do here: wait for the source, or follow the downtime procedure.", record: null },
      raw: null,
      retryEventId: null,
      failure: null,
    });
  }

  // Identity first (top rung), then the order the read model gives.
  rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || Number(b.identity) - Number(a.identity));

  const counts: Record<ActionGroup, number> = { review: 0, waiting: 0, failed: 0, info: 0 };
  for (const r of rows) {
    counts[r.group] += 1;
    const s = sources.find((x) => x.id === r.sourceId);
    if (s) s.counts[r.group] += 1;
  }

  // ------------------------------------------------------------------ recent messages (one line per message id)
  const seedStart = seedClockStart(db, now);
  const total = (db.prepare("SELECT COUNT(*) n FROM integration_event WHERE outcome NOT IN ('failed','stale_ignored')").get() as { n: number }).n;
  const limit = opts.allMessages ? -1 : opts.messageLimit ?? 10;
  const msgRows = db
    .prepare(
      `SELECT e.id, e.message_id, e.message_type, e.entity_key, e.source_version, e.source_updated_at, e.received_at, e.outcome, e.detail, e.payload, e.receipt_count,
              s.name source_name,
              COALESCE((SELECT MAX(r.received_at) FROM integration_receipt r WHERE r.event_id = e.id), e.received_at) last_received_at
         FROM integration_event e JOIN integration_source s ON s.id = e.source_id
        WHERE e.outcome NOT IN ('failed','stale_ignored')
        ORDER BY last_received_at DESC, e.rowid DESC
        LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    message_id: string;
    message_type: string;
    entity_key: string;
    source_version: number | null;
    source_updated_at: string | null;
    received_at: string;
    outcome: string;
    detail: string | null;
    payload: string;
    receipt_count: number;
    source_name: string;
    last_received_at: string;
  }[];
  const shown: MessageView[] = msgRows.map((m) => {
    const key = m.entity_key.includes(":") ? m.entity_key.slice(m.entity_key.indexOf(":") + 1).replace(/^accession_request:/, "") : m.entity_key;
    return {
      eventId: m.id,
      sourceName: plainName(m.source_name),
      messageId: m.message_id,
      what: MESSAGE_WHAT[m.message_type] ?? m.message_type,
      subject: `${key}${m.source_version !== null ? ` v${m.source_version}` : ""}`,
      outcome: m.outcome,
      outcomeWords: OUTCOME_WORDS[m.outcome] ?? m.outcome.replace(/_/g, " "),
      detail: m.detail,
      sourceEventTime: m.source_updated_at,
      firstReceivedAt: m.received_at,
      lastReceivedAt: m.last_received_at,
      deliveries: Math.max(1, m.receipt_count),
      seeded: m.received_at <= seedStart && m.receipt_count <= 1,
      raw: prettyRaw(m.payload) ?? "",
    };
  });

  return {
    now,
    sources,
    rows,
    counts,
    messages: { shown, total },
    compared: { orders: recon.summary.ordersCompared, inSync: recon.summary.ordersInSync },
    includeInSync: !!opts.includeInSync,
  };
}

/** Counts per action group (Operations and the source-freshness popover link here with them). */
export function loadIntegrationCounts(db: DB): Record<ActionGroup, number> & { unavailable: number } {
  const s = loadIntegrationScreen(db, { messageLimit: 0 });
  return { ...s.counts, unavailable: s.sources.filter((x) => x.status === "offline").length };
}
