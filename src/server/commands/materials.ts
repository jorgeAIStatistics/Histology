// Commands for the "materials" slice (S5): print queue, labels, bench progress,
// additional work, source-change review, trays and block retrieval.
// Each defineCommand() call registers itself; every state change goes through here.
import { z } from "zod";
import { defineCommand } from "./registry";
import type { Ctx } from "../core/context";
import { BLOCK_STATE_ORDER, SLIDE_STATE_ORDER } from "@/lib/domain";
import { ensureMaterialsSchema, advanceBlocks, advanceSlides } from "../domain/material";
import { cancelJob, reconcileJob, releaseJob, releaseQueuedForPrinter, reprintJob, requestPrint } from "../domain/print";
import { applyLabel, retireLabel, verifyLabel } from "../domain/labels";
import { orderAdditionalSlide, reviewSourceChange } from "../domain/workorder";
import {
  completeTray, deliverTray, openTray, releaseTrayWithExceptions, resolveTrayScan, scanIntoTray, setTrayDisposition,
} from "../domain/tray";
import { createRequest, deliverRequest, markNotFound, returnBlock, scanForRequest } from "../domain/retrieval";

const id = z.string().trim().min(1).max(120);
const text = (max = 1000) => z.string().max(max);

/** Make sure the additive materials columns exist (older local DB files), then run. */
function withSchema<I, R>(fn: (ctx: Ctx, input: I) => R): (ctx: Ctx, input: I) => R {
  return (ctx, input) => {
    ensureMaterialsSchema(ctx.db);
    return fn(ctx, input);
  };
}

// ---------------------------------------------------------------- printing

export const printRequest = defineCommand({
  name: "print.request",
  description: "Queue a label print for a slide, block or case. A job already in flight (or with an unknown outcome) for the same label prevents a second one.",
  permission: "print.request",
  input: z.object({
    targetType: z.enum(["slide", "block", "accession"]),
    targetId: id,
    kind: z.enum(["slide_label", "cassette_label", "requisition_label"]),
    purpose: z.string().trim().max(40).optional(), // "initial" | "additional_work"; anything else is recorded as "initial"
    reprintOfJobId: id.optional(),
    reprintReason: text(500).optional(),
    printerId: id.optional(),
  }),
  run: withSchema((ctx, input) => requestPrint(ctx, input)),
});

export const printReconcile = defineCommand({
  name: "print.reconcile",
  description: "Record what the printer actually produced for a job with an unknown outcome (after checking the printer).",
  permission: "print.reconcile",
  input: z.object({
    printJobId: id,
    expectedVersion: z.number().int().positive(),
    outcome: z.enum(["printed_ok", "not_printed", "printed_damaged", "cant_tell"]),
    note: text(1000).optional().default(""),
  }),
  run: withSchema((ctx, input) => reconcileJob(ctx, input)),
});

export const printReprint = defineCommand({
  name: "print.reprint",
  description: "Reprint a label for the same slide/block/case with a reason. Links the original job; never creates a new slide or block.",
  permission: "print.request",
  input: z.object({ printJobId: id, reason: text(500) }),
  run: withSchema((ctx, input) => reprintJob(ctx, input.printJobId, input.reason)),
});

export const printCancel = defineCommand({
  name: "print.cancel",
  description: "Cancel a planned or queued print job (nothing printed yet). Requires a reason.",
  permission: "print.request",
  input: z.object({ printJobId: id, reason: text(500) }),
  run: withSchema((ctx, input) => cancelJob(ctx, input.printJobId, input.reason)),
});

export const printRelease = defineCommand({
  name: "print.release",
  description: "Release a job kept in the queue while the (simulated) printer was unavailable, or every queued job for one printer.",
  permission: "print.request",
  input: z
    .object({ printJobId: id.optional(), printerId: id.optional() })
    .refine((v) => !!v.printJobId || !!v.printerId, { message: "Give a print job or a printer" }),
  run: withSchema((ctx, input) => (input.printJobId ? releaseJob(ctx, input.printJobId) : releaseQueuedForPrinter(ctx, input.printerId!))),
});

// ---------------------------------------------------------------- labels

