/**
 * Read paths for the presenter console (/demo, synthetic demo only). Server-only:
 * opens SQLite. Nothing here changes state: each list names the synthetic records a
 * simulated world event can act on right now, so the console's target pickers never
 * offer a record the event would refuse. The commands themselves still check
 * everything on the server.
 */
import type { DB } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { labDay } from "@/lib/time";
import { CLARIFICATION_CATEGORY, CLARIFICATION_STATE, INTAKE_STATUS, type ClarificationState } from "@/lib/domain";
import { deliveriesForDay, intakeQueue } from "./intake";
import { sourceEntryQueue } from "./grossing";
import { printerViews, type PrinterView } from "./materials";

/** A courier delivery of the demo day whose simulated bag still holds requisitions. */
export interface CourierTarget {
  id: string;
  displayId: string;
  courierName: string;
  expectedAt: string | null;
  arrivedAt: string | null;
  /** Requisitions still in the simulated bag. */
  remaining: number;
  total: number;
}

/** An intake item a simulated colleague can edit (anything not canceled). */
export interface IntakeTarget {
  id: string;
  displayId: string;
  status: string;
  statusLabel: string;
  patientName: string | null;
  officeName: string;
}

/** A sent clarification the office simulator can answer. */
export interface ClarificationTarget {
  id: string;
  displayId: string;
  category: string;
  subject: string;
  officeName: string;
  state: ClarificationState;
  stateLabel: string;
}

/** A gross description staff attested as entered, waiting for the simulated source to acknowledge it. */
export interface GrossAckTarget {
  recordId: string;
  ref: string;
  accessionNumber: string;
  designation: string;
  enteredBy: string | null;
  enteredAt: string | null;
  sourceName: string | null;
  /** The simulated source is offline: it cannot acknowledge until it is back (the command refuses). */
  sourceOffline: boolean;
}

export interface WorldEventTargets {
  now: string;
  couriers: CourierTarget[];
  intakeItems: IntakeTarget[];
  clarifications: ClarificationTarget[];
  grossAcks: GrossAckTarget[];
  printers: PrinterView[];
}

/** Clarification states the simulated office can answer (it never received a drafted or failed message). */
export const SIMULATED_ANSWER_STATES: readonly ClarificationState[] = ["sent", "delivered", "delivery_unknown", "acknowledged"];

/** Courier deliveries of the demo day with requisitions still in the simulated bag, in arrival order. */
export function courierTargets(db: DB, now: string = readClock(db).now): CourierTarget[] {
  return deliveriesForDay(db, labDay(now))
    .filter((d) => d.simTotal > 0 && d.simRemaining > 0)
    .map((d) => ({
      id: d.id,
      displayId: d.displayId,
      courierName: d.courierName,
      expectedAt: d.expectedAt,
      arrivedAt: d.arrivedAt,
      remaining: d.simRemaining,
      total: d.simTotal,
    }));
}

/** Intake items on today's bench (the Intake queue) that are not canceled: items still in review first, then accessioned ones, each by id. */
export function intakeEditTargets(db: DB, now: string = readClock(db).now): IntakeTarget[] {
  const closed = (status: string) => (status === "accessioned" ? 1 : 0);
  return intakeQueue(db, now)
    .filter((q) => q.status !== "canceled")
    .sort((a, b) => closed(a.status) - closed(b.status) || a.displayId.localeCompare(b.displayId))
    .map((q) => ({
      id: q.id,
      displayId: q.displayId,
      status: q.status,
      statusLabel: INTAKE_STATUS[q.status as keyof typeof INTAKE_STATUS] ?? q.status,
      patientName: q.patientName,
      officeName: q.officeName,
    }));
}

/** Sent clarifications the office simulator can answer, oldest first. */
export function officeAnswerTargets(db: DB): ClarificationTarget[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.display_id, c.category, c.subject_label, c.state, o.name AS office_name
         FROM clarification c JOIN office o ON o.id = c.office_id
        WHERE c.state IN (${SIMULATED_ANSWER_STATES.map((s) => `'${s}'`).join(", ")})
        ORDER BY c.display_id`,
    )
    .all() as { id: string; display_id: string; category: string; subject_label: string; state: ClarificationState; office_name: string }[];
  return rows.map((r) => ({
    id: r.id,
    displayId: r.display_id,
    category: CLARIFICATION_CATEGORY[r.category as keyof typeof CLARIFICATION_CATEGORY] ?? r.category,
    subject: r.subject_label,
    officeName: r.office_name,
    state: r.state,
    stateLabel: CLARIFICATION_STATE[r.state] ?? r.state,
  }));
}

/** Attested gross entries the simulated source has not acknowledged yet (from the shared source-entry queue). */
export function sourceAckTargets(db: DB): GrossAckTarget[] {
  return sourceEntryQueue(db)
    .filter((r) => r.sourceUpdateState === "entered_attested")
    .map((r) => ({
      recordId: r.recordId,
      ref: r.ref,
      accessionNumber: r.accessionNumber,
      designation: r.designation,
      enteredBy: r.enteredBy,
      enteredAt: r.enteredAt,
      sourceName: r.sourceName ? r.sourceName.replace(/\s*\(simulated[^)]*\)\s*$/i, "") : null,
      sourceOffline: r.sourceStatus === "offline",
    }));
}

/** Everything the World events tab offers, read once per render. */
export function worldEventTargets(db: DB): WorldEventTargets {
  const now = readClock(db).now;
  return {
    now,
    couriers: courierTargets(db, now),
    intakeItems: intakeEditTargets(db, now),
    clarifications: officeAnswerTargets(db),
    grossAcks: sourceAckTargets(db),
    printers: printerViews(db),
  };
}
