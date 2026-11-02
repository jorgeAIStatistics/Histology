// Shared test harness: an isolated in-memory database seeded with the same
// reproducible synthetic demo day, with the demo clock PAUSED at 10:52 ET.
import { openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { executeCommand, mustRun, type CommandResult } from "@/server/commands";
import { setClock, advanceClock } from "@/server/core/clock";
import { labLocalToIso } from "@/lib/time";

export function testDb(): DB {
  const db = openDatabase(":memory:");
  seedDemo(db, { clockRunning: false });
  return db;
}

/** Run a command as a staff member; returns the CommandResult (never throws). */
export function run<R = unknown>(db: DB, actorId: string, name: string, input: unknown, idempotencyKey?: string): CommandResult<R> {
  return executeCommand<R>(db, actorId, name, input, { idempotencyKey });
}

/** Run a command and throw if it fails. */
export function must<R = unknown>(db: DB, actorId: string, name: string, input: unknown, idempotencyKey?: string): R {
  return mustRun<R>(db, actorId, name, input, { idempotencyKey });
}

/**
 * Run a simulated world event as the internal system actor, the way the
 * guided-demo runner does (origin "simulator"). User requests can never act
 * as "system" (src/server/commands/registry.ts).
 */
export function simulate<R = unknown>(db: DB, name: string, input: unknown): R {
  return mustRun<R>(db, "system", name, input, { origin: "simulator" });
}

/** Set the paused demo clock to a lab-local time on the demo day, e.g. at(db, "11:00"). */
export function clockAt(db: DB, hhmm: string, day = "2026-10-14"): void {
  setClock(db, labLocalToIso(day, hhmm), false);
}

export function tick(db: DB, minutes: number): void {
  advanceClock(db, minutes);
}

export function one<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): T {
  return db.prepare(sql).get(...params) as T;
}

export function all<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Staff ids from the seed. */
export const STAFF = {
  maya: "stf_maya", // accessioner
  luis: "stf_luis", // accessioner
  kim: "stf_kim", // accessioning lead
  dana: "stf_dana", // grosser
  sam: "stf_sam", // histology assistant
  priya: "stf_priya", // histotech
  marcus: "stf_marcus", // histotech
  tanya: "stf_tanya", // supervisor
  marsh: "stf_marsh", // dermatopathologist
  okafor: "stf_okafor",
  ferreira: "stf_ferreira",
  director: "stf_director", // read-only
  md: "stf_md", // medical director
} as const;
