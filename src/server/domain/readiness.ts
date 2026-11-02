import type { DB } from "../db/db";
import type { HoldRow, HoldTransition, ScopeType } from "./holds";
import { blockedTransitions, HOLD_TRANSITION_LABEL } from "./holds";
import { trayReadinessProblem } from "./tray";
import type { BlockState, GrossState, SlideState, SourceUpdateState, Stage } from "@/lib/domain";
import { awaitsSourceEntry, BLOCK_STATE_ORDER, SLIDE_STATE_ORDER, STAGE } from "@/lib/domain";
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
  /** What the hold is on (intake_item, container, order_part, specimen_part, block, slide, work_order, accession). Kept so scope never collapses. */
  scopeType: ScopeType;
  scopeLabel: string;
  /**
   * Derived, short: the exact material held, as this part sees it ("Part B", "A1", "A1-2", "WO-2213", "Whole case").
   * A block or slide hold names that block or slide, never the whole part.
   */
  target: string;
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

/** Bench-path order (lib/domain STAGE order, without canceled). */
const STAGE_ORDER: Stage[] = (Object.keys(STAGE) as Stage[]).filter((s) => s !== "canceled");

function minByOrder<T extends string>(values: T[], order: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of values) if (best === null || order.indexOf(v) < order.indexOf(best)) best = v;
  return best;
}

function toHoldView(h: HoldRow, target: string): HoldView {
  return {
    id: h.id, displayId: h.display_id, scopeType: h.scope_type, scopeLabel: h.scope_label, target, reasonText: h.reason_text, blocks: blockedTransitions(h),
    clarificationId: h.clarification_id, placedAt: h.placed_at,
  };
}

function holdBlocks<T extends { blocks: HoldTransition[] }>(holds: T[], t: HoldTransition): T[] {
  return holds.filter((h) => h.blocks.includes("all") || h.blocks.includes(t));
}

