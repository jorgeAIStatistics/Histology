import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { openTask, closeTasks } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { labDay, fmtDate } from "@/lib/time";

/**
 * Related-order candidates (SM-5). Detection only PROPOSES a review; it never
 * links, merges or combines orders or patients.
 *
 * Proposed when two not-yet-accessioned orders on the bench share:
 *   - the same source-scoped patient reference (same tenant + MRN; INV-1/2),
 *   - the same encounter (or the encounter is unknown on one side),
 *   - the same office,
 *   - the same collection day.
 * A different encounter for the same patient is NOT proposed (INV-4); the
 * bench shows it as "other orders for this patient — separate encounter".
 * Different tenants are never compared, so an identical MRN in another tenant
 * can never match.
 * A different patient reference with the same name + birth date + office is
 * proposed as a possible duplicate patient record; it can be reviewed but can
 * never be approved as one accession inside this app.
 */

export const DETECTION_RULE_SAME_PATIENT = "same_patient_reference: same tenant patient + encounter + office + collection day (v1)";
export const DETECTION_RULE_DUPLICATE_RECORD = "possible_duplicate_patient_record: different patient reference, same name + birth date + office (v1)";

export interface ReasonItem {
  code: string;
  label: string;
  detail: string;
}

export interface CandidateRow {
  id: string;
  display_id: string;
  order_a_id: string;
  order_b_id: string;
  reasons: string;
  conflicts: string;
  detection_rule: string;
  status: "pending_review" | "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";
  detected_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_reason: string | null;
  version: number;
}

interface OrderFacts {
  id: string;
  tenant_id: string;
  source_order_id: string;
  patient_ref_id: string;
  encounter_id: string | null;
  enc_src: string | null;
  office_id: string;
  office_name: string;
  ordering_clinician_id: string | null;
  clinician_name: string | null;
  family_name: string;
  given_name: string;
  birth_date: string;
  source_mrn: string;
  tenant_name: string;
  intake_item_id: string;
  intake_display: string;
  delivery_id: string | null;
  designations: string[];
  collectionDays: string[];
}

function orderFacts(db: DB, orderId: string, intakeItemId: string): OrderFacts | null {
  const o = db
    .prepare(
      `SELECT so.id, so.tenant_id, so.source_order_id, so.patient_ref_id, so.encounter_id, e.source_encounter_id enc_src, so.office_id,
              off.name office_name, so.ordering_clinician_id, c.display_name clinician_name, pr.family_name, pr.given_name, pr.birth_date,
              pr.source_mrn, t.name tenant_name, ii.id intake_item_id, ii.display_id intake_display, ii.delivery_id
         FROM source_order so
         JOIN patient_ref pr ON pr.id = so.patient_ref_id
         JOIN source_tenant t ON t.id = so.tenant_id
         JOIN office off ON off.id = so.office_id
         LEFT JOIN encounter e ON e.id = so.encounter_id
         LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
         JOIN intake_item ii ON ii.id = ?
        WHERE so.id = ?`,
    )
    .get(intakeItemId, orderId) as Omit<OrderFacts, "designations" | "collectionDays"> | undefined;
  if (!o) return null;
  const parts = db.prepare("SELECT designation, collected_at FROM source_order_part WHERE source_order_id = ? AND status = 'active'").all(orderId) as {
    designation: string;
    collected_at: string | null;
  }[];
  return {
    ...o,
    designations: parts.map((p) => p.designation),
    collectionDays: [...new Set(parts.map((p) => (p.collected_at ? labDay(p.collected_at) : null)).filter((d): d is string => !!d))],
  };
}

/** Orders on the bench (linked to an intake item that is not accessioned or canceled). */
function benchOrders(db: DB, excludeIntakeItemId: string): { orderId: string; intakeItemId: string }[] {
  return db
    .prepare(
      `SELECT l.source_order_id orderId, l.intake_item_id intakeItemId FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id
        WHERE ii.status NOT IN ('accessioned','canceled') AND ii.id <> ?`,
    )
    .all(excludeIntakeItemId) as { orderId: string; intakeItemId: string }[];
}

export interface PairAssessment {
  propose: boolean;
  rule: string | null;
  reasons: ReasonItem[];
  conflicts: ReasonItem[];
  /** Same patient, different encounter: shown separately, never proposed. */
  separateEncounter: boolean;
}

