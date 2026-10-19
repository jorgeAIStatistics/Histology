import { z } from "zod";
import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { openTask } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { getSetting, setSetting } from "../core/settings";
import { holdPartForSourceAmendment } from "./correction";
import { fmtTime } from "@/lib/time";
import { log } from "../core/log";
import { LATERALITY } from "@/lib/domain";
import { isAccessionMessageType } from "../integration/accession-schemas";
import { processAccessionMessage } from "../integration/accession-messages";

/**
 * Inbound import from a SIMULATED source system (S6).
 *
 * Every message is namespaced by the source's tenant. The pipeline decides, in
 * this order:
 *   1. duplicate message id           → duplicate_ignored (receipt counted, nothing else changes)
 *   2. payload invalid / unprocessable → failed (kept in the failure queue, retryable)
 *   3. version <= stored version       → stale_ignored (an older update never overwrites a newer one)
 *   4. unknown order (known tenant)    → applied: the order is created
 *   5. newer version                   → applied: new immutable version stored, working values
 *                                        updated, affected local work reconciled (never erased)
 *
 * Imported text (clinical notes, sites) is stored and displayed as DATA. It is
 * never interpreted as an instruction and cannot change roles or permissions.
 * Nothing here writes back to the source: local completion never implies a
 * source-system write.
 *
 * Stage 6 Phase D (contract "hlos.source-message" 1.0, docs/release/integration-contract.md):
 * every inbound path (the HTTP endpoint and the in-process pump) reaches this
 * function through src/server/integration/inbound.ts handleEnvelope. It now
 * also takes `specimen.submitted` (an order snapshot that names the specimen
 * lines the source recorded as sent) and dispatches `accession.issued` /
 * `accession.acknowledged` to src/server/integration/accession-messages.ts,
 * inside the same duplicate → failed → applied pipeline. The envelope's
 * `sent_at` (the source's claimed event time) is stored as
 * integration_event.source_updated_at; received_at stays the local time.
 */

// ------------------------------------------------------------------ payload

const nullableString = z.string().nullable().optional();

const SpecimenSchema = z.object({
  designation: z.string().trim().min(1).max(4),
  site: z.string().trim().min(1).max(200),
  laterality: nullableString,
  procedure: nullableString,
  collected_at: nullableString,
  expected_containers: z.number().int().min(0).max(20).nullable().optional(),
  requested_stains: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  orientation: nullableString,
});

export const SimulatedOrderSchema = z.object({
  resourceType: z.literal("SimulatedOrder").optional(),
  order_id: z.string().trim().min(1).max(64),
  version: z.number().int().min(1),
  updated_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "updated_at must be an ISO timestamp"),
  status: z.enum(["active", "amended", "canceled"]).optional(),
  patient: z.object({
    mrn: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    birth_date: z.string().trim().min(1).max(20),
  }),
  encounter_id: nullableString,
  office_id: z.string().trim().min(1).max(40),
  /** Optional display name the source sends with the office id (used only to label a new, unreviewed office). */
  office_name: z.string().trim().min(1).max(120).nullable().optional(),
  ordering_provider_id: nullableString,
  clinical_note: nullableString,
  amendment_note: nullableString,
  specimens: z.array(SpecimenSchema).max(26),
});
export type SimulatedOrder = z.infer<typeof SimulatedOrderSchema>;
type Specimen = z.infer<typeof SpecimenSchema>;

/**
 * `specimen.submitted`: the full order snapshot (same schema, same versioning) plus the specimen lines the
 * source recorded as sent with this version and how many containers. Each named line must be on the order,
 * and its container count must equal the line's expected_containers when that is given. It is imported as an
 * order version (a new line → part_added; after accession → a review task, no part is created). It never
 * marks a container as received here: receipt is a local, staff-attested event.
 */
export const SpecimenSubmittedSchema = SimulatedOrderSchema.extend({
  submitted: z
    .array(z.object({ designation: z.string().trim().min(1).max(4), containers: z.number().int().min(1).max(20) }))
    .min(1)
    .max(26),
}).superRefine((p, ctx) => {
  if (p.status === "canceled") {
    ctx.addIssue({ code: "custom", path: ["status"], message: "A canceled order cannot submit specimens; send order.cancel instead." });
  }
  const seen = new Set<string>();
  p.submitted.forEach((s, i) => {
    const key = s.designation.toUpperCase();
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["submitted", i, "designation"], message: "Named twice in submitted." });
    seen.add(key);
    const line = p.specimens.find((x) => x.designation.toUpperCase() === key);
    if (!line) {
      ctx.addIssue({ code: "custom", path: ["submitted", i, "designation"], message: "Names no specimen line on this order version." });
    } else if (line.expected_containers !== null && line.expected_containers !== undefined && line.expected_containers !== s.containers) {
      ctx.addIssue({ code: "custom", path: ["submitted", i, "containers"], message: "Differs from that specimen line's expected_containers." });
    }
  });
});

/** Order-snapshot message types the order importer applies itself (accession.* are dispatched; see above). */
export const SUPPORTED_MESSAGE_TYPES = ["order.upsert", "order.amend", "order.cancel", "specimen.submitted"] as const;

export interface SourceMessage {
  messageId: string;
  messageType: string;
  /** Object or JSON text. Stored verbatim either way. */
  payload: unknown;
  /**
   * The source's claimed event time (contract envelope `sent_at`). Stored as integration_event.source_updated_at.
   * Absent (direct callers): the payload's own updated_at, as before.
   */
  sentAt?: string | null;
}

export type ImportOutcome = "applied" | "duplicate_ignored" | "stale_ignored" | "failed";

export interface ReconciliationNote {
  kind:
    | "order_created"
    | "working_values_updated"
    | "work_order_cancel_review"
    | "work_order_canceled"
    | "work_order_added"
    | "correction_review_opened"
    | "lead_review_task"
    | "receipt_recheck_task"
    | "clarification_linked"
    | "part_added"
    | "part_canceled"
    | "order_canceled_review"
    | "patient_conflict"
    | "order_level_review"
    | "order_values_updated"
    | "correction_review_updated"
    | "new_office_review"
    | "content_conflict_review"
    | "accession_confirmed"
    | "accession_acknowledged"
    | "accession_mismatch_review";
  summary: string;
  ref?: string;
}

/** Notes that only describe what changed; every other kind opened (or is) a review item. */
export const INFO_ONLY: ReadonlySet<ReconciliationNote["kind"]> = new Set([
  "working_values_updated",
  "order_values_updated",
  "part_added",
  "clarification_linked",
  "correction_review_updated",
  "order_created",
  "accession_confirmed",
  "accession_acknowledged",
]);
/** Notes that opened a task or review for a person. */
export const OPENS_REVIEW: ReadonlySet<ReconciliationNote["kind"]> = new Set([
  "work_order_cancel_review",
  "work_order_added",
  "correction_review_opened",
  "lead_review_task",
  "receipt_recheck_task",
  "order_canceled_review",
  "patient_conflict",
  "order_level_review",
  "new_office_review",
  "content_conflict_review",
  "accession_mismatch_review",
]);

export interface ImportResult {
  outcome: ImportOutcome;
  eventId: string;
  messageId: string;
  detail: string;
  orderId?: string;
  sourceOrderId?: string;
  version?: number;
  previousVersion?: number;
  receiptCount?: number;
  reconciliation: ReconciliationNote[];
}

/** How a delivery reached the importer: the in-process pump, a demo replay, a staff retry, a sync, or the inbound contract endpoint. */
export type ReceiptVia = "pump" | "replay" | "retry" | "sync" | "inbound";

class ImportFailure extends Error {}

interface SourceRow {
  id: string;
  name: string;
  tenant_id: string | null;
  status: string;
}

interface EventRow {
  id: string;
  source_id: string;
  message_id: string;
  message_type: string;
  outcome: string;
  detail: string | null;
  payload: string;
  receipt_count: number;
  received_at: string;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  source_order_id: string;
  patient_ref_id: string;
  office_id: string;
  encounter_id: string | null;
  ordering_clinician_id: string | null;
  source_status: string;
  source_version: number;
  source_updated_at: string;
  review_state: string;
  clinical_note: string | null;
  version: number;
}

interface OrderPartRow {
  id: string;
  source_order_id: string;
  designation: string;
  site_text: string;
  site_normalized: string | null;
  laterality: string | null;
  procedure: string | null;
  orientation_note: string | null;
  collected_at: string | null;
  expected_containers: number | null;
  requested_stains: string;
  status: string;
}

// ------------------------------------------------------------------ public API

/**
 * Import one message from a simulated source. Never throws for bad data: an
 * unprocessable message is recorded with outcome `failed` (failure queue).
 * Throws only for programming errors (unknown source id).
 */
