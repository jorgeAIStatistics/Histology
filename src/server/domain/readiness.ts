import type { DB } from "../db/db";
import type { HoldRow, HoldTransition } from "./holds";
import { blockedTransitions } from "./holds";
import type { BlockState, GrossState, SlideState, SourceUpdateState, Stage } from "@/lib/domain";
import { BLOCK_STATE_ORDER, SLIDE_STATE_ORDER } from "@/lib/domain";
import { getSetting } from "../core/settings";

/**
 * Readiness is DERIVED, never stored: from child items (blocks, slides, work
 * orders), documentation state (gross record versions) and unresolved holds.
 * Physical progress and documentation progress are kept separate, and one
 * finished part never makes a case "complete".
 */

export interface BlockView {
  id: string;
  label: string;
  identifier: string;
  state: BlockState;
  piecesSubmitted: number | null;
  custody: string;
  locationCode: string | null;
}

export interface SlideView {
  id: string;
  blockLabel: string;
  seq: number;
  stain: string;
  level: string | null;
  state: SlideState;
  labelState: string;
  status: string;
  workOrderId: string | null;
  identifier: string;
}

export interface WorkOrderView {
  id: string;
  displayId: string;
  kind: string;
  stain: string | null;
  authorizationSource: string;
  sourceReference: string;
  requestedBy: string;
  status: string;
  statusReason: string | null;
  targetPartId: string | null;
  targetBlockLabel: string | null;
  slideLabels: string[];
}

export interface HoldView {
  id: string;
  displayId: string;
  scopeLabel: string;
  reasonText: string;
  blocks: HoldTransition[];
  clarificationId: string | null;
  placedAt: string;
}

export interface PartReadiness {
  partId: string;
  designation: string;
  site: string;
  laterality: string | null;
  procedure: string | null;
  sourceOrderId: string;
  sourceOrderRef: string;
  status: string;
  physicalState: string;
  grossState: GrossState | "not_started";
  grossRecordId: string | null;
  grossRecordVersion: number | null;
  sourceUpdateState: SourceUpdateState | "not_started";
  blocks: BlockView[];
  /** Cassettes allocated in the approved/latest gross record; null = unknown (no record yet). */
  blocksExpected: number | null;
  slides: SlideView[];
  slideCounts: Record<SlideState, number> & { total: number; active: number };
  workOrders: WorkOrderView[];
  holds: HoldView[];
  stage: Stage;
  eligible: string[];
  blockedBy: string[];
  pas: { workOrder: string; source: string; target: string; status: string; slides: string[] }[];
}

export interface CaseReadiness {
  accessionId: string;
  accessionNumber: string;
  namespace: string;
  caseStatus: string;
  priority: string;
  pathologistId: string | null;
  officeId: string;
  parts: PartReadiness[];
  stage: Stage;
  stageLabel: string;
  partsSummary: string;
  holdCount: number;
  pasCount: number;
  openWorkOrders: number;
  isComplete: boolean;
  readinessText: string;
  eligible: string[];
  blockedBy: string[];
  lastUpdateAt: string | null;
}

const STAGE_ORDER: Stage[] = [
  "intake", "awaiting_gross", "gross_in_progress", "processing", "embedding", "sectioning", "staining", "qc", "ready_for_tray", "delivered",
];

function minByOrder<T extends string>(values: T[], order: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of values) if (best === null || order.indexOf(v) < order.indexOf(best)) best = v;
  return best;
}

function toHoldView(h: HoldRow): HoldView {
  return { id: h.id, displayId: h.display_id, scopeLabel: h.scope_label, reasonText: h.reason_text, blocks: blockedTransitions(h), clarificationId: h.clarification_id, placedAt: h.placed_at };
}

function holdBlocks(holds: HoldView[], t: HoldTransition): HoldView[] {
  return holds.filter((h) => h.blocks.includes("all") || h.blocks.includes(t));
}

