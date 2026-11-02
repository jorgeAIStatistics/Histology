/**
 * Laboratory administration operations behind scripts/admin.ts (the admin
 * CLI). Each operation runs in one transaction and writes one audit event
 * (origin "system", action admin.*), naming the local operator account that
 * ran the CLI. Identity links are created ONLY here: sign-in never links a
 * person automatically, and a provider job title never grants a role.
 *
 * Exports: linkIdentity, unlinkIdentity, setRole, deactivateStaff,
 * revokeSessions, listAdmin.
 */
import type { DB } from "../db/db";
import { ROLES, type Role } from "@/lib/roles";
import { auditAuth, subjectRef } from "./audit";
import { revokeAllForStaff } from "./sessions";

export class AdminError extends Error {}

export interface AdminContext {
  /** Who ran the command (the local OS account), recorded in the audit event. */
  operator: string;
  correlationId: string;
  now?: number;
}

function mustStaff(db: DB, staffId: string): { id: string; display_name: string; role: Role; active: number; lab_id: string } {
  const row = db.prepare("SELECT id, display_name, role, active, lab_id FROM staff WHERE id = ?").get(staffId) as
    | { id: string; display_name: string; role: Role; active: number; lab_id: string }
    | undefined;
  if (!row) throw new AdminError(`No staff member "${staffId}".`);
  return row;
}