export function importSourceMessage(ctx: Ctx, sourceId: string, message: SourceMessage, opts: { via?: ReceiptVia } = {}): ImportResult {
  const db = ctx.db;
  const via = opts.via ?? "pump";
  const source = db.prepare("SELECT id, name, tenant_id, status FROM integration_source WHERE id = ?").get(sourceId) as SourceRow | undefined;
  if (!source) throw new DomainError("NOT_FOUND", `Integration source ${sourceId} was not found`);
  const payloadText = typeof message.payload === "string" ? message.payload : JSON.stringify(message.payload ?? null);
  const messageId = String(message.messageId ?? "").trim();
  const messageType = String(message.messageType ?? "").trim() || "unknown";
  const sentAt = typeof message.sentAt === "string" && message.sentAt.trim() ? message.sentAt.trim() : null;

  const existing = messageId
    ? (db.prepare("SELECT * FROM integration_event WHERE source_id = ? AND message_id = ?").get(sourceId, messageId) as EventRow | undefined)
    : undefined;

  // 1. Duplicate message id: count the receipt, change nothing else.
  if (existing && existing.outcome !== "failed") {
    db.prepare("UPDATE integration_event SET receipt_count = receipt_count + 1 WHERE id = ?").run(existing.id);
    const count = existing.receipt_count + 1;
    const detail = `Duplicate of message ${messageId} (first received ${fmtTime(existing.received_at)} ET, outcome ${existing.outcome.replace(/_/g, " ")}). Receipt #${count} ignored; nothing changed.`;
    audit(ctx, {
      action: "integration.duplicate_ignored",
      entityType: "integration_event",
      entityId: existing.id,
      sourceRef: `${sourceId}:${messageId}:v${(existing as { source_version?: number | null }).source_version ?? "?"}`,
      summary: `${source.name}: duplicate message ${messageId} ignored (receipt #${count})`,
      before: { receiptCount: existing.receipt_count, outcome: existing.outcome },
      after: { receiptCount: count, outcome: existing.outcome, sourceId, messageId, messageType, eventId: existing.id, via },
    });
    logReceipt(ctx, { eventId: existing.id, sourceId, messageId, messageType, outcome: "duplicate_ignored", detail, via });
    return { outcome: "duplicate_ignored", eventId: existing.id, messageId, detail, receiptCount: count, reconciliation: [] };
  }

  const eventId = existing?.id ?? newId(db, "ie");
  const isRetry = Boolean(existing);

  let result: ImportResult;
  try {
    if (!messageId) throw new ImportFailure("Message has no message id; it cannot be de-duplicated, so it was not applied.");
    // Demo fault injection: "simulate a processing failure on the next message".
    const failKey = `s6_fail_next_import:${sourceId}`;
    if (!isRetry && getSetting(db, failKey) === "1") {
      setSetting(db, failKey, "0", ctx.now);
      throw new ImportFailure("Simulated processing error (demo control: fail next message). The message was received but not applied. Retry it from the failure queue.");
    }
    // Nested transaction = savepoint: a failure rolls back every partial change
    // (including the integration_event row), so the failure path below never collides with it.
    result = db.transaction(() => processMessage(ctx, source, { eventId, messageId, messageType, payloadText, isRetry, existing, sentAt }))();
  } catch (e) {
    result = recordFailure(ctx, source, { eventId, messageId, messageType, payloadText, existing, sentAt }, e);
  }
  // The receipt is a log line written after the outcome is settled; logging can never undo or fail the import.
  logReceipt(ctx, { eventId, sourceId, messageId: result.messageId || `missing-id:${eventId}`, messageType, outcome: result.outcome, detail: result.detail, via });
  return result;
}

function recordFailure(
  ctx: Ctx,
  source: SourceRow,
  m: { eventId: string; messageId: string; messageType: string; payloadText: string; existing?: EventRow; sentAt?: string | null },
  e: unknown,
): ImportResult {
  const db = ctx.db;
  const detail =
    e instanceof ImportFailure || e instanceof DomainError ? e.message : `Unexpected processing error: ${e instanceof Error ? e.message : String(e)}`;
  if (!(e instanceof ImportFailure) && !(e instanceof DomainError)) log("error", "import.unexpected_error", { correlationId: ctx.correlationId, sourceId: source.id, messageId: m.messageId, error: e });
  const entityKey = guessEntityKey(source, m.payloadText);
  const storedMessageId = m.messageId || `missing-id:${m.eventId}`;
  if (m.existing) {
    db.prepare("UPDATE integration_event SET detail = ?, receipt_count = receipt_count + 1 WHERE id = ?").run(
      `${detail} (retry at ${fmtTime(ctx.now)} ET failed)`,
      m.existing.id,
    );
  } else {
    // Upsert: even if a row with this id somehow exists, the failure is recorded instead of throwing.
    db.prepare(
      `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, 1)
       ON CONFLICT(source_id, message_id) DO UPDATE SET outcome = 'failed', detail = excluded.detail, receipt_count = receipt_count + 1`,
    ).run(m.eventId, source.id, storedMessageId, m.messageType, entityKey.key, entityKey.version, m.sentAt ?? entityKey.updatedAt, ctx.now, detail, m.payloadText);
  }
  audit(ctx, {
    action: "integration.import_failed",
    entityType: "integration_event",
    entityId: m.eventId,
    sourceRef: `${source.id}:${storedMessageId}:v${entityKey.version ?? "?"}`,
    summary: `${source.name}: message ${m.messageId || "(no id)"} could not be applied — kept in the failure queue`,
    reason: detail,
    before: m.existing ? { outcome: m.existing.outcome, receiptCount: m.existing.receipt_count } : undefined,
    after: { outcome: "failed", sourceId: source.id, messageId: storedMessageId, messageType: m.messageType, eventId: m.eventId, entityKey: entityKey.key, sourceVersion: entityKey.version },
  });
  return { outcome: "failed", eventId: m.eventId, messageId: m.messageId, detail, reconciliation: [] };
}

// ------------------------------------------------------------------ processing

interface ProcessInput {
  eventId: string;
  messageId: string;
  messageType: string;
  payloadText: string;
  isRetry: boolean;
  existing?: EventRow;
  /** The source's claimed event time (envelope sent_at); null → the payload's updated_at. */
  sentAt?: string | null;
}

function processMessage(ctx: Ctx, source: SourceRow, m: ProcessInput): ImportResult {
  const db = ctx.db;
  if (!source.tenant_id) throw new ImportFailure(`${source.name} has no source tenant, so its identifiers have no namespace. Message not applied.`);
  // accession.issued / accession.acknowledged: compared with the local record and recorded; never issue or renumber.
  if (isAccessionMessageType(m.messageType)) return processAccessionMessage(ctx, source, m);
  if (!(SUPPORTED_MESSAGE_TYPES as readonly string[]).includes(m.messageType)) {
    throw new ImportFailure(`Unsupported message type "${m.messageType}". Supported: ${[...SUPPORTED_MESSAGE_TYPES, "accession.issued", "accession.acknowledged"].join(", ")}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(m.payloadText);
  } catch {
    throw new ImportFailure("Payload is not valid JSON. Stored verbatim; nothing was applied.");
  }
  const parsed = (m.messageType === "specimen.submitted" ? SpecimenSubmittedSchema : SimulatedOrderSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ");
    throw new ImportFailure(`Payload failed validation (${issues}). Stored verbatim; nothing was applied.`);
  }
  const p = parsed.data;
  const tenant = source.tenant_id;
  const isCancel = m.messageType === "order.cancel" || p.status === "canceled";
  const entityKey = `${tenant}:${p.order_id}`;

  const order = db.prepare("SELECT * FROM source_order WHERE tenant_id = ? AND source_order_id = ?").get(tenant, p.order_id) as OrderRow | undefined;

  const finish = (outcome: Exclude<ImportOutcome, "failed" | "duplicate_ignored">, detail: string, extra: Partial<ImportResult>): ImportResult => {
    if (m.existing) {
      db.prepare(
        `UPDATE integration_event SET outcome = ?, detail = ?, entity_key = ?, source_version = ?, source_updated_at = ?, receipt_count = receipt_count + 1 WHERE id = ?`,
      ).run(outcome, `${detail} (${outcome === "applied" ? "applied" : "processed"} on retry at ${fmtTime(ctx.now)} ET)`, entityKey, p.version, m.sentAt ?? p.updated_at, m.eventId);
    } else {
      db.prepare(
        `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(m.eventId, source.id, m.messageId, m.messageType, entityKey, p.version, m.sentAt ?? p.updated_at, ctx.now, outcome, detail, m.payloadText);
    }
    return { outcome, eventId: m.eventId, messageId: m.messageId, detail, sourceOrderId: p.order_id, version: p.version, reconciliation: [], ...extra };
  };

  // 3. Stale: an older (or equal) version never overwrites the stored one.
  if (order && p.version <= order.source_version) {
    const stored = db.prepare("SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = ?").get(order.id, p.version) as
      | { payload: string }
      | undefined;
    const sameContent = stored ? canonical(stored.payload) === canonical(m.payloadText) : null;
    const contentConflict = p.version === order.source_version && Boolean(stored) && sameContent === false;
    const notes: ReconciliationNote[] = [];
    if (contentConflict) {
      // Contract: an equal version is stale_ignored. A person still has to look at why the source re-sent
      // the same version number with different content, so the stored version is kept and a review task opened.
      const taskId = openTask(ctx, {
        kind: "source_conflict",
        entityType: "integration_event",
        entityId: m.eventId,
        title: `${p.order_id} v${p.version} was re-sent by ${source.name} with different content — review (stored v${p.version} kept)`,
        ownerId: firstStaff(db, "supervisor"),
        ownerRole: "supervisor",
        priority: "high",
        detail: `Message ${m.messageId} carries version ${p.version}, which is already stored, but its content differs. The stored version was not overwritten. Compare both payloads in the integration log and confirm with the source which one is current.`,
      });
      notes.push({ kind: "content_conflict_review", summary: `Same version, different content: review task opened.`, ref: taskId });
    }
    const contentNote = contentConflict ? " Same version number with DIFFERENT content — stored data unchanged; a review task was opened." : "";
    const detail = `${p.order_id} v${p.version} is not newer than the stored v${order.source_version} (updated ${fmtTime(order.source_updated_at)} ET). Ignored; the newer version was kept.${contentNote}`;
    audit(ctx, {
      action: "integration.stale_ignored",
      entityType: "source_order",
      entityId: order.id,
      sourceRef: `${source.id}:${m.messageId}:v${p.version}`,
      summary: `${source.name}: ${p.order_id} v${p.version} ignored as stale (stored v${order.source_version})${contentConflict ? "; same version with different content sent for review" : ""}`,
      before: { sourceVersion: order.source_version },
      after: {
        sourceVersion: order.source_version,
        receivedVersion: p.version,
        sourceId: source.id,
        messageId: m.messageId,
        messageType: m.messageType,
        eventId: m.eventId,
        contentConflict,
        reviewTaskIds: notes.map((n) => n.ref).filter(Boolean),
      },
    });
    return finish("stale_ignored", detail, { orderId: order.id, previousVersion: order.source_version, reconciliation: notes });
  }

  // 4. Unknown order for a known tenant → new import.
  if (!order) {
    const created = createOrderFromPayload(ctx, source, p, m, isCancel);
    const base = `New order ${p.order_id} v${p.version} imported (${p.specimens.length} part${p.specimens.length === 1 ? "" : "s"}${isCancel ? ", canceled at source" : ""}).`;
    const detail = created.notes.length ? `${base} ${created.notes.map((n) => n.summary).join(" ")}` : base;
    audit(ctx, {
      action: "integration.order_imported",
      entityType: "source_order",
      entityId: created.orderId,
      sourceRef: `${source.id}:${m.messageId}:v${p.version}`,
      summary: `${source.name}: new order ${p.order_id} v${p.version} imported (simulated source)`,
      after: {
        sourceOrderId: p.order_id,
        tenantId: source.tenant_id,
        sourceVersion: p.version,
        sourceStatus: isCancel ? "canceled" : "active",
        patientRefId: (db.prepare("SELECT patient_ref_id p FROM source_order WHERE id = ?").get(created.orderId) as { p: string }).p,
        parts: p.specimens.map((s) => s.designation),
        sourceId: source.id,
        messageId: m.messageId,
        messageType: m.messageType,
        eventId: m.eventId,
        reconciliation: created.notes.map((n) => ({ kind: n.kind, ref: n.ref ?? null })),
      },
    });
    return finish("applied", detail, { orderId: created.orderId, reconciliation: [{ kind: "order_created", summary: base, ref: p.order_id }, ...created.notes] });
  }

  // 5. Newer version → store, update working values, reconcile local work.
  const notes = applyNewerVersion(ctx, source, order, p, m, isCancel);
  const reviewCount = notes.filter((n) => OPENS_REVIEW.has(n.kind)).length;
  const detail =
    `${p.order_id} v${order.source_version} → v${p.version} applied.` +
    (notes.length ? ` ${notes.map((n) => n.summary).join(" ")}` : " No specimen or stain changes.") +
    (reviewCount ? ` ${reviewCount} review item${reviewCount === 1 ? "" : "s"} opened; nothing was erased.` : "");
  return finish("applied", detail, { orderId: order.id, previousVersion: order.source_version, reconciliation: notes });
}

