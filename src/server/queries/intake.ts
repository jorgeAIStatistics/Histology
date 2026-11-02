import type { DB } from "@/server/db/db";
import type { Actor } from "@/server/core/context";
import { readClock } from "@/server/core/clock";
import { roleCan } from "@/lib/roles";
import { fmtDate, labDay } from "@/lib/time";
import { activeHolds, blockedTransitions, scopesForIntake, type HoldRow } from "@/server/domain/holds";
import {
  type CompareField,
  type ComparisonRow,
  type ContainerRow,
  type DiscrepancyRow,
  type IntakeItemRow,
  COMPARE_FIELD_LABEL,
  IDENTITY_FIELDS,
  comparisonForContainer,
  containersFor,
  mismatchHoldReason,
  mismatchValues,
  parseLabel,
  requisitionFor,
} from "@/server/domain/intake";
import { currentRouting, type RoutingDecisionRow } from "@/server/domain/routing";
import { candidatesForIntake, intakeItemsForOrder, separateEncounterOrders, DETECTION_RULE_DUPLICATE_RECORD, type ReasonItem } from "@/server/domain/related";
import { accessionBlockers, latestRequestFor, type Blocker } from "@/server/domain/accession";
import { openSourceConflictsForOrder } from "@/server/domain/sourceConflict";
import { historyPayload } from "@/server/domain/privacy";
import { accessionSourceStatus } from "@/server/sim/authoritative";
import { countUnreceived, labelText } from "@/server/sim/courier";
import { CORRECTION_KIND_LABEL, CORRECTION_STATUS_LABEL } from "@/server/domain/correction";
import { assistantMode } from "@/server/assist/drafter";
import { genericBody, SIMULATED_TAG } from "@/server/sim/notifications";
import { buildPlan, openOrder, partsOf, queueFlags, type IntakePlan, type QueueFlag } from "@/components/intake/plan";

/**
 * Read side of the intake bench (server components call these directly).
 * Everything returned is plain JSON so it can be passed to client components.
 * Unknown values stay `null` (rendered as "Unknown", never 0).
 */

// ---------------------------------------------------------------- types

export type Lane = "to_review" | "exceptions" | "done";

export interface ManifestLineView {
  id: string;
  officeId: string | null;
  officeName: string;
  manifestSource: string;
  /** null = Unknown (no source manifest). */
  expected: number | null;
  received: number;
  /** null when expected is unknown. */
  missing: number | null;
  extra: number;
  note: string | null;
  /** Order parts with no container received, e.g. "ORD-77140 part B". */
  missingParts: { orderRef: string; designation: string; intakeDisplay: string }[];
  items: string[];
}

export interface DeliveryView {
  id: string;
  displayId: string;
  courierName: string;
  routeLabel: string | null;
  expectedAt: string | null;
  arrivedAt: string | null;
  receivedByName: string | null;
  status: string;
  version: number;
  lines: ManifestLineView[];
  /** Received containers from offices with no manifest line. */
  offManifest: { officeName: string; received: number; items: string[] }[];
  totals: {
    expected: number | null;
    expectedKnownPart: number;
    received: number;
    missing: number | null;
    extra: number;
    unknownLines: number;
    /** Received containers that a person has checked against the order (verified or discrepancy recorded). */
    checked: number;
  };
  /** SIMULATOR: requisitions still in the courier bag (demo unpack controls only). */
  simRemaining: number;
  simTotal: number;
  /** Unpacking finished (status reconciled): missing / extra counts are final, not "so far". */
  unpackingComplete: boolean;
}

export interface QueueItem {
  id: string;
  displayId: string;
  status: string;
  lane: Lane;
  reasons: string[];
  officeName: string;
  officeKnown: boolean;
  patientName: string | null;
  orderRefs: string[];
  containerCount: number;
  verifiedCount: number;
  accessionNumber: string | null;
  receivedAt: string;
  deliveryDisplay: string | null;
  routingStatus: string | null;
  pathologistName: string | null;
  pathologistColor: string | null;
  ownerName: string | null;
  /** Lane reasons ranked by the severity ladder (identity, field differs, hold, waiting on a named owner). */
  flags: QueueFlag[];
  /** The related-order review this item is part of (never a merge). */
  related: { displayId: string; status: string; ownerName: string | null } | null;
}

export interface OrderPartView {
  id: string;
  designation: string;
  siteText: string;
  laterality: string | null;
  procedure: string | null;
  collectedAt: string | null;
  expectedContainers: number | null;
  stains: string[];
  receivedContainers: number;
}

export interface OrderView {
  id: string;
  sourceOrderId: string;
  tenantName: string;
  sourceVersion: number;
  sourceStatus: string;
  sourceUpdatedAt: string;
  importedAt: string;
  clinicianName: string | null;
  clinicianCredential: string | null;
  officeName: string;
  encounter: string | null;
  encounterAt: string | null;
  /** Untrusted free text from the source: display as plain text only. */
  clinicalNote: string | null;
  versions: { version: number; updatedAt: string; importedAt: string; changeSummary: string | null }[];
  parts: OrderPartView[];
}

export interface ContainerView {
  id: string;
  seq: number;
  version: number;
  observed: Record<string, string | null>;
  labelText: string;
  handwritten: boolean;
  capture: string;
  orderPartId: string | null;
  orderRef: string | null;
  designation: string | null;
  linkBasis: string | null;
  verificationState: "unverified" | "verified" | "discrepancy";
  verifiedByName: string | null;
  verifiedAt: string | null;
  conditionNote: string | null;
  comparison: ComparisonRow[];
  lastVerification: { orderVersion: number; result: string; at: string; byName: string | null; origin: string } | null;
  currentOrderVersion: number | null;
  orderChangedSinceVerification: boolean;
  clarification: { id: string; displayId: string; state: string; category: string } | null;
  openMismatchFields: string[];
  /** Recorded (open) field mismatches for this container, with their frozen values. */
  openMismatches: {
    id: string;
    version: number;
    field: string;
    label: string;
    identity: boolean;
    detectedAt: string;
    detectedByName: string | null;
    order: string | null;
    observed: string | null;
    requisition: string | null;
    orderVersion: number | null;
    /** Set when the values now agree but the finding stays open (why). Null = still differs. */
    holdReason: string | null;
  }[];
  /** Mismatches an accessioning lead or supervisor accepted with a reason. */
  acceptedMismatches: { id: string; field: string; label: string; byName: string | null; at: string | null; reason: string | null }[];
}

export interface RoutingView {
  id: string;
  status: string;
  suggested: { id: string; name: string; color: string | null } | null;
  final: { id: string; name: string; color: string | null } | null;
  ruleSetVersion: number | null;
  ruleSetEffectiveFrom: string | null;
  explanation: string;
  overrideReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  coverage: boolean;
}

export interface RelatedView {
  id: string;
  displayId: string;
  status: string;
  version: number;
  reasons: ReasonItem[];
  conflicts: ReasonItem[];
  detectionRule: string;
  duplicateRecordKind: boolean;
  detectedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  orders: { id: string; sourceOrderId: string; tenantName: string }[];
  otherItems: { id: string; displayId: string; status: string }[];
  /** The two submissions as the lead's A | B columns read them (derived, read-only; nothing is joined). */
  sides: RelatedSide[];
}

/**
 * One submission of a related-order candidate, read from its own records, so each
 * reason and conflict can be shown for both submissions in aligned columns.
 */
export interface RelatedSide {
  orderId: string;
  sourceOrderId: string;
  /** The intake item that received this order (null if none on the bench). */
  intakeDisplayId: string | null;
  parts: string[];
  /** What this submission's own record says for each reason or conflict code; null = not stated. */
  values: Record<string, string | null>;
}

export interface HoldView {
  id: string;
  displayId: string;
  scopeType: string;
  scopeLabel: string;
  reasonText: string;
  blocks: string[];
  blocksAccession: boolean;
  clarificationDisplayId: string | null;
  placedByName: string | null;
  placedAt: string;
  version: number;
}

