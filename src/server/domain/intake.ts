import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { closeTasks } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { labDay, fmtDate } from "@/lib/time";
import { LATERALITY, PROCEDURE } from "@/lib/domain";
import {
  type SimContainerLabel,
  type SimPhysicalItem,
  type SimRequisition,
  findByOrderRef,
  getPhysicalItem,
  labelText,
  listPhysicalItems,
  markUnpacked,
  nextUnreceived,
} from "../sim/courier";
import { computeAndStoreRouting } from "./routing";
import { detectRelatedForIntake } from "./related";

/**
 * Intake (pre-accession) domain: receiving a courier delivery, unpacking a
 * requisition and its containers, tenant-scoped order lookup, typed container
 * observations, explicit staff verification with a field-level comparison,
 * and expected-vs-received container reconciliation.
 *
 * Rules kept here:
 * - An outside identifier is looked up only inside its tenant (INV-1).
 * - A scan / requisition read IDENTIFIES a record; only a person verifies a
 *   container against its physical contents (INV-12).
 * - Original values (order, bottle, requisition) are kept as written; the
 *   normalized forms are used only for comparison.
 */

// ---------------------------------------------------------------- normalization (pure)

const LATERALITY_WORDS: Record<string, "left" | "right" | "bilateral" | "midline"> = {
  l: "left", lt: "left", lft: "left", left: "left",
  r: "right", rt: "right", rght: "right", right: "right",
  bilat: "bilateral", bilateral: "bilateral", "b/l": "bilateral", both: "bilateral",
  midline: "midline", mid: "midline",
};

const SITE_ABBREV: Record<string, string> = {
  ant: "anterior", post: "posterior", sup: "superior", inf: "inferior", lat: "lateral", med: "medial",
  prox: "proximal", dist: "distal", dors: "dorsal", vent: "ventral", upr: "upper", lwr: "lower", fh: "forehead",
};

export function normalizeLaterality(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/\.$/, "");
  if (!s) return null;
  if (s === "not_stated" || s === "not stated" || s === "n/a") return "not_stated";
  return LATERALITY_WORDS[s] ?? s;
}

/**
 * Split free-text site into laterality (if written) and the normalized site
 * words. Original text is not changed: `lateralityText` is the side exactly as
 * written ("L", "Lt.", "left"), for evidence and questions.
 */
export function parseSite(text: string | null | undefined): { laterality: string | null; lateralityText: string | null; core: string | null } {
  if (!text || !String(text).trim()) return { laterality: null, lateralityText: null, core: null };
  // Tokens keep their original spelling; a dotted word is split for comparison ("Lt." → "lt", "post.neck" → "post", "neck").
  const tokens: { orig: string; norm: string }[] = [];
  for (const word of String(text).replace(/[,;:()]/g, " ").split(/\s+/).filter(Boolean)) {
    const pieces = word.split(".").filter(Boolean);
    if (pieces.length <= 1) tokens.push({ orig: word, norm: (pieces[0] ?? word).toLowerCase() });
    else for (const p of pieces) tokens.push({ orig: p, norm: p.toLowerCase() });
  }
  let laterality: string | null = null;
  let lateralityText: string | null = null;
  const rest: string[] = [];
  tokens.forEach((t, idx) => {
    const lat = LATERALITY_WORDS[t.norm];
    // Full words anywhere; single letters ("L", "R") only at the start or the end ("Upper lip, L").
    if (lat && laterality === null && (t.norm.length > 1 || rest.length === 0 || idx === tokens.length - 1)) {
      laterality = lat;
      lateralityText = t.orig;
      return;
    }
    rest.push(SITE_ABBREV[t.norm] ?? t.norm);
  });
  return { laterality, lateralityText, core: rest.join(" ") || null };
}

export function normalizeProcedure(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  if (/^shave/.test(s)) return "shave";
  if (/^punch/.test(s)) return "punch";
  if (/^exc/.test(s)) return "excision";
  if (/^curett/.test(s)) return "curettage";
  if (/nail/.test(s)) return "nail clipping";
  return s;
}