/** Pure assessment of two orders (no writes). */
export function assessPair(a: OrderFacts, b: OrderFacts): PairAssessment {
  const reasons: ReasonItem[] = [];
  const conflicts: ReasonItem[] = [];
  const notProposed = (separateEncounter = false): PairAssessment => ({ propose: false, rule: null, reasons, conflicts, separateEncounter });
  if (a.tenant_id !== b.tenant_id) return notProposed(); // identifiers are only comparable within one tenant

  const sameOffice = a.office_id === b.office_id;
  const sharedDay = a.collectionDays.find((d) => b.collectionDays.includes(d)) ?? null;

  if (a.patient_ref_id === b.patient_ref_id) {
    reasons.push({ code: "same_patient_reference", label: "Same source-scoped patient reference", detail: `MRN ${a.source_mrn} in ${a.tenant_name}` });
    const bothKnown = !!a.encounter_id && !!b.encounter_id;
    if (bothKnown && a.encounter_id !== b.encounter_id) {
      // Two legitimate encounters for one patient stay separate (not proposed).
      return notProposed(true);
    }
    if (bothKnown) reasons.push({ code: "same_encounter", label: "Same encounter", detail: a.enc_src ?? a.encounter_id! });
    else conflicts.push({ code: "encounter_unknown", label: "Encounter unknown", detail: `Encounter not stated on ${!a.encounter_id ? a.source_order_id : b.source_order_id}` });
    if (!sameOffice) return notProposed();
    reasons.push({ code: "same_office", label: "Same submitting office", detail: a.office_name });
    if (!sharedDay) {
      if (!a.collectionDays.length || !b.collectionDays.length) {
        conflicts.push({ code: "collection_unknown", label: "Collection date unknown", detail: "Collection date missing on at least one order" });
      } else return notProposed();
    } else reasons.push({ code: "same_collection_day", label: "Same collection date", detail: fmtDate(`${sharedDay}T16:00:00.000Z`) });
    if (a.ordering_clinician_id && a.ordering_clinician_id === b.ordering_clinician_id) {
      reasons.push({ code: "same_clinician", label: "Same ordering clinician", detail: a.clinician_name ?? "" });
    }
    if (a.delivery_id && a.delivery_id === b.delivery_id) reasons.push({ code: "same_delivery", label: "Same courier delivery", detail: "" });
    conflicts.push({
      code: "separate_orders",
      label: "Separate source orders",
      detail: `${a.source_order_id} and ${b.source_order_id} stay separate source records (both kept)`,
    });
    const clash = a.designations.filter((d) => b.designations.includes(d));
    if (clash.length) {
      conflicts.push({ code: "designation_clash", label: "Clashing part designations", detail: `Both orders use part ${clash.join(", ")}` });
    }
    return { propose: true, rule: DETECTION_RULE_SAME_PATIENT, reasons, conflicts, separateEncounter: false };
  }

  // Different patient references in the same tenant: only a possible duplicate record, never a link.
  const nameA = `${a.family_name} ${a.given_name}`.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const nameB = `${b.family_name} ${b.given_name}`.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (nameA === nameB && a.birth_date === b.birth_date && sameOffice) {
    reasons.push({ code: "same_name_dob", label: "Same name and birth date", detail: "Name and birth date are never keys" });
    reasons.push({ code: "same_office", label: "Same submitting office", detail: a.office_name });
    conflicts.push({ code: "different_patient_reference", label: "Different patient references", detail: `MRN ${a.source_mrn} vs MRN ${b.source_mrn} (${a.tenant_name})` });
    return { propose: true, rule: DETECTION_RULE_DUPLICATE_RECORD, reasons, conflicts, separateEncounter: false };
  }
  return notProposed();
}

