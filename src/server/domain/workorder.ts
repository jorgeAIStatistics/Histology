import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { updateVersioned } from "../core/versioning";
import { WORK_ORDER_STATUS, type WorkOrderStatus } from "@/lib/domain";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import { closeTasksForEntity, mustBlock, pathologistOf, refreshSlideLabelState, requireText, slideText, staffName, getSlide } from "./material";
import { cancelPendingJobsFor } from "./print";

/**
 * Work orders: authorized additional work (an additional slide is NOT a
 * reprint), and review of work orders that the source canceled or amended
 * after material was printed or prepared. Nothing physically prepared is
 * silently erased: every slide row stays, with its recorded disposition.
 */

export type ReviewDecision = "retain_prepared_material" | "void_unprepared" | "keep_active";

export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
  retain_prepared_material: "Retain prepared material (cancellation accepted)",
  void_unprepared: "Void unprepared work (nothing was prepared)",
  keep_active: "Keep the work active",
};

export const SLIDE_DISPOSITION_LABEL: Record<string, string> = {
  retained_per_review: "Retained per review (not delivered as ordered work)",
  voided_unprepared: "Voided before preparation (per review)",
  kept_active: "Kept active (per review)",
};

export function orderAdditionalSlide(
  ctx: Ctx,
  input: { blockId: string; stain: string; level?: string | null; reason: string },
): { workOrderId: string; workOrderDisplayId: string; slideId: string; slideLabel: string; message: string } {
  const reason = requireText(input.reason, "Say why the additional slide is needed");
  const stain = requireText(input.stain, "Choose the stain for the additional slide");
  const block = mustBlock(ctx.db, input.blockId);
  if (block.status !== "active") throw new DomainError("BLOCKED", `${block.accession_number} ${block.label_text} is void`);
  if (block.custody_state === "sent_out") {
    throw new DomainError("BLOCKED", `${block.accession_number} ${block.label_text} is outside the lab (sent out). Request it back before ordering more slides.`);
  }
  if (block.custody_state === "missing_investigation") {
    throw new DomainError("BLOCKED", `${block.accession_number} ${block.label_text} is missing (investigation open). Find it before ordering more slides.`);
  }
  const level = input.level?.trim() || null;
  const isHE = stain.toUpperCase() === "H&E" || stain.toUpperCase() === "HE";
  const kind = isHE ? (level ? "levels" : "recut") : "stain";
  const pathologistId = pathologistOf(ctx.db, block.accession_id);
  const pathologistName = staffName(ctx.db, pathologistId) ?? "assigned dermatopathologist";
  const byPathologist = ctx.actor.role === "pathologist";
  const requestedByLabel = byPathologist ? ctx.actor.name : `${pathologistName} (entered by ${ctx.actor.name})`;

  const woId = newId(ctx.db, "wo");
  const woDisplay = displayId(ctx.db, "WO", 4);
  ctx.db
    .prepare(
      `INSERT INTO work_order (id, display_id, accession_id, kind, stain, authorization_source, source_reference, requested_by_label, requested_by_staff_id,
        source_order_id, source_version, target_part_id, target_block_id, quantity, status, status_reason, requested_at, version)
       VALUES (?, ?, ?, ?, ?, 'pathologist_request', ?, ?, ?, NULL, NULL, ?, ?, 1, 'requested', NULL, ?, 1)`,
    )
    .run(
      woId, woDisplay, block.accession_id, kind, isHE ? "H&E" : stain, `Additional slide on ${block.label_text}: ${reason}`, requestedByLabel,
      byPathologist ? ctx.actor.id : (pathologistId ?? null), block.part_id, block.id, ctx.now,
    );
  const seq = (ctx.db.prepare("SELECT COALESCE(MAX(slide_seq), 0) + 1 n FROM slide WHERE block_id = ?").get(block.id) as { n: number }).n;
  const slideId = newId(ctx.db, "sld");
  const identifier = encodeLabel({
    kind: "S", namespace: namespaceCode(block.namespace), accession: block.accession_number, part: block.part_designation, block: block.block_seq, slide: seq, stain: isHE ? "H&E" : stain,
  });
  ctx.db
    .prepare(
      `INSERT INTO slide (id, accession_id, block_id, slide_seq, stain, level_label, work_order_id, identifier, physical_state, label_state, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'none', 'active', 1)`,
    )
    .run(slideId, block.accession_id, block.id, seq, isHE ? "H&E" : stain, level, woId, identifier);
  const slide = getSlide(ctx.db, slideId)!;
  const slideLabel = slideText(slide);
  audit(ctx, {
    action: "work_order.created",
    entityType: "work_order",
    entityId: woId,
    accessionId: block.accession_id,
    summary: `${woDisplay}: additional slide ${slideLabel} ordered on ${block.accession_number} ${block.label_text} (${requestedByLabel}). New work order and new planned slide — not a reprint.`,
    reason,
  });
  recordWorklistChange(ctx, {
    accessionId: block.accession_id,
    pathologistId,
    type: "changed",
    summary: `${woDisplay}: additional ${isHE ? "H&E" : stain} slide planned on ${block.accession_number} ${block.label_text}`,
  });
  return { workOrderId: woId, workOrderDisplayId: woDisplay, slideId, slideLabel, message: `${woDisplay} created: ${slideLabel} planned. Print its label when ready.` };
}