export function normalizeName(v: string | null | undefined): string | null {
  if (!v || !String(v).trim()) return null;
  return String(v)
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export function normalizeDate(v: string | null | undefined): string | null {
  if (!v || !String(v).trim()) return null;
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s.toLowerCase();
}

// ---------------------------------------------------------------- comparison (pure)

export type CompareField =
  | "patient_name"
  | "birth_date"
  | "mrn"
  | "site"
  | "laterality"
  | "procedure"
  | "part_designation"
  | "collection_date";

export const COMPARE_FIELD_LABEL: Record<CompareField, string> = {
  patient_name: "Patient name",
  birth_date: "Date of birth",
  mrn: "MRN and tenant",
  site: "Site",
  laterality: "Laterality",
  procedure: "Procedure",
  part_designation: "Part designation",
  collection_date: "Collection date",
};

export type CompareStatus = "match" | "differs" | "not_compared";

export interface CellValue {
  /** Exactly as written in that source (original). */
  original: string | null;
  /** Normalized value used only for comparison. */
  normalized: string | null;
  /** Where it came from, e.g. "from site text 'L dorsal forearm'". */
  note?: string | null;
}

export interface ComparisonRow {
  field: CompareField;
  label: string;
  order: CellValue;
  observed: CellValue;
  requisition: CellValue;
  status: CompareStatus;
  /** Which pairs disagree, e.g. ["order≠observed"]. */
  pairs: string[];
  note: string | null;
}

export interface OrderSide {
  sourceOrderId: string;
  tenantName: string;
  sourceVersion: number;
  patientName: string; // "Family, Given"
  birthDate: string;
  mrn: string;
  part: {
    designation: string;
    siteText: string;
    laterality: string | null;
    procedure: string | null;
    collectedAt: string | null;
  };
}

export interface RequisitionSide {
  patientName: string | null;
  birthDate: string | null;
  mrn: string | null;
  specimen: { designation: string; site?: string | null; laterality?: string | null; procedure?: string | null; collected_at?: string | null } | null;
}

function cell(original: unknown, normalized: string | null, note?: string | null): CellValue {
  const o = original === null || original === undefined || String(original).trim() === "" ? null : String(original);
  return { original: o, normalized: o === null ? null : normalized, note: note ?? null };
}

function decide(field: CompareField, order: CellValue, observed: CellValue, requisition: CellValue): Pick<ComparisonRow, "status" | "pairs" | "note"> {
  const pairs: string[] = [];
  const pairsOf: [string, CellValue, CellValue][] = [
    ["order≠observed", order, observed],
    ["order≠requisition", order, requisition],
    ["observed≠requisition", observed, requisition],
  ];
  for (const [name, a, b] of pairsOf) if (a.normalized !== null && b.normalized !== null && a.normalized !== b.normalized) pairs.push(name);
  const present = [order, observed, requisition].filter((c) => c.normalized !== null).length;

  // Laterality: a sided order (left/right) with no side on the bottle is a question, not a match.
  if (field === "laterality" && pairs.length === 0 && (order.normalized === "left" || order.normalized === "right") && observed.normalized === null) {
    return { status: "differs", pairs: ["order≠observed"], note: "Order states a side; no side is written on the bottle label." };
  }
  if (pairs.length) return { status: "differs", pairs, note: null };
  if (present < 2) return { status: "not_compared", pairs, note: "Fewer than two sources state this value." };
  return { status: "match", pairs, note: null };
}

/**
 * Field-level comparison of the order part (source), the observed container
 * label (staff entry) and the paper requisition. Abbreviations such as
 * "L"/"Lt"/"R" are normalized for comparison only; originals are kept.
 */
export function compareContainer(order: OrderSide | null, observed: SimContainerLabel, req: RequisitionSide | null): ComparisonRow[] {
  const obsSite = parseSite(observed.site_text ?? null);
  const obsLatExplicit = normalizeLaterality((observed.laterality as string | null | undefined) ?? null);
  const noSite = { laterality: null, lateralityText: null, core: null };
  const orderSite = order ? parseSite(order.part.siteText) : noSite;
  const reqSite = req?.specimen ? parseSite(req.specimen.site ?? null) : noSite;
  const reqLatExplicit = normalizeLaterality(req?.specimen?.laterality ?? null);
  const orderLat = order ? normalizeLaterality(order.part.laterality) ?? orderSite.laterality : null;

  const rows: ComparisonRow[] = [];
  const push = (field: CompareField, o: CellValue, ob: CellValue, rq: CellValue) => {
    rows.push({ field, label: COMPARE_FIELD_LABEL[field], order: o, observed: ob, requisition: rq, ...decide(field, o, ob, rq) });
  };

  push(
    "patient_name",
    cell(order?.patientName, normalizeName(order?.patientName)),
    cell(observed.patient_name, normalizeName(observed.patient_name ?? null)),
    cell(req?.patientName, normalizeName(req?.patientName ?? null)),
  );
  push(
    "birth_date",
    cell(order?.birthDate, normalizeDate(order?.birthDate)),
    cell(observed.birth_date, normalizeDate(observed.birth_date ?? null)),
    cell(req?.birthDate, normalizeDate(req?.birthDate ?? null)),
  );
  push(
    "mrn",
    cell(order ? `${order.mrn} (${order.tenantName})` : null, order ? order.mrn.trim() : null),
    cell(observed.mrn, observed.mrn ? String(observed.mrn).trim() : null, observed.mrn ? "Tenant assumed from the order's source" : null),
    cell(req?.mrn, req?.mrn ? String(req.mrn).trim() : null),
  );
  push(
    "site",
    cell(order?.part.siteText, orderSite.core),
    cell(observed.site_text, obsSite.core),
    cell(req?.specimen?.site, reqSite.core),
  );
  const orderLatOriginal = order ? (order.part.laterality ? LATERALITY[order.part.laterality as keyof typeof LATERALITY] ?? order.part.laterality : null) : null;
  const obsLatValue = obsLatExplicit ?? obsSite.laterality;
  // The side exactly as written: the separate field if present, otherwise the token found in the site text.
  const obsLatOriginal = observed.laterality ? String(observed.laterality) : obsSite.lateralityText;
  const reqLatValue = reqLatExplicit ?? reqSite.laterality;
  const reqLatOriginal = req?.specimen?.laterality ? String(req.specimen.laterality) : reqSite.lateralityText;
  push(
    "laterality",
    cell(orderLatOriginal, orderLat),
    cell(obsLatOriginal, obsLatValue, !observed.laterality && obsSite.laterality ? `from site text "${observed.site_text}"` : null),
    cell(reqLatOriginal, reqLatValue, !req?.specimen?.laterality && reqSite.laterality ? `from site text "${req?.specimen?.site}"` : null),
  );
  push(
    "procedure",
    cell(order?.part.procedure ? PROCEDURE[order.part.procedure as keyof typeof PROCEDURE] ?? order.part.procedure : null, normalizeProcedure(order?.part.procedure)),
    cell(observed.procedure, normalizeProcedure(observed.procedure ?? null)),
    cell(req?.specimen?.procedure, normalizeProcedure(req?.specimen?.procedure ?? null)),
  );
  push(
    "part_designation",
    cell(order?.part.designation, order ? order.part.designation.trim().toUpperCase() : null),
    cell(observed.part_designation, observed.part_designation ? String(observed.part_designation).trim().toUpperCase() : null),
    cell(req?.specimen?.designation, req?.specimen?.designation ? req.specimen.designation.trim().toUpperCase() : null),
  );
  const orderDay = order?.part.collectedAt ? labDay(order.part.collectedAt) : null;
  const reqDay = req?.specimen?.collected_at ? labDay(req.specimen.collected_at) : null;
  push(
    "collection_date",
    cell(order?.part.collectedAt ? fmtDate(order.part.collectedAt) : null, orderDay),
    cell(observed.collection_date, normalizeDate((observed.collection_date as string | null | undefined) ?? null)),
    cell(req?.specimen?.collected_at ? fmtDate(req.specimen.collected_at) : null, reqDay),
  );
  return rows;
}

// ---------------------------------------------------------------- loaders

export interface IntakeItemRow {
  id: string;
  display_id: string;
  delivery_id: string | null;
  office_id: string | null;
  observed_office_text: string | null;
  received_at: string;
  received_by: string | null;
  status: string;
  current_owner_id: string | null;
  accession_id: string | null;
  version: number;
  updated_at: string;
  updated_by: string | null;
  notes: string | null;
}

export interface ContainerRow {
  id: string;
  intake_item_id: string;
  seq: number;
  observed_label: string;
  label_capture: string;
  order_part_id: string | null;
  link_basis: string | null;
  verification_state: "unverified" | "verified" | "discrepancy";
  verified_by: string | null;
  verified_at: string | null;
  condition_note: string | null;
  version: number;
}

export function loadIntakeItem(db: DB, id: string): IntakeItemRow {
  const r = db.prepare("SELECT * FROM intake_item WHERE id = ?").get(id) as IntakeItemRow | undefined;
  if (!r) throw new DomainError("NOT_FOUND", "Intake item was not found");
  return r;
}

export function loadContainer(db: DB, id: string): ContainerRow {
  const r = db.prepare("SELECT * FROM container WHERE id = ?").get(id) as ContainerRow | undefined;
  if (!r) throw new DomainError("NOT_FOUND", "Container was not found");
  return r;
}

export function parseLabel(c: Pick<ContainerRow, "observed_label">): SimContainerLabel {
  try {
    return JSON.parse(c.observed_label) as SimContainerLabel;
  } catch {
    return {};
  }
}

/** Tenant-scoped order lookup: an order id means nothing without its tenant (INV-1). */
export function findOrderInTenant(db: DB, tenantId: string, sourceOrderId: string): { id: string; source_status: string } | null {
  return (
    (db
      .prepare("SELECT id, source_status FROM source_order WHERE tenant_id = ? AND upper(source_order_id) = upper(?)")
      .get(tenantId, sourceOrderId.trim()) as { id: string; source_status: string } | undefined) ?? null
  );
}

export function orderSideFor(db: DB, orderPartId: string): OrderSide | null {
  const r = db
    .prepare(
      `SELECT so.source_order_id, so.source_version, t.name tenant_name, pr.family_name, pr.given_name, pr.birth_date, pr.source_mrn,
              sop.designation, sop.site_text, sop.laterality, sop.procedure, sop.collected_at
         FROM source_order_part sop JOIN source_order so ON so.id = sop.source_order_id JOIN patient_ref pr ON pr.id = so.patient_ref_id
         JOIN source_tenant t ON t.id = so.tenant_id WHERE sop.id = ?`,
    )
    .get(orderPartId) as
    | {
        source_order_id: string; source_version: number; tenant_name: string; family_name: string; given_name: string; birth_date: string;
        source_mrn: string; designation: string; site_text: string; laterality: string | null; procedure: string | null; collected_at: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    sourceOrderId: r.source_order_id,
    tenantName: r.tenant_name,
    sourceVersion: r.source_version,
    patientName: `${r.family_name}, ${r.given_name}`,
    birthDate: r.birth_date,
    mrn: r.source_mrn,
    part: { designation: r.designation, siteText: r.site_text, laterality: r.laterality, procedure: r.procedure, collectedAt: r.collected_at },
  };
}

export function requisitionFor(db: DB, intakeItemId: string): SimRequisition | null {
  const r = db.prepare("SELECT observed_fields FROM requisition_doc WHERE intake_item_id = ? ORDER BY id LIMIT 1").get(intakeItemId) as
    | { observed_fields: string }
    | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.observed_fields) as SimRequisition;
  } catch {
    return null;
  }
}

export function requisitionSide(req: SimRequisition | null, designation: string | null): RequisitionSide | null {
  if (!req) return null;
  const specimens = req.specimens ?? [];
  const spec = (designation ? specimens.find((s) => s.designation?.toUpperCase() === designation.toUpperCase()) : null) ?? (specimens.length === 1 ? specimens[0] : null);
  return { patientName: req.patient_name ?? null, birthDate: req.birth_date ?? null, mrn: req.mrn ?? null, specimen: spec ?? null };
}

