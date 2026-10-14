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
import { fmtFull } from "@/lib/time";
import { getWorklist, loadSourceFreshness } from "../queries/worklist";
import { describeFilters, worklistFiltersSchema, worklistViewSchema, VIEW_LABEL } from "@/components/worklist/views";
import { checkClaim, checkRelease, roleLabel, TASK_ROLES } from "@/components/worklist/task-rules";

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
      summary: `${display}: ${input.format === "print" ? "printed" : "downloaded (CSV)"} ${VIEW_LABEL[input.view]} worklist v${data.seq}, ${rowCount} ${rowCount === 1 ? "row" : "rows"}, filters: ${describeFilters(input.filters ?? {}, doctorName)}. Generated ${fmtFull(ctx.now)}.${freshness.stale ? " Source data was stale at generation." : ""}`,
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

function rulesView(ctx: Ctx, t: TaskRow) {
  return { ownerId: t.owner_id, ownerName: t.owner_id ? staffName(ctx, t.owner_id) : null, ownerRole: t.owner_role, status: t.status };
}

/**
 * Permission note: there is no dedicated `task.claim` key in src/lib/roles.ts (foundation). The command
 * registry checks `worklist.ack`; the real rules (role must fit the task, takeover only by a lead or the
 * supervisor with a reason) live in components/worklist/task-rules.ts and are enforced here on the server.
 */
export const taskClaim = defineCommand({
  name: "task.claim",
  description:
    "Take ownership of a task (become the current task owner). The claimant's role must fit the task; taking over someone else's task needs an accessioning lead or the supervisor and a reason. Detects a stale view.",
  permission: "worklist.ack",
  input: z.object({
    taskId: z.string().min(1).max(64),
    expectedVersion: z.number().int().min(1),
    /** Required when taking over a task someone else owns. */
    reason: z.string().trim().max(200).optional(),
  }),
  run: (ctx, input) => {
    const t = loadTask(ctx, input.taskId);
    const pre = checkClaim(ctx.actor, rulesView(ctx, t));
    // Closed tasks and roles that never own bench tasks are refused before anything else.
    if (!pre.ok && (pre.code === "INVARIANT" || !TASK_ROLES.includes(ctx.actor.role))) throw new DomainError(pre.code, pre.reason, { role: ctx.actor.role });
    // Already mine and in progress (double click, second tab): nothing to change.
    if (pre.ok && pre.unchanged) return { taskId: t.id, ownerId: ctx.actor.id, version: t.version, unchanged: true };
    // A stale view is reported as a conflict first: someone claimed or changed this task after the user loaded it.
    if (t.version !== input.expectedVersion) {
      throw new DomainError(
        "CONFLICT",
        `This task changed since you loaded it (you had version ${input.expectedVersion}, current is ${t.version}; owner now: ${t.owner_id ? staffName(ctx, t.owner_id) : "nobody"}). Review it before claiming.`,
        { table: "task", id: t.id, expectedVersion: input.expectedVersion, currentVersion: t.version, current: t },
      );
    }
    if (!pre.ok) throw new DomainError(pre.code, pre.reason, { role: ctx.actor.role, ownerRole: t.owner_role });
    const reason = input.reason?.trim() || null;
    if (pre.takeover && (!reason || reason.length < 3)) {
      throw new DomainError("VALIDATION", `Taking over a task from ${staffName(ctx, t.owner_id)} needs a reason (recorded in the audit log).`);
    }
    // owner_role is the role the task is meant for; claiming never changes it, so releasing returns it to the right queue.
    const updated = updateVersioned(ctx.db, "task", t.id, input.expectedVersion, { owner_id: ctx.actor.id, status: "in_progress" }) as unknown as TaskRow;
    const previous = pre.takeover ? ` (taken over from ${staffName(ctx, t.owner_id)})` : "";
    audit(ctx, {
      action: pre.takeover ? "task.reassigned" : "task.claimed",
      entityType: "task",
      entityId: t.id,
      accessionId: t.accession_id,
      intakeItemId: t.intake_item_id,
      summary: `${ctx.actor.name} ${pre.takeover ? "took over" : "claimed"} "${t.title}"${previous}`,
      reason,
      before: { ownerId: t.owner_id, ownerRole: t.owner_role, status: t.status },
      after: { ownerId: ctx.actor.id, ownerRole: t.owner_role, status: "in_progress" },
    });
    noteTaskChange(ctx, t, `Task owner: ${ctx.actor.name} ${pre.takeover ? "took over" : "claimed"} "${t.title}"`);
    return { taskId: t.id, ownerId: ctx.actor.id, version: updated.version, unchanged: false, takeover: pre.takeover };
  },
});

export const taskRelease = defineCommand({
  name: "task.release",
  description:
    "Give a claimed task back to the queue (no owner; the role it is meant for is kept). The current owner can release it; an accessioning lead or the supervisor can release anyone's task with a reason.",
  permission: "worklist.ack",
  input: z.object({
    taskId: z.string().min(1).max(64),
    reason: z.string().trim().max(200).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  }),
  run: (ctx, input) => {
    const t = loadTask(ctx, input.taskId);
    const check = checkRelease(ctx.actor, rulesView(ctx, t));
    if (!check.ok) throw new DomainError(check.code, check.reason, { role: ctx.actor.role });
    if (check.unchanged) return { taskId: t.id, ownerId: null, version: t.version, unchanged: true };
    const reason = input.reason?.trim() || null;
    if (check.othersTask && (!reason || reason.length < 3)) {
      throw new DomainError("VALIDATION", `Releasing ${staffName(ctx, t.owner_id)}'s task needs a reason (recorded in the audit log).`);
    }
    const updated = updateVersioned(ctx.db, "task", t.id, input.expectedVersion ?? t.version, { owner_id: null, status: "open" }) as unknown as TaskRow;
    audit(ctx, {
      action: "task.released",
      entityType: "task",
      entityId: t.id,
      accessionId: t.accession_id,
      intakeItemId: t.intake_item_id,
      summary: `${ctx.actor.name} released "${t.title}" back to the ${t.owner_role ? `${roleLabel(t.owner_role).toLowerCase()} ` : ""}queue${check.othersTask ? ` (was owned by ${staffName(ctx, t.owner_id)})` : ""}`,
      reason,
      before: { ownerId: t.owner_id, ownerRole: t.owner_role, status: t.status },
      after: { ownerId: null, ownerRole: t.owner_role, status: "open" },
    });
    noteTaskChange(ctx, t, `Task released to the queue: "${t.title}"`);
    return { taskId: t.id, ownerId: null, version: updated.version, unchanged: false };
  },
});

export const __worklistCommands = [worklistAck, worklistSnapshot, worklistSaveFilter, worklistDeleteFilter, taskClaim, taskRelease] as const;