interface WoRow {
  id: string;
  display_id: string;
  accession_id: string;
  stain: string | null;
  status: WorkOrderStatus;
  status_reason: string | null;
  source_reference: string;
  authorization_source: string;
  version: number;
}

/**
 * Record the review decision for a work order canceled or amended at the
 * source after labels were printed or slides prepared.
 *
 * - Slide rows are never deleted; each gets a recorded disposition.
 * - Holds are NOT released here: releasing a hold is a separate, audited
 *   decision by a lead or supervisor (hold.release). Active holds on the
 *   reviewed material are listed in the result.
 * - "Keep active" on work the SOURCE CANCELED needs new authorization: only
 *   the dermatopathologist can record it, and the work order's authorization
 *   is rewritten to that request (the canceled source order no longer
 *   authorizes it). Slides the importer already voided stay void.
 */
export function reviewSourceChange(
  ctx: Ctx,
  input: { workOrderId: string; decision: ReviewDecision; note: string },
): { workOrderId: string; status: WorkOrderStatus; slides: { slideId: string; label: string; disposition: string }[]; retiredLabels: number; heldOpen: string[]; message: string } {
  const note = requireText(input.note, "A review note is required");
  const wo = ctx.db.prepare("SELECT * FROM work_order WHERE id = ? OR display_id = ?").get(input.workOrderId, input.workOrderId) as WoRow | undefined;
  if (!wo) throw new DomainError("NOT_FOUND", "Work order not found");
  if (wo.status !== "cancel_review" && wo.status !== "amended_review") {
    throw new DomainError("INVARIANT", `${wo.display_id} is ${WORK_ORDER_STATUS[wo.status] ?? wo.status}; only a work order awaiting review of a source change can be reviewed`);
  }
  const slides = ctx.db.prepare("SELECT id FROM slide WHERE work_order_id = ? ORDER BY slide_seq").all(wo.id) as { id: string }[];
  const infos = slides.map((s) => getSlide(ctx.db, s.id)!);
  const prepared = infos.filter((s) => s.physical_state !== "planned");
  const reauthorize = input.decision === "keep_active" && wo.status === "cancel_review";
  if (reauthorize && ctx.actor.role !== "pathologist") {
    throw new DomainError(
      "FORBIDDEN",
      `${wo.display_id} was canceled at the source. Keeping it active needs a new authorization from the dermatopathologist; a ${ctx.actor.role.replace(/_/g, " ")} can retain prepared material or void unprepared work instead.`,
    );
  }
  if (input.decision === "void_unprepared" && prepared.length) {
    throw new DomainError(
      "BLOCKED",
      `${prepared.map((s) => slideText(s)).join(", ")} ${prepared.length === 1 ? "is" : "are"} already prepared (${prepared.map((s) => s.physical_state).join(", ")}). Prepared material cannot be voided; choose "Retain prepared material".`,
    );
  }

  const results: { slideId: string; label: string; disposition: string }[] = [];
  let retiredLabels = 0;
  const reviewFields = { review_note: note, reviewed_by: ctx.actor.id, reviewed_at: ctx.now };
  for (const s of infos) {
    if (s.status === "void") {
      // Voided earlier (for example by the importer before anything was prepared): stays void and on record.
      results.push({ slideId: s.id, label: slideText(s), disposition: "already void" });
      continue;
    }
    let disposition: string;
    let status: string;
    if (input.decision === "keep_active") {
      disposition = "kept_active";
      status = "active";
    } else if (s.physical_state === "planned") {
      disposition = "voided_unprepared";
      status = "void";
    } else {
      disposition = "retained_per_review";
      status = "void";
    }
    updateVersioned(ctx.db, "slide", s.id, undefined, { status, review_disposition: disposition, ...reviewFields });
    if (input.decision !== "keep_active") {
      cancelPendingJobsFor(ctx, "slide", s.id, `${wo.display_id} canceled at the source; reviewed`);
      if (s.physical_state === "planned") {
        // A printed label for a slide that will never be cut is retired through this approved review.
        const labels = ctx.db.prepare("SELECT id FROM label WHERE target_type = 'slide' AND target_id = ? AND state <> 'retired'").all(s.id) as { id: string }[];
        for (const l of labels) {
          ctx.db
            .prepare("UPDATE label SET state = 'retired', retired_by = ?, retired_at = ?, retire_reason = ? WHERE id = ?")
            .run(ctx.actor.id, ctx.now, `Not needed: ${wo.display_id} canceled at the source; retired per review (${note})`, l.id);
          retiredLabels += 1;
        }
        refreshSlideLabelState(ctx.db, s.id);
      }
    }
    results.push({ slideId: s.id, label: slideText(s), disposition });
  }

  let nextStatus: WorkOrderStatus;
  if (input.decision === "keep_active") {
    nextStatus = prepared.length ? "in_progress" : "requested";
  } else {
    nextStatus = "canceled";
  }
  const reauth = reauthorize
    ? {
        authorization_source: "pathologist_request",
        source_reference: `Kept active by ${ctx.actor.name} after the source canceled it (was: ${wo.source_reference}): ${note}`,
        requested_by_label: ctx.actor.name,
        requested_by_staff_id: ctx.actor.id,
      }
    : {};
  updateVersioned(ctx.db, "work_order", wo.id, undefined, {
    status: nextStatus,
    status_reason: `${wo.status === "cancel_review" ? "Canceled" : "Amended"} at source; reviewed by ${ctx.actor.name}: ${REVIEW_DECISION_LABEL[input.decision]}${reauthorize ? " (new authorization by the dermatopathologist)" : ""}`,
    review_decision: input.decision,
    ...reviewFields,
    ...reauth,
  });

  closeTasksForEntity(ctx, "order_change_review", wo.id);
  for (const s of infos) closeTasksForEntity(ctx, "order_change_review", s.id);

  // Holds are never released as a side effect of this review: each release is its own audited decision.
  const scopeIds = [wo.id, ...infos.map((s) => s.id)];
  const holds = ctx.db
    .prepare(`SELECT display_id FROM hold WHERE status = 'active' AND scope_id IN (${scopeIds.map(() => "?").join(",")})`)
    .all(...scopeIds) as { display_id: string }[];
  const heldOpen = holds.map((h) => h.display_id);

  audit(ctx, {
    action: "work_order.reviewed",
    entityType: "work_order",
    entityId: wo.id,
    accessionId: wo.accession_id,
    summary: `${wo.display_id}${wo.stain ? ` (${wo.stain})` : ""} source change reviewed by ${ctx.actor.name}: ${REVIEW_DECISION_LABEL[input.decision]}${reauthorize ? " — new authorization recorded by the dermatopathologist" : ""}. ${results
      .map((r) => `${r.label}: ${SLIDE_DISPOSITION_LABEL[r.disposition] ?? r.disposition}`)
      .join("; ")}. No slide record was deleted.`,
    reason: note,
    before: { status: wo.status },
    after: { status: nextStatus, decision: input.decision },
  });
  recordWorklistChange(ctx, {
    accessionId: wo.accession_id,
    pathologistId: pathologistOf(ctx.db, wo.accession_id),
    type: nextStatus === "canceled" ? "canceled" : "changed",
    summary: `${wo.display_id}${wo.stain ? ` ${wo.stain}` : ""} reviewed: ${REVIEW_DECISION_LABEL[input.decision].toLowerCase()}`,
  });
  return {
    workOrderId: wo.id,
    status: nextStatus,
    slides: results,
    retiredLabels,
    heldOpen,
    message: `${wo.display_id} reviewed: ${REVIEW_DECISION_LABEL[input.decision]}.${retiredLabels ? ` ${retiredLabels} unused label(s) retired.` : ""}${heldOpen.length ? ` ${heldOpen.join(", ")} still active: this review does not release holds; a lead or supervisor releases ${heldOpen.length === 1 ? "it" : "them"} separately with a reason.` : ""}`,
  };
}
