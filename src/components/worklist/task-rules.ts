/**
 * Who may claim, take over or release an operational task. Pure (no React, no
 * database): the server commands (task.claim / task.release) enforce these
 * rules, and the UI uses the same function only to explain disabled controls.
 * The demo role selector is not authentication.
 */
import { ROLE_LABEL, type Role } from "@/lib/roles";

/** Roles that run bench work and may own operational tasks. Read-only demo roles and dermatopathologists do not. */
export const TASK_ROLES: readonly Role[] = ["accessioner", "accessioning_lead", "grosser", "histology_assistant", "histotech", "supervisor"];

/** Roles that may reassign (take over) or release a task someone else owns. Always with a reason. */
export const TASK_REASSIGN_ROLES: readonly Role[] = ["accessioning_lead", "supervisor"];

/**
 * Which roles can do the work of a task meant for another role. The supervisor
 * covers every role; otherwise only these documented overlaps apply (they
 * mirror the permission matrix: a lead can do accessioning work, a histology
 * assistant can do grossing and histotech bench work).
 */
const COVERED_BY: Partial<Record<string, readonly Role[]>> = {
  accessioner: ["accessioning_lead"],
  grosser: ["histology_assistant"],
  histotech: ["histology_assistant"],
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Unknown role";
  return (ROLE_LABEL as Record<string, string>)[role] ?? role.replace(/_/g, " ");
}

/** Can someone in `actorRole` do the work of a task meant for `ownerRole`? */
export function roleFitsTask(actorRole: Role, ownerRole: string | null): boolean {
  if (!TASK_ROLES.includes(actorRole)) return false;
  if (!ownerRole || actorRole === "supervisor" || actorRole === ownerRole) return true;
  return (COVERED_BY[ownerRole] ?? []).includes(actorRole);
}

export interface TaskForRules {
  ownerId: string | null;
  ownerName?: string | null;
  ownerRole: string | null;
  status: string;
}

export type ClaimCheck =
  | { ok: true; takeover: boolean; unchanged: boolean }
  | { ok: false; code: "FORBIDDEN" | "INVARIANT"; reason: string };

/**
 * Claim rules:
 * - closed tasks cannot be claimed;
 * - the claimant's role must fit the task's role (owner_role is never changed by a claim);
 * - a task already owned by someone else can only be taken over by an accessioning lead
 *   or the supervisor, with a reason (checked by the command).
 */
export function checkClaim(actor: { id: string; role: Role }, task: TaskForRules): ClaimCheck {
  if (task.status === "done" || task.status === "canceled") {
    return { ok: false, code: "INVARIANT", reason: `This task is already ${task.status === "done" ? "done" : "canceled"}; there is nothing to claim.` };
  }
  if (!TASK_ROLES.includes(actor.role)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason:
        actor.role === "pathologist"
          ? "Dermatopathologists do not own lab bench tasks in this demo."
          : `${roleLabel(actor.role)} is read only here: it can view tasks but not claim them.`,
    };
  }
  if (task.ownerId === actor.id) return { ok: true, takeover: false, unchanged: task.status === "in_progress" };
  if (!roleFitsTask(actor.role, task.ownerRole)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason: `For the ${roleLabel(task.ownerRole)} role, not ${roleLabel(actor.role)}. An accessioning lead or the supervisor can reassign it.`,
    };
  }
  if (task.ownerId) {
    if (!TASK_REASSIGN_ROLES.includes(actor.role)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        reason: `${task.ownerName ?? "Someone else"} owns this task. Only an accessioning lead or the supervisor can reassign it, with a reason.`,
      };
    }
    return { ok: true, takeover: true, unchanged: false };
  }
  return { ok: true, takeover: false, unchanged: false };
}

export type ReleaseCheck = { ok: true; unchanged: boolean; othersTask: boolean } | { ok: false; code: "FORBIDDEN" | "INVARIANT"; reason: string };

/** Release rules: the owner can release their own task; an accessioning lead or the supervisor can release anyone's (with a reason). */
export function checkRelease(actor: { id: string; role: Role }, task: TaskForRules): ReleaseCheck {
  if (task.status === "done" || task.status === "canceled") {
    return { ok: false, code: "INVARIANT", reason: `This task is already ${task.status === "done" ? "done" : "canceled"}; it cannot be released.` };
  }
  if (!TASK_ROLES.includes(actor.role)) {
    return { ok: false, code: "FORBIDDEN", reason: `${roleLabel(actor.role)} cannot release lab tasks.` };
  }
  if (!task.ownerId) return { ok: true, unchanged: true, othersTask: false };
  if (task.ownerId === actor.id) return { ok: true, unchanged: false, othersTask: false };
  if (!TASK_REASSIGN_ROLES.includes(actor.role)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason: `Only the current owner (${task.ownerName ?? "someone else"}), an accessioning lead or the supervisor can release this task.`,
    };
  }
  return { ok: true, unchanged: false, othersTask: true };
}
