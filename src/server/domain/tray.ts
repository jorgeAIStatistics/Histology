import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { requirePermission } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { closeTasks, openTask } from "../core/tasks";
import { recordWorklistChange } from "../core/feed";
import { updateVersioned } from "../core/versioning";
import { TRAY_STATUS, type TrayStatus } from "@/lib/domain";
import { decodeLabel, humanLabel } from "@/lib/identifiers";
import { roleCan } from "@/lib/roles";
import { fmtTime } from "@/lib/time";
import { assertNotHeld, holdsBlocking, scopesForSlide } from "./holds";
import { getSlide, getSlideByIdentifier, pathologistOf, refreshWorkOrderProgress, requireText, slideText, staffName } from "./material";

/**
 * Tray assembly. The tray and its context (pathologist) are established once;
 * then every slide is scanned individually. One tray scan never verifies the
 * slides on it, and there is no "verify all" action. A tray becomes
 * "Verified complete" only when every expected slide has its own matching scan
 * and nothing unexpected remains; otherwise a supervisor may release it with
 * documented exceptions, which is never shown as verified.
 */

export type TrayScanResult = "verified_expected" | "unexpected" | "duplicate" | "canceled_material" | "unknown_identifier" | "invalid_payload";
export type ScanResolution = "removed_from_tray" | "same_slide_rescanned" | "added_by_authorized_change";
/** Recorded by the system on an unreadable scan (nothing to remove: the scan identified no record). */
export type SystemResolution = "not_accepted";
export type Disposition = "follows_separately" | "missing_investigation";
export type ExpectedState = "expected" | "scanned" | "missing" | "follows_separately" | "canceled";

export const SCAN_RESULT_LABEL: Record<TrayScanResult, string> = {
  verified_expected: "Scanned, matches",
  unexpected: "Unexpected",
  duplicate: "Duplicate",
  canceled_material: "Canceled",
  unknown_identifier: "Unknown identifier",
  invalid_payload: "Not readable",
};

export const EXPECTED_STATE_LABEL: Record<ExpectedState, string> = {
  expected: "Expected",
  scanned: "Scanned, matches",
  missing: "Missing",
  follows_separately: "Follows separately",
  canceled: "Canceled",
};

export const RESOLUTION_LABEL: Record<ScanResolution | SystemResolution, string> = {
  removed_from_tray: "Removed from tray",
  same_slide_rescanned: "Same slide scanned twice (logged)",
  added_by_authorized_change: "Added to the list by a supervisor",
  not_accepted: "Not accepted (rescan needed)",
};

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  follows_separately: "Follows separately",
  missing_investigation: "Missing — investigation open",
};

const NEEDS_RESOLUTION: TrayScanResult[] = ["unexpected", "duplicate", "canceled_material", "unknown_identifier"];
/** Scan results that raise a tray exception (a person must look at the tray before it can be closed). */
const RAISES_EXCEPTION: TrayScanResult[] = ["unexpected", "canceled_material", "unknown_identifier"];
/** Task kind for tray exceptions (tray-level and per missing / following slide). Shown on /operations. */
export const TRAY_EXCEPTION_TASK = "tray_exception";
const ACTIVE_TRAY: TrayStatus[] = ["open", "assembling", "exception"];
const INACTIVE_WO = new Set(["cancel_review", "amended_review", "canceled"]);

export interface TrayRow {
  id: string;
  display_id: string;
  pathologist_id: string;
  status: TrayStatus;
  opened_by: string | null;
  opened_at: string;
  closed_by: string | null;
  closed_at: string | null;
  close_note: string | null;
  version: number;
}

