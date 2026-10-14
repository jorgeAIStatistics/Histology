import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { newId } from "../core/ids";
import { audit } from "../core/audit";
import { decodeLabel, humanLabel, type DecodeResult } from "@/lib/identifiers";
import { closeTasksForEntity, refreshSlideLabelState, requireText } from "./material";

/**
 * Physical label lifecycle. Printing, applying and verifying a label are three
 * separate events. A label scan identifies the record the label encodes; it
 * never verifies the tissue on the slide or in the cassette.
 */
export interface LabelRow {
  id: string;
  target_type: string;
  target_id: string;
  print_job_id: string | null;
  payload: string;
  state: "printed" | "applied" | "verified" | "retired";
  applied_by: string | null;
  applied_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  created_at: string;
  replaces_label_id: string | null;
}

export function getLabel(db: DB, labelId: string): LabelRow | undefined {
  return db.prepare("SELECT * FROM label WHERE id = ?").get(labelId) as LabelRow | undefined;
}

function mustLabel(db: DB, labelId: string): LabelRow {
  const l = getLabel(db, labelId);
  if (!l) throw new DomainError("NOT_FOUND", `Label ${labelId} was not found`);
  return l;
}

/** Readable text for a label payload ("D26-04817 A1-2 PAS"), or the raw payload if it does not decode. */
export function labelText(payload: string): string {
  const d = decodeLabel(payload);
  return d.ok ? humanLabel(d.identity) : payload;
}

function accessionOfTarget(db: DB, targetType: string, targetId: string): string | null {
  const table = targetType === "slide" ? "slide" : targetType === "block" ? "block" : null;
  if (!table) return targetType === "accession" ? targetId : null;
  const r = db.prepare(`SELECT accession_id FROM ${table} WHERE id = ?`).get(targetId) as { accession_id: string } | undefined;
  return r?.accession_id ?? null;
}

/** A printed label row for a print job (called when the printer acknowledges or a person confirms output). */
export function createLabelForJob(
  ctx: Ctx,
  job: { id: string; target_type: string; target_id: string; payload: string },
  replacesLabelId: string | null = null,
): string {
  const existing = ctx.db.prepare("SELECT id FROM label WHERE print_job_id = ?").get(job.id) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId(ctx.db, "lbl");
  ctx.db
    .prepare(
      `INSERT INTO label (id, target_type, target_id, print_job_id, payload, state, created_at, replaces_label_id)
       VALUES (?, ?, ?, ?, ?, 'printed', ?, ?)`,
    )
    .run(id, job.target_type, job.target_id, job.id, job.payload, ctx.now, replacesLabelId);
  if (job.target_type === "slide") refreshSlideLabelState(ctx.db, job.target_id);
  return id;
}

/** The newest non-retired label for a target (the one a reprint replaces). */
export function currentLabelFor(db: DB, targetType: string, targetId: string): LabelRow | undefined {
  return db
    .prepare(
      `SELECT * FROM label WHERE target_type = ? AND target_id = ? AND state <> 'retired'
        ORDER BY CASE state WHEN 'verified' THEN 3 WHEN 'applied' THEN 2 ELSE 1 END DESC, created_at DESC LIMIT 1`,
    )
    .get(targetType, targetId) as LabelRow | undefined;
}

export function applyLabel(ctx: Ctx, labelId: string): { labelId: string; state: string; message: string } {
  const l = mustLabel(ctx.db, labelId);
  const text = labelText(l.payload);
  if (l.state === "applied" || l.state === "verified") {
    return { labelId, state: l.state, message: `Label ${text} is already ${l.state}. Nothing changed.` };
  }
  if (l.state !== "printed") throw new DomainError("INVARIANT", `Label ${text} is ${l.state} and cannot be applied`);
  const other = ctx.db
    .prepare(
      `SELECT l.id, pj.display_id FROM label l LEFT JOIN print_job pj ON pj.id = l.print_job_id
        WHERE l.target_type = ? AND l.target_id = ? AND l.state IN ('applied','verified') AND l.id <> ?`,
    )
    .get(l.target_type, l.target_id, l.id) as { id: string; display_id: string | null } | undefined;
  if (other) {
    throw new DomainError(
      "BLOCKED",
      `Another label${other.display_id ? ` (from ${other.display_id})` : ""} is already applied to ${text}. Retire it (with a reason) before applying this one.`,
      { existingLabelId: other.id },
    );
  }
  ctx.db.prepare("UPDATE label SET state = 'applied', applied_by = ?, applied_at = ? WHERE id = ?").run(ctx.actor.id, ctx.now, labelId);
  if (l.target_type === "slide") refreshSlideLabelState(ctx.db, l.target_id);
  audit(ctx, {
    action: "label.applied",
    entityType: "label",
    entityId: labelId,
    accessionId: accessionOfTarget(ctx.db, l.target_type, l.target_id),
    summary: `Label ${text} applied by ${ctx.actor.name} (not yet verified by scan)`,
  });
  return { labelId, state: "applied", message: `Label ${text} recorded as applied. Scan it to verify the label.` };
}

