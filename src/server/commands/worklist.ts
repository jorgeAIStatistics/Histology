// Commands for the worklist slice (S3): acknowledgments, snapshots, saved
// filters and task ownership. Each defineCommand() call registers itself.
import { z } from "zod";
import { defineCommand } from "./registry";
import type { Ctx } from "../core/context";
import { audit } from "../core/audit";
import { DomainError } from "../core/errors";
import { currentWorklistSeq, recordWorklistChange } from "../core/feed";
import { displayId, newId } from "../core/ids";
import { updateVersioned } from "../core/versioning";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { fmtFull } from "@/lib/time";
import { getWorklist, loadSourceFreshness } from "../queries/worklist";
import { describeFilters, worklistFiltersSchema, worklistViewSchema, VIEW_LABEL } from "@/components/worklist/views";

/** Roles that run bench work and may own operational tasks. Read-only demo roles and pathologists cannot claim lab tasks. */
const TASK_ROLES: Role[] = ["accessioner", "accessioning_lead", "grosser", "histology_assistant", "histotech", "supervisor"];
/** Roles that may release a task someone else owns. */
const TASK_RELEASE_ANY: Role[] = ["accessioning_lead", "supervisor"];

function requireTaskRole(ctx: Ctx, action: string): void {
  if (ctx.origin !== "user") return;
  if (!TASK_ROLES.includes(ctx.actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      `${ROLE_LABEL[ctx.actor.role]} cannot ${action}. Allowed: ${TASK_ROLES.map((r) => ROLE_LABEL[r]).join(", ")}.`,
      { role: ctx.actor.role },
    );
  }
}

// ---------------------------------------------------------------- worklist.ack

export const worklistAck = defineCommand({
  name: "worklist.ack",
  description: "Acknowledge the worklist up to a version for one view (new/changed/canceled tags clear for this user and view only).",
  permission: "worklist.ack",
  input: z.object({ view: worklistViewSchema, seq: z.number().int().min(0) }),
  run: (ctx, input) => {
    const current = currentWorklistSeq(ctx);
    if (input.seq > current) {
      throw new DomainError("VALIDATION", `Cannot acknowledge version v${input.seq}: the latest worklist version is v${current}.`);
    }
    const prior = ctx.db.prepare("SELECT acked_seq, acked_at FROM worklist_ack WHERE staff_id = ? AND view = ?").get(ctx.actor.id, input.view) as
      | { acked_seq: number; acked_at: string }
      | undefined;
    // Never move an acknowledgment backwards (an older tab acknowledging late must not resurrect old tags).
    if (prior && prior.acked_seq >= input.seq) {
      return { view: input.view, ackedSeq: prior.acked_seq, ackedAt: prior.acked_at, unchanged: true };
    }
    ctx.db
      .prepare(
        `INSERT INTO worklist_ack (staff_id, view, acked_seq, acked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(staff_id, view) DO UPDATE SET acked_seq = excluded.acked_seq, acked_at = excluded.acked_at`,
      )
      .run(ctx.actor.id, input.view, input.seq, ctx.now);
    audit(ctx, {
      action: "worklist.acknowledged",
      entityType: "worklist_ack",
      entityId: `${ctx.actor.id}:${input.view}`,
      summary: `${ctx.actor.name} acknowledged the ${VIEW_LABEL[input.view]} worklist up to version v${input.seq}${prior ? ` (was v${prior.acked_seq})` : ""}`,
      before: prior ? { ackedSeq: prior.acked_seq } : null,
      after: { ackedSeq: input.seq },
    });
    return { view: input.view, ackedSeq: input.seq, ackedAt: ctx.now, unchanged: false };
  },
});

// ---------------------------------------------------------------- worklist.snapshot

