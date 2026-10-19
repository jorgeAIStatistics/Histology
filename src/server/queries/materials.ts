import type { DB } from "@/server/db/db";
import { getSetting } from "@/server/core/settings";
import { PRINT_STATE, RETRIEVAL_STATUS, TRAY_STATUS, WORK_ORDER_STATUS, type PrintState } from "@/lib/domain";
import { decodeLabel, humanLabel } from "@/lib/identifiers";
import { labDay } from "@/lib/time";
import { ensureMaterialsSchema, getBlock, getSlide, slideText, blockText } from "@/server/domain/material";
import { listPrinters, PRINTER_STATUS_LABEL } from "@/server/sim/printer";
import { checkPayloadAgainstRecord, roundTrip, type RecordCheck } from "@/server/domain/labels";
import { computeTrayView, eligibleSlidesFor, type TrayView } from "@/server/domain/tray";
import {
  custodyFacts, custodyHistory, ITEM_STATUS_LABEL, LOCATION_CAPTION, locationCard, splitLocation, type CustodyEventView, type CustodyFacts, type LocationCard,
} from "@/server/domain/retrieval";
import { SLIDE_DISPOSITION_LABEL } from "@/server/domain/workorder";
import { holdsBlocking, scopesForSlide } from "@/server/domain/holds";

/**
 * Read models for /materials (print jobs, trays, retrieval). Server components
 * call these directly. Everything shown is synthetic; printers and scanners
 * are simulated.
 */

// ---------------------------------------------------------------- print jobs

export const PURPOSE_LABEL: Record<string, string> = {
  initial: "New label",
  additional_work: "Additional slide (work order)",
  reprint_damaged: "Reprint: damaged or replaced label",
  reprint_after_failure: "Reprint after failed print",
  reprint_after_unknown: "Reprint after unknown outcome (not printed)",
};

export const RECONCILIATION_LABEL: Record<string, string> = {
  printed_ok: "Checked: label printed",
  not_printed: "Checked: not printed",
  printed_damaged: "Checked: printed but damaged",
  cant_tell: "Can't tell — escalated to supervisor",
};

export interface PrinterView {
  id: string;
  name: string;
  kind: string;
  location: string;
  status: string;
  statusLabel: string;
  reportsCompletion: boolean;
  queued: number;
  unknown: number;
}

export function printerViews(db: DB): PrinterView[] {
  const counts = db
    .prepare("SELECT printer_id, state, COUNT(*) n FROM print_job WHERE state IN ('planned','queued','unknown_outcome') GROUP BY printer_id, state")
    .all() as { printer_id: string; state: string; n: number }[];
  return listPrinters(db).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    location: p.location,
    status: p.status,
    statusLabel: PRINTER_STATUS_LABEL[p.status] ?? `${p.status} (simulated)`,
    reportsCompletion: !!p.reports_completion,
    queued: counts.filter((c) => c.printer_id === p.id && c.state !== "unknown_outcome").reduce((n, c) => n + c.n, 0),
    unknown: counts.filter((c) => c.printer_id === p.id && c.state === "unknown_outcome").reduce((n, c) => n + c.n, 0),
  }));
}

export type PrintFilter = "attention" | "today" | "all";

export interface PrintJobRowView {
  id: string;
  displayId: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  accessionId: string | null;
  kind: string;
  purpose: string;
  purposeLabel: string;
  state: PrintState;
  stateLabel: string;
  printerId: string;
  printerName: string;
  createdAt: string;
  submittedAt: string | null;
  requestedBy: string;
  reprintOfDisplayId: string | null;
  reprintReason: string | null;
  reconciliation: string | null;
  /** Acknowledged by a printer that does not report completion, and nobody has recorded what came out yet. */
  needsOutputCheck: boolean;
  /** A newer job for the same label exists (this one was reprinted). */
  supersededBy: string | null;
  needsAttention: boolean;
  version: number;
}

const STATE_RANK: Record<string, number> = { unknown_outcome: 0, acknowledged: 1, failed: 2, queued: 3, planned: 4, submitted: 5 };

/**
 * SQL for "this print job needs a person": in flight or unknown, acknowledged with no output
 * recorded yet, or failed and not yet replaced by a newer job for the same label.
 */
const NEEDS_ATTENTION_SQL = `(pj.state IN ('unknown_outcome','queued','planned','submitted')
  OR (pj.state = 'acknowledged' AND NOT EXISTS (SELECT 1 FROM label l WHERE l.print_job_id = pj.id))
  OR (pj.state = 'failed' AND NOT EXISTS (
        SELECT 1 FROM print_job n WHERE n.target_type = pj.target_type AND n.target_id = pj.target_id AND n.kind = pj.kind
           AND n.state <> 'canceled' AND n.id <> pj.id AND (n.created_at > pj.created_at OR (n.created_at = pj.created_at AND n.rowid > pj.rowid)))))`;

function targetLabelFor(payload: string): string {
  const d = decodeLabel(payload);
  return d.ok ? humanLabel(d.identity) : payload;
}

