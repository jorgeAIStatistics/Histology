/**
 * The ONE answer to "who holds the next step on this hold, and what is it?", shared by
 * Operations, the case page and the grossing bench so they never disagree. Read-only.
 *
 * Owner, in this order:
 *   1. an open task on the hold itself (hold_release_decision, order_change_review, ...);
 *   2. the open task of the correction review that placed it (source amended after accession);
 *   3. the linked clarification's open task;
 *   4. the clarification's escalation owner;
 *   5. the clarification's lab owner;
 *   otherwise nobody: "Accessioning lead (unassigned)" (the same words as an unowned routing exception).
 *
 * The next step follows the clarification's state, with AWAITING_OFFICE_STATES as the single
 * definition of "waiting for the office". A question never sent or never delivered is never
 * presented as waiting for the office.
 */
import type { DB } from "@/server/db/db";
import { AWAITING_OFFICE_STATES } from "@/server/domain/clarification";
import { correctionIdOfHold } from "@/server/domain/correction";
import { CLARIFICATION_STATE, type ClarificationState } from "@/lib/domain";
import { fmtTime } from "@/lib/time";

export type HoldWaiting =
  | "not_sent"
  | "delivery_unconfirmed"
  | "office"
  | "lab_review"
  | "lab_resolve"
  | "source_amendment"
  | "lab_release"
  | "correction_review"
  | "lab_decision";

export interface HoldNextStep {
  holdId: string;
  /** A staff name, or "Unassigned (<role>)" when no one holds it. */
  owner: string;
  ownerId: string | null;
  ownerFrom: "hold_task" | "correction_task" | "clarification_task" | "escalation_owner" | "lab_owner" | "none";
  /** The open task the owner came from (so a list does not show it a second time). */
  taskId: string | null;
  nextStep: string;
  waiting: HoldWaiting;
  clarification: { id: string; displayId: string; state: ClarificationState; resolutionCode: string | null } | null;
  correction: { id: string; displayId: string; status: string } | null;
}

/** Resolutions that mean the order itself must change at the source (the office confirmed what the lab observed). */
const AMENDS_ORDER = new Set(["confirmed_observed", "source_amended"]);

interface TaskRow {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  owner_id: string | null;
  owner_role: string | null;
  created_at: string;
}

