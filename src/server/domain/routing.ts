import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { newId } from "../core/ids";
import { audit } from "../core/audit";
import { openTask, closeTasks } from "../core/tasks";
import { assertNotHeld, scopesForIntake } from "./holds";
import { fmtDate } from "@/lib/time";

/**
 * Office → assigned dermatopathologist routing.
 *
 * - Suggestions come ONLY from an approved (or since-retired) rule set whose
 *   effective window contains the receipt time (INV-18). The decision row
 *   records the rule set, the rule and a plain explanation naming the version.
 * - A coverage exception (approved leave) substitutes the covering
 *   pathologist and says so.
 * - Unknown office, a new office that has not been reviewed, or no rule for
 *   the office → status 'exception' with NO pathologist. There is no default
 *   doctor.
 * - Override / exception resolution need a lead or supervisor and a reason
 *   (INV-19). The previous decision is kept (status 'superseded').
 */

export interface RoutingDecisionRow {
  id: string;
  intake_item_id: string;
  status: "suggested" | "confirmed" | "overridden" | "exception" | "superseded";
  suggested_pathologist_id: string | null;
  final_pathologist_id: string | null;
  rule_set_id: string | null;
  rule_id: string | null;
  coverage_exception_id: string | null;
  explanation: string;
  override_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface RoutingSuggestion {
  status: "suggested" | "exception";
  pathologistId: string | null;
  ruleSetId: string | null;
  ruleSetVersion: number | null;
  ruleId: string | null;
  coverageExceptionId: string | null;
  explanation: string;
  exceptionReason: string | null;
}

interface RuleSetRow {
  id: string;
  version: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
}

/** The approved rule set in force at `at` (highest version wins if windows overlap). Drafts never apply. */
export function ruleSetEffectiveAt(db: DB, at: string): RuleSetRow | null {
  const rows = db
    .prepare(
      `SELECT id, version, status, effective_from, effective_to FROM routing_rule_set
        WHERE status IN ('approved','retired') AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
        ORDER BY version DESC`,
    )
    .all(at, at) as RuleSetRow[];
  return rows[0] ?? null;
}

function staffName(db: DB, id: string | null): string {
  if (!id) return "Unassigned";
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

/** Pure lookup (no writes): what the approved rules say for this office at this receipt time. */
export function suggestRouting(db: DB, officeId: string | null, receivedAt: string, observedOfficeText?: string | null): RoutingSuggestion {
  const none = (exceptionReason: string, ruleSet: RuleSetRow | null = null): RoutingSuggestion => ({
    status: "exception",
    pathologistId: null,
    ruleSetId: ruleSet?.id ?? null,
    ruleSetVersion: ruleSet?.version ?? null,
    ruleId: null,
    coverageExceptionId: null,
    explanation: `Routing exception: ${exceptionReason} No dermatopathologist is suggested; a lead must assign one with a reason.`,
    exceptionReason,
  });

  if (!officeId) {
    return none(`office "${observedOfficeText ?? "unknown"}" is not in the office directory.`);
  }
  const office = db.prepare("SELECT id, name, status FROM office WHERE id = ?").get(officeId) as
    | { id: string; name: string; status: string }
    | undefined;
  if (!office) return none(`office "${observedOfficeText ?? officeId}" is not in the office directory.`);

  const set = ruleSetEffectiveAt(db, receivedAt);
  if (!set) return none(`no approved routing rule set was in effect at ${fmtDate(receivedAt)}.`);
  if (office.status === "new_unreviewed") {
    return none(`${office.name} is a new office that has not been reviewed (rule set v${set.version} has no approved rule for it).`, set);
  }
  if (office.status === "inactive") {
    return none(`${office.name} is marked inactive in the office directory.`, set);
  }
  const rule = db.prepare("SELECT id, pathologist_id FROM routing_rule WHERE rule_set_id = ? AND office_id = ?").get(set.id, office.id) as
    | { id: string; pathologist_id: string }
    | undefined;
  if (!rule) return none(`rule set v${set.version} has no rule for ${office.name}.`, set);

  const ruleText = `${office.name} → ${staffName(db, rule.pathologist_id)} (rule set v${set.version}, effective ${fmtDate(set.effective_from)})`;
  const pathologist = db.prepare("SELECT id, active FROM staff WHERE id = ? AND role = 'pathologist'").get(rule.pathologist_id) as
    | { id: string; active: number }
    | undefined;

  const coverage = db
    .prepare(
      `SELECT id, covering_pathologist_id, reason, ends_at FROM coverage_exception
        WHERE pathologist_id = ? AND status = 'approved' AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(rule.pathologist_id, receivedAt, receivedAt) as { id: string; covering_pathologist_id: string; reason: string; ends_at: string } | undefined;

  if (coverage) {
    const cover = db.prepare("SELECT id FROM staff WHERE id = ? AND role = 'pathologist' AND active = 1").get(coverage.covering_pathologist_id) as
      | { id: string }
      | undefined;
    if (!cover) {
      return { ...none(`${staffName(db, rule.pathologist_id)} is under a coverage exception and the covering pathologist is unavailable.`, set), ruleId: rule.id, coverageExceptionId: coverage.id };
    }
    return {
      status: "suggested",
      pathologistId: cover.id,
      ruleSetId: set.id,
      ruleSetVersion: set.version,
      ruleId: rule.id,
      coverageExceptionId: coverage.id,
      explanation: `From rule: ${ruleText}. Coverage exception: ${staffName(db, rule.pathologist_id)} is covered by ${staffName(db, cover.id)} until ${fmtDate(coverage.ends_at)} (${coverage.reason}).`,
      exceptionReason: null,
    };
  }

  if (!pathologist || pathologist.active !== 1) {
    return { ...none(`the rule names ${staffName(db, rule.pathologist_id)}, who is not active, and no coverage is defined.`, set), ruleId: rule.id };
  }
  return {
    status: "suggested",
    pathologistId: pathologist.id,
    ruleSetId: set.id,
    ruleSetVersion: set.version,
    ruleId: rule.id,
    coverageExceptionId: null,
    explanation: `From rule: ${ruleText}.`,
    exceptionReason: null,
  };
}

export function currentRouting(db: DB, intakeItemId: string): RoutingDecisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1")
      .get(intakeItemId) as RoutingDecisionRow | undefined) ?? null
  );
}

function leadOwner(db: DB): string | null {
  const r = db.prepare("SELECT id FROM staff WHERE role = 'accessioning_lead' AND active = 1 ORDER BY id LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}

interface IntakeRef {
  id: string;
  display_id: string;
  office_id: string | null;
  observed_office_text: string | null;
  received_at: string;
  status: string;
}

function loadIntake(db: DB, intakeItemId: string): IntakeRef {
  const it = db
    .prepare("SELECT id, display_id, office_id, observed_office_text, received_at, status FROM intake_item WHERE id = ?")
    .get(intakeItemId) as IntakeRef | undefined;
  if (!it) throw new DomainError("NOT_FOUND", "Intake item was not found");
  return it;
}

function assertPreAccession(it: IntakeRef, what: string): void {
  if (it.status === "accessioned" || it.status === "canceled") {
    throw new DomainError(
      "INVARIANT",
      `${what} is not possible on ${it.display_id}: it is already ${it.status}. After accessioning, use the case's reassignment or correction process.`,
    );
  }
}

/** Compute and store the routing suggestion (or exception) for a newly received item. Idempotent. */
export function computeAndStoreRouting(ctx: Ctx, intakeItemId: string): RoutingDecisionRow {
  const existing = currentRouting(ctx.db, intakeItemId);
  if (existing) return existing;
  const it = loadIntake(ctx.db, intakeItemId);
  const s = suggestRouting(ctx.db, it.office_id, it.received_at, it.observed_office_text);
  const id = newId(ctx.db, "rd");
  ctx.db
    .prepare(
      `INSERT INTO routing_decision (id, intake_item_id, status, suggested_pathologist_id, final_pathologist_id, rule_set_id, rule_id,
        coverage_exception_id, explanation, override_reason, decided_by, decided_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(id, intakeItemId, s.status, s.pathologistId, s.ruleSetId, s.ruleId, s.coverageExceptionId, s.explanation, ctx.now);
  audit(ctx, {
    action: s.status === "exception" ? "routing.exception" : "routing.suggested",
    entityType: "routing_decision",
    entityId: id,
    intakeItemId,
    summary: s.status === "exception" ? `${it.display_id}: ${s.explanation}` : `${it.display_id}: suggested ${staffName(ctx.db, s.pathologistId)}. ${s.explanation}`,
    after: { status: s.status, suggested: s.pathologistId, ruleSet: s.ruleSetVersion ? `v${s.ruleSetVersion}` : null },
  });
  if (s.status === "exception") {
    openTask(ctx, {
      kind: "routing_exception",
      entityType: "intake_item",
      entityId: intakeItemId,
      title: `Assign a dermatopathologist for ${it.display_id}: routing exception (${s.exceptionReason})`,
      ownerId: leadOwner(ctx.db),
      ownerRole: "accessioning_lead",
      priority: "high",
      intakeItemId,
    });
  }
  return currentRouting(ctx.db, intakeItemId)!;
}

/** Accept the rule's suggestion. An exception has nothing to accept. */
export function confirmRouting(ctx: Ctx, intakeItemId: string): { decision: RoutingDecisionRow; duplicate: boolean } {
  const it = loadIntake(ctx.db, intakeItemId);
  assertPreAccession(it, "Confirming routing");
  const cur = currentRouting(ctx.db, intakeItemId);
  if (!cur) throw new DomainError("NOT_FOUND", `${it.display_id} has no routing decision yet`);
  if (cur.status === "confirmed" || cur.status === "overridden") return { decision: cur, duplicate: true };
  if (cur.status === "exception") {
    throw new DomainError(
      "BLOCKED",
      `${it.display_id} is a routing exception: there is no rule suggestion to accept. An accessioning lead or supervisor must assign a dermatopathologist with a reason.`,
    );
  }
  assertNotHeld(ctx.db, "routing_confirm", scopesForIntake(ctx.db, intakeItemId), `Confirming routing for ${it.display_id}`);
  ctx.db
    .prepare("UPDATE routing_decision SET status = 'confirmed', final_pathologist_id = suggested_pathologist_id, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(ctx.actor.id, ctx.now, cur.id);
  audit(ctx, {
    action: "routing.confirmed",
    entityType: "routing_decision",
    entityId: cur.id,
    intakeItemId,
    summary: `${it.display_id}: routing to ${staffName(ctx.db, cur.suggested_pathologist_id)} confirmed by ${ctx.actor.name}. ${cur.explanation}`,
    before: { status: cur.status, pathologist: cur.final_pathologist_id, decidedBy: cur.decided_by },
    after: {
      status: "confirmed",
      pathologist: cur.suggested_pathologist_id,
      decidedBy: ctx.actor.id,
      decisionId: cur.id,
      ruleSetId: cur.rule_set_id,
      ruleId: cur.rule_id,
      coverageExceptionId: cur.coverage_exception_id,
    },
  });
  return { decision: currentRouting(ctx.db, intakeItemId)!, duplicate: false };
}

function assertPathologist(db: DB, pathologistId: string): void {
  const p = db.prepare("SELECT id FROM staff WHERE id = ? AND role = 'pathologist' AND active = 1").get(pathologistId);
  if (!p) throw new DomainError("VALIDATION", "Choose an active dermatopathologist");
}

function supersedeAndInsert(
  ctx: Ctx,
  cur: RoutingDecisionRow,
  next: { suggested: string | null; final: string; explanation: string; reason: string },
): RoutingDecisionRow {
  ctx.db.prepare("UPDATE routing_decision SET status = 'superseded' WHERE id = ?").run(cur.id);
  const id = newId(ctx.db, "rd");
  ctx.db
    .prepare(
      `INSERT INTO routing_decision (id, intake_item_id, status, suggested_pathologist_id, final_pathologist_id, rule_set_id, rule_id,
        coverage_exception_id, explanation, override_reason, decided_by, decided_at, created_at)
       VALUES (?, ?, 'overridden', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, cur.intake_item_id, next.suggested, next.final, cur.rule_set_id, cur.rule_id, cur.coverage_exception_id, next.explanation,
      next.reason, ctx.actor.id, ctx.now, ctx.now,
    );
  return ctx.db.prepare("SELECT * FROM routing_decision WHERE id = ?").get(id) as RoutingDecisionRow;
}

/**
 * Lead/supervisor chooses a different pathologist than the rule. The rule's suggestion stays on record.
 * `expectedDecisionId` is the routing decision the user saw: every override or exception resolution
 * supersedes the decision with a new id, so a different current id means someone else changed the
 * routing first (CONFLICT, nothing written). A `routing_confirm` hold blocks it, as it blocks confirm.
 */
export function overrideRouting(ctx: Ctx, intakeItemId: string, pathologistId: string, reason: string, expectedDecisionId: string): RoutingDecisionRow {
  const it = loadIntake(ctx.db, intakeItemId);
  assertPreAccession(it, "Overriding routing");
  if (!reason.trim()) throw new DomainError("VALIDATION", "An override needs a reason");
  const cur = currentRouting(ctx.db, intakeItemId);
  if (!cur) throw new DomainError("NOT_FOUND", `${it.display_id} has no routing decision yet`);
  if (cur.id !== expectedDecisionId) {
    throw new DomainError(
      "CONFLICT",
      `The routing for ${it.display_id} was changed by someone else after you opened it (now ${cur.status}${cur.final_pathologist_id ? `, ${staffName(ctx.db, cur.final_pathologist_id)}` : ""}). Review the current routing before overriding it.`,
      { table: "routing_decision", id: cur.id, expectedDecisionId, currentDecisionId: cur.id, current: cur },
    );
  }
  assertPathologist(ctx.db, pathologistId);
  if (cur.status === "exception") {
    throw new DomainError("VALIDATION", `${it.display_id} is a routing exception. Use "Resolve routing exception" to assign a dermatopathologist.`);
  }
  assertNotHeld(ctx.db, "routing_confirm", scopesForIntake(ctx.db, intakeItemId), `Overriding routing for ${it.display_id}`);
  const currentFinal = cur.final_pathologist_id ?? cur.suggested_pathologist_id;
  if (currentFinal === pathologistId) {
    throw new DomainError("VALIDATION", `${staffName(ctx.db, pathologistId)} is already the assigned dermatopathologist; nothing to override.`);
  }
  const explanation = `Overridden by ${ctx.actor.name}: ${staffName(ctx.db, pathologistId)} instead of ${staffName(ctx.db, cur.suggested_pathologist_id)}. Rule suggestion kept on record — ${cur.explanation.replace(/^From rule: /, "rule: ")}`;
  const row = supersedeAndInsert(ctx, cur, { suggested: cur.suggested_pathologist_id, final: pathologistId, explanation, reason: reason.trim() });
  audit(ctx, {
    action: "routing.overridden",
    entityType: "routing_decision",
    entityId: row.id,
    intakeItemId,
    summary: `${it.display_id}: routing overridden to ${staffName(ctx.db, pathologistId)} (rule suggested ${staffName(ctx.db, cur.suggested_pathologist_id)})`,
    before: { status: cur.status, pathologist: currentFinal },
    after: { status: "overridden", pathologist: pathologistId },
    reason: reason.trim(),
  });
  return row;
}

/** Lead/supervisor assigns a pathologist to a routing exception (unknown or unreviewed office). */
export function resolveRoutingException(ctx: Ctx, intakeItemId: string, pathologistId: string, reason: string): RoutingDecisionRow {
  const it = loadIntake(ctx.db, intakeItemId);
  assertPreAccession(it, "Resolving the routing exception");
  if (!reason.trim()) throw new DomainError("VALIDATION", "Resolving a routing exception needs a reason");
  assertPathologist(ctx.db, pathologistId);
  const cur = currentRouting(ctx.db, intakeItemId);
  if (!cur) throw new DomainError("NOT_FOUND", `${it.display_id} has no routing decision yet`);
  if (cur.status !== "exception") {
    throw new DomainError("VALIDATION", `${it.display_id} is not a routing exception (status: ${cur.status}). Use confirm or override instead.`);
  }
  const explanation = `Routing exception resolved by ${ctx.actor.name}: assigned ${staffName(ctx.db, pathologistId)}. No rule suggestion existed (${cur.explanation.replace(/^Routing exception: /, "").replace(/ No dermatopathologist is suggested.*$/, "")}) This is a one-item decision, not a new routing rule.`;
  const row = supersedeAndInsert(ctx, cur, { suggested: null, final: pathologistId, explanation, reason: reason.trim() });
  closeTasks(ctx, "routing_exception", "intake_item", intakeItemId);
  audit(ctx, {
    action: "routing.exception_resolved",
    entityType: "routing_decision",
    entityId: row.id,
    intakeItemId,
    summary: `${it.display_id}: routing exception resolved — assigned ${staffName(ctx.db, pathologistId)}`,
    before: { status: "exception", pathologist: null },
    after: { status: "overridden", pathologist: pathologistId },
    reason: reason.trim(),
  });
  return row;
}
