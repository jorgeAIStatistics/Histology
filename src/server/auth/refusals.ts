/**
 * Audit of refusals of SIGNED-IN users in secured mode (Stage 6 security review, finding 7).
 *
 * A person who is signed in, unlocked and linked can still be refused:
 *
 *   kind              | when                                                         | target          | recorded as
 *   ------------------|--------------------------------------------------------------|-----------------|---------------
 *   reauth_required   | a sensitive command with a stale sign-in (401 REAUTH_REQUIRED) | the command     | auth.refused
 *   view_denied       | a page, read API or export the role may not open (403, or     | the view        | auth.refused
 *                     | the /forbidden page)                                         | permission      |
 *   forbidden         | a command the role may not run (403 FORBIDDEN)               | the command     | command.denied
 *
 * Each is written through the one append-only, sealed audit path, as the person (origin "user"), with the
 * permission involved and the session reference (never the session id or its hash). NO REQUEST CONTENT is
 * recorded: no input, no typed text, no record id, no query string; only the kind, the target and a count.
 *
 * Rate limit: at most ONE event per database, staff member, kind and target per REFUSAL_WINDOW_MS. A refusal
 * inside the window is not written; it is counted, and the next event written for the same key carries
 * `skipped`: how many identical refusals were not recorded one by one since the previous event. (Every request,
 * recorded or skipped, still has its own structured `http.request` log line with the status and error code.)
 * The window is kept in this process's memory: each server process applies it on its own, and a restart starts
 * a new window.
 *
 * Not covered here, deliberately: refusals that END a session or never had one (no session, expired, locked,
 * revoked, wrong lab, deactivated, unlinked: the person is not signed in any more), the hand-over refusal
 * (ACTOR_MISMATCH: the screen was opened for someone else; nothing is attempted as the signed-in person), and
 * background polling (/api/live answers 403 to a role with no bench screen on every poll; it is not the person
 * asking for anything).
 */
import type { DB } from "../db/db";
import type { Permission } from "@/lib/roles";
import { audit } from "../core/audit";
import { sessionRefFor } from "../core/audit-seal";
import { loadActor, makeCtx } from "../core/context";
import { log } from "../core/log";

export const REFUSAL_WINDOW_MS = 60_000;

export type RefusalKind = "reauth_required" | "view_denied" | "forbidden";

type Seen = Map<string, { at: number; skipped: number }>;

function seen(): Seen {
  const g = globalThis as typeof globalThis & { __hlosRefusals?: Seen };
  return (g.__hlosRefusals ??= new Map());
}

/**
 * The rate limit. Returns null when this refusal falls inside the window of the last recorded one for the same
 * key (it is counted, not recorded), else the number of refusals skipped since that one (0 for the first).
 */
export function refusalGate(db: DB, staffId: string, kind: RefusalKind, target: string, now: number = Date.now()): { skipped: number } | null {
  const map = seen();
  const key = [db.name, staffId, kind, target].join("\n");
  const last = map.get(key);
  if (last && now >= last.at && now - last.at < REFUSAL_WINDOW_MS) {
    last.skipped += 1;
    return null;
  }
  if (map.size > 5000) map.clear(); // bounded memory: keys are staff x a fixed vocabulary of kinds and targets
  map.set(key, { at: now, skipped: 0 });
  return { skipped: last?.skipped ?? 0 };
}

const SUMMARY: Record<Exclude<RefusalKind, "forbidden">, (target: string) => string> = {
  reauth_required: (t) => `Refused: ${t} needs a recent sign-in (re-authentication required); nothing was recorded`,
  view_denied: (t) => `Refused: this role cannot open ${t}; nothing was shown`,
};

export interface SignedInRefusal {
  /** The signed-in staff member who was refused. */
  staffId: string;
  kind: Exclude<RefusalKind, "forbidden">;
  /** The command name (reauth_required) or the view permission (view_denied). */
  target: string;
  /** The permission involved: the command's permission, or the view permission. */
  permission: Permission | null;
  /** sha256 of the session id (the session reference is derived from it; neither is stored). */
  sessionIdHash: string;
  correlationId: string;
  now?: number;
}

/** Records one auth.refused event, rate-limited (see above). Never throws: an audit failure is logged. */
export function auditSignedInRefusal(db: DB, r: SignedInRefusal): void {
  try {
    const gate = refusalGate(db, r.staffId, r.kind, r.target, r.now);
    if (!gate) return;
    const ctx = makeCtx(db, loadActor(db, r.staffId), "user", r.correlationId);
    ctx.permission = r.permission;
    ctx.sessionRef = sessionRefFor(r.sessionIdHash);
    audit(ctx, {
      action: "auth.refused",
      entityType: "auth",
      entityId: r.staffId,
      summary: SUMMARY[r.kind](r.target),
      reason: r.kind,
      after: { kind: r.kind, target: r.target, skipped: gate.skipped, windowSeconds: REFUSAL_WINDOW_MS / 1000 },
    });
  } catch (e) {
    log("error", "auth.refusal_audit_failed", { correlationId: r.correlationId, kind: r.kind, error: e });
  }
}
