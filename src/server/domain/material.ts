import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { closeTasks } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { getSetting } from "../core/settings";
import { assertNotHeld, scopesForBlock, scopesForSlide } from "./holds";
import { BLOCK_STATE, BLOCK_STATE_ORDER, SLIDE_STATE, SLIDE_STATE_ORDER, type BlockState, type SlideState } from "@/lib/domain";

/**
 * Shared helpers for the materials slice (blocks, slides, labels, trays,
 * retrieval). Physical progress is recorded here; it never implies
 * documentation or source-system progress.
 */

// ---------------------------------------------------------------- additive schema (runtime safety net)

/**
 * The columns added by schema.materials.sql. A local database file created
 * before that file existed will not have them until the next demo reset, so
 * they are also added here (idempotent, additive only).
 */
const MATERIAL_COLUMNS: [table: string, column: string, ddl: string][] = [
  ["label", "replaces_label_id", "TEXT"],
  ["slide", "review_disposition", "TEXT"],
  ["slide", "review_note", "TEXT"],
  ["slide", "reviewed_by", "TEXT"],
  ["slide", "reviewed_at", "TEXT"],
  ["work_order", "review_decision", "TEXT"],
  ["work_order", "review_note", "TEXT"],
  ["work_order", "reviewed_by", "TEXT"],
  ["work_order", "reviewed_at", "TEXT"],
  ["tray_scan", "detail", "TEXT"],
  ["retrieval_item", "mismatch_count", "INTEGER NOT NULL DEFAULT 0"],
  ["retrieval_item", "delivered_at", "TEXT"],
  ["retrieval_item", "returned_at", "TEXT"],
];
const ensured = new WeakSet<DB>();

/**
 * Idempotent and additive. A database is only remembered as "done" once every
 * column is already present when checked, so columns added inside a command
 * transaction that later rolled back are simply added again on the next call.
 */
export function ensureMaterialsSchema(db: DB): void {
  if (ensured.has(db)) return;
  const cache = new Map<string, Set<string>>();
  let missing = 0;
  for (const [table, column, ddl] of MATERIAL_COLUMNS) {
    let cols = cache.get(table);
    if (!cols) {
      cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      cache.set(table, cols);
    }
    if (!cols.has(column)) {
      missing += 1;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      cols.add(column);
    }
  }
  if (missing === 0) ensured.add(db);
}

// ---------------------------------------------------------------- lookups

export interface SlideInfo {
  id: string;
  accession_id: string;
  accession_number: string;
  namespace: string;
  pathologist_id: string | null;
  block_id: string;
  block_label: string;
  block_state: BlockState;
  part_id: string;
  part_designation: string;
  slide_seq: number;
  stain: string;
  level_label: string | null;
  work_order_id: string | null;
  wo_status: string | null;
  wo_display: string | null;
  identifier: string;
  physical_state: SlideState;
  label_state: string;
  status: string;
  version: number;
}

const SLIDE_SQL = `SELECT s.id, s.accession_id, a.accession_number, a.namespace, a.assigned_pathologist_id AS pathologist_id, s.block_id,
    b.label_text AS block_label, b.physical_state AS block_state, b.part_id, sp.designation AS part_designation, s.slide_seq, s.stain,
    s.level_label, s.work_order_id, wo.status AS wo_status, wo.display_id AS wo_display, s.identifier, s.physical_state, s.label_state,
    s.status, s.version
  FROM slide s JOIN block b ON b.id = s.block_id JOIN specimen_part sp ON sp.id = b.part_id JOIN accession a ON a.id = s.accession_id
  LEFT JOIN work_order wo ON wo.id = s.work_order_id`;

export function getSlide(db: DB, slideId: string): SlideInfo | undefined {
  return db.prepare(`${SLIDE_SQL} WHERE s.id = ?`).get(slideId) as SlideInfo | undefined;
}

export function getSlideByIdentifier(db: DB, identifier: string): SlideInfo | undefined {
  return db.prepare(`${SLIDE_SQL} WHERE s.identifier = ?`).get(identifier.trim().toUpperCase()) as SlideInfo | undefined;
}

