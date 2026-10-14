import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { openTask } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { roleCan } from "@/lib/roles";
import { PRINT_STATE, type PrintState } from "@/lib/domain";
import { encodeLabel, humanLabel, namespaceCode, decodeLabel } from "@/lib/identifiers";
import { assertNotHeld, scopesForBlock, scopesForSlide, type Scope } from "./holds";
import { closeTasksForEntity, getBlock, getSlide, requireText, slideText, staffName, supervisorId } from "./material";
import { createLabelForJob, currentLabelFor } from "./labels";
import { defaultPrinterFor, getPrinter, PRINTER_KIND_FOR, simulateSubmit, type SimPrinter } from "../sim/printer";

/**
 * Print jobs linked to authoritative identifiers and authorized work.
 *
 *   planned → queued → submitted → acknowledged → completion_confirmed
 *   submitted → unknown_outcome (simulated timeout) → reconciled by a person
 *   acknowledged → (a person checks the output) completion_confirmed | failed | unknown_outcome
 *   planned | queued → canceled
 *
 * A printer acknowledgement is NOT proof that a label came out. A label row
 * (state "printed") exists only once completion is confirmed — by a printer
 * that reports completion, or by a person who checked the output.
 *
 * A job in flight (or with an unknown outcome) blocks another job for the
 * same target and label kind — also enforced by the print_job_one_in_flight
 * unique index. Once a label has been printed (or a job failed), printing it
 * again is only possible as a reprint of the LATEST job for that label, so the
 * chain stays linear: a reprint is a NEW job on the SAME target that records
 * the reason, operator and original job and never creates a slide or block.
 */

export type PrintTargetType = "slide" | "block" | "accession";
export type PrintKind = "slide_label" | "cassette_label" | "requisition_label";
export type ReconcileOutcome = "printed_ok" | "not_printed" | "printed_damaged" | "cant_tell";

export interface PrintJobRow {
  id: string;
  display_id: string;
  printer_id: string;
  kind: PrintKind;
  target_type: PrintTargetType;
  target_id: string;
  accession_id: string | null;
  payload: string;
  purpose: string;
  state: PrintState;
  reprint_of_job_id: string | null;
  reprint_reason: string | null;
  idempotency_key: string;
  requested_by: string;
  created_at: string;
  submitted_at: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  reconciled_by: string | null;
  reconciled_at: string | null;
  reconciliation: string | null;
  reconciliation_note: string | null;
  failure_detail: string | null;
  version: number;
}

export interface PrintResult {
  outcome: "created" | "duplicate_prevented";
  printJobId: string;
  displayId: string;
  state: PrintState;
  stateLabel: string;
  message: string;
  printerUnavailable?: boolean;
  labelId?: string | null;
  /** For a reprint of a damaged label: the old physical label that must be retired (explicit step). */
  retireLabelId?: string | null;
}

const IN_FLIGHT: PrintState[] = ["planned", "queued", "submitted", "acknowledged", "unknown_outcome"];

const EXPECTED_KIND: Record<PrintTargetType, PrintKind> = {
  slide: "slide_label",
  block: "cassette_label",
  accession: "requisition_label",
};

