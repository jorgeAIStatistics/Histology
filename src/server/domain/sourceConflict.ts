import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { audit } from "../core/audit";
import { updateVersioned } from "../core/versioning";
import { auditedPatientRef } from "./privacy";

/**
 * Source conflicts on patient and order-level details (S6 import).
 *
 * When the simulated source sends an order whose patient details differ from
 * the patient reference on file for that MRN, or a newer version of an order
 * changes its patient, office or encounter, the importer keeps what is on file
 * and opens ONE `source_conflict` review task (src/server/domain/sourceImport.ts).
 *
 * - An open conflict on the order's patient reference, or on the order itself,
 *   blocks accession (accessionBlockers, code `source_conflict_open`).
 * - The only decision recorded here is `details_on_file_confirmed`: a lead
 *   checked and the details on file stand. The task closes with an audit row
 *   (before/after and the reason). The patient reference, the order and its
 *   link are never changed: nothing is merged, relinked or overwritten.
 * - Any other outcome (the details on file are wrong, the order belongs to a
 *   different patient) is a patient identity question for the office: raise an
 *   identity clarification (existing flow). This module never decides identity.
 */

export const SOURCE_CONFLICT_DECISIONS = ["details_on_file_confirmed"] as const;
export type SourceConflictDecision = (typeof SOURCE_CONFLICT_DECISIONS)[number];

/** Entity types whose source conflicts are about the patient or the order (and gate accession). */
const GATED_ENTITY_TYPES = ["patient_ref", "source_order"] as const;

export interface SourceConflictTaskRow {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  title: string;
  owner_id: string | null;
  owner_role: string | null;
  status: string;
  priority: string;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
  accession_id: string | null;
  intake_item_id: string | null;
  detail: string | null;
  version: number;
}

/** Open source-conflict tasks on this order or on its patient reference (oldest first). */
export function openSourceConflictsForOrder(db: DB, order: { id: string; patient_ref_id: string }): SourceConflictTaskRow[] {
  return db
    .prepare(
      `SELECT * FROM task WHERE kind = 'source_conflict' AND status IN ('open','in_progress')
          AND ((entity_type = 'patient_ref' AND entity_id = ?) OR (entity_type = 'source_order' AND entity_id = ?))
        ORDER BY created_at, id`,
    )
    .all(order.patient_ref_id, order.id) as SourceConflictTaskRow[];
}

/**
 * The patient reference as the audit trail records it (C4: no name, birth date or MRN in audit payloads):
 * its id and an HMAC fingerprint of its details (src/server/domain/privacy.ts). Equal fingerprints before
 * and after prove the details on file did not change; the values stay in patient_ref.
 */
function patientSnapshot(db: DB, patientRefId: string) {
  return auditedPatientRef(db, patientRefId);
}

/** The details on file, compared in memory only (never written to the audit trail). */
function patientDetails(db: DB, patientRefId: string): string | null {
  const row = db.prepare("SELECT id, tenant_id, source_mrn, family_name, given_name, birth_date FROM patient_ref WHERE id = ?").get(patientRefId);
  return row ? JSON.stringify(row) : null;
}

export interface ReviewSourceConflictResult {
  taskId: string;
  status: "done";
  version: number;
  decision: SourceConflictDecision;
  patientRefId: string | null;
  sourceOrderIds: string[];
  message: string;
}

/**
 * A lead records that the details on file stand for a source conflict about a
 * patient or an order. Closes the review task; changes nothing else.
 */