/** Short reason a QC-reviewed slide is not accepted on a tray (from trayReadinessProblem, the tray rules). */
function trayReasonShort(problem: string): { reason: string; kind: "hold" | "on_tray" | "other" } {
  let m: RegExpExecArray | null;
  if ((m = /active hold blocking tray delivery \((.+)\)$/.exec(problem))) return { reason: m[1], kind: "hold" };
  if ((m = /is already listed on (\S+)$/.exec(problem))) return { reason: m[1], kind: "on_tray" };
  if (/label has not been scanned/.test(problem)) return { reason: "label not scanned after it was applied", kind: "other" };
  if ((m = /belongs to (\S+), which is (.+)$/.exec(problem))) return { reason: `${m[1]} is ${m[2]}`, kind: "other" };
  if (/is void/.test(problem)) return { reason: "void", kind: "other" };
  if (/awaiting review of a source change/.test(problem)) return { reason: "awaiting review of a source change", kind: "other" };
  return { reason: problem, kind: "other" };
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

  // The intake item(s) each part came from: its container's intake item; with no container, the intake items on
  // the same accession that carried its order (holds.ts intakeItemsForPart, batched).
  const fromContainer = new Map<string, string[]>();
  for (const r of db
    .prepare(`SELECT sp.id AS part_id, c.intake_item_id FROM specimen_part sp JOIN container c ON c.id = sp.container_id WHERE sp.accession_id IN (${ph})`)
    .all(...accessionIds) as { part_id: string; intake_item_id: string }[]) fromContainer.set(r.part_id, [r.intake_item_id]);
  const fromLink = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `SELECT sp.id AS part_id, ii.id AS intake_item_id FROM specimen_part sp
         JOIN intake_item ii ON ii.accession_id = sp.accession_id
         JOIN intake_order_link l ON l.intake_item_id = ii.id AND l.source_order_id = sp.source_order_id
        WHERE sp.accession_id IN (${ph}) ORDER BY ii.id`,
    )
    .all(...accessionIds) as { part_id: string; intake_item_id: string }[]) fromLink.set(r.part_id, [...(fromLink.get(r.part_id) ?? []), r.intake_item_id]);
  const intakeItemsOf = (partId: string) => fromContainer.get(partId) ?? fromLink.get(partId) ?? [];

  // Holds: on parts, their accession, order parts, containers, intake items, blocks, slides, work orders.
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
      // Part-level holds stop everything made from the part; a block, slide or work-order hold stops only that
      // material (the same scope chains holds.ts enforces: scopesForPart / scopesForBlock / scopesForSlide).
      const partLevelRows: HoldRow[] = [
        ...holdsFor("specimen_part", p.id),
        ...holdsFor("order_part", p.source_order_part_id),
        ...holdsFor("container", p.container_id),
        ...intakeItemsOf(p.id).flatMap((ii) => holdsFor("intake_item", ii)),
        ...caseHolds,
      ];
      const partTarget = (h: HoldRow) => (h.scope_type === "accession" ? "Whole case" : `Part ${p.designation}`);
      const partLevel = [...new Map(partLevelRows.map((h) => [h.id, toHoldView(h, partTarget(h))])).values()];
      const blockHolds = new Map(pBlocks.map((b) => [b.id, holdsFor("block", b.id).map((h) => toHoldView(h, b.label_text))]));
      const slideHolds = new Map(pSlides.map((s) => [s.id, holdsFor("slide", s.id).map((h) => toHoldView(h, `${s.block_label}-${s.slide_seq}`))]));
      const woHolds = new Map(pWos.map((w) => [w.id, holdsFor("work_order", w.id).map((h) => toHoldView(h, w.display_id))]));
      const holdList: HoldView[] = [
        ...partLevel,
        ...[...blockHolds.values()].flat(),
        ...[...slideHolds.values()].flat(),
        ...[...woHolds.values()].flat(),
      ];
      const holds = [...new Map(holdList.map((h) => [h.id, h])).values()];
      /** Holds that apply to one block (part-level + that block). */
      const holdsOnBlock = (blockId: string) => [...partLevel, ...(blockHolds.get(blockId) ?? [])];

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
        // A loaded cassette is not "processing": with an approved record it is ready for (waiting on) the next run.
        if (minBlock === "cassette_loaded") stage = approved ? "awaiting_processing" : "gross_in_progress";
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
      for (const h of holds) blockedBy.push(`${h.displayId} on ${h.scopeLabel}: ${h.reasonText} (holds ${h.blocks.map((b) => HOLD_TRANSITION_LABEL[b] ?? b).join(", ")})`);
      if (p.status !== "canceled") {
        // Gross approval is a part-level step: only part-level holds stop it (holds.ts scopesForPart).
        const approvalHolds = holdBlocks(partLevel, "gross_approval");
        if (!g && !pBlocks.length) {
          if (approvalHolds.length) blockedBy.push(`Grossing documentation for part ${p.designation} cannot be approved until ${approvalHolds.map((h) => h.displayId).join(", ")} is released`);
          else eligible.push(`Part ${p.designation}: ready for grossing`);
        }
        if (g && g.state !== "approved_for_downstream" && approvalHolds.length) {
          blockedBy.push(`Gross record for part ${p.designation} cannot be approved: ${approvalHolds.map((h) => h.displayId).join(", ")}`);
        }
      }
      if (g && awaitsSourceEntry({ grossState: g.state, sourceUpdateState: g.source_update_state, partStatus: p.status })) {
        eligible.push(`Part ${p.designation}: enter approved gross description in source system (pending)`);
      }
      /** Blocks grouped by the holds that stop `t` on each one: free blocks, and held blocks per hold set. */
      const splitByHold = (list: typeof pBlocks, t: HoldTransition) => {
        const free: typeof pBlocks = [];
        const held = new Map<string, typeof pBlocks>();
        for (const b of list) {
          const hb = holdBlocks(holdsOnBlock(b.id), t);
          if (!hb.length) free.push(b);
          else {
            const key = [...new Set(hb.map((h) => h.displayId))].join(", ");
            held.set(key, [...(held.get(key) ?? []), b]);
          }
        }
        return { free, held };
      };
      const loaded = pBlocks.filter((b) => b.physical_state === "cassette_loaded");
      if (loaded.length) {
        const { free, held } = splitByHold(loaded, "processing");
        for (const [ids, bs] of held) blockedBy.push(`${bs.map((b) => b.label_text).join(", ")} held from processing: ${ids}`);
        if (free.length) {
          if (!approved && requireApproved) blockedBy.push(`${free.map((b) => b.label_text).join(", ")} loaded but not eligible for processing: gross record not approved (local policy setting)`);
          else eligible.push(`${free.map((b) => b.label_text).join(", ")} eligible for the next processing run`);
        }
      }
      const toSection = pBlocks.filter((b) => b.physical_state === "embedded" || (b.physical_state === "sectioned" && activeSlides.some((s) => s.block_label === b.label_text && s.physical_state === "planned")));
      if (toSection.length) {
        const { free, held } = splitByHold(toSection, "sectioning");
        for (const [ids, bs] of held) blockedBy.push(`Sectioning held: ${bs.map((b) => b.label_text).join(", ")} (${ids})`);
        if (free.length) eligible.push(`Sectioning: ${free.map((b) => `${b.label_text} (${activeSlides.filter((s) => s.block_label === b.label_text && s.physical_state === "planned").length} planned)`).join(", ")}`);
      }
      // Ready for a tray: only slides a tray would accept (the tray rules, domain/tray.ts trayReadinessProblem).
      const qcSlides = activeSlides.filter((s) => s.physical_state === "qc_reviewed");
      if (qcSlides.length) {
        let ready = 0;
        const byKind = { hold: new Map<string, string[]>(), on_tray: new Map<string, string[]>(), other: new Map<string, string[]>() };
        for (const s of qcSlides) {
          const problem = trayReadinessProblem(db, s.id);
          if (!problem) {
            ready += 1;
            continue;
          }
          const { reason, kind } = trayReasonShort(problem);
          byKind[kind].set(reason, [...(byKind[kind].get(reason) ?? []), `${s.block_label}-${s.slide_seq}`]);
        }
        for (const [ids, labels] of byKind.hold) blockedBy.push(`${labels.join(", ")} held from tray delivery: ${ids}`);
        for (const [tray, labels] of byKind.on_tray) blockedBy.push(`${labels.join(", ")} already listed on ${tray} (tray not delivered yet)`);
        if (byKind.other.size) blockedBy.push(`Not ready for a tray: ${[...byKind.other].map(([reason, labels]) => `${labels.join(", ")} (${reason})`).join("; ")}`);
        if (ready > 0) eligible.push(`${ready} slide(s) ready for tray`);
      }
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
      ? ALL_SENT_ON_TRAYS
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

/** Case-complete sentence: tray delivery is recorded digitally; no receipt by the pathologist is recorded. */
export const ALL_SENT_ON_TRAYS = "All parts sent on trays; receipt not recorded";

export const STAGE_SHORT: Record<Stage, string> = {
  intake: "Intake",
  awaiting_gross: "Awaiting grossing",
  gross_in_progress: "Gross documentation",
  awaiting_processing: STAGE.awaiting_processing,
  processing: "Processing",
  embedding: "Embedding",
  sectioning: "Sectioning",
  staining: "Staining",
  qc: "QC",
  ready_for_tray: "Ready for tray",
  delivered: STAGE.delivered,
  canceled: "Canceled",
};

export function caseReadiness(db: DB, accessionId: string): CaseReadiness | null {
  return computeReadiness(db, [accessionId]).get(accessionId) ?? null;
}