export function getPrintJob(db: DB, idOrDisplay: string): PrintJobRow | undefined {
  return db.prepare("SELECT * FROM print_job WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as PrintJobRow | undefined;
}

function mustJob(db: DB, idOrDisplay: string): PrintJobRow {
  const j = getPrintJob(db, idOrDisplay);
  if (!j) throw new DomainError("NOT_FOUND", `Print job ${idOrDisplay} was not found`);
  return j;
}

interface ResolvedTarget {
  payload: string;
  human: string;
  accessionId: string;
  scopes: Scope[];
}

/** The authoritative record a label is for, and why it may not be printable. */
function resolveTarget(db: DB, targetType: PrintTargetType, targetId: string, kind: PrintKind): ResolvedTarget {
  if (EXPECTED_KIND[targetType] !== kind) {
    throw new DomainError("VALIDATION", `A ${targetType} needs a ${EXPECTED_KIND[targetType].replace("_", " ")}, not a ${kind.replace("_", " ")}`);
  }
  if (targetType === "slide") {
    const s = getSlide(db, targetId);
    if (!s) throw new DomainError("NOT_FOUND", `Slide ${targetId} was not found`);
    if (s.status !== "active") {
      throw new DomainError(
        "BLOCKED",
        `${slideText(s)} is ${s.status === "canceled_needs_review" ? "awaiting review of a source change" : "void"}; no new label can be printed for it`,
      );
    }
    if (s.wo_status && !["requested", "in_progress", "completed"].includes(s.wo_status)) {
      throw new DomainError("BLOCKED", `${slideText(s)} belongs to ${s.wo_display}, which is ${s.wo_status.replace(/_/g, " ")}. Review the work order before printing.`);
    }
    return { payload: s.identifier, human: slideText(s), accessionId: s.accession_id, scopes: scopesForSlide(db, targetId) };
  }
  if (targetType === "block") {
    const b = getBlock(db, targetId);
    if (!b) throw new DomainError("NOT_FOUND", `Block ${targetId} was not found`);
    if (b.status !== "active") throw new DomainError("BLOCKED", `${b.accession_number} ${b.label_text} is void; no new label can be printed for it`);
    return { payload: b.identifier, human: `${b.accession_number} ${b.label_text}`, accessionId: b.accession_id, scopes: scopesForBlock(db, targetId) };
  }
  const a = db.prepare("SELECT id, accession_number, namespace FROM accession WHERE id = ?").get(targetId) as
    | { id: string; accession_number: string; namespace: string }
    | undefined;
  if (!a) throw new DomainError("NOT_FOUND", `Accession ${targetId} was not found`);
  const payload = encodeLabel({ kind: "C", namespace: namespaceCode(a.namespace), accession: a.accession_number });
  return { payload, human: a.accession_number, accessionId: a.id, scopes: [{ type: "accession", id: a.id }] };
}

function pickPrinter(db: DB, kind: PrintKind, printerId?: string | null): SimPrinter {
  const printer = printerId ? getPrinter(db, printerId) : defaultPrinterFor(db, kind);
  if (!printer) throw new DomainError("NOT_FOUND", printerId ? `Printer ${printerId} was not found` : `No printer is configured for ${kind.replace("_", " ")}s`);
  if (PRINTER_KIND_FOR[kind] !== printer.kind) {
    throw new DomainError("VALIDATION", `${printer.name} prints ${printer.kind} labels and cannot print a ${kind.replace("_", " ")}`);
  }
  return printer;
}

function inFlightJob(db: DB, targetType: string, targetId: string, kind: string): PrintJobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM print_job WHERE target_type = ? AND target_id = ? AND kind = ? AND state IN (${IN_FLIGHT.map(() => "?").join(",")})
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(targetType, targetId, kind, ...IN_FLIGHT) as PrintJobRow | undefined;
}

/** The newest job for a label that was not canceled before printing (the head of the reprint chain). */
export function latestJobFor(db: DB, targetType: string, targetId: string, kind: string): PrintJobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM print_job WHERE target_type = ? AND target_id = ? AND kind = ? AND state <> 'canceled'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(targetType, targetId, kind) as PrintJobRow | undefined;
}

function duplicateMessage(existing: PrintJobRow, human: string): string {
  switch (existing.state) {
    case "unknown_outcome":
      return `${existing.display_id} for ${human} has an unknown outcome. Reconcile it (check the printer output) before printing again. No new job was created.`;
    case "acknowledged":
      return `Already sent as ${existing.display_id}; the printer acknowledged it but does not report completion. Record what came out on ${existing.display_id} (printed / not printed / damaged) before printing again. No new job was created.`;
    default:
      return `Already in flight as ${existing.display_id} (${PRINT_STATE[existing.state]}). No second job was created.`;
  }
}

function duplicateResult(existing: PrintJobRow, human: string, ctx?: Ctx): PrintResult {
  if (ctx) {
    audit(ctx, {
      action: "print.duplicate_prevented",
      entityType: "print_job",
      entityId: existing.id,
      accessionId: existing.accession_id,
      summary: `Print request for ${human} by ${ctx.actor.name}: no second job created (${existing.display_id} is ${PRINT_STATE[existing.state]})`,
    });
  }
  return {
    outcome: "duplicate_prevented",
    printJobId: existing.id,
    displayId: existing.display_id,
    state: existing.state,
    stateLabel: PRINT_STATE[existing.state],
    message: duplicateMessage(existing, human),
  };
}

function setJob(db: DB, jobId: string, fields: Record<string, unknown>): void {
  updateVersioned(db, "print_job", jobId, undefined, fields);
}

