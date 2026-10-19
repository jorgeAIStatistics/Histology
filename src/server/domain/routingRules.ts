import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { newId } from "../core/ids";
import { audit } from "../core/audit";
import { fmtDateTime } from "@/lib/time";

/**
 * Versioned office → assigned dermatopathologist rules (S6).
 *
 * - An approved (or retired) rule set is frozen by database triggers; any change
 *   is a NEW draft version that copies the current approved rules.
 * - A draft needs a reason; approval needs a permitted role (medical director or
 *   supervisor) and takes effect at `effective_from` (default: now on the demo clock).
 * - Approving does not re-route work already received.
 * - An office with no rule is a routing exception, never a guessed doctor.
 */

export interface RuleSetRow {
  id: string;
  version: number;
  status: "draft" | "approved" | "retired";
  effective_from: string;
  effective_to: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
}

export interface RuleChange {
  officeId: string;
  /** null removes the rule → new items from that office go to the routing exception lane. */
  pathologistId: string | null;
}

export function currentApprovedRuleSet(db: DB, atIso: string): RuleSetRow | undefined {
  return db
    .prepare(
      `SELECT * FROM routing_rule_set WHERE status = 'approved' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
        ORDER BY version DESC LIMIT 1`,
    )
    .get(atIso, atIso) as RuleSetRow | undefined;
}

export function latestApprovedRuleSet(db: DB): RuleSetRow | undefined {
  return db.prepare("SELECT * FROM routing_rule_set WHERE status = 'approved' ORDER BY version DESC LIMIT 1").get() as RuleSetRow | undefined;
}

export function openDraft(db: DB): RuleSetRow | undefined {
  return db.prepare("SELECT * FROM routing_rule_set WHERE status = 'draft' ORDER BY version DESC LIMIT 1").get() as RuleSetRow | undefined;
}

function assertPathologist(db: DB, id: string): { id: string; display_name: string } {
  const row = db.prepare("SELECT id, display_name FROM staff WHERE id = ? AND role = 'pathologist' AND active = 1").get(id) as
    | { id: string; display_name: string }
    | undefined;
  if (!row) throw new DomainError("VALIDATION", `"${id}" is not an active dermatopathologist`);
  return row;
}

function officeName(db: DB, id: string): string {
  const row = db.prepare("SELECT name FROM office WHERE id = ?").get(id) as { name: string } | undefined;
  if (!row) throw new DomainError("VALIDATION", `Office "${id}" is not in the office directory`);
  return row.name;
}

/** Create a new draft version copying the newest approved rules (in force or future-dated), with the requested changes applied. */
export function draftRuleSet(ctx: Ctx, input: { reason: string; changes: RuleChange[] }): { ruleSetId: string; version: number; changes: string[] } {
  const db = ctx.db;
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required to draft a new routing rule version");
  const existingDraft = openDraft(db);
  if (existingDraft) {
    throw new DomainError(
      "CONFLICT",
      `Draft v${existingDraft.version} is already waiting for approval. Approve or discard it before drafting another version.`,
      { ruleSetId: existingDraft.id, version: existingDraft.version },
    );
  }
  // Base = the newest approved version, even if it is future-dated. Copying only the version in force
  // today would silently drop an approved future change when this draft later replaces it.
  const base = latestApprovedRuleSet(db) ?? currentApprovedRuleSet(db, ctx.now);
  const baseRules = base
    ? (db.prepare("SELECT office_id, pathologist_id FROM routing_rule WHERE rule_set_id = ?").all(base.id) as { office_id: string; pathologist_id: string }[])
    : [];
  const map = new Map(baseRules.map((r) => [r.office_id, r.pathologist_id]));
  const described: string[] = [];
  const seen = new Set<string>();
  for (const c of input.changes) {
    if (seen.has(c.officeId)) throw new DomainError("VALIDATION", `Office ${c.officeId} appears twice in the change list`);
    seen.add(c.officeId);
    const office = officeName(db, c.officeId);
    const before = map.get(c.officeId) ?? null;
    if (c.pathologistId) {
      const p = assertPathologist(db, c.pathologistId);
      if (before === p.id) continue;
      map.set(c.officeId, p.id);
      described.push(`${office} → ${p.display_name}${before ? "" : " (new rule)"}`);
    } else {
      if (!before) continue;
      map.delete(c.officeId);
      described.push(`${office}: rule removed (new items go to the routing exception lane)`);
    }
  }
  if (!described.length) throw new DomainError("VALIDATION", "The draft would be identical to the current approved rules. Change at least one office.");

  const version = ((db.prepare("SELECT COALESCE(MAX(version), 0) v FROM routing_rule_set").get() as { v: number }).v ?? 0) + 1;
  const id = newId(db, "rrs");
  db.prepare(
    `INSERT INTO routing_rule_set (id, version, status, effective_from, effective_to, approved_by, approved_at, notes)
     VALUES (?, ?, 'draft', ?, NULL, NULL, NULL, ?)`,
  ).run(id, version, ctx.now, `Drafted by ${ctx.actor.name} from v${base?.version ?? "none"}: ${reason}`);
  const ins = db.prepare("INSERT INTO routing_rule (id, rule_set_id, office_id, pathologist_id) VALUES (?, ?, ?, ?)");
  for (const [officeId, pathologistId] of [...map.entries()].sort()) ins.run(newId(db, "rr"), id, officeId, pathologistId);

  audit(ctx, {
    action: "routing.rule_set_drafted",
    entityType: "routing_rule_set",
    entityId: id,
    summary: `Routing rules v${version} drafted from v${base?.version ?? "none"}: ${described.join("; ")}. Needs approval before use.`,
    reason,
    after: { version, changes: described },
  });
  return { ruleSetId: id, version, changes: described };
}

