// Commands for the "clarifications" slice (S2). Each defineCommand() call registers itself.
// Every office notification here is SIMULATED; no real office is ever contacted.
import { z } from "zod";
import { defineCommand } from "./registry";
import { audit } from "../core/audit";
import { DomainError } from "../core/errors";
import {
  cancelClarification,
  createClarification,
  draftForClarification,
  escalateClarification,
  followUpClarification,
  getClarification,
  placeManualHold,
  recordAck,
  recordAnswer,
  recordDelivery,
  releaseHoldWithChecks,
  resolveClarification,
  reviewClarification,
  sendClarification,
  ANSWER_CHANNELS,
  RESOLUTION_CODES,
} from "../domain/clarification";
import { assertAssistantAvailable } from "../assist/drafter";
import { simulateOfficeAnswer } from "../sim/office";
import { CLARIFICATION_CATEGORY } from "@/lib/domain";

const id = z.string().trim().min(1).max(100);
const version = z.number().int().min(1);
const text = (max: number) => z.string().max(max);
const required = (max: number, msg: string) => z.string().trim().min(1, msg).max(max);

const CATEGORIES = Object.keys(CLARIFICATION_CATEGORY) as [keyof typeof CLARIFICATION_CATEGORY, ...(keyof typeof CLARIFICATION_CATEGORY)[]];
const TRANSITIONS = ["accession_request", "routing_confirm", "gross_approval", "processing", "sectioning", "print", "tray_delivery", "all"] as const;
const SCOPE_TYPES = ["intake_item", "container", "order_part", "specimen_part", "block", "slide", "work_order", "accession"] as const;
const PRIORITIES = ["routine", "high", "urgent"] as const;

const scopeSchema = z.object({ type: z.enum(SCOPE_TYPES), id });
const evidenceItem = z.record(z.string(), z.unknown());

export const clarificationCreate = defineCommand({
  name: "clarification.create",
  description:
    "Draft a specimen-specific clarification (deduplicated on open category + subject), pick the office contact with coverage, set the next follow-up within office hours, optionally place a scoped hold.",
  permission: "clarification.create",
  input: z.object({
    category: z.enum(CATEGORIES),
    refs: z.object({
      intakeItemId: id.nullish(),
      sourceOrderId: id.nullish(),
      orderPartId: id.nullish(),
      containerId: id.nullish(),
      accessionId: id.nullish(),
      specimenPartId: id.nullish(),
    }),
    subjectLabel: required(200, "Name the affected material (for example Part B · ORD-77121)"),
    /** The person's own question. Without it a fixed rule-based template is stored (draft source "template"). */
    question: text(2000).optional(),
    evidence: z.array(evidenceItem).max(20).default([]),
    priority: z.enum(PRIORITIES).default("routine"),
    hold: z
      .object({
        scope: scopeSchema,
        scopeLabel: required(200, "Name the held material"),
        blocks: z.array(z.enum(TRANSITIONS)).min(1, "Choose at least one step to hold"),
      })
      .nullish(),
    officeId: id.nullish(),
    labOwnerId: id.nullish(),
  }),
  run: (ctx, input) =>
    createClarification(ctx, {
      category: input.category,
      refs: input.refs,
      subjectLabel: input.subjectLabel,
      question: input.question,
      evidence: input.evidence,
      priority: input.priority,
      hold: input.hold ?? null,
      officeId: input.officeId ?? null,
      labOwnerId: input.labOwnerId ?? null,
    }),
});

export const clarificationDraftMessage = defineCommand({
  name: "clarification.draftMessage",
  description:
    "Deterministic drafting assistant (demo, not live AI): proposes the question from the recorded evidence (no patient details: identity values are never quoted) and a generic notification body. ASSISTANT_UNAVAILABLE when the assistant is switched off; manual entry still works.",
  permission: "clarification.send",
  input: z.object({ clarificationId: id }),
  run: (ctx, input) => {
    assertAssistantAvailable(ctx.db);
    const clr = getClarification(ctx.db, input.clarificationId);
    const draft = draftForClarification(ctx.db, clr);
    audit(
      { ...ctx, origin: "assistant" },
      {
        action: "assistant.draft_proposed",
        entityType: "clarification",
        entityId: clr.id,
        accessionId: clr.accession_id,
        intakeItemId: clr.intake_item_id,
        summary: `Deterministic demo drafter proposed text for ${clr.display_id} (requested by ${ctx.actor.name}). Proposal only; nothing was sent or changed.`,
        after: { basedOn: draft.basedOn },
      },
    );
    return {
      clarificationId: clr.id,
      displayId: clr.display_id,
      question: draft.question,
      notificationBody: draft.notificationBody,
      /** Alias of notificationBody (generic; no patient identifiers). */
      body: draft.notificationBody,
      label: draft.label,
      generator: draft.generator,
      basedOn: draft.basedOn,
    };
  },
});

export const clarificationSend = defineCommand({
  name: "clarification.send",
  description:
    "Send the clarification through the SIMULATED notification connector. The office gets a generic notice; the question stays in the secure case view. Idempotent per clarification. Never moves past the delivery states.",
  permission: "clarification.send",
  input: z.object({
    clarificationId: id,
    expectedVersion: version,
    body: text(1000).optional(),
    question: text(2000).optional(),
    draftSource: z.enum(["manual", "assistant_proposal", "template"]).optional(),
  }),
  run: (ctx, input) => sendClarification(ctx, input),
});

export const clarificationRecordDelivery = defineCommand({
  name: "clarification.recordDelivery",
  description: "Record a delivery outcome (delivered / delivery unknown / delivery failed) confirmed by staff or the simulated connector.",
  permission: "clarification.record",
  input: z.object({
    clarificationId: id,
    outcome: z.enum(["delivered", "delivery_unknown", "delivery_failed"]),
    note: text(500).optional(),
  }),
  run: (ctx, input) => recordDelivery(ctx, input),
});