/** Hand a planned/queued job to the simulated printer and apply the outcome. */
function dispatch(ctx: Ctx, jobId: string, replacesLabelId: string | null): { state: PrintState; message: string; printerUnavailable: boolean; labelId: string | null } {
  const job = mustJob(ctx.db, jobId);
  const printer = getPrinter(ctx.db, job.printer_id);
  if (!printer) throw new DomainError("NOT_FOUND", `Printer ${job.printer_id} was not found`);
  const human = labelTextOf(job);
  const sim = simulateSubmit(printer);
  if (sim.outcome === "unavailable") {
    setJob(ctx.db, jobId, { state: "queued", failure_detail: sim.detail });
    return { state: "queued", message: `${job.display_id} queued for ${human}. ${sim.detail}`, printerUnavailable: true, labelId: null };
  }
  if (sim.outcome === "timeout") {
    setJob(ctx.db, jobId, { state: "unknown_outcome", submitted_at: ctx.now, failure_detail: sim.detail });
    const canReconcile = roleCan(ctx.actor.role, "print.reconcile");
    openTask(ctx, {
      kind: "print_reconcile",
      entityType: "print_job",
      entityId: jobId,
      title: `Reconcile ${job.display_id} (${human}) — printer timed out after submission`,
      ownerId: canReconcile ? ctx.actor.id : null,
      ownerRole: "histotech",
      priority: "high",
      accessionId: job.accession_id,
      detail: sim.detail,
    });
    return {
      state: "unknown_outcome",
      message: `${job.display_id}: printer did not confirm after 30 s (simulated timeout). Outcome unknown. Check the printer output before retrying.`,
      printerUnavailable: false,
      labelId: null,
    };
  }
  const completed = sim.outcome === "completed";
  setJob(ctx.db, jobId, {
    state: completed ? "completion_confirmed" : "acknowledged",
    submitted_at: ctx.now,
    acknowledged_at: ctx.now,
    completed_at: completed ? ctx.now : null,
    failure_detail: null,
  });
  // Only a printer that reports completion produces a label record here. An acknowledgement
  // alone does not prove a label came out: a person confirms the output first (reconcile).
  const labelId = completed ? createLabelForJob(ctx, job, replacesLabelId) : null;
  return {
    state: completed ? "completion_confirmed" : "acknowledged",
    message: completed
      ? `${job.display_id} for ${human}: ${sim.detail}`
      : `${job.display_id} for ${human}: ${sim.detail} Record "Label printed" once you have the label in hand.`,
    printerUnavailable: false,
    labelId,
  };
}

function labelTextOf(job: Pick<PrintJobRow, "payload">): string {
  const d = decodeLabel(job.payload);
  return d.ok ? humanLabel(d.identity) : job.payload;
}

