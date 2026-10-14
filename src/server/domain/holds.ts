import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { requirePermission } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { updateVersioned } from "../core/versioning";

/**
 * Holds are scoped to the affected material. A hold on Part B blocks only the
 * listed transitions for Part B (and things derived from it), never the whole
 * bench or the rest of the case.
 */
export type HoldTransition =
  | "accession_request"
  | "routing_confirm"
  | "gross_approval"
  | "processing"
  | "sectioning"
  | "print"
  | "tray_delivery"
  | "all";

export type ScopeType = "intake_item" | "container" | "order_part" | "specimen_part" | "block" | "slide" | "work_order" | "accession";

export interface Scope {
  type: ScopeType;
  id: string;
}

export interface HoldRow {
  id: string;
  display_id: string;
  scope_type: ScopeType;
  scope_id: string;
  scope_label: string;
  blocks: string;
  reason_code: string;
  reason_text: string;
  clarification_id: string | null;
  status: "active" | "released";
  placed_by: string;
  placed_at: string;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  intake_item_id: string | null;
  accession_id: string | null;
  version: number;
}

export function blockedTransitions(h: HoldRow): HoldTransition[] {
  try {
    return JSON.parse(h.blocks) as HoldTransition[];
  } catch {
    return ["all"];
  }
}

export function activeHolds(db: DB, scopes: Scope[]): HoldRow[] {
  if (!scopes.length) return [];
  const where = scopes.map(() => "(scope_type = ? AND scope_id = ?)").join(" OR ");
  const params = scopes.flatMap((s) => [s.type, s.id]);
  return db.prepare(`SELECT * FROM hold WHERE status = 'active' AND (${where}) ORDER BY placed_at`).all(...params) as HoldRow[];
}

export function holdsBlocking(db: DB, transition: HoldTransition, scopes: Scope[]): HoldRow[] {
  return activeHolds(db, scopes).filter((h) => {
    const t = blockedTransitions(h);
    return t.includes("all") || t.includes(transition);
  });
}

/** Throws BLOCKED (with the holds as evidence) if any active hold blocks this transition. */
export function assertNotHeld(db: DB, transition: HoldTransition, scopes: Scope[], what: string): void {
  const blocking = holdsBlocking(db, transition, scopes);
  if (blocking.length) {
    throw new DomainError(
      "BLOCKED",
      `${what} is blocked by ${blocking.map((h) => `${h.display_id} (${h.scope_label}: ${h.reason_text})`).join("; ")}`,
      { holds: blocking.map((h) => ({ id: h.id, display_id: h.display_id, scope_label: h.scope_label, reason: h.reason_text, clarification_id: h.clarification_id })) },
    );
  }
}

// ---------------------------------------------------------------- scope chains

/** Everything whose hold should also apply to this specimen part. */
export function scopesForPart(db: DB, partId: string): Scope[] {
  const p = db.prepare("SELECT accession_id, source_order_part_id, container_id FROM specimen_part WHERE id = ?").get(partId) as
    | { accession_id: string; source_order_part_id: string; container_id: string | null }
    | undefined;
  if (!p) return [{ type: "specimen_part", id: partId }];
  const scopes: Scope[] = [
    { type: "specimen_part", id: partId },
    { type: "accession", id: p.accession_id },
    { type: "order_part", id: p.source_order_part_id },
  ];
  if (p.container_id) scopes.push({ type: "container", id: p.container_id });
  return scopes;
}

export function scopesForBlock(db: DB, blockId: string): Scope[] {
  const b = db.prepare("SELECT part_id FROM block WHERE id = ?").get(blockId) as { part_id: string } | undefined;
  return [{ type: "block", id: blockId }, ...(b ? scopesForPart(db, b.part_id) : [])];
}

export function scopesForSlide(db: DB, slideId: string): Scope[] {
  const s = db.prepare("SELECT block_id, work_order_id FROM slide WHERE id = ?").get(slideId) as { block_id: string; work_order_id: string | null } | undefined;
  if (!s) return [{ type: "slide", id: slideId }];
  const scopes: Scope[] = [{ type: "slide", id: slideId }, ...scopesForBlock(db, s.block_id)];
  if (s.work_order_id) scopes.push({ type: "work_order", id: s.work_order_id });
  return scopes;
}