export const clarificationRecordAck = defineCommand({
  name: "clarification.recordAck",
  description: "Record that the office acknowledged the question (not an answer).",
  permission: "clarification.record",
  input: z.object({ clarificationId: id, note: text(500).optional() }),
  run: (ctx, input) => recordAck(ctx, input),
});

export const clarificationRecordAnswer = defineCommand({
  name: "clarification.recordAnswer",
  description: "Record the office's answer verbatim (untrusted text). Moves to 'answered'; it never resolves the clarification.",
  permission: "clarification.record",
  input: z.object({
    clarificationId: id,
    answerText: required(4000, "Enter the office's answer"),
    answeredBy: required(200, "Who gave the answer (role or name at the office)"),
    channel: z.enum(Object.keys(ANSWER_CHANNELS) as [keyof typeof ANSWER_CHANNELS, ...(keyof typeof ANSWER_CHANNELS)[]]).default("phone_recorded_by_staff"),
  }),
  run: (ctx, input) => recordAnswer(ctx, input),
});

export const clarificationSimulateOfficeAnswer = defineCommand({
  name: "clarification.simulateOfficeAnswer",
  description:
    "Demo control: the office simulator replies (labeled 'Simulated office reply'). For the hero ORD-77121 laterality question it also queues amended order ORD-77121 v2 in the simulated source, available 1 minute later. Idempotent.",
  permission: null,
  input: z.object({ clarificationId: id }),
  run: (ctx, input) => simulateOfficeAnswer(ctx, input.clarificationId),
});

export const clarificationReview = defineCommand({
  name: "clarification.review",
  description: "Lead/supervisor reviews the office answer (requires 'answered'). 'insufficient' sends it back to waiting on the office.",
  permission: "clarification.review",
  input: z.object({
    clarificationId: id,
    expectedVersion: version,
    note: text(1000).optional(),
    outcome: z.enum(["accepted", "insufficient"]).optional(),
  }),
  run: (ctx, input) => reviewClarification(ctx, input),
});

export const clarificationResolve = defineCommand({
  name: "clarification.resolve",
  description:
    "Lead/supervisor resolves a reviewed clarification with a resolution code and note. Optional hold releases are recorded as SEPARATE audited releases with their own reason.",
  permission: "clarification.resolve",
  input: z.object({
    clarificationId: id,
    expectedVersion: version,
    resolutionCode: z.enum(Object.keys(RESOLUTION_CODES) as [keyof typeof RESOLUTION_CODES, ...(keyof typeof RESOLUTION_CODES)[]]),
    note: required(2000, "A resolution note is required"),
    releaseHoldIds: z.array(id).max(10).optional(),
    releaseReason: text(1000).nullish(),
  }),
  run: (ctx, input) => resolveClarification(ctx, input),
});

export const clarificationFollowUp = defineCommand({
  name: "clarification.followUp",
  description: "Send a reminder (simulated). Suppressed if a message went out less than 30 minutes ago.",
  permission: "clarification.send",
  input: z.object({ clarificationId: id }),
  run: (ctx, input) => followUpClarification(ctx, input),
});

export const clarificationEscalate = defineCommand({
  name: "clarification.escalate",
  description: "Escalate to the office's escalation contact (simulated) and give the lab escalation owner a task.",
  permission: "clarification.send",
  input: z.object({ clarificationId: id, note: text(500).optional() }),
  run: (ctx, input) => escalateClarification(ctx, input),
});

export const clarificationCancel = defineCommand({
  name: "clarification.cancel",
  description: "Lead/supervisor cancels an open clarification with a reason. Linked holds stay active until released separately.",
  permission: "clarification.resolve",
  input: z.object({ clarificationId: id, reason: required(1000, "A reason is required"), expectedVersion: version.optional() }),
  run: (ctx, input) => cancelClarification(ctx, input),
});

export const holdRelease = defineCommand({
  name: "hold.release",
  description:
    "Lead/supervisor releases a hold with a reason. A hold linked to an open clarification needs the clarification resolved first (or a supervisor override with reason).",
  permission: "hold.release",
  input: z.object({
    holdId: id,
    expectedVersion: version,
    reason: required(1000, "A release reason is required"),
    overrideOpenClarification: z.boolean().optional(),
  }),
  run: (ctx, input) => releaseHoldWithChecks(ctx, input),
});

export const holdPlace = defineCommand({
  name: "hold.place",
  description: "Place a manual hold scoped to specific material and specific steps (never the whole bench).",
  permission: "hold.place",
  input: z.object({
    scope: scopeSchema,
    scopeLabel: required(200, "Name the held material"),
    blocks: z.array(z.enum(TRANSITIONS)).min(1, "Choose at least one step to hold"),
    reasonCode: text(60).optional(),
    reasonText: required(500, "Say why the material is held"),
    clarificationId: id.nullish(),
  }),
  run: (ctx, input) => {
    if (input.blocks.includes("all") && input.blocks.length > 1) {
      throw new DomainError("VALIDATION", "Choose 'all' or specific steps, not both.");
    }
    return placeManualHold(ctx, input);
  },
});

export const __clarificationsCommands = [
  clarificationCreate.name,
  clarificationDraftMessage.name,
  clarificationSend.name,
  clarificationRecordDelivery.name,
  clarificationRecordAck.name,
  clarificationRecordAnswer.name,
  clarificationSimulateOfficeAnswer.name,
  clarificationReview.name,
  clarificationResolve.name,
  clarificationFollowUp.name,
  clarificationEscalate.name,
  clarificationCancel.name,
  holdRelease.name,
  holdPlace.name,
] as const;