export interface ClarificationView {
  id: string;
  displayId: string;
  /** Row version, sent back with a send (stale-safe). */
  version: number;
  /** For a drafted question: the generic notice the office would receive (no patient details). */
  noticePreview: string | null;
  category: string;
  state: string;
  subjectLabel: string;
  question: string;
  ownerName: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
  /** Material the question was raised on (null = the whole intake item). */
  containerId: string | null;
  orderPartId: string | null;
}

export interface TaskView {
  id: string;
  kind: string;
  title: string;
  ownerName: string | null;
  ownerRole: string | null;
  status: string;
  priority: string;
  createdAt: string;
  dueAt: string | null;
}

export interface AuditView {
  id: string;
  at: string;
  actorName: string | null;
  actorRole: string | null;
  origin: string;
  action: string;
  summary: string;
  reason: string | null;
  before: string | null;
  after: string | null;
}

/**
 * An open source-conflict review on one of this item's linked orders or on its
 * patient reference: the source sent patient (or order-level) details that
 * differ from what is on file. It gates accession (`source_conflict_open`)
 * until an accessioning lead or supervisor reviews it. Derived, read-only.
 */
export interface SourceConflictView {
  /** The review task (sent back with its version by sourceConflict.review). */
  id: string;
  version: number;
  /** "patient": a new order gave different details for the patient on file; "order": a newer version of a linked order changed order-level details. */
  about: "patient" | "order";
  /** The task title as the importer wrote it (what differs, in words). */
  title: string;
  detail: string | null;
  ownerName: string | null;
  ownerRole: string | null;
  priority: string;
  createdAt: string;
  /** This item's linked orders that the conflict holds back. */
  orderRefs: string[];
}

export interface MissingPartView {
  discrepancyId: string;
  /** Version of the discrepancy row (for a lead's acceptance of an extra container). */
  version: number;
  orderPartId: string;
  orderRef: string;
  designation: string;
  expected: number | null;
  received: number;
  /** Container numbers currently linked to this part. */
  containerSeqs: number[];
  clarification: { displayId: string; state: string } | null;
}

export interface ItemDetail {
  id: string;
  displayId: string;
  status: string;
  version: number;
  notes: string | null;
  ownerId: string | null;
  ownerName: string | null;
  receivedAt: string;
  receivedByName: string | null;
  updatedAt: string;
  updatedByName: string | null;
  delivery: { id: string; displayId: string } | null;
  office: { id: string; name: string; status: string; tenantName: string } | null;
  observedOfficeText: string | null;
  accession: { id: string; number: string; namespace: string; issuedAt: string; issuedBy: string; pathologistName: string | null } | null;
  patient: { name: string; birthDate: string; mrn: string; tenantName: string } | null;
  orders: OrderView[];
  requisition: { docRef: string; fields: Record<string, unknown> } | null;
  containers: ContainerView[];
  missingParts: MissingPartView[];
  /** Order parts with more containers than the order expects. */
  extraParts: MissingPartView[];
  openDiscrepancies: { id: string; kind: string; field: string | null; label: string; containerSeq: number | null }[];
  routing: RoutingView | null;
  routingHistory: RoutingView[];
  related: RelatedView[];
  separateEncounters: ReturnType<typeof separateEncounterOrders>;
  holds: HoldView[];
  /** Open source-conflict reviews that gate this item's accession (oldest first). */
  sourceConflicts: SourceConflictView[];
  clarifications: ClarificationView[];
  tasks: TaskView[];
  audit: AuditView[];
  lane: Lane;
  laneReasons: string[];
  readiness: {
    ready: boolean;
    blockers: Blocker[];
    /** Items approved as one accession with this one (request them together). */
    group: { ids: string[]; displayIds: string[]; candidateId: string | null; blockers: Blocker[] } | null;
  };
  latestRequest: { id: string; displayId: string; status: string; requestedAt: string; failureDetail: string | null } | null;
  corrections: { id: string; displayId: string; kind: string; kindLabel: string; status: string; statusLabel: string; description: string; requestedAt: string; version: number }[];
}

export interface BenchPermissions {
  receive: boolean;
  edit: boolean;
  verify: boolean;
  confirmRouting: boolean;
  override: boolean;
  resolveException: boolean;
  reviewRelated: boolean;
  acceptDiscrepancy: boolean;
  requestAccession: boolean;
  raiseClarification: boolean;
  placeHold: boolean;
  openCorrection: boolean;
  closeCorrection: boolean;
  print: boolean;
  sendClarification: boolean;
  reviewClarification: boolean;
  /** Record that the details on file stand for a source conflict (sourceConflict.review). */
  reviewSourceConflict: boolean;
}

/**
 * A possibly related item shown beside this one (never merged): just what the
 * screen needs to state the hold scope for every part and draw the A | B plates.
 */
export interface SiblingView {
  id: string;
  displayId: string;
  status: string;
  part: string | null;
  orderRef: string | null;
  site: string | null;
  procedure: string | null;
  verification: "unverified" | "verified" | "discrepancy" | "none";
  differing: string[];
  holds: { displayId: string; scopeType: string; scopeLabel: string; blocks: string[]; blocksAccession: boolean }[];
  accession: string | null;
}

export interface IntakeBench {
  now: string;
  demoDay: string;
  actor: { id: string; name: string; role: string };
  permissions: BenchPermissions;
  source: { available: boolean; status: string; name: string; lastSuccessAt: string | null };
  deliveries: DeliveryView[];
  activeDeliveryId: string | null;
  queue: QueueItem[];
  counts: Record<Lane, number>;
  pathologists: { id: string; name: string; shortName: string; color: string | null }[];
  selected: ItemDetail | null;
  selectedNotFound: string | null;
  /** Read-only demo roles (Director, Medical director). */
  readOnly: boolean;
  assistantMode: "deterministic" | "unavailable";
  /** Possibly related items of the selected item (context only). */
  siblings: SiblingView[];
  /** For the selected item and this actor: finding, hold scope, five steps, next step, waiting on, accession reason. */
  plan: IntakePlan | null;
  /** The first open item in working order (exceptions, then routine review), for the empty state. */
  firstOpen: { displayId: string; patientName: string | null; reason: string | null } | null;
}

// ---------------------------------------------------------------- helpers

type StaffRow = { id: string; display_name: string; short_name: string; role: string; color_token: string | null };