/** Comparison for a container against a given order part (defaults to its linked part). */
export function comparisonForContainer(db: DB, container: ContainerRow, orderPartId?: string | null): ComparisonRow[] {
  const partId = orderPartId ?? container.order_part_id;
  const order = partId ? orderSideFor(db, partId) : null;
  const observed = parseLabel(container);
  const req = requisitionSide(requisitionFor(db, container.intake_item_id), order?.part.designation ?? (observed.part_designation as string | null) ?? null);
  return compareContainer(order, observed, req);
}

function staffName(db: DB, id: string | null | undefined): string {
  if (!id) return "Unknown";
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

// ---------------------------------------------------------------- discrepancies

export type ResolutionKind = "order_amended" | "lead_accepted" | "relinked" | "count_reconciled" | "staff_linked";

export interface DiscrepancyRow {
  id: string;
  intake_item_id: string;
  kind: "field_mismatch" | "missing_container" | "extra_container" | "unmatched_container" | "order_not_linked";
  field: string | null;
  container_id: string | null;
  order_part_id: string | null;
  values_json: string;
  status: "open" | "resolved" | "withdrawn";
  detected_at: string;
  detected_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolution_kind: ResolutionKind | null;
  version: number;
}

/** Recorded values of a field mismatch (frozen as found). */
export interface MismatchValues {
  order?: CellValue;
  observed?: CellValue;
  requisition?: CellValue;
  pairs?: string[];
  orderVersion?: number;
}

export function mismatchValues(d: Pick<DiscrepancyRow, "values_json">): MismatchValues {
  try {
    return JSON.parse(d.values_json) as MismatchValues;
  } catch {
    return {};
  }
}

export const IDENTITY_FIELDS: readonly string[] = ["patient_name", "birth_date", "mrn"];

/**
 * Clarification categories that can answer a finding. A clarification of an
 * unrelated category (or an old one) does not cover a new discrepancy.
 */
export function coveringCategories(kind: DiscrepancyRow["kind"], field?: string | null): string[] {
  if (kind === "missing_container" || kind === "extra_container") return ["missing_container", "other"];
  switch (field) {
    case "patient_name":
    case "birth_date":
    case "mrn":
      return ["identity_conflict", "other"];
    case "laterality":
    case "site":
      return ["laterality", "site", "other"];
    case "procedure":
      return ["biopsy_method", "other"];
    case "part_designation":
      return ["other", "related_orders", "missing_container"];
    default:
      return ["other"];
  }
}

export interface CoveringClarification {
  id: string;
  display_id: string;
  state: string;
  category: string;
  /** Set once resolved (confirmed_observed | confirmed_order | source_amended | other). */
  resolution_code?: string | null;
  resolved_at?: string | null;
}

type ClarificationRefs = { containerId?: string | null; orderPartId?: string | null; intakeItemId?: string | null };

/** SQL conditions matching clarifications raised on these refs (container, order part, or the item itself). */
function refConditions(refs: ClarificationRefs): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (refs.containerId) {
    conds.push("container_id = ?");
    params.push(refs.containerId);
  }
  if (refs.orderPartId) {
    conds.push("order_part_id = ?");
    params.push(refs.orderPartId);
  }
  if (refs.intakeItemId) {
    conds.push("(intake_item_id = ? AND container_id IS NULL AND order_part_id IS NULL)");
    params.push(refs.intakeItemId);
  }
  return { conds, params };
}

/**
 * The clarification that covers a finding on this container / order part:
 * matching category, and either still open, or resolved after the finding was
 * recorded. `resolvedOnly`: only a resolved one counts. The row carries its
 * resolution code. Patient identity uses identityCoverage() instead.
 */
export function clarificationCovering(
  db: DB,
  refs: ClarificationRefs,
  opts: { categories: string[]; since?: string | null; resolvedOnly?: boolean },
): CoveringClarification | null {
  const { conds, params } = refConditions(refs);
  if (!conds.length || !opts.categories.length) return null;
  const cats = opts.categories.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, display_id, state, category, resolution_code, resolved_at FROM clarification
        WHERE state <> 'canceled' AND category IN (${cats}) AND (${conds.join(" OR ")}) ORDER BY created_at DESC`,
    )
    .all(...opts.categories, ...params) as CoveringClarification[];
  for (const r of rows) {
    const resolved = r.state === "resolved";
    if (opts.resolvedOnly && !resolved) continue;
    if (!resolved) return r;
    if (!opts.since || (r.resolved_at ?? "") >= opts.since) return r;
  }
  return null;
}

/**
 * Patient identity (name, birth date, MRN) at accession: the only answer that
 * lets the specimen be accessioned under the order's patient is an
 * `identity_conflict` clarification resolved by a lead as `confirmed_order`
 * (the office confirmed the order's patient is correct), resolved after the
 * finding, and not followed by a later identity decision that says otherwise.
 * An open question, a hold, another category or another code never covers it:
 *  - confirmed_observed: the bottle is right, so the order names a different
 *    patient. Accession waits for a corrected order and a new check of the
 *    container; the recorded mismatch closes only on that re-check, when the
 *    order's patient details match the bottle (verifyContainer). Nothing is
 *    relinked or changed automatically.
 *  - source_amended: the amended order has to arrive and be checked first.
 *  - other: not a decision about the patient.
 */
export const IDENTITY_COVERING = { category: "identity_conflict", resolutionCode: "confirmed_order" } as const;

const IDENTITY_NOT_COVERING_WHY: Record<string, string> = {
  confirmed_observed: "resolved as 'container is correct': the order names a different patient; accession waits for the corrected order and a new check of the container",
  source_amended: "resolved as 'order amended in the source': accession waits for the amended order version to arrive and a new check of the container",
  other: "resolved as 'other', which is not a confirmation of the order's patient; only 'office confirmed the order is correct' covers a patient identity difference",
};

export interface IdentityCoverage {
  covering: CoveringClarification | null;
  /** The identity decision (or other-category answer) that does NOT cover the finding, with the reason (for the blocker message). */
  notCovering: { clarification: CoveringClarification; why: string } | null;
}

export function identityCoverage(db: DB, refs: ClarificationRefs, since: string | null): IdentityCoverage {
  const { conds, params } = refConditions(refs);
  if (!conds.length) return { covering: null, notCovering: null };
  // Resolved after the finding, newest decision first: a later identity decision replaces an earlier one.
  const rows = (
    db
      .prepare(
        `SELECT id, display_id, state, category, resolution_code, resolved_at FROM clarification
          WHERE state = 'resolved' AND category IN (?, 'other') AND (${conds.join(" OR ")}) ORDER BY resolved_at DESC, rowid DESC`,
      )
      .all(IDENTITY_COVERING.category, ...params) as CoveringClarification[]
  ).filter((r) => !since || (r.resolved_at ?? "") >= since);
  const decision = rows.find((r) => r.category === IDENTITY_COVERING.category);
  if (decision?.resolution_code === IDENTITY_COVERING.resolutionCode) return { covering: decision, notCovering: null };
  if (decision) {
    const why = IDENTITY_NOT_COVERING_WHY[decision.resolution_code ?? ""] ?? `resolved as '${decision.resolution_code ?? "unknown"}', which does not confirm the order's patient`;
    return { covering: null, notCovering: { clarification: decision, why } };
  }
  const other = rows[0];
  if (!other) return { covering: null, notCovering: null };
  return {
    covering: null,
    notCovering: {
      clarification: other,
      why: `resolved in category '${other.category.replace(/_/g, " ")}'; only an identity clarification resolved as 'office confirmed the order is correct' covers a patient identity difference`,
    },
  };
}