/** Preferred task on a hold: the release decision first, then any other open task, oldest first. */
const HOLD_TASK_RANK = (k: string) => (k === "hold_release_decision" ? 0 : k === "order_change_review" ? 1 : 2);
/** Preferred clarification task: review (a lead decision), then escalation, then the follow-up. */
const CLR_TASK_RANK = (k: string) => (k === "clarification_review" ? 0 : k === "clarification_escalation" ? 1 : 2);

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Next step and owner for every active hold (or the given holds, active or not). */
export function holdNextSteps(db: DB, holdIds?: string[]): Map<string, HoldNextStep> {
  const out = new Map<string, HoldNextStep>();
  const holds = (
    holdIds
      ? holdIds.length
        ? db.prepare(`SELECT * FROM hold WHERE id IN (${holdIds.map(() => "?").join(",")})`).all(...holdIds)
        : []
      : db.prepare("SELECT * FROM hold WHERE status = 'active'").all()
  ) as { id: string; display_id: string; reason_code: string; clarification_id: string | null }[];
  if (!holds.length) return out;

  const staff = new Map((db.prepare("SELECT id, display_name FROM staff").all() as { id: string; display_name: string }[]).map((s) => [s.id, s.display_name]));
  const tasks = db
    .prepare("SELECT id, kind, entity_type, entity_id, owner_id, owner_role, created_at FROM task WHERE status IN ('open','in_progress') AND entity_type IN ('hold','clarification','correction_review')")
    .all() as TaskRow[];
  const pick = (entityType: string, entityId: string, rank: (k: string) => number) =>
    tasks
      .filter((t) => t.entity_type === entityType && t.entity_id === entityId)
      .sort((a, b) => rank(a.kind) - rank(b.kind) || Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  const clrStmt = db.prepare(
    `SELECT c.id, c.display_id, c.state, c.lab_owner_id, c.escalation_owner_id, c.next_follow_up_at, c.resolution_code, c.resolved_at, c.created_at,
            COALESCE(c.source_order_id,
                     (SELECT sop.source_order_id FROM source_order_part sop WHERE sop.id = c.order_part_id),
                     (SELECT sp.source_order_id FROM specimen_part sp WHERE sp.id = c.specimen_part_id),
                     (SELECT l.source_order_id FROM intake_order_link l WHERE l.intake_item_id = c.intake_item_id ORDER BY l.linked_at LIMIT 1)) AS order_id
       FROM clarification c WHERE c.id = ?`,
  );
  const newerVersionStmt = db.prepare("SELECT 1 FROM source_order_version WHERE source_order_id = ? AND imported_at > ? LIMIT 1");
  const corrStmt = db.prepare("SELECT id, display_id, status FROM correction_review WHERE id = ?");
  const who = (t: { owner_id: string | null; owner_role: string | null }) =>
    (t.owner_id && staff.get(t.owner_id)) || `Unassigned${t.owner_role ? ` (${t.owner_role.replace(/_/g, " ")})` : ""}`;

  for (const h of holds) {
    const clr = h.clarification_id
      ? (clrStmt.get(h.clarification_id) as
          | {
              id: string; display_id: string; state: ClarificationState; lab_owner_id: string | null; escalation_owner_id: string | null;
              next_follow_up_at: string | null; resolution_code: string | null; resolved_at: string | null; created_at: string; order_id: string | null;
            }
          | undefined)
      : undefined;
    const correctionId = correctionIdOfHold(h.reason_code);
    const corr = correctionId ? (corrStmt.get(correctionId) as { id: string; display_id: string; status: string } | undefined) : undefined;

    // ---- owner
    let owner = "Accessioning lead (unassigned)";
    let ownerId: string | null = null;
    let ownerFrom: HoldNextStep["ownerFrom"] = "none";
    let taskId: string | null = null;
    const holdTask = pick("hold", h.id, HOLD_TASK_RANK);
    const corrTask = corr ? pick("correction_review", corr.id, () => 0) : undefined;
    const clrTask = clr ? pick("clarification", clr.id, CLR_TASK_RANK) : undefined;
    if (holdTask) [owner, ownerId, ownerFrom, taskId] = [who(holdTask), holdTask.owner_id, "hold_task", holdTask.id];
    else if (corrTask) [owner, ownerId, ownerFrom, taskId] = [who(corrTask), corrTask.owner_id, "correction_task", corrTask.id];
    else if (clrTask) [owner, ownerId, ownerFrom, taskId] = [who(clrTask), clrTask.owner_id, "clarification_task", clrTask.id];
    else if (clr?.escalation_owner_id) [owner, ownerId, ownerFrom] = [staff.get(clr.escalation_owner_id) ?? "Unknown person", clr.escalation_owner_id, "escalation_owner"];
    else if (clr?.lab_owner_id) [owner, ownerId, ownerFrom] = [staff.get(clr.lab_owner_id) ?? "Unknown person", clr.lab_owner_id, "lab_owner"];

    // ---- next step (by clarification state)
    let nextStep: string;
    let waiting: HoldWaiting;
    if (corr) {
      waiting = "correction_review";
      nextStep = `Correction review ${corr.display_id} is open: the source order changed after accession. Review it; closing the review releases ${h.display_id}`;
    } else if (!clr) {
      waiting = "lab_decision";
      nextStep = "Lead or supervisor reviews the evidence and releases the hold with a reason";
    } else if (clr.state === "drafted") {
      waiting = "not_sent";
      nextStep = `Send ${clr.display_id}, not sent yet`;
    } else if (clr.state === "delivery_failed" || clr.state === "delivery_unknown") {
      waiting = "delivery_unconfirmed";
      nextStep = `Delivery not confirmed: follow up on ${clr.display_id} (${lowerFirst(CLARIFICATION_STATE[clr.state])}, simulated)`;
    } else if (AWAITING_OFFICE_STATES.includes(clr.state)) {
      waiting = "office";
      nextStep = `Waiting for the office on ${clr.display_id}: ${lowerFirst(CLARIFICATION_STATE[clr.state])}${clr.next_follow_up_at ? `; follow-up ${fmtTime(clr.next_follow_up_at)} ET` : ""}`;
    } else if (clr.state === "answered") {
      waiting = "lab_review";
      nextStep = `Lead reviews the office answer on ${clr.display_id}`;
    } else if (clr.state === "reviewed") {
      waiting = "lab_resolve";
      nextStep = `Lead resolves ${clr.display_id}, then releases ${h.display_id} with a reason`;
    } else if (clr.state === "resolved" && AMENDS_ORDER.has(clr.resolution_code ?? "") && !(clr.order_id && newerVersionStmt.get(clr.order_id, clr.created_at))) {
      // "Newer" means imported after the question was asked: an amendment that arrived before the lead
      // resolved it (the scripted hero path) already settles it.
      // The office said the order must change; until a newer order version is imported, nothing is ready to release.
      waiting = "source_amendment";
      nextStep = `${clr.display_id} is resolved: waiting for the amended order from the source (simulated) before ${h.display_id} is reviewed for release`;
    } else if (clr.state === "resolved") {
      waiting = "lab_release";
      nextStep = `${clr.display_id} is resolved: lead releases ${h.display_id} with a reason (not automatic)`;
    } else {
      waiting = "lab_decision";
      nextStep = `${clr.display_id} is ${lowerFirst(CLARIFICATION_STATE[clr.state] ?? clr.state)}: lead or supervisor reviews and releases ${h.display_id} with a reason`;
    }

    out.set(h.id, {
      holdId: h.id, owner, ownerId, ownerFrom, taskId, nextStep, waiting,
      clarification: clr ? { id: clr.id, displayId: clr.display_id, state: clr.state, resolutionCode: clr.resolution_code } : null,
      correction: corr ? { id: corr.id, displayId: corr.display_id, status: corr.status } : null,
    });
  }
  return out;
}

export function holdNextStep(db: DB, holdId: string): HoldNextStep | null {
  return holdNextSteps(db, [holdId]).get(holdId) ?? null;
}