export function getTray(db: DB, idOrDisplay: string): TrayRow | undefined {
  return db.prepare("SELECT * FROM tray WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as TrayRow | undefined;
}

function mustTray(db: DB, idOrDisplay: string): TrayRow {
  const t = getTray(db, idOrDisplay);
  if (!t) throw new DomainError("NOT_FOUND", `Tray ${idOrDisplay} was not found`);
  return t;
}

function assertActive(t: TrayRow): void {
  if (!ACTIVE_TRAY.includes(t.status)) {
    throw new DomainError("BLOCKED", `${t.display_id} is ${TRAY_STATUS[t.status].toLowerCase()}; it no longer accepts changes`);
  }
}

// ---------------------------------------------------------------- derived view

export interface TrayExpectedView {
  slideId: string;
  seq: number;
  label: string;
  identifier: string;
  accessionId: string;
  accessionNumber: string;
  state: ExpectedState;
  stateLabel: string;
  scanId: string | null;
  scannedAt: string | null;
  scannedBy: string | null;
  disposition: Disposition | null;
  dispositionNote: string | null;
  dispositionBy: string | null;
  dispositionAt: string | null;
  canceledReason: string | null;
  /** Scanned onto the tray, but its work was canceled or is under review since: must be removed. */
  canceledOnTray: boolean;
}

export interface TrayScanView {
  id: string;
  payload: string;
  slideId: string | null;
  slideLabel: string | null;
  accessionNumber: string | null;
  belongsTo: string | null;
  result: TrayScanResult;
  resultLabel: string;
  detail: string | null;
  scannedAt: string;
  scannedBy: string | null;
  resolution: ScanResolution | SystemResolution | null;
  resolutionLabel: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  needsResolution: boolean;
}

export interface TrayView {
  tray: TrayRow;
  statusLabel: string;
  pathologistName: string;
  openedByName: string | null;
  closedByName: string | null;
  expected: TrayExpectedView[];
  scans: TrayScanView[];
  unresolved: TrayScanView[];
  counts: { expected: number; scanned: number; notScanned: number; withDisposition: number; canceled: number; unresolved: number; canceledOnTray: number };
  /** Why "Mark tray complete" is not allowed (empty = allowed). */
  completeBlockers: string[];
  /** Why "Release with exceptions" is not allowed (empty = allowed). */
  releaseBlockers: string[];
  /** One-line summary for the blocked-completion message. */
  blockedSummary: string | null;
  isActive: boolean;
}

export function computeTrayView(db: DB, idOrDisplay: string): TrayView {
  const tray = mustTray(db, idOrDisplay);
  const rows = db
    .prepare(
      `SELECT tes.slide_id, tes.seq, tes.disposition, tes.disposition_by, tes.disposition_at, tes.disposition_note,
              s.identifier, s.status AS slide_status, s.slide_seq, s.stain, s.level_label, b.label_text AS block_label,
              a.accession_number, a.id AS accession_id, wo.status AS wo_status, wo.display_id AS wo_display
         FROM tray_expected_slide tes JOIN slide s ON s.id = tes.slide_id JOIN block b ON b.id = s.block_id
         JOIN accession a ON a.id = s.accession_id LEFT JOIN work_order wo ON wo.id = s.work_order_id
        WHERE tes.tray_id = ? ORDER BY tes.seq`,
    )
    .all(tray.id) as {
    slide_id: string; seq: number; disposition: Disposition | null; disposition_by: string | null; disposition_at: string | null; disposition_note: string | null;
    identifier: string; slide_status: string; slide_seq: number; stain: string; level_label: string | null; block_label: string; accession_number: string;
    accession_id: string; wo_status: string | null; wo_display: string | null;
  }[];
  const scanRows = db
    .prepare(
      `SELECT ts.*, s.slide_seq, s.stain, s.level_label, b.label_text AS block_label, a.accession_number, p.display_name AS pathologist_name,
              sb.display_name AS scanned_by_name, rb.display_name AS resolved_by_name
         FROM tray_scan ts LEFT JOIN slide s ON s.id = ts.slide_id LEFT JOIN block b ON b.id = s.block_id
         LEFT JOIN accession a ON a.id = s.accession_id LEFT JOIN staff p ON p.id = a.assigned_pathologist_id
         LEFT JOIN staff sb ON sb.id = ts.scanned_by LEFT JOIN staff rb ON rb.id = ts.resolved_by
        WHERE ts.tray_id = ? ORDER BY ts.scanned_at DESC, ts.id DESC`,
    )
    .all(tray.id) as {
    id: string; scanned_payload: string; slide_id: string | null; result: TrayScanResult; scanned_by: string; scanned_at: string; resolution: ScanResolution | SystemResolution | null;
    resolved_by: string | null; resolved_at: string | null; detail: string | null; slide_seq: number | null; stain: string | null; level_label: string | null;
    block_label: string | null; accession_number: string | null; pathologist_name: string | null; scanned_by_name: string | null; resolved_by_name: string | null;
  }[];

  const scans: TrayScanView[] = scanRows.map((r) => ({
    id: r.id,
    payload: r.scanned_payload,
    slideId: r.slide_id,
    slideLabel: r.accession_number ? slideText({ accession_number: r.accession_number, block_label: r.block_label!, slide_seq: r.slide_seq!, stain: r.stain!, level_label: r.level_label }) : null,
    accessionNumber: r.accession_number,
    belongsTo: r.pathologist_name,
    result: r.result,
    resultLabel: SCAN_RESULT_LABEL[r.result] ?? r.result,
    detail: r.detail,
    scannedAt: r.scanned_at,
    scannedBy: r.scanned_by_name ?? r.scanned_by,
    resolution: r.resolution,
    resolutionLabel: r.resolution ? (RESOLUTION_LABEL[r.resolution] ?? r.resolution) : null,
    resolvedBy: r.resolved_by_name ?? r.resolved_by,
    resolvedAt: r.resolved_at,
    needsResolution: NEEDS_RESOLUTION.includes(r.result) && !r.resolution,
  }));

  const matchingScan = (slideId: string) =>
    scans
      .slice()
      .reverse()
      .find(
        (s) =>
          s.slideId === slideId &&
          ((s.result === "verified_expected" && s.resolution !== "removed_from_tray") || (s.result === "unexpected" && s.resolution === "added_by_authorized_change")),
      );

  const expected: TrayExpectedView[] = rows.map((r) => {
    const label = slideText({ accession_number: r.accession_number, block_label: r.block_label, slide_seq: r.slide_seq, stain: r.stain, level_label: r.level_label });
    const scan = matchingScan(r.slide_id);
    const canceledReason =
      r.slide_status !== "active"
        ? r.slide_status === "canceled_needs_review"
          ? "Work canceled or amended at the source; awaiting review"
          : "Slide is void"
        : r.wo_status && INACTIVE_WO.has(r.wo_status)
          ? `${r.wo_display} is ${r.wo_status.replace(/_/g, " ")}`
          : null;
    // Cancellation takes precedence over an earlier scan: a slide whose work was canceled after it was
    // scanned is not counted as "on the tray"; it is flagged for removal instead.
    let state: ExpectedState;
    if (canceledReason) state = "canceled";
    else if (scan) state = "scanned";
    else if (r.disposition === "missing_investigation") state = "missing";
    else if (r.disposition === "follows_separately") state = "follows_separately";
    else state = "expected";
    return {
      slideId: r.slide_id,
      seq: r.seq,
      label,
      identifier: r.identifier,
      accessionId: r.accession_id,
      accessionNumber: r.accession_number,
      state,
      stateLabel: EXPECTED_STATE_LABEL[state],
      scanId: scan?.id ?? null,
      scannedAt: scan?.scannedAt ?? null,
      scannedBy: scan?.scannedBy ?? null,
      disposition: scan ? null : r.disposition,
      dispositionNote: scan ? null : r.disposition_note,
      dispositionBy: scan ? null : staffName(db, r.disposition_by),
      dispositionAt: scan ? null : r.disposition_at,
      canceledReason,
      canceledOnTray: !!canceledReason && !!scan,
    };
  });

  const unresolved = scans.filter((s) => s.needsResolution);
  const canceledOnTray = expected.filter((e) => e.canceledOnTray);
  const live = expected.filter((e) => e.state !== "canceled");
  const scanned = live.filter((e) => e.state === "scanned");
  const notScanned = live.filter((e) => e.state !== "scanned");
  const noDisposition = notScanned.filter((e) => !e.disposition);
  const withDisposition = notScanned.filter((e) => !!e.disposition);

  const unresolvedText = (s: TrayScanView) => {
    const what = s.slideLabel ?? `"${s.payload}"`;
    switch (s.result) {
      case "unexpected":
        return `Unexpected slide ${what}${s.belongsTo ? ` (${s.belongsTo}'s case)` : ""} still on the tray: remove it`;
      case "duplicate":
        return `Duplicate scan of ${what}: confirm it was the same slide or remove the second slide`;
      case "canceled_material":
        return `Canceled material ${what} must be removed from the tray`;
      default:
        return `Unknown label ${what} must be removed from the tray`;
    }
  };

  const canceledText = (e: TrayExpectedView) => `${e.label}: scanned onto the tray, but ${e.canceledReason?.toLowerCase() ?? "its work was canceled"}: remove it from the tray`;
  const completeBlockers: string[] = [];
  for (const e of noDisposition) completeBlockers.push(`${e.label}: expected, not scanned`);
  for (const e of withDisposition) completeBlockers.push(`${e.label}: not on the tray (${DISPOSITION_LABEL[e.disposition!].toLowerCase()})`);
  for (const e of canceledOnTray) completeBlockers.push(canceledText(e));
  for (const s of unresolved) completeBlockers.push(unresolvedText(s));

  const releaseBlockers: string[] = [];
  for (const e of noDisposition) releaseBlockers.push(`${e.label}: scan it, or record "follows separately" or "missing" with a note`);
  for (const e of canceledOnTray) releaseBlockers.push(canceledText(e));
  for (const s of unresolved) releaseBlockers.push(unresolvedText(s));
  if (!completeBlockers.length) releaseBlockers.push("Nothing is outstanding: use Mark tray complete instead");

  const parts: string[] = [];
  if (notScanned.length) {
    const missing = notScanned.filter((e) => e.state === "missing" || e.state === "expected");
    const follows = notScanned.filter((e) => e.state === "follows_separately");
    if (missing.length) parts.push(`${missing.length} not scanned (${missing.map((e) => e.label.split(" ").slice(0, 2).join(" ")).join(", ")})`);
    if (follows.length) parts.push(`${follows.length} follows separately (${follows.map((e) => e.label.split(" ").slice(0, 2).join(" ")).join(", ")})`);
  }
  const byKind = (k: TrayScanResult, word: string) => {
    const list = unresolved.filter((s) => s.result === k);
    if (list.length) parts.push(`${list.length} ${word} (${list.map((s) => (s.slideLabel ? s.slideLabel.split(" ").slice(0, 2).join(" ") : s.payload)).join(", ")})`);
  };
  if (canceledOnTray.length) parts.push(`${canceledOnTray.length} canceled on the tray (${canceledOnTray.map((e) => e.label.split(" ").slice(0, 2).join(" ")).join(", ")})`);
  byKind("unexpected", "unexpected");
  byKind("duplicate", "duplicate");
  byKind("canceled_material", "canceled");
  byKind("unknown_identifier", "unknown");

  const isActive = ACTIVE_TRAY.includes(tray.status);
  return {
    tray,
    statusLabel: TRAY_STATUS[tray.status] ?? tray.status,
    pathologistName: staffName(db, tray.pathologist_id) ?? "Unknown",
    openedByName: staffName(db, tray.opened_by),
    closedByName: staffName(db, tray.closed_by),
    expected,
    scans,
    unresolved,
    counts: {
      expected: live.length,
      scanned: scanned.length,
      notScanned: notScanned.length,
      withDisposition: withDisposition.length,
      canceled: expected.length - live.length,
      unresolved: unresolved.length,
      canceledOnTray: canceledOnTray.length,
    },
    completeBlockers: isActive ? completeBlockers : [`${tray.display_id} is ${TRAY_STATUS[tray.status].toLowerCase()}`],
    releaseBlockers: isActive ? releaseBlockers : [`${tray.display_id} is ${TRAY_STATUS[tray.status].toLowerCase()}`],
    blockedSummary: isActive && completeBlockers.length ? `Cannot complete: ${parts.join(", ")}.` : null,
    isActive,
  };
}

function openTrayExceptionTask(ctx: Ctx, tray: TrayRow): string | null {
  const row = ctx.db
    .prepare("SELECT id FROM task WHERE kind = ? AND entity_type = 'tray' AND entity_id = ? AND status IN ('open','in_progress')")
    .get(TRAY_EXCEPTION_TASK, tray.id) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Tray status:
 *   exception  — something needs a person before the tray can be closed: an unresolved flagged scan,
 *                a slide recorded missing / following separately, canceled material still on the tray,
 *                or an earlier exception (unexpected / canceled / unknown slide) while slides are still
 *                outstanding. A tray-level task names who owns it (shown on Operations).
 *   assembling — at least one scan, nothing exceptional outstanding.
 *   open       — no scans yet.
 * Every scan or decision bumps the version, so a stale "Mark complete" is detected.
 */
function refreshTrayStatus(ctx: Ctx, trayId: string): TrayStatus {
  const t = mustTray(ctx.db, trayId);
  if (!ACTIVE_TRAY.includes(t.status)) return t.status;
  const view = computeTrayView(ctx.db, t.id);
  const substantive =
    view.unresolved.some((u) => RAISES_EXCEPTION.includes(u.result)) || view.counts.withDisposition > 0 || view.counts.canceledOnTray > 0;
  const hard = view.counts.unresolved > 0 || substantive;
  let taskId = openTrayExceptionTask(ctx, t);
  if (substantive && !taskId) {
    const canAssemble = roleCan(ctx.actor.role, "tray.assemble");
    taskId = openTask(ctx, {
      kind: TRAY_EXCEPTION_TASK,
      entityType: "tray",
      entityId: t.id,
      title: `${t.display_id} (${view.pathologistName}): exception during assembly — resolve before it can be completed or released`,
      ownerId: canAssemble ? ctx.actor.id : null,
      ownerRole: "histotech",
      priority: "high",
      detail: view.blockedSummary,
    });
  }
  const anyScan = ctx.db.prepare("SELECT 1 FROM tray_scan WHERE tray_id = ? LIMIT 1").get(t.id);
  let next: TrayStatus;
  if (hard) next = "exception";
  else if (taskId && view.completeBlockers.length) next = "exception";
  else {
    if (taskId) closeTasks(ctx, TRAY_EXCEPTION_TASK, "tray", t.id);
    next = anyScan ? "assembling" : "open";
  }
  updateVersioned(ctx.db, "tray", t.id, undefined, { status: next });
  return next;
}

/** Why a slide cannot (yet) be listed on a tray, or null when it can. Same rules as opening a tray. */
export function trayReadinessProblem(db: DB, slideId: string, exceptTrayId?: string): string | null {
  const s = getSlide(db, slideId);
  if (!s) return "Slide not found";
  if (s.status !== "active") return `${slideText(s)} is ${s.status === "void" ? "void" : "awaiting review of a source change"}`;
  if (s.wo_status && INACTIVE_WO.has(s.wo_status)) return `${slideText(s)} belongs to ${s.wo_display}, which is ${s.wo_status.replace(/_/g, " ")}`;
  if (s.physical_state !== "qc_reviewed") return `${slideText(s)} is not QC reviewed`;
  if (s.label_state !== "verified") return `${slideText(s)}'s label has not been scanned after it was applied`;
  const other = db
    .prepare("SELECT t.display_id FROM tray_expected_slide tes JOIN tray t ON t.id = tes.tray_id WHERE tes.slide_id = ? AND t.status <> 'delivered' AND t.id <> ? LIMIT 1")
    .get(slideId, exceptTrayId ?? "") as { display_id: string } | undefined;
  if (other) return `${slideText(s)} is already listed on ${other.display_id}`;
  const held = holdsBlocking(db, "tray_delivery", scopesForSlide(db, slideId));
  if (held.length) return `${slideText(s)} has an active hold blocking tray delivery (${held.map((h) => h.display_id).join(", ")})`;
  return null;
}

// ---------------------------------------------------------------- commands

/** Ready for a tray (R-5): QC reviewed, label verified, active, work not under review, no delivery hold, not already on a tray. */
export function eligibleSlidesFor(db: DB, pathologistId: string): string[] {
  const rows = db
    .prepare(
      `SELECT s.id FROM slide s JOIN accession a ON a.id = s.accession_id JOIN block b ON b.id = s.block_id
         LEFT JOIN work_order wo ON wo.id = s.work_order_id
        WHERE a.assigned_pathologist_id = ? AND s.physical_state = 'qc_reviewed' AND s.status = 'active' AND s.label_state = 'verified'
          AND (wo.id IS NULL OR wo.status IN ('requested','in_progress','completed'))
          AND NOT EXISTS (SELECT 1 FROM tray_expected_slide tes JOIN tray t ON t.id = tes.tray_id WHERE tes.slide_id = s.id AND t.status <> 'delivered')
        ORDER BY a.accession_number, b.label_text, s.slide_seq`,
    )
    .all(pathologistId) as { id: string }[];
  return rows.map((r) => r.id).filter((id) => holdsBlocking(db, "tray_delivery", scopesForSlide(db, id)).length === 0);
}

export function openTray(ctx: Ctx, pathologistId: string): { trayId: string; displayId: string; expected: number; message: string } {
  const p = ctx.db.prepare("SELECT id, display_name, role FROM staff WHERE id = ?").get(pathologistId) as { id: string; display_name: string; role: string } | undefined;
  if (!p || p.role !== "pathologist") throw new DomainError("VALIDATION", "Choose an assigned dermatopathologist for the tray");
  const slides = eligibleSlidesFor(ctx.db, pathologistId);
  if (!slides.length) {
    throw new DomainError("BLOCKED", `No slides for ${p.display_name} are QC reviewed with a verified label and ready for a tray right now.`);
  }
  const initial = (p.display_name.split(" ").pop() ?? "X").charAt(0).toUpperCase();
  const id = newId(ctx.db, "tray");
  const display = displayId(ctx.db, `TRY-${initial}`, 2);
  ctx.db
    .prepare("INSERT INTO tray (id, display_id, pathologist_id, status, opened_by, opened_at, version) VALUES (?, ?, ?, 'open', ?, ?, 1)")
    .run(id, display, pathologistId, ctx.actor.id, ctx.now);
  const ins = ctx.db.prepare("INSERT INTO tray_expected_slide (tray_id, slide_id, seq) VALUES (?, ?, ?)");
  slides.forEach((sid, i) => ins.run(id, sid, i + 1));
  audit(ctx, {
    action: "tray.opened",
    entityType: "tray",
    entityId: id,
    summary: `${display} opened for ${p.display_name}: ${slides.length} expected slide(s) listed. Each must be scanned individually.`,
  });
  return { trayId: id, displayId: display, expected: slides.length, message: `${display} opened for ${p.display_name} with ${slides.length} expected slide(s). Scan each slide.` };
}

export interface TrayScanOutcome {
  scanId: string;
  trayId: string;
  trayDisplayId: string;
  result: TrayScanResult;
  resultLabel: string;
  accepted: boolean;
  slideId: string | null;
  slideLabel: string | null;
  message: string;
  trayStatus: TrayStatus;
  scannedCount: number;
  expectedCount: number;
}

export function scanIntoTray(ctx: Ctx, trayIdOrDisplay: string, payload: string): TrayScanOutcome {
  const tray = mustTray(ctx.db, trayIdOrDisplay);
  assertActive(tray);
  const raw = requireText(payload, "Scan or type a slide label").toUpperCase();
  const decoded = decodeLabel(raw);
  let result: TrayScanResult;
  let slideId: string | null = null;
  let slideLabel: string | null = null;
  let detail: string;
  const pathologist = staffName(ctx.db, tray.pathologist_id) ?? "the assigned dermatopathologist";

  if (!decoded.ok) {
    result = "invalid_payload";
    detail = `Not accepted: ${decoded.reason}. Rescan, or type the full label code.`;
  } else if (decoded.identity.kind !== "S") {
    result = "invalid_payload";
    detail = `Scanned ${humanLabel(decoded.identity)}, which is a ${decoded.identity.kind === "B" ? "block (cassette)" : "case"} label. Scan the slide label.`;
  } else {
    const slide = getSlideByIdentifier(ctx.db, decoded.payload);
    if (!slide) {
      result = "unknown_identifier";
      detail = `Label reads ${humanLabel(decoded.identity)}, but no such slide exists in this lab's records. Remove it from the tray and report it.`;
    } else {
      slideId = slide.id;
      slideLabel = slideText(slide);
      const exp = ctx.db.prepare("SELECT * FROM tray_expected_slide WHERE tray_id = ? AND slide_id = ?").get(tray.id, slide.id) as
        | { disposition: string | null }
        | undefined;
      const prior = ctx.db
        .prepare(
          `SELECT scanned_at, scanned_by FROM tray_scan WHERE tray_id = ? AND slide_id = ? AND resolution IS NULL
              AND result IN ('verified_expected','unexpected','canceled_material') ORDER BY scanned_at DESC LIMIT 1`,
        )
        .get(tray.id, slide.id) as { scanned_at: string; scanned_by: string } | undefined;
      const canceled = slide.status !== "active" || (slide.wo_status !== null && INACTIVE_WO.has(slide.wo_status));
      if (prior) {
        result = "duplicate";
        detail = `${slideLabel} was already scanned at ${fmtTime(prior.scanned_at)} ET by ${staffName(ctx.db, prior.scanned_by)}. Counted once.`;
      } else if (canceled) {
        result = "canceled_material";
        detail = `${slideLabel}: the work for this slide was canceled or is under review${slide.wo_display ? ` (${slide.wo_display})` : ""}. Remove it from the tray.`;
      } else if (exp) {
        result = "verified_expected";
        detail = `Scanned ${slideLabel}. Matches ${tray.display_id}.`;
        if (exp.disposition) {
          ctx.db
            .prepare("UPDATE tray_expected_slide SET disposition = NULL, disposition_by = ?, disposition_at = ?, disposition_note = ? WHERE tray_id = ? AND slide_id = ?")
            .run(ctx.actor.id, ctx.now, `Found and scanned (was: ${exp.disposition.replace(/_/g, " ")})`, tray.id, slide.id);
          detail += " It was recorded as not on the tray; that record is now closed.";
        }
        // A slide that was following separately or missing (on this or an earlier tray) is now accounted for.
        closeTasks(ctx, TRAY_EXCEPTION_TASK, "slide", slide.id);
      } else {
        result = "unexpected";
        const owner = slide.pathologist_id ? staffName(ctx.db, slide.pathologist_id) : null;
        detail = `${slideLabel} is not on ${tray.display_id}'s list for ${pathologist}${owner ? ` (it belongs to ${owner}'s case)` : ""}. Not accepted. Remove it from the tray.`;
      }
    }
  }

  const scanId = newId(ctx.db, "tscan");
  // An unreadable scan identified nothing, so there is nothing to remove: it is logged as "not accepted".
  const autoResolved = result === "invalid_payload";
  ctx.db
    .prepare(
      `INSERT INTO tray_scan (id, tray_id, scanned_payload, slide_id, result, scanned_by, scanned_at, detail, resolution, resolved_by, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scanId, tray.id, raw, slideId, result, ctx.actor.id, ctx.now, detail,
      autoResolved ? "not_accepted" : null, autoResolved ? ctx.actor.id : null, autoResolved ? ctx.now : null,
    );
  const status = refreshTrayStatus(ctx, tray.id);
  const accessionId = slideId ? (getSlide(ctx.db, slideId)?.accession_id ?? null) : null;
  audit(ctx, {
    action: "tray.scan",
    entityType: "tray",
    entityId: tray.id,
    accessionId,
    summary: `${tray.display_id} scan: ${SCAN_RESULT_LABEL[result]}${slideLabel ? ` — ${slideLabel}` : ` — "${raw}"`}`,
    after: { result, payload: raw },
  });
  const view = computeTrayView(ctx.db, tray.id);
  return {
    scanId,
    trayId: tray.id,
    trayDisplayId: tray.display_id,
    result,
    resultLabel: SCAN_RESULT_LABEL[result],
    accepted: result === "verified_expected",
    slideId,
    slideLabel,
    message: result === "verified_expected" ? `${detail} ${view.counts.scanned} of ${view.counts.expected} scanned.` : detail,
    trayStatus: status,
    scannedCount: view.counts.scanned,
    expectedCount: view.counts.expected,
  };
}

const PRE_DELIVERY_CLOSED: TrayStatus[] = ["verified_complete", "released_with_exceptions"];

function isCanceledSlide(slide: { status: string; wo_status: string | null }): boolean {
  return slide.status !== "active" || (slide.wo_status !== null && INACTIVE_WO.has(slide.wo_status));
}

export function resolveTrayScan(ctx: Ctx, scanId: string, resolution: ScanResolution): { scanId: string; trayStatus: TrayStatus; message: string } {
  const scan = ctx.db.prepare("SELECT * FROM tray_scan WHERE id = ?").get(scanId) as
    | { id: string; tray_id: string; slide_id: string | null; result: TrayScanResult; resolution: string | null; scanned_payload: string }
    | undefined;
  if (!scan) throw new DomainError("NOT_FOUND", `Scan ${scanId} was not found`);
  const tray = mustTray(ctx.db, scan.tray_id);
  const slide = scan.slide_id ? getSlide(ctx.db, scan.slide_id) : undefined;
  const what = slide ? slideText(slide) : `"${scan.scanned_payload}"`;
  // A slide scanned onto the tray whose work was canceled afterwards must be taken off again,
  // even if the tray was already closed (before delivery).
  const removingCanceled = scan.result === "verified_expected" && resolution === "removed_from_tray" && !!slide && isCanceledSlide(slide);
  if (removingCanceled) {
    if (!ACTIVE_TRAY.includes(tray.status) && !PRE_DELIVERY_CLOSED.includes(tray.status)) {
      throw new DomainError("BLOCKED", `${tray.display_id} is ${TRAY_STATUS[tray.status].toLowerCase()}; it no longer accepts changes`);
    }
  } else {
    assertActive(tray);
    if (!NEEDS_RESOLUTION.includes(scan.result)) throw new DomainError("VALIDATION", `A "${SCAN_RESULT_LABEL[scan.result]}" scan needs no resolution`);
  }
  if (scan.resolution) return { scanId, trayStatus: tray.status, message: `Already resolved (${RESOLUTION_LABEL[scan.resolution as ScanResolution] ?? scan.resolution}). Nothing changed.` };

  if (resolution === "same_slide_rescanned" && scan.result !== "duplicate") {
    throw new DomainError("VALIDATION", "Only a duplicate scan can be closed as the same slide scanned twice");
  }
  if (resolution === "added_by_authorized_change") {
    requirePermission(ctx, "tray.releaseWithExceptions");
    if (scan.result !== "unexpected" || !slide) throw new DomainError("VALIDATION", "Only an unexpected slide can be added to the expected list");
    if (slide.pathologist_id !== tray.pathologist_id) {
      throw new DomainError(
        "INVARIANT",
        `${what} belongs to ${staffName(ctx.db, slide.pathologist_id) ?? "another pathologist"}'s case, not ${staffName(ctx.db, tray.pathologist_id)}'s. It cannot join ${tray.display_id}; remove it.`,
      );
    }
    // Same readiness rules as opening a tray (QC reviewed, label scanned, work active, not on another tray, no hold).
    const problem = trayReadinessProblem(ctx.db, slide.id, tray.id);
    if (problem) throw new DomainError("BLOCKED", `${problem}. It cannot be added to ${tray.display_id}; remove it.`);
    const seq = (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 n FROM tray_expected_slide WHERE tray_id = ?").get(tray.id) as { n: number }).n;
    ctx.db.prepare("INSERT OR IGNORE INTO tray_expected_slide (tray_id, slide_id, seq) VALUES (?, ?, ?)").run(tray.id, slide.id, seq);
  }
  ctx.db.prepare("UPDATE tray_scan SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(resolution, ctx.actor.id, ctx.now, scanId);
  const status = ACTIVE_TRAY.includes(tray.status) ? refreshTrayStatus(ctx, tray.id) : tray.status;
  if (!ACTIVE_TRAY.includes(tray.status)) updateVersioned(ctx.db, "tray", tray.id, undefined, {});
  audit(ctx, {
    action: "tray.scan_resolved",
    entityType: "tray",
    entityId: tray.id,
    accessionId: slide?.accession_id ?? null,
    summary: `${tray.display_id}: ${removingCanceled ? "canceled material" : SCAN_RESULT_LABEL[scan.result].toLowerCase()} ${what} — ${RESOLUTION_LABEL[resolution].toLowerCase()} (${ctx.actor.name})`,
  });
  return { scanId, trayStatus: status, message: `${what}: ${RESOLUTION_LABEL[resolution]}.` };
}

export function setTrayDisposition(
  ctx: Ctx,
  trayIdOrDisplay: string,
  slideId: string,
  disposition: Disposition,
  note: string,
): { trayId: string; slideId: string; taskId: string; message: string } {
  const why = requireText(note, "Add a note: where the slide is, or what was checked");
  const tray = mustTray(ctx.db, trayIdOrDisplay);
  assertActive(tray);
  const view = computeTrayView(ctx.db, tray.id);
  const item = view.expected.find((e) => e.slideId === slideId);
  if (!item) throw new DomainError("NOT_FOUND", `That slide is not on ${tray.display_id}'s expected list`);
  if (item.state === "scanned") throw new DomainError("VALIDATION", `${item.label} was already scanned onto ${tray.display_id}; no disposition is needed`);
  if (item.state === "canceled") throw new DomainError("VALIDATION", `${item.label} is canceled (${item.canceledReason}); it is not expected on the tray`);
  ctx.db
    .prepare("UPDATE tray_expected_slide SET disposition = ?, disposition_by = ?, disposition_at = ?, disposition_note = ? WHERE tray_id = ? AND slide_id = ?")
    .run(disposition, ctx.actor.id, ctx.now, why, tray.id, slideId);
  const pathologist = staffName(ctx.db, tray.pathologist_id);
  // One open tray-exception task per slide; changing the disposition replaces it.
  closeTasks(ctx, TRAY_EXCEPTION_TASK, "slide", slideId, "canceled");
  const taskId = openTask(ctx, {
    kind: TRAY_EXCEPTION_TASK,
    entityType: "slide",
    entityId: slideId,
    title:
      disposition === "follows_separately"
        ? `Deliver ${item.label} separately to ${pathologist} (not on ${tray.display_id})`
        : `Missing-material investigation: find slide ${item.label} (expected on ${tray.display_id})`,
    ownerId: ctx.actor.id,
    ownerRole: "histotech",
    priority: "high",
    accessionId: item.accessionId,
    detail: why,
  });
  refreshTrayStatus(ctx, tray.id);
  audit(ctx, {
    action: "tray.disposition",
    entityType: "tray",
    entityId: tray.id,
    accessionId: item.accessionId,
    summary: `${tray.display_id}: ${item.label} recorded as ${DISPOSITION_LABEL[disposition].toLowerCase()} by ${ctx.actor.name}`,
    reason: why,
  });
  recordWorklistChange(ctx, {
    accessionId: item.accessionId,
    pathologistId: pathologistOf(ctx.db, item.accessionId),
    type: "changed",
    summary: `${item.label} not on ${tray.display_id}: ${DISPOSITION_LABEL[disposition].toLowerCase()}`,
  });
  return { trayId: tray.id, slideId, taskId, message: `${item.label}: ${DISPOSITION_LABEL[disposition]}. Task opened for ${ctx.actor.name}.` };
}

export function completeTray(ctx: Ctx, trayIdOrDisplay: string, expectedVersion: number): { trayId: string; status: TrayStatus; message: string } {
  const tray = mustTray(ctx.db, trayIdOrDisplay);
  if (tray.status === "verified_complete") return { trayId: tray.id, status: tray.status, message: `${tray.display_id} is already verified complete. Nothing changed.` };
  assertActive(tray);
  if (tray.version !== expectedVersion) {
    throw new DomainError(
      "CONFLICT",
      `${tray.display_id} changed since you looked at it (another scan or decision was recorded). Review the latest list before completing.`,
      { table: "tray", id: tray.id, expectedVersion, currentVersion: tray.version },
    );
  }
  const view = computeTrayView(ctx.db, tray.id);
  if (view.completeBlockers.length) {
    throw new DomainError("BLOCKED", `${tray.display_id} ${view.blockedSummary ?? "cannot be completed."}`, { reasons: view.completeBlockers });
  }
  const note = `Every expected slide scanned individually (${view.counts.scanned} of ${view.counts.expected}); nothing unexpected remains.`;
  const updated = updateVersioned(ctx.db, "tray", tray.id, expectedVersion, { status: "verified_complete", closed_by: ctx.actor.id, closed_at: ctx.now, close_note: note });
  closeTasks(ctx, TRAY_EXCEPTION_TASK, "tray", tray.id);
  audit(ctx, {
    action: "tray.completed",
    entityType: "tray",
    entityId: tray.id,
    summary: `${tray.display_id} verified complete by ${ctx.actor.name}. ${note}`,
    before: { status: tray.status, version: tray.version },
    after: {
      status: "verified_complete",
      version: updated.version,
      pathologistId: tray.pathologist_id,
      scannedSlideIds: view.expected.filter((e) => e.state === "scanned").map((e) => e.slideId),
      counts: view.counts,
    },
  });
  return { trayId: tray.id, status: "verified_complete", message: `${tray.display_id} verified complete. ${note}` };
}

export function releaseTrayWithExceptions(
  ctx: Ctx,
  trayIdOrDisplay: string,
  note: string,
  expectedVersion: number,
): { trayId: string; status: TrayStatus; message: string } {
  const why = requireText(note, "A note is required to release a tray with exceptions");
  const tray = mustTray(ctx.db, trayIdOrDisplay);
  if (tray.status === "released_with_exceptions") return { trayId: tray.id, status: tray.status, message: `${tray.display_id} was already released with exceptions. Nothing changed.` };
  assertActive(tray);
  // Same stale-view rule as completing a tray: the supervisor decides on the list they reviewed, not on a newer one.
  if (tray.version !== expectedVersion) {
    throw new DomainError(
      "CONFLICT",
      `${tray.display_id} changed since you looked at it (another scan or decision was recorded). Review the latest list before releasing it with exceptions.`,
      { table: "tray", id: tray.id, expectedVersion, currentVersion: tray.version },
    );
  }
  const view = computeTrayView(ctx.db, tray.id);
  if (view.releaseBlockers.length) {
    throw new DomainError("BLOCKED", `${tray.display_id} cannot be released yet: ${view.releaseBlockers.join("; ")}.`, { reasons: view.releaseBlockers });
  }
  const outstanding = view.expected
    .filter((e) => e.state !== "scanned" && e.state !== "canceled")
    .map((e) => `${e.label} (${DISPOSITION_LABEL[e.disposition!].toLowerCase()}: ${e.dispositionNote})`);
  const closeNote = `Released with exceptions by ${ctx.actor.name}: ${why}. Scanned ${view.counts.scanned} of ${view.counts.expected}. Outstanding: ${outstanding.join("; ")}.`;
  const updated = updateVersioned(ctx.db, "tray", tray.id, expectedVersion, { status: "released_with_exceptions", closed_by: ctx.actor.id, closed_at: ctx.now, close_note: closeNote });
  // The tray-level exception is decided; each outstanding slide keeps its own task.
  closeTasks(ctx, TRAY_EXCEPTION_TASK, "tray", tray.id);
  audit(ctx, {
    action: "tray.released_with_exceptions",
    entityType: "tray",
    entityId: tray.id,
    summary: `${tray.display_id}: ${closeNote}`,
    reason: why,
    before: { status: tray.status, version: tray.version },
    after: {
      status: "released_with_exceptions",
      version: updated.version,
      pathologistId: tray.pathologist_id,
      scannedSlideIds: view.expected.filter((e) => e.state === "scanned").map((e) => e.slideId),
      outstanding: view.expected
        .filter((e) => e.state !== "scanned" && e.state !== "canceled")
        .map((e) => ({ slideId: e.slideId, disposition: e.disposition, note: e.dispositionNote })),
      counts: view.counts,
    },
  });
  return { trayId: tray.id, status: "released_with_exceptions", message: `${tray.display_id} released with documented exceptions (not verified complete). ${outstanding.length} item(s) outstanding.` };
}

export function deliverTray(ctx: Ctx, trayIdOrDisplay: string): { trayId: string; delivered: number; outstanding: string[]; message: string } {
  const tray = mustTray(ctx.db, trayIdOrDisplay);
  if (tray.status === "delivered") return { trayId: tray.id, delivered: 0, outstanding: [], message: `${tray.display_id} was already delivered. Nothing changed.` };
  if (tray.status !== "verified_complete" && tray.status !== "released_with_exceptions") {
    throw new DomainError("BLOCKED", `${tray.display_id} must be verified complete or released with exceptions by a supervisor before delivery`);
  }
  const view = computeTrayView(ctx.db, tray.id);
  const canceledOnTray = view.expected.filter((e) => e.canceledOnTray);
  if (canceledOnTray.length) {
    throw new DomainError(
      "BLOCKED",
      `${tray.display_id} cannot be delivered: ${canceledOnTray.map((e) => `${e.label} (${e.canceledReason})`).join("; ")} ${canceledOnTray.length === 1 ? "is" : "are"} on the tray but no longer ordered work. Take ${canceledOnTray.length === 1 ? "it" : "them"} off the tray and record the removal first.`,
      { reasons: canceledOnTray.map((e) => e.label) },
    );
  }
  const scanned = view.expected.filter((e) => e.state === "scanned");
  for (const e of scanned) assertNotHeld(ctx.db, "tray_delivery", scopesForSlide(ctx.db, e.slideId), `Delivering ${e.label}`);
  const byAccession = new Map<string, number>();
  const wos = new Set<string>();
  const deliveredSlides: { slideId: string; label: string; from: string }[] = [];
  for (const e of scanned) {
    const s = getSlide(ctx.db, e.slideId)!;
    if (isCanceledSlide(s)) throw new DomainError("INVARIANT", `${slideText(s)} is not active ordered work and cannot be delivered`);
    if (s.physical_state !== "delivered") {
      updateVersioned(ctx.db, "slide", s.id, undefined, { physical_state: "delivered" });
      deliveredSlides.push({ slideId: s.id, label: slideText(s), from: s.physical_state });
      // One row per slide marked delivered, on the slide itself (shows in the case history).
      audit(ctx, {
        action: "slide.delivered",
        entityType: "slide",
        entityId: s.id,
        accessionId: s.accession_id,
        summary: `${slideText(s)}: ${s.physical_state.replace(/_/g, " ")} → delivered on ${tray.display_id} (${ctx.actor.name})`,
        before: { physical_state: s.physical_state },
        after: { physical_state: "delivered", trayId: tray.id, trayDisplayId: tray.display_id, pathologistId: tray.pathologist_id },
      });
    }
    if (s.work_order_id) wos.add(s.work_order_id);
    byAccession.set(s.accession_id, (byAccession.get(s.accession_id) ?? 0) + 1);
  }
  for (const wo of wos) refreshWorkOrderProgress(ctx, wo);
  const deliveredTray = updateVersioned(ctx.db, "tray", tray.id, undefined, { status: "delivered" });
  const outstanding = view.expected.filter((e) => e.state === "missing" || e.state === "follows_separately").map((e) => e.label);
  for (const [accessionId, n] of byAccession) {
    const acc = ctx.db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(accessionId) as { accession_number: string };
    recordWorklistChange(ctx, {
      accessionId,
      pathologistId: pathologistOf(ctx.db, accessionId),
      type: "changed",
      summary: `${acc.accession_number}: ${n} slide(s) delivered on ${tray.display_id}`,
    });
  }
  audit(ctx, {
    action: "tray.delivered",
    entityType: "tray",
    entityId: tray.id,
    summary: `${tray.display_id} delivered to ${view.pathologistName}: ${scanned.length} slide(s)${outstanding.length ? `; still outstanding: ${outstanding.join(", ")}` : ""}`,
    before: { status: tray.status, version: tray.version },
    after: {
      status: "delivered",
      version: deliveredTray.version,
      pathologistId: tray.pathologist_id,
      deliveredSlideIds: scanned.map((e) => e.slideId),
      newlyDelivered: deliveredSlides.map((d) => ({ slideId: d.slideId, from: d.from })),
      outstandingSlideIds: view.expected.filter((e) => e.state === "missing" || e.state === "follows_separately").map((e) => e.slideId),
    },
  });
  return {
    trayId: tray.id,
    delivered: scanned.length,
    outstanding,
    message: `${tray.display_id} delivered to ${view.pathologistName}: ${scanned.length} slide(s).${outstanding.length ? ` Still outstanding (tasks open): ${outstanding.join(", ")}.` : ""}`,
  };
}