function insertJob(
  ctx: Ctx,
  j: { printer: SimPrinter; kind: PrintKind; targetType: PrintTargetType; targetId: string; accessionId: string; payload: string; purpose: string; reprintOf?: string | null; reprintReason?: string | null },
): PrintJobRow {
  const id = newId(ctx.db, "pj");
  const display = displayId(ctx.db, "PJ", 4);
  ctx.db
    .prepare(
      `INSERT INTO print_job (id, display_id, printer_id, kind, target_type, target_id, accession_id, payload, purpose, state,
        reprint_of_job_id, reprint_reason, idempotency_key, requested_by, created_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id, display, j.printer.id, j.kind, j.targetType, j.targetId, j.accessionId, j.payload, j.purpose,
      j.reprintOf ?? null, j.reprintReason ?? null, `job:${id}`, ctx.actor.id, ctx.now,
    );
  // planned → queued (handed to the print queue)
  setJob(ctx.db, id, { state: "queued" });
  return mustJob(ctx.db, id);
}

// ---------------------------------------------------------------- commands

export interface RequestPrintInput {
  targetType: PrintTargetType;
  targetId: string;
  kind: PrintKind;
  purpose?: string;
  reprintOfJobId?: string;
  reprintReason?: string;
  printerId?: string;
}

export function requestPrint(ctx: Ctx, input: RequestPrintInput): PrintResult {
  if (input.reprintOfJobId) {
    const original = mustJob(ctx.db, input.reprintOfJobId);
    if (original.target_type !== input.targetType || original.target_id !== input.targetId || original.kind !== input.kind) {
      throw new DomainError("VALIDATION", `${original.display_id} was for a different label; a reprint always targets the same record`);
    }
    return reprintJob(ctx, original.id, input.reprintReason ?? "", input.printerId);
  }
  const target = resolveTarget(ctx.db, input.targetType, input.targetId, input.kind);
  assertNotHeld(ctx.db, "print", target.scopes, `Printing label ${target.human}`);

  const existing = inFlightJob(ctx.db, input.targetType, input.targetId, input.kind);
  if (existing) return duplicateResult(existing, target.human, ctx);

  const lastJob = latestJobFor(ctx.db, input.targetType, input.targetId, input.kind);
  const label = currentLabelFor(ctx.db, input.targetType, input.targetId);
  if (label) {
    // A physical label is already on record: a second plain print would be an uncontrolled duplicate.
    // Point at the head of the reprint chain: that is the job a reprint must start from.
    const job = lastJob ?? (label.print_job_id ? getPrintJob(ctx.db, label.print_job_id) : undefined);
    if (!job) {
      throw new DomainError("BLOCKED", `A label for ${target.human} is already recorded (${label.state}). Retire it with a reason before printing a replacement. No new job was created.`);
    }
    const res = duplicateResult(job, target.human, ctx);
    return {
      ...res,
      message: `A label for ${target.human} already exists (${job.display_id}, label ${label.state}). To print it again, use "Reprint with reason" on ${job.display_id}. No new job was created.`,
    };
  }

  // A label that was printed before (and since retired) or whose last job failed / was reconciled
  // "not printed" is printed again only as a reprint with a reason, linked to the latest job.
  if (lastJob) {
    throw new DomainError(
      "BLOCKED",
      lastJob.state === "failed"
        ? `${lastJob.display_id} for ${target.human} did not print. Use "Reprint with reason" on ${lastJob.display_id} so the new job is linked to it. No new job was created.`
        : `${target.human} was already printed by ${lastJob.display_id}. Use "Reprint with reason" on ${lastJob.display_id} so the new job is linked to it. No new job was created.`,
      { printJobId: lastJob.id, displayId: lastJob.display_id },
    );
  }

  const printer = pickPrinter(ctx.db, input.kind, input.printerId);
  const purpose = input.purpose === "additional_work" ? "additional_work" : "initial";
  const job = insertJob(ctx, { printer, kind: input.kind, targetType: input.targetType, targetId: input.targetId, accessionId: target.accessionId, payload: target.payload, purpose });
  const d = dispatch(ctx, job.id, null);
  audit(ctx, {
    action: "print.requested",
    entityType: "print_job",
    entityId: job.id,
    accessionId: target.accessionId,
    summary: `${job.display_id} requested for ${target.human} on ${printer.name}: ${PRINT_STATE[d.state]}`,
    after: { state: d.state, printer: printer.id, purpose },
  });
  return {
    outcome: "created",
    printJobId: job.id,
    displayId: job.display_id,
    state: d.state,
    stateLabel: PRINT_STATE[d.state],
    message: d.message,
    printerUnavailable: d.printerUnavailable,
    labelId: d.labelId,
  };
}

/** Release a job kept in the queue while the printer was unavailable. */
export function releaseJob(ctx: Ctx, printJobId: string): PrintResult {
  const job = mustJob(ctx.db, printJobId);
  const human = labelTextOf(job);
  if (job.state !== "queued" && job.state !== "planned") {
    return { ...duplicateResult(job, human), message: `${job.display_id} is ${PRINT_STATE[job.state]}, not waiting in the queue. Nothing changed.` };
  }
  const d = dispatch(ctx, job.id, replacedLabelFor(ctx.db, job));
  audit(ctx, {
    action: "print.released",
    entityType: "print_job",
    entityId: job.id,
    accessionId: job.accession_id,
    summary: `${job.display_id} released from the queue for ${human}: ${PRINT_STATE[d.state]}`,
  });
  return {
    outcome: "created",
    printJobId: job.id,
    displayId: job.display_id,
    state: d.state,
    stateLabel: PRINT_STATE[d.state],
    message: d.message,
    printerUnavailable: d.printerUnavailable,
    labelId: d.labelId,
  };
}

/** Release every queued job for one printer (after it is back). */
export function releaseQueuedForPrinter(ctx: Ctx, printerId: string): { released: PrintResult[]; message: string } {
  const jobs = ctx.db.prepare("SELECT id FROM print_job WHERE printer_id = ? AND state IN ('planned','queued') ORDER BY created_at").all(printerId) as { id: string }[];
  const released = jobs.map((j) => releaseJob(ctx, j.id));
  const stillQueued = released.filter((r) => r.state === "queued").length;
  return {
    released,
    message: !jobs.length
      ? "No queued jobs for this printer."
      : stillQueued
        ? `${stillQueued} of ${jobs.length} job(s) still queued: the printer is still unavailable (simulated).`
        : `${jobs.length} queued job(s) released to the printer (simulated).`,
  };
}

/** For a reprint: the label the new one replaces (the original job's label, when one exists). */
function replacedLabelFor(db: DB, job: PrintJobRow): string | null {
  if (!job.reprint_of_job_id) return null;
  const r = db.prepare("SELECT id FROM label WHERE print_job_id = ?").get(job.reprint_of_job_id) as { id: string } | undefined;
  return r?.id ?? null;
}

export interface ReconcileInput {
  printJobId: string;
  expectedVersion: number;
  outcome: ReconcileOutcome;
  note?: string;
}

const OUTCOME_TEXT: Record<ReconcileOutcome, string> = {
  printed_ok: "Label printed (checked at the printer)",
  not_printed: "Not printed (checked at the printer)",
  printed_damaged: "Printed but damaged or unreadable",
  cant_tell: "Can't tell — escalated to a supervisor",
};

/**
 * A person checks the printer and records what came out. Required before any
 * retry of a job with an unknown outcome, and the only way a job that was just
 * acknowledged (by a printer that does not report completion) gets a label
 * record. "Can't tell" keeps (or puts) the job in Unknown outcome and hands the
 * check to a supervisor. A person's check is recorded as reconciled_by/at; it
 * is never written as a printer timestamp.
 */
export function reconcileJob(ctx: Ctx, input: ReconcileInput): PrintResult {
  const job = mustJob(ctx.db, input.printJobId);
  const human = labelTextOf(job);
  const note = (input.note ?? "").trim();
  if (job.state !== "unknown_outcome" && job.state !== "acknowledged") {
    throw new DomainError(
      "INVARIANT",
      `${job.display_id} is ${PRINT_STATE[job.state]}; only a job with an unknown outcome, or one the printer acknowledged without confirming completion, is checked here`,
    );
  }
  if ((input.outcome === "cant_tell" || input.outcome === "printed_damaged") && !note) {
    throw new DomainError("VALIDATION", input.outcome === "cant_tell" ? "Describe what you checked so the supervisor can follow up" : "Describe the damage (for example: smudged code, torn label)");
  }
  const base = { reconciled_by: ctx.actor.id, reconciled_at: ctx.now, reconciliation: input.outcome, reconciliation_note: note || null };
  let labelId: string | null = null;
  let message: string;
  let state: PrintState = job.state;
  switch (input.outcome) {
    case "printed_ok":
    case "printed_damaged": {
      state = "completion_confirmed";
      // Confirmed by a person who checked the output: acknowledged_at / completed_at stay as the printer left them.
      updateVersioned(ctx.db, "print_job", job.id, input.expectedVersion, { ...base, state });
      labelId = createLabelForJob(ctx, job, replacedLabelFor(ctx.db, job));
      closeTasksForEntity(ctx, "print_reconcile", job.id);
      closeTasksForEntity(ctx, "print_escalation", job.id);
      if (input.outcome === "printed_damaged") {
        openTask(ctx, {
          kind: "print_reprint",
          entityType: "print_job",
          entityId: job.id,
          title: `Retire the damaged label from ${job.display_id} and reprint (${human})`,
          ownerId: ctx.actor.id,
          ownerRole: "histotech",
          priority: "high",
          accessionId: job.accession_id,
        });
        message = `${job.display_id} recorded as printed but damaged (checked by ${ctx.actor.name}). Retire the damaged label and reprint with a reason.`;
      } else {
        message = `${job.display_id}: label printed (checked by ${ctx.actor.name}). Apply it, then scan to verify.`;
      }
      break;
    }
    case "not_printed": {
      state = "failed";
      updateVersioned(ctx.db, "print_job", job.id, input.expectedVersion, { ...base, state });
      closeTasksForEntity(ctx, "print_reconcile", job.id);
      closeTasksForEntity(ctx, "print_escalation", job.id);
      message = `${job.display_id}: not printed (checked by ${ctx.actor.name}). Retry is now allowed (reprint with a reason).`;
      break;
    }
    case "cant_tell": {
      state = "unknown_outcome";
      updateVersioned(ctx.db, "print_job", job.id, input.expectedVersion, { ...base, state });
      // The operator's check is done; the next step belongs to the supervisor.
      closeTasksForEntity(ctx, "print_reconcile", job.id);
      openTask(ctx, {
        kind: "print_escalation",
        entityType: "print_job",
        entityId: job.id,
        title: `${job.display_id} (${human}): operator could not tell whether the label printed — supervisor check`,
        ownerId: supervisorId(ctx.db),
        ownerRole: "supervisor",
        priority: "high",
        accessionId: job.accession_id,
        detail: note,
      });
      message = `${job.display_id} is "Unknown outcome" and was escalated to a supervisor. No retry until someone confirms what printed.`;
      break;
    }
  }
  audit(ctx, {
    action: "print.reconciled",
    entityType: "print_job",
    entityId: job.id,
    accessionId: job.accession_id,
    summary: `${job.display_id} (${human}) checked by ${ctx.actor.name}: ${OUTCOME_TEXT[input.outcome]}`,
    before: { state: job.state },
    after: { state, reconciliation: input.outcome },
    reason: note || null,
  });
  return { outcome: "created", printJobId: job.id, displayId: job.display_id, state, stateLabel: PRINT_STATE[state], message, labelId };
}

/**
 * Reprint: a new job for the same target, from the LATEST job for that label
 * only (the chain stays linear, so two reprints of one original cannot both
 * produce live labels). Requires a reason; records the operator and the
 * original job; never creates a slide or block.
 */
export function reprintJob(ctx: Ctx, printJobId: string, reason: string, printerId?: string | null): PrintResult {
  const why = requireText(reason, "A reprint needs a reason (for example: label smudged, printer jam, not printed)");
  const original = mustJob(ctx.db, printJobId);
  const human = labelTextOf(original);
  if (original.state === "unknown_outcome") {
    throw new DomainError(
      "BLOCKED",
      `${original.display_id} has an unknown outcome. Reconcile it first (Label printed / Not printed / Can't tell). No reprint was created.`,
      { printJobId: original.id },
    );
  }
  if (original.state === "planned" || original.state === "queued" || original.state === "submitted") {
    throw new DomainError("BLOCKED", `${original.display_id} is still ${PRINT_STATE[original.state].toLowerCase()}. Cancel it or wait; no reprint was created.`);
  }
  if (original.state === "canceled") {
    throw new DomainError("BLOCKED", `${original.display_id} was canceled before printing. Use "Print label" instead of a reprint.`);
  }
  const target = resolveTarget(ctx.db, original.target_type, original.target_id, original.kind);
  assertNotHeld(ctx.db, "print", target.scopes, `Reprinting label ${human}`);
  const other = inFlightJob(ctx.db, original.target_type, original.target_id, original.kind);
  if (other && other.id !== original.id) return duplicateResult(other, human, ctx);
  const head = latestJobFor(ctx.db, original.target_type, original.target_id, original.kind);
  if (head && head.id !== original.id) {
    throw new DomainError(
      "BLOCKED",
      `${original.display_id} was already replaced by ${head.display_id} (${PRINT_STATE[head.state]}). If that label also needs replacing, reprint from ${head.display_id}. No reprint was created.`,
      { printJobId: head.id, displayId: head.display_id },
    );
  }

  const oldLabel = ctx.db.prepare("SELECT id, state, applied_by, applied_at FROM label WHERE print_job_id = ?").get(original.id) as
    | { id: string; state: string; applied_by: string | null; applied_at: string | null }
    | undefined;
  if (original.state === "acknowledged") {
    if (!oldLabel || oldLabel.state === "retired") {
      throw new DomainError(
        "BLOCKED",
        `${original.display_id} was acknowledged by the printer, but nobody has recorded what came out. Record "Label printed", "Printed but damaged" or "Not printed" on ${original.display_id} first. No reprint was created.`,
        { printJobId: original.id, needsOutputCheck: true },
      );
    }
    // The label from this job is on record (printed/applied/verified): its output is confirmed by that
    // record, not by the reprint reason. Close the job so the replacement is not blocked as "in flight".
    updateVersioned(ctx.db, "print_job", original.id, undefined, {
      state: "completion_confirmed",
      reconciled_by: ctx.actor.id,
      reconciled_at: ctx.now,
      reconciliation: "printed_ok",
      reconciliation_note: `Label from ${original.display_id} is on record (${oldLabel.state}${oldLabel.applied_at ? `, applied by ${staffName(ctx.db, oldLabel.applied_by) ?? "Unknown"}` : ""}); output confirmed from that record when a replacement was requested`,
    });
  }

  let purpose: string;
  let retireLabelId: string | null = null;
  let replacesLabelId: string | null = null;
  if (original.state === "failed") {
    purpose = original.reconciliation === "not_printed" ? "reprint_after_unknown" : "reprint_after_failure";
  } else {
    // A label from the original job exists (or existed): the new one replaces it.
    purpose = "reprint_damaged";
    replacesLabelId = oldLabel?.id ?? null;
    if (oldLabel && oldLabel.state !== "retired") {
      retireLabelId = oldLabel.id;
      openTask(ctx, {
        kind: "label_retire",
        entityType: "label",
        entityId: oldLabel.id,
        title: `Retire the replaced label from ${original.display_id} (${human})`,
        ownerId: ctx.actor.id,
        ownerRole: "histotech",
        priority: "high",
        accessionId: original.accession_id,
        detail: `Reprint reason: ${why}`,
      });
    }
  }

  const printer = printerId ? pickPrinter(ctx.db, original.kind, printerId) : (getPrinter(ctx.db, original.printer_id) ?? pickPrinter(ctx.db, original.kind));
  const job = insertJob(ctx, {
    printer, kind: original.kind, targetType: original.target_type, targetId: original.target_id, accessionId: target.accessionId,
    payload: target.payload, purpose, reprintOf: original.id, reprintReason: why,
  });
  const d = dispatch(ctx, job.id, replacesLabelId);
  closeTasksForEntity(ctx, "print_reprint", original.id);
  audit(ctx, {
    action: "print.reprinted",
    entityType: "print_job",
    entityId: job.id,
    accessionId: target.accessionId,
    summary: `${job.display_id} reprint of ${original.display_id} for ${human} by ${ctx.actor.name}: ${PRINT_STATE[d.state]}. Same ${original.target_type}; no new specimen, block or slide.`,
    reason: why,
    after: { state: d.state, reprint_of: original.display_id, purpose },
  });
  return {
    outcome: "created",
    printJobId: job.id,
    displayId: job.display_id,
    state: d.state,
    stateLabel: PRINT_STATE[d.state],
    message: `${job.display_id} is a reprint of ${original.display_id}. ${d.message}${retireLabelId ? " Retire the old label before applying the new one." : ""}`,
    printerUnavailable: d.printerUnavailable,
    labelId: d.labelId,
    retireLabelId,
  };
}

