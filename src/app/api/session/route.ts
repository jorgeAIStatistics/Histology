import { cookies } from "next/headers";
import { getDb } from "@/server/db/db";
import { loadActor } from "@/server/core/context";
import { isDemoMode } from "@/server/runtime-mode";
import { ACTOR_COOKIE, getActor, rejectCrossOrigin } from "@/server/session";

/**
 * DEMO role switch, not authentication. The "Acting as" selector posts a
 * staff id here and we remember it in a cookie. Anyone using this local demo
 * can pick any role; the server still checks permissions on every command.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getActor();
  return Response.json({ ok: true, actor }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  if (!isDemoMode()) {
    return Response.json(
      { ok: false, error: { code: "FORBIDDEN", message: "The demo role switch exists only in synthetic demo mode. This build has no sign-in." } },
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