/** Batch-compute readiness for many cases with a fixed number of queries. */
export function computeReadiness(db: DB, accessionIds: string[]): Map<string, CaseReadiness> {
  const out = new Map<string, CaseReadiness>();
  if (!accessionIds.length) return out;
  const ph = accessionIds.map(() => "?").join(",");
  const requireApproved = getSetting(db, "processing_requires_approved_gross") !== "0";

  const accessions = db.prepare(`SELECT * FROM accession WHERE id IN (${ph})`).all(...accessionIds) as {
    id: string; accession_number: string; namespace: string; case_status: string; priority: string; assigned_pathologist_id: string | null; office_id: string; updated_at: string;
  }[];
  const parts = db
    .prepare(
      `SELECT sp.*, so.source_order_id AS src_order FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id
        WHERE sp.accession_id IN (${ph}) ORDER BY sp.designation`,
    )
    .all(...accessionIds) as {
    id: string; accession_id: string; designation: string; site_text: string; laterality: string | null; procedure: string | null; source_order_id: string;
    source_order_part_id: string; container_id: string | null; src_order: string; status: string; physical_state: string;
  }[];
  const blocks = db
    .prepare(
      `SELECT b.*, l.code AS loc_code FROM block b LEFT JOIN storage_location l ON l.id = b.current_location_id WHERE b.accession_id IN (${ph}) AND b.status = 'active' ORDER BY b.block_seq`,
    )
    .all(...accessionIds) as {
    id: string; part_id: string; label_text: string; identifier: string; physical_state: BlockState; pieces_submitted: number | null; custody_state: string; loc_code: string | null;
  }[];
  const slides = db
    .prepare(
      `SELECT s.*, b.label_text AS block_label, b.part_id FROM slide s JOIN block b ON b.id = s.block_id WHERE s.accession_id IN (${ph}) ORDER BY b.label_text, s.slide_seq`,
    )
    .all(...accessionIds) as {
    id: string; part_id: string; block_label: string; slide_seq: number; stain: string; level_label: string | null; physical_state: SlideState; label_state: string;
    status: string; work_order_id: string | null; identifier: string;
  }[];
  const wos = db
    .prepare(
      `SELECT wo.*, b.label_text AS block_label FROM work_order wo LEFT JOIN block b ON b.id = wo.target_block_id WHERE wo.accession_id IN (${ph}) ORDER BY wo.display_id`,
    )
    .all(...accessionIds) as {
    id: string; accession_id: string; display_id: string; kind: string; stain: string | null; authorization_source: string; source_reference: string;
    requested_by_label: string; status: string; status_reason: string | null; target_part_id: string | null; block_label: string | null;
  }[];
  const gross = db
    .prepare(
      `SELECT gr.* FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id
        WHERE sp.accession_id IN (${ph}) AND gr.state <> 'superseded' ORDER BY gr.record_version DESC`,
    )
    .all(...accessionIds) as {
    id: string; specimen_part_id: string; record_version: number; state: GrossState; source_update_state: SourceUpdateState; fields: string; updated_at: string;
  }[];

  // Holds: on parts, their accession, order parts, containers, blocks, slides, work orders.
  const holdRows = db.prepare("SELECT * FROM hold WHERE status = 'active'").all() as HoldRow[];
  const holdsByScope = new Map<string, HoldRow[]>();
  for (const h of holdRows) {
    const key = `${h.scope_type}:${h.scope_id}`;
    const list = holdsByScope.get(key) ?? [];
    list.push(h);
    holdsByScope.set(key, list);
  }
  const holdsFor = (type: string, id: string | null | undefined) => (id ? holdsByScope.get(`${type}:${id}`) ?? [] : []);

  const lastAudit = db
    .prepare(`SELECT accession_id, MAX(at) AS at FROM audit_event WHERE accession_id IN (${ph}) GROUP BY accession_id`)
    .all(...accessionIds) as { accession_id: string; at: string }[];
  const lastAuditMap = new Map(lastAudit.map((r) => [r.accession_id, r.at]));

  for (const a of accessions) {
    const caseParts = parts.filter((p) => p.accession_id === a.id);
    const caseHolds = holdsFor("accession", a.id);
    const partViews: PartReadiness[] = caseParts.map((p) => {
      const pBlocks = blocks.filter((b) => b.part_id === p.id);
      const pSlides = slides.filter((s) => s.part_id === p.id);
      const pWos = wos.filter((w) => w.accession_id === a.id && (w.target_part_id === p.id || (!w.target_part_id && !!w.block_label && pBlocks.some((b) => b.label_text === w.block_label))));
      const g = gross.find((x) => x.specimen_part_id === p.id) ?? null;
      const blockIds = new Set(pBlocks.map((b) => b.id));
      const slideIds = new Set(pSlides.map((s) => s.id));
      const holdList: HoldRow[] = [
        ...holdsFor("specimen_part", p.id),
        ...holdsFor("order_part", p.source_order_part_id),
        ...holdsFor("container", p.container_id),
        ...caseHolds,
        ...[...blockIds].flatMap((id) => holdsFor("block", id)),
        ...[...slideIds].flatMap((id) => holdsFor("slide", id)),
        ...pWos.flatMap((w) => holdsFor("work_order", w.id)),
      ];
      const holds = [...new Map(holdList.map((h) => [h.id, toHoldView(h)])).values()];

      const counts = Object.fromEntries(SLIDE_STATE_ORDER.map((s) => [s, 0])) as Record<SlideState, number>;
      const activeSlides = pSlides.filter((s) => s.status === "active");
      for (const s of activeSlides) counts[s.physical_state] += 1;
      let blocksExpected: number | null = null;
      if (g) {
        try {
          const f = JSON.parse(g.fields) as { cassettes?: { value: unknown[] | null } };
          blocksExpected = Array.isArray(f.cassettes?.value) ? f.cassettes!.value!.length : null;
        } catch {
          blocksExpected = null;
        }
      }
      const grossState: GrossState | "not_started" = g ? g.state : "not_started";
      const approved = grossState === "approved_for_downstream";

      // ---- stage
      let stage: Stage;
      if (p.status === "canceled") stage = "canceled";
      else if (!pBlocks.length) stage = g ? "gross_in_progress" : "awaiting_gross";
      else {
        const minBlock = minByOrder(pBlocks.map((b) => b.physical_state), BLOCK_STATE_ORDER)!;
        if (minBlock === "cassette_loaded") stage = approved ? "processing" : "gross_in_progress";
        else if (minBlock === "processing" || minBlock === "processed") stage = "processing";
        else if (minBlock === "embedded") stage = "sectioning";
        else {
          const minSlide = minByOrder(activeSlides.map((s) => s.physical_state), SLIDE_STATE_ORDER);
          stage =
            minSlide === null ? "sectioning"
            : minSlide === "planned" ? "sectioning"
            : minSlide === "sectioned" || minSlide === "stained" ? "staining"
            : minSlide === "coverslipped" ? "qc"
            : minSlide === "qc_reviewed" ? "ready_for_tray"
            : "delivered";
        }
      }

      // ---- eligible / blocked
      const eligible: string[] = [];
      const blockedBy: string[] = [];
      for (const h of holds) blockedBy.push(`${h.displayId} on ${h.scopeLabel}: ${h.reasonText} (blocks ${h.blocks.join(", ")})`);
      if (!g && !pBlocks.length && p.status !== "canceled") {
        const hb = holdBlocks(holds, "gross_approval");
        if (hb.length) blockedBy.push(`Grossing documentation for part ${p.designation} cannot be approved until ${hb.map((h) => h.displayId).join(", ")} is released`);
        else eligible.push(`Part ${p.designation}: ready for grossing`);
      }
      if (g && g.state !== "approved_for_downstream") {
        const hb = holdBlocks(holds, "gross_approval");
        if (hb.length) blockedBy.push(`Gross record for part ${p.designation} cannot be approved: ${hb.map((h) => h.displayId).join(", ")}`);
      }
      if (approved && (g!.source_update_state === "not_started" || g!.source_update_state === "pending_entry")) {
        eligible.push(`Part ${p.designation}: enter approved gross description in source system (pending)`);
      }
      const loaded = pBlocks.filter((b) => b.physical_state === "cassette_loaded");
      if (loaded.length) {
        const hb = holdBlocks(holds, "processing");
        if (hb.length) blockedBy.push(`${loaded.map((b) => b.label_text).join(", ")} held from processing: ${hb.map((h) => h.displayId).join(", ")}`);
        else if (!approved && requireApproved) blockedBy.push(`${loaded.map((b) => b.label_text).join(", ")} loaded but not eligible for processing: gross record not approved (local policy setting)`);
        else eligible.push(`${loaded.map((b) => b.label_text).join(", ")} eligible for the next processing run`);
      }
      const toSection = pBlocks.filter((b) => b.physical_state === "embedded" || (b.physical_state === "sectioned" && activeSlides.some((s) => s.block_label === b.label_text && s.physical_state === "planned")));
      if (toSection.length) {
        const hb = holdBlocks(holds, "sectioning");
        if (hb.length) blockedBy.push(`Sectioning held: ${hb.map((h) => h.displayId).join(", ")}`);
        else eligible.push(`Sectioning: ${toSection.map((b) => `${b.label_text} (${activeSlides.filter((s) => s.block_label === b.label_text && s.physical_state === "planned").length} planned)`).join(", ")}`);
      }
      if (counts.qc_reviewed > 0 && !holdBlocks(holds, "tray_delivery").length) eligible.push(`${counts.qc_reviewed} slide(s) ready for tray`);
      const canceledReview = pSlides.filter((s) => s.status === "canceled_needs_review");
      if (canceledReview.length) blockedBy.push(`Review needed: ${canceledReview.map((s) => `${s.block_label}-${s.slide_seq} ${s.stain}`).join(", ")} prepared/printed for work that was canceled or amended at the source`);

      const woViews: WorkOrderView[] = pWos.map((w) => ({
        id: w.id, displayId: w.display_id, kind: w.kind, stain: w.stain, authorizationSource: w.authorization_source, sourceReference: w.source_reference,
        requestedBy: w.requested_by_label, status: w.status, statusReason: w.status_reason, targetPartId: w.target_part_id, targetBlockLabel: w.block_label,
        slideLabels: pSlides.filter((s) => s.work_order_id === w.id).map((s) => `${s.block_label}-${s.slide_seq}`),
      }));
      const pas = woViews
        .filter((w) => (w.stain ?? "").toUpperCase() === "PAS")
        .map((w) => ({
          workOrder: w.displayId,
          source: w.sourceReference,
          target: w.slideLabels.length ? w.slideLabels.join(", ") : w.targetBlockLabel ?? `Part ${p.designation} (block not yet assigned)`,
          status: w.status,
          slides: w.slideLabels,
        }));

      return {
        partId: p.id, designation: p.designation, site: p.site_text, laterality: p.laterality, procedure: p.procedure, sourceOrderId: p.source_order_id,
        sourceOrderRef: p.src_order, status: p.status, physicalState: p.physical_state, grossState, grossRecordId: g?.id ?? null,
        grossRecordVersion: g?.record_version ?? null, sourceUpdateState: g ? g.source_update_state : "not_started",
        blocks: pBlocks.map((b) => ({ id: b.id, label: b.label_text, identifier: b.identifier, state: b.physical_state, piecesSubmitted: b.pieces_submitted, custody: b.custody_state, locationCode: b.loc_code })),
        blocksExpected,
        slides: pSlides.map((s) => ({ id: s.id, blockLabel: s.block_label, seq: s.slide_seq, stain: s.stain, level: s.level_label, state: s.physical_state, labelState: s.label_state, status: s.status, workOrderId: s.work_order_id, identifier: s.identifier })),
        slideCounts: { ...counts, total: pSlides.length, active: activeSlides.length },
        workOrders: woViews, holds, stage, eligible, blockedBy, pas,
      };
    });

    const activeParts = partViews.filter((p) => p.status !== "canceled");
    const stage: Stage = activeParts.length ? minByOrder(activeParts.map((p) => p.stage), STAGE_ORDER) ?? "intake" : "canceled";
    const isComplete = activeParts.length > 0 && activeParts.every((p) => p.stage === "delivered");
    const holdCount = new Set(partViews.flatMap((p) => p.holds.map((h) => h.id)).concat(caseHolds.map((h) => h.id))).size;
    const pasCount = partViews.reduce((n, p) => n + p.pas.filter((x) => x.status !== "canceled").length, 0);
    const openWorkOrders = partViews.reduce((n, p) => n + p.workOrders.filter((w) => !["completed", "canceled"].includes(w.status)).length, 0);
    const partsSummary = partViews
      .map((p) => `${p.designation}: ${p.holds.length ? "hold" : STAGE_SHORT[p.stage]}`)
      .join(" · ");
    const distinctStages = new Set(activeParts.map((p) => p.stage));
    const stageLabel = distinctStages.size > 1 ? `${STAGE_SHORT[stage]} (parts differ)` : STAGE_SHORT[stage];
    const eligible = partViews.flatMap((p) => p.eligible);
    const blockedBy = partViews.flatMap((p) => p.blockedBy);
    const readinessText = isComplete
      ? "All parts delivered"
      : blockedBy.length && !eligible.length
        ? `Not ready: ${blockedBy[0]}`
        : eligible.length
          ? `Eligible: ${eligible[0]}${eligible.length > 1 ? ` (+${eligible.length - 1} more)` : ""}`
          : "No eligible work right now";

    out.set(a.id, {
      accessionId: a.id, accessionNumber: a.accession_number, namespace: a.namespace, caseStatus: a.case_status, priority: a.priority,
      pathologistId: a.assigned_pathologist_id, officeId: a.office_id, parts: partViews, stage, stageLabel, partsSummary, holdCount, pasCount,
      openWorkOrders, isComplete, readinessText, eligible, blockedBy, lastUpdateAt: lastAuditMap.get(a.id) ?? a.updated_at,
    });
  }
  return out;
}

export const STAGE_SHORT: Record<Stage, string> = {
  intake: "Intake",
  awaiting_gross: "Awaiting grossing",
  gross_in_progress: "Gross documentation",
  processing: "Processing",
  embedding: "Embedding",
  sectioning: "Sectioning",
  staining: "Staining",
  qc: "QC",
  ready_for_tray: "Ready for tray",
  delivered: "Delivered",
  canceled: "Canceled",
};

export function caseReadiness(db: DB, accessionId: string): CaseReadiness | null {
  return computeReadiness(db, [accessionId]).get(accessionId) ?? null;
}