/** An open (not resolved, not canceled) clarification about this container or order part, whatever its category. */
export function openClarificationOn(db: DB, refs: { containerId?: string | null; orderPartId?: string | null }): CoveringClarification | null {
  const conds: string[] = [];
  const params: string[] = [];
  if (refs.containerId) {
    conds.push("container_id = ?");
    params.push(refs.containerId);
  }
  if (refs.orderPartId) {
    conds.push("order_part_id = ?");
    params.push(refs.orderPartId);
  }
  if (!conds.length) return null;
  return (
    (db
      .prepare(`SELECT id, display_id, state, category FROM clarification WHERE state NOT IN ('resolved','canceled') AND (${conds.join(" OR ")}) ORDER BY created_at DESC LIMIT 1`)
      .get(...params) as CoveringClarification | undefined) ?? null
  );
}

/**
 * Why a recorded mismatch whose values now agree is still open. A recorded
 * mismatch is closed automatically only when the source order was amended and
 * the bottle observation is unchanged; never because someone retyped the
 * observation. Returns null when re-verification may close it.
 */
export function mismatchHoldReason(
  db: DB,
  d: DiscrepancyRow,
  now: ComparisonRow | undefined,
  currentOrderVersion: number,
): string | null {
  const rec = mismatchValues(d);
  const observationChanged = (rec.observed?.normalized ?? null) !== (now?.observed.normalized ?? null);
  const orderAmended = typeof rec.orderVersion === "number" && currentOrderVersion > rec.orderVersion;
  const open = openClarificationOn(db, { containerId: d.container_id, orderPartId: d.order_part_id });
  if (open) return `${open.display_id} is still open; its review decides this question`;
  if (IDENTITY_FIELDS.includes(d.field ?? "")) {
    return orderAmended && !observationChanged ? null : "Patient identity values now agree, but a recorded identity mismatch closes only through a resolved identity clarification or a source amendment";
  }
  if (orderAmended && !observationChanged) return null;
  if (observationChanged) return "The bottle observation was edited after this mismatch was recorded. An accessioning lead or supervisor must accept the correction, with a reason";
  return "Values now agree, but the order was not amended. An accessioning lead or supervisor must accept this, with a reason";
}

function openDiscrepancy(
  ctx: Ctx,
  d: { intakeItemId: string; kind: DiscrepancyRow["kind"]; field?: string | null; containerId?: string | null; orderPartId?: string | null; values: unknown },
): { row: DiscrepancyRow; created: boolean } {
  const existing = ctx.db
    .prepare(
      `SELECT * FROM intake_discrepancy WHERE status = 'open' AND intake_item_id = ? AND kind = ? AND COALESCE(container_id,'') = COALESCE(?, '')
        AND COALESCE(order_part_id,'') = COALESCE(?, '') AND COALESCE(field,'') = COALESCE(?, '')`,
    )
    .get(d.intakeItemId, d.kind, d.containerId ?? null, d.orderPartId ?? null, d.field ?? null) as DiscrepancyRow | undefined;
  if (existing) return { row: existing, created: false };
  const id = newId(ctx.db, "idc");
  ctx.db
    .prepare(
      `INSERT INTO intake_discrepancy (id, intake_item_id, kind, field, container_id, order_part_id, values_json, status, detected_at, detected_by, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`,
    )
    .run(id, d.intakeItemId, d.kind, d.field ?? null, d.containerId ?? null, d.orderPartId ?? null, JSON.stringify(d.values), ctx.now, ctx.actor.id);
  return { row: ctx.db.prepare("SELECT * FROM intake_discrepancy WHERE id = ?").get(id) as DiscrepancyRow, created: true };
}

/** Close an open discrepancy. Values stay as found; the closing decision is recorded beside them. */
const DISCREPANCY_KIND_WORDS: Record<DiscrepancyRow["kind"], string> = {
  field_mismatch: "mismatch",
  missing_container: "missing-container flag",
  extra_container: "extra-container flag",
  unmatched_container: "unmatched-container flag",
  order_not_linked: "unlinked-order flag",
};

/** Close an open discrepancy. Values stay as found; the closing decision is recorded beside them, with its own audit row. */
function closeDiscrepancy(ctx: Ctx, d: DiscrepancyRow, status: "resolved" | "withdrawn", kind: ResolutionKind, note: string): void {
  const res = ctx.db
    .prepare(
      `UPDATE intake_discrepancy SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?, resolution_kind = ?, version = version + 1
        WHERE id = ? AND status = 'open'`,
    )
    .run(status, ctx.now, ctx.actor.id, note, kind, d.id);
  if (res.changes !== 1) return; // already closed: nothing changed, nothing to record
  const what = d.kind === "field_mismatch" ? `${(COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field ?? "field").toLowerCase()} mismatch` : DISCREPANCY_KIND_WORDS[d.kind];
  audit(ctx, {
    action: "intake.discrepancy_closed",
    entityType: "intake_discrepancy",
    entityId: d.id,
    intakeItemId: d.intake_item_id,
    summary: `Recorded ${what} ${status === "withdrawn" ? "withdrawn" : "closed"} (${kind.replace(/_/g, " ")}): ${note}. Values kept as found.`,
    before: { status: d.status, version: d.version },
    after: {
      status,
      version: d.version + 1,
      resolutionKind: kind,
      kind: d.kind,
      field: d.field,
      containerId: d.container_id,
      orderPartId: d.order_part_id,
    },
  });
}

function openRows(db: DB, where: { intakeItemId?: string; containerId?: string; orderPartId?: string; kind: DiscrepancyRow["kind"] }): DiscrepancyRow[] {
  const conds = ["status = 'open'", "kind = ?"];
  const params: string[] = [where.kind];
  if (where.intakeItemId) {
    conds.push("intake_item_id = ?");
    params.push(where.intakeItemId);
  }
  if (where.containerId) {
    conds.push("container_id = ?");
    params.push(where.containerId);
  }
  if (where.orderPartId) {
    conds.push("order_part_id = ?");
    params.push(where.orderPartId);
  }
  return db.prepare(`SELECT * FROM intake_discrepancy WHERE ${conds.join(" AND ")} ORDER BY detected_at`).all(...params) as DiscrepancyRow[];
}

/**
 * Expected vs received containers per order part of this intake item:
 * missing (none, or fewer than expected) and extra (more than expected).
 * Unknown expected counts never produce "extra". Re-run whenever a container
 * is linked to a different part, so flags open and close with the evidence.
 */
export function reconcilePartCounts(ctx: Ctx, intakeItemId: string, because: string): { missing: string[]; extra: string[] } {
  const db = ctx.db;
  const parts = db
    .prepare(
      `SELECT sop.id, sop.designation, sop.expected_containers, so.source_order_id FROM intake_order_link l
         JOIN source_order so ON so.id = l.source_order_id JOIN source_order_part sop ON sop.source_order_id = so.id
        WHERE l.intake_item_id = ? AND sop.status = 'active' ORDER BY so.source_order_id, sop.designation`,
    )
    .all(intakeItemId) as { id: string; designation: string; expected_containers: number | null; source_order_id: string }[];
  const containers = containersFor(db, intakeItemId);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const p of parts) {
    const linked = containers.filter((c) => c.order_part_id === p.id);
    const got = linked.length;
    const expected = p.expected_containers;
    const detail = `Order ${p.source_order_id} part ${p.designation}: expected ${expected ?? "Unknown"}, received ${got}`;
    const values = { order: { source_order_id: p.source_order_id, designation: p.designation, expected_containers: expected }, received: got, containers: linked.map((c) => c.seq), detail };
    if (got === 0 || (expected !== null && got < expected)) {
      missing.push(p.designation);
      openDiscrepancy(ctx, { intakeItemId, kind: "missing_container", orderPartId: p.id, values });
    } else {
      for (const d of openRows(db, { intakeItemId, orderPartId: p.id, kind: "missing_container" })) closeDiscrepancy(ctx, d, "resolved", "count_reconciled", `${detail}. ${because}`);
    }
    if (expected !== null && got > expected) {
      extra.push(p.designation);
      openDiscrepancy(ctx, { intakeItemId, kind: "extra_container", orderPartId: p.id, values });
    } else {
      for (const d of openRows(db, { intakeItemId, orderPartId: p.id, kind: "extra_container" })) closeDiscrepancy(ctx, d, "resolved", "count_reconciled", `${detail}. ${because}`);
    }
  }
  return { missing, extra };
}