// ------------------------------------------------------------------ new order

interface PatientRow {
  id: string;
  source_mrn: string;
  family_name: string;
  given_name: string;
  birth_date: string;
}

/**
 * An office id this tenant has not sent before is recorded as a NEW, UNREVIEWED office in that
 * tenant's namespace (never matched to another tenant's office or guessed by name). With no approved
 * routing rule, its items go to the routing exception lane, and a supervisor gets a review task.
 */
function ensureOffice(ctx: Ctx, source: SourceRow, p: SimulatedOrder, notes: ReconciliationNote[], msg: { messageId: string; eventId: string }): { id: string; name: string } {
  const db = ctx.db;
  const tenant = source.tenant_id!;
  const known = db.prepare("SELECT id, name FROM office WHERE tenant_id = ? AND source_office_id = ?").get(tenant, p.office_id) as
    | { id: string; name: string }
    | undefined;
  if (known) return known;
  const id = newId(db, "off");
  const stem = `NEW-${p.office_id.toUpperCase().replace(/[^A-Z0-9]+/g, "")}`.slice(0, 24) || "NEW";
  let code = stem;
  for (let i = 2; db.prepare("SELECT 1 FROM office WHERE code = ?").get(code); i++) code = `${stem}-${i}`;
  const name = p.office_name?.trim() ? `${p.office_name.trim()} (new, not reviewed)` : `Office ${p.office_id} (new, not reviewed)`;
  // Working hours are not known for a new office: JSON null is shown as "Unknown", never as closed.
  db.prepare(
    `INSERT INTO office (id, practice_id, tenant_id, source_office_id, code, name, working_hours, status)
     VALUES (?, NULL, ?, ?, ?, ?, 'null', 'new_unreviewed')`,
  ).run(id, tenant, p.office_id, code, name);
  const taskId = openTask(ctx, {
    kind: "source_conflict",
    entityType: "office",
    entityId: id,
    title: `New office ${p.office_id} received from ${source.name} on ${p.order_id} — review the directory entry and routing rule`,
    ownerId: firstStaff(db, "supervisor"),
    ownerRole: "supervisor",
    priority: "high",
    detail: `The office is listed under Settings → Routing → Unknown offices. Until an approved rule exists, its items go to the routing exception lane; no dermatopathologist is guessed. Contacts and working hours are Unknown until someone adds them.`,
  });
  audit(ctx, {
    action: "office.created_from_source",
    entityType: "office",
    entityId: id,
    sourceRef: `${source.id}:${msg.messageId}:v${p.version}`,
    summary: `${source.name}: office ${p.office_id} was not in the directory for this tenant; recorded as new and unreviewed (${code}). Items route to the exception lane until a rule is approved.`,
    after: { officeId: id, tenantId: tenant, sourceOfficeId: p.office_id, code, status: "new_unreviewed", reviewTaskId: taskId, sourceOrderId: p.order_id, sourceId: source.id, messageId: msg.messageId, eventId: msg.eventId },
  });
  notes.push({ kind: "new_office_review", summary: `Office ${p.office_id} was new for this tenant: recorded as unreviewed (${code}); supervisor review task opened; items go to the routing exception lane.`, ref: taskId });
  return { id, name };
}

/** `what` quotes both values (task titles and the import detail, shown where identification happens); `fields` names them only (audit trail). */
function samePerson(row: PatientRow, p: SimulatedOrder["patient"]): { same: boolean; what: string[]; fields: string[] } {
  const [family, given] = splitName(p.name);
  const what: string[] = [];
  const fields: string[] = [];
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm(row.family_name) !== norm(family) || norm(row.given_name) !== norm(given)) {
    what.push(`name ${row.family_name}, ${row.given_name} → ${p.name}`);
    fields.push("name");
  }
  if (row.birth_date.trim() !== p.birth_date.trim()) {
    what.push(`date of birth ${row.birth_date} → ${p.birth_date}`);
    fields.push("date of birth");
  }
  return { same: what.length === 0, what, fields };
}