export const labelApply = defineCommand({
  name: "label.apply",
  description: "Record that a printed label was physically applied (not yet verified).",
  permission: "label.apply",
  input: z.object({ labelId: id }),
  run: withSchema((ctx, input) => applyLabel(ctx, input.labelId)),
});

export const labelVerify = defineCommand({
  name: "label.verify",
  description: "Scan an applied label: it must decode and match its own record. Identifies the record; does not verify tissue.",
  permission: "label.apply",
  input: z.object({ labelId: id, scannedPayload: text(200) }),
  run: withSchema((ctx, input) => verifyLabel(ctx, input.labelId, input.scannedPayload)),
});

export const labelRetire = defineCommand({
  name: "label.retire",
  description: "Retire a physical label (damaged, replaced or not needed) with a reason.",
  permission: "label.retire",
  input: z.object({ labelId: id, reason: text(500) }),
  run: withSchema((ctx, input) => retireLabel(ctx, input.labelId, input.reason)),
});

// ---------------------------------------------------------------- bench progress (demo)

export const blockAdvance = defineCommand({
  name: "block.advance",
  description: "Record bench progress for blocks (forward only). Holds and gross approval are re-checked.",
  permission: "material.advance",
  input: z.object({ blockIds: z.array(id).min(1).max(100), toState: z.enum(BLOCK_STATE_ORDER as [string, ...string[]]) }),
  run: withSchema((ctx, input) => advanceBlocks(ctx, input.blockIds, input.toState as (typeof BLOCK_STATE_ORDER)[number])),
});

export const slideAdvance = defineCommand({
  name: "slide.advance",
  description: "Record bench progress for slides (forward only, up to QC reviewed). Delivery happens only through a tray.",
  permission: "material.advance",
  input: z.object({ slideIds: z.array(id).min(1).max(200), toState: z.enum(SLIDE_STATE_ORDER as [string, ...string[]]) }),
  run: withSchema((ctx, input) => advanceSlides(ctx, input.slideIds, input.toState as (typeof SLIDE_STATE_ORDER)[number])),
});

// ---------------------------------------------------------------- work orders

export const slideOrderAdditional = defineCommand({
  name: "slide.orderAdditional",
  description: "Order an additional slide (stain, level or recut): creates a work order and a new planned slide. Not a reprint.",
  permission: "workorder.review",
  input: z.object({ blockId: id, stain: text(40), level: text(40).optional().nullable(), reason: text(500) }),
  run: withSchema((ctx, input) => orderAdditionalSlide(ctx, input)),
});

export const workorderReviewSourceChange = defineCommand({
  name: "workorder.reviewSourceChange",
  description: "Record the review decision for a work order canceled or amended at the source after material was printed or prepared.",
  permission: "workorder.review",
  input: z.object({ workOrderId: id, decision: z.enum(["retain_prepared_material", "void_unprepared", "keep_active"]), note: text(1000) }),
  run: withSchema((ctx, input) => reviewSourceChange(ctx, input)),
});

// ---------------------------------------------------------------- trays

export const trayOpen = defineCommand({
  name: "tray.open",
  description: "Open a tray for one dermatopathologist; lists the slides ready for a tray. Each slide must then be scanned individually.",
  permission: "tray.assemble",
  input: z.object({ pathologistId: id }),
  run: withSchema((ctx, input) => openTray(ctx, input.pathologistId)),
});

export const trayScan = defineCommand({
  name: "tray.scan",
  description: "Scan one slide into a tray. Unexpected, duplicate, canceled or unknown material is flagged and not accepted.",
  permission: "tray.assemble",
  input: z.object({ trayId: id, payload: text(200) }),
  run: withSchema((ctx, input) => scanIntoTray(ctx, input.trayId, input.payload)),
});

export const trayResolveScan = defineCommand({
  name: "tray.resolveScan",
  description: "Resolve a flagged tray scan: removed from the tray, same slide scanned twice, or (supervisor) added to the expected list.",
  permission: "tray.assemble",
  input: z.object({ scanId: id, resolution: z.enum(["removed_from_tray", "same_slide_rescanned", "added_by_authorized_change"]) }),
  run: withSchema((ctx, input) => resolveTrayScan(ctx, input.scanId, input.resolution)),
});

