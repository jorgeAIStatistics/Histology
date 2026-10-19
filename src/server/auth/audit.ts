/**
 * Audit events for sign-in, sign-out, locks and denials (secured mode), and
 * for the admin CLI. Written through the one append-only audit path
 * (src/server/core/audit.ts). Never records a token, a code, a nonce, a
 * session id or patient data: only staff ids, the issuer, a short hash of the
 * provider subject and a reason code.
 *
 * Actions: auth.signed_in, auth.reauthenticated, auth.handover, auth.denied,
 * auth.signed_out, auth.locked; admin.* (scripts/admin.ts).
 */
import { createHash } from "node:crypto";
import type { DB } from "../db/db";
import { audit } from "../core/audit";
import { makeCtx, SYSTEM_ACTOR, type Actor, type Origin } from "../core/context";
import type { Role } from "@/lib/roles";

/** Short, non-reversible reference to a provider subject for investigations (never the subject itself). */
export function subjectRef(subject: string | null | undefined): string | null {
  if (!subject) return null;
  return `sub-sha256:${createHash("sha256").update(subject).digest("hex").slice(0, 16)}`;
}

function staffActor(db: DB, staffId: string): Actor | null {
  const row = db.prepare("SELECT id, display_name, role FROM staff WHERE id = ?").get(staffId) as
    | { id: string; display_name: string; role: Role }
    | undefined;
  return row ? { id: row.id, name: row.display_name, role: row.role } : null;
}

export interface AuthAuditInput {
  action: string;
  /** The staff member the event is about (signed in, signed out, locked). Null for an unknown person. */
  staffId?: string | null;
  summary: string;
  reason?: string | null;
  details?: Record<string, unknown>;
  correlationId: string;
  /**
   * Who is recorded as acting: "staff" (the person's own sign-in, sign-out or
   * lock; origin "user") or "system" (denials and the admin CLI; origin
   * "system"). Default: "staff" when staffId names a known staff member.
   */
  actor?: "staff" | "system";
}

/** Appends one audit event. Never throws (an audit failure is logged, never shown to the person signing in). */
export function auditAuth(db: DB, input: AuthAuditInput): void {
  try {
    const staff = input.actor !== "system" && input.staffId ? staffActor(db, input.staffId) : null;
    const actor: Actor = staff ?? SYSTEM_ACTOR;
    const origin: Origin = staff ? "user" : "system";
    const ctx = makeCtx(db, actor, origin, input.correlationId);
    audit(ctx, {
      action: input.action,
      entityType: "auth",
      entityId: input.staffId ?? "unknown",
      summary: input.summary,
      reason: input.reason ?? null,
      after: input.details,
    });
  } catch (e) {
    console.error("[auth] audit failed", input.action, e instanceof Error ? e.message : e);
  }
}