export function cancelJob(ctx: Ctx, printJobId: string, reason: string): PrintResult {
  const why = requireText(reason, "A reason is required to cancel a print job");
  const job = mustJob(ctx.db, printJobId);
  const human = labelTextOf(job);
  if (job.state === "canceled") return { ...duplicateResult(job, human), message: `${job.display_id} was already canceled. Nothing changed.` };
  if (job.state !== "planned" && job.state !== "queued") {
    throw new DomainError(
      "BLOCKED",
      `${job.display_id} was already sent to the printer (${PRINT_STATE[job.state]}). ${job.state === "unknown_outcome" ? "Reconcile it instead." : "It can no longer be canceled."}`,
    );
  }
  updateVersioned(ctx.db, "print_job", job.id, undefined, { state: "canceled", failure_detail: `Canceled: ${why}` });
  audit(ctx, {
    action: "print.canceled",
    entityType: "print_job",
    entityId: job.id,
    accessionId: job.accession_id,
    summary: `${job.display_id} for ${human} canceled before printing`,
    reason: why,
  });
  return { outcome: "created", printJobId: job.id, displayId: job.display_id, state: "canceled", stateLabel: PRINT_STATE.canceled, message: `${job.display_id} canceled. Nothing was printed.` };
}

/** Cancel queued/planned jobs for a target (used when work is canceled). */
export function cancelPendingJobsFor(ctx: Ctx, targetType: string, targetId: string, reason: string): string[] {
  const jobs = ctx.db
    .prepare("SELECT id FROM print_job WHERE target_type = ? AND target_id = ? AND state IN ('planned','queued')")
    .all(targetType, targetId) as { id: string }[];
  return jobs.map((j) => cancelJob(ctx, j.id, reason).displayId);
}