/** Approve a draft. Retires the previous approved set by closing its effective period. */
export function approveRuleSet(ctx: Ctx, input: { ruleSetId: string; effectiveFrom?: string }): { ruleSetId: string; version: number; effectiveFrom: string; retired: number[] } {
  const db = ctx.db;
  const set = db.prepare("SELECT * FROM routing_rule_set WHERE id = ?").get(input.ruleSetId) as RuleSetRow | undefined;
  if (!set) throw new DomainError("NOT_FOUND", "Routing rule set not found");
  if (set.status !== "draft") throw new DomainError("INVARIANT", `Rule set v${set.version} is ${set.status}; only a draft can be approved`);
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom).toISOString() : ctx.now;
  if (Date.parse(effectiveFrom) < Date.parse(ctx.now) - 60_000) {
    throw new DomainError("VALIDATION", "A rule set cannot take effect in the past: work already received is never re-routed retroactively");
  }
  const rules = (db.prepare("SELECT COUNT(*) n FROM routing_rule WHERE rule_set_id = ?").get(set.id) as { n: number }).n;
  if (!rules) throw new DomainError("VALIDATION", "A rule set with no rules cannot be approved");

  const previous = db
    .prepare("SELECT * FROM routing_rule_set WHERE status = 'approved' AND (effective_to IS NULL OR effective_to > ?) ORDER BY version")
    .all(effectiveFrom) as RuleSetRow[];
  const retired: number[] = [];
  for (const prev of previous) {
    if (Date.parse(prev.effective_from) >= Date.parse(effectiveFrom)) {
      throw new DomainError("INVARIANT", `Approved v${prev.version} starts ${fmtDateTime(prev.effective_from)}; a new version must start after it`);
    }
    // Takes effect now → retire immediately; future-dated → the old set stays approved until then (closed by the period end).
    const retireNow = Date.parse(effectiveFrom) <= Date.parse(ctx.now) + 60_000;
    db.prepare("UPDATE routing_rule_set SET effective_to = ?, status = ? WHERE id = ?").run(effectiveFrom, retireNow ? "retired" : "approved", prev.id);
    retired.push(prev.version);
    audit(ctx, {
      action: "routing.rule_set_retired",
      entityType: "routing_rule_set",
      entityId: prev.id,
      summary: `Routing rules v${prev.version} ${retireNow ? "retired" : "end"} at ${fmtDateTime(effectiveFrom)} ET (replaced by v${set.version})`,
    });
  }
  db.prepare("UPDATE routing_rule_set SET status = 'approved', effective_from = ?, approved_by = ?, approved_at = ? WHERE id = ?").run(
    effectiveFrom,
    ctx.actor.id,
    ctx.now,
    set.id,
  );
  const ruleRows = db.prepare("SELECT id, office_id, pathologist_id FROM routing_rule WHERE rule_set_id = ? ORDER BY office_id").all(set.id) as {
    id: string;
    office_id: string;
    pathologist_id: string;
  }[];
  audit(ctx, {
    action: "routing.rule_set_approved",
    entityType: "routing_rule_set",
    entityId: set.id,
    summary: `Routing rules v${set.version} approved by ${ctx.actor.name}, effective ${fmtDateTime(effectiveFrom)} ET. Rules are now frozen. Items already received are not re-routed.`,
    before: { status: set.status, effectiveFrom: set.effective_from, approvedBy: set.approved_by },
    after: {
      status: "approved",
      version: set.version,
      effectiveFrom,
      approvedBy: ctx.actor.id,
      approvedAt: ctx.now,
      retiredVersions: retired,
      supersededRuleSetIds: previous.map((p) => p.id),
      rules: ruleRows.map((r) => ({ ruleId: r.id, officeId: r.office_id, pathologistId: r.pathologist_id })),
    },
  });
  return { ruleSetId: set.id, version: set.version, effectiveFrom, retired };
}