function staffMap(db: DB): Map<string, StaffRow> {
  const rows = db.prepare("SELECT id, display_name, short_name, role, color_token FROM staff").all() as StaffRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function nameOf(staff: Map<string, StaffRow>, id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === "system") return "System";
  return staff.get(id)?.display_name ?? id;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function permissionsFor(role: Actor["role"]): BenchPermissions {
  return {
    receive: roleCan(role, "intake.receive"),
    edit: roleCan(role, "intake.edit"),
    verify: roleCan(role, "intake.verifyContainer"),
    confirmRouting: roleCan(role, "routing.confirm"),
    override: roleCan(role, "routing.override"),
    resolveException: roleCan(role, "routing.resolveException"),
    reviewRelated: roleCan(role, "related.review"),
    acceptDiscrepancy: roleCan(role, "clarification.resolve"),
    requestAccession: roleCan(role, "accession.request"),
    raiseClarification: roleCan(role, "clarification.create"),
    placeHold: roleCan(role, "hold.place"),
    openCorrection: roleCan(role, "correction.open"),
    closeCorrection: roleCan(role, "correction.close"),
    print: roleCan(role, "print.request"),
    sendClarification: roleCan(role, "clarification.send"),
    reviewClarification: roleCan(role, "clarification.review"),
    reviewSourceConflict: roleCan(role, "clarification.resolve"),
  };
}

// ---------------------------------------------------------------- deliveries / manifest reconciliation

export function deliveriesForDay(db: DB, day: string): DeliveryView[] {
  const staff = staffMap(db);
  const rows = db
    .prepare("SELECT * FROM courier_delivery ORDER BY COALESCE(expected_at, arrived_at)")
    .all() as { id: string; display_id: string; courier_name: string; route_label: string | null; expected_at: string | null; arrived_at: string | null; received_by: string | null; status: string; version: number }[];
  const out: DeliveryView[] = [];
  for (const d of rows) {
    const when = d.expected_at ?? d.arrived_at;
    if (!when || labDay(when) !== day) continue;
    const lines = db.prepare("SELECT * FROM manifest_line WHERE delivery_id = ? ORDER BY rowid").all(d.id) as {
      id: string; office_id: string | null; observed_office_text: string | null; manifest_source: string; expected_containers: number | null; note: string | null;
    }[];
    const items = db
      .prepare(
        `SELECT ii.id, ii.display_id, ii.office_id, ii.observed_office_text, (SELECT COUNT(*) FROM container c WHERE c.intake_item_id = ii.id) n,
                (SELECT COUNT(*) FROM container c WHERE c.intake_item_id = ii.id AND c.verification_state <> 'unverified') checked
           FROM intake_item ii WHERE ii.delivery_id = ? ORDER BY ii.received_at`,
      )
      .all(d.id) as { id: string; display_id: string; office_id: string | null; observed_office_text: string | null; n: number; checked: number }[];
    const officeNames = new Map((db.prepare("SELECT id, name FROM office").all() as { id: string; name: string }[]).map((o) => [o.id, o.name]));
    const missingRows = db
      .prepare(
        `SELECT d.intake_item_id, ii.display_id, so.source_order_id, sop.designation FROM intake_discrepancy d
           JOIN intake_item ii ON ii.id = d.intake_item_id JOIN source_order_part sop ON sop.id = d.order_part_id JOIN source_order so ON so.id = sop.source_order_id
          WHERE ii.delivery_id = ? AND d.kind = 'missing_container' AND d.status = 'open'`,
      )
      .all(d.id) as { intake_item_id: string; display_id: string; source_order_id: string; designation: string }[];
    const used = new Set<string>();
    const lineViews: ManifestLineView[] = lines.map((l) => {
      const officeName = l.office_id ? officeNames.get(l.office_id) ?? l.office_id : l.observed_office_text ?? "Unknown office";
      const mine = items.filter((it) =>
        l.office_id
          ? it.office_id === l.office_id
          : (it.observed_office_text ?? "").trim().toLowerCase() === (l.observed_office_text ?? "").trim().toLowerCase(),
      );
      mine.forEach((it) => used.add(it.id));
      const received = mine.reduce((s, it) => s + it.n, 0);
      const expected = l.expected_containers;
      const mineIds = new Set(mine.map((m) => m.id));
      return {
        id: l.id,
        officeId: l.office_id,
        officeName,
        manifestSource: l.manifest_source,
        expected,
        received,
        missing: expected === null ? null : Math.max(0, expected - received),
        extra: expected === null ? 0 : Math.max(0, received - expected),
        note: l.note,
        missingParts: missingRows.filter((m) => mineIds.has(m.intake_item_id)).map((m) => ({ orderRef: m.source_order_id, designation: m.designation, intakeDisplay: m.display_id })),
        items: mine.map((m) => m.display_id),
      };
    });
    const off = items.filter((it) => !used.has(it.id));
    const offGroups = new Map<string, { officeName: string; received: number; items: string[] }>();
    for (const it of off) {
      const name = it.office_id ? officeNames.get(it.office_id) ?? "Unknown office" : it.observed_office_text ?? "Unknown office";
      const g = offGroups.get(name) ?? { officeName: name, received: 0, items: [] };
      g.received += it.n;
      g.items.push(it.display_id);
      offGroups.set(name, g);
    }
    const unknownLines = lineViews.filter((l) => l.expected === null).length;
    const expectedKnownPart = lineViews.reduce((s, l) => s + (l.expected ?? 0), 0);
    const received = lineViews.reduce((s, l) => s + l.received, 0) + [...offGroups.values()].reduce((s, g) => s + g.received, 0);
    const extra = lineViews.reduce((s, l) => s + l.extra, 0) + [...offGroups.values()].reduce((s, g) => s + g.received, 0);
    const simTotal = (db.prepare("SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ?").get(d.id) as { n: number }).n;
    out.push({
      id: d.id,
      displayId: d.display_id,
      courierName: d.courier_name,
      routeLabel: d.route_label,
      expectedAt: d.expected_at,
      arrivedAt: d.arrived_at,
      receivedByName: nameOf(staff, d.received_by),
      status: d.status,
      version: d.version,
      lines: lineViews,
      offManifest: [...offGroups.values()],
      totals: {
        expected: unknownLines ? null : expectedKnownPart,
        expectedKnownPart,
        received,
        missing: unknownLines ? null : lineViews.reduce((s, l) => s + (l.missing ?? 0), 0),
        extra,
        unknownLines,
        checked: items.reduce((n, it) => n + it.checked, 0),
      },
      simRemaining: countUnreceived(db, d.id),
      simTotal,
      unpackingComplete: d.status === "reconciled",
    });
  }
  return out;
}

// ---------------------------------------------------------------- lanes

interface LaneFacts {
  lane: Lane;
  reasons: string[];
}

function laneFor(db: DB, item: IntakeItemRow, routing: RoutingDecisionRow | null): LaneFacts {
  if (item.status === "accessioned" || item.status === "canceled") return { lane: "done", reasons: [] };
  const reasons: string[] = [];
  if (!item.office_id) reasons.push("Office not in directory");
  if (routing?.status === "exception") reasons.push("Routing exception");
  const disc = db.prepare("SELECT kind, field, container_id FROM intake_discrepancy WHERE intake_item_id = ? AND status = 'open'").all(item.id) as {
    kind: string; field: string | null; container_id: string | null;
  }[];
  const mismatchFields = [...new Set(disc.filter((d) => d.kind === "field_mismatch").map((d) => d.field ?? ""))];
  const identityFields: string[] = mismatchFields.filter((f) => f === "patient_name" || f === "birth_date" || f === "mrn");
  const otherFields = mismatchFields.filter((f) => !identityFields.includes(f));
  const discContainers = (db.prepare("SELECT COUNT(*) n FROM container WHERE intake_item_id = ? AND verification_state = 'discrepancy'").get(item.id) as { n: number }).n;
  const identityClar = (
    db
      .prepare("SELECT COUNT(*) n FROM clarification WHERE category = 'identity_conflict' AND state NOT IN ('resolved','canceled') AND intake_item_id = ?")
      .get(item.id) as { n: number }
  ).n;
  if (identityFields.length || identityClar) reasons.push("Identity conflict");
  if (otherFields.length) reasons.push(`Discrepancy: ${otherFields.map((f) => COMPARE_FIELD_LABEL[f as CompareField]?.toLowerCase() ?? f).join(", ")}`);
  else if (discContainers && !identityFields.length && !identityClar) reasons.push("Discrepancy recorded");
  if (disc.some((d) => d.kind === "missing_container")) reasons.push("Missing container");
  if (disc.some((d) => d.kind === "extra_container")) reasons.push("Extra container");
  if (disc.some((d) => d.kind === "unmatched_container")) reasons.push("Container not matched to a part");
  if (disc.some((d) => d.kind === "order_not_linked")) reasons.push("No order linked");
  // The source sent other patient or order-level details for a linked order: accession waits for a lead's review.
  const linked = db
    .prepare("SELECT so.id, so.patient_ref_id FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id WHERE l.intake_item_id = ?")
    .all(item.id) as { id: string; patient_ref_id: string }[];
  if (linked.some((o) => openSourceConflictsForOrder(db, o).length > 0)) reasons.push("Source conflict");
  const cands = candidatesForIntake(db, item.id);
  if (cands.some((c) => c.status === "pending_review")) reasons.push("Related orders: needs review");
  if (cands.some((c) => c.status === "escalated_to_office")) reasons.push("Related orders: asked the office");
  const holds = activeHolds(db, scopesForIntake(db, item.id));
  for (const h of holds) reasons.push(`Hold ${h.display_id}`);
  return { lane: reasons.length ? "exceptions" : "to_review", reasons };
}

export function intakeQueue(db: DB, now: string): QueueItem[] {
  const staff = staffMap(db);
  const day = labDay(now);
  const rows = db
    .prepare(
      `SELECT ii.*, off.name office_name, cd.display_id delivery_display, a.accession_number
         FROM intake_item ii LEFT JOIN office off ON off.id = ii.office_id LEFT JOIN courier_delivery cd ON cd.id = ii.delivery_id
         LEFT JOIN accession a ON a.id = ii.accession_id
        ORDER BY ii.received_at`,
    )
    .all() as (IntakeItemRow & { office_name: string | null; delivery_display: string | null; accession_number: string | null })[];
  const out: QueueItem[] = [];
  for (const r of rows) {
    const open = r.status !== "accessioned" && r.status !== "canceled";
    if (!open && labDay(r.received_at) !== day) continue;
    const routing = currentRouting(db, r.id);
    const lf = laneFor(db, r, routing);
    const orders = db
      .prepare(
        `SELECT so.source_order_id, pr.family_name, pr.given_name FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id
           JOIN patient_ref pr ON pr.id = so.patient_ref_id WHERE l.intake_item_id = ? ORDER BY so.source_order_id`,
      )
      .all(r.id) as { source_order_id: string; family_name: string; given_name: string }[];
    const cs = db.prepare("SELECT verification_state FROM container WHERE intake_item_id = ?").all(r.id) as { verification_state: string }[];
    let patientName: string | null = orders[0] ? `${orders[0].given_name} ${orders[0].family_name}` : null;
    if (!patientName) {
      const c = db.prepare("SELECT observed_label FROM container WHERE intake_item_id = ? ORDER BY seq LIMIT 1").get(r.id) as { observed_label: string } | undefined;
      const lbl = c ? parseLabel(c) : null;
      patientName = lbl?.patient_name ? `${lbl.patient_name} (as on bottle)` : null;
    }
    const finalId = routing ? routing.final_pathologist_id ?? routing.suggested_pathologist_id : null;
    const p = finalId ? staff.get(finalId) : undefined;
    const cands = candidatesForIntake(db, r.id);
    const cand = cands.find((c) => c.status === "pending_review" || c.status === "escalated_to_office") ?? cands[0] ?? null;
    const relOwner = cand
      ? (db
          .prepare("SELECT owner_id FROM task WHERE status IN ('open','in_progress') AND entity_type = 'related_order_candidate' AND entity_id = ? ORDER BY created_at LIMIT 1")
          .get(cand.id) as { owner_id: string | null } | undefined)
      : undefined;
    const related = cand ? { displayId: cand.display_id, status: cand.status, ownerName: nameOf(staff, relOwner?.owner_id) } : null;
    // Derived, read-only: who the routing exception waits on (named on the queue flag).
    const routingOwner =
      routing?.status === "exception"
        ? (db
            .prepare("SELECT owner_id FROM task WHERE kind = 'routing_exception' AND entity_id = ? AND status IN ('open','in_progress') ORDER BY created_at LIMIT 1")
            .get(r.id) as { owner_id: string | null } | undefined)
        : undefined;
    out.push({
      id: r.id,
      displayId: r.display_id,
      status: r.status,
      lane: lf.lane,
      reasons: lf.reasons,
      officeName: r.office_name ?? r.observed_office_text ?? "Unknown office",
      officeKnown: !!r.office_id,
      patientName,
      orderRefs: orders.map((o) => o.source_order_id),
      containerCount: cs.length,
      verifiedCount: cs.filter((c) => c.verification_state !== "unverified").length,
      accessionNumber: r.accession_number,
      receivedAt: r.received_at,
      deliveryDisplay: r.delivery_display,
      routingStatus: routing?.status ?? null,
      pathologistName: p?.display_name ?? null,
      pathologistColor: p?.color_token ?? null,
      ownerName: nameOf(staff, r.current_owner_id),
      flags: queueFlags(lf.reasons, related, nameOf(staff, routingOwner?.owner_id)),
      related,
    });
  }
  // Exceptions first within the open lanes; newest first in Done.
  return out.sort((a, b) => {
    if (a.lane === "done" && b.lane === "done") return a.receivedAt < b.receivedAt ? 1 : -1;
    return a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.displayId.localeCompare(b.displayId);
  });
}

// ---------------------------------------------------------------- item detail

function routingView(db: DB, staff: Map<string, StaffRow>, r: RoutingDecisionRow): RoutingView {
  const set = r.rule_set_id
    ? (db.prepare("SELECT version, effective_from FROM routing_rule_set WHERE id = ?").get(r.rule_set_id) as { version: number; effective_from: string } | undefined)
    : undefined;
  const person = (id: string | null) => {
    if (!id) return null;
    const s = staff.get(id);
    return { id, name: s?.display_name ?? id, color: s?.color_token ?? null };
  };
  return {
    id: r.id,
    status: r.status,
    suggested: person(r.suggested_pathologist_id),
    final: person(r.final_pathologist_id),
    ruleSetVersion: set?.version ?? null,
    ruleSetEffectiveFrom: set?.effective_from ?? null,
    explanation: r.explanation,
    overrideReason: r.override_reason,
    decidedByName: nameOf(staff, r.decided_by),
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    coverage: !!r.coverage_exception_id,
  };
}

function holdView(staff: Map<string, StaffRow>, h: HoldRow): HoldView {
  const blocks = blockedTransitions(h);
  return {
    id: h.id,
    displayId: h.display_id,
    scopeType: h.scope_type,
    scopeLabel: h.scope_label,
    reasonText: h.reason_text,
    blocks,
    blocksAccession: blocks.includes("all") || blocks.includes("accession_request"),
    clarificationDisplayId: null,
    placedByName: nameOf(staff, h.placed_by),
    placedAt: h.placed_at,
    version: h.version,
  };
}

/**
 * One submission of a related-order candidate, read from its own order, patient
 * reference, encounter, office, clinician, parts and courier delivery. Keyed by
 * the reason and conflict codes of the detection rule (src/server/domain/related.ts),
 * so the lead sees what each record says side by side. Read-only; joins nothing.
 */
function relatedSide(db: DB, orderId: string): RelatedSide {
  const o = db
    .prepare(
      `SELECT so.source_order_id, pr.source_mrn, pr.family_name, pr.given_name, pr.birth_date, e.source_encounter_id enc_src,
              off.name office_name, c.display_name clinician_name
         FROM source_order so
         JOIN patient_ref pr ON pr.id = so.patient_ref_id
         JOIN office off ON off.id = so.office_id
         LEFT JOIN encounter e ON e.id = so.encounter_id
         LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
        WHERE so.id = ?`,
    )
    .get(orderId) as
    | { source_order_id: string; source_mrn: string; family_name: string; given_name: string; birth_date: string; enc_src: string | null; office_name: string; clinician_name: string | null }
    | undefined;
  const parts = db.prepare("SELECT designation, collected_at FROM source_order_part WHERE source_order_id = ? AND status = 'active' ORDER BY designation").all(orderId) as {
    designation: string;
    collected_at: string | null;
  }[];
  const items = intakeItemsForOrder(db, orderId);
  const delivery = items[0]
    ? ((db.prepare("SELECT d.display_id FROM intake_item ii JOIN courier_delivery d ON d.id = ii.delivery_id WHERE ii.id = ?").get(items[0].id) as { display_id: string } | undefined)?.display_id ?? null)
    : null;
  const days = [...new Set(parts.map((p) => (p.collected_at ? labDay(p.collected_at) : null)).filter((d): d is string => !!d))];
  const designations = parts.map((p) => p.designation);
  const values: Record<string, string | null> = o
    ? {
        same_patient_reference: `MRN ${o.source_mrn}`,
        different_patient_reference: `MRN ${o.source_mrn}`,
        same_encounter: o.enc_src,
        encounter_unknown: o.enc_src,
        same_office: o.office_name,
        same_collection_day: days.length ? days.map((d) => fmtDate(`${d}T16:00:00.000Z`)).join(", ") : null,
        collection_unknown: days.length ? days.map((d) => fmtDate(`${d}T16:00:00.000Z`)).join(", ") : null,
        same_clinician: o.clinician_name,
        same_delivery: delivery,
        separate_orders: o.source_order_id,
        designation_clash: designations.length ? `Part ${designations.join(", ")}` : null,
        same_name_dob: `${o.family_name}, ${o.given_name}, ${o.birth_date}`,
      }
    : {};
  return { orderId, sourceOrderId: o?.source_order_id ?? orderId, intakeDisplayId: items[0]?.display_id ?? null, parts: designations, values };
}

export function intakeItemDetail(db: DB, displayIdOrId: string): ItemDetail | null {
  const staff = staffMap(db);
  const item = db.prepare("SELECT * FROM intake_item WHERE display_id = ? OR id = ?").get(displayIdOrId.trim().toUpperCase(), displayIdOrId.trim()) as
    | IntakeItemRow
    | undefined;
  if (!item) return null;

  const delivery = item.delivery_id
    ? (db.prepare("SELECT id, display_id FROM courier_delivery WHERE id = ?").get(item.delivery_id) as { id: string; display_id: string } | undefined)
    : undefined;
  const office = item.office_id
    ? (db
        .prepare("SELECT o.id, o.name, o.status, t.name tenant FROM office o JOIN source_tenant t ON t.id = o.tenant_id WHERE o.id = ?")
        .get(item.office_id) as { id: string; name: string; status: string; tenant: string } | undefined)
    : undefined;
  const acc = item.accession_id
    ? (db.prepare("SELECT id, accession_number, namespace, issued_at, issued_by_system, assigned_pathologist_id FROM accession WHERE id = ?").get(item.accession_id) as
        | { id: string; accession_number: string; namespace: string; issued_at: string; issued_by_system: string; assigned_pathologist_id: string | null }
        | undefined)
    : undefined;

  // Orders (tenant-scoped, with versions and parts; original values as imported).
  const orderRows = db
    .prepare(
      `SELECT so.*, t.name tenant_name, c.display_name clinician_name, c.credential clinician_credential, off.name office_name,
              e.source_encounter_id enc_src, e.encounter_at enc_at, pr.family_name, pr.given_name, pr.birth_date, pr.source_mrn
         FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id JOIN source_tenant t ON t.id = so.tenant_id
         JOIN office off ON off.id = so.office_id JOIN patient_ref pr ON pr.id = so.patient_ref_id
         LEFT JOIN clinician c ON c.id = so.ordering_clinician_id LEFT JOIN encounter e ON e.id = so.encounter_id
        WHERE l.intake_item_id = ? ORDER BY so.source_order_id`,
    )
    .all(item.id) as {
    id: string; source_order_id: string; tenant_name: string; source_version: number; source_status: string; source_updated_at: string; imported_at: string;
    clinician_name: string | null; clinician_credential: string | null; office_name: string; enc_src: string | null; enc_at: string | null; clinical_note: string | null;
    family_name: string; given_name: string; birth_date: string; source_mrn: string; patient_ref_id: string;
  }[];
  const containers = containersFor(db, item.id);
  const orders: OrderView[] = orderRows.map((o) => {
    const parts = db.prepare("SELECT * FROM source_order_part WHERE source_order_id = ? ORDER BY designation").all(o.id) as {
      id: string; designation: string; site_text: string; laterality: string | null; procedure: string | null; collected_at: string | null;
      expected_containers: number | null; requested_stains: string; status: string;
    }[];
    const versions = db
      .prepare("SELECT source_version, source_updated_at, imported_at, change_summary FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC")
      .all(o.id) as { source_version: number; source_updated_at: string; imported_at: string; change_summary: string | null }[];
    return {
      id: o.id,
      sourceOrderId: o.source_order_id,
      tenantName: o.tenant_name,
      sourceVersion: o.source_version,
      sourceStatus: o.source_status,
      sourceUpdatedAt: o.source_updated_at,
      importedAt: o.imported_at,
      clinicianName: o.clinician_name,
      clinicianCredential: o.clinician_credential,
      officeName: o.office_name,
      encounter: o.enc_src,
      encounterAt: o.enc_at,
      clinicalNote: o.clinical_note,
      versions: versions.map((v) => ({ version: v.source_version, updatedAt: v.source_updated_at, importedAt: v.imported_at, changeSummary: v.change_summary })),
      parts: parts
        .filter((p) => p.status === "active")
        .map((p) => ({
          id: p.id,
          designation: p.designation,
          siteText: p.site_text,
          laterality: p.laterality,
          procedure: p.procedure,
          collectedAt: p.collected_at,
          expectedContainers: p.expected_containers,
          stains: parseJson<{ stain: string }[]>(p.requested_stains, []).map((s) => s.stain),
          receivedContainers: containers.filter((c) => c.order_part_id === p.id).length,
        })),
    };
  });

  const partInfo = new Map<string, { orderRef: string; designation: string; orderVersion: number }>();
  for (const o of orders) for (const p of o.parts) partInfo.set(p.id, { orderRef: o.sourceOrderId, designation: p.designation, orderVersion: o.sourceVersion });

  const clarRows = db
    .prepare(
      `SELECT * FROM clarification WHERE intake_item_id = ?
          OR container_id IN (SELECT id FROM container WHERE intake_item_id = ?)
          OR order_part_id IN (SELECT sop.id FROM source_order_part sop JOIN intake_order_link l ON l.source_order_id = sop.source_order_id WHERE l.intake_item_id = ?)
          OR source_order_id IN (SELECT source_order_id FROM intake_order_link WHERE intake_item_id = ?)
          OR (? IS NOT NULL AND accession_id = ?)
        ORDER BY created_at DESC`,
    )
    .all(item.id, item.id, item.id, item.id, item.accession_id, item.accession_id) as {
    id: string; display_id: string; category: string; state: string; subject_label: string; question: string; lab_owner_id: string;
    next_follow_up_at: string | null; created_at: string; container_id: string | null; order_part_id: string | null; version: number;
  }[];

  const openDisc = db.prepare("SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND status = 'open' ORDER BY detected_at").all(item.id) as DiscrepancyRow[];

  const containerViews: ContainerView[] = containers.map((c: ContainerRow) => {
    const label = parseLabel(c);
    const last = db
      .prepare("SELECT source_order_version, result, attested_at, attested_by, origin FROM container_verification WHERE container_id = ? ORDER BY attested_at DESC, rowid DESC LIMIT 1")
      .get(c.id) as { source_order_version: number; result: string; attested_at: string; attested_by: string; origin: string } | undefined;
    const info = c.order_part_id ? partInfo.get(c.order_part_id) : undefined;
    const clar = clarRows.find((q) => q.state !== "canceled" && (q.container_id === c.id || (!!c.order_part_id && q.order_part_id === c.order_part_id)));
    const comparison = comparisonForContainer(db, c);
    const mine = openDisc.filter((d) => d.kind === "field_mismatch" && d.container_id === c.id);
    const openMismatches: ContainerView["openMismatches"] = mine.map((d) => {
      const v = mismatchValues(d);
      const row = comparison.find((r) => r.field === d.field);
      const stillDiffers = !!row && row.status === "differs" && d.order_part_id === c.order_part_id;
      return {
        id: d.id,
        version: d.version,
        field: d.field ?? "",
        label: COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field ?? "Field",
        identity: IDENTITY_FIELDS.includes(d.field ?? ""),
        detectedAt: d.detected_at,
        detectedByName: nameOf(staff, d.detected_by),
        order: v.order?.original ?? null,
        observed: v.observed?.original ?? null,
        requisition: v.requisition?.original ?? null,
        orderVersion: typeof v.orderVersion === "number" ? v.orderVersion : null,
        holdReason: stillDiffers ? null : (mismatchHoldReason(db, d, row, info?.orderVersion ?? v.orderVersion ?? 0) ?? "Values now agree; check the container again to close this finding"),
      };
    });
    const acceptedRows = db
      .prepare(
        `SELECT * FROM intake_discrepancy WHERE container_id = ? AND kind = 'field_mismatch' AND status = 'resolved' AND resolution_kind = 'lead_accepted'
          ORDER BY resolved_at DESC, rowid DESC`,
      )
      .all(c.id) as DiscrepancyRow[];
    const acceptedMismatches = [...new Map(acceptedRows.map((d) => [d.field ?? "", d])).values()]
      .filter((d) => !mine.some((m) => m.field === d.field))
      .map((d) => ({
        id: d.id,
        field: d.field ?? "",
        label: COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field ?? "Field",
        byName: nameOf(staff, d.resolved_by),
        at: d.resolved_at,
        reason: d.resolution_note,
      }));
    const observed: Record<string, string | null> = {};
    for (const k of ["patient_name", "birth_date", "mrn", "part_designation", "site_text", "laterality", "procedure", "collection_date"]) {
      const v = (label as Record<string, unknown>)[k];
      observed[k] = v === null || v === undefined || String(v).trim() === "" ? null : String(v);
    }
    return {
      id: c.id,
      seq: c.seq,
      version: c.version,
      observed,
      labelText: labelText({ ...label, raw_text: null }),
      handwritten: !!label.handwritten,
      capture: c.label_capture,
      orderPartId: c.order_part_id,
      orderRef: info?.orderRef ?? null,
      designation: info?.designation ?? null,
      linkBasis: c.link_basis,
      verificationState: c.verification_state,
      verifiedByName: nameOf(staff, c.verified_by),
      verifiedAt: c.verified_at,
      conditionNote: c.condition_note,
      comparison,
      lastVerification: last
        ? { orderVersion: last.source_order_version, result: last.result, at: last.attested_at, byName: nameOf(staff, last.attested_by), origin: last.origin }
        : null,
      currentOrderVersion: info?.orderVersion ?? null,
      orderChangedSinceVerification: !!last && !!info && last.source_order_version !== info.orderVersion && c.verification_state !== "unverified",
      clarification: clar ? { id: clar.id, displayId: clar.display_id, state: clar.state, category: clar.category } : null,
      openMismatchFields: mine.map((d) => d.field ?? ""),
      openMismatches,
      acceptedMismatches,
    };
  });

  const countView = (d: DiscrepancyRow, categories: string[]): MissingPartView => {
    const info = partInfo.get(d.order_part_id!);
    const part = orders.flatMap((o) => o.parts).find((p) => p.id === d.order_part_id);
    const linkedSeqs = containers.filter((c) => c.order_part_id === d.order_part_id).map((c) => c.seq);
    const clar = clarRows.find((q) => q.state !== "canceled" && q.order_part_id === d.order_part_id && categories.includes(q.category));
    return {
      discrepancyId: d.id,
      version: d.version,
      orderPartId: d.order_part_id!,
      orderRef: info?.orderRef ?? "Unknown order",
      designation: info?.designation ?? "?",
      expected: part?.expectedContainers ?? null,
      received: linkedSeqs.length,
      containerSeqs: linkedSeqs,
      clarification: clar ? { displayId: clar.display_id, state: clar.state } : null,
    };
  };
  const missingParts: MissingPartView[] = openDisc.filter((d) => d.kind === "missing_container" && d.order_part_id).map((d) => countView(d, ["missing_container", "other"]));
  const extraParts: MissingPartView[] = openDisc.filter((d) => d.kind === "extra_container" && d.order_part_id).map((d) => countView(d, ["missing_container", "other"]));

  const routing = currentRouting(db, item.id);
  const history = (db.prepare("SELECT * FROM routing_decision WHERE intake_item_id = ? ORDER BY created_at, id").all(item.id) as RoutingDecisionRow[]).filter(
    (r) => r.status === "superseded",
  );

  const tenantOf = new Map((db.prepare("SELECT so.id, so.source_order_id, t.name FROM source_order so JOIN source_tenant t ON t.id = so.tenant_id").all() as { id: string; source_order_id: string; name: string }[]).map((r) => [r.id, r]));
  const related: RelatedView[] = candidatesForIntake(db, item.id).map((c) => {
    const orderIds = [c.order_a_id, c.order_b_id];
    const others = orderIds.flatMap((oid) => intakeItemsForOrder(db, oid)).filter((x) => x.id !== item.id);
    return {
      id: c.id,
      displayId: c.display_id,
      status: c.status,
      version: c.version,
      reasons: parseJson<ReasonItem[]>(c.reasons, []),
      conflicts: parseJson<ReasonItem[]>(c.conflicts, []),
      detectionRule: c.detection_rule,
      duplicateRecordKind: c.detection_rule === DETECTION_RULE_DUPLICATE_RECORD,
      detectedAt: c.detected_at,
      reviewedByName: nameOf(staff, c.reviewed_by),
      reviewedAt: c.reviewed_at,
      decisionReason: c.decision_reason,
      orders: orderIds.map((oid) => ({ id: oid, sourceOrderId: tenantOf.get(oid)?.source_order_id ?? oid, tenantName: tenantOf.get(oid)?.name ?? "Unknown tenant" })),
      otherItems: [...new Map(others.map((o) => [o.id, { id: o.id, displayId: o.display_id, status: o.status }])).values()],
      sides: orderIds.map((oid) => relatedSide(db, oid)),
    };
  });

  const separate = orders.flatMap((o) => separateEncounterOrders(db, o.id));
  const separateUnique = [...new Map(separate.map((s) => [s.orderId, s])).values()].filter((s) => !orders.some((o) => o.id === s.orderId));

  // Holds on the item, its containers and order parts (+ the case once accessioned).
  const scopeHolds = activeHolds(db, scopesForIntake(db, item.id));
  const caseHolds = item.accession_id ? (db.prepare("SELECT * FROM hold WHERE status = 'active' AND accession_id = ?").all(item.accession_id) as HoldRow[]) : [];
  const holdRows = [...new Map([...scopeHolds, ...caseHolds].map((h) => [h.id, h])).values()];
  const holds = holdRows.map((h) => {
    const hv = holdView(staff, h);
    if (h.clarification_id) hv.clarificationDisplayId = (db.prepare("SELECT display_id FROM clarification WHERE id = ?").get(h.clarification_id) as { display_id: string } | undefined)?.display_id ?? null;
    return hv;
  });

  // Source conflicts on a linked order or its patient reference (one review can hold back several orders).
  const conflictMap = new Map<string, SourceConflictView>();
  for (const o of orderRows) {
    for (const t of openSourceConflictsForOrder(db, { id: o.id, patient_ref_id: o.patient_ref_id })) {
      const seen = conflictMap.get(t.id);
      if (seen) {
        if (!seen.orderRefs.includes(o.source_order_id)) seen.orderRefs.push(o.source_order_id);
        continue;
      }
      conflictMap.set(t.id, {
        id: t.id,
        version: t.version,
        about: t.entity_type === "patient_ref" ? "patient" : "order",
        title: t.title,
        detail: t.detail,
        ownerName: nameOf(staff, t.owner_id),
        ownerRole: t.owner_role,
        priority: t.priority,
        createdAt: t.created_at,
        orderRefs: [o.source_order_id],
      });
    }
  }
  const sourceConflicts = [...conflictMap.values()];

  const candIds = related.map((r) => r.id);
  const containerIds = containers.map((c) => c.id);
  const ph = (n: number) => (n ? Array.from({ length: n }, () => "?").join(",") : "''");
  const taskRows = db
    .prepare(
      `SELECT * FROM task WHERE status IN ('open','in_progress') AND (
          intake_item_id = ? OR (entity_type = 'intake_item' AND entity_id = ?)
          OR (entity_type = 'related_order_candidate' AND entity_id IN (${ph(candIds.length)}))
          OR (entity_type = 'container' AND entity_id IN (${ph(containerIds.length)}))
          OR (? IS NOT NULL AND accession_id = ?))
        ORDER BY created_at`,
    )
    .all(item.id, item.id, ...candIds, ...containerIds, item.accession_id, item.accession_id) as {
    id: string; kind: string; title: string; owner_id: string | null; owner_role: string | null; status: string; priority: string; created_at: string; due_at: string | null;
  }[];

  const auditRowsAll = db
    .prepare(
      `SELECT * FROM audit_event WHERE intake_item_id = ?
          OR (entity_type = 'related_order_candidate' AND entity_id IN (${ph(candIds.length)}))
          OR (? IS NOT NULL AND accession_id = ?)
        ORDER BY seq DESC LIMIT 120`,
    )
    .all(item.id, ...candIds, item.accession_id, item.accession_id) as {
    id: string; at: string; actor_id: string | null; actor_role: string | null; origin: string; action: string; summary: string; reason: string | null;
    before_json: string | null; after_json: string | null; entity_type: string; entity_id: string; correlation_id: string | null;
  }[];
  // A related-order decision is audited once per member intake item (so each item's own history has it).
  // Shown on one item, those copies are the same event: list it once.
  const seenCandidateEvents = new Set<string>();
  const auditRows = auditRowsAll.filter((a) => {
    if (a.entity_type !== "related_order_candidate") return true;
    const key = `${a.action}|${a.entity_id}|${a.at}|${a.correlation_id ?? ""}|${a.summary}`;
    if (seenCandidateEvents.has(key)) return false;
    seenCandidateEvents.add(key);
    return true;
  });

  const first = orderRows[0];
  const routingForLane = routing;
  const lf = laneFor(db, item, routingForLane);

  // Readiness: own blockers, plus the approved group (request together). A submitted (unissued) request can be retried.
  const req = latestRequestFor(db, item.id);
  const pendingReqId = req?.status === "submitted" ? req.id : null;
  let group: ItemDetail["readiness"]["group"] = null;
  const approved = related.filter((r) => r.status === "single_accession_approved");
  if (approved.length && item.status !== "accessioned") {
    const ids = new Set<string>([item.id]);
    for (const r of approved) for (const o of r.otherItems) if (o.status !== "accessioned" && o.status !== "canceled") ids.add(o.id);
    if (ids.size > 1) {
      const idList = [...ids];
      const displays = idList.map((i) => (db.prepare("SELECT display_id FROM intake_item WHERE id = ?").get(i) as { display_id: string }).display_id);
      group = { ids: idList, displayIds: displays, candidateId: approved[0].id, blockers: accessionBlockers(db, idList, pendingReqId) };
    }
  }
  const ownBlockers = item.status === "accessioned" ? [] : accessionBlockers(db, [item.id], pendingReqId);
  const corrections = item.accession_id
    ? (db.prepare("SELECT * FROM correction_review WHERE accession_id = ? OR related_accession_id = ? ORDER BY requested_at DESC").all(item.accession_id, item.accession_id) as {
        id: string; display_id: string; kind: string; status: string; description: string; requested_at: string; version: number;
      }[])
    : [];

  const req0 = requisitionFor(db, item.id);
  const reqDoc = db.prepare("SELECT doc_ref FROM requisition_doc WHERE intake_item_id = ? LIMIT 1").get(item.id) as { doc_ref: string } | undefined;

  return {
    id: item.id,
    displayId: item.display_id,
    status: item.status,
    version: item.version,
    notes: item.notes,
    ownerId: item.current_owner_id,
    ownerName: nameOf(staff, item.current_owner_id),
    receivedAt: item.received_at,
    receivedByName: nameOf(staff, item.received_by),
    updatedAt: item.updated_at,
    updatedByName: nameOf(staff, item.updated_by),
    delivery: delivery ? { id: delivery.id, displayId: delivery.display_id } : null,
    office: office ? { id: office.id, name: office.name, status: office.status, tenantName: office.tenant } : null,
    observedOfficeText: item.observed_office_text,
    accession: acc
      ? { id: acc.id, number: acc.accession_number, namespace: acc.namespace, issuedAt: acc.issued_at, issuedBy: acc.issued_by_system, pathologistName: nameOf(staff, acc.assigned_pathologist_id) }
      : null,
    patient: first ? { name: `${first.given_name} ${first.family_name}`, birthDate: first.birth_date, mrn: first.source_mrn, tenantName: first.tenant_name } : null,
    orders,
    requisition: req0 ? { docRef: reqDoc?.doc_ref ?? "Unknown", fields: req0 as Record<string, unknown> } : null,
    containers: containerViews,
    missingParts,
    extraParts,
    openDiscrepancies: openDisc.map((d) => ({
      id: d.id,
      kind: d.kind,
      field: d.field,
      label: d.field ? COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field : d.kind.replace(/_/g, " "),
      containerSeq: d.container_id ? containers.find((c) => c.id === d.container_id)?.seq ?? null : null,
    })),
    routing: routing ? routingView(db, staff, routing) : null,
    routingHistory: history.map((h) => routingView(db, staff, h)),
    related,
    separateEncounters: separateUnique,
    holds,
    sourceConflicts,
    clarifications: clarRows.map((q) => ({
      id: q.id,
      displayId: q.display_id,
      version: q.version,
      noticePreview: q.state === "drafted" ? genericBody("initial", q.display_id).replace(` ${SIMULATED_TAG}`, "") : null,
      category: q.category,
      state: q.state,
      subjectLabel: q.subject_label,
      question: q.question,
      ownerName: nameOf(staff, q.lab_owner_id),
      nextFollowUpAt: q.next_follow_up_at,
      createdAt: q.created_at,
      containerId: q.container_id,
      orderPartId: q.order_part_id,
    })),
    tasks: taskRows.map((t) => ({
      id: t.id, kind: t.kind, title: t.title, ownerName: nameOf(staff, t.owner_id), ownerRole: t.owner_role, status: t.status, priority: t.priority, createdAt: t.created_at, dueAt: t.due_at,
    })),
    audit: auditRows.map((a) => ({
      id: a.id, at: a.at, actorName: nameOf(staff, a.actor_id), actorRole: a.actor_role, origin: a.origin, action: a.action, summary: a.summary, reason: a.reason,
      // A patient reference audited as { id, fingerprint } is shown with the details from the patient record itself (C4).
      before: historyPayload(db, a.before_json), after: historyPayload(db, a.after_json),
    })),
    lane: lf.lane,
    laneReasons: lf.reasons,
    readiness: { ready: ownBlockers.length === 0 && item.status !== "accessioned", blockers: ownBlockers, group },
    latestRequest: req ? { id: req.id, displayId: req.display_id, status: req.status, requestedAt: req.requested_at, failureDetail: req.failure_detail } : null,
    corrections: corrections.map((c) => ({
      id: c.id, displayId: c.display_id, kind: c.kind, kindLabel: CORRECTION_KIND_LABEL[c.kind as keyof typeof CORRECTION_KIND_LABEL] ?? c.kind,
      status: c.status, statusLabel: CORRECTION_STATUS_LABEL[c.status] ?? c.status, description: c.description, requestedAt: c.requested_at, version: c.version,
    })),
  };
}

// ---------------------------------------------------------------- bench

export function intakeBench(db: DB, actor: Actor, opts: { item?: string | null } = {}): IntakeBench {
  const now = readClock(db).now;
  const day = labDay(now);
  const deliveries = deliveriesForDay(db, day);
  const active =
    deliveries.find((d) => d.status === "expected" || d.status === "arrived" || d.status === "reconciling") ?? deliveries[deliveries.length - 1] ?? null;
  const queue = intakeQueue(db, now);
  const counts: Record<Lane, number> = { to_review: 0, exceptions: 0, done: 0 };
  for (const q of queue) counts[q.lane] += 1;
  const src = accessionSourceStatus(db);
  const pathologists = (db.prepare("SELECT id, display_name, short_name, color_token FROM staff WHERE role = 'pathologist' AND active = 1 ORDER BY display_name").all() as {
    id: string; display_name: string; short_name: string; color_token: string | null;
  }[]).map((p) => ({ id: p.id, name: p.display_name, shortName: p.short_name, color: p.color_token }));
  let selected: ItemDetail | null = null;
  let selectedNotFound: string | null = null;
  if (opts.item) {
    selected = intakeItemDetail(db, opts.item);
    if (!selected) selectedNotFound = opts.item;
  }
  const permissions = permissionsFor(actor.role);
  const readOnly = actor.role === "director" || actor.role === "medical_director";
  const siblings = selected ? siblingsOf(db, selected) : [];
  const order = openOrder(queue);
  const firstOpen = order[0] ? { displayId: order[0].displayId, patientName: order[0].patientName, reason: order[0].flags[0]?.text ?? null } : null;
  let plan: IntakePlan | null = null;
  if (selected) {
    const at = order.findIndex((q) => q.id === selected!.id);
    const after = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].find((q) => q.id !== selected!.id) ?? null;
    plan = buildPlan({
      item: selected,
      siblings,
      actor: { id: actor.id, name: actor.name, role: actor.role },
      permissions,
      sourceAvailable: src.available,
      readOnly,
      nextItem: after ? { displayId: after.displayId, patientName: after.patientName } : null,
    });
  }
  return {
    now,
    demoDay: day,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    permissions,
    source: { available: src.available, status: src.status, name: src.name, lastSuccessAt: src.lastSuccessAt },
    deliveries,
    activeDeliveryId: active?.id ?? null,
    queue,
    counts,
    pathologists,
    selected,
    selectedNotFound,
    readOnly,
    assistantMode: assistantMode(db),
    siblings,
    plan,
    firstOpen,
  };
}

