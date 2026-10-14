import type { Ctx } from "./context";

/**
 * Worklist change feed. Every change that affects the digital worklist is
 * recorded with a monotonic sequence so each user can see what is new,
 * changed or canceled since their last acknowledged version.
 */
export function recordWorklistChange(
  ctx: Ctx,
  change: {
    accessionId?: string | null;
    intakeItemId?: string | null;
    pathologistId?: string | null;
    type: "new" | "changed" | "canceled";
    summary: string;
  },
): number {
  const res = ctx.db
    .prepare(
      "INSERT INTO worklist_change (accession_id, intake_item_id, pathologist_id, change_type, summary, at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(change.accessionId ?? null, change.intakeItemId ?? null, change.pathologistId ?? null, change.type, change.summary, ctx.now);
  return Number(res.lastInsertRowid);
}

export function currentWorklistSeq(ctx: Pick<Ctx, "db">): number {
  const row = ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM worklist_change").get() as { seq: number };
  return row.seq;
}