export function mustSlide(db: DB, slideId: string): SlideInfo {
  const s = getSlide(db, slideId);
  if (!s) throw new DomainError("NOT_FOUND", `Slide ${slideId} was not found`);
  return s;
}

/** "D26-04817 A1-2 PAS" (with the level when present, e.g. "D26-04817 A1-3 H&E deeper L1"). */
export function slideText(s: Pick<SlideInfo, "accession_number" | "block_label" | "slide_seq" | "stain" | "level_label">): string {
  return `${s.accession_number} ${s.block_label}-${s.slide_seq} ${s.stain}${s.level_label ? ` ${s.level_label}` : ""}`;
}

export interface BlockInfo {
  id: string;
  accession_id: string;
  accession_number: string;
  namespace: string;
  pathologist_id: string | null;
  part_id: string;
  part_designation: string;
  block_seq: number;
  label_text: string;
  identifier: string;
  physical_state: BlockState;
  current_location_id: string | null;
  location_code: string | null;
  location_kind: string | null;
  location_label: string | null;
  location_confirmed_at: string | null;
  location_confirmed_by: string | null;
  location_confirmed_by_name: string | null;
  custody_state: string;
  checkout_holder_id: string | null;
  checkout_holder_name: string | null;
  status: string;
  version: number;
}

const BLOCK_SQL = `SELECT b.id, b.accession_id, a.accession_number, a.namespace, a.assigned_pathologist_id AS pathologist_id, b.part_id,
    sp.designation AS part_designation, b.block_seq, b.label_text, b.identifier, b.physical_state, b.current_location_id,
    l.code AS location_code, l.kind AS location_kind, l.label AS location_label, b.location_confirmed_at, b.location_confirmed_by,
    cb.display_name AS location_confirmed_by_name, b.custody_state, b.checkout_holder_id, h.display_name AS checkout_holder_name, b.status, b.version
  FROM block b JOIN specimen_part sp ON sp.id = b.part_id JOIN accession a ON a.id = b.accession_id
  LEFT JOIN storage_location l ON l.id = b.current_location_id
  LEFT JOIN staff cb ON cb.id = b.location_confirmed_by
  LEFT JOIN staff h ON h.id = b.checkout_holder_id`;

export function getBlock(db: DB, blockId: string): BlockInfo | undefined {
  return db.prepare(`${BLOCK_SQL} WHERE b.id = ?`).get(blockId) as BlockInfo | undefined;
}

export function getBlockByIdentifier(db: DB, identifier: string): BlockInfo | undefined {
  return db.prepare(`${BLOCK_SQL} WHERE b.identifier = ?`).get(identifier.trim().toUpperCase()) as BlockInfo | undefined;
}

export function mustBlock(db: DB, blockId: string): BlockInfo {
  const b = getBlock(db, blockId);
  if (!b) throw new DomainError("NOT_FOUND", `Block ${blockId} was not found`);
  return b;
}

/** "D26-03990 A1" */
export function blockText(b: Pick<BlockInfo, "accession_number" | "label_text">): string {
  return `${b.accession_number} ${b.label_text}`;
}

