import type { DB } from "../db/db";
import { ins, addMinutes } from "./util";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import type { GrossFields } from "@/lib/gross";
import { emptyGrossFields, GROSS_TEMPLATES } from "@/lib/gross";

export const NAMESPACE = "EMA-SIM DERM";
const NS = namespaceCode(NAMESPACE);

let auditCounter = 0;
export function resetBuilderCounters(): void {
  auditCounter = 0;
}

export function seedAudit(
  db: DB,
  e: {
    at: string;
    actor: string;
    role: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    accessionId?: string | null;
    intakeItemId?: string | null;
    origin?: string;
    after?: unknown;
    reason?: string;
  },
): void {
  auditCounter += 1;
  ins(db, "audit_event", {
    id: `aud_seed_${String(auditCounter).padStart(6, "0")}`,
    at: e.at,
    recorded_at: e.at,
    actor_id: e.actor,
    actor_role: e.role,
    origin: e.origin ?? "demo",
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId,
    accession_id: e.accessionId ?? null,
    intake_item_id: e.intakeItemId ?? null,
    summary: e.summary,
    before_json: null,
    after_json: e.after === undefined ? null : JSON.stringify(e.after),
    reason: e.reason ?? null,
    correlation_id: "seed",
  });
}

export interface PatientSpec {
  tenant: string;
  mrn: string;
  given: string;
  family: string;
  dob: string;
  sex?: string;
}

export function upsertPatient(db: DB, p: PatientSpec, importedAt: string): string {
  const existing = db.prepare("SELECT id FROM patient_ref WHERE tenant_id = ? AND source_mrn = ?").get(p.tenant, p.mrn) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = `pt_${p.tenant.replace("ten_", "")}_${p.mrn}`;
  ins(db, "patient_ref", {
    id, tenant_id: p.tenant, source_mrn: p.mrn, family_name: p.family, given_name: p.given, birth_date: p.dob,
    sex: p.sex ?? null, source_updated_at: importedAt, imported_at: importedAt,
  });
  return id;
}

