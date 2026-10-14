import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { closeTasks, openTask } from "../core/tasks";
import { updateVersioned } from "../core/versioning";

/**
 * Post-accession discrepancy → correction review (SM-10).
 *
 * The app keeps a review / cross-reference record with a snapshot of every
 * original reference (accession number, namespace, parts, source orders,
 * printed label payloads). It NEVER renumbers, merges, splits, moves parts or
 * relabels material: the issued number is protected by a database trigger, and
 * any authorized correction happens in the authoritative system through its
 * own process. There is no correction endpoint to the (simulated) source.
 */

export const CORRECTION_KINDS = ["possible_duplicate_case", "site_discrepancy", "identity_discrepancy", "part_designation", "related_case"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const CORRECTION_KIND_LABEL: Record<CorrectionKind, string> = {
  possible_duplicate_case: "Possible duplicate case",
  site_discrepancy: "Site or laterality discrepancy",
  identity_discrepancy: "Patient identity discrepancy",
  part_designation: "Part designation question",
  related_case: "Related case (cross-reference)",
};

export const CORRECTION_OUTCOMES = ["referred_to_source_process", "closed_no_change", "closed_corrected_in_source"] as const;
export type CorrectionOutcome = (typeof CORRECTION_OUTCOMES)[number];

export const CORRECTION_STATUS_LABEL: Record<string, string> = {
  open: "Open — under review",
  referred_to_source_process: "Referred to the source system's correction process",
  closed_no_change: "Closed — no change needed",
  closed_corrected_in_source: "Closed — corrected in the source system",
};

export interface CorrectionRow {
  id: string;
  display_id: string;
  accession_id: string;
  kind: CorrectionKind;
  related_accession_id: string | null;
  original_refs: string;
  description: string;
  requested_by: string;
  requested_at: string;
  status: string;
  outcome_note: string | null;
  closed_by: string | null;
  closed_at: string | null;
  version: number;
}

/** Snapshot of every identifier as it stands now, so nothing later can silently change what was referenced. */
export function snapshotRefs(db: DB, accessionId: string): Record<string, unknown> {
  const a = db
    .prepare(
      `SELECT a.accession_number, a.namespace, a.source_case_id, a.issued_at, a.issued_by_system, pr.source_mrn, t.name tenant, a.assigned_pathologist_id
         FROM accession a JOIN patient_ref pr ON pr.id = a.patient_ref_id JOIN source_tenant t ON t.id = pr.tenant_id WHERE a.id = ?`,
    )
    .get(accessionId) as Record<string, unknown> | undefined;
  if (!a) throw new DomainError("NOT_FOUND", "Accession was not found");
  const parts = db
    .prepare(
      `SELECT sp.designation, sp.original_designation, so.source_order_id, so.source_version, sp.site_text, sp.laterality, sp.procedure
         FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id WHERE sp.accession_id = ? ORDER BY sp.designation`,
    )
    .all(accessionId);
  const blocks = db.prepare("SELECT label_text, identifier FROM block WHERE accession_id = ? ORDER BY label_text").all(accessionId);
  const slides = db.prepare("SELECT identifier, stain, label_state FROM slide WHERE accession_id = ? ORDER BY identifier").all(accessionId);
  const labels = db
    .prepare(
      `SELECT l.payload, l.state FROM label l WHERE (l.target_type = 'slide' AND l.target_id IN (SELECT id FROM slide WHERE accession_id = ?))
          OR (l.target_type = 'block' AND l.target_id IN (SELECT id FROM block WHERE accession_id = ?)) ORDER BY l.payload`,
    )
    .all(accessionId, accessionId);
  const intake = db.prepare("SELECT display_id FROM intake_item WHERE accession_id = ? ORDER BY display_id").all(accessionId);
  return { accession: a, parts, blocks, slides, labels, intakeItems: intake, capturedFor: "correction review (original references kept)" };
}

function leadOwner(db: DB): string | null {
  const r = db.prepare("SELECT id FROM staff WHERE role = 'accessioning_lead' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function openCorrection(
  ctx: Ctx,
  input: { accessionId: string; kind: CorrectionKind; description: string; relatedAccessionId?: string | null },
): { correction: CorrectionRow; duplicate: boolean } {
  const db = ctx.db;
  const acc = db.prepare("SELECT id, accession_number, assigned_pathologist_id FROM accession WHERE id = ?").get(input.accessionId) as
    | { id: string; accession_number: string; assigned_pathologist_id: string | null }
    | undefined;
  if (!acc) throw new DomainError("NOT_FOUND", "Accession was not found");
  if (!input.description.trim()) throw new DomainError("VALIDATION", "Describe the discrepancy");
  let related: { id: string; accession_number: string } | undefined;
  if (input.relatedAccessionId) {
    if (input.relatedAccessionId === input.accessionId) throw new DomainError("VALIDATION", "A case cannot be cross-referenced to itself");
    related = db.prepare("SELECT id, accession_number FROM accession WHERE id = ?").get(input.relatedAccessionId) as { id: string; accession_number: string } | undefined;
    if (!related) throw new DomainError("NOT_FOUND", "Related accession was not found");
  }
  const dup = db
    .prepare(
      `SELECT * FROM correction_review WHERE accession_id = ? AND kind = ? AND COALESCE(related_accession_id,'') = COALESCE(?, '')
        AND status IN ('open','referred_to_source_process')`,
    )
    .get(input.accessionId, input.kind, input.relatedAccessionId ?? null) as CorrectionRow | undefined;
  if (dup) return { correction: dup, duplicate: true };

  const refs: Record<string, unknown> = { primary: snapshotRefs(db, input.accessionId) };
  if (related) refs.related = snapshotRefs(db, related.id);
  const id = newId(db, "xr");
  const disp = displayId(db, "XR", 4);
  db.prepare(
    `INSERT INTO correction_review (id, display_id, accession_id, kind, related_accession_id, original_refs, description, requested_by, requested_at, status, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1)`,
  ).run(id, disp, input.accessionId, input.kind, related?.id ?? null, JSON.stringify(refs), input.description.trim(), ctx.actor.id, ctx.now);
  openTask(ctx, {
    kind: "correction_review",
    entityType: "correction_review",
    entityId: id,
    title: `Review ${disp} on ${acc.accession_number}: ${CORRECTION_KIND_LABEL[input.kind]}${related ? ` (with ${related.accession_number})` : ""}`,
    ownerId: leadOwner(db),
    ownerRole: "accessioning_lead",
    priority: "high",
    accessionId: input.accessionId,
  });
  audit(ctx, {
    action: "correction.opened",
    entityType: "correction_review",
    entityId: id,
    accessionId: input.accessionId,
    summary: `${disp} opened on ${acc.accession_number}${related ? ` (cross-reference ${related.accession_number})` : ""}: ${CORRECTION_KIND_LABEL[input.kind]}. Original references snapshotted; nothing renumbered, merged or relabeled.`,
    after: { kind: input.kind, description: input.description.trim() },
  });
  if (related) {
    audit(ctx, {
      action: "correction.cross_referenced",
      entityType: "correction_review",
      entityId: id,
      accessionId: related.id,
      summary: `${related.accession_number} cross-referenced by ${disp} (from ${acc.accession_number}). Both cases unchanged.`,
    });
  }
  recordWorklistChange(ctx, {
    accessionId: input.accessionId,
    pathologistId: acc.assigned_pathologist_id,
    type: "changed",
    summary: `${acc.accession_number}: correction review ${disp} opened (${CORRECTION_KIND_LABEL[input.kind]}); identifiers unchanged`,
  });
  return { correction: db.prepare("SELECT * FROM correction_review WHERE id = ?").get(id) as CorrectionRow, duplicate: false };
}

export function closeCorrection(
  ctx: Ctx,
  input: { correctionId: string; outcome: CorrectionOutcome; note: string; expectedVersion?: number },
): CorrectionRow {
  const db = ctx.db;
  const c = db.prepare("SELECT * FROM correction_review WHERE id = ?").get(input.correctionId) as CorrectionRow | undefined;
  if (!c) throw new DomainError("NOT_FOUND", "Correction review was not found");
  if (c.status === "closed_no_change" || c.status === "closed_corrected_in_source") {
    throw new DomainError("VALIDATION", `${c.display_id} is already closed`);
  }
  if (!input.note.trim()) throw new DomainError("VALIDATION", "A note is required");
  const closing = input.outcome !== "referred_to_source_process";
  const updated = updateVersioned(db, "correction_review", c.id, input.expectedVersion, {
    status: input.outcome,
    outcome_note: input.note.trim(),
    closed_by: closing ? ctx.actor.id : null,
    closed_at: closing ? ctx.now : null,
  }) as unknown as CorrectionRow;
  closeTasks(ctx, "correction_review", "correction_review", c.id);
  const acc = db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(c.accession_id) as { accession_number: string };
  if (!closing) {
    openTask(ctx, {
      kind: "correction_review",
      entityType: "correction_review",
      entityId: c.id,
      title: `Request correction for ${acc.accession_number} (${c.display_id}) through the authorized source-system process — this app cannot make it`,
      ownerId: leadOwner(db),
      ownerRole: "accessioning_lead",
      accessionId: c.accession_id,
    });
  }
  audit(ctx, {
    action: closing ? "correction.closed" : "correction.referred",
    entityType: "correction_review",
    entityId: c.id,
    accessionId: c.accession_id,
    summary: `${c.display_id} on ${acc.accession_number}: ${CORRECTION_STATUS_LABEL[input.outcome]} by ${ctx.actor.name}. Accession number, parts and labels unchanged.`,
    before: { status: c.status },
    after: { status: input.outcome },
    reason: input.note.trim(),
  });
  return updated;
}
