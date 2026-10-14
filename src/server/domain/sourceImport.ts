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
import { fmtTime } from "@/lib/time";
import { LATERALITY } from "@/lib/domain";

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
  ordering_provider_id: nullableString,
  clinical_note: nullableString,
  amendment_note: nullableString,
  specimens: z.array(SpecimenSchema).max(26),
});
export type SimulatedOrder = z.infer<typeof SimulatedOrderSchema>;
type Specimen = z.infer<typeof SpecimenSchema>;

export const SUPPORTED_MESSAGE_TYPES = ["order.upsert", "order.amend", "order.cancel"] as const;

export interface SourceMessage {
  messageId: string;
  messageType: string;
  /** Object or JSON text. Stored verbatim either way. */
  payload: unknown;
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
    | "patient_conflict";
  summary: string;
  ref?: string;
}

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

export type ReceiptVia = "pump" | "replay" | "retry" | "sync";

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

  const existing = messageId
    ? (db.prepare("SELECT * FROM integration_event WHERE source_id = ? AND message_id = ?").get(sourceId, messageId) as EventRow | undefined)
    : undefined;

  // 1. Duplicate message id: count the receipt, change nothing else.
  if (existing && existing.outcome !== "failed") {
    db.prepare("UPDATE integration_event SET receipt_count = receipt_count + 1 WHERE id = ?").run(existing.id);
    const count = existing.receipt_count + 1;
    const detail = `Duplicate of message ${messageId} (first received ${fmtTime(existing.received_at)} ET, outcome ${existing.outcome}). Receipt #${count} ignored; nothing changed.`;
    writeReceipt(ctx, { eventId: existing.id, sourceId, messageId, messageType, outcome: "duplicate_ignored", detail, via });
    audit(ctx, {
      action: "integration.duplicate_ignored",
      entityType: "integration_event",
      entityId: existing.id,
      summary: `${source.name}: duplicate message ${messageId} ignored (receipt #${count})`,
    });
    return { outcome: "duplicate_ignored", eventId: existing.id, messageId, detail, receiptCount: count, reconciliation: [] };
  }

  const eventId = existing?.id ?? newId(db, "ie");
  const isRetry = Boolean(existing);

  try {
    if (!messageId) throw new ImportFailure("Message has no message id; it cannot be de-duplicated, so it was not applied.");
    // Demo fault injection: "simulate a processing failure on the next message".
    const failKey = `s6_fail_next_import:${sourceId}`;
    if (!isRetry && getSetting(db, failKey) === "1") {
      setSetting(db, failKey, "0", ctx.now);
      throw new ImportFailure("Simulated processing error (demo control: fail next message). The message was received but not applied. Retry it from the failure queue.");
    }
    // Nested transaction = savepoint: a failure rolls back every partial change.
    const result = db.transaction(() => processMessage(ctx, source, { eventId, messageId, messageType, payloadText, isRetry, existing }))();
    writeReceipt(ctx, { eventId, sourceId, messageId, messageType, outcome: result.outcome, detail: result.detail, via });
    return result;
  } catch (e) {
    const detail =
      e instanceof ImportFailure || e instanceof DomainError
        ? e.message
        : `Unexpected processing error: ${e instanceof Error ? e.message : String(e)}`;
    if (!(e instanceof ImportFailure) && !(e instanceof DomainError)) console.error("[sourceImport] unexpected", e);
    const entityKey = guessEntityKey(source, payloadText);
    if (existing) {
      db.prepare("UPDATE integration_event SET detail = ?, receipt_count = receipt_count + 1 WHERE id = ?").run(
        `${detail} (retry at ${fmtTime(ctx.now)} ET failed)`,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, 1)`,
      ).run(eventId, sourceId, messageId || `missing-id:${eventId}`, messageType, entityKey.key, entityKey.version, entityKey.updatedAt, ctx.now, detail, payloadText);
    }
    writeReceipt(ctx, { eventId, sourceId, messageId: messageId || `missing-id:${eventId}`, messageType, outcome: "failed", detail, via });
    audit(ctx, {
      action: "integration.import_failed",
      entityType: "integration_event",
      entityId: eventId,
      summary: `${source.name}: message ${messageId || "(no id)"} could not be applied — kept in the failure queue`,
      reason: detail,
    });
    return { outcome: "failed", eventId, messageId, detail, reconciliation: [] };
  }
}

// ------------------------------------------------------------------ processing

interface ProcessInput {
  eventId: string;
  messageId: string;
  messageType: string;
  payloadText: string;
  isRetry: boolean;
  existing?: EventRow;
}

function processMessage(ctx: Ctx, source: SourceRow, m: ProcessInput): ImportResult {
  const db = ctx.db;
  if (!source.tenant_id) throw new ImportFailure(`${source.name} has no source tenant, so its identifiers have no namespace. Message not applied.`);
  if (!(SUPPORTED_MESSAGE_TYPES as readonly string[]).includes(m.messageType)) {
    throw new ImportFailure(`Unsupported message type "${m.messageType}". Supported: ${SUPPORTED_MESSAGE_TYPES.join(", ")}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(m.payloadText);
  } catch {
    throw new ImportFailure("Payload is not valid JSON. Stored verbatim; nothing was applied.");
  }
  const parsed = SimulatedOrderSchema.safeParse(raw);
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
      ).run(outcome, `${detail} (applied on retry at ${fmtTime(ctx.now)} ET)`, entityKey, p.version, p.updated_at, m.eventId);
    } else {
      db.prepare(
        `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(m.eventId, source.id, m.messageId, m.messageType, entityKey, p.version, p.updated_at, ctx.now, outcome, detail, m.payloadText);
    }
    return { outcome, eventId: m.eventId, messageId: m.messageId, detail, sourceOrderId: p.order_id, version: p.version, reconciliation: [], ...extra };
  };

  // 3. Stale: an older (or equal) version never overwrites the stored one.
  if (order && p.version <= order.source_version) {
    const stored = db.prepare("SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = ?").get(order.id, p.version) as
      | { payload: string }
      | undefined;
    const sameContent = stored ? canonical(stored.payload) === canonical(m.payloadText) : null;
    const contentNote =
      p.version === order.source_version && stored && sameContent === false
        ? " Same version number with DIFFERENT content — logged for review; stored data unchanged."
        : "";
    const detail = `${p.order_id} v${p.version} is not newer than the stored v${order.source_version} (updated ${fmtTime(order.source_updated_at)} ET). Ignored; the newer version was kept.${contentNote}`;
    audit(ctx, {
      action: "integration.stale_ignored",
      entityType: "source_order",
      entityId: order.id,
      summary: `${source.name}: ${p.order_id} v${p.version} ignored as stale (stored v${order.source_version})`,
    });
    return finish("stale_ignored", detail, { orderId: order.id, previousVersion: order.source_version });
  }

  // 4. Unknown order for a known tenant → new import.
  if (!order) {
    const created = createOrderFromPayload(ctx, source, p, m, isCancel);
    const detail = `New order ${p.order_id} v${p.version} imported (${p.specimens.length} part${p.specimens.length === 1 ? "" : "s"}${isCancel ? ", canceled at source" : ""}).`;
    audit(ctx, {
      action: "integration.order_imported",
      entityType: "source_order",
      entityId: created,
      summary: `${source.name}: new order ${p.order_id} v${p.version} imported (simulated source)`,
    });
    return finish("applied", detail, { orderId: created, reconciliation: [{ kind: "order_created", summary: detail, ref: p.order_id }] });
  }

  // 5. Newer version → store, update working values, reconcile local work.
  const notes = applyNewerVersion(ctx, source, order, p, m, isCancel);
  const reviewCount = notes.filter((n) => n.kind !== "working_values_updated" && n.kind !== "part_added").length;
  const detail =
    `${p.order_id} v${order.source_version} → v${p.version} applied.` +
    (notes.length ? ` ${notes.map((n) => n.summary).join(" ")}` : " No specimen or stain changes.") +
    (reviewCount ? ` ${reviewCount} review item${reviewCount === 1 ? "" : "s"} opened; nothing was erased.` : "");
  return finish("applied", detail, { orderId: order.id, previousVersion: order.source_version, reconciliation: notes });
}

// ------------------------------------------------------------------ new order

function createOrderFromPayload(ctx: Ctx, source: SourceRow, p: SimulatedOrder, m: ProcessInput, isCancel: boolean): string {
  const db = ctx.db;
  const tenant = source.tenant_id!;
  const office = db.prepare("SELECT id, name FROM office WHERE tenant_id = ? AND source_office_id = ?").get(tenant, p.office_id) as
    | { id: string; name: string }
    | undefined;
  if (!office) {
    throw new ImportFailure(
      `Office ${p.office_id} is not in the office directory for this tenant. Add the office in Settings, then retry. Nothing was applied.`,
    );
  }
  // Patient reference: (tenant, MRN) is the key. A name is never a key.
  let patient = db.prepare("SELECT id FROM patient_ref WHERE tenant_id = ? AND source_mrn = ?").get(tenant, p.patient.mrn) as { id: string } | undefined;
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
  return orderId;
}

// ------------------------------------------------------------------ newer version

function applyNewerVersion(ctx: Ctx, source: SourceRow, order: OrderRow, p: SimulatedOrder, m: ProcessInput, isCancel: boolean): ReconciliationNote[] {
  const db = ctx.db;
  const notes: ReconciliationNote[] = [];
  const versionLabel = `${p.order_id} v${p.version}`;
  const amendNote = p.amendment_note ? ` (${p.amendment_note})` : "";

  // Patient on the order changed at source? Never move an order to another patient silently.
  const currentPatient = db.prepare("SELECT source_mrn FROM patient_ref WHERE id = ?").get(order.patient_ref_id) as { source_mrn: string } | undefined;
  if (currentPatient && currentPatient.source_mrn !== p.patient.mrn) {
    const taskId = openTask(ctx, {
      kind: "source_conflict",
      entityType: "source_order",
      entityId: order.id,
      title: `Source changed the patient on ${p.order_id} (MRN ${currentPatient.source_mrn} → ${p.patient.mrn}) — review; nothing was moved`,
      ownerId: firstStaff(db, "accessioning_lead"),
      ownerRole: "accessioning_lead",
      priority: "urgent",
      detail: `Version ${p.version} names a different patient reference. The order stays linked to the original patient until an authorized review.`,
    });
    notes.push({ kind: "patient_conflict", summary: `Patient reference changed at source; review task opened (order not moved).`, ref: taskId });
  }

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

  const needsReview = notes.some((n) => !["working_values_updated", "part_added"].includes(n.kind));
  updateVersioned(db, "source_order", order.id, undefined, {
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
    summary: `${source.name}: ${p.order_id} v${order.source_version} → v${p.version} ${isCancel ? "canceled at source" : "amended at source"}${amendNote}. Original v${order.source_version} kept.`,
    before: { source_version: order.source_version, source_status: order.source_status },
    after: { source_version: p.version, source_status: isCancel ? "canceled" : "amended", reconciliation: notes.map((n) => n.kind) },
  });
  return notes;
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
    if (identityChanges.length) notes.push(openCorrectionReview(ctx, order, part, accessioned, identityChanges, versionLabel));
    // (a) Stain reconciliation against existing work orders from this source order.
    notes.push(...reconcileStains(ctx, order, accessioned, newStains, p, versionLabel));
  } else if (identityChanges.length || stainsChanged) {
    // (c) Not yet accessioned: working values updated above. Route to the lead if a hold or a receipt depends on it.
    notes.push(...reviewPreAccessionAmendment(ctx, order, part, changes, versionLabel));
  }
  return notes;
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
  if (part.status !== "canceled") {
    db.prepare("UPDATE source_order_part SET status = 'canceled' WHERE id = ?").run(part.id);
    notes.push({ kind: "part_canceled", summary: `Part ${part.designation} ${wholeOrder ? "canceled with the order" : "removed"} at source.`, ref: part.id });
    audit(ctx, {
      action: "source_order_part.canceled_at_source",
      entityType: "source_order_part",
      entityId: part.id,
      accessionId: accessioned?.accession_id ?? null,
      summary: `${versionLabel}: part ${part.designation} ${wholeOrder ? "canceled with the order" : "removed from the order"} at source. Nothing was erased.`,
    });
  }
  if (accessioned) {
    notes.push(...reconcileStains(ctx, order, accessioned, [], p, versionLabel));
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
    notes.push(...reviewPreAccessionAmendment(ctx, order, part, [], versionLabel, wholeOrder ? "canceled" : "removed"));
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

function reconcileStains(ctx: Ctx, order: OrderRow, part: AccessionedPart, newStains: string[], p: SimulatedOrder, versionLabel: string): ReconciliationNote[] {
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
  for (const stain of newStains) {
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
  const prepared = slides.filter((s) => s.label_state !== "none" || s.physical_state !== "planned");
  const unprepared = slides.filter((s) => !prepared.includes(s));
  const stain = wo.stain ?? wo.kind;
  const why = p.amendment_note ? ` — "${p.amendment_note}"` : "";
  const label = (s: { block_label: string; slide_seq: number; stain: string }) => `${part.accession_number} ${s.block_label}-${s.slide_seq} ${s.stain}`;

  for (const s of prepared) updateVersioned(db, "slide", s.id, undefined, { status: "canceled_needs_review" });
  for (const s of unprepared) {
    updateVersioned(db, "slide", s.id, undefined, { status: "void" });
    // A label not yet sent to a printer is withdrawn; anything already submitted stays for reconciliation.
    db.prepare(
      `UPDATE print_job SET state = 'canceled', failure_detail = ?, version = version + 1
        WHERE target_type = 'slide' AND target_id = ? AND state IN ('planned', 'queued')`,
    ).run(`Withdrawn: ${stain} canceled at source (${versionLabel}) before printing`, s.id);
  }

  const reviewNeeded = prepared.length > 0;
  updateVersioned(db, "work_order", wo.id, undefined, {
    status: reviewNeeded ? "cancel_review" : "canceled",
    status_reason: `${stain} removed at source by ${versionLabel}${why}.${reviewNeeded ? ` Prepared/printed: ${prepared.map(label).join(", ")} — kept for review.` : " Nothing had been printed or prepared."}`,
  });

  let taskId: string | undefined;
  if (reviewNeeded) {
    taskId = openTask(ctx, {
      kind: "order_change_review",
      entityType: "work_order",
      entityId: wo.id,
      title: `${stain} canceled at source after material was prepared — review ${prepared.map(label).join(", ")} (${wo.display_id})`,
      ownerRole: "histotech",
      priority: "high",
      accessionId: wo.accession_id,
      detail: `${versionLabel}${why}. The slide${prepared.length === 1 ? " is" : "s are"} not deleted; record a disposition (retain, file with note, or void the label) through the work-order review.`,
    });
  }
  recordWorklistChange(ctx, {
    accessionId: wo.accession_id,
    pathologistId: part.assigned_pathologist_id,
    type: "canceled",
    summary: reviewNeeded
      ? `${part.accession_number}: ${stain} (${wo.display_id}) canceled at source — ${prepared.map(label).join(", ")} already prepared; review needed`
      : `${part.accession_number}: ${stain} (${wo.display_id}) canceled at source — nothing had been prepared`,
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
    opened_by: "source import (system)",
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
  return { kind: "correction_review_opened", summary: `${sp.accession_number} part ${sp.designation}: correction review ${display} opened (issued part not changed).`, ref: id };
}

// ------------------------------------------------------------------ (c)/(d) pre-accession

function reviewPreAccessionAmendment(
  ctx: Ctx,
  order: OrderRow,
  part: OrderPartRow,
  changes: FieldChange[],
  versionLabel: string,
  canceled?: "canceled" | "removed",
): ReconciliationNote[] {
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

  // Active holds that reference this order part (directly, through its containers, or through a linked clarification).
  const containerIds = (db.prepare("SELECT id FROM container WHERE order_part_id = ?").all(part.id) as { id: string }[]).map((r) => r.id);
  const holds = db
    .prepare(
      `SELECT * FROM hold WHERE status = 'active' AND (
          (scope_type = 'order_part' AND scope_id = ?)
          ${containerIds.length ? `OR (scope_type = 'container' AND scope_id IN (${containerIds.map(() => "?").join(",")}))` : ""}
          OR clarification_id IN (SELECT id FROM clarification WHERE order_part_id = ?)
        ) ORDER BY placed_at`,
    )
    .all(part.id, ...containerIds, part.id) as { id: string; display_id: string; scope_label: string; intake_item_id: string | null; accession_id: string | null; clarification_id: string | null }[];

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
  if (!holds.length) {
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
    const p = JSON.parse(payloadText) as { order_id?: unknown; version?: unknown; updated_at?: unknown };
    return {
      key: `${source.tenant_id ?? source.id}:${typeof p.order_id === "string" ? p.order_id : "unknown"}`,
      version: typeof p.version === "number" ? p.version : null,
      updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
    };
  } catch {
    return { key: `${source.tenant_id ?? source.id}:unknown`, version: null, updatedAt: null };
  }
}

function writeReceipt(
  ctx: Ctx,
  r: { eventId: string; sourceId: string; messageId: string; messageType: string; outcome: string; detail: string; via: ReceiptVia },
): void {
  ctx.db
    .prepare(
      `INSERT INTO integration_receipt (id, event_id, source_id, message_id, message_type, received_at, outcome, detail, via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(ctx.db, "irc"), r.eventId, r.sourceId, r.messageId, r.messageType, ctx.now, r.outcome, r.detail, r.via);
}
