/**
 * Server-side sessions for the secured mode (SQLite table auth_session).
 *
 * - The session id is 32 random bytes (256 bits), base64url, kept ONLY in the
 *   HttpOnly cookie. The database stores its SHA-256 (id_hash), so a copy of
 *   the database does not hold usable session ids.
 * - Every time here is the REAL wall clock (Date.now(), or an explicit `now`
 *   in milliseconds for tests), never the demo clock.
 * - Role, active status and lab are read from the staff table on EVERY
 *   resolution, so a role change or a deactivation applies to the next request.
 *
 * Exports (all synchronous; better-sqlite3):
 * - createSession(db, input, policy, now?)           -> { cookieValue, idHash, expiresAt }
 * - resolveSession(db, cookieValue, { touch, policy, now? }) -> { ok: true, session, staff } | { ok: false, reason, session? }
 * - touchSession(db, idHash, now?)                    records user-driven activity
 * - lockSession(db, idHash, now?)                     manual lock (idempotent)
 * - unlockAfterReauth(db, idHash, input, now?)        same person signed in again: new auth_time, unlocked
 * - revokeSession(db, idHash, reason, now?)
 * - revokeAllForStaff(db, staffId, reason, now?)      -> number revoked (admin CLI)
 * - isReauthFresh(session | authTimeIso, policy, now?) sensitive-command freshness
 * - peekSession(db, cookieValue)                      raw row, no checks (sign-in / sign-out bookkeeping only)
 * - hashSessionId(id), sessionPolicyFromEnv()
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DB } from "../db/db";
import type { Role } from "@/lib/roles";
import { authConfig } from "./config";

export interface SessionPolicy {
  /** HLOS_LAB_ID: a session and its staff member must belong to this lab. */
  labId: string;
  /** Idle minutes before the session locks (HLOS_SESSION_IDLE_MIN). */
  idleMinutes: number;
  /** Absolute lifetime in hours (HLOS_SESSION_MAX_HOURS). */
  maxHours: number;
  /** Re-authentication freshness for sensitive commands, minutes (HLOS_REAUTH_MAX_AGE_MIN). */
  reauthMaxAgeMinutes: number;
}

/** The policy from the validated environment, or null when the secured configuration is invalid. */
export function sessionPolicyFromEnv(): SessionPolicy | null {
  const cfg = authConfig();
  if (!cfg.ok) return null;
  const { labId, idleMinutes, maxHours, reauthMaxAgeMinutes } = cfg.config;
  return { labId, idleMinutes, maxHours, reauthMaxAgeMinutes };
}

export interface SessionRow {
  id_hash: string;
  staff_id: string;
  lab_id: string;
  issuer: string;
  subject: string;
  auth_time: string;
  created_at: string;
  last_activity_at: string;
  expires_at: string;
  locked_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  user_agent_hash: string | null;
}

/** What callers may know about a session (no id, no hash of the user agent). */
export interface SessionInfo {
  idHash: string;
  staffId: string;
  labId: string;
  issuer: string;
  subject: string;
  /** Last authentication at the provider (ISO). */
  authTime: string;
  createdAt: string;
  lastActivityAt: string;
  /** Absolute expiry (ISO). */
  expiresAt: string;
  /** When the idle lock applies without further activity (ISO). */
  idleLocksAt: string;
  lockedAt: string | null;
}

export interface SessionStaff {
  id: string;
  name: string;
  role: Role;
}

export type SessionFailureReason =
  | "missing" // no cookie
  | "unknown" // malformed or not in the database
  | "revoked" // signed out, replaced by another person's sign-in, or revoked by an administrator
  | "expired" // absolute lifetime reached
  | "locked" // locked by the user (or earlier by the idle timer)
  | "idle_locked" // locked now: no user-driven request within the idle window
  | "wrong_lab" // the session or the staff member belongs to another lab
  | "staff_inactive" // the staff member was deactivated (or removed)
  | "identity_unlinked"; // the (issuer, subject) link was removed or now points elsewhere