// ---------------------------------------------------------------- receiving

export interface DeliveryRow {
  id: string;
  display_id: string;
  courier_name: string;
  route_label: string | null;
  expected_at: string | null;
  arrived_at: string | null;
  received_by: string | null;
  status: string;
  version: number;
}

export function loadDelivery(db: DB, id: string): DeliveryRow {
  const d = db.prepare("SELECT * FROM courier_delivery WHERE id = ?").get(id) as DeliveryRow | undefined;
  if (!d) throw new DomainError("NOT_FOUND", "Courier delivery was not found");
  return d;
}

/** Record the courier arrival (who received it, when). Idempotent. */
export function receiveDelivery(ctx: Ctx, deliveryId: string): { delivery: DeliveryRow; duplicate: boolean } {
  const d = loadDelivery(ctx.db, deliveryId);
  if (d.arrived_at) return { delivery: d, duplicate: true };
  const updated = updateVersioned(ctx.db, "courier_delivery", deliveryId, undefined, {
    arrived_at: ctx.now,
    received_by: ctx.actor.id,
    status: "reconciling",
  }) as unknown as DeliveryRow;
  const lines = ctx.db.prepare("SELECT COUNT(*) n FROM manifest_line WHERE delivery_id = ?").get(deliveryId) as { n: number };
  audit(ctx, {
    action: "courier.arrived",
    entityType: "courier_delivery",
    entityId: deliveryId,
    summary: `Courier ${d.display_id} (${d.courier_name}) arrival recorded by ${ctx.actor.name}; ${lines.n} office manifest line(s) to reconcile`,
    after: { arrived_at: ctx.now, status: "reconciling" },
  });
  return { delivery: updated, duplicate: false };
}

function resolveOffice(db: DB, observedText: string): { id: string; tenant_id: string; name: string } | null {
  return (
    (db
      .prepare("SELECT id, tenant_id, name FROM office WHERE lower(trim(name)) = lower(trim(?)) OR lower(code) = lower(trim(?))")
      .get(observedText, observedText) as { id: string; tenant_id: string; name: string } | undefined) ?? null
  );
}

export interface ReceiveResult {
  intakeItemId: string;
  displayId: string;
  duplicate: boolean;
  physicalItemId: string;
  orderLinked: boolean;
  routingStatus: string;
  relatedCandidates: string[];
  missingParts: string[];
  remaining: number;
}

/**
 * Unpack one requisition and its containers from the (simulated) courier bag.
 * Idempotent: an already-received physical item returns its intake item.
 */
export function receivePhysicalItem(ctx: Ctx, input: { deliveryId: string; physicalItemId?: string; orderRef?: string }): ReceiveResult {
  const db = ctx.db;
  const delivery = loadDelivery(db, input.deliveryId);
  let item: SimPhysicalItem | null = null;
  if (input.physicalItemId) {
    item = getPhysicalItem(db, input.physicalItemId);
    if (!item || item.deliveryId !== input.deliveryId) throw new DomainError("NOT_FOUND", "That item is not part of this courier delivery");
  } else if (input.orderRef) {
    const matches = findByOrderRef(db, input.deliveryId, input.orderRef);
    if (!matches.length) throw new DomainError("NOT_FOUND", `No requisition with ${input.orderRef.trim()} is in courier ${delivery.display_id}`);
    item = matches.find((m) => !m.receivedIntakeItemId) ?? matches[0];
  } else {
    item = nextUnreceived(db, input.deliveryId);
    if (!item) throw new DomainError("VALIDATION", `Everything in courier ${delivery.display_id} has been unpacked`);
  }

  const remainingNow = () => (db.prepare("SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ? AND received_intake_item_id IS NULL").get(input.deliveryId) as { n: number }).n;

  if (item.receivedIntakeItemId) {
    const existing = loadIntakeItem(db, item.receivedIntakeItemId);
    const rd = db.prepare("SELECT status FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'").get(existing.id) as { status: string } | undefined;
    const links = (db.prepare("SELECT COUNT(*) n FROM intake_order_link WHERE intake_item_id = ?").get(existing.id) as { n: number }).n;
    const missingNow = db
      .prepare(
        `SELECT sop.designation FROM intake_discrepancy d JOIN source_order_part sop ON sop.id = d.order_part_id
          WHERE d.intake_item_id = ? AND d.kind = 'missing_container' AND d.status = 'open' ORDER BY sop.designation`,
      )
      .all(existing.id) as { designation: string }[];
    return {
      intakeItemId: existing.id, displayId: existing.display_id, duplicate: true, physicalItemId: item.id, orderLinked: links > 0,
      routingStatus: rd?.status ?? "unknown", relatedCandidates: [], missingParts: missingNow.map((m) => m.designation), remaining: remainingNow(),
    };
  }

  if (!delivery.arrived_at) receiveDelivery(ctx, input.deliveryId);

  const office = resolveOffice(db, item.observedOfficeText);
  const id = newId(db, "int");
  const disp = displayId(db, "INT-1014", 3);
  db.prepare(
    `INSERT INTO intake_item (id, display_id, delivery_id, office_id, observed_office_text, received_at, received_by, status, current_owner_id,
       accession_id, version, updated_at, updated_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL, 1, ?, ?, NULL)`,
  ).run(id, disp, input.deliveryId, office?.id ?? null, item.observedOfficeText, ctx.now, ctx.actor.id, ctx.actor.id, ctx.now, ctx.actor.id);

  // Requisition as read at the bench (a simulated read of the paper; it identifies, it does not verify).
  let orderId: string | null = null;
  let orderNote = "";
  if (item.requisitionOrderRef && office) {
    const found = findOrderInTenant(db, office.tenant_id, item.requisitionOrderRef);
    if (found) {
      orderId = found.id;
      db.prepare("INSERT INTO intake_order_link (intake_item_id, source_order_id, link_basis, linked_by, linked_at) VALUES (?, ?, 'requisition_barcode', ?, ?)").run(
        id, found.id, ctx.actor.id, ctx.now,
      );
      if (found.source_status === "canceled") orderNote = ` Order ${item.requisitionOrderRef} is canceled at the source.`;
    } else {
      orderNote = ` No order ${item.requisitionOrderRef} found in this office's source tenant.`;
    }
  } else if (item.requisitionOrderRef && !office) {
    orderNote = ` Office "${item.observedOfficeText}" is not in the directory, so ${item.requisitionOrderRef} cannot be looked up in a tenant (order ids are only unique within a tenant).`;
  } else {
    orderNote = " The requisition shows no order id.";
  }
  db.prepare("INSERT INTO requisition_doc (id, source_order_id, intake_item_id, observed_fields, handwritten_note, doc_ref) VALUES (?, ?, ?, ?, NULL, ?)").run(
    newId(db, "req"), orderId, id, JSON.stringify(item.requisition), `REQ-SIM-${item.requisitionOrderRef ?? disp}`,
  );

  if (!orderId) {
    openDiscrepancy(ctx, { intakeItemId: id, kind: "order_not_linked", values: { orderRef: item.requisitionOrderRef, office: item.observedOfficeText, detail: orderNote.trim() } });
  }

  // Containers: typed observations of each bottle label (synthetic label card).
  const parts = orderId
    ? (db.prepare("SELECT id, designation, expected_containers FROM source_order_part WHERE source_order_id = ? AND status = 'active' ORDER BY designation").all(orderId) as {
        id: string;
        designation: string;
        expected_containers: number | null;
      }[])
    : [];
  item.containers.forEach((label, idx) => {
    const cid = newId(db, "ctr");
    const desig = label.part_designation ? String(label.part_designation).trim().toUpperCase() : null;
    // A suggested link only; staff confirm (or change) it when they verify the container.
    let partId: string | null = null;
    let basis = "unknown";
    let unmatchedDetail = "";
    if (parts.length === 1) {
      if (!desig) {
        partId = parts[0].id;
        basis = "single_part_order";
      } else if (parts[0].designation.toUpperCase() === desig) {
        partId = parts[0].id;
        basis = "suggested_by_designation";
      } else {
        unmatchedDetail = `Bottle shows part ${desig}; order ${item.requisitionOrderRef ?? ""} has only part ${parts[0].designation}`;
      }
    } else if (desig) {
      partId = parts.find((p) => p.designation.toUpperCase() === desig)?.id ?? null;
      if (partId) basis = "suggested_by_designation";
      else unmatchedDetail = `Bottle shows part ${desig}, which is not a part on order ${item.requisitionOrderRef ?? ""}`;
    } else if (parts.length > 1) {
      unmatchedDetail = `Bottle shows no part designation and order ${item.requisitionOrderRef ?? ""} has ${parts.length} parts`;
    }
    const observed = { ...label, raw_text: label.raw_text ?? labelText(label) };
    db.prepare(
      `INSERT INTO container (id, intake_item_id, seq, observed_label, label_capture, order_part_id, link_basis, verification_state, verified_by, verified_at, condition_note, version)
       VALUES (?, ?, ?, ?, 'synthetic_image', ?, ?, 'unverified', NULL, NULL, NULL, 1)`,
    ).run(cid, id, idx + 1, JSON.stringify(observed), partId, basis);
    if (!partId && orderId) {
      openDiscrepancy(ctx, {
        intakeItemId: id, kind: "unmatched_container", containerId: cid,
        values: { observed: { part_designation: label.part_designation ?? null }, order: parts.map((p) => p.designation), detail: unmatchedDetail },
      });
    }
  });

  // Expected vs received per order part (missing and extra).
  const counts = orderId ? reconcilePartCounts(ctx, id, "Counted at unpacking") : { missing: [], extra: [] };
  const missingParts = counts.missing;

  markUnpacked(db, item.id, id);

  audit(ctx, {
    action: "intake.received",
    entityType: "intake_item",
    entityId: id,
    intakeItemId: id,
    summary: `${disp} received from courier ${delivery.display_id}: ${item.observedOfficeText}, ${item.containers.length} container(s)${orderId ? `, linked to ${item.requisitionOrderRef} (tenant-scoped lookup)` : ""}.${orderNote}${missingParts.length ? ` Missing container for part ${missingParts.join(", ")}.` : ""}${counts.extra.length ? ` More containers than expected for part ${counts.extra.join(", ")}.` : ""}`,
    after: { office: office?.name ?? null, order: item.requisitionOrderRef, containers: item.containers.length },
  });

  const rd = computeAndStoreRouting(ctx, id);
  const related = orderId ? detectRelatedForIntake(ctx, id) : [];

  recordWorklistChange(ctx, {
    intakeItemId: id,
    pathologistId: rd.suggested_pathologist_id,
    type: "new",
    summary: `${disp} arrived (${item.observedOfficeText}); provisional, not yet accessioned`,
  });

  const remaining = remainingNow();
  if (remaining === 0) finishUnpacking(ctx, input.deliveryId);

  return {
    intakeItemId: id, displayId: disp, duplicate: false, physicalItemId: item.id, orderLinked: !!orderId, routingStatus: rd.status,
    relatedCandidates: related.map((r) => r.display_id), missingParts, remaining,
  };
}

