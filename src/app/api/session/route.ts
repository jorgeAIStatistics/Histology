import { cookies } from "next/headers";
import { getDb } from "@/server/db/db";
import { loadActor } from "@/server/core/context";
import { isDemoMode } from "@/server/runtime-mode";
import { ACTOR_COOKIE, rejectCrossOrigin } from "@/server/session";
import { guardFailureResponse, requireApiActor } from "@/server/auth/guard";

/**
 * GET: the current actor through the one guard (demo: the demo role; secured:
 * the signed-in, unlocked session's staff member; locked: 401, no data). Never
 * counts as activity.
 *
 * POST: DEMO role switch, not authentication. The "Acting as" selector posts a
 * staff id here and we remember it in a cookie. Anyone using this local demo
 * can pick any role; the server still checks permissions on every command.
 * It does not exist outside synthetic demo mode (403).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireApiActor(req, { touch: false });
  if (!g.ok) return guardFailureResponse(g);
  return Response.json({ ok: true, actor: g.actor }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  if (!isDemoMode()) {
    return Response.json(
      { ok: false, error: { code: "FORBIDDEN", message: "The demo role switch exists only in synthetic demo mode." } },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  let staffId: unknown;
  try {
    staffId = ((await req.json()) as { staffId?: unknown })?.staffId;
  } catch {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Request body must be JSON with a staffId." } },
      { status: 400 },
    );
  }
  if (typeof staffId !== "string" || !/^[a-z0-9_]{1,64}$/i.test(staffId)) {
    return Response.json({ ok: false, error: { code: "VALIDATION", message: "staffId is missing or invalid." } }, { status: 400 });
  }

  let actor;
  try {
    actor = loadActor(getDb(), staffId);
  } catch {
    return Response.json(
      { ok: false, error: { code: "NOT_FOUND", message: `No active demo staff member "${staffId}".` } },
      { status: 404 },
    );
  }

  const store = await cookies();
  store.set(ACTOR_COOKIE, actor.id, {
    httpOnly: false, // readable by the demo UI; this cookie is not a credential
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true, actor }, { headers: { "Cache-Control": "no-store" } });
}
