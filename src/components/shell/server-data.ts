/**
 * Server-only data for the app shell and /api/live. Never import this file
 * from a client component (it opens the SQLite database).
 */
import { getDb, type DB } from "@/server/db/db";
import { readClock, type ClockState } from "@/server/core/clock";
import { getActor } from "@/server/session";
import type { Role } from "@/lib/roles";
import type { LivePayload, LiveSource, NavCounts, ShellActor, ShellStaff } from "@/lib/client/types";

function safeNumber(db: DB, sql: string): number | null {
  try {
    const row = db.prepare(sql).get() as { n: number | null } | undefined;
    return row && typeof row.n === "number" ? row.n : 0;
  } catch (e) {
    console.error("[shell] count failed", sql, e);
    return null;
  }
}

function sumOrNull(...values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  return values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

export function loadSources(db: DB): LiveSource[] {
  try {
    return db
      .prepare(
        `SELECT s.id, s.name, s.adapter, s.tenant_id, t.name AS tenant_name, s.status,
                s.last_success_at, s.last_attempt_at, s.last_error
           FROM integration_source s
           LEFT JOIN source_tenant t ON t.id = s.tenant_id
          ORDER BY CASE WHEN s.tenant_id IS NULL THEN 1 ELSE 0 END, s.id`,
      )
      .all() as LiveSource[];
  } catch (e) {
    console.error("[shell] sources failed", e);
    return [];
  }
}

/** Counters + clock + sources, shared by the shell's first render and /api/live. */
export function loadLiveSnapshot(db: DB, clock: ClockState = readClock(db)): LivePayload {
  return {
    auditSeq: safeNumber(db, "SELECT COALESCE(MAX(seq), 0) AS n FROM audit_event") ?? 0,
    worklistSeq: safeNumber(db, "SELECT COALESCE(MAX(seq), 0) AS n FROM worklist_change") ?? 0,
    clock: { now: clock.now, running: clock.running, anchorDemo: clock.anchorDemo, anchorWall: clock.anchorWall },
    sources: loadSources(db),
  };
}

export function loadNavCounts(db: DB): NavCounts {
  return {
    intake: safeNumber(db, "SELECT COUNT(*) AS n FROM intake_item WHERE status IN ('received','in_review','ready_for_accession')"),
    clarifications: safeNumber(db, "SELECT COUNT(*) AS n FROM clarification WHERE state NOT IN ('resolved','canceled')"),
    materials: sumOrNull(
      safeNumber(db, "SELECT COUNT(*) AS n FROM print_job WHERE state = 'unknown_outcome'"),
      safeNumber(db, "SELECT COUNT(*) AS n FROM tray WHERE status IN ('exception')"),
    ),
    operations: safeNumber(db, "SELECT COUNT(*) AS n FROM hold WHERE status = 'active'"),
  };
}

const ROLE_ORDER: Role[] = [
  "accessioner",
  "accessioning_lead",
  "grosser",
  "histology_assistant",
  "histotech",
  "supervisor",
  "pathologist",
  "director",
  "medical_director",
];

export function loadStaff(db: DB): ShellStaff[] {
  try {
    const rows = db.prepare("SELECT id, display_name AS name, role FROM staff WHERE active = 1").all() as ShellStaff[];
    return rows.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
  } catch (e) {
    console.error("[shell] staff failed", e);
    return [];
  }
}

export interface ShellData {
  actor: ShellActor;
  staff: ShellStaff[];
  counts: NavCounts;
  live: LivePayload;
}

export async function loadShellData(): Promise<ShellData> {
  const db = getDb();
  const actor = await getActor();
  return {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    staff: loadStaff(db),
    counts: loadNavCounts(db),
    live: loadLiveSnapshot(db),
  };
}
