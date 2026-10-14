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

/** Staff id from the demo role cookie, or the default demo actor (Maya Torres, Accessioner). */
export async function getActorId(): Promise<string> {
  const store = await cookies();
  const value = store.get(ACTOR_COOKIE)?.value?.trim();
  return value && /^[a-z0-9_]{1,64}$/i.test(value) ? value : DEFAULT_ACTOR_ID;
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