export function createEncounter(
  db: DB,
  e: { tenant: string; srcId: string; patientId: string; officeId: string; clinicianId: string; at: string | null },
): string {
  const existing = db.prepare("SELECT id FROM encounter WHERE tenant_id = ? AND source_encounter_id = ?").get(e.tenant, e.srcId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = `enc_${e.srcId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  ins(db, "encounter", {
    id, tenant_id: e.tenant, source_encounter_id: e.srcId, patient_ref_id: e.patientId, office_id: e.officeId,
    clinician_id: e.clinicianId, encounter_at: e.at, source_updated_at: e.at, imported_at: e.at ?? addMinutes(new Date().toISOString(), 0),
  });
  return id;
}

export interface OrderPartSpec {
  designation: string;
  site: string;
  laterality: string | null;
  procedure: string | null;
  collectedAt: string | null;
  expectedContainers?: number | null;
  stains?: string[];
  orientation?: string | null;
}

export interface OrderSpec {
  tenant: string;
  sourceId: string; // integration source row id (src_ema / src_oth)
  srcOrderId: string;
  patientId: string;
  encounterId: string | null;
  officeId: string;
  clinicianId: string | null;
  updatedAt: string;
  note?: string | null;
  parts: OrderPartSpec[];
  version?: number;
}

export function orderPayload(o: OrderSpec, patient: { mrn: string; given: string; family: string; dob: string }, encounterSrc: string | null, officeSrc: string, clinicianSrc: string | null) {
  return {
    resourceType: "SimulatedOrder",
    order_id: o.srcOrderId,
    version: o.version ?? 1,
    updated_at: o.updatedAt,
    status: "active",
    patient: { mrn: patient.mrn, name: `${patient.family}, ${patient.given}`, birth_date: patient.dob },
    encounter_id: encounterSrc,
    office_id: officeSrc,
    ordering_provider_id: clinicianSrc,
    clinical_note: o.note ?? null,
    specimens: o.parts.map((p) => ({
      designation: p.designation,
      site: p.site,
      laterality: p.laterality,
      procedure: p.procedure,
      collected_at: p.collectedAt,
      expected_containers: p.expectedContainers ?? 1,
      requested_stains: p.stains ?? [],
      orientation: p.orientation ?? null,
    })),
  };
}

export function createOrder(db: DB, o: OrderSpec, payload: unknown): { orderId: string; partIds: string[] } {
  const orderId = `ord_${o.srcOrderId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const importedAt = addMinutes(o.updatedAt, 1);
  const msgId = `${o.srcOrderId}#v${o.version ?? 1}`;
  ins(db, "integration_event", {
    id: `ie_${orderId}_v${o.version ?? 1}`, source_id: o.sourceId, message_id: msgId, message_type: "order.upsert",
    entity_key: `${o.tenant}:${o.srcOrderId}`, source_version: o.version ?? 1, source_updated_at: o.updatedAt,
    received_at: importedAt, outcome: "applied", detail: "Imported from simulated source", payload: JSON.stringify(payload), receipt_count: 1,
  });
  ins(db, "source_order", {
    id: orderId, tenant_id: o.tenant, source_order_id: o.srcOrderId, patient_ref_id: o.patientId, encounter_id: o.encounterId,
    office_id: o.officeId, ordering_clinician_id: o.clinicianId, source_status: "active", source_version: o.version ?? 1,
    source_updated_at: o.updatedAt, imported_at: importedAt, import_event_id: `ie_${orderId}_v${o.version ?? 1}`,
    clinical_note: o.note ?? null, review_state: "unreviewed", version: 1,
  });
  ins(db, "source_order_version", {
    id: `sov_${orderId}_v${o.version ?? 1}`, source_order_id: orderId, source_version: o.version ?? 1, source_updated_at: o.updatedAt,
    imported_at: importedAt, payload: JSON.stringify(payload), change_summary: "Initial version",
  });
  const partIds: string[] = [];
  for (const p of o.parts) {
    const id = `${orderId}_${p.designation.toLowerCase()}`;
    ins(db, "source_order_part", {
      id, source_order_id: orderId, designation: p.designation, site_text: p.site, site_normalized: p.site.toLowerCase(),
      laterality: p.laterality, procedure: p.procedure, orientation_note: p.orientation ?? null, collected_at: p.collectedAt,
      expected_containers: p.expectedContainers === undefined ? 1 : p.expectedContainers,
      requested_stains: JSON.stringify((p.stains ?? []).map((s) => ({ stain: s, source: "order" }))), status: "active",
    });
    partIds.push(id);
  }
  return { orderId, partIds };
}

export interface ContainerSpec {
  orderPartId: string | null;
  observed: Record<string, unknown>;
  verified?: { by: string; at: string } | null;
  capture?: string;
}

export function createIntake(
  db: DB,
  i: {
    display: string;
    deliveryId: string | null;
    officeId: string | null;
    observedOfficeText?: string | null;
    receivedAt: string;
    receivedBy: string;
    status: string;
    orderIds: string[];
    containers: ContainerSpec[];
    owner?: string | null;
  },
): { intakeId: string; containerIds: string[] } {
  const intakeId = `int_${i.display.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  ins(db, "intake_item", {
    id: intakeId, display_id: i.display, delivery_id: i.deliveryId, office_id: i.officeId, observed_office_text: i.observedOfficeText ?? null,
    received_at: i.receivedAt, received_by: i.receivedBy, status: i.status, current_owner_id: i.owner ?? i.receivedBy, accession_id: null,
    version: 1, updated_at: i.receivedAt, updated_by: i.receivedBy,
  });
  for (const orderId of i.orderIds) {
    ins(db, "intake_order_link", { intake_item_id: intakeId, source_order_id: orderId, link_basis: "requisition_barcode", linked_by: i.receivedBy, linked_at: i.receivedAt });
  }
  const containerIds: string[] = [];
  i.containers.forEach((c, idx) => {
    const id = `${intakeId}_c${idx + 1}`;
    ins(db, "container", {
      id, intake_item_id: intakeId, seq: idx + 1, observed_label: JSON.stringify(c.observed), label_capture: c.capture ?? "typed",
      order_part_id: c.orderPartId, link_basis: c.orderPartId ? "staff_match" : "unknown",
      verification_state: c.verified ? "verified" : "unverified", verified_by: c.verified?.by ?? null, verified_at: c.verified?.at ?? null,
      condition_note: null, version: 1,
    });
    containerIds.push(id);
  });
  return { intakeId, containerIds };
}

export function createRoutingDecision(
  db: DB,
  r: { intakeId: string; officeId: string | null; pathologistId: string | null; status: string; by: string | null; at: string; explanation: string; ruleSet?: string },
): string {
  const id = `rd_${r.intakeId}`;
  const ruleId = r.officeId && r.pathologistId ? `rr_v3_${r.officeId}` : null;
  ins(db, "routing_decision", {
    id, intake_item_id: r.intakeId, status: r.status, suggested_pathologist_id: r.pathologistId, final_pathologist_id: r.status === "exception" ? null : r.pathologistId,
    rule_set_id: ruleId ? r.ruleSet ?? "rrs_v3" : null, rule_id: ruleId, coverage_exception_id: null, explanation: r.explanation,
    override_reason: null, decided_by: r.by, decided_at: r.status === "suggested" || r.status === "exception" ? null : r.at, created_at: r.at,
  });
  return id;
}

export function createAccession(
  db: DB,
  a: {
    number: string;
    issuedAt: string;
    patientId: string;
    officeId: string;
    clinicianId: string | null;
    pathologistId: string;
    routingDecisionId: string | null;
    day: string;
    prior?: boolean;
    status?: string;
    priority?: string;
    owner?: string | null;
  },
): string {
  const id = `acc_${a.number.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  ins(db, "accession", {
    id, accession_number: a.number, namespace: NAMESPACE, source_case_id: `SIM-CASE-${a.number.replace("D26-", "")}`,
    issued_at: a.issuedAt, issued_by_system: "Authoritative source simulator (EMA-SIM)", patient_ref_id: a.patientId, office_id: a.officeId,
    ordering_clinician_id: a.clinicianId, assigned_pathologist_id: a.pathologistId, routing_decision_id: a.routingDecisionId,
    case_status: a.status ?? "open", priority: a.priority ?? "routine", current_owner_id: a.owner ?? null, received_day: a.day,
    is_prior_day: a.prior ? 1 : 0, version: 1, updated_at: a.issuedAt,
  });
  return id;
}

export function createPart(
  db: DB,
  p: {
    accessionId: string;
    accessionNumber: string;
    designation: string;
    orderId: string;
    orderPartId: string;
    originalDesignation: string;
    site: string;
    laterality: string | null;
    procedure: string | null;
    containerId: string | null;
    physical: string;
  },
): string {
  const id = `${p.accessionId}_p${p.designation.toLowerCase()}`;
  ins(db, "specimen_part", {
    id, accession_id: p.accessionId, designation: p.designation, source_order_id: p.orderId, source_order_part_id: p.orderPartId,
    original_designation: p.originalDesignation, site_text: p.site, laterality: p.laterality, procedure: p.procedure,
    container_id: p.containerId, physical_state: p.physical, status: "active", version: 1,
  });
  return id;
}

export function blockIdentifier(accessionNumber: string, part: string, block: number): string {
  return encodeLabel({ kind: "B", namespace: NS, accession: accessionNumber, part, block });
}
export function slideIdentifier(accessionNumber: string, part: string, block: number, slide: number, stain: string): string {
  return encodeLabel({ kind: "S", namespace: NS, accession: accessionNumber, part, block, slide, stain });
}

export function createBlock(
  db: DB,
  b: {
    accessionId: string;
    accessionNumber: string;
    partId: string;
    part: string;
    seq: number;
    state: string;
    pieces: number | null;
    locationId?: string | null;
    locationAt?: string | null;
    locationBy?: string | null;
    custody?: string;
    holder?: string | null;
  },
): string {
  const id = `${b.partId}_b${b.seq}`;
  ins(db, "block", {
    id, accession_id: b.accessionId, part_id: b.partId, block_seq: b.seq, label_text: `${b.part}${b.seq}`,
    identifier: blockIdentifier(b.accessionNumber, b.part, b.seq), physical_state: b.state, pieces_submitted: b.pieces,
    current_location_id: b.locationId ?? null, location_confirmed_at: b.locationAt ?? null, location_confirmed_by: b.locationBy ?? null,
    custody_state: b.custody ?? "in_workflow", checkout_holder_id: b.holder ?? null, status: "active", version: 1,
  });
  return id;
}

export function createSlide(
  db: DB,
  s: {
    accessionId: string;
    accessionNumber: string;
    blockId: string;
    part: string;
    block: number;
    seq: number;
    stain: string;
    level?: string | null;
    workOrderId?: string | null;
    state: string;
    labelState: string;
    status?: string;
  },
): string {
  const id = `${s.blockId}_s${s.seq}`;
  ins(db, "slide", {
    id, accession_id: s.accessionId, block_id: s.blockId, slide_seq: s.seq, stain: s.stain, level_label: s.level ?? null,
    work_order_id: s.workOrderId ?? null, identifier: slideIdentifier(s.accessionNumber, s.part, s.block, s.seq, s.stain),
    physical_state: s.state, label_state: s.labelState, status: s.status ?? "active", version: 1,
  });
  return id;
}

let woCounter = 2200;
let pjCounter = 8700;
export function setCounters(wo: number, pj: number): void {
  woCounter = wo;
  pjCounter = pj;
}
export function nextWoDisplay(): string {
  woCounter += 1;
  return `WO-${woCounter}`;
}
export function nextPjDisplay(): string {
  pjCounter += 1;
  return `PJ-${pjCounter}`;
}
export function currentCounters() {
  return { wo: woCounter, pj: pjCounter };
}

export function createWorkOrder(
  db: DB,
  w: {
    accessionId: string;
    kind: string;
    stain: string | null;
    auth: "source_order" | "standing_protocol" | "pathologist_request";
    reference: string;
    requestedByLabel: string;
    requestedByStaff?: string | null;
    orderId?: string | null;
    orderVersion?: number | null;
    partId?: string | null;
    blockId?: string | null;
    quantity?: number;
    status: string;
    at: string;
    display?: string;
  },
): string {
  const display = w.display ?? nextWoDisplay();
  const id = `wo_${display.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  ins(db, "work_order", {
    id, display_id: display, accession_id: w.accessionId, kind: w.kind, stain: w.stain, authorization_source: w.auth,
    source_reference: w.reference, requested_by_label: w.requestedByLabel, requested_by_staff_id: w.requestedByStaff ?? null,
    source_order_id: w.orderId ?? null, source_version: w.orderVersion ?? null, target_part_id: w.partId ?? null, target_block_id: w.blockId ?? null,
    quantity: w.quantity ?? 1, status: w.status, status_reason: null, requested_at: w.at, version: 1,
  });
  return id;
}

export function createPrintedLabel(
  db: DB,
  l: {
    targetType: "slide" | "block" | "accession";
    targetId: string;
    accessionId: string;
    payload: string;
    printer: string;
    kind: "slide_label" | "cassette_label" | "requisition_label";
    by: string;
    at: string;
    jobState?: string;
    labelState?: "printed" | "applied" | "verified" | null;
    display?: string;
  },
): string {
  const display = l.display ?? nextPjDisplay();
  const jobId = `pj_${display.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const state = l.jobState ?? (l.printer === "prn_c1" ? "completion_confirmed" : "acknowledged");
  ins(db, "print_job", {
    id: jobId, display_id: display, printer_id: l.printer, kind: l.kind, target_type: l.targetType, target_id: l.targetId,
    accession_id: l.accessionId, payload: l.payload, purpose: "initial", state, reprint_of_job_id: null, reprint_reason: null,
    idempotency_key: `seed-${jobId}`, requested_by: l.by, created_at: l.at, submitted_at: addMinutes(l.at, 0),
    acknowledged_at: state === "acknowledged" || state === "completion_confirmed" ? addMinutes(l.at, 0) : null,
    completed_at: state === "completion_confirmed" ? addMinutes(l.at, 1) : null, reconciled_by: null, reconciled_at: null,
    reconciliation: null, reconciliation_note: null, failure_detail: null, version: 1,
  });
  if (l.labelState) {
    ins(db, "label", {
      id: `lbl_${jobId}`, target_type: l.targetType, target_id: l.targetId, print_job_id: jobId, payload: l.payload, state: l.labelState,
      applied_by: l.labelState !== "printed" ? l.by : null, applied_at: l.labelState !== "printed" ? addMinutes(l.at, 2) : null,
      verified_by: l.labelState === "verified" ? l.by : null, verified_at: l.labelState === "verified" ? addMinutes(l.at, 3) : null,
      retired_by: null, retired_at: null, retire_reason: null, created_at: l.at,
    });
  }
  return jobId;
}

/** A confirmed, approved gross record for seeded history. */
export function confirmedGrossFields(
  procedure: string,
  pieces: number,
  dims: [number, number, number | null],
  unit: "cm" | "mm",
  appearance: string,
  ink: string,
  sectioning: string,
  cassettes: { label: string; pieces: number; description: string }[],
): GrossFields {
  const f = emptyGrossFields(procedure);
  const c = <T,>(value: T) => ({ value, status: "confirmed" as const });
  f.template_id = (GROSS_TEMPLATES[procedure] ?? GROSS_TEMPLATES.other).id;
  f.specimen_type = c(procedure);
  f.received_in = c("formalin");
  f.container_label_matches = c(true);
  f.piece_count = c(pieces);
  f.dimensions = c({ length: dims[0], width: dims[1], depth: dims[2], unit, raw: null });
  f.appearance = c(appearance);
  f.ink_orientation = c(ink);
  f.sectioning = c(sectioning);
  f.cassettes = c(cassettes);
  return f;
}

export function grossNarrative(part: string, site: string, procedure: string, f: GrossFields): string {
  const d = f.dimensions.value!;
  const dimText = [d.length, d.width, d.depth].filter((x) => x !== null).join(" x ");
  const pieces = f.piece_count.value === 1 ? "one" : String(f.piece_count.value);
  const cas = (f.cassettes.value ?? []).map((c) => c.label).join(", ");
  return `Part ${part}: received in formalin labeled with the patient's name and "${site}". Consists of ${pieces} ${f.appearance.value} ${procedure === "nail_clipping" ? "nail clipping fragment(s)" : "skin " + procedure + (f.piece_count.value === 1 ? "" : " pieces")} measuring ${dimText} ${d.unit}. ${f.ink_orientation.value}. ${f.sectioning.value}; submitted in cassette(s) ${cas}.`;
}

export function createGrossRecord(
  db: DB,
  g: {
    partId: string;
    state: string;
    sourceState: string;
    fields: GrossFields;
    narrative: string;
    grosser: string;
    createdAt: string;
    reviewedAt?: string | null;
    approvedAt?: string | null;
    approvedBy?: string | null;
    sourceEntryAt?: string | null;
    sourceEntryBy?: string | null;
    transcriptId?: string | null;
    unresolved?: unknown[];
    proposals?: unknown[];
    extractor?: string | null;
  },
): string {
  const id = `gr_${g.partId}_v1`;
  ins(db, "gross_record", {
    id, specimen_part_id: g.partId, record_version: 1, state: g.state, source_update_state: g.sourceState,
    transcript_id: g.transcriptId ?? null, narrative: g.narrative, fields: JSON.stringify(g.fields),
    proposals: JSON.stringify(g.proposals ?? []), unresolved: JSON.stringify(g.unresolved ?? []), extractor: g.extractor ?? null,
    grosser_id: g.grosser, reviewed_by: g.reviewedAt ? g.grosser : null, reviewed_at: g.reviewedAt ?? null,
    approved_by: g.approvedAt ? g.approvedBy ?? g.grosser : null, approved_at: g.approvedAt ?? null,
    source_entry_by: g.sourceEntryBy ?? null, source_entry_at: g.sourceEntryAt ?? null, source_ack_at: null,
    created_at: g.createdAt, updated_at: g.approvedAt ?? g.reviewedAt ?? g.createdAt, version: 1,
  });
  return id;
}