export function listPrintJobs(
  db: DB,
  opts: { filter: PrintFilter; now: string; limit?: number },
): { rows: PrintJobRowView[]; total: number; counts: Record<PrintFilter, number> & { unknown: number; queued: number; failed: number } } {
  ensureMaterialsSchema(db);
  const all = db
    .prepare(
      `SELECT pj.*, p.name AS printer_name, s.display_name AS requested_by_name, o.display_id AS reprint_of_display,
              ${NEEDS_ATTENTION_SQL} AS attention,
              (SELECT COUNT(*) FROM label l WHERE l.print_job_id = pj.id) AS label_count,
              (SELECT n.display_id FROM print_job n WHERE n.reprint_of_job_id = pj.id AND n.state <> 'canceled' ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1) AS replaced_by
         FROM print_job pj JOIN printer p ON p.id = pj.printer_id LEFT JOIN staff s ON s.id = pj.requested_by
         LEFT JOIN print_job o ON o.id = pj.reprint_of_job_id`,
    )
    .all() as (Record<string, unknown> & {
    attention: number; label_count: number; replaced_by: string | null;
    id: string; display_id: string; target_type: string; target_id: string; accession_id: string | null; kind: string; purpose: string; state: PrintState;
    printer_id: string; printer_name: string; created_at: string; submitted_at: string | null; requested_by: string; requested_by_name: string | null;
    reprint_of_display: string | null; reprint_reason: string | null; reconciliation: string | null; payload: string; version: number;
  })[];
  const today = labDay(opts.now);
  const view = (r: (typeof all)[number]): PrintJobRowView => ({
    id: r.id,
    displayId: r.display_id,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: targetLabelFor(r.payload),
    accessionId: r.accession_id,
    kind: r.kind,
    purpose: r.purpose,
    purposeLabel: PURPOSE_LABEL[r.purpose] ?? r.purpose,
    state: r.state,
    stateLabel: PRINT_STATE[r.state] ?? r.state,
    printerId: r.printer_id,
    printerName: r.printer_name,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    requestedBy: r.requested_by_name ?? r.requested_by,
    reprintOfDisplayId: r.reprint_of_display,
    reprintReason: r.reprint_reason,
    reconciliation: r.reconciliation,
    needsOutputCheck: r.state === "acknowledged" && r.label_count === 0,
    supersededBy: r.replaced_by,
    needsAttention: r.attention === 1,
    version: r.version,
  });
  const views = all.map(view);
  const isToday = (v: PrintJobRowView) => labDay(v.createdAt) === today;
  const inAttention = (v: PrintJobRowView) => v.needsAttention || (isToday(v) && Date.parse(opts.now) - Date.parse(v.createdAt) < 3 * 3600_000);
  const counts = {
    attention: views.filter(inAttention).length,
    today: views.filter(isToday).length,
    all: views.length,
    unknown: views.filter((v) => v.state === "unknown_outcome").length,
    queued: views.filter((v) => v.state === "queued" || v.state === "planned").length,
    failed: views.filter((v) => v.state === "failed" && v.needsAttention).length,
  };
  let rows = opts.filter === "attention" ? views.filter(inAttention)
    : opts.filter === "today" ? views.filter(isToday)
    : views;
  rows = rows.sort((a, b) => {
    const ra = a.needsAttention ? (STATE_RANK[a.state] ?? 8) : 9;
    const rb = b.needsAttention ? (STATE_RANK[b.state] ?? 8) : 9;
    if (ra !== rb) return ra - rb;
    return b.createdAt.localeCompare(a.createdAt) || b.displayId.localeCompare(a.displayId);
  });
  const total = rows.length;
  return { rows: rows.slice(0, opts.limit ?? 150), total, counts };
}

export interface LabelView {
  id: string;
  state: string;
  payload: string;
  text: string;
  printJobDisplayId: string | null;
  createdAt: string;
  appliedBy: string | null;
  appliedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  replacesLabelId: string | null;
}

function labelsFor(db: DB, targetType: string, targetId: string): LabelView[] {
  const rows = db
    .prepare(
      `SELECT l.*, pj.display_id AS pj_display, ab.display_name AS applied_name, vb.display_name AS verified_name, rb.display_name AS retired_name
         FROM label l LEFT JOIN print_job pj ON pj.id = l.print_job_id LEFT JOIN staff ab ON ab.id = l.applied_by
         LEFT JOIN staff vb ON vb.id = l.verified_by LEFT JOIN staff rb ON rb.id = l.retired_by
        WHERE l.target_type = ? AND l.target_id = ? ORDER BY l.created_at DESC, l.id DESC`,
    )
    .all(targetType, targetId) as (Record<string, unknown> & {
    id: string; state: string; payload: string; pj_display: string | null; created_at: string; applied_name: string | null; applied_at: string | null;
    verified_name: string | null; verified_at: string | null; retired_name: string | null; retired_at: string | null; retire_reason: string | null; replaces_label_id: string | null;
  })[];
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    payload: r.payload,
    text: targetLabelFor(r.payload),
    printJobDisplayId: r.pj_display,
    createdAt: r.created_at,
    appliedBy: r.applied_name,
    appliedAt: r.applied_at,
    verifiedBy: r.verified_name,
    verifiedAt: r.verified_at,
    retiredBy: r.retired_name,
    retiredAt: r.retired_at,
    retireReason: r.retire_reason,
    replacesLabelId: r.replaces_label_id,
  }));
}

export interface HistoryEntry {
  at: string;
  actor: string | null;
  role: string | null;
  origin: string;
  action: string;
  summary: string;
  reason: string | null;
}