export function staffName(db: DB, id: string | null | undefined): string | null {
  if (!id) return null;
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

export function pathologistOf(db: DB, accessionId: string): string | null {
  const r = db.prepare("SELECT assigned_pathologist_id p FROM accession WHERE id = ?").get(accessionId) as { p: string | null } | undefined;
  return r?.p ?? null;
}

/** First active supervisor (escalation owner). */
export function supervisorId(db: DB): string | null {
  const r = db.prepare("SELECT id FROM staff WHERE role = 'supervisor' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function requireText(value: string | null | undefined, message: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new DomainError("VALIDATION", message);
  return v;
}

// ---------------------------------------------------------------- label state on the slide row

const LABEL_RANK: Record<string, number> = { printed: 1, applied: 2, verified: 3 };

/**
 * slide.label_state is a cached summary of the physical label rows:
 * the most advanced non-retired label, else "retired" if one was retired,
 * else "none". It never claims more than the label rows show.
 */
export function refreshSlideLabelState(db: DB, slideId: string): string {
  const rows = db.prepare("SELECT state FROM label WHERE target_type = 'slide' AND target_id = ?").all(slideId) as { state: string }[];
  let best = "none";
  let bestRank = 0;
  for (const r of rows) {
    const rank = LABEL_RANK[r.state] ?? 0;
    if (rank > bestRank) {
      best = r.state;
      bestRank = rank;
    }
  }
  if (bestRank === 0 && rows.some((r) => r.state === "retired")) best = "retired";
  const current = db.prepare("SELECT label_state FROM slide WHERE id = ?").get(slideId) as { label_state: string } | undefined;
  if (current && current.label_state !== best) {
    db.prepare("UPDATE slide SET label_state = ?, version = version + 1 WHERE id = ?").run(best, slideId);
  }
  return best;
}

// ---------------------------------------------------------------- work-order progress (derived from its slides)

const ACTIVE_WO = new Set(["requested", "in_progress", "completed"]);

/** requested → in_progress (first slide sectioned) → completed (every active slide QC reviewed or delivered). */
export function refreshWorkOrderProgress(ctx: Ctx, workOrderId: string | null): void {
  if (!workOrderId) return;
  const wo = ctx.db.prepare("SELECT id, display_id, status, quantity, accession_id FROM work_order WHERE id = ?").get(workOrderId) as
    | { id: string; display_id: string; status: string; quantity: number; accession_id: string }
    | undefined;
  if (!wo || !ACTIVE_WO.has(wo.status)) return;
  const slides = ctx.db.prepare("SELECT physical_state FROM slide WHERE work_order_id = ? AND status = 'active'").all(workOrderId) as { physical_state: SlideState }[];
  let next = wo.status;
  const started = slides.some((s) => s.physical_state !== "planned");
  const done = slides.length >= Math.max(1, wo.quantity) && slides.every((s) => s.physical_state === "qc_reviewed" || s.physical_state === "delivered");
  if (done) next = "completed";
  else if (started) next = "in_progress";
  if (next !== wo.status) {
    updateVersioned(ctx.db, "work_order", wo.id, undefined, { status: next });
    audit(ctx, {
      action: "work_order.progress",
      entityType: "work_order",
      entityId: wo.id,
      accessionId: wo.accession_id,
      summary: `${wo.display_id} is now ${next === "completed" ? "completed (every slide QC reviewed)" : "in progress (first slide sectioned)"}`,
    });
  }
}

// ---------------------------------------------------------------- bench progress (demo)

function blockIndex(s: BlockState): number {
  return BLOCK_STATE_ORDER.indexOf(s);
}
function slideIndex(s: SlideState): number {
  return SLIDE_STATE_ORDER.indexOf(s);
}

/** Advance blocks forward. Re-checks holds and gross approval on the server for each block. */
export function advanceBlocks(ctx: Ctx, blockIds: string[], toState: BlockState): { advanced: { blockId: string; label: string; from: string; to: string }[] } {
  const target = blockIndex(toState);
  if (target < 0) throw new DomainError("VALIDATION", `Unknown block state "${toState}"`);
  const requireApproved = getSetting(ctx.db, "processing_requires_approved_gross") !== "0";
  const out: { blockId: string; label: string; from: string; to: string }[] = [];
  const touched = new Map<string, string[]>();
  for (const id of [...new Set(blockIds)]) {
    const b = mustBlock(ctx.db, id);
    const label = blockText(b);
    if (b.status !== "active") throw new DomainError("INVARIANT", `${label} is void and cannot advance`);
    const from = blockIndex(b.physical_state);
    if (from >= target) {
      throw new DomainError("VALIDATION", `${label} is already ${BLOCK_STATE[b.physical_state]}; blocks only move forward here`);
    }
    if (b.custody_state === "sent_out" || b.custody_state === "missing_investigation") {
      throw new DomainError("BLOCKED", `${label} is not in the lab workflow (${b.custody_state === "sent_out" ? "sent outside the lab" : "missing — investigation open"})`);
    }
    const crosses = (s: BlockState) => from < blockIndex(s) && target >= blockIndex(s);
    if (crosses("processing")) {
      assertNotHeld(ctx.db, "processing", scopesForBlock(ctx.db, id), `Processing ${label}`);
      if (requireApproved) {
        const approved = ctx.db
          .prepare("SELECT 1 FROM gross_record WHERE specimen_part_id = ? AND state = 'approved_for_downstream'")
          .get(b.part_id);
        if (!approved) {
          throw new DomainError(
            "BLOCKED",
            `${label} cannot start processing: the gross record for part ${b.part_designation} is not approved for downstream use (local policy setting)`,
          );
        }
      }
    }
    if (crosses("sectioned")) assertNotHeld(ctx.db, "sectioning", scopesForBlock(ctx.db, id), `Sectioning ${label}`);
    updateVersioned(ctx.db, "block", id, undefined, { physical_state: toState });
    audit(ctx, {
      action: "block.advanced",
      entityType: "block",
      entityId: id,
      accessionId: b.accession_id,
      summary: `${label}: ${BLOCK_STATE[b.physical_state]} → ${BLOCK_STATE[toState]} (bench progress recorded by ${ctx.actor.name})`,
      before: { physical_state: b.physical_state },
      after: { physical_state: toState },
    });
    if (crosses("processing")) {
      ctx.db
        .prepare(
          `UPDATE task SET status = 'done', completed_at = ?, completed_by = ?, version = version + 1
            WHERE kind = 'processing_eligible' AND entity_id = ? AND status IN ('open','in_progress')`,
        )
        .run(ctx.now, ctx.actor.id, id);
      const remaining = ctx.db
        .prepare("SELECT COUNT(*) n FROM block WHERE part_id = ? AND status = 'active' AND physical_state = 'cassette_loaded'")
        .get(b.part_id) as { n: number };
      if (remaining.n === 0) {
        ctx.db
          .prepare(
            `UPDATE task SET status = 'done', completed_at = ?, completed_by = ?, version = version + 1
              WHERE kind = 'processing_eligible' AND entity_id = ? AND status IN ('open','in_progress')`,
          )
          .run(ctx.now, ctx.actor.id, b.part_id);
      }
    }
    out.push({ blockId: id, label, from: b.physical_state, to: toState });
    const list = touched.get(b.accession_id) ?? [];
    list.push(b.label_text);
    touched.set(b.accession_id, list);
  }
  for (const [accessionId, labels] of touched) {
    const acc = ctx.db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(accessionId) as { accession_number: string };
    recordWorklistChange(ctx, {
      accessionId,
      pathologistId: pathologistOf(ctx.db, accessionId),
      type: "changed",
      summary: `${acc.accession_number} ${labels.join(", ")} → ${BLOCK_STATE[toState]}`,
    });
  }
  return { advanced: out };
}

const TRAY_ONLY: SlideState = "delivered";

/** Advance slides forward (up to QC reviewed). Delivery happens only through a tray. */
export function advanceSlides(ctx: Ctx, slideIds: string[], toState: SlideState): { advanced: { slideId: string; label: string; from: string; to: string }[] } {
  if (toState === TRAY_ONLY) {
    throw new DomainError("VALIDATION", "Slides are delivered through a tray (scan each slide, then deliver the tray). They cannot be marked delivered here.");
  }
  const target = slideIndex(toState);
  if (target < 0) throw new DomainError("VALIDATION", `Unknown slide state "${toState}"`);
  const out: { slideId: string; label: string; from: string; to: string }[] = [];
  const touched = new Map<string, string[]>();
  const wos = new Set<string>();
  for (const id of [...new Set(slideIds)]) {
    const s = mustSlide(ctx.db, id);
    const label = slideText(s);
    if (s.status !== "active") {
      throw new DomainError("BLOCKED", `${label} is ${s.status === "canceled_needs_review" ? "awaiting review of a source change" : "void"} and cannot advance`);
    }
    if (s.wo_status && !ACTIVE_WO.has(s.wo_status)) {
      throw new DomainError("BLOCKED", `${label} belongs to ${s.wo_display}, which is ${s.wo_status.replace(/_/g, " ")}; review the work order first`);
    }
    const from = slideIndex(s.physical_state);
    if (from >= target) throw new DomainError("VALIDATION", `${label} is already ${SLIDE_STATE[s.physical_state]}; slides only move forward here`);
    if (from < slideIndex("sectioned") && target >= slideIndex("sectioned")) {
      if (s.block_state === "stored") {
        // An archived block can be cut again (deeper levels, recuts) once it is out of storage and on the bench.
        const blk = ctx.db.prepare("SELECT custody_state, checkout_holder_id FROM block WHERE id = ?").get(s.block_id) as { custody_state: string; checkout_holder_id: string | null };
        if (blk.custody_state === "stored") {
          throw new DomainError("BLOCKED", `${label} cannot be sectioned: block ${s.accession_number} ${s.block_label} is filed in storage. Request it (Retrieval) and scan it out first.`);
        }
        if (blk.custody_state === "sent_out" || blk.custody_state === "missing_investigation") {
          throw new DomainError("BLOCKED", `${label} cannot be sectioned: block ${s.accession_number} ${s.block_label} is ${blk.custody_state === "sent_out" ? "recorded as sent outside the lab" : "missing (investigation open)"}`);
        }
      } else if (s.block_state !== "embedded" && s.block_state !== "sectioned") {
        throw new DomainError("BLOCKED", `${label} cannot be sectioned: block ${s.block_label} is ${BLOCK_STATE[s.block_state]}, not embedded`);
      }
      assertNotHeld(ctx.db, "sectioning", scopesForSlide(ctx.db, id), `Sectioning ${label}`);
      if (s.block_state === "embedded") {
        updateVersioned(ctx.db, "block", s.block_id, undefined, { physical_state: "sectioned" });
        audit(ctx, {
          action: "block.advanced",
          entityType: "block",
          entityId: s.block_id,
          accessionId: s.accession_id,
          summary: `${s.accession_number} ${s.block_label}: first section cut (block now sectioned)`,
        });
      }
    }
    updateVersioned(ctx.db, "slide", id, undefined, { physical_state: toState });
    audit(ctx, {
      action: "slide.advanced",
      entityType: "slide",
      entityId: id,
      accessionId: s.accession_id,
      summary: `${label}: ${SLIDE_STATE[s.physical_state]} → ${SLIDE_STATE[toState]} (bench progress recorded by ${ctx.actor.name})`,
      before: { physical_state: s.physical_state },
      after: { physical_state: toState },
    });
    if (s.work_order_id) wos.add(s.work_order_id);
    out.push({ slideId: id, label, from: s.physical_state, to: toState });
    const list = touched.get(s.accession_id) ?? [];
    list.push(`${s.block_label}-${s.slide_seq}`);
    touched.set(s.accession_id, list);
  }
  for (const wo of wos) refreshWorkOrderProgress(ctx, wo);
  for (const [accessionId, labels] of touched) {
    const acc = ctx.db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(accessionId) as { accession_number: string };
    recordWorklistChange(ctx, {
      accessionId,
      pathologistId: pathologistOf(ctx.db, accessionId),
      type: "changed",
      summary: `${acc.accession_number} slides ${labels.join(", ")} → ${SLIDE_STATE[toState]}`,
    });
  }
  return { advanced: out };
}

/** Close an open task by kind for any entity type (used when the entity type was chosen by another slice). */
export function closeTasksForEntity(ctx: Ctx, kind: string, entityId: string, status: "done" | "canceled" = "done"): number {
  return ctx.db
    .prepare(
      `UPDATE task SET status = ?, completed_at = ?, completed_by = ?, version = version + 1
        WHERE kind = ? AND entity_id = ? AND status IN ('open','in_progress')`,
    )
    .run(status, ctx.now, ctx.actor.id, kind, entityId).changes;
}

export { closeTasks };
