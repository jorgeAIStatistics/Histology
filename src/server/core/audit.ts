import type { Ctx } from "./context";
import { newId } from "./ids";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  accessionId?: string | null;
  intakeItemId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Append-only local audit trail (enforced by SQLite triggers). */
export function audit(ctx: Ctx, input: AuditInput): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_event (id, at, recorded_at, actor_id, actor_role, origin, action, entity_type, entity_id,
        accession_id, intake_item_id, summary, before_json, after_json, reason, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(ctx.db, "aud"),
      ctx.now,
      new Date().toISOString(),
      ctx.actor.id,
      ctx.actor.role,
      ctx.origin,
      input.action,
      input.entityType,
      input.entityId,
      input.accessionId ?? null,
      input.intakeItemId ?? null,
      input.summary,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
      ctx.correlationId,
    );
}
