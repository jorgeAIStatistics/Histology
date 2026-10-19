// Commands for the S1 intake & accession slice. Each defineCommand() call registers itself.
import { z } from "zod";
import { defineCommand } from "./registry";
import { loadActor, makeCtx } from "../core/context";
import { audit } from "../core/audit";
import {
  acceptDiscrepancy,
  receiveDelivery,
  receivePhysicalItem,
  receiveAll,
  recordObservation,
  verifyContainer,
  updateItem,
  loadIntakeItem,
} from "../domain/intake";
import { confirmRouting, overrideRouting, resolveRoutingException } from "../domain/routing";
import { reviewCandidate } from "../domain/related";
import { requestAccession } from "../domain/accession";
import { openCorrection, closeCorrection, CORRECTION_KINDS, CORRECTION_OUTCOMES } from "../domain/correction";
import { reviewSourceConflict, SOURCE_CONFLICT_DECISIONS } from "../domain/sourceConflict";

const id = z.string().trim().min(1).max(80);
const version = z.number().int().nonnegative();
const reason = z.string().trim().min(1, "A reason is required").max(1000);
const optText = z.string().max(200).nullable().optional();

export const receiveDeliveryCmd = defineCommand({
  name: "intake.receiveDelivery",
  description: "Record a courier arrival (time, receiver). Idempotent.",
  permission: "intake.receive",
  input: z.object({ deliveryId: id }),
  run: (ctx, input) => {
    const { delivery, duplicate } = receiveDelivery(ctx, input.deliveryId);
    return { deliveryId: delivery.id, displayId: delivery.display_id, arrivedAt: delivery.arrived_at, receivedBy: delivery.received_by, status: delivery.status, duplicate };
  },
});

export const receivePhysicalItemCmd = defineCommand({
  name: "intake.receivePhysicalItem",
  description: "Unpack one requisition and its containers from the simulated courier bag. Idempotent per physical item.",
  permission: "intake.receive",
  input: z.object({ deliveryId: id, physicalItemId: id.optional(), orderRef: z.string().trim().min(1).max(60).optional() }),
  run: (ctx, input) => receivePhysicalItem(ctx, input),
});

export const receiveAllCmd = defineCommand({
  name: "intake.receiveAll",
  description: "Demo convenience: unpack every requisition still in the simulated courier bag.",
  permission: "intake.receive",
  input: z.object({ deliveryId: id }),
  run: (ctx, input) => receiveAll(ctx, input.deliveryId),
});

export const recordObservationCmd = defineCommand({
  name: "intake.recordObservation",
  description: "Staff edits the typed observation of a bottle label (clears an earlier verification).",
  permission: "intake.edit",
  input: z.object({
    containerId: id,
    expectedVersion: version,
    observed: z
      .object({
        patient_name: optText,
        birth_date: optText,
        mrn: optText,
        part_designation: optText,
        site_text: optText,
        laterality: optText,
        procedure: optText,
        collection_date: optText,
        condition_note: z.string().max(500).nullable().optional(),
      })
      .strict(),
  }),
  run: (ctx, input) => {
    const c = recordObservation(ctx, input.containerId, input.expectedVersion, input.observed);
    return { containerId: c.id, version: c.version, verificationState: c.verification_state };
  },
});

export const verifyContainerCmd = defineCommand({
  name: "intake.verifyContainer",
  description: "Staff verified against physical container: a person attests the bottle was checked; differences are recorded as discrepancies.",
  permission: "intake.verifyContainer",
  input: z.object({ containerId: id, expectedVersion: version, orderPartId: id }),
  run: (ctx, input) => verifyContainer(ctx, input.containerId, input.expectedVersion, input.orderPartId),
});