/** Discard a draft that should never be used. It is kept (as retired, never approved) for the record. */
export function discardDraft(ctx: Ctx, input: { ruleSetId: string; reason: string }): { ruleSetId: string; version: number } {
  const db = ctx.db;
  const set = db.prepare("SELECT * FROM routing_rule_set WHERE id = ?").get(input.ruleSetId) as RuleSetRow | undefined;
  if (!set) throw new DomainError("NOT_FOUND", "Routing rule set not found");
  if (set.status !== "draft") throw new DomainError("INVARIANT", `Rule set v${set.version} is ${set.status}; only a draft can be discarded`);
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required to discard a draft");
  db.prepare("UPDATE routing_rule_set SET status = 'retired', effective_to = effective_from, notes = ? WHERE id = ?").run(
    `${set.notes ?? ""} · Discarded (never approved) by ${ctx.actor.name}: ${reason}`.replace(/^ · /, ""),
    set.id,
  );
  audit(ctx, {
    action: "routing.rule_set_discarded",
    entityType: "routing_rule_set",
    entityId: set.id,
    summary: `Draft routing rules v${set.version} discarded (never approved)`,
    reason,
  });
  return { ruleSetId: set.id, version: set.version };
}

export function addCoverage(
  ctx: Ctx,
  input: { pathologistId: string; coveringPathologistId: string; startsAt: string; endsAt: string; reason: string },
): { coverageId: string } {
  const db = ctx.db;
  const absent = assertPathologist(db, input.pathologistId);
  const cover = assertPathologist(db, input.coveringPathologistId);
  if (absent.id === cover.id) throw new DomainError("VALIDATION", "A dermatopathologist cannot cover their own absence");
  const starts = new Date(input.startsAt).toISOString();
  const ends = new Date(input.endsAt).toISOString();
  if (Date.parse(ends) <= Date.parse(starts)) throw new DomainError("VALIDATION", "Coverage must end after it starts");
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required for a coverage exception");
  const overlap = db
    .prepare(
      `SELECT id FROM coverage_exception WHERE pathologist_id = ? AND status = 'approved' AND starts_at < ? AND ends_at > ?`,
    )
    .get(absent.id, ends, starts) as { id: string } | undefined;
  if (overlap) throw new DomainError("CONFLICT", `${absent.display_name} already has an approved coverage exception overlapping this period`);
  const id = newId(db, "cov");
  db.prepare(
    `INSERT INTO coverage_exception (id, pathologist_id, covering_pathologist_id, starts_at, ends_at, reason, status, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`,
  ).run(id, absent.id, cover.id, starts, ends, reason, ctx.actor.id);
  audit(ctx, {
    action: "routing.coverage_added",
    entityType: "coverage_exception",
    entityId: id,
    summary: `Coverage: ${cover.display_name} covers ${absent.display_name} ${fmtDateTime(starts)} – ${fmtDateTime(ends)} ET`,
    reason,
  });
  return { coverageId: id };
}

export function retireCoverage(ctx: Ctx, input: { coverageId: string; reason: string }): { coverageId: string } {
  const db = ctx.db;
  const row = db.prepare("SELECT * FROM coverage_exception WHERE id = ?").get(input.coverageId) as { id: string; status: string } | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "Coverage exception not found");
  if (row.status !== "approved") return { coverageId: row.id };
  const reason = input.reason.trim();
  if (!reason) throw new DomainError("VALIDATION", "A reason is required to retire a coverage exception");
  db.prepare("UPDATE coverage_exception SET status = 'retired' WHERE id = ?").run(row.id);
  audit(ctx, { action: "routing.coverage_retired", entityType: "coverage_exception", entityId: row.id, summary: "Coverage exception retired", reason });
  return { coverageId: row.id };
}

/** Close the period of approved sets whose end has passed (future-dated approvals). Cheap; called by the pump. */
export function retireExpiredRuleSets(ctx: Ctx): number {
  const rows = ctx.db
    .prepare("SELECT id, version FROM routing_rule_set WHERE status = 'approved' AND effective_to IS NOT NULL AND effective_to <= ?")
    .all(ctx.now) as { id: string; version: number }[];
  for (const r of rows) {
    ctx.db.prepare("UPDATE routing_rule_set SET status = 'retired' WHERE id = ?").run(r.id);
    audit(ctx, { action: "routing.rule_set_retired", entityType: "routing_rule_set", entityId: r.id, summary: `Routing rules v${r.version} retired (effective period ended)` });
  }
  return rows.length;
}