export const traySetDisposition = defineCommand({
  name: "tray.setDisposition",
  description: "Record a controlled disposition for an expected slide that is not on the tray (follows separately / missing). Opens a task.",
  permission: "tray.assemble",
  input: z.object({ trayId: id, slideId: id, disposition: z.enum(["follows_separately", "missing_investigation"]), note: text(1000) }),
  run: withSchema((ctx, input) => setTrayDisposition(ctx, input.trayId, input.slideId, input.disposition, input.note)),
});

export const trayComplete = defineCommand({
  name: "tray.complete",
  description: "Mark a tray verified complete: only when every expected slide was scanned and nothing unexpected remains.",
  permission: "tray.assemble",
  input: z.object({ trayId: id, expectedVersion: z.number().int().positive() }),
  run: withSchema((ctx, input) => completeTray(ctx, input.trayId, input.expectedVersion)),
});

export const trayReleaseWithExceptions = defineCommand({
  name: "tray.releaseWithExceptions",
  description: "Supervisor only: release a tray with documented exceptions (never shown as verified complete).",
  permission: "tray.releaseWithExceptions",
  input: z.object({ trayId: id, note: text(1000) }),
  run: withSchema((ctx, input) => releaseTrayWithExceptions(ctx, input.trayId, input.note)),
});

export const trayDeliver = defineCommand({
  name: "tray.deliver",
  description: "Deliver a verified (or supervisor-released) tray; scanned slides become delivered.",
  permission: "tray.assemble",
  input: z.object({ trayId: id }),
  run: withSchema((ctx, input) => deliverTray(ctx, input.trayId)),
});

// ---------------------------------------------------------------- retrieval

export const retrievalCreate = defineCommand({
  name: "retrieval.create",
  description: "Request blocks from storage, in the order the receiving bench needs them.",
  permission: "retrieval.request",
  input: z.object({ blockIds: z.array(id).min(1).max(50), purpose: text(300), destination: text(120), workOrderId: id.optional().nullable() }),
  run: withSchema((ctx, input) => createRequest(ctx, input)),
});

export const retrievalScan = defineCommand({
  name: "retrieval.scan",
  description: "Scan a block against a retrieval request. A wrong block is rejected and only the mismatch is recorded.",
  permission: "retrieval.pick",
  input: z.object({ requestId: id, payload: text(200) }),
  run: withSchema((ctx, input) => scanForRequest(ctx, input.requestId, input.payload)),
});

export const retrievalMarkNotFound = defineCommand({
  name: "retrieval.markNotFound",
  description: "Record that a requested block is not at its last confirmed location; opens a missing-material investigation.",
  permission: "retrieval.pick",
  input: z.object({ itemId: id, note: text(1000) }),
  run: withSchema((ctx, input) => markNotFound(ctx, input.itemId, input.note)),
});

export const retrievalDeliver = defineCommand({
  name: "retrieval.deliver",
  description: "Hand picked blocks over at the request's destination.",
  permission: "retrieval.pick",
  input: z.object({ requestId: id }),
  run: withSchema((ctx, input) => deliverRequest(ctx, input.requestId)),
});

export const retrievalReturn = defineCommand({
  name: "retrieval.return",
  description: "Return a block to a storage slot (confirms this block's location only).",
  permission: "retrieval.pick",
  input: z.object({ blockId: id, locationCode: text(80) }),
  run: withSchema((ctx, input) => returnBlock(ctx, input.blockId, input.locationCode)),
});

export const __materialsCommands = [
  printRequest, printReconcile, printReprint, printCancel, printRelease, labelApply, labelVerify, labelRetire, blockAdvance, slideAdvance,
  slideOrderAdditional, workorderReviewSourceChange, trayOpen, trayScan, trayResolveScan, traySetDisposition, trayComplete,
  trayReleaseWithExceptions, trayDeliver, retrievalCreate, retrievalScan, retrievalMarkNotFound, retrievalDeliver, retrievalReturn,
] as const;
