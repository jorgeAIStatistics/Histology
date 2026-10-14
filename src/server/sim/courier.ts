import type { DB } from "../db/db";

/**
 * SIMULATOR ONLY: the physical contents of a courier delivery.
 *
 * A real deployment has no table that knows what is inside the courier bag.
 * The demo keeps one (`sim_physical_item`) so "unpacking" is reproducible:
 * each row is one requisition plus the bottle labels staff will read. The
 * intake bench records what staff observe; it never treats these rows as
 * verified facts about the tissue.
 */

export interface SimContainerLabel {
  patient_name?: string | null;
  birth_date?: string | null;
  mrn?: string | null;
  part_designation?: string | null;
  site_text?: string | null;
  laterality?: string | null;
  procedure?: string | null;
  collection_date?: string | null;
  handwritten?: boolean;
  raw_text?: string | null;
  [key: string]: unknown;
}

export interface SimRequisitionSpecimen {
  designation: string;
  site?: string | null;
  laterality?: string | null;
  procedure?: string | null;
  collected_at?: string | null;
}

export interface SimRequisition {
  order_id?: string | null;
  patient_name?: string | null;
  birth_date?: string | null;
  mrn?: string | null;
  specimens?: SimRequisitionSpecimen[];
  printed_from?: string | null;
  [key: string]: unknown;
}

export interface SimPhysicalItem {
  id: string;
  deliveryId: string;
  seq: number;
  observedOfficeText: string;
  requisitionOrderRef: string | null;
  requisition: SimRequisition;
  containers: SimContainerLabel[];
  receivedIntakeItemId: string | null;
}

interface Row {
  id: string;
  delivery_id: string;
  seq: number;
  observed_office_text: string;
  requisition_order_ref: string | null;
  requisition_fields: string;
  containers: string;
  received_intake_item_id: string | null;
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toItem(r: Row): SimPhysicalItem {
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    seq: r.seq,
    observedOfficeText: r.observed_office_text,
    requisitionOrderRef: r.requisition_order_ref,
    requisition: safeJson<SimRequisition>(r.requisition_fields, {}),
    containers: safeJson<SimContainerLabel[]>(r.containers, []),
    receivedIntakeItemId: r.received_intake_item_id,
  };
}

export function listPhysicalItems(db: DB, deliveryId: string): SimPhysicalItem[] {
  return (db.prepare("SELECT * FROM sim_physical_item WHERE delivery_id = ? ORDER BY seq").all(deliveryId) as Row[]).map(toItem);
}

export function getPhysicalItem(db: DB, id: string): SimPhysicalItem | null {
  const r = db.prepare("SELECT * FROM sim_physical_item WHERE id = ?").get(id) as Row | undefined;
  return r ? toItem(r) : null;
}

/** The next requisition still "in the courier bag" (lowest sequence not yet unpacked). */
export function nextUnreceived(db: DB, deliveryId: string): SimPhysicalItem | null {
  const r = db
    .prepare("SELECT * FROM sim_physical_item WHERE delivery_id = ? AND received_intake_item_id IS NULL ORDER BY seq LIMIT 1")
    .get(deliveryId) as Row | undefined;
  return r ? toItem(r) : null;
}

/** Find a not-necessarily-unpacked item by the order id printed on its requisition (exact, case-insensitive). */
export function findByOrderRef(db: DB, deliveryId: string, orderRef: string): SimPhysicalItem[] {
  return (
    db
      .prepare("SELECT * FROM sim_physical_item WHERE delivery_id = ? AND upper(requisition_order_ref) = upper(?) ORDER BY seq")
      .all(deliveryId, orderRef.trim()) as Row[]
  ).map(toItem);
}

export function markUnpacked(db: DB, physicalItemId: string, intakeItemId: string): void {
  db.prepare("UPDATE sim_physical_item SET received_intake_item_id = ? WHERE id = ? AND received_intake_item_id IS NULL").run(intakeItemId, physicalItemId);
}

export function countUnreceived(db: DB, deliveryId: string): number {
  return (
    db.prepare("SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ? AND received_intake_item_id IS NULL").get(deliveryId) as { n: number }
  ).n;
}

/** Readable text of a synthetic bottle label (used for typed-observation search and the label card). */
export function labelText(l: SimContainerLabel): string {
  if (l.raw_text) return String(l.raw_text);
  return [l.patient_name, l.birth_date, l.mrn ? `MRN ${l.mrn}` : null, l.part_designation ? `Part ${l.part_designation}` : null, l.site_text, l.procedure]
    .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
    .join(" · ");
}
