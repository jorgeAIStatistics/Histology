/**
 * Types shared between the server shell loader, /api/live and client
 * components. Type-only: safe to import anywhere.
 */
import type { Role } from "@/lib/roles";

export interface ClockSnapshot {
  /** Demo-clock time (UTC ISO). */
  now: string;
  running: boolean;
  anchorDemo: string;
  anchorWall: string;
}

export interface LiveSource {
  id: string;
  name: string;
  adapter: string;
  tenant_id: string | null;
  /** Tenant display name, e.g. "EMA-SIM Sunrise Coast" (null for printer/notification/assistant connectors). */
  tenant_name: string | null;
  /** connected | degraded | offline */
  status: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

/** Payload of GET /api/live. */
export interface LivePayload {
  auditSeq: number;
  worklistSeq: number;
  clock: ClockSnapshot;
  sources: LiveSource[];
  /** Number of simulated source events delivered by this poll (0 when nothing was due). */
  delivered?: number;
}

export interface ShellActor {
  id: string;
  name: string;
  role: Role;
}

export interface ShellStaff {
  id: string;
  name: string;
  role: Role;
}

/** Nav counts. `null` = could not be computed (shown as no count, never as 0). */
export interface NavCounts {
  intake: number | null;
  clarifications: number | null;
  materials: number | null;
  operations: number | null;
}