function createOrderFromPayload(ctx: Ctx, source: SourceRow, p: SimulatedOrder, m: ProcessInput, isCancel: boolean): { orderId: string; notes: ReconciliationNote[] } {
  const db = ctx.db;
  const tenant = source.tenant_id!;
  const notes: ReconciliationNote[] = [];
  const office = ensureOffice(ctx, source, p, notes, { messageId: m.messageId, eventId: m.eventId });
  // Patient reference: (tenant, MRN) is the key. A name is never a key.
  const existingPatient = db.prepare("SELECT * FROM patient_ref WHERE tenant_id = ? AND source_mrn = ?").get(tenant, p.patient.mrn) as PatientRow | undefined;
  let patient: { id: string } | undefined = existingPatient;
  if (existingPatient) {
    const cmp = samePerson(existingPatient, p.patient);
    if (!cmp.same) {
      // Linked by MRN (the key), but the demographics differ: never merged or overwritten silently.
      const taskId = openTask(ctx, {
        kind: "source_conflict",
        entityType: "patient_ref",
        entityId: existingPatient.id,
        title: `New order ${p.order_id} gives different details for MRN ${p.patient.mrn} (${cmp.what.join("; ")}) — review; patient record not changed`,
        ownerId: firstStaff(db, "accessioning_lead"),
        ownerRole: "accessioning_lead",
        priority: "urgent",
        detail: `The order was linked to the patient reference on file by MRN within this tenant. The details on file were kept. Check the container and requisition identifiers before accession.`,
      });
      notes.push({ kind: "patient_conflict", summary: `MRN ${p.patient.mrn} is on file with different details (${cmp.what.join("; ")}); review task opened, nothing merged.`, ref: taskId });
    }
  }
  if (!patient) {
    const [family, given] = splitName(p.patient.name);
    const id = newId(db, "pt");
    db.prepare(
      `INSERT INTO patient_ref (id, tenant_id, source_mrn, family_name, given_name, birth_date, sex, source_updated_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, tenant, p.patient.mrn, family, given, p.patient.birth_date, p.updated_at, ctx.now);
    patient = { id };
  }
  const clinicianId = resolveClinician(db, tenant, p.ordering_provider_id ?? null);
  let encounterId: string | null = null;
  if (p.encounter_id) {
    const enc = db.prepare("SELECT id FROM encounter WHERE tenant_id = ? AND source_encounter_id = ?").get(tenant, p.encounter_id) as { id: string } | undefined;
    if (enc) encounterId = enc.id;
    else {
      encounterId = newId(db, "enc");
      db.prepare(
        `INSERT INTO encounter (id, tenant_id, source_encounter_id, patient_ref_id, office_id, clinician_id, encounter_at, source_updated_at, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(encounterId, tenant, p.encounter_id, patient.id, office.id, clinicianId, p.updated_at, ctx.now);
    }
  }
  const orderId = newId(db, "ord");
  db.prepare(
    `INSERT INTO source_order (id, tenant_id, source_order_id, patient_ref_id, encounter_id, office_id, ordering_clinician_id, source_status,
       source_version, source_updated_at, imported_at, import_event_id, clinical_note, review_state, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', 1)`,
  ).run(orderId, tenant, p.order_id, patient.id, encounterId, office.id, clinicianId, isCancel ? "canceled" : "active", p.version, p.updated_at, ctx.now, m.eventId, p.clinical_note ?? null);
  insertVersion(ctx, orderId, p, m.payloadText, "Initial version received");
  for (const s of p.specimens) insertPart(db, orderId, s, isCancel ? "canceled" : "active");
  return { orderId, notes };
}

// ------------------------------------------------------------------ newer version

function applyNewerVersion(ctx: Ctx, source: SourceRow, order: OrderRow, p: SimulatedOrder, m: ProcessInput, isCancel: boolean): ReconciliationNote[] {
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  const versionLabel = `${p.order_id} v${p.version}`;
  const amendNote = p.amendment_note ? ` (${p.amendment_note})` : "";

  const orderLevel = reconcileOrderLevel(ctx, source, order, p, versionLabel, { messageId: m.messageId, eventId: m.eventId });
  notes.push(...orderLevel.notes);

  const changeSummary = isCancel ? `Order canceled at source${amendNote}` : `Amended at source${amendNote}`;
  insertVersion(ctx, order.id, p, m.payloadText, changeSummary);

  // Specimen lines.
  const parts = db.prepare("SELECT * FROM source_order_part WHERE source_order_id = ? ORDER BY designation").all(order.id) as OrderPartRow[];
  const incoming = new Map(p.specimens.map((s) => [s.designation.toUpperCase(), s]));

  for (const part of parts) {
    const spec = isCancel ? undefined : incoming.get(part.designation.toUpperCase());
    incoming.delete(part.designation.toUpperCase());
    const accessioned = db
      .prepare(
        `SELECT sp.id, sp.designation, sp.site_text, sp.laterality, sp.procedure, sp.accession_id, a.accession_number, a.namespace, a.assigned_pathologist_id,
                sp.original_designation
           FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id
          WHERE sp.source_order_part_id = ? AND sp.status <> 'canceled'`,
      )
      .get(part.id) as AccessionedPart | undefined;

    if (!spec) {
      notes.push(...reconcilePartCanceled(ctx, order, part, accessioned, p, versionLabel, isCancel));
      continue;
    }
    notes.push(...reconcilePartChanges(ctx, order, part, spec, accessioned, p, versionLabel));
  }

  // New specimen lines on the amended order.
  for (const s of incoming.values()) {
    if (isCancel) break;
    insertPart(db, order.id, s, "active");
    notes.push({ kind: "part_added", summary: `New part ${s.designation} (${s.site}) added at source.`, ref: s.designation });
    const acc = db
      .prepare(
        `SELECT DISTINCT a.id, a.accession_number, a.assigned_pathologist_id FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.source_order_id = ?`,
      )
      .get(order.id) as { id: string; accession_number: string; assigned_pathologist_id: string | null } | undefined;
    if (acc) {
      openTask(ctx, {
        kind: "order_change_review",
        entityType: "source_order",
        entityId: order.id,
        title: `${versionLabel} added part ${s.designation} after ${acc.accession_number} was issued — review (no part was created automatically)`,
        ownerId: firstStaff(db, "accessioning_lead"),
        ownerRole: "accessioning_lead",
        priority: "high",
        accessionId: acc.id,
      });
      recordWorklistChange(ctx, { accessionId: acc.id, pathologistId: acc.assigned_pathologist_id, type: "changed", summary: `${acc.accession_number}: ${versionLabel} added part ${s.designation} at source — review` });
    }
  }

  const needsReview = notes.some((n) => !INFO_ONLY.has(n.kind));
  updateVersioned(db, "source_order", order.id, undefined, {
    ...orderLevel.patch,
    source_version: p.version,
    source_updated_at: p.updated_at,
    imported_at: ctx.now,
    import_event_id: m.eventId,
    clinical_note: p.clinical_note ?? null,
    source_status: isCancel ? "canceled" : "amended",
    review_state: needsReview ? "needs_reconciliation" : order.review_state,
  });
  audit(ctx, {
    action: isCancel ? "integration.order_canceled" : "integration.order_amended",
    entityType: "source_order",
    entityId: order.id,
    sourceRef: `${source.id}:${m.messageId}:v${p.version}`,
    summary: `${source.name}: ${p.order_id} v${order.source_version} → v${p.version} ${isCancel ? "canceled at source" : "amended at source"}${amendNote}. Original v${order.source_version} kept.`,
    before: { source_version: order.source_version, source_status: order.source_status },
    after: {
      source_version: p.version,
      source_status: isCancel ? "canceled" : "amended",
      reconciliation: notes.map((n) => n.kind),
      reconciliationRefs: notes.map((n) => ({ kind: n.kind, ref: n.ref ?? null })),
      sourceId: source.id,
      messageId: m.messageId,
      messageType: m.messageType,
      eventId: m.eventId,
    },
  });
  return notes;
}

// ------------------------------------------------------------------ order-level changes

/**
 * Order-level fields that identify or route the work (patient, office, encounter) are never changed
 * silently: a newer version that differs opens ONE source_conflict review task for the accessioning lead,
 * and the working values stay as they were until a person decides. The ordering provider is a plain
 * working value and is updated when the provider is in the directory.
 */
function reconcileOrderLevel(
  ctx: Ctx,
  source: SourceRow,
  order: OrderRow,
  p: SimulatedOrder,
  versionLabel: string,
  msg: { messageId: string; eventId: string },
): { notes: ReconciliationNote[]; patch: Record<string, unknown> } {
  const db = ctx.db;
  const tenant = source.tenant_id!;
  const notes: ReconciliationNote[] = [];
  const patch: Record<string, unknown> = {};
  const cur = db
    .prepare(
      `SELECT pr.source_mrn, pr.family_name, pr.given_name, pr.birth_date, pr.id patient_id,
              o.source_office_id, o.name office_name, e.source_encounter_id, c.source_provider_id, c.display_name provider_name
         FROM source_order so JOIN patient_ref pr ON pr.id = so.patient_ref_id JOIN office o ON o.id = so.office_id
         LEFT JOIN encounter e ON e.id = so.encounter_id LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
        WHERE so.id = ?`,
    )
    .get(order.id) as
    | {
        source_mrn: string;
        family_name: string;
        given_name: string;
        birth_date: string;
        patient_id: string;
        source_office_id: string;
        office_name: string;
        source_encounter_id: string | null;
        source_provider_id: string | null;
        provider_name: string | null;
      }
    | undefined;
  if (!cur) return { notes, patch };

  const review: string[] = [];
  // The same changes for the audit trail: patient identifiers named by field only (C4); the task keeps both values.
  const reviewAudit: string[] = [];
  const both = (text: string, audited = text) => {
    review.push(text);
    reviewAudit.push(audited);
  };
  let urgent = false;
  if (cur.source_mrn !== p.patient.mrn) {
    both(`patient MRN ${cur.source_mrn} → ${p.patient.mrn} (order stays linked to the original patient)`, "patient MRN (order stays linked to the original patient)");
    urgent = true;
  } else {
    const cmp = samePerson(
      { id: cur.patient_id, source_mrn: cur.source_mrn, family_name: cur.family_name, given_name: cur.given_name, birth_date: cur.birth_date },
      p.patient,
    );
    if (!cmp.same) {
      both(`patient ${cmp.what.join(", ")} (patient record not changed)`, `patient ${cmp.fields.join(", ")} (patient record not changed)`);
      urgent = true;
    }
  }
  if (cur.source_office_id !== p.office_id) {
    const target = db.prepare("SELECT name FROM office WHERE tenant_id = ? AND source_office_id = ?").get(tenant, p.office_id) as { name: string } | undefined;
    both(`office ${cur.office_name} → ${target?.name ?? `${p.office_id} (not in the directory)`} (routing not changed; nothing re-routed)`);
  }
  if ((cur.source_encounter_id ?? null) !== (p.encounter_id ?? null)) {
    both(`encounter ${cur.source_encounter_id ?? "Unknown"} → ${p.encounter_id ?? "Unknown"} (related-order decisions may need a second look)`);
  }
  const provider = p.ordering_provider_id ?? null;
  const resolvedProvider = resolveClinician(db, tenant, provider);
  if (resolvedProvider !== (order.ordering_clinician_id ?? null)) {
    if (resolvedProvider) {
      patch.ordering_clinician_id = resolvedProvider;
      const name = (db.prepare("SELECT display_name FROM clinician WHERE id = ?").get(resolvedProvider) as { display_name: string }).display_name;
      notes.push({ kind: "order_values_updated", summary: `Ordering provider ${cur.provider_name ?? "Unknown"} → ${name}.`, ref: order.id });
    } else {
      both(
        `ordering provider ${cur.provider_name ?? "Unknown"} → ${provider ? `${provider} (not in the directory; previous provider kept)` : "not given (previous provider kept)"}`,
      );
    }
  }

  if (review.length) {
    const taskId = openTask(ctx, {
      kind: "source_conflict",
      entityType: "source_order",
      entityId: order.id,
      title:
        review.length === 1
          ? `${versionLabel} changed the ${review[0].split(" (")[0]} — review; nothing was changed locally`
          : `${versionLabel} changed ${review.length} order-level details at source — review; nothing was changed locally`,
      ownerId: firstStaff(db, "accessioning_lead"),
      ownerRole: "accessioning_lead",
      priority: urgent ? "urgent" : "high",
      detail: `Changes in ${versionLabel}: ${review.join("; ")}. The previous values stay in effect until an authorized person reviews them. Both versions are kept.`,
    });
    audit(ctx, {
      action: "integration.order_level_change_review",
      entityType: "source_order",
      entityId: order.id,
      sourceRef: `${source.id}:${msg.messageId}:v${p.version}`,
      summary: `${source.name}: ${versionLabel} changed ${reviewAudit.join("; ")} — sent for review, not applied`,
      before: { patientRefId: order.patient_ref_id, officeId: order.office_id, encounterId: order.encounter_id, sourceVersion: order.source_version },
      after: {
        // Not applied: the working values stay as they were until a person reviews the task.
        patientRefId: order.patient_ref_id,
        officeId: order.office_id,
        encounterId: order.encounter_id,
        receivedVersion: p.version,
        changes: reviewAudit,
        reviewTaskId: taskId,
        sourceId: source.id,
        messageId: msg.messageId,
        eventId: msg.eventId,
      },
    });
    notes.push({
      kind: urgent ? "patient_conflict" : "order_level_review",
      summary: `Order-level change${review.length === 1 ? "" : "s"} sent for review, not applied: ${review.join("; ")}.`,
      ref: taskId,
    });
  }
  return { notes, patch };
}

interface AccessionedPart {
  id: string;
  designation: string;
  original_designation: string;
  site_text: string;
  laterality: string | null;
  procedure: string | null;
  accession_id: string;
  accession_number: string;
  namespace: string;
  assigned_pathologist_id: string | null;
}

interface FieldChange {
  field: "site" | "laterality" | "procedure" | "collected_at" | "orientation" | "expected_containers";
  label: string;
  from: string | number | null;
  to: string | number | null;
}

function reconcilePartChanges(
  ctx: Ctx,
  order: OrderRow,
  part: OrderPartRow,
  spec: Specimen,
  accessioned: AccessionedPart | undefined,
  p: SimulatedOrder,
  versionLabel: string,
): ReconciliationNote[] {
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  const changes = diffPart(part, spec);
  const identityChanges = changes.filter((c) => c.field === "site" || c.field === "laterality" || c.field === "procedure");
  const newStains = normStains(spec.requested_stains ?? []);
  const oldStains = parseStains(part.requested_stains);
  const stainsChanged = newStains.join("|") !== oldStains.join("|");

  // Mirror the source's current values on the order part (versions keep the originals).
  if (changes.length || stainsChanged || part.status !== "active") {
    db.prepare(
      `UPDATE source_order_part SET site_text = ?, site_normalized = ?, laterality = ?, procedure = ?, orientation_note = ?, collected_at = ?,
              expected_containers = ?, requested_stains = ?, status = 'active' WHERE id = ?`,
    ).run(
      spec.site,
      spec.site.toLowerCase(),
      spec.laterality ?? null,
      spec.procedure ?? null,
      spec.orientation ?? null,
      spec.collected_at ?? null,
      spec.expected_containers === undefined ? part.expected_containers : spec.expected_containers,
      JSON.stringify(newStains.map((s) => ({ stain: s, source: "order" }))),
      part.id,
    );
    const what = [...changes.map((c) => `${c.label} ${fmtVal(c.from)} → ${fmtVal(c.to)}`), ...(stainsChanged ? [`stains [${oldStains.join(", ") || "none"}] → [${newStains.join(", ") || "none"}]`] : [])];
    if (what.length) {
      notes.push({ kind: "working_values_updated", summary: `Part ${part.designation}: ${what.join("; ")}.`, ref: part.id });
      audit(ctx, {
        action: "source_order_part.working_values_updated",
        entityType: "source_order_part",
        entityId: part.id,
        accessionId: accessioned?.accession_id ?? null,
        summary: `${versionLabel} part ${part.designation}: ${what.join("; ")} (previous values kept in the earlier version)`,
        before: { site: part.site_text, laterality: part.laterality, procedure: part.procedure, stains: oldStains },
        after: { site: spec.site, laterality: spec.laterality ?? null, procedure: spec.procedure ?? null, stains: newStains },
      });
    }
  }

  if (accessioned) {
    // (b) Identity change on an issued part → correction review. The part's site is immutable.
    // The comparison is against the ISSUED part (not the previous order version): a later version
    // that matches the issued part again needs no new review.
    if (identityChanges.length) {
      const vsIssued = diffIssued(accessioned, spec);
      const open = openImportReviewFor(db, accessioned);
      if (vsIssued.length && !open) {
        notes.push(openCorrectionReview(ctx, order, part, accessioned, vsIssued, versionLabel));
      } else if (open) {
        notes.push(noteOnOpenReview(ctx, accessioned, open, vsIssued, versionLabel));
      }
      notes.push(...reviewHoldsAndClarifications(ctx, order, part, changes, versionLabel, { checkReceipt: false }));
    }
    // (a) Stain reconciliation against existing work orders from this source order.
    const added = newStains.filter((s) => !oldStains.includes(s));
    notes.push(...reconcileStains(ctx, order, accessioned, newStains, added, p, versionLabel));
  } else if (changes.length || stainsChanged) {
    // (c) Not yet accessioned: working values updated above. Any change (site, laterality, procedure, collection
    // time, orientation, expected containers or stains) goes to the lead if a hold or an already-received container depends on it.
    notes.push(...reviewHoldsAndClarifications(ctx, order, part, changes, versionLabel, { checkReceipt: true }));
  }
  return notes;
}

const IDENTITY_FIELDS = ["site", "laterality", "procedure"] as const;

/** Site / laterality / procedure of the incoming specimen line vs the issued specimen part. */
function diffIssued(sp: AccessionedPart, s: Specimen): FieldChange[] {
  const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const incoming: Record<(typeof IDENTITY_FIELDS)[number], string | null> = { site: s.site, laterality: s.laterality ?? null, procedure: s.procedure ?? null };
  const labels = { site: "Site", laterality: "Laterality", procedure: "Procedure" } as const;
  const out: FieldChange[] = [];
  for (const f of IDENTITY_FIELDS) {
    const issued = fieldOnPart(sp, f);
    if (norm(issued) !== norm(incoming[f])) out.push({ field: f, label: labels[f], from: issued, to: incoming[f] });
  }
  return out;
}

interface OpenReview {
  id: string;
  display_id: string;
}

/** An open correction review this importer already opened for the same issued part (one per part at a time). */
function openImportReviewFor(db: DB, sp: AccessionedPart): OpenReview | undefined {
  const rows = db
    .prepare("SELECT id, display_id, original_refs FROM correction_review WHERE accession_id = ? AND kind = 'site_discrepancy' AND status = 'open' ORDER BY requested_at")
    .all(sp.accession_id) as { id: string; display_id: string; original_refs: string }[];
  for (const r of rows) {
    try {
      const refs = JSON.parse(r.original_refs) as { part_designation?: string; opened_by?: string };
      if (refs.part_designation === sp.designation && refs.opened_by === IMPORT_OPENER) return { id: r.id, display_id: r.display_id };
    } catch {
      /* not ours */
    }
  }
  return undefined;
}

/** A later version for a part that already has an open import review: no second review, the change is recorded against it. */
function noteOnOpenReview(ctx: Ctx, sp: AccessionedPart, open: OpenReview, vsIssued: FieldChange[], versionLabel: string): ReconciliationNote {
  const text = vsIssued.length
    ? `${versionLabel} still differs from the issued part (${vsIssued.map((c) => `${c.label.toLowerCase()}: issued ${fmtVal(c.from)}, order ${fmtVal(c.to)}`).join("; ")})`
    : `${versionLabel} now matches the issued part again`;
  recordWorklistChange(ctx, {
    accessionId: sp.accession_id,
    pathologistId: sp.assigned_pathologist_id,
    type: "changed",
    summary: `${sp.accession_number} part ${sp.designation}: ${text} — see open correction review ${open.display_id}`,
  });
  audit(ctx, {
    action: "correction.source_update_noted",
    entityType: "correction_review",
    entityId: open.id,
    accessionId: sp.accession_id,
    summary: `${open.display_id}: ${text}. No second review opened; the issued part is unchanged.`,
  });
  return { kind: "correction_review_updated", summary: `${sp.accession_number} part ${sp.designation}: ${text}; recorded on open review ${open.display_id} (no second review).`, ref: open.id };
}

function reconcilePartCanceled(
  ctx: Ctx,
  order: OrderRow,
  part: OrderPartRow,
  accessioned: AccessionedPart | undefined,
  p: SimulatedOrder,
  versionLabel: string,
  wholeOrder: boolean,
): ReconciliationNote[] {
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  // Already canceled by an earlier version: that version opened the reviews and recorded the
  // worklist change. Re-running it would repeat "canceled" entries and reopen closed reviews.
  if (part.status === "canceled") return notes;
  db.prepare("UPDATE source_order_part SET status = 'canceled' WHERE id = ?").run(part.id);
  notes.push({ kind: "part_canceled", summary: `Part ${part.designation} ${wholeOrder ? "canceled with the order" : "removed"} at source.`, ref: part.id });
  audit(ctx, {
    action: "source_order_part.canceled_at_source",
    entityType: "source_order_part",
    entityId: part.id,
    accessionId: accessioned?.accession_id ?? null,
    summary: `${versionLabel}: part ${part.designation} ${wholeOrder ? "canceled with the order" : "removed from the order"} at source. Nothing was erased.`,
  });
  if (accessioned) {
    notes.push(...reconcileStains(ctx, order, accessioned, [], [], p, versionLabel));
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM block WHERE part_id = ? AND status = 'active') blocks,
                (SELECT COUNT(*) FROM slide s JOIN block b ON b.id = s.block_id WHERE b.part_id = ? AND s.status = 'active') slides`,
      )
      .get(accessioned.id, accessioned.id) as { blocks: number; slides: number };
    const taskId = openTask(ctx, {
      kind: "order_change_review",
      entityType: "specimen_part",
      entityId: accessioned.id,
      title: `${p.order_id} ${wholeOrder ? "canceled" : `part ${part.designation} removed`} at source — review material for ${accessioned.accession_number} part ${accessioned.designation} (${counts.blocks} block${counts.blocks === 1 ? "" : "s"}, ${counts.slides} slide${counts.slides === 1 ? "" : "s"}). Nothing has been discarded.`,
      ownerRole: "supervisor",
      ownerId: firstStaff(db, "supervisor"),
      priority: "high",
      accessionId: accessioned.accession_id,
      detail: `Source ${versionLabel}. The issued part, its blocks and slides remain on record until a person records a disposition.`,
    });
    notes.push({ kind: "order_canceled_review", summary: `${accessioned.accession_number} part ${accessioned.designation}: review task opened for prepared material.`, ref: taskId });
    recordWorklistChange(ctx, {
      accessionId: accessioned.accession_id,
      pathologistId: accessioned.assigned_pathologist_id,
      type: "canceled",
      summary: `${accessioned.accession_number} part ${accessioned.designation}: ${p.order_id} ${wholeOrder ? "canceled" : "part removed"} at source — prepared material kept for review`,
    });
  } else {
    notes.push(...reviewHoldsAndClarifications(ctx, order, part, [], versionLabel, { checkReceipt: true, canceled: wholeOrder ? "canceled" : "removed" }));
  }
  return notes;
}

// ------------------------------------------------------------------ (a) stains vs work orders

interface WorkOrderRow {
  id: string;
  display_id: string;
  accession_id: string;
  stain: string | null;
  kind: string;
  status: string;
  authorization_source: string;
  source_order_id: string | null;
  target_part_id: string | null;
  target_block_id: string | null;
}

function reconcileStains(
  ctx: Ctx,
  order: OrderRow,
  part: AccessionedPart,
  newStains: string[],
  addedStains: string[],
  p: SimulatedOrder,
  versionLabel: string,
): ReconciliationNote[] {
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  const wos = db
    .prepare(
      `SELECT wo.* FROM work_order wo
        WHERE wo.source_order_id = ? AND wo.authorization_source = 'source_order'
          AND (wo.target_part_id = ? OR wo.target_block_id IN (SELECT id FROM block WHERE part_id = ?))
          AND wo.status NOT IN ('canceled', 'cancel_review')
        ORDER BY wo.display_id`,
    )
    .all(order.id, part.id, part.id) as WorkOrderRow[];

  for (const wo of wos) {
    const stain = (wo.stain ?? "").trim().toUpperCase();
    if (stain && newStains.includes(stain)) continue;
    notes.push(cancelWorkOrder(ctx, wo, part, p, versionLabel));
  }

  // Stains newly requested by the amended order → a new authorized work order (no slide is invented).
  for (const stain of addedStains) {
    const covered = db
      .prepare(
        `SELECT display_id FROM work_order WHERE accession_id = ? AND UPPER(COALESCE(stain,'')) = ? AND status NOT IN ('canceled','cancel_review')
            AND (target_part_id = ? OR target_block_id IN (SELECT id FROM block WHERE part_id = ?))`,
      )
      .get(part.accession_id, stain, part.id, part.id) as { display_id: string } | undefined;
    if (covered) continue;
    const id = newId(db, "wo");
    const display = displayId(db, "WO", 4);
    db.prepare(
      `INSERT INTO work_order (id, display_id, accession_id, kind, stain, authorization_source, source_reference, requested_by_label, requested_by_staff_id,
          source_order_id, source_version, target_part_id, target_block_id, quantity, status, status_reason, requested_at, version)
       VALUES (?, ?, ?, 'stain', ?, 'source_order', ?, 'Ordering clinician (amended order)', NULL, ?, ?, ?, NULL, 1, 'requested', ?, ?, 1)`,
    ).run(
      id, display, part.accession_id, stain, `${versionLabel} · part ${part.original_designation} (${stain} added by amendment)`,
      order.id, p.version, part.id, `Added by source amendment ${versionLabel}. Slides are planned at the bench; none were created automatically.`, ctx.now,
    );
    openTask(ctx, {
      kind: "order_change_review",
      entityType: "work_order",
      entityId: id,
      title: `${stain} added at source (${versionLabel}) for ${part.accession_number} part ${part.designation} — plan slides (${display})`,
      ownerRole: "histotech",
      priority: "high",
      accessionId: part.accession_id,
    });
    recordWorklistChange(ctx, { accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed", summary: `${part.accession_number} part ${part.designation}: ${stain} requested by ${versionLabel} (${display})` });
    audit(ctx, {
      action: "workorder.added_by_source",
      entityType: "work_order",
      entityId: id,
      accessionId: part.accession_id,
      summary: `${display} ${stain} for ${part.accession_number} part ${part.designation} authorized by ${versionLabel}`,
    });
    notes.push({ kind: "work_order_added", summary: `${stain} added by the amendment (${display}, slides not yet planned).`, ref: id });
  }
  return notes;
}

function cancelWorkOrder(ctx: Ctx, wo: WorkOrderRow, part: AccessionedPart, p: SimulatedOrder, versionLabel: string): ReconciliationNote {
  const db = ctx.db;
  const slides = db
    .prepare(
      `SELECT s.id, s.slide_seq, s.stain, s.physical_state, s.label_state, b.label_text block_label
         FROM slide s JOIN block b ON b.id = s.block_id WHERE s.work_order_id = ? AND s.status = 'active' ORDER BY b.block_seq, s.slide_seq`,
    )
    .all(wo.id) as { id: string; slide_seq: number; stain: string; physical_state: string; label_state: string; block_label: string }[];
  // A label may exist even when the slide shows no label yet: a job that reached the printer
  // (submitted / acknowledged / completed) or whose outcome is UNKNOWN (timeout) counts as possibly printed.
  // Unknown is never treated as "nothing printed".
  const sentJobs = (slideId: string) =>
    db
      .prepare(
        `SELECT display_id, state FROM print_job WHERE target_type = 'slide' AND target_id = ?
            AND state IN ('submitted', 'acknowledged', 'completion_confirmed', 'unknown_outcome') ORDER BY created_at`,
      )
      .all(slideId) as { display_id: string; state: string }[];
  const withJobs = slides.map((s) => ({ ...s, jobs: sentJobs(s.id) }));
  const prepared = withJobs.filter((s) => s.label_state !== "none" || s.physical_state !== "planned" || s.jobs.length > 0);
  const unprepared = withJobs.filter((s) => !prepared.includes(s));
  const unknownJobs = prepared.flatMap((s) => s.jobs.filter((j) => j.state === "unknown_outcome").map((j) => j.display_id));
  const stain = wo.stain ?? wo.kind;
  const why = p.amendment_note ? ` — "${p.amendment_note}"` : "";
  const label = (s: { block_label: string; slide_seq: number; stain: string; label_state: string; physical_state: string; jobs: { display_id: string; state: string }[] }) => {
    const base = `${part.accession_number} ${s.block_label}-${s.slide_seq} ${s.stain}`;
    const onlyUnknown = s.label_state === "none" && s.physical_state === "planned" && s.jobs.length > 0 && s.jobs.every((j) => j.state === "unknown_outcome");
    return onlyUnknown ? `${base} (print outcome unknown, ${s.jobs.map((j) => j.display_id).join(", ")})` : base;
  };

  for (const s of prepared) updateVersioned(db, "slide", s.id, undefined, { status: "canceled_needs_review" });
  for (const s of unprepared) {
    updateVersioned(db, "slide", s.id, undefined, { status: "void" });
    // A label not yet sent to a printer is withdrawn (and audited); anything already submitted stays for reconciliation.
    const queued = db
      .prepare("SELECT id, display_id, accession_id FROM print_job WHERE target_type = 'slide' AND target_id = ? AND state IN ('planned', 'queued')")
      .all(s.id) as { id: string; display_id: string; accession_id: string | null }[];
    for (const j of queued) {
      updateVersioned(db, "print_job", j.id, undefined, { state: "canceled", failure_detail: `Withdrawn: ${stain} canceled at source (${versionLabel}) before printing` });
      audit(ctx, {
        action: "print.withdrawn_by_source_change",
        entityType: "print_job",
        entityId: j.id,
        accessionId: j.accession_id ?? wo.accession_id,
        summary: `${j.display_id} for ${label(s)} withdrawn before printing: ${stain} canceled at source (${versionLabel})`,
        reason: `Source amendment ${versionLabel}`,
      });
    }
  }

  const reviewNeeded = prepared.length > 0;
  updateVersioned(db, "work_order", wo.id, undefined, {
    status: reviewNeeded ? "cancel_review" : "canceled",
    status_reason: `${stain} removed at source by ${versionLabel}${why}.${reviewNeeded ? ` Prepared/printed or possibly printed: ${prepared.map(label).join(", ")} — kept for review.` : " Nothing had been sent to a printer or prepared."}`,
  });

  let taskId: string | undefined;
  if (reviewNeeded) {
    taskId = openTask(ctx, {
      kind: "order_change_review",
      entityType: "work_order",
      entityId: wo.id,
      title: `${stain} canceled at source after material was prepared${unknownJobs.length ? " or possibly printed" : ""} — review ${prepared.map(label).join(", ")} (${wo.display_id})`,
      ownerRole: "histotech",
      priority: "high",
      accessionId: wo.accession_id,
      detail: `${versionLabel}${why}. The slide${prepared.length === 1 ? " is" : "s are"} not deleted; record a disposition (retain, file with note, or void the label) through the work-order review.${unknownJobs.length ? ` Print outcome unknown for ${unknownJobs.join(", ")}: reconcile the print job as well (check the printer output).` : ""}`,
    });
  }
  recordWorklistChange(ctx, {
    accessionId: wo.accession_id,
    pathologistId: part.assigned_pathologist_id,
    type: "canceled",
    summary: reviewNeeded
      ? `${part.accession_number}: ${stain} (${wo.display_id}) canceled at source — ${prepared.map(label).join(", ")} already prepared or possibly printed; review needed`
      : `${part.accession_number}: ${stain} (${wo.display_id}) canceled at source — nothing had been sent to a printer or prepared`,
  });
  audit(ctx, {
    action: reviewNeeded ? "workorder.source_cancel_review" : "workorder.source_canceled",
    entityType: "work_order",
    entityId: wo.id,
    accessionId: wo.accession_id,
    summary: reviewNeeded
      ? `${wo.display_id} ${stain} canceled at source (${versionLabel}); ${prepared.length} prepared slide${prepared.length === 1 ? "" : "s"} marked "canceled — needs review" (not deleted)`
      : `${wo.display_id} ${stain} canceled at source (${versionLabel}); nothing had been prepared`,
    before: { status: wo.status },
    after: { status: reviewNeeded ? "cancel_review" : "canceled", prepared: prepared.map((s) => s.id), voided: unprepared.map((s) => s.id) },
  });
  return reviewNeeded
    ? { kind: "work_order_cancel_review", summary: `${stain} (${wo.display_id}) canceled at source; ${prepared.map(label).join(", ")} prepared → review task.`, ref: taskId }
    : { kind: "work_order_canceled", summary: `${stain} (${wo.display_id}) canceled at source; nothing had been prepared.`, ref: wo.id };
}

// ------------------------------------------------------------------ (b) accessioned identity change

const IMPORT_OPENER = "source import (system)";

function openCorrectionReview(ctx: Ctx, order: OrderRow, part: OrderPartRow, sp: AccessionedPart, changes: FieldChange[], versionLabel: string): ReconciliationNote {
  const db = ctx.db;
  const lead = firstStaff(db, "accessioning_lead") ?? firstStaff(db, "supervisor");
  if (!lead) throw new ImportFailure("No accessioning lead or supervisor is on file to own the correction review.");
  const id = newId(db, "xr");
  const display = displayId(db, "XR", 4);
  const what = changes.map((c) => `${c.label}: issued part says ${fmtVal(fieldOnPart(sp, c.field))}, ${versionLabel} says ${fmtVal(c.to)}`).join("; ");
  const originalRefs = {
    accession_number: sp.accession_number,
    namespace: sp.namespace,
    part_designation: sp.designation,
    original_designation: sp.original_designation,
    specimen_part: { site_text: sp.site_text, laterality: sp.laterality, procedure: sp.procedure },
    source_order_id: order.source_order_id,
    previous_order_version: order.source_version,
    previous_order_values: { site: part.site_text, laterality: part.laterality, procedure: part.procedure },
    amended_order_version: versionLabel,
    changes,
    opened_by: IMPORT_OPENER,
  };
  // correction_review.requested_by must reference a staff row; the import is a system actor, so the
  // review is recorded against its owner (the accessioning lead) and the description says it was automatic.
  db.prepare(
    `INSERT INTO correction_review (id, display_id, accession_id, kind, related_accession_id, original_refs, description, requested_by, requested_at, status, version)
     VALUES (?, ?, ?, 'site_discrepancy', NULL, ?, ?, ?, ?, 'open', 1)`,
  ).run(
    id, display, sp.accession_id, JSON.stringify(originalRefs),
    `Opened automatically by the source import: ${versionLabel} changed part ${sp.designation} after ${sp.accession_number} was issued. ${what}. The issued part is not changed here; use the authorized correction process in the source system.`,
    lead, ctx.now,
  );
  const taskId = openTask(ctx, {
    kind: "correction_review",
    entityType: "correction_review",
    entityId: id,
    title: `Source amended ${sp.accession_number} part ${sp.designation} after accession (${changes.map((c) => c.label.toLowerCase()).join(", ")}) — review ${display}`,
    ownerId: lead,
    ownerRole: "accessioning_lead",
    priority: "high",
    accessionId: sp.accession_id,
  });
  recordWorklistChange(ctx, {
    accessionId: sp.accession_id,
    pathologistId: sp.assigned_pathologist_id,
    type: "changed",
    summary: `${sp.accession_number} part ${sp.designation}: ${versionLabel} differs from the issued part (${changes.map((c) => c.label.toLowerCase()).join(", ")}) — correction review ${display}`,
  });
  audit(ctx, {
    action: "correction.opened_by_import",
    entityType: "correction_review",
    entityId: id,
    accessionId: sp.accession_id,
    summary: `${display} opened: ${versionLabel} changed ${changes.map((c) => c.label.toLowerCase()).join(", ")} on issued ${sp.accession_number} part ${sp.designation}. Part site and identity unchanged.`,
    after: originalRefs,
  });
  // Until the review is closed, the affected part may not move on with the superseded details: an ordinary
  // scoped hold (gross approval, print, tray delivery) that every screen and command already honours.
  holdPartForSourceAmendment(ctx, id);
  return { kind: "correction_review_opened", summary: `${sp.accession_number} part ${sp.designation}: correction review ${display} opened (issued part not changed).`, ref: id };
}

// ------------------------------------------------------------------ (c)/(d) holds, clarifications, receipts

function reviewHoldsAndClarifications(
  ctx: Ctx,
  order: OrderRow,
  part: OrderPartRow,
  changes: FieldChange[],
  versionLabel: string,
  opts: { checkReceipt: boolean; canceled?: "canceled" | "removed" },
): ReconciliationNote[] {
  const canceled = opts.canceled;
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  const lead = firstStaff(db, "accessioning_lead");
  const changeText = canceled
    ? canceled === "canceled" ? "order canceled at source" : `part ${part.designation} removed at source`
    : changes.map((c) => `${c.label.toLowerCase()} now ${fmtVal(c.to)}`).join(", ") || "requested stains changed";

  // Clarifications that concern this order part: link and mark their order evidence as superseded.
  const clars = db
    .prepare(
      `SELECT id, display_id, state, evidence FROM clarification
        WHERE (order_part_id = ? OR (order_part_id IS NULL AND source_order_id = ?)) AND state <> 'canceled'
        ORDER BY created_at`,
    )
    .all(part.id, order.id) as { id: string; display_id: string; state: string; evidence: string }[];
  for (const c of clars) {
    markEvidenceSuperseded(ctx, c, changes, versionLabel, canceled);
    notes.push({ kind: "clarification_linked", summary: `${c.display_id} evidence marked "superseded by amendment ${versionLabel}".`, ref: c.id });
  }
  const clarList = clars.length ? ` Linked: ${clars.map((c) => `${c.display_id} (${c.state})`).join(", ")}.` : "";

  // Active holds that reference this order part: directly, through its containers, through the intake item
  // those containers arrived in, or through a linked clarification.
  const containerIds = (db.prepare("SELECT id FROM container WHERE order_part_id = ?").all(part.id) as { id: string }[]).map((r) => r.id);
  const holds = db
    .prepare(
      `SELECT * FROM hold WHERE status = 'active' AND (
          (scope_type = 'order_part' AND scope_id = ?)
          ${containerIds.length ? `OR (scope_type = 'container' AND scope_id IN (${containerIds.map(() => "?").join(",")}))` : ""}
          OR (scope_type = 'intake_item' AND scope_id IN (SELECT intake_item_id FROM container WHERE order_part_id = ? AND intake_item_id IS NOT NULL))
          OR clarification_id IN (SELECT id FROM clarification WHERE order_part_id = ?)
        ) ORDER BY placed_at`,
    )
    .all(part.id, ...containerIds, part.id, part.id) as { id: string; display_id: string; scope_label: string; intake_item_id: string | null; accession_id: string | null; clarification_id: string | null }[];

  for (const h of holds) {
    const taskId = openTask(ctx, {
      kind: "order_change_review",
      entityType: "hold",
      entityId: h.id,
      title: `Amended order received — review and release ${h.display_id}`,
      ownerId: lead,
      ownerRole: "accessioning_lead",
      priority: "high",
      intakeItemId: h.intake_item_id,
      accessionId: h.accession_id,
      detail: `${versionLabel}: ${changeText} (part ${part.designation}, ${h.scope_label}). Previous order values are kept in the earlier version.${clarList} The hold is not released automatically; release it with a reason after review.`,
    });
    audit(ctx, {
      action: "task.amended_order_review",
      entityType: "hold",
      entityId: h.id,
      intakeItemId: h.intake_item_id,
      accessionId: h.accession_id,
      summary: `Amended order ${versionLabel} received for held material ${h.scope_label}; lead review task opened (hold ${h.display_id} stays active)`,
    });
    notes.push({ kind: "lead_review_task", summary: `Lead review task opened for ${h.display_id} (hold not released automatically).`, ref: taskId });
  }

  // No hold, but the container already arrived and may have been checked against the old values.
  if (!holds.length && opts.checkReceipt) {
    const received = db
      .prepare(
        `SELECT DISTINCT ii.id, ii.display_id FROM container c JOIN intake_item ii ON ii.id = c.intake_item_id
          WHERE c.order_part_id = ? AND ii.status NOT IN ('accessioned','canceled')`,
      )
      .get(part.id) as { id: string; display_id: string } | undefined;
    if (received) {
      const taskId = openTask(ctx, {
        kind: "order_change_review",
        entityType: "source_order_part",
        entityId: part.id,
        title: `Order changed after receipt — re-check ${received.display_id} part ${part.designation} against ${versionLabel}`,
        ownerId: lead,
        ownerRole: "accessioning_lead",
        priority: "high",
        intakeItemId: received.id,
        detail: `${changeText}.${clarList} Any earlier "staff verified" check was made against the previous version.`,
      });
      notes.push({ kind: "receipt_recheck_task", summary: `${received.display_id}: re-check task opened (container already received).`, ref: taskId });
    }
  }
  return notes;
}

function markEvidenceSuperseded(
  ctx: Ctx,
  c: { id: string; display_id: string; evidence: string },
  changes: FieldChange[],
  versionLabel: string,
  canceled?: "canceled" | "removed",
): void {
  let evidence: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(c.evidence);
    evidence = Array.isArray(parsed) ? parsed : [];
  } catch {
    evidence = [];
  }
  if (evidence.some((e) => e && e.superseded_by_amendment === versionLabel)) return;
  const fieldsChanged = new Set(changes.map((x) => x.label.toLowerCase()));
  const marked = evidence.map((e) => {
    const field = String(e?.field ?? "").toLowerCase();
    if (!canceled && fieldsChanged.size && field && !fieldsChanged.has(field)) return e;
    const change = changes.find((x) => x.label.toLowerCase() === field);
    return { ...e, superseded_by_amendment: versionLabel, amended_order_value: canceled ? `(${canceled} at source)` : change ? fmtVal(change.to) : undefined };
  });
  marked.push({
    field: "Source amendment",
    order_value: canceled ? `${versionLabel}: ${canceled} at source` : `${versionLabel}: ${changes.map((x) => `${x.label} ${fmtVal(x.to)}`).join(", ") || "updated"}`,
    observed_value: null,
    source: "simulated source import",
    superseded_by_amendment: versionLabel,
    recorded_at: ctx.now,
  });
  // An additive annotation: the question, answer and state of the clarification are untouched.
  ctx.db.prepare("UPDATE clarification SET evidence = ? WHERE id = ?").run(JSON.stringify(marked), c.id);
  audit(ctx, {
    action: "clarification.evidence_superseded",
    entityType: "clarification",
    entityId: c.id,
    summary: `${c.display_id}: order evidence marked "superseded by amendment ${versionLabel}" (question, answer and state unchanged)`,
  });
}

// ------------------------------------------------------------------ helpers

function insertVersion(ctx: Ctx, orderId: string, p: SimulatedOrder, payloadText: string, summary: string): void {
  ctx.db
    .prepare(
      `INSERT INTO source_order_version (id, source_order_id, source_version, source_updated_at, imported_at, payload, change_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(ctx.db, "sov"), orderId, p.version, p.updated_at, ctx.now, payloadText, summary);
}

function insertPart(db: DB, orderId: string, s: Specimen, status: "active" | "canceled"): void {
  db.prepare(
    `INSERT INTO source_order_part (id, source_order_id, designation, site_text, site_normalized, laterality, procedure, orientation_note, collected_at,
       expected_containers, requested_stains, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(db, "sop"), orderId, s.designation.toUpperCase(), s.site, s.site.toLowerCase(), s.laterality ?? null, s.procedure ?? null,
    s.orientation ?? null, s.collected_at ?? null, s.expected_containers === undefined ? null : s.expected_containers,
    JSON.stringify(normStains(s.requested_stains ?? []).map((x) => ({ stain: x, source: "order" }))), status,
  );
}

function diffPart(part: OrderPartRow, s: Specimen): FieldChange[] {
  const out: FieldChange[] = [];
  const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  if (part.site_text.trim() !== s.site.trim()) out.push({ field: "site", label: "Site", from: part.site_text, to: s.site });
  if (!eq(part.laterality, s.laterality)) out.push({ field: "laterality", label: "Laterality", from: part.laterality, to: s.laterality ?? null });
  if (!eq(part.procedure, s.procedure)) out.push({ field: "procedure", label: "Procedure", from: part.procedure, to: s.procedure ?? null });
  if (!eq(part.collected_at, s.collected_at)) out.push({ field: "collected_at", label: "Collection time", from: part.collected_at, to: s.collected_at ?? null });
  if (!eq(part.orientation_note, s.orientation)) out.push({ field: "orientation", label: "Orientation", from: part.orientation_note, to: s.orientation ?? null });
  if (s.expected_containers !== undefined && !eq(part.expected_containers, s.expected_containers)) {
    out.push({ field: "expected_containers", label: "Expected containers", from: part.expected_containers, to: s.expected_containers });
  }
  return out;
}

function fieldOnPart(sp: AccessionedPart, field: FieldChange["field"]): string | null {
  if (field === "site") return sp.site_text;
  if (field === "laterality") return sp.laterality;
  if (field === "procedure") return sp.procedure;
  return null;
}

function fmtVal(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "Unknown";
  if (typeof v === "string" && v in LATERALITY) return LATERALITY[v as keyof typeof LATERALITY];
  return String(v);
}

function normStains(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
}

function parseStains(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return normStains(v.map((x) => (typeof x === "string" ? x : String((x as { stain?: unknown })?.stain ?? ""))));
  } catch {
    return [];
  }
}

function splitName(name: string): [string, string] {
  const [family, ...rest] = name.split(",");
  const given = rest.join(",").trim();
  return [family.trim() || name.trim(), given || "Unknown"];
}

function resolveClinician(db: DB, tenant: string, providerId: string | null): string | null {
  if (!providerId) return null;
  const bySrc = db.prepare("SELECT id FROM clinician WHERE tenant_id = ? AND source_provider_id = ?").get(tenant, providerId) as { id: string } | undefined;
  if (bySrc) return bySrc.id;
  const byId = db.prepare("SELECT id FROM clinician WHERE tenant_id = ? AND id = ?").get(tenant, providerId) as { id: string } | undefined;
  return byId?.id ?? null;
}

export function firstStaff(db: DB, role: string): string | null {
  const row = db.prepare("SELECT id FROM staff WHERE role = ? AND active = 1 ORDER BY id").get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

function canonical(json: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(json)));
  } catch {
    return json;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

function guessEntityKey(source: SourceRow, payloadText: string): { key: string; version: number | null; updatedAt: string | null } {
  try {
    const p = JSON.parse(payloadText) as { order_id?: unknown; version?: unknown; updated_at?: unknown; request_id?: unknown };
    if (typeof p.order_id !== "string" && typeof p.request_id === "string") {
      // An accession message (accession.issued / accession.acknowledged): keyed by the lab's request id.
      return { key: `${source.tenant_id ?? source.id}:accession_request:${p.request_id.slice(0, 40)}`, version: null, updatedAt: null };
    }
    return {
      key: `${source.tenant_id ?? source.id}:${typeof p.order_id === "string" ? p.order_id : "unknown"}`,
      version: typeof p.version === "number" ? p.version : null,
      updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
    };
  } catch {
    return { key: `${source.tenant_id ?? source.id}:unknown`, version: null, updatedAt: null };
  }
}

/**
 * Append one line to the receipt log (every delivery, duplicate and retry). It is written after the
 * import outcome is settled and can never fail or undo the import: a logging error is reported and skipped.
 */
function logReceipt(
  ctx: Ctx,
  r: { eventId: string; sourceId: string; messageId: string; messageType: string; outcome: string; detail: string; via: ReceiptVia },
): void {
  try {
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO integration_receipt (id, event_id, source_id, message_id, message_type, received_at, outcome, detail, via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId(ctx.db, "irc"), r.eventId, r.sourceId, r.messageId, r.messageType, ctx.now, r.outcome, r.detail, r.via);
    })();
  } catch (e) {
    log("error", "import.receipt_log_failed", { correlationId: ctx.correlationId, sourceId: r.sourceId, messageId: r.messageId, error: e });
  }
}
