/**
 * Server-only data for the app shell and /api/live. Never import this file
 * from a client component (it opens the SQLite database).
 */
import { getDb, type DB } from "@/server/db/db";
import { readClock, type ClockState } from "@/server/core/clock";
import { currentViewer } from "@/server/auth/guard";
import type { RuntimeMode } from "@/server/runtime-mode";
import { hasBenchView, type Role } from "@/lib/roles";
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
  "lab_admin",
  "auditor",
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
  /** demo: every active staff member (the presenter's role switch). secured: ONLY the signed-in actor. Otherwise empty. */
  staff: ShellStaff[];
  counts: NavCounts;
  live: LivePayload;
  /** The runtime mode the shell was rendered in. */
  mode: RuntimeMode;
  /** False when no actor could be resolved (locked build, no or locked session): every other field is an empty placeholder. */
  signedIn: boolean;
}

/**
 * Placeholder for a shell without an actor (locked build, sign-in pages, a
 * locked or missing session): no staff, no counts, no clock, no sources. The
 * placeholder role ("auditor") holds no clinical permission, so any control
 * that consults it is disabled.
 */
const NO_ACTOR: ShellActor = { id: "", name: "Not signed in", role: "auditor" };
const EMPTY_LIVE: LivePayload = {
  auditSeq: 0,
  worklistSeq: 0,
  clock: { now: new Date(0).toISOString(), running: false, anchorDemo: "", anchorWall: "" },
  sources: [],
};
const NO_COUNTS: NavCounts = { intake: null, clarifications: null, materials: null, operations: null };

/**
 * Shell data through the one guard (src/server/auth/guard.ts). Never counts
 * as activity (the page's own guard does). Reads nothing from the lab
 * database unless an actor is resolved; in secured mode it sends only the
 * signed-in actor to the client, never the staff directory.
 */
export async function loadShellData(): Promise<ShellData> {
  const viewer = await currentViewer({ touch: false });
  if (!viewer.ok) {
    return { actor: NO_ACTOR, staff: [], counts: NO_COUNTS, live: EMPTY_LIVE, mode: viewer.mode, signedIn: false };
  }
  const db = getDb();
  const actor: ShellActor = { id: viewer.actor.id, name: viewer.actor.name, role: viewer.actor.role };
  // A role with no bench screen (laboratory administrator, auditor) gets no lab counts, clock or source health.
  const bench = hasBenchView(actor.role);
  return {
    actor,
    staff: viewer.mode === "demo" ? loadStaff(db) : [actor],
    counts: bench ? loadNavCounts(db) : NO_COUNTS,
    live: bench ? loadLiveSnapshot(db) : EMPTY_LIVE,
    mode: viewer.mode,
    signedIn: true,
  };
}