/**
 * Every requisition in the courier bag has been unpacked: the manifest
 * comparison is now final (missing / extra counts no longer "so far").
 * In this demo the courier simulator knows when the bag is empty.
 */
function finishUnpacking(ctx: Ctx, deliveryId: string): void {
  const db = ctx.db;
  const d = loadDelivery(db, deliveryId);
  if (d.status === "reconciled") return;
  const n = (sql: string) => (db.prepare(sql).get(deliveryId) as { n: number }).n;
  const items = n("SELECT COUNT(*) n FROM intake_item WHERE delivery_id = ?");
  const containers = n("SELECT COUNT(*) n FROM container c JOIN intake_item ii ON ii.id = c.intake_item_id WHERE ii.delivery_id = ?");
  const missing = n("SELECT COUNT(*) n FROM intake_discrepancy x JOIN intake_item ii ON ii.id = x.intake_item_id WHERE ii.delivery_id = ? AND x.kind = 'missing_container' AND x.status = 'open'");
  const extra = n("SELECT COUNT(*) n FROM intake_discrepancy x JOIN intake_item ii ON ii.id = x.intake_item_id WHERE ii.delivery_id = ? AND x.kind = 'extra_container' AND x.status = 'open'");
  const unknownLines = n("SELECT COUNT(*) n FROM manifest_line WHERE delivery_id = ? AND expected_containers IS NULL");
  updateVersioned(db, "courier_delivery", deliveryId, undefined, { status: "reconciled" });
  audit(ctx, {
    action: "courier.reconciled",
    entityType: "courier_delivery",
    entityId: deliveryId,
    summary: `Courier ${d.display_id}: all ${items} requisition(s) unpacked (courier contents simulated); ${containers} container(s) received. Order parts missing a container: ${missing}; parts with more containers than expected: ${extra}.${unknownLines ? ` Expected quantity Unknown for ${unknownLines} office(s) with no source manifest.` : ""}`,
    after: { status: "reconciled", items, containers, missingParts: missing, extraParts: extra },
  });
}

/** Demo convenience: unpack every requisition still in the (simulated) courier bag. */
export function receiveAll(ctx: Ctx, deliveryId: string): { received: ReceiveResult[]; alreadyReceived: number } {
  receiveDelivery(ctx, deliveryId);
  const items = listPhysicalItems(ctx.db, deliveryId);
  const received: ReceiveResult[] = [];
  let already = 0;
  for (const it of items) {
    if (it.receivedIntakeItemId) {
      already += 1;
      continue;
    }
    received.push(receivePhysicalItem(ctx, { deliveryId, physicalItemId: it.id }));
  }
  return { received, alreadyReceived: already };
}

// ---------------------------------------------------------------- observations, verification, edits

function assertEditable(it: IntakeItemRow, what: string): void {
  if (it.status === "accessioned" || it.status === "canceled") {
    throw new DomainError("INVARIANT", `${what}: ${it.display_id} is already ${it.status}. Post-accession discrepancies go through a correction review.`);
  }
}

const OBSERVATION_KEYS = ["patient_name", "birth_date", "mrn", "part_designation", "site_text", "laterality", "procedure", "collection_date"] as const;

/** Staff edits the typed observation of a bottle label. Any earlier verification must be repeated. */
export function recordObservation(
  ctx: Ctx,
  containerId: string,
  expectedVersion: number,
  observed: Partial<Record<(typeof OBSERVATION_KEYS)[number], string | null>> & { condition_note?: string | null },
): ContainerRow {
  const c = loadContainer(ctx.db, containerId);
  const it = loadIntakeItem(ctx.db, c.intake_item_id);
  assertEditable(it, "Cannot edit observations");
  const before = parseLabel(c);
  const next: SimContainerLabel = { ...before };
  const changed: string[] = [];
  for (const k of OBSERVATION_KEYS) {
    if (!(k in observed)) continue;
    const v = observed[k];
    const nv = v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();
    if ((before[k] ?? null) !== nv) {
      next[k] = nv;
      changed.push(k);
    }
  }
  const conditionChanged = "condition_note" in observed && (observed.condition_note ?? null) !== c.condition_note;
  if (!changed.length && !conditionChanged) {
    if (c.version !== expectedVersion) {
      // Still surface a stale view even when nothing changed.
      updateVersioned(ctx.db, "container", containerId, expectedVersion, {});
    }
    return c;
  }
  next.raw_text = labelText({ ...next, raw_text: null });
  const fields: Record<string, unknown> = { observed_label: JSON.stringify(next) };
  if (conditionChanged) fields.condition_note = observed.condition_note ?? null;
  const wasVerified = c.verification_state !== "unverified";
  if (changed.length && wasVerified) {
    fields.verification_state = "unverified";
    fields.verified_by = null;
    fields.verified_at = null;
  }
  const updated = updateVersioned(ctx.db, "container", containerId, expectedVersion, fields) as unknown as ContainerRow;
  touchItem(ctx, it, "in_review");
  audit(ctx, {
    action: "intake.observation_recorded",
    entityType: "container",
    entityId: containerId,
    intakeItemId: it.id,
    summary: `${it.display_id} container ${c.seq}: observation edited by ${ctx.actor.name} (${[...changed, ...(conditionChanged ? ["condition_note"] : [])].join(", ")})${changed.length && wasVerified ? ". Earlier verification cleared — verify again against the physical container." : ""}`,
    before: Object.fromEntries(changed.map((k) => [k, before[k] ?? null])),
    after: Object.fromEntries(changed.map((k) => [k, next[k] ?? null])),
  });
  return updated;
}