function auditFor(db: DB, entityType: string, entityIds: string[]): HistoryEntry[] {
  if (!entityIds.length) return [];
  const rows = db
    .prepare(
      `SELECT ae.at, ae.actor_id, s.display_name, ae.actor_role, ae.origin, ae.action, ae.summary, ae.reason
         FROM audit_event ae LEFT JOIN staff s ON s.id = ae.actor_id
        WHERE ae.entity_type = ? AND ae.entity_id IN (${entityIds.map(() => "?").join(",")}) ORDER BY ae.seq DESC LIMIT 60`,
    )
    .all(entityType, ...entityIds) as { at: string; actor_id: string | null; display_name: string | null; actor_role: string | null; origin: string; action: string; summary: string; reason: string | null }[];
  return rows.map((r) => ({ at: r.at, actor: r.display_name ?? r.actor_id, role: r.actor_role, origin: r.origin, action: r.action, summary: r.summary, reason: r.reason }));
}

export interface PrintJobDetail {
  job: PrintJobRowView & {
    payload: string;
    failureDetail: string | null;
    reconciledBy: string | null;
    reconciledAt: string | null;
    reconciliationNote: string | null;
    acknowledgedAt: string | null;
    completedAt: string | null;
  };
  printer: PrinterView | null;
  target: {
    type: string;
    id: string;
    label: string;
    accessionId: string | null;
    accessionNumber: string | null;
    status: string | null;
    physicalState: string | null;
    workOrder: { displayId: string; status: string; statusLabel: string } | null;
    blockId: string | null;
    stain: string | null;
  };
  labels: LabelView[];
  chain: { id: string; displayId: string; state: PrintState; stateLabel: string; purposeLabel: string; createdAt: string; reprintReason: string | null; isThis: boolean }[];
  /** The newest job for this label (reprints are allowed from it only). */
  head: { id: string; displayId: string; state: PrintState } | null;
  preview: ReturnType<typeof roundTrip>;
  /** The payload decoded and compared field by field with the slide/block/case record. */
  recordCheck: RecordCheck;
  history: HistoryEntry[];
  openTasks: { id: string; kind: string; title: string; owner: string | null; ownerRole: string | null }[];
}

