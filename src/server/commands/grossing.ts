// Commands for the "grossing" slice (S4). Each defineCommand() call registers itself.
// Every state change for gross documentation goes through one of these.
import { z } from "zod";
import { defineCommand } from "./registry";
import {
  amend, approve, confirmField, flagNeedsClarification, GROSS_FIELD_KEYS, loadTranscript, markReviewed, recordSourceEntry,
  resolveClarification, simulateSourceAck, startDraft, updateFields, withConflictAuthor, type FieldPatch, type GrossFieldKey,
} from "../domain/gross";

const id = z.string().trim().min(1).max(120);
const version = z.number().int().min(1);
const fieldKey = z.enum(GROSS_FIELD_KEYS as [GrossFieldKey, ...GrossFieldKey[]]);
const patchEntry = z.object({ value: z.unknown() });
const patchSchema = z
  .object(Object.fromEntries(GROSS_FIELD_KEYS.map((k) => [k, patchEntry.optional()])) as Record<GrossFieldKey, z.ZodOptional<typeof patchEntry>>)
  .strict();

export const grossStartDraft = defineCommand({
  name: "gross.startDraft",
  description: "Open the gross record for a part, creating an empty v1 draft from the procedure's template (no values pre-filled) if none exists.",
  permission: "gross.edit",
  input: z.object({ specimenPartId: id }),
  run: (ctx, input) => startDraft(ctx, input.specimenPartId),
});

export const grossLoadTranscript = defineCommand({
  name: "gross.loadTranscript",
  description:
    "Attach a synthetic dictation transcript and run the deterministic demo extractor. Produces proposals only; nothing is confirmed. expectedVersion is the gross record version the user saw, or null when the part had no gross record yet (a record started by someone else meanwhile is a conflict).",
  permission: "gross.edit",
  input: z.object({ specimenPartId: id, transcriptKey: z.string().trim().min(1).max(60), expectedVersion: version.nullable() }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => loadTranscript(ctx, input.specimenPartId, input.transcriptKey, input.expectedVersion)),
});

export const grossUpdateFields = defineCommand({
  name: "gross.updateFields",
  description: "Save typed values and/or the narrative on a draft. Typed values still need an explicit confirmation.",
  permission: "gross.edit",
  input: z.object({
    grossRecordId: id, expectedVersion: version, patch: patchSchema.default({}), narrative: z.string().max(4000).optional(),
    /** The operator checked the (unchanged) narrative against values confirmed after it was written. */
    narrativeChecked: z.boolean().optional(),
  }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => updateFields(ctx, input.grossRecordId, input.expectedVersion, input.patch as FieldPatch, input.narrative, input.narrativeChecked ?? false)),
});

export const grossConfirmField = defineCommand({
  name: "gross.confirmField",
  description:
    "Operator confirms one value (numbers, units and counts must be explicit). Without a value, confirms a clean proposal as shown. Keeping a needs-review value as dictated requires acknowledgeReview: true (the operator checked the specimen).",
  permission: "gross.review",
  input: z.object({ grossRecordId: id, expectedVersion: version, field: fieldKey, value: z.unknown().optional(), acknowledgeReview: z.boolean().optional() }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => confirmField(ctx, input.grossRecordId, input.expectedVersion, input.field, input.value, input.acknowledgeReview ?? false)),
});

export const grossMarkReviewed = defineCommand({
  name: "gross.markReviewed",
  description: "Mark the draft operator reviewed. Blocked until every required value is confirmed with explicit units and counts.",
  permission: "gross.review",
  input: z.object({ grossRecordId: id, expectedVersion: version }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => markReviewed(ctx, input.grossRecordId, input.expectedVersion)),
});

export const grossApprove = defineCommand({
  name: "gross.approve",
  description: "Approve a reviewed gross record for downstream use: creates allocated blocks, the source-entry task and processing eligibility. Blocked by unconfirmed values or a gross-approval hold.",
  permission: "gross.approve",
  input: z.object({ grossRecordId: id, expectedVersion: version }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => approve(ctx, input.grossRecordId, input.expectedVersion)),
});

export const grossRecordSourceEntry = defineCommand({
  name: "gross.recordSourceEntry",
  description: "Staff attestation that the approved description was entered manually in the source system. Not an acknowledgment from the source.",
  permission: "gross.recordSourceEntry",
  input: z.object({ grossRecordId: id, expectedVersion: version }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => recordSourceEntry(ctx, input.grossRecordId, input.expectedVersion)),
});

export const grossSimulateSourceAck = defineCommand({
  name: "gross.simulateSourceAck",
  description: "Demo simulator: the simulated source system acknowledges an attested entry. No real interface exists.",
  permission: null,
  audience: "presenter",
  input: z.object({ grossRecordId: id }),
  run: (ctx, input) => simulateSourceAck(ctx, input.grossRecordId),
});

export const grossFlagNeedsClarification = defineCommand({
  name: "gross.flagNeedsClarification",
  description: "Park a draft as needing clarification, with a note.",
  permission: "gross.edit",
  input: z.object({ grossRecordId: id, expectedVersion: version, note: z.string().trim().min(3, "Describe what needs clarification").max(1000) }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => flagNeedsClarification(ctx, input.grossRecordId, input.expectedVersion, input.note)),
});

export const grossResolveClarification = defineCommand({
  name: "gross.resolveClarification",
  description: "Record how a grossing question was resolved; the record returns from needs clarification to draft (it can then be reviewed).",
  permission: "gross.edit",
  input: z.object({ grossRecordId: id, expectedVersion: version, resolution: z.string().trim().min(3, "Describe how it was resolved").max(1000) }),
  run: (ctx, input) => withConflictAuthor(ctx.db, () => resolveClarification(ctx, input.grossRecordId, input.expectedVersion, input.resolution)),
});

export const grossAmend = defineCommand({
  name: "gross.amend",
  description: "Create a new draft version from an approved one (reason required). The approved version is superseded and never edited.",
  permission: "gross.approve",
  input: z.object({ grossRecordId: id, reason: z.string().trim().min(3, "A reason is required").max(1000) }),
  run: (ctx, input) => amend(ctx, input.grossRecordId, input.reason),
});