const patchSchema = z
  .object({
    currentOwnerId: id.nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const updateItemCmd = defineCommand({
  name: "intake.updateItem",
  description: "Edit an intake item's owner or note. A stale version is rejected as a conflict.",
  permission: "intake.edit",
  input: z.object({ intakeItemId: id, expectedVersion: version, patch: patchSchema }),
  run: (ctx, input) => {
    const it = updateItem(ctx, input.intakeItemId, input.expectedVersion, input.patch);
    return { intakeItemId: it.id, version: it.version, currentOwnerId: it.current_owner_id, notes: it.notes, updatedAt: it.updated_at };
  },
});

/**
 * Lead / supervisor accepts a recorded field mismatch or extra container with
 * a reason (values stay as found). Not in the original contract: added so a
 * recorded mismatch can never be edited away by retyping the observation.
 * Patient identity differences are refused (they need a resolved identity
 * clarification). Uses the lead-only "clarification.resolve" permission.
 */
export const acceptDiscrepancyCmd = defineCommand({
  name: "intake.acceptDiscrepancy",
  description: "Accessioning lead or supervisor accepts a recorded mismatch or extra container, with a reason. Values are kept as found.",
  permission: "clarification.resolve",
  input: z.object({ discrepancyId: id, expectedVersion: version, reason }),
  run: (ctx, input) => {
    const { discrepancy, containerState } = acceptDiscrepancy(ctx, input.discrepancyId, input.expectedVersion, input.reason);
    return { discrepancyId: discrepancy.id, status: discrepancy.status, version: discrepancy.version, containerState };
  },
});

/**
 * DEMO ONLY: performs an edit on the item as a second accessioner (Luis
 * Benitez) so the presenter can show stale-update detection. The edit is
 * audited as Luis with origin 'demo'; the person who pressed the control is
 * audited too. Requires a role that may edit intake items (not read-only).
 */
export const simulateColleagueEditCmd = defineCommand({
  name: "intake.simulateColleagueEdit",
  description: "Demo control: Luis Benitez (simulated colleague) edits this intake item's note, bumping its version.",
  permission: "intake.edit",
  audience: "presenter",
  input: z.object({ intakeItemId: id }),
  run: (ctx, input) => {
    const it = loadIntakeItem(ctx.db, input.intakeItemId);
    const luis = loadActor(ctx.db, "stf_luis");
    audit(ctx, {
      action: "demo.colleague_edit_requested",
      entityType: "intake_item",
      entityId: it.id,
      intakeItemId: it.id,
      summary: `${ctx.actor.name} used the demo control "Simulate a colleague editing this item" on ${it.display_id}; the edit below is attributed to ${luis.name} (simulated colleague).`,
    });
    const colleagueCtx = { ...makeCtx(ctx.db, luis, "demo", ctx.correlationId), now: ctx.now };
    const note = `Luis Benitez: checked the requisition for ${it.display_id} at the second bench (simulated colleague edit).`;
    const updated = updateItem(colleagueCtx, it.id, it.version, { notes: it.notes ? `${it.notes}\n${note}` : note });
    return { intakeItemId: updated.id, version: updated.version, editedBy: luis.name, requestedBy: ctx.actor.name, notes: updated.notes };
  },
});

// ---------------------------------------------------------------- routing

export const routingConfirmCmd = defineCommand({
  name: "routing.confirm",
  description: "Accept the routing rule's suggested dermatopathologist.",
  permission: "routing.confirm",
  input: z.object({ intakeItemId: id }),
  run: (ctx, input) => {
    const { decision, duplicate } = confirmRouting(ctx, input.intakeItemId);
    return { decisionId: decision.id, status: decision.status, pathologistId: decision.final_pathologist_id, duplicate };
  },
});

export const routingOverrideCmd = defineCommand({
  name: "routing.override",
  description:
    "Lead/supervisor: assign a different dermatopathologist than the rule, with a reason. The rule suggestion is kept. expectedDecisionId is the routing decision the user saw (a newer decision is a conflict); a routing_confirm hold blocks it.",
  permission: "routing.override",
  input: z.object({ intakeItemId: id, pathologistId: id, reason, expectedDecisionId: id }),
  run: (ctx, input) => {
    const d = overrideRouting(ctx, input.intakeItemId, input.pathologistId, input.reason, input.expectedDecisionId);
    return { decisionId: d.id, status: d.status, pathologistId: d.final_pathologist_id };
  },
});

export const routingResolveExceptionCmd = defineCommand({
  name: "routing.resolveException",
  description: "Lead/supervisor: assign a dermatopathologist to a routing exception (unknown or unreviewed office), with a reason.",
  permission: "routing.resolveException",
  input: z.object({ intakeItemId: id, pathologistId: id, reason }),
  run: (ctx, input) => {
    const d = resolveRoutingException(ctx, input.intakeItemId, input.pathologistId, input.reason);
    return { decisionId: d.id, status: d.status, pathologistId: d.final_pathologist_id };
  },
});

// ---------------------------------------------------------------- related orders

export const relatedReviewCmd = defineCommand({
  name: "related.review",
  description: "Lead/supervisor decision on a related-order candidate. Never merges orders or patients.",
  permission: "related.review",
  input: z.object({
    candidateId: id,
    expectedVersion: version,
    decision: z.enum(["single_accession_approved", "keep_separate", "not_related", "escalated_to_office"]),
    reason,
  }),
  run: (ctx, input) => {
    const c = reviewCandidate(ctx, input.candidateId, input.expectedVersion, input.decision, input.reason);
    return { candidateId: c.id, displayId: c.display_id, status: c.status, version: c.version };
  },
});

// ---------------------------------------------------------------- accession

export const accessionRequestCmd = defineCommand({
  name: "accession.request",
  description: "Request the official accession from the simulated authoritative source. Idempotent per set of intake items.",
  permission: "accession.request",
  input: z.object({ intakeItemIds: z.array(id).min(1).max(10), relatedCandidateId: id.nullable().optional() }),
  run: (ctx, input) => requestAccession(ctx, input.intakeItemIds, input.relatedCandidateId ?? null),
});

// ---------------------------------------------------------------- post-accession correction review

export const correctionOpenCmd = defineCommand({
  name: "correction.open",
  description: "Open a correction review for a post-accession discrepancy. Snapshots original references; never renumbers, merges or relabels.",
  permission: "correction.open",
  input: z.object({
    accessionId: id,
    kind: z.enum(CORRECTION_KINDS),
    description: z.string().trim().min(1, "Describe the discrepancy").max(2000),
    relatedAccessionId: id.nullable().optional(),
  }),
  run: (ctx, input) => {
    const { correction, duplicate } = openCorrection(ctx, input);
    return { correctionId: correction.id, displayId: correction.display_id, status: correction.status, duplicate };
  },
});

export const correctionCloseCmd = defineCommand({
  name: "correction.close",
  description: "Lead/supervisor records the outcome of a correction review (referred to the source process, no change, or corrected in source).",
  permission: "correction.close",
  input: z.object({
    correctionId: id,
    outcome: z.enum(CORRECTION_OUTCOMES),
    note: z.string().trim().min(1, "A note is required").max(2000),
    expectedVersion: version,
  }),
  run: (ctx, input) => {
    const c = closeCorrection(ctx, input);
    return { correctionId: c.id, displayId: c.display_id, status: c.status, version: c.version };
  },
});

// ---------------------------------------------------------------- source conflicts (patient / order-level details)

/**
 * The simulated source sent patient details that differ from the patient on
 * file for that MRN, or a newer order version changed its patient, office or
 * encounter. The importer kept what is on file and opened a review task, which
 * blocks accession. Uses the lead-only "clarification.resolve" permission: the
 * same authority that resolves a patient identity question.
 */
export const sourceConflictReviewCmd = defineCommand({
  name: "sourceConflict.review",
  description:
    "Lead/supervisor: record that the patient and order details on file stand for a source conflict, with a reason. Closes the review task only: the patient reference and the order link are never changed and nothing is merged. Any other outcome (the details on file are wrong, or the order is for a different patient) is a patient identity question: raise an identity clarification instead.",
  permission: "clarification.resolve",
  input: z.object({ taskId: id, expectedVersion: version, decision: z.enum(SOURCE_CONFLICT_DECISIONS), reason }),
  run: (ctx, input) => reviewSourceConflict(ctx, input),
});

export const __intakeCommands = [
  receiveDeliveryCmd, receivePhysicalItemCmd, receiveAllCmd, recordObservationCmd, verifyContainerCmd, updateItemCmd, acceptDiscrepancyCmd, simulateColleagueEditCmd,
  routingConfirmCmd, routingOverrideCmd, routingResolveExceptionCmd, relatedReviewCmd, accessionRequestCmd, correctionOpenCmd, correctionCloseCmd,
  sourceConflictReviewCmd,
] as const;
