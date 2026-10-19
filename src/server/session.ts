import { cookies } from "next/headers";
import { getDb } from "@/server/db/db";
import { loadActor, type Actor } from "@/server/core/context";

/**
 * Demo role switch. The "Acting as" selector stores a staff id in a cookie so
 * the presenter can show each role's view. This is NOT authentication: there
 * is no sign-in, no password and no session security. Every command still
 * checks the role on the server (src/server/core/context.ts requirePermission).
 */
export const ACTOR_COOKIE = "hlos_actor";
export const DEFAULT_ACTOR_ID = "stf_maya";

const ACTOR_ID = /^[a-z0-9_]{1,64}$/i;

/** Staff id from the demo role cookie, or the default demo actor (Maya Torres, Accessioner). */
export async function getActorId(): Promise<string> {
  const store = await cookies();
  const value = store.get(ACTOR_COOKIE)?.value?.trim();
  return value && ACTOR_ID.test(value) ? value : DEFAULT_ACTOR_ID;
}

/**
 * The same demo actor, read from a request's Cookie header (route handlers;
 * testable without the Next.js request context). The value is only a demo
 * role selection: executeCommand still resolves it against active staff,
 * refuses the internal "system" actor for user requests, and checks the role.
 */
export function actorIdFromRequest(req: Request): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === ACTOR_COOKIE) {
      const value = decodeURIComponent(v.join("=")).trim();
      return ACTOR_ID.test(value) ? value : DEFAULT_ACTOR_ID;
    }
  }
  return DEFAULT_ACTOR_ID;
}

/** One correlation id per HTTP request: the caller's X-Request-Id when well formed, else a new UUID. Recorded on every audit event and receipt. */
export function correlationIdFor(req: Request): string {
  const given = req.headers.get("x-request-id")?.trim();
  return given && /^[A-Za-z0-9._:-]{8,100}$/.test(given) ? given : `req-${crypto.randomUUID()}`;
}

/** The current demo actor. Falls back to the default actor if the cookie names an unknown or inactive staff member. */
export async function getActor(): Promise<Actor> {
  const db = getDb();
  const id = await getActorId();
  try {
    return loadActor(db, id);
  } catch {
    return loadActor(db, DEFAULT_ACTOR_ID);
  }
}

/**
 * Light guard for state-changing demo endpoints: reject browser requests whose
 * Origin header names a different host. Returns a 403 Response, or null to proceed.
 */
export function rejectCrossOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (host && new URL(origin).host === host) return null;
  } catch {
    /* fall through */
  }
  return Response.json(
    { ok: false, error: { code: "FORBIDDEN", message: "Cross-origin requests are not accepted by this local demo." } },
    { status: 403 },
  );
}