function leadOwner(db: DB): string | null {
  const r = db.prepare("SELECT id FROM staff WHERE role = 'accessioning_lead' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * Run detection for one intake item's linked orders against other orders on
 * the bench. Idempotent: an existing candidate for the same pair is reused
 * (UNIQUE(order_a_id, order_b_id)).
 */
export function detectRelatedForIntake(ctx: Ctx, intakeItemId: string): CandidateRow[] {
  const db = ctx.db;
  const own = db.prepare("SELECT source_order_id FROM intake_order_link WHERE intake_item_id = ?").all(intakeItemId) as { source_order_id: string }[];
  const created: CandidateRow[] = [];
  const others = benchOrders(db, intakeItemId);
  for (const { source_order_id: mine } of own) {
    const a = orderFacts(db, mine, intakeItemId);
    if (!a) continue;
    for (const o of others) {
      if (o.orderId === mine) continue;
      const b = orderFacts(db, o.orderId, o.intakeItemId);
      if (!b) continue;
      const res = assessPair(a, b);
      if (!res.propose || !res.rule) continue;
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const existing = db.prepare("SELECT * FROM related_order_candidate WHERE order_a_id = ? AND order_b_id = ?").get(x, y) as CandidateRow | undefined;
      if (existing) continue;
      const id = newId(db, "rel");
      const disp = displayId(db, "REL", 4);
      db.prepare(
        `INSERT INTO related_order_candidate (id, display_id, order_a_id, order_b_id, reasons, conflicts, detection_rule, status, detected_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, 1)`,
      ).run(id, disp, x, y, JSON.stringify(res.reasons), JSON.stringify(res.conflicts), res.rule, ctx.now);
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      audit(ctx, {
        action: "related.detected",
        entityType: "related_order_candidate",
        entityId: id,
        intakeItemId,
        summary: `${disp}: possible related orders ${first.source_order_id} (${first.intake_display}) and ${second.source_order_id} (${second.intake_display}). Needs review. Linking does not merge records.`,
        after: { reasons: res.reasons.map((r) => r.label), conflicts: res.conflicts.map((c) => c.label) },
      });
      openTask(ctx, {
        kind: "related_order_review",
        entityType: "related_order_candidate",
        entityId: id,
        title: `Review possible related orders ${disp}: ${first.source_order_id} + ${second.source_order_id}`,
        ownerId: leadOwner(db),
        ownerRole: "accessioning_lead",
        priority: "high",
        intakeItemId,
      });
      created.push(db.prepare("SELECT * FROM related_order_candidate WHERE id = ?").get(id) as CandidateRow);
    }
  }
  return created;
}

/** Candidates touching any order linked to this intake item. */
export function candidatesForIntake(db: DB, intakeItemId: string): CandidateRow[] {
  return db
    .prepare(
      `SELECT DISTINCT c.* FROM related_order_candidate c JOIN intake_order_link l ON l.source_order_id IN (c.order_a_id, c.order_b_id)
        WHERE l.intake_item_id = ? ORDER BY c.detected_at`,
    )
    .all(intakeItemId) as CandidateRow[];
}

/** Intake items (not canceled) that link the given order. */
export function intakeItemsForOrder(db: DB, orderId: string): { id: string; display_id: string; status: string }[] {
  return db
    .prepare(
      `SELECT ii.id, ii.display_id, ii.status FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id
        WHERE l.source_order_id = ? AND ii.status <> 'canceled' ORDER BY ii.received_at`,
    )
    .all(orderId) as { id: string; display_id: string; status: string }[];
}

export type RelatedDecision = "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";

const DECISION_TEXT: Record<RelatedDecision, string> = {
  single_accession_approved: "approved as one accession (parts kept with their original orders; nothing merged)",
  keep_separate: "kept as separate cases",
  not_related: "marked not related",
  escalated_to_office: "escalated to the office for clarification",
};

/** Record a reviewer's decision. Never merges orders or patients. */
export function reviewCandidate(ctx: Ctx, candidateId: string, expectedVersion: number, decision: RelatedDecision, reason: string): CandidateRow {
  const db = ctx.db;
  const c = db.prepare("SELECT * FROM related_order_candidate WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  if (!c) throw new DomainError("NOT_FOUND", "Related-order candidate was not found");
  if (!reason.trim()) throw new DomainError("VALIDATION", "A reason is required for a related-order decision");
  const members = [...intakeItemsForOrder(db, c.order_a_id), ...intakeItemsForOrder(db, c.order_b_id)];
  const accessioned = members.filter((m) => m.status === "accessioned");
  if (accessioned.length) {
    throw new DomainError(
      "INVARIANT",
      `${c.display_id} cannot be changed: ${accessioned.map((m) => m.display_id).join(", ")} is already accessioned. Open a correction review on the case instead.`,
    );
  }
  // A request already sent to the source is not withdrawn locally: the decision it was based on stays until it is issued.
  if (members.length) {
    const ph = members.map(() => "?").join(",");
    const inFlight = db
      .prepare(
        `SELECT DISTINCT ar.display_id FROM accession_request ar JOIN accession_request_item ai ON ai.request_id = ar.id
          WHERE ar.status = 'submitted' AND ai.intake_item_id IN (${ph})`,
      )
      .all(...members.map((m) => m.id)) as { display_id: string }[];
    if (inFlight.length) {
      throw new DomainError(
        "BLOCKED",
        `${c.display_id} cannot be changed while accession request ${inFlight.map((r) => r.display_id).join(", ")} is waiting for the simulated source. Retry that request when the source is back; after issue, a post-accession question goes to a correction review.`,
      );
    }
  }
  if (decision === "single_accession_approved" && c.detection_rule === DETECTION_RULE_DUPLICATE_RECORD) {
    throw new DomainError(
      "INVARIANT",
      `${c.display_id} involves two different patient references. This app never joins different patient records; keep them separate or ask the office.`,
    );
  }
  const before = { status: c.status, version: c.version };
  const updated = updateVersioned(db, "related_order_candidate", candidateId, expectedVersion, {
    status: decision,
    reviewed_by: ctx.actor.id,
    reviewed_at: ctx.now,
    decision_reason: reason.trim(),
  }) as unknown as CandidateRow;
  closeTasks(ctx, "related_order_review", "related_order_candidate", candidateId);
  const orders = db.prepare("SELECT id, source_order_id FROM source_order WHERE id IN (?, ?)").all(c.order_a_id, c.order_b_id) as { id: string; source_order_id: string }[];
  const refs = orders.map((o) => o.source_order_id).join(" + ");
  for (const m of members) {
    audit(ctx, {
      action: "related.reviewed",
      entityType: "related_order_candidate",
      entityId: candidateId,
      intakeItemId: m.id,
      summary: `${c.display_id} (${refs}) ${DECISION_TEXT[decision]} by ${ctx.actor.name}. Both source orders are preserved.`,
      before,
      after: { status: decision },
      reason: reason.trim(),
    });
  }
  return updated;
}

/** Other orders for the same tenant-scoped patient that were NOT proposed because the encounter differs. */
export function separateEncounterOrders(db: DB, orderId: string): {
  orderId: string;
  sourceOrderId: string;
  encounter: string | null;
  encounterAt: string | null;
  officeName: string;
  accessionNumber: string | null;
  intakeDisplay: string | null;
  status: string;
}[] {
  const o = db.prepare("SELECT patient_ref_id, encounter_id, tenant_id FROM source_order WHERE id = ?").get(orderId) as
    | { patient_ref_id: string; encounter_id: string | null; tenant_id: string }
    | undefined;
  if (!o) return [];
  const rows = db
    .prepare(
      `SELECT so.id orderId, so.source_order_id sourceOrderId, e.source_encounter_id encounter, e.encounter_at encounterAt, off.name officeName,
              so.source_status status,
              (SELECT a.accession_number FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.source_order_id = so.id LIMIT 1) accessionNumber,
              (SELECT ii.display_id FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id WHERE l.source_order_id = so.id ORDER BY ii.received_at DESC LIMIT 1) intakeDisplay
         FROM source_order so JOIN office off ON off.id = so.office_id LEFT JOIN encounter e ON e.id = so.encounter_id
        WHERE so.patient_ref_id = ? AND so.tenant_id = ? AND so.id <> ?
          AND so.encounter_id IS NOT NULL AND ? IS NOT NULL AND so.encounter_id <> ?
        ORDER BY e.encounter_at DESC`,
    )
    .all(o.patient_ref_id, o.tenant_id, orderId, o.encounter_id, o.encounter_id) as {
    orderId: string;
    sourceOrderId: string;
    encounter: string | null;
    encounterAt: string | null;
    officeName: string;
    accessionNumber: string | null;
    intakeDisplay: string | null;
    status: string;
  }[];
  return rows;
}