export function getPrintJobDetail(db: DB, idOrDisplay: string, now: string): PrintJobDetail | null {
  ensureMaterialsSchema(db);
  const r = db.prepare("SELECT * FROM print_job WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as Record<string, unknown> | undefined;
  if (!r) return null;
  const base = listPrintJobs(db, { filter: "all", now, limit: 100000 }).rows.find((x) => x.id === r.id);
  if (!base) return null;
  const printer = printerViews(db).find((p) => p.id === base.printerId) ?? null;
  let target: PrintJobDetail["target"] = {
    type: base.targetType, id: base.targetId, label: base.targetLabel, accessionId: base.accessionId, accessionNumber: null, status: null, physicalState: null,
    workOrder: null, blockId: null, stain: null,
  };
  if (base.targetType === "slide") {
    const s = getSlide(db, base.targetId);
    if (s) {
      target = {
        ...target, label: slideText(s), accessionNumber: s.accession_number, status: s.status, physicalState: s.physical_state, blockId: s.block_id, stain: s.stain,
        workOrder: s.wo_display ? { displayId: s.wo_display, status: s.wo_status ?? "", statusLabel: WORK_ORDER_STATUS[s.wo_status as keyof typeof WORK_ORDER_STATUS] ?? s.wo_status ?? "" } : null,
      };
    }
  } else if (base.targetType === "block") {
    const b = getBlock(db, base.targetId);
    if (b) target = { ...target, label: blockText(b), accessionNumber: b.accession_number, status: b.status, physicalState: b.physical_state, blockId: b.id };
  } else {
    const a = db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(base.targetId) as { accession_number: string } | undefined;
    target = { ...target, accessionNumber: a?.accession_number ?? null };
  }
  // The reprint chain: walk to the original, then every job that reprints anything in the chain.
  let root = r as { id: string; reprint_of_job_id: string | null };
  for (let i = 0; i < 20 && root.reprint_of_job_id; i++) {
    const up = db.prepare("SELECT id, reprint_of_job_id FROM print_job WHERE id = ?").get(root.reprint_of_job_id) as typeof root | undefined;
    if (!up) break;
    root = up;
  }
  const chainIds = new Set<string>([root.id]);
  for (let i = 0; i < 20; i++) {
    const more = db
      .prepare(`SELECT id FROM print_job WHERE reprint_of_job_id IN (${[...chainIds].map(() => "?").join(",")})`)
      .all(...chainIds) as { id: string }[];
    const before = chainIds.size;
    for (const m of more) chainIds.add(m.id);
    if (chainIds.size === before) break;
  }
  const chainRows = db
    .prepare(`SELECT id, display_id, state, purpose, created_at, reprint_reason FROM print_job WHERE id IN (${[...chainIds].map(() => "?").join(",")}) ORDER BY created_at, display_id`)
    .all(...chainIds) as { id: string; display_id: string; state: PrintState; purpose: string; created_at: string; reprint_reason: string | null }[];
  const tasks = db
    .prepare(
      `SELECT t.id, t.kind, t.title, s.display_name AS owner, t.owner_role FROM task t LEFT JOIN staff s ON s.id = t.owner_id
        WHERE t.status IN ('open','in_progress') AND ((t.entity_type = 'print_job' AND t.entity_id = ?) OR (t.entity_type = 'label' AND t.entity_id IN (SELECT id FROM label WHERE target_type = ? AND target_id = ?)))`,
    )
    .all(base.id, base.targetType, base.targetId) as { id: string; kind: string; title: string; owner: string | null; owner_role: string | null }[];
  return {
    job: {
      ...base,
      payload: String(r.payload),
      failureDetail: (r.failure_detail as string | null) ?? null,
      reconciledBy: r.reconciled_by ? ((db.prepare("SELECT display_name n FROM staff WHERE id = ?").get(r.reconciled_by) as { n: string } | undefined)?.n ?? String(r.reconciled_by)) : null,
      reconciledAt: (r.reconciled_at as string | null) ?? null,
      reconciliationNote: (r.reconciliation_note as string | null) ?? null,
      acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
      completedAt: (r.completed_at as string | null) ?? null,
    },
    printer,
    target,
    labels: labelsFor(db, base.targetType, base.targetId),
    chain: chainRows.map((c) => ({
      id: c.id, displayId: c.display_id, state: c.state, stateLabel: PRINT_STATE[c.state], purposeLabel: PURPOSE_LABEL[c.purpose] ?? c.purpose, createdAt: c.created_at,
      reprintReason: c.reprint_reason, isThis: c.id === base.id,
    })),
    head: (() => {
      const h = db
        .prepare(
          `SELECT id, display_id, state FROM print_job WHERE target_type = ? AND target_id = ? AND kind = ? AND state <> 'canceled'
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(base.targetType, base.targetId, base.kind) as { id: string; display_id: string; state: PrintState } | undefined;
      return h ? { id: h.id, displayId: h.display_id, state: h.state } : null;
    })(),
    preview: roundTrip(String(r.payload)),
    recordCheck: checkPayloadAgainstRecord(db, base.targetType, base.targetId, String(r.payload)),
    history: auditFor(db, "print_job", [...chainIds]),
    openTasks: tasks.map((t) => ({ id: t.id, kind: t.kind, title: t.title, owner: t.owner, ownerRole: t.owner_role })),
  };
}

/** Active slides with no label and no print job yet (for example a newly ordered additional slide). Slides with an earlier job are handled from that job (reconcile / reprint). */
export function slidesAwaitingLabel(db: DB, limit = 8): { total: number; rows: { slideId: string; label: string; workOrderDisplayId: string | null; physicalState: string; purpose: "initial" | "additional_work" }[] } {
  ensureMaterialsSchema(db);
  const where = `s.status = 'active' AND s.label_state = 'none'
      AND (wo.id IS NULL OR wo.status IN ('requested','in_progress','completed'))
      AND NOT EXISTS (SELECT 1 FROM print_job pj WHERE pj.target_type = 'slide' AND pj.target_id = s.id AND pj.state <> 'canceled')`;
  const total = (db.prepare(`SELECT COUNT(*) n FROM slide s LEFT JOIN work_order wo ON wo.id = s.work_order_id WHERE ${where}`).get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT s.id, wo.display_id AS wo_display, wo.authorization_source AS auth FROM slide s LEFT JOIN work_order wo ON wo.id = s.work_order_id
        WHERE ${where} ORDER BY (wo.authorization_source IN ('pathologist_request','staff_entered_request')) DESC, wo.requested_at DESC, s.accession_id, s.block_id, s.slide_seq LIMIT ?`,
    )
    .all(limit) as { id: string; wo_display: string | null; auth: string | null }[];
  return {
    total,
    rows: rows.map((r) => {
      const info = getSlide(db, r.id)!;
      return { slideId: r.id, label: slideText(info), workOrderDisplayId: r.wo_display, physicalState: info.physical_state, purpose: r.auth === "pathologist_request" || r.auth === "staff_entered_request" ? "additional_work" : "initial" };
    }),
  };
}

// ---------------------------------------------------------------- source changes awaiting review

export interface WorkOrderReviewView {
  id: string;
  displayId: string;
  status: string;
  statusLabel: string;
  stain: string | null;
  kind: string;
  accessionId: string;
  accessionNumber: string;
  sourceReference: string;
  statusReason: string | null;
  version: number;
  slides: { id: string; label: string; physicalState: string; labelState: string; status: string; prepared: boolean; labels: LabelView[] }[];
  openTasks: { id: string; title: string; owner: string | null }[];
  holds: { displayId: string; scopeLabel: string; reason: string }[];
  /** Canceled at the source: keeping the work needs a new authorization by the dermatopathologist. */
  keepNeedsPathologist: boolean;
}

export function listWorkOrdersInReview(db: DB): WorkOrderReviewView[] {
  ensureMaterialsSchema(db);
  const wos = db
    .prepare(
      `SELECT wo.*, a.accession_number FROM work_order wo JOIN accession a ON a.id = wo.accession_id
        WHERE wo.status IN ('cancel_review','amended_review') ORDER BY wo.display_id`,
    )
    .all() as { id: string; display_id: string; status: string; stain: string | null; kind: string; accession_id: string; accession_number: string; source_reference: string; status_reason: string | null; version: number }[];
  return wos.map((w) => {
    const slides = db.prepare("SELECT id FROM slide WHERE work_order_id = ? ORDER BY slide_seq").all(w.id) as { id: string }[];
    const ids = [w.id, ...slides.map((s) => s.id)];
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, s.display_name AS owner FROM task t LEFT JOIN staff s ON s.id = t.owner_id
          WHERE t.status IN ('open','in_progress') AND t.entity_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as { id: string; title: string; owner: string | null }[];
    const holds = db
      .prepare(`SELECT display_id, scope_label, reason_text FROM hold WHERE status = 'active' AND scope_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { display_id: string; scope_label: string; reason_text: string }[];
    return {
      id: w.id,
      displayId: w.display_id,
      status: w.status,
      statusLabel: WORK_ORDER_STATUS[w.status as keyof typeof WORK_ORDER_STATUS] ?? w.status,
      stain: w.stain,
      kind: w.kind,
      accessionId: w.accession_id,
      accessionNumber: w.accession_number,
      sourceReference: w.source_reference,
      statusReason: w.status_reason,
      version: w.version,
      slides: slides.map((s) => {
        const info = getSlide(db, s.id)!;
        return {
          id: s.id,
          label: slideText(info),
          physicalState: info.physical_state,
          labelState: info.label_state,
          status: info.status,
          prepared: info.physical_state !== "planned",
          labels: labelsFor(db, "slide", s.id),
        };
      }),
      openTasks: tasks,
      holds: holds.map((h) => ({ displayId: h.display_id, scopeLabel: h.scope_label, reason: h.reason_text })),
      keepNeedsPathologist: w.status === "cancel_review",
    };
  });
}

/** Recently reviewed source changes (decision recorded), newest first. */
export function listRecentWorkOrderReviews(db: DB, limit = 5): { displayId: string; accessionNumber: string; decision: string | null; note: string | null; reviewedBy: string | null; reviewedAt: string | null; slides: { label: string; disposition: string }[] }[] {
  ensureMaterialsSchema(db);
  const rows = db
    .prepare(
      `SELECT wo.id, wo.display_id, a.accession_number, wo.review_decision, wo.review_note, s.display_name AS reviewer, wo.reviewed_at
         FROM work_order wo JOIN accession a ON a.id = wo.accession_id LEFT JOIN staff s ON s.id = wo.reviewed_by
        WHERE wo.review_decision IS NOT NULL ORDER BY wo.reviewed_at DESC LIMIT ?`,
    )
    .all(limit) as { id: string; display_id: string; accession_number: string; review_decision: string | null; review_note: string | null; reviewer: string | null; reviewed_at: string | null }[];
  return rows.map((r) => ({
    displayId: r.display_id,
    accessionNumber: r.accession_number,
    decision: r.review_decision,
    note: r.review_note,
    reviewedBy: r.reviewer,
    reviewedAt: r.reviewed_at,
    slides: (db.prepare("SELECT id, review_disposition FROM slide WHERE work_order_id = ?").all(r.id) as { id: string; review_disposition: string | null }[]).map((s) => ({
      label: slideText(getSlide(db, s.id)!),
      disposition: SLIDE_DISPOSITION_LABEL[s.review_disposition ?? ""] ?? s.review_disposition ?? "No disposition recorded",
    })),
  }));
}

// ---------------------------------------------------------------- trays

export interface TrayListRow {
  id: string;
  displayId: string;
  status: string;
  statusLabel: string;
  pathologistId: string;
  pathologistName: string;
  pathologistColor: string | null;
  expected: number;
  scanned: number;
  unresolved: number;
  openedAt: string;
  closedAt: string | null;
  version: number;
}

export function listTrays(db: DB): TrayListRow[] {
  ensureMaterialsSchema(db);
  const rows = db
    .prepare(
      `SELECT t.*, s.display_name AS pathologist_name, s.color_token AS pathologist_color FROM tray t JOIN staff s ON s.id = t.pathologist_id
        ORDER BY CASE t.status WHEN 'exception' THEN 0 WHEN 'assembling' THEN 1 WHEN 'open' THEN 2 WHEN 'verified_complete' THEN 3 WHEN 'released_with_exceptions' THEN 3 ELSE 5 END, t.opened_at DESC`,
    )
    .all() as { id: string; display_id: string; status: string; pathologist_id: string; pathologist_name: string; pathologist_color: string | null; opened_at: string; closed_at: string | null; version: number }[];
  return rows.map((t) => {
    const v = computeTrayView(db, t.id);
    return {
      id: t.id,
      displayId: t.display_id,
      status: t.status,
      statusLabel: TRAY_STATUS[t.status as keyof typeof TRAY_STATUS] ?? t.status,
      pathologistId: t.pathologist_id,
      pathologistName: t.pathologist_name,
      pathologistColor: t.pathologist_color,
      expected: v.counts.expected,
      scanned: v.counts.scanned,
      unresolved: v.counts.unresolved,
      openedAt: t.opened_at,
      closedAt: t.closed_at,
      version: t.version,
    };
  });
}

export interface BenchSlide {
  key: string;
  label: string;
  payload: string;
  kind: "expected" | "unexpected" | "missing" | "damaged";
  note: string;
  /** The "missing" slide is not on the bench until the presenter clicks "Found it". */
  hiddenUntilFound: boolean;
}

/**
 * SIMULATED scanner panel: what is physically on the bench next to the tray.
 * For TRY-M-03 this follows storyline step 6 (scenario_tray_present).
 */
export function benchSlidesFor(db: DB, view: TrayView): BenchSlide[] {
  if (!view.isActive) return [];
  const out: BenchSlide[] = [];
  const scannedIds = new Set(view.expected.filter((e) => e.state === "scanned").map((e) => e.slideId));
  const unresolvedSlideIds = new Set(view.unresolved.map((s) => s.slideId).filter(Boolean) as string[]);
  const removedIds = new Set(view.scans.filter((s) => s.resolution === "removed_from_tray").map((s) => s.slideId).filter(Boolean) as string[]);
  let scenario: { expectedUnscanned?: string; missing?: string; unexpected?: string } = {};
  if (view.tray.display_id === "TRY-M-03") {
    try {
      scenario = JSON.parse(getSetting(db, "scenario_tray_present") ?? "{}");
    } catch {
      scenario = {};
    }
  }
  const add = (slideId: string, kind: BenchSlide["kind"], note: string, hidden = false) => {
    const s = getSlide(db, slideId);
    if (!s) return;
    out.push({ key: `${kind}:${slideId}`, label: slideText(s), payload: s.identifier, kind, note, hiddenUntilFound: hidden });
  };
  const notScanned = view.expected.filter((e) => e.state !== "scanned" && e.state !== "canceled");
  if (scenario.expectedUnscanned || scenario.missing) {
    for (const e of notScanned) {
      if (e.slideId === scenario.missing) add(e.slideId, "missing", "Not on the bench. Click \"Found it\" to simulate finding it.", true);
      else add(e.slideId, "expected", "On the bench, not yet scanned");
    }
    if (scenario.unexpected && !scannedIds.has(scenario.unexpected) && !unresolvedSlideIds.has(scenario.unexpected) && !removedIds.has(scenario.unexpected)) {
      add(scenario.unexpected, "unexpected", "Mixed into the stack (belongs to another case)");
    }
  } else {
    for (const e of notScanned) add(e.slideId, "expected", "On the bench, not yet scanned");
  }
  // The smudged-label example is always a slide that is on the bench and not yet scanned (never one already on the tray).
  const sample = notScanned.find((e) => e.slideId !== scenario.missing && !e.disposition);
  if (sample) {
    const s = getSlide(db, sample.slideId);
    if (s) {
      const body = s.identifier.slice(0, s.identifier.lastIndexOf(":"));
      const last = s.identifier.slice(-1);
      const wrong = last === "Z" ? "Y" : last === "9" ? "A" : String.fromCharCode(last.charCodeAt(0) + 1);
      out.push({ key: `damaged:${s.id}`, label: `${slideText(s)} (smudged label)`, payload: `${body}:${wrong}`, kind: "damaged", note: "Simulated misread: wrong check character", hiddenUntilFound: false });
    }
  }
  return out;
}

export interface TrayDetail {
  view: TrayView;
  bench: BenchSlide[];
  pathologistColor: string | null;
  /** Latest print job per expected slide (for "label problem? reprint" links to the Print jobs tab). */
  printJobs: Record<string, string>;
  /** Derived, read only: active holds that stop tray delivery, per expected slide (drawn hatched on the tray). */
  holds: Record<string, { displayId: string; scopeLabel: string; reason: string }[]>;
}

export function getTrayDetail(db: DB, idOrDisplay: string): TrayDetail | null {
  ensureMaterialsSchema(db);
  const t = db
    .prepare("SELECT t.id, s.color_token FROM tray t JOIN staff s ON s.id = t.pathologist_id WHERE t.id = ? OR t.display_id = ?")
    .get(idOrDisplay, idOrDisplay) as { id: string; color_token: string | null } | undefined;
  if (!t) return null;
  const view = computeTrayView(db, t.id);
  const jobs = db
    .prepare(
      `SELECT pj.target_id, pj.display_id FROM print_job pj JOIN tray_expected_slide tes ON tes.slide_id = pj.target_id AND tes.tray_id = ?
        WHERE pj.target_type = 'slide' AND pj.state <> 'canceled' ORDER BY pj.created_at, pj.rowid`,
    )
    .all(t.id) as { target_id: string; display_id: string }[];
  const printJobs: Record<string, string> = {};
  for (const j of jobs) printJobs[j.target_id] = j.display_id; // later rows overwrite: newest wins
  const holds: TrayDetail["holds"] = {};
  for (const e of view.expected) {
    const blocking = holdsBlocking(db, "tray_delivery", scopesForSlide(db, e.slideId));
    if (blocking.length) holds[e.slideId] = blocking.map((h) => ({ displayId: h.display_id, scopeLabel: h.scope_label, reason: h.reason_text }));
  }
  return { view, bench: benchSlidesFor(db, view), pathologistColor: t.color_token, printJobs, holds };
}

/** Pathologists and how many slides are ready for a new tray — the same rules tray.open applies. */
export function pathologistsForTrays(db: DB): { id: string; name: string; ready: number }[] {
  const ps = db.prepare("SELECT id, display_name FROM staff WHERE role = 'pathologist' AND active = 1 ORDER BY display_name").all() as { id: string; display_name: string }[];
  return ps.map((p) => ({ id: p.id, name: p.display_name, ready: eligibleSlidesFor(db, p.id).length }));
}

// ---------------------------------------------------------------- retrieval

export type RetrievalFilter = "open" | "overdue" | "outside" | "all";

export interface RetrievalListRow {
  id: string;
  displayId: string;
  status: string;
  statusLabel: string;
  requestedBy: string;
  purpose: string;
  destination: string;
  createdAt: string;
  dueAt: string | null;
  items: number;
  picked: number;
  exceptions: number;
  hasOverdue: boolean;
  hasOutside: boolean;
}

export interface RetrievalItemView {
  id: string;
  benchSeq: number;
  blockId: string;
  blockLabel: string;
  identifier: string;
  status: string;
  statusLabel: string;
  pickedBy: string | null;
  pickedAt: string | null;
  note: string | null;
  location: LocationCard;
  custody: CustodyFacts;
  history: CustodyEventView[];
  /** Where this block's physical availability stands right now (derived). */
  availability: "in_storage" | "checked_out" | "sent_out" | "missing" | "in_workflow";
}

export interface PickGroup {
  key: string;
  label: string;
  items: { itemId: string; benchSeq: number; total: number; blockLabel: string; slot: string | null; status: string; statusLabel: string; availability: RetrievalItemView["availability"] }[];
}

export interface RetrievalDetail {
  request: RetrievalListRow & { workOrderDisplayId: string | null; version: number };
  items: RetrievalItemView[];
  pickList: PickGroup[];
  scanLog: { at: string; actor: string | null; event: string; blockLabel: string; note: string | null }[];
  locationCaption: string;
  overdueRule: string;
  sampleWrongBlock: { label: string; payload: string } | null;
}

function requestRows(db: DB, now: string): RetrievalListRow[] {
  const reqs = db
    .prepare(
      `SELECT rr.*, s.display_name AS requested_by_name FROM retrieval_request rr LEFT JOIN staff s ON s.id = rr.requested_by ORDER BY rr.created_at DESC`,
    )
    .all() as { id: string; display_id: string; status: string; requested_by: string; requested_by_name: string | null; purpose: string; destination: string; created_at: string; due_at: string | null }[];
  return reqs.map((r) => {
    const items = db.prepare("SELECT block_id, status FROM retrieval_item WHERE request_id = ?").all(r.id) as { block_id: string; status: string }[];
    let hasOverdue = false;
    let hasOutside = false;
    for (const i of items) {
      const b = getBlock(db, i.block_id);
      if (!b || i.status !== "pending") continue;
      const f = custodyFacts(db, b, now);
      if (f.overdue) hasOverdue = true;
      if (b.custody_state === "sent_out") hasOutside = true;
    }
    return {
      id: r.id,
      displayId: r.display_id,
      status: r.status,
      statusLabel: RETRIEVAL_STATUS[r.status as keyof typeof RETRIEVAL_STATUS] ?? r.status,
      requestedBy: r.requested_by_name ?? r.requested_by,
      purpose: r.purpose,
      destination: r.destination,
      createdAt: r.created_at,
      dueAt: r.due_at,
      items: items.length,
      picked: items.filter((i) => ["picked", "delivered", "returned"].includes(i.status)).length,
      exceptions: items.filter((i) => i.status === "not_found" || i.status === "missing_investigation").length,
      hasOverdue,
      hasOutside,
    };
  });
}

export function listRetrievalRequests(db: DB, filter: RetrievalFilter, now: string): { rows: RetrievalListRow[]; counts: Record<RetrievalFilter, number> } {
  ensureMaterialsSchema(db);
  const all = requestRows(db, now);
  const open = all.filter((r) => !["delivered", "canceled"].includes(r.status));
  const counts = { open: open.length, overdue: all.filter((r) => r.hasOverdue).length, outside: all.filter((r) => r.hasOutside).length, all: all.length };
  const rows = filter === "open" ? open : filter === "overdue" ? all.filter((r) => r.hasOverdue) : filter === "outside" ? all.filter((r) => r.hasOutside) : all;
  return { rows, counts };
}

export function getRetrievalDetail(db: DB, idOrDisplay: string, now: string): RetrievalDetail | null {
  ensureMaterialsSchema(db);
  const r = db.prepare("SELECT * FROM retrieval_request WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as
    | { id: string; work_order_id: string | null; version: number }
    | undefined;
  if (!r) return null;
  const row = requestRows(db, now).find((x) => x.id === r.id)!;
  const wo = r.work_order_id ? (db.prepare("SELECT display_id FROM work_order WHERE id = ?").get(r.work_order_id) as { display_id: string } | undefined) : undefined;
  const itemRows = db.prepare("SELECT * FROM retrieval_item WHERE request_id = ? ORDER BY bench_seq").all(r.id) as {
    id: string; block_id: string; bench_seq: number; status: string; picked_by: string | null; picked_at: string | null; note: string | null;
  }[];
  const items: RetrievalItemView[] = itemRows.map((i) => {
    const b = getBlock(db, i.block_id)!;
    const custody = custodyFacts(db, b, now);
    const availability: RetrievalItemView["availability"] =
      b.custody_state === "stored" ? "in_storage" : b.custody_state === "checked_out" ? "checked_out" : b.custody_state === "sent_out" ? "sent_out" : b.custody_state === "missing_investigation" ? "missing" : "in_workflow";
    return {
      id: i.id,
      benchSeq: i.bench_seq,
      blockId: b.id,
      blockLabel: blockText(b),
      identifier: b.identifier,
      status: i.status,
      statusLabel: ITEM_STATUS_LABEL[i.status] ?? i.status,
      pickedBy: i.picked_by ? ((db.prepare("SELECT display_name n FROM staff WHERE id = ?").get(i.picked_by) as { n: string } | undefined)?.n ?? i.picked_by) : null,
      pickedAt: i.picked_at,
      note: i.note,
      location: locationCard(b),
      custody,
      history: custodyHistory(db, b.id),
      availability,
    };
  });
  const groups = new Map<string, PickGroup>();
  for (const it of items) {
    const inStorage = it.availability === "in_storage" || it.availability === "missing";
    const done = it.status !== "pending" && it.status !== "not_found" && it.status !== "missing_investigation";
    const where = done
      ? { group: "~~picked", groupLabel: "Picked for this request", slot: null }
      : inStorage
        ? splitLocation(it.location.code)
        : { group: "~not-in-storage", groupLabel: "Not in storage (checked out or sent out)", slot: null };
    const g = groups.get(where.group) ?? { key: where.group, label: where.groupLabel, items: [] };
    g.items.push({ itemId: it.id, benchSeq: it.benchSeq, total: items.length, blockLabel: it.blockLabel, slot: where.slot, status: it.status, statusLabel: it.statusLabel, availability: it.availability });
    groups.set(where.group, g);
  }
  const pickList = [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((g) => ({ ...g, items: g.items.sort((a, b) => (a.slot ?? "").localeCompare(b.slot ?? "") || a.benchSeq - b.benchSeq) }));
  const log = db
    .prepare(
      `SELECT ce.at, s.display_name AS actor, ce.event, ce.material_id, ce.note FROM custody_event ce LEFT JOIN staff s ON s.id = ce.actor_id
        WHERE ce.request_id = ? ORDER BY ce.at DESC, ce.id DESC LIMIT 40`,
    )
    .all(r.id) as { at: string; actor: string | null; event: string; material_id: string; note: string | null }[];
  const inRequest = new Set(items.map((i) => i.blockId));
  const wrong =
    (db.prepare("SELECT b.id FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03909' LIMIT 1").get() as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM block WHERE custody_state = 'stored' ORDER BY id LIMIT 1").get() as { id: string } | undefined);
  const wrongBlock = wrong && !inRequest.has(wrong.id) ? getBlock(db, wrong.id) : undefined;
  return {
    request: { ...row, workOrderDisplayId: wo?.display_id ?? null, version: r.version },
    items,
    pickList,
    scanLog: log.map((l) => {
      const b = getBlock(db, l.material_id);
      return { at: l.at, actor: l.actor, event: l.event, blockLabel: b ? blockText(b) : l.material_id, note: l.note };
    }),
    locationCaption: LOCATION_CAPTION,
    overdueRule: "Demo default: a checked-out block is expected back the same lab day.",
    sampleWrongBlock: wrongBlock ? { label: blockText(wrongBlock), payload: wrongBlock.identifier } : null,
  };
}

/** Blocks a requester can pick from when creating a new retrieval request (stored archive blocks). */
export function storedBlocks(db: DB, limit = 60): { id: string; label: string; location: string | null }[] {
  const rows = db
    .prepare(
      `SELECT b.id FROM block b JOIN accession a ON a.id = b.accession_id
        WHERE b.status = 'active' AND b.custody_state IN ('stored','checked_out','sent_out') ORDER BY a.accession_number, b.label_text LIMIT ?`,
    )
    .all(limit) as { id: string }[];
  return rows.map((r) => {
    const b = getBlock(db, r.id)!;
    return { id: b.id, label: blockText(b), location: b.custody_state === "stored" ? b.location_code : b.custody_state === "sent_out" ? "Sent out" : "Checked out" };
  });
}

/** Overdue returns, outside send-outs and open investigations across all blocks. */
export function custodyExceptions(db: DB, now: string): { overdue: { label: string; summary: string }[]; sentOut: { label: string; summary: string }[]; missing: { label: string; summary: string }[] } {
  ensureMaterialsSchema(db);
  const rows = db.prepare("SELECT id FROM block WHERE custody_state IN ('checked_out','sent_out','missing_investigation')").all() as { id: string }[];
  const out = { overdue: [] as { label: string; summary: string }[], sentOut: [] as { label: string; summary: string }[], missing: [] as { label: string; summary: string }[] };
  for (const r of rows) {
    const b = getBlock(db, r.id)!;
    const f = custodyFacts(db, b, now);
    const entry = { label: blockText(b), summary: f.summary };
    if (b.custody_state === "sent_out") out.sentOut.push(entry);
    else if (b.custody_state === "missing_investigation") out.missing.push(entry);
    else if (f.overdue) out.overdue.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- tab counts

export function materialsCounts(db: DB, now: string): { print: number; trays: number; retrieval: number; reviews: number } {
  ensureMaterialsSchema(db);
  const print = (db.prepare(`SELECT COUNT(*) n FROM print_job pj WHERE ${NEEDS_ATTENTION_SQL}`).get() as { n: number }).n;
  const trays = (db.prepare("SELECT COUNT(*) n FROM tray WHERE status IN ('open','assembling','exception')").get() as { n: number }).n;
  const reviews = (db.prepare("SELECT COUNT(*) n FROM work_order WHERE status IN ('cancel_review','amended_review')").get() as { n: number }).n;
  const retrieval = listRetrievalRequests(db, "open", now).counts.open;
  return { print, trays, retrieval, reviews };
}