function validIssuer(issuer: string): string {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new AdminError("--issuer must be the provider's issuer URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AdminError("--issuer must be an http(s) URL.");
  return issuer;
}

function system(db: DB, ctx: AdminContext, action: string, staffId: string | null, summary: string, details: Record<string, unknown>): void {
  auditAuth(db, { action, staffId, actor: "system", summary, details: { ...details, operator: ctx.operator }, correlationId: ctx.correlationId });
}

/** Links (lab, issuer, subject) to a staff member. Refuses a subject already linked to someone else. */
export function linkIdentity(db: DB, ctx: AdminContext, input: { staffId: string; issuer: string; subject: string; labId: string }): { relinked: boolean } {
  const issuer = validIssuer(input.issuer);
  const subject = input.subject.trim();
  if (!subject || subject.length > 255) throw new AdminError("--subject is required (at most 255 characters).");
  return db.transaction(() => {
    const staff = mustStaff(db, input.staffId);
    if (staff.active !== 1) throw new AdminError(`${staff.id} is not active.`);
    if (staff.lab_id !== input.labId) throw new AdminError(`${staff.id} belongs to ${staff.lab_id}, not ${input.labId}.`);
    const existing = db.prepare("SELECT id, staff_id, active FROM staff_identity WHERE lab_id = ? AND issuer = ? AND subject = ?").get(input.labId, issuer, subject) as
      | { id: number; staff_id: string; active: number }
      | undefined;
    if (existing?.active === 1 && existing.staff_id !== staff.id) {
      throw new AdminError(`That identity is already linked to ${existing.staff_id}. Unlink it first.`);
    }
    if (existing?.active === 1 && existing.staff_id === staff.id) return { relinked: false };
    const at = new Date(ctx.now ?? Date.now()).toISOString();
    if (existing) {
      db.prepare("UPDATE staff_identity SET staff_id = ?, active = 1, linked_by = ?, linked_at = ? WHERE id = ?").run(staff.id, ctx.operator, at, existing.id);
    } else {
      db.prepare("INSERT INTO staff_identity (lab_id, issuer, subject, staff_id, active, linked_by, linked_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(
        input.labId, issuer, subject, staff.id, ctx.operator, at,
      );
    }
    system(db, ctx, "admin.link_identity", staff.id, `Linked a sign-in identity to ${staff.display_name}`, { labId: input.labId, issuer, subject: subjectRef(subject) });
    return { relinked: Boolean(existing) };
  })();
}

/** Deactivates a link and revokes the sessions that used it. */
export function unlinkIdentity(db: DB, ctx: AdminContext, input: { issuer: string; subject: string; labId: string }): { staffId: string; sessionsRevoked: number } {
  const issuer = validIssuer(input.issuer);
  return db.transaction(() => {
    const row = db.prepare("SELECT id, staff_id FROM staff_identity WHERE lab_id = ? AND issuer = ? AND subject = ? AND active = 1").get(input.labId, issuer, input.subject) as
      | { id: number; staff_id: string }
      | undefined;
    if (!row) throw new AdminError("No active link for that identity in this lab.");
    db.prepare("UPDATE staff_identity SET active = 0 WHERE id = ?").run(row.id);
    const at = new Date(ctx.now ?? Date.now()).toISOString();
    const revoked = db
      .prepare("UPDATE auth_session SET revoked_at = ?, revoked_reason = 'identity_unlinked' WHERE staff_id = ? AND issuer = ? AND subject = ? AND revoked_at IS NULL")
      .run(at, row.staff_id, issuer, input.subject).changes;
    system(db, ctx, "admin.unlink_identity", row.staff_id, `Unlinked a sign-in identity from ${row.staff_id}`, {
      labId: input.labId, issuer, subject: subjectRef(input.subject), sessionsRevoked: revoked,
    });
    return { staffId: row.staff_id, sessionsRevoked: revoked };
  })();
}

/** Changes a staff member's role. Applies to their next request (roles are read on every request). */
export function setRole(db: DB, ctx: AdminContext, input: { staffId: string; role: string }): { from: Role; to: Role } {
  if (!(ROLES as readonly string[]).includes(input.role)) throw new AdminError(`Unknown role "${input.role}". Roles: ${ROLES.join(", ")}.`);
  const to = input.role as Role;
  return db.transaction(() => {
    const staff = mustStaff(db, input.staffId);
    if (staff.role === to) return { from: staff.role, to };
    db.prepare("UPDATE staff SET role = ? WHERE id = ?").run(to, staff.id);
    system(db, ctx, "admin.set_role", staff.id, `Role of ${staff.display_name} changed from ${staff.role} to ${to}`, { from: staff.role, to });
    return { from: staff.role, to };
  })();
}

/** Deactivates a staff member and revokes all their sessions. */
export function deactivateStaff(db: DB, ctx: AdminContext, input: { staffId: string }): { sessionsRevoked: number } {
  return db.transaction(() => {
    const staff = mustStaff(db, input.staffId);
    if (staff.active === 1) db.prepare("UPDATE staff SET active = 0 WHERE id = ?").run(staff.id);
    const revoked = revokeAllForStaff(db, staff.id, "staff_deactivated", ctx.now);
    system(db, ctx, "admin.deactivate_staff", staff.id, `Deactivated ${staff.display_name}`, { sessionsRevoked: revoked, wasActive: staff.active === 1 });
    return { sessionsRevoked: revoked };
  })();
}

/** Revokes every open session of a staff member (all workstations). */
export function revokeSessions(db: DB, ctx: AdminContext, input: { staffId: string }): { sessionsRevoked: number } {
  return db.transaction(() => {
    const staff = mustStaff(db, input.staffId);
    const revoked = revokeAllForStaff(db, staff.id, "admin_revoked", ctx.now);
    system(db, ctx, "admin.revoke_sessions", staff.id, `Revoked ${revoked} session(s) of ${staff.display_name}`, { sessionsRevoked: revoked });
    return { sessionsRevoked: revoked };
  })();
}

export interface AdminListing {
  staff: { id: string; name: string; role: Role; labId: string; active: boolean; identities: number; openSessions: number }[];
  identities: { labId: string; issuer: string; subject: string; staffId: string; active: boolean; linkedBy: string; linkedAt: string }[];
}

/** Staff, links and open-session counts (no session ids, no patient data). Read-only; also audited (admin.list). */
export function listAdmin(db: DB, ctx: AdminContext): AdminListing {
  const now = new Date(ctx.now ?? Date.now()).toISOString();
  const staff = (
    db
      .prepare(
        `SELECT s.id, s.display_name AS name, s.role, s.lab_id AS labId, s.active,
                (SELECT COUNT(*) FROM staff_identity i WHERE i.staff_id = s.id AND i.active = 1) AS identities,
                (SELECT COUNT(*) FROM auth_session a WHERE a.staff_id = s.id AND a.revoked_at IS NULL AND a.expires_at > ?) AS openSessions
           FROM staff s ORDER BY s.id`,
      )
      .all(now) as { id: string; name: string; role: Role; labId: string; active: number; identities: number; openSessions: number }[]
  ).map((r) => ({ ...r, active: r.active === 1 }));
  const identities = (
    db.prepare("SELECT lab_id AS labId, issuer, subject, staff_id AS staffId, active, linked_by AS linkedBy, linked_at AS linkedAt FROM staff_identity ORDER BY staff_id, id").all() as {
      labId: string; issuer: string; subject: string; staffId: string; active: number; linkedBy: string; linkedAt: string;
    }[]
  ).map((r) => ({ ...r, active: r.active === 1 }));
  system(db, ctx, "admin.list", null, "Listed staff, identity links and open sessions", { staff: staff.length, identities: identities.length });
  return { staff, identities };
}