/** Holds relevant to an intake item: the item, its containers, and the order parts linked to it. */
export function scopesForIntake(db: DB, intakeItemId: string): Scope[] {
  const scopes: Scope[] = [{ type: "intake_item", id: intakeItemId }];
  const containers = db.prepare("SELECT id, order_part_id FROM container WHERE intake_item_id = ?").all(intakeItemId) as { id: string; order_part_id: string | null }[];
  for (const c of containers) {
    scopes.push({ type: "container", id: c.id });
    if (c.order_part_id) scopes.push({ type: "order_part", id: c.order_part_id });
  }
  const parts = db
    .prepare(
      `SELECT sop.id FROM intake_order_link l JOIN source_order_part sop ON sop.source_order_id = l.source_order_id WHERE l.intake_item_id = ?`,
    )
    .all(intakeItemId) as { id: string }[];
  for (const p of parts) if (!scopes.some((s) => s.type === "order_part" && s.id === p.id)) scopes.push({ type: "order_part", id: p.id });
  return scopes;
}

// ---------------------------------------------------------------- place / release

export interface PlaceHoldInput {
  scope: Scope;
  scopeLabel: string;
  blocks: HoldTransition[];
  reasonCode: string;
  reasonText: string;
  clarificationId?: string | null;
  intakeItemId?: string | null;
  accessionId?: string | null;
}

/** Idempotent per (scope, reason, clarification): placing the same hold twice returns the existing one. */
export function placeHold(ctx: Ctx, input: PlaceHoldInput): HoldRow {
  requirePermission(ctx, "hold.place");
  const existing = ctx.db
    .prepare(
      "SELECT * FROM hold WHERE status = 'active' AND scope_type = ? AND scope_id = ? AND reason_code = ? AND COALESCE(clarification_id,'') = COALESCE(?, '')",
    )
    .get(input.scope.type, input.scope.id, input.reasonCode, input.clarificationId ?? null) as HoldRow | undefined;
  if (existing) return existing;
  const id = newId(ctx.db, "hold");
  const display = displayId(ctx.db, "H", 4);
  ctx.db
    .prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, clarification_id, status,
        placed_by, placed_at, intake_item_id, accession_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
    )
    .run(
      id, display, input.scope.type, input.scope.id, input.scopeLabel, JSON.stringify(input.blocks), input.reasonCode, input.reasonText,
      input.clarificationId ?? null, ctx.actor.id, ctx.now, input.intakeItemId ?? null, input.accessionId ?? null,
    );
  audit(ctx, {
    action: "hold.placed",
    entityType: "hold",
    entityId: id,
    accessionId: input.accessionId,
    intakeItemId: input.intakeItemId,
    summary: `${display} placed on ${input.scopeLabel}: ${input.reasonText} (blocks ${input.blocks.join(", ")})`,
  });
  if (input.accessionId) {
    const path = ctx.db.prepare("SELECT assigned_pathologist_id p FROM accession WHERE id = ?").get(input.accessionId) as { p: string } | undefined;
    recordWorklistChange(ctx, { accessionId: input.accessionId, pathologistId: path?.p, type: "changed", summary: `Hold ${display} on ${input.scopeLabel}` });
  }
  return ctx.db.prepare("SELECT * FROM hold WHERE id = ?").get(id) as HoldRow;
}

export function releaseHold(ctx: Ctx, holdId: string, reason: string, expectedVersion?: number): HoldRow {
  requirePermission(ctx, "hold.release");
  const h = ctx.db.prepare("SELECT * FROM hold WHERE id = ?").get(holdId) as HoldRow | undefined;
  if (!h) throw new DomainError("NOT_FOUND", "Hold not found");
  if (h.status === "released") return h;
  if (!reason.trim()) throw new DomainError("VALIDATION", "A release reason is required");
  const updated = updateVersioned(ctx.db, "hold", holdId, expectedVersion, {
    status: "released",
    released_by: ctx.actor.id,
    released_at: ctx.now,
    release_reason: reason,
  }) as unknown as HoldRow;
  audit(ctx, {
    action: "hold.released",
    entityType: "hold",
    entityId: holdId,
    accessionId: h.accession_id,
    intakeItemId: h.intake_item_id,
    summary: `${h.display_id} released on ${h.scope_label}`,
    reason,
  });
  if (h.accession_id) {
    const path = ctx.db.prepare("SELECT assigned_pathologist_id p FROM accession WHERE id = ?").get(h.accession_id) as { p: string } | undefined;
    recordWorklistChange(ctx, { accessionId: h.accession_id, pathologistId: path?.p, type: "changed", summary: `Hold ${h.display_id} released (${h.scope_label})` });
  }
  return updated;
}
