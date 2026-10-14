import type { Ctx } from "./context";
import { newId } from "./ids";

export interface OpenTaskInput {
  kind: string;
  entityType: string;
  entityId: string;
  title: string;
  ownerId?: string | null;
  ownerRole?: string | null;
  priority?: "routine" | "high" | "urgent";
  dueAt?: string | null;
  accessionId?: string | null;
  intakeItemId?: string | null;
  detail?: string | null;
}

/** Idempotent: an open task of the same kind for the same entity is reused. */
export function openTask(ctx: Ctx, t: OpenTaskInput): string {
  const existing = ctx.db
    .prepare("SELECT id FROM task WHERE kind = ? AND entity_type = ? AND entity_id = ? AND status IN ('open','in_progress')")
    .get(t.kind, t.entityType, t.entityId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId(ctx.db, "task");
  ctx.db
    .prepare(
      `INSERT INTO task (id, kind, entity_type, entity_id, title, owner_id, owner_role, status, priority, due_at, created_at, accession_id, intake_item_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, t.kind, t.entityType, t.entityId, t.title, t.ownerId ?? null, t.ownerRole ?? null,
      t.priority ?? "routine", t.dueAt ?? null, ctx.now, t.accessionId ?? null, t.intakeItemId ?? null, t.detail ?? null,
    );
  return id;
}

export function closeTasks(ctx: Ctx, kind: string, entityType: string, entityId: string, status: "done" | "canceled" = "done"): number {
  return ctx.db
    .prepare(
      `UPDATE task SET status = ?, completed_at = ?, completed_by = ?, version = version + 1
       WHERE kind = ? AND entity_type = ? AND entity_id = ? AND status IN ('open','in_progress')`,
    )
    .run(status, ctx.now, ctx.actor.id, kind, entityType, entityId).changes;
}

/** Re-attach open tasks from intake items to the accession once issued. */
export function attachTasksToAccession(ctx: Ctx, intakeItemId: string, accessionId: string): void {
  ctx.db.prepare("UPDATE task SET accession_id = ? WHERE intake_item_id = ? AND accession_id IS NULL").run(accessionId, intakeItemId);
}