/** Possibly related items of `item`, summarized for the hold scope line and the A | B plates (context only, never merged). */
export function siblingsOf(db: DB, item: ItemDetail): SiblingView[] {
  const ids = [...new Set(item.related.flatMap((r) => r.otherItems.map((o) => o.displayId)))].filter((d) => d !== item.displayId);
  const out: SiblingView[] = [];
  for (const displayId of ids) {
    const d = intakeItemDetail(db, displayId);
    if (!d) continue;
    const c = d.containers[0];
    const part = c?.orderPartId ? d.orders.flatMap((o) => o.parts).find((p) => p.id === c.orderPartId) : d.orders[0]?.parts[0];
    const states = d.containers.map((x) => x.verificationState);
    out.push({
      id: d.id,
      displayId: d.displayId,
      status: d.status,
      part: partsOf(d).join(" ") || null,
      orderRef: d.orders[0]?.sourceOrderId ?? null,
      site: part?.siteText ?? null,
      procedure: part?.procedure ?? null,
      verification: !states.length ? "none" : states.includes("unverified") ? "unverified" : states.includes("discrepancy") ? "discrepancy" : "verified",
      differing: [...new Set(d.containers.flatMap((x) => x.comparison.filter((r) => r.status === "differs").map((r) => r.label)))],
      holds: d.holds.map((h) => ({ displayId: h.displayId, scopeType: h.scopeType, scopeLabel: h.scopeLabel, blocks: h.blocks, blocksAccession: h.blocksAccession })),
      accession: d.accession?.number ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- scan resolution

export type IntakeScanResolution =
  | { kind: "item"; displayId: string; message: string }
  | { kind: "items"; matches: { displayId: string; label: string }[]; message: string }
  | { kind: "case"; accession: string; message: string }
  | { kind: "unpack"; deliveryId: string; deliveryDisplay: string; orderRef: string; physicalItemId: string; message: string }
  | { kind: "none"; message: string };

/**
 * What a scan or typed value means on the intake bench. A scan IDENTIFIES a
 * record; it never verifies a container. Order ids are tenant-scoped, so an
 * order id that exists in two tenants returns both matches for the person to choose.
 */
export function resolveIntakeScan(db: DB, raw: string): IntakeScanResolution {
  const text = raw.trim();
  const up = text.toUpperCase();
  if (!text) return { kind: "none", message: "Scan or type an order id, intake id or bottle label text." };

  if (/^INT-\d{4}-\d{3}$/.test(up)) {
    const it = db.prepare("SELECT display_id FROM intake_item WHERE display_id = ?").get(up) as { display_id: string } | undefined;
    return it ? { kind: "item", displayId: it.display_id, message: `Matched provisional intake item ${it.display_id}.` } : { kind: "none", message: `No intake item ${up}.` };
  }
  if (/^D\d{2}-\d{5}/.test(up)) {
    const num = up.slice(0, 9);
    const acc = db.prepare("SELECT accession_number FROM accession WHERE accession_number = ?").get(num) as { accession_number: string } | undefined;
    return acc
      ? { kind: "case", accession: acc.accession_number, message: `${acc.accession_number} is an issued accession. Opening the case.` }
      : { kind: "none", message: `No accession ${num} is on record in this lab. Check the label; an accession number is issued only by the source system.` };
  }

  // Order id printed on a requisition (tenant-scoped: may exist in more than one tenant).
  const byOrder = db
    .prepare(
      `SELECT ii.display_id, so.source_order_id, t.name tenant FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id
         JOIN source_order so ON so.id = l.source_order_id JOIN source_tenant t ON t.id = so.tenant_id
        WHERE upper(so.source_order_id) = ? AND ii.status <> 'canceled' ORDER BY ii.received_at DESC`,
    )
    .all(up) as { display_id: string; source_order_id: string; tenant: string }[];
  if (byOrder.length === 1) return { kind: "item", displayId: byOrder[0].display_id, message: `Matched ${byOrder[0].source_order_id} (${byOrder[0].tenant}) → ${byOrder[0].display_id}.` };
  if (byOrder.length > 1) {
    return {
      kind: "items",
      matches: byOrder.map((b) => ({ displayId: b.display_id, label: `${b.source_order_id} · ${b.tenant}` })),
      message: `${up} matches ${byOrder.length} intake items. Order ids are unique only within a tenant; choose one.`,
    };
  }
  const unpacked = db
    .prepare(
      `SELECT sp.id, sp.delivery_id, sp.requisition_order_ref, cd.display_id FROM sim_physical_item sp JOIN courier_delivery cd ON cd.id = sp.delivery_id
        WHERE upper(sp.requisition_order_ref) = ? AND sp.received_intake_item_id IS NULL ORDER BY cd.expected_at DESC LIMIT 1`,
    )
    .get(up) as { id: string; delivery_id: string; requisition_order_ref: string; display_id: string } | undefined;
  if (unpacked) {
    return {
      kind: "unpack",
      deliveryId: unpacked.delivery_id,
      deliveryDisplay: unpacked.display_id,
      orderRef: unpacked.requisition_order_ref,
      physicalItemId: unpacked.id,
      message: `${unpacked.requisition_order_ref} is in courier ${unpacked.display_id} and not unpacked yet.`,
    };
  }

  // Bottle label text (typed observation): match on the label as it reads (values only, never the stored field names).
  if (text.length >= 4) {
    const needle = text.toLowerCase().replace(/\s+/g, " ");
    const rows = db
      .prepare(
        `SELECT ii.display_id, c.seq, c.observed_label FROM container c JOIN intake_item ii ON ii.id = c.intake_item_id
          WHERE ii.status <> 'canceled' ORDER BY ii.received_at DESC LIMIT 400`,
      )
      .all() as { display_id: string; seq: number; observed_label: string }[];
    const hits = rows.filter((r) => {
      const lbl = parseLabel(r);
      const values = [labelText({ ...lbl, raw_text: null }), ...Object.values(lbl).filter((v): v is string => typeof v === "string")];
      return values.some((v) => v.toLowerCase().replace(/\s+/g, " ").includes(needle));
    });
    const uniq = [...new Map(hits.map((r) => [r.display_id, r])).values()].slice(0, 12);
    if (uniq.length === 1) return { kind: "item", displayId: uniq[0].display_id, message: `Bottle label text matched ${uniq[0].display_id} container ${uniq[0].seq}.` };
    if (uniq.length > 1) {
      return {
        kind: "items",
        matches: uniq.map((r) => ({ displayId: r.display_id, label: labelText(parseLabel(r)) })),
        message: `"${text}" matches ${uniq.length} intake items. Choose one.`,
      };
    }
  }
  return { kind: "none", message: `No matching order or intake item for "${text}". Check the label, or unpack it from the courier manifest.` };
}

export { COMPARE_FIELD_LABEL };