export type VerifyResult =
  | { labelId: string; verified: true; message: string }
  | { labelId: string; verified: false; reason: string; message: string; decoded: DecodeResult };

/**
 * Verify an applied label by scanning it. The scanned payload must decode
 * (valid check character) and match the label's own payload. A failed scan is
 * recorded in the audit trail and changes nothing else.
 */
export function verifyLabel(ctx: Ctx, labelId: string, scannedPayload: string): VerifyResult {
  const l = mustLabel(ctx.db, labelId);
  const text = labelText(l.payload);
  if (l.state === "printed") throw new DomainError("BLOCKED", `Label ${text} has not been applied yet. Record "Apply label" first.`);
  if (l.state === "retired") throw new DomainError("INVARIANT", `Label ${text} is retired and cannot be verified`);
  const decoded = decodeLabel(scannedPayload);
  const accessionId = accessionOfTarget(ctx.db, l.target_type, l.target_id);
  if (!decoded.ok || decoded.payload !== l.payload.toUpperCase()) {
    const reason = !decoded.ok
      ? `Scan not accepted: ${decoded.reason}.`
      : `Scanned ${humanLabel(decoded.identity)}, but this label belongs to ${text}.`;
    audit(ctx, {
      action: "label.verify_failed",
      entityType: "label",
      entityId: labelId,
      accessionId,
      summary: `Label verification failed for ${text}: ${reason}`,
      after: { scanned: decoded.payload },
    });
    return { labelId, verified: false, reason, message: `${reason} Nothing changed.`, decoded };
  }
  if (l.state === "verified") return { labelId, verified: true, message: `Label ${text} was already verified. Nothing changed.` };
  ctx.db.prepare("UPDATE label SET state = 'verified', verified_by = ?, verified_at = ? WHERE id = ?").run(ctx.actor.id, ctx.now, labelId);
  if (l.target_type === "slide") refreshSlideLabelState(ctx.db, l.target_id);
  audit(ctx, {
    action: "label.verified",
    entityType: "label",
    entityId: labelId,
    accessionId,
    summary: `Label ${text} scanned after application: the label decodes and matches its record (identifies the record; does not verify tissue)`,
  });
  return { labelId, verified: true, message: `Scanned ${text}. Label matches its record.` };
}

/** Retire a physical label through an explicit, reasoned step (damaged, replaced, not needed). */
export function retireLabel(ctx: Ctx, labelId: string, reason: string): { labelId: string; message: string } {
  const why = requireText(reason, "A reason is required to retire a label");
  const l = mustLabel(ctx.db, labelId);
  const text = labelText(l.payload);
  if (l.state === "retired") return { labelId, message: `Label ${text} was already retired. Nothing changed.` };
  ctx.db
    .prepare("UPDATE label SET state = 'retired', retired_by = ?, retired_at = ?, retire_reason = ? WHERE id = ?")
    .run(ctx.actor.id, ctx.now, why, labelId);
  if (l.target_type === "slide") refreshSlideLabelState(ctx.db, l.target_id);
  closeTasksForEntity(ctx, "label_retire", labelId);
  audit(ctx, {
    action: "label.retired",
    entityType: "label",
    entityId: labelId,
    accessionId: accessionOfTarget(ctx.db, l.target_type, l.target_id),
    summary: `Label ${text} retired (was ${l.state}). The slide/block record is unchanged.`,
    reason: why,
  });
  return { labelId, message: `Label ${text} retired. The ${l.target_type} record is unchanged.` };
}

/** Round-trip check used by the label preview panel: decode the payload back and compare. */
export function roundTrip(payload: string): { payload: string; decoded: DecodeResult; human: string | null; matches: boolean } {
  const decoded = decodeLabel(payload);
  return {
    payload,
    decoded,
    human: decoded.ok ? humanLabel(decoded.identity) : null,
    matches: decoded.ok && decoded.payload === payload.trim().toUpperCase(),
  };
}