function touchItem(ctx: Ctx, it: IntakeItemRow, status?: string): void {
  const nextStatus = status && it.status === "received" ? status : it.status;
  ctx.db.prepare("UPDATE intake_item SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(nextStatus, ctx.now, ctx.actor.id, it.id);
}

export interface VerifyResult {
  containerId: string;
  state: "verified" | "discrepancy";
  version: number;
  comparison: ComparisonRow[];
  discrepancies: { field: CompareField; label: string; orderValue: string | null; observedValue: string | null; requisitionValue: string | null; discrepancyId: string }[];
  /** Recorded mismatches that stay open although the values now agree (and why). */
  stillOpen: { field: string; label: string; discrepancyId: string; reason: string }[];
  /** Differences a lead already accepted with a reason (same values, same order version): not recorded again. */
  accepted: { field: string; label: string }[];
  verificationId: string;
}

/** The latest lead acceptance of exactly these values for this container, part and field (null if none). */
function leadAcceptance(db: DB, containerId: string, orderPartId: string, row: ComparisonRow, orderVersion: number): DiscrepancyRow | null {
  const r = db
    .prepare(
      `SELECT * FROM intake_discrepancy WHERE container_id = ? AND order_part_id = ? AND kind = 'field_mismatch' AND field = ?
          AND status = 'resolved' AND resolution_kind = 'lead_accepted' ORDER BY resolved_at DESC, rowid DESC LIMIT 1`,
    )
    .get(containerId, orderPartId, row.field) as DiscrepancyRow | undefined;
  if (!r) return null;
  const v = mismatchValues(r);
  const same = (a: CellValue | undefined, b: CellValue) => (a?.normalized ?? null) === b.normalized;
  return v.orderVersion === orderVersion && same(v.order, row.order) && same(v.observed, row.observed) && same(v.requisition, row.requisition) ? r : null;
}

/**
 * "Staff verified against physical container": a person attests they checked
 * the bottle. Only people can do this (never a scan, OCR, rule or assistant).
 * Differences become recorded discrepancies with every value kept.
 *
 * A recorded mismatch is never closed just because someone retyped the
 * observation: it closes automatically only when the source order was amended
 * (and the observation is unchanged and no clarification is still open);
 * otherwise it stays open for a clarification or a lead's acceptance.
 */
export function verifyContainer(ctx: Ctx, containerId: string, expectedVersion: number, orderPartId: string): VerifyResult {
  if (ctx.origin !== "user" && ctx.origin !== "demo") {
    throw new DomainError("INVARIANT", "Only a person can verify a container against its physical contents. A scan, OCR read, rule or assistant never sets this.");
  }
  const db = ctx.db;
  const c = loadContainer(db, containerId);
  const it = loadIntakeItem(db, c.intake_item_id);
  assertEditable(it, "Cannot verify");
  const linked = db
    .prepare(
      `SELECT sop.id, sop.designation, so.source_order_id, so.source_version FROM source_order_part sop JOIN source_order so ON so.id = sop.source_order_id
         JOIN intake_order_link l ON l.source_order_id = so.id WHERE l.intake_item_id = ? AND sop.id = ? AND sop.status = 'active'`,
    )
    .get(it.id, orderPartId) as { id: string; designation: string; source_order_id: string; source_version: number } | undefined;
  if (!linked) {
    throw new DomainError("VALIDATION", `That order part is not an active part of an order linked to ${it.display_id}. Choose one of this item's order parts.`);
  }
  const comparison = comparisonForContainer(db, c, orderPartId);
  const accepted: VerifyResult["accepted"] = [];
  const differing = comparison.filter((r) => {
    if (r.status !== "differs") return false;
    if (leadAcceptance(db, containerId, orderPartId, r, linked.source_version)) {
      accepted.push({ field: r.field, label: r.label });
      return false;
    }
    return true;
  });
  const differingFields = new Set<string>(differing.map((d) => d.field));

  // Earlier mismatches on this container: still differing (kept), re-linked away (withdrawn), now agreeing (closed only on a source amendment).
  const toClose: { row: DiscrepancyRow; status: "resolved" | "withdrawn"; kind: ResolutionKind; note: string }[] = [];
  const stillOpen: VerifyResult["stillOpen"] = [];
  for (const d of openRows(db, { containerId, kind: "field_mismatch" })) {
    const label = COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field ?? "Field";
    if (d.order_part_id !== orderPartId) {
      toClose.push({
        row: d, status: "withdrawn", kind: "relinked",
        note: `Container ${c.seq} linked to ${linked.source_order_id} part ${linked.designation} by ${ctx.actor.name}; this comparison against another order part no longer applies (values kept)`,
      });
      continue;
    }
    if (differingFields.has(d.field ?? "")) continue;
    const why = mismatchHoldReason(db, d, comparison.find((r) => r.field === d.field), linked.source_version);
    if (why) stillOpen.push({ field: d.field ?? "", label, discrepancyId: d.id, reason: why });
    else {
      toClose.push({
        row: d, status: "resolved", kind: "order_amended",
        note: `${linked.source_order_id} amended to v${linked.source_version}; ${ctx.actor.name} checked the container again and the values now agree (original values kept)`,
      });
    }
  }
  const state: "verified" | "discrepancy" = differing.length || stillOpen.length ? "discrepancy" : "verified";

  const updated = updateVersioned(db, "container", containerId, expectedVersion, {
    order_part_id: orderPartId,
    link_basis: "staff_match",
    verification_state: state,
    verified_by: ctx.actor.id,
    verified_at: ctx.now,
  }) as unknown as ContainerRow;

  const verificationId = newId(db, "cv");
  db.prepare(
    `INSERT INTO container_verification (id, container_id, intake_item_id, order_part_id, source_order_version, result, comparison, attested_by, attested_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(verificationId, containerId, it.id, orderPartId, linked.source_version, state, JSON.stringify(comparison), ctx.actor.id, ctx.now, ctx.origin);

  for (const t of toClose) closeDiscrepancy(ctx, t.row, t.status, t.kind, t.note);
  // The staff link answers an "unmatched container" flag.
  for (const d of openRows(db, { containerId, kind: "unmatched_container" })) {
    closeDiscrepancy(ctx, d, "resolved", "staff_linked", `Linked to ${linked.source_order_id} part ${linked.designation} by ${ctx.actor.name}`);
  }

  const discrepancies: VerifyResult["discrepancies"] = [];
  for (const d of differing) {
    const { row } = openDiscrepancy(ctx, {
      intakeItemId: it.id, kind: "field_mismatch", field: d.field, containerId, orderPartId,
      values: { order: d.order, observed: d.observed, requisition: d.requisition, pairs: d.pairs, orderVersion: linked.source_version },
    });
    discrepancies.push({
      field: d.field, label: d.label, orderValue: d.order.original, observedValue: d.observed.original, requisitionValue: d.requisition.original, discrepancyId: row.id,
    });
  }

  // Container counts per order part change when a container is (re)linked.
  reconcilePartCounts(ctx, it.id, `Container ${c.seq} linked to ${linked.source_order_id} part ${linked.designation} by ${ctx.actor.name}`);

  touchItem(ctx, it, "in_review");
  closeTasks(ctx, "container_verification", "container", containerId);
  const parts: string[] = [];
  if (discrepancies.length) parts.push(`recorded a discrepancy — ${discrepancies.map((d) => `${d.label}: order "${d.orderValue ?? "not stated"}", bottle "${d.observedValue ?? "not on label"}"`).join("; ")}. Both values kept`);
  if (stillOpen.length) parts.push(`recorded mismatch still open — ${stillOpen.map((s) => `${s.label}: ${s.reason}`).join("; ")}`);
  if (accepted.length) parts.push(`${accepted.map((a) => a.label.toLowerCase()).join(", ")} differ as already accepted by a lead`);
  audit(ctx, {
    action: state === "verified" ? "intake.container_verified" : "intake.container_discrepancy",
    entityType: "container",
    entityId: containerId,
    intakeItemId: it.id,
    summary:
      state === "verified"
        ? `${it.display_id} container ${c.seq}: staff verified against physical container by ${ctx.actor.name}${ctx.origin === "demo" ? " (demo rehearsal)" : ""} (${linked.source_order_id} v${linked.source_version} part ${linked.designation}); ${accepted.length ? parts.join(". ") : "all compared fields agree"}`
        : `${it.display_id} container ${c.seq}: ${ctx.actor.name}${ctx.origin === "demo" ? " (demo rehearsal)" : ""} checked the physical container against ${linked.source_order_id} v${linked.source_version} part ${linked.designation} and ${parts.join(". ")}.`,
    after: { state, orderPart: `${linked.source_order_id} ${linked.designation}`, orderVersion: linked.source_version, stillOpen: stillOpen.map((s) => s.field) },
  });
  return { containerId, state, version: updated.version, comparison, discrepancies, stillOpen, accepted, verificationId };
}

/**
 * Accessioning lead / supervisor accepts a recorded field mismatch or an
 * extra container, with a reason (for example a typing error at the bench
 * corrected against the physical label). The values stay as found; the
 * decision is recorded beside them. Patient identity differences are not
 * accepted locally: they need an identity clarification resolved by a lead.
 * While a clarification on the container is open, its review decides instead.
 */
export function acceptDiscrepancy(ctx: Ctx, discrepancyId: string, expectedVersion: number, reason: string): { discrepancy: DiscrepancyRow; containerState: string | null } {
  const db = ctx.db;
  const d = db.prepare("SELECT * FROM intake_discrepancy WHERE id = ?").get(discrepancyId) as DiscrepancyRow | undefined;
  if (!d) throw new DomainError("NOT_FOUND", "Discrepancy was not found");
  const it = loadIntakeItem(db, d.intake_item_id);
  assertEditable(it, "Cannot accept a discrepancy");
  if (!reason.trim()) throw new DomainError("VALIDATION", "A reason is required to accept a discrepancy");
  if (d.kind !== "field_mismatch" && d.kind !== "extra_container") {
    throw new DomainError(
      "VALIDATION",
      d.kind === "missing_container"
        ? "A missing container is answered by the office: raise a missing-container clarification."
        : "An unmatched container is linked by verifying it against the correct order part.",
    );
  }
  if (d.status !== "open" && d.version === expectedVersion) throw new DomainError("VALIDATION", `This discrepancy is already ${d.status}`);
  if (d.kind === "field_mismatch" && IDENTITY_FIELDS.includes(d.field ?? "")) {
    throw new DomainError(
      "INVARIANT",
      "Patient identity differences are not accepted locally. Raise an identity clarification; accession waits until a lead resolves it (or the source order is amended).",
    );
  }
  const open = openClarificationOn(db, { containerId: d.container_id, orderPartId: d.order_part_id });
  if (open) {
    throw new DomainError("BLOCKED", `${open.display_id} is open for this ${d.container_id ? "container" : "order part"}. Its review on the Clarifications screen decides this question.`);
  }
  const label = d.kind === "field_mismatch" ? COMPARE_FIELD_LABEL[d.field as CompareField] ?? d.field ?? "Field" : "Extra container";
  const updated = updateVersioned(db, "intake_discrepancy", discrepancyId, expectedVersion, {
    status: "resolved",
    resolved_at: ctx.now,
    resolved_by: ctx.actor.id,
    resolution_note: reason.trim(),
    resolution_kind: "lead_accepted",
  }) as unknown as DiscrepancyRow;

  // A container whose last recorded mismatch was accepted counts as verified (the staff check stands; the acceptance is audited).
  let containerState: string | null = null;
  const c = d.container_id ? loadContainer(db, d.container_id) : null;
  if (c && c.verification_state === "discrepancy" && c.verified_by) {
    const remaining = openRows(db, { containerId: c.id, kind: "field_mismatch" }).filter((x) => x.order_part_id === c.order_part_id);
    if (!remaining.length) {
      updateVersioned(db, "container", c.id, undefined, { verification_state: "verified" });
      containerState = "verified";
    } else containerState = "discrepancy";
  }
  const v = mismatchValues(d);
  audit(ctx, {
    action: "intake.discrepancy_accepted",
    entityType: "intake_discrepancy",
    entityId: discrepancyId,
    intakeItemId: it.id,
    summary:
      d.kind === "field_mismatch"
        ? `${it.display_id}${c ? ` container ${c.seq}` : ""}: ${ctx.actor.name} accepted the recorded ${label.toLowerCase()} mismatch (order "${v.order?.original ?? "not stated"}", bottle "${v.observed?.original ?? "not on label"}"). Values kept as found.${containerState === "verified" ? " Container counts as verified." : ""}`
        : `${it.display_id}: ${ctx.actor.name} accepted more containers than expected (${(JSON.parse(d.values_json) as { detail?: string }).detail ?? "count differs"}).`,
    reason: reason.trim(),
    before: { status: "open" },
    after: { status: "resolved", resolution_kind: "lead_accepted", containerState },
  });
  return { discrepancy: updated, containerState };
}

/** Generic edit of an intake item (owner, notes). Optimistic concurrency: a stale edit is rejected, never applied. */
export function updateItem(ctx: Ctx, intakeItemId: string, expectedVersion: number, patch: { currentOwnerId?: string | null; notes?: string | null }): IntakeItemRow {
  const it = loadIntakeItem(ctx.db, intakeItemId);
  const fields: Record<string, unknown> = {};
  if ("currentOwnerId" in patch) {
    if (patch.currentOwnerId) {
      const s = ctx.db.prepare("SELECT id FROM staff WHERE id = ? AND active = 1").get(patch.currentOwnerId);
      if (!s) throw new DomainError("VALIDATION", "Owner must be an active staff member");
    }
    fields.current_owner_id = patch.currentOwnerId ?? null;
  }
  if ("notes" in patch) fields.notes = patch.notes?.trim() ? patch.notes.trim() : null;
  if (!Object.keys(fields).length) throw new DomainError("VALIDATION", "Nothing to change");
  fields.updated_at = ctx.now;
  fields.updated_by = ctx.actor.id;
  const updated = updateVersioned(ctx.db, "intake_item", intakeItemId, expectedVersion, fields) as unknown as IntakeItemRow;
  const changes: string[] = [];
  if ("current_owner_id" in fields && fields.current_owner_id !== it.current_owner_id) changes.push(`owner → ${staffName(ctx.db, fields.current_owner_id as string | null)}`);
  if ("notes" in fields && fields.notes !== it.notes) changes.push("note updated");
  audit(ctx, {
    action: "intake.updated",
    entityType: "intake_item",
    entityId: intakeItemId,
    intakeItemId,
    summary: `${it.display_id} edited by ${ctx.actor.name}${ctx.origin === "demo" ? " (demo: simulated colleague edit)" : ""}: ${changes.join(", ") || "no visible change"}`,
    before: { current_owner_id: it.current_owner_id, notes: it.notes, version: it.version },
    after: { current_owner_id: updated.current_owner_id, notes: updated.notes, version: updated.version },
  });
  return updated;
}

/** Containers of an intake item. */
export function containersFor(db: DB, intakeItemId: string): ContainerRow[] {
  return db.prepare("SELECT * FROM container WHERE intake_item_id = ? ORDER BY seq").all(intakeItemId) as ContainerRow[];
}

export function openDiscrepanciesFor(db: DB, intakeItemId: string): DiscrepancyRow[] {
  return db.prepare("SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND status = 'open' ORDER BY detected_at").all(intakeItemId) as DiscrepancyRow[];
}

export { staffName as intakeStaffName };