export type ResolveResult =
  | { ok: true; session: SessionInfo; staff: SessionStaff }
  | {
      ok: false;
      reason: SessionFailureReason;
      /** Present for "locked", "idle_locked" and "expired" (lock state and expiry for the session endpoint). */
      session?: SessionInfo;
    };

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

const iso = (ms: number) => new Date(ms).toISOString();

function toInfo(row: SessionRow, policy: SessionPolicy): SessionInfo {
  return {
    idHash: row.id_hash,
    staffId: row.staff_id,
    labId: row.lab_id,
    issuer: row.issuer,
    subject: row.subject,
    authTime: row.auth_time,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    idleLocksAt: iso(Date.parse(row.last_activity_at) + policy.idleMinutes * 60_000),
    lockedAt: row.locked_at,
  };
}

export interface CreateSessionInput {
  staffId: string;
  labId: string;
  issuer: string;
  subject: string;
  /** When the person authenticated at the provider (ms since epoch). */
  authTimeMs: number;
  userAgent?: string | null;
  /** HLOS_SESSION_SECRET: keys the user-agent HMAC (no plain user agent is stored). */
  secret?: string;
}

/** Creates a session and returns the cookie value (the only copy of the id). */
export function createSession(db: DB, input: CreateSessionInput, policy: SessionPolicy, now: number = Date.now()): { cookieValue: string; idHash: string; expiresAt: string } {
  const cookieValue = randomBytes(32).toString("base64url");
  const idHash = hashSessionId(cookieValue);
  const expiresAt = iso(now + policy.maxHours * 3_600_000);
  const uaHash = input.userAgent && input.secret ? createHmac("sha256", input.secret).update(`ua:${input.userAgent}`).digest("hex") : null;
  db.prepare(
    `INSERT INTO auth_session (id_hash, staff_id, lab_id, issuer, subject, auth_time, created_at, last_activity_at, expires_at, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(idHash, input.staffId, input.labId, input.issuer, input.subject, iso(input.authTimeMs), iso(now), iso(now), expiresAt, uaHash);
  return { cookieValue, idHash, expiresAt };
}

/** The raw row for a cookie value (no validity checks). For sign-in and sign-out bookkeeping only. */
export function peekSession(db: DB, cookieValue: string | null | undefined): SessionRow | undefined {
  if (!cookieValue || !SESSION_ID.test(cookieValue)) return undefined;
  return db.prepare("SELECT * FROM auth_session WHERE id_hash = ?").get(hashSessionId(cookieValue)) as SessionRow | undefined;
}

/**
 * Resolves a session cookie. In order: present and known, not revoked, not
 * past its absolute expiry, this lab, staff member active in this lab,
 * identity link still active and pointing at the same staff member, not
 * locked, not idle past the window (which locks it now). A session that fails
 * the lab, staff or link checks is revoked on the spot. With `touch: true` a
 * successful resolution records user-driven activity (page loads and
 * commands); background polling passes `touch: false`.
 */
export function resolveSession(
  db: DB,
  cookieValue: string | null | undefined,
  opts: { touch: boolean; policy: SessionPolicy; now?: number },
): ResolveResult {
  const now = opts.now ?? Date.now();
  const { policy } = opts;
  if (!cookieValue) return { ok: false, reason: "missing" };
  const row = peekSession(db, cookieValue);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (now >= Date.parse(row.expires_at)) return { ok: false, reason: "expired", session: toInfo(row, policy) };
  if (row.lab_id !== policy.labId) {
    revokeSession(db, row.id_hash, "wrong_lab", now);
    return { ok: false, reason: "wrong_lab" };
  }
  const staff = db.prepare("SELECT id, display_name, role, active, lab_id FROM staff WHERE id = ?").get(row.staff_id) as
    | { id: string; display_name: string; role: Role; active: number; lab_id: string }
    | undefined;
  if (!staff || staff.active !== 1) {
    revokeSession(db, row.id_hash, "staff_inactive", now);
    return { ok: false, reason: "staff_inactive" };
  }
  if (staff.lab_id !== policy.labId) {
    revokeSession(db, row.id_hash, "wrong_lab", now);
    return { ok: false, reason: "wrong_lab" };
  }
  const link = db
    .prepare("SELECT staff_id FROM staff_identity WHERE lab_id = ? AND issuer = ? AND subject = ? AND active = 1")
    .get(policy.labId, row.issuer, row.subject) as { staff_id: string } | undefined;
  if (!link || link.staff_id !== row.staff_id) {
    revokeSession(db, row.id_hash, "identity_unlinked", now);
    return { ok: false, reason: "identity_unlinked" };
  }
  if (row.locked_at) return { ok: false, reason: "locked", session: toInfo(row, policy) };
  if (now - Date.parse(row.last_activity_at) >= policy.idleMinutes * 60_000) {
    db.prepare("UPDATE auth_session SET locked_at = ? WHERE id_hash = ? AND locked_at IS NULL").run(iso(now), row.id_hash);
    return { ok: false, reason: "idle_locked", session: toInfo({ ...row, locked_at: iso(now) }, policy) };
  }
  let current = row;
  if (opts.touch) {
    touchSession(db, row.id_hash, now);
    current = { ...row, last_activity_at: iso(now) };
  }
  return { ok: true, session: toInfo(current, policy), staff: { id: staff.id, name: staff.display_name, role: staff.role } };
}

/** Records user-driven activity (never called for background polling). */
export function touchSession(db: DB, idHash: string, now: number = Date.now()): void {
  db.prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ? AND revoked_at IS NULL AND locked_at IS NULL").run(iso(now), idHash);
}

/** Locks a session (the user's "Lock" or the client idle timer). Idempotent; returns whether a row changed. */
export function lockSession(db: DB, idHash: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE auth_session SET locked_at = ? WHERE id_hash = ? AND locked_at IS NULL AND revoked_at IS NULL").run(iso(now), idHash).changes > 0;
}

/** The same person authenticated again: records the new auth_time and unlocks. The absolute expiry is unchanged. */
export function unlockAfterReauth(
  db: DB,
  idHash: string,
  input: { authTimeMs: number; issuer: string; subject: string },
  now: number = Date.now(),
): boolean {
  return (
    db
      .prepare(
        "UPDATE auth_session SET auth_time = ?, issuer = ?, subject = ?, locked_at = NULL, last_activity_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
      )
      .run(iso(input.authTimeMs), input.issuer, input.subject, iso(now), idHash).changes > 0
  );
}

export function revokeSession(db: DB, idHash: string, reason: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE auth_session SET revoked_at = ?, revoked_reason = ? WHERE id_hash = ? AND revoked_at IS NULL").run(iso(now), reason, idHash).changes > 0;
}

/** Revokes every open session of a staff member (all workstations). Returns how many were revoked. */
export function revokeAllForStaff(db: DB, staffId: string, reason: string, now: number = Date.now()): number {
  return db.prepare("UPDATE auth_session SET revoked_at = ?, revoked_reason = ? WHERE staff_id = ? AND revoked_at IS NULL").run(iso(now), reason, staffId).changes;
}

/**
 * Whether the last authentication is recent enough for a sensitive command
 * (auth_time within HLOS_REAUTH_MAX_AGE_MIN of now).
 */
export function isReauthFresh(session: { authTime: string } | string, policy: Pick<SessionPolicy, "reauthMaxAgeMinutes">, now: number = Date.now()): boolean {
  const authTime = Date.parse(typeof session === "string" ? session : session.authTime);
  if (!Number.isFinite(authTime)) return false;
  return now - authTime <= policy.reauthMaxAgeMinutes * 60_000;
}

/** When the current re-authentication stops being fresh (ISO). */
export function reauthFreshUntil(authTimeIso: string, policy: Pick<SessionPolicy, "reauthMaxAgeMinutes">): string {
  return iso(Date.parse(authTimeIso) + policy.reauthMaxAgeMinutes * 60_000);
}
