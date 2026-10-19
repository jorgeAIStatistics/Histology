import type { DB } from "../db/db";
import type { Role, Permission } from "@/lib/roles";
import { roleCan, ROLE_LABEL, rolesFor, PERMISSION_LABEL } from "@/lib/roles";
import { DomainError } from "./errors";
import { demoNow } from "./clock";

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export type Origin = "user" | "system" | "simulator" | "assistant" | "import" | "demo";

/** Everything a domain operation needs. Pass it down; never use globals. */
export interface Ctx {
  db: DB;
  actor: Actor;
  origin: Origin;
  correlationId: string;
  /** Demo-clock time, fixed for the duration of one command. */
  now: string;
  /**
   * Secured-mode user commands only (set by executeCommand): whether the
   * session's last sign-in is within the re-authentication window. Operations
   * that must never run on a stale sign-in (hold release) refuse when it is
   * false, whichever command reached them. Undefined elsewhere (demo, system).
   */
  reauthFresh?: boolean;
}

export function makeCtx(db: DB, actor: Actor, origin: Origin = "user", correlationId?: string): Ctx {
  const now = demoNow(db);
  return { db, actor, origin, now, correlationId: correlationId ?? `c-${Date.now().toString(36)}` };
}

export function loadActor(db: DB, staffId: string): Actor {
  const row = db.prepare("SELECT id, display_name, role FROM staff WHERE id = ? AND active = 1").get(staffId) as
    | { id: string; display_name: string; role: Role }
    | undefined;
  if (!row) throw new DomainError("FORBIDDEN", "Unknown or inactive staff member");
  return { id: row.id, name: row.display_name, role: row.role };
}

/** The non-human actor used for simulator/system events. */
export const SYSTEM_ACTOR: Actor = { id: "system", name: "System", role: "supervisor" };

/** Server-side role check. */
export function requirePermission(ctx: Ctx, permission: Permission): void {
  if (ctx.origin === "simulator" || ctx.origin === "system" || ctx.origin === "import") return;
  if (!roleCan(ctx.actor.role, permission)) {
    const allowed = rolesFor(permission).map((r) => ROLE_LABEL[r]).join(", ");
    throw new DomainError(
      "FORBIDDEN",
      `Not allowed: ${ROLE_LABEL[ctx.actor.role]} cannot ${PERMISSION_LABEL[permission] ?? permission}. Allowed: ${allowed}.`,
      { permission, role: ctx.actor.role },
    );
  }
}