export function reviewSourceConflict(
  ctx: Ctx,
  input: { taskId: string; expectedVersion: number; decision: SourceConflictDecision; reason: string },
): ReviewSourceConflictResult {
  const db = ctx.db;
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required: say what you checked and why the details on file stand.");
  if (!(SOURCE_CONFLICT_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new DomainError("VALIDATION", `Unknown decision "${input.decision}"`);
  }
  const task = db.prepare("SELECT * FROM task WHERE id = ?").get(input.taskId) as SourceConflictTaskRow | undefined;
  if (!task) throw new DomainError("NOT_FOUND", "Source-conflict task was not found");
  if (task.kind !== "source_conflict" || !(GATED_ENTITY_TYPES as readonly string[]).includes(task.entity_type)) {
    throw new DomainError(
      "VALIDATION",
      "This review is for source conflicts about a patient or an order. Other source reviews (new office, re-sent message) are handled where they are listed.",
    );
  }
  if (task.version !== input.expectedVersion) {
    throw new DomainError(
      "CONFLICT",
      `This source-conflict review changed since you opened it (you had version ${input.expectedVersion}, current is ${task.version}). Review the latest version first.`,
      { table: "task", id: task.id, expectedVersion: input.expectedVersion, currentVersion: task.version, current: task },
    );
  }
  if (task.status !== "open" && task.status !== "in_progress") {
    throw new DomainError("INVARIANT", `This source-conflict review is already ${task.status}. Nothing changed.`);
  }

  // What the review is about: the patient reference (and its orders), or one order (and its patient reference).
  let patientRefId: string | null = null;
  let orders: { id: string; source_order_id: string; patient_ref_id: string }[] = [];
  if (task.entity_type === "patient_ref") {
    patientRefId = task.entity_id;
    orders = db.prepare("SELECT id, source_order_id, patient_ref_id FROM source_order WHERE patient_ref_id = ? ORDER BY source_order_id").all(patientRefId) as typeof orders;
  } else {
    orders = db.prepare("SELECT id, source_order_id, patient_ref_id FROM source_order WHERE id = ?").all(task.entity_id) as typeof orders;
    patientRefId = orders[0]?.patient_ref_id ?? null;
  }
  const before = patientRefId ? patientSnapshot(db, patientRefId) : null;
  const detailsBefore = patientRefId ? patientDetails(db, patientRefId) : null;
  const intakeItemIds = orders.length
    ? (db
        .prepare(`SELECT DISTINCT intake_item_id id FROM intake_order_link WHERE source_order_id IN (${orders.map(() => "?").join(",")}) ORDER BY intake_item_id`)
        .all(...orders.map((o) => o.id)) as { id: string }[]).map((r) => r.id)
    : [];

  const updated = updateVersioned(db, "task", task.id, input.expectedVersion, {
    status: "done",
    completed_at: ctx.now,
    completed_by: ctx.actor.id,
  }) as unknown as SourceConflictTaskRow;

  // The patient reference is never touched by this review; the audit shows it is unchanged.
  const after = patientRefId ? patientSnapshot(db, patientRefId) : null;
  const detailsAfter = patientRefId ? patientDetails(db, patientRefId) : null;
  const orderList = orders.map((o) => o.source_order_id).join(", ") || "the order";
  // One row per intake item the conflict held, so every affected item's History shows who reviewed it and why
  // (a patient-level conflict can hold several items: each one's accession was blocked by it).
  const historyItems: (string | null)[] = task.intake_item_id ? [task.intake_item_id] : intakeItemIds.length ? intakeItemIds : [null];
  for (const intakeItemId of historyItems) audit(ctx, {
    action: "source_conflict.reviewed",
    entityType: "task",
    entityId: task.id,
    accessionId: task.accession_id,
    intakeItemId,
    summary: `${ctx.actor.name} reviewed the source conflict on ${orderList}: details on file confirmed. The patient reference and the order link were not changed; nothing was merged.`,
    reason,
    // The task title quotes the differing details; the audit keeps the task's id and kind (the title stays on the task record).
    before: { task: { status: task.status, version: task.version, entityType: task.entity_type, entityId: task.entity_id, kind: task.kind }, patientRef: before },
    after: {
      task: { status: "done", version: updated.version },
      decision: input.decision,
      patientRef: after,
      patientRefUnchanged: detailsBefore === detailsAfter && before?.fingerprint === after?.fingerprint,
      sourceOrders: orders.map((o) => ({ id: o.id, sourceOrderId: o.source_order_id })),
      intakeItemIds,
    },
  });
  return {
    taskId: task.id,
    status: "done",
    version: updated.version,
    decision: input.decision,
    patientRefId,
    sourceOrderIds: orders.map((o) => o.id),
    message: `Source conflict reviewed: details on file confirmed for ${orderList}. Nothing was merged or changed.`,
  };
}