export const worklistSnapshot = defineCommand({
  name: "worklist.snapshot",
  description: "Record a printed or downloaded worklist snapshot (version, generation time, source data age). The copy is not updated after printing.",
  permission: "worklist.snapshot",
  input: z.object({
    view: worklistViewSchema,
    filters: worklistFiltersSchema.default({}),
    format: z.enum(["print", "csv"]),
    /** The worklist version the user is looking at. If the list moved on, the snapshot is refused so paper never mixes versions. */
    expectedSeq: z.number().int().min(0).optional(),
  }),
  run: (ctx, input) => {
    const data = getWorklist(ctx.db, { staffId: ctx.actor.id, view: input.view, filters: input.filters });
    if (input.expectedSeq !== undefined && input.expectedSeq !== data.seq) {
      throw new DomainError(
        "CONFLICT",
        `The worklist changed since you loaded it (you saw v${input.expectedSeq}, the latest is v${data.seq}). Refresh, check the changes, then print or download again.`,
        { expectedSeq: input.expectedSeq, currentSeq: data.seq },
      );
    }
    const rowCount = data.groups.reduce((n, g) => n + g.rows.length, 0);
    const freshness = loadSourceFreshness(ctx.db, ctx.now);
    const id = newId(ctx.db, "snap");
    const display = displayId(ctx.db, "SNAP", 4);
    ctx.db
      .prepare(
        `INSERT INTO worklist_snapshot (id, display_id, generated_at, generated_by, seq, view, filters, format, row_count, data_as_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, display, ctx.now, ctx.actor.id, data.seq, input.view, JSON.stringify(input.filters ?? {}), input.format, rowCount, freshness.dataAsOf);
    const doctorName = (pid: string) => data.doctors.find((d) => d.id === pid)?.name;
    audit(ctx, {
      action: "worklist.snapshot",
      entityType: "worklist_snapshot",
      entityId: id,
      summary: `${display}: ${input.format === "print" ? "printed" : "downloaded (CSV)"} ${VIEW_LABEL[input.view]} worklist v${data.seq}, ${rowCount} row(s), filters: ${describeFilters(input.filters ?? {}, doctorName)}. Generated ${fmtFull(ctx.now)}.${freshness.stale ? " Source data was stale at generation." : ""}`,
      after: { seq: data.seq, rowCount, dataAsOf: freshness.dataAsOf, stale: freshness.stale },
    });
    return {
      snapshotId: id,
      displayId: display,
      seq: data.seq,
      generatedAt: ctx.now,
      generatedBy: ctx.actor.name,
      rowCount,
      dataAsOf: freshness.dataAsOf,
      stale: freshness.stale,
    };
  },
});

// ---------------------------------------------------------------- saved filters

export const worklistSaveFilter = defineCommand({
  name: "worklist.saveFilter",
  description: "Save the current worklist filters under a name for this user and view (saving the same name again replaces it).",
  permission: "worklist.ack",
  input: z.object({ view: worklistViewSchema, name: z.string().trim().min(1, "Give the filter a name").max(40), filters: worklistFiltersSchema }),
  run: (ctx, input) => {
    const existing = ctx.db.prepare("SELECT id, filters FROM saved_filter WHERE staff_id = ? AND view = ? AND name = ?").get(ctx.actor.id, input.view, input.name) as
      | { id: string; filters: string }
      | undefined;
    const filtersJson = JSON.stringify(input.filters);
    let id: string;
    if (existing) {
      id = existing.id;
      ctx.db.prepare("UPDATE saved_filter SET filters = ? WHERE id = ?").run(filtersJson, id);
    } else {
      const count = (ctx.db.prepare("SELECT COUNT(*) n FROM saved_filter WHERE staff_id = ?").get(ctx.actor.id) as { n: number }).n;
      if (count >= 30) throw new DomainError("VALIDATION", "You already have 30 saved filters. Delete one before saving another.");
      id = newId(ctx.db, "sf");
      ctx.db
        .prepare("INSERT INTO saved_filter (id, staff_id, view, name, filters, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, ctx.actor.id, input.view, input.name, filtersJson, ctx.now);
    }
    audit(ctx, {
      action: existing ? "worklist.filterUpdated" : "worklist.filterSaved",
      entityType: "saved_filter",
      entityId: id,
      summary: `${ctx.actor.name} ${existing ? "updated" : "saved"} worklist filter "${input.name}" (${VIEW_LABEL[input.view]}): ${describeFilters(input.filters)}`,
      before: existing ? JSON.parse(existing.filters) : undefined,
      after: input.filters,
    });
    return { filterId: id, name: input.name, replaced: !!existing };
  },
});

export const worklistDeleteFilter = defineCommand({
  name: "worklist.deleteFilter",
  description: "Delete one of your own saved worklist filters (a personal preference, not an operational record).",
  permission: "worklist.ack",
  input: z.object({ filterId: z.string().min(1).max(64) }),
  run: (ctx, input) => {
    const row = ctx.db.prepare("SELECT * FROM saved_filter WHERE id = ?").get(input.filterId) as
      | { id: string; staff_id: string; view: string; name: string; filters: string }
      | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "That saved filter no longer exists.");
    if (row.staff_id !== ctx.actor.id) throw new DomainError("FORBIDDEN", "You can only delete your own saved filters.");
    ctx.db.prepare("DELETE FROM saved_filter WHERE id = ?").run(row.id);
    audit(ctx, {
      action: "worklist.filterDeleted",
      entityType: "saved_filter",
      entityId: row.id,
      summary: `${ctx.actor.name} deleted worklist filter "${row.name}"`,
      before: JSON.parse(row.filters),
    });
    return { filterId: row.id, deleted: true };
  },
});

// ---------------------------------------------------------------- task ownership

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  owner_id: string | null;
  owner_role: string | null;
  status: string;
  accession_id: string | null;
  intake_item_id: string | null;
  version: number;
}

function loadTask(ctx: Ctx, taskId: string): TaskRow {
  const t = ctx.db.prepare("SELECT * FROM task WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!t) throw new DomainError("NOT_FOUND", "That task was not found.");
  return t;
}

function staffName(ctx: Ctx, id: string | null): string {
  if (!id) return "nobody";
  return (ctx.db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined)?.display_name ?? id;
}

function noteTaskChange(ctx: Ctx, t: TaskRow, summary: string): void {
  if (t.accession_id) {
    const acc = ctx.db.prepare("SELECT assigned_pathologist_id AS p FROM accession WHERE id = ?").get(t.accession_id) as { p: string | null } | undefined;
    recordWorklistChange(ctx, { accessionId: t.accession_id, pathologistId: acc?.p ?? null, type: "changed", summary });
  } else if (t.intake_item_id) {
    recordWorklistChange(ctx, { intakeItemId: t.intake_item_id, type: "changed", summary });
  }
}

export const taskClaim = defineCommand({
  name: "task.claim",
  description: "Take ownership of a task (become the current task owner). Detects a stale view if someone else claimed or changed it first.",
  permission: "worklist.ack",
  input: z.object({ taskId: z.string().min(1).max(64), expectedVersion: z.number().int().min(1) }),
  run: (ctx, input) => {
    requireTaskRole(ctx, "claim lab tasks");
    const t = loadTask(ctx, input.taskId);
    if (t.status === "done" || t.status === "canceled") {
      throw new DomainError("INVARIANT", `This task is already ${t.status === "done" ? "done" : "canceled"}; there is nothing to claim.`);
    }
    if (t.owner_id === ctx.actor.id && t.status === "in_progress") {
      if (t.version !== input.expectedVersion) {
        // Same outcome the user wanted; still report that the row moved on.
        return { taskId: t.id, ownerId: ctx.actor.id, version: t.version, unchanged: true };
      }
      return { taskId: t.id, ownerId: ctx.actor.id, version: t.version, unchanged: true };
    }
    const updated = updateVersioned(ctx.db, "task", t.id, input.expectedVersion, {
      owner_id: ctx.actor.id,
      owner_role: ctx.actor.role,
      status: "in_progress",
    }) as unknown as TaskRow;
    const previous = t.owner_id && t.owner_id !== ctx.actor.id ? ` (previous owner: ${staffName(ctx, t.owner_id)})` : "";
    audit(ctx, {
      action: "task.claimed",
      entityType: "task",
      entityId: t.id,
      accessionId: t.accession_id,
      intakeItemId: t.intake_item_id,
      summary: `${ctx.actor.name} claimed "${t.title}"${previous}`,
      before: { ownerId: t.owner_id, ownerRole: t.owner_role, status: t.status },
      after: { ownerId: ctx.actor.id, ownerRole: ctx.actor.role, status: "in_progress" },
    });
    noteTaskChange(ctx, t, `Task owner: ${ctx.actor.name} claimed "${t.title}"`);
    return { taskId: t.id, ownerId: ctx.actor.id, version: updated.version, unchanged: false };
  },
});

export const taskRelease = defineCommand({
  name: "task.release",
  description: "Give a claimed task back to the queue (no owner). Only the current owner, an accessioning lead or the supervisor can release it.",
  permission: "worklist.ack",
  input: z.object({ taskId: z.string().min(1).max(64), reason: z.string().trim().max(200).optional() }),
  run: (ctx, input) => {
    requireTaskRole(ctx, "release lab tasks");
    const t = loadTask(ctx, input.taskId);
    if (t.status === "done" || t.status === "canceled") {
      throw new DomainError("INVARIANT", `This task is already ${t.status === "done" ? "done" : "canceled"}; it cannot be released.`);
    }
    if (!t.owner_id) return { taskId: t.id, ownerId: null, version: t.version, unchanged: true };
    if (t.owner_id !== ctx.actor.id && !TASK_RELEASE_ANY.includes(ctx.actor.role)) {
      throw new DomainError(
        "FORBIDDEN",
        `Only the current owner (${staffName(ctx, t.owner_id)}), an accessioning lead or the supervisor can release this task.`,
      );
    }
    const updated = updateVersioned(ctx.db, "task", t.id, t.version, { owner_id: null, status: "open" }) as unknown as TaskRow;
    audit(ctx, {
      action: "task.released",
      entityType: "task",
      entityId: t.id,
      accessionId: t.accession_id,
      intakeItemId: t.intake_item_id,
      summary: `${ctx.actor.name} released "${t.title}" back to the queue${t.owner_id !== ctx.actor.id ? ` (was owned by ${staffName(ctx, t.owner_id)})` : ""}`,
      reason: input.reason ?? null,
      before: { ownerId: t.owner_id, status: t.status },
      after: { ownerId: null, status: "open" },
    });
    noteTaskChange(ctx, t, `Task released to the queue: "${t.title}"`);
    return { taskId: t.id, ownerId: null, version: updated.version, unchanged: false };
  },
});

export const __worklistCommands = [worklistAck, worklistSnapshot, worklistSaveFilter, worklistDeleteFilter, taskClaim, taskRelease] as const;
