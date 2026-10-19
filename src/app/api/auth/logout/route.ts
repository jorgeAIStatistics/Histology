import { handleLogout } from "@/server/auth/flow";
import { sessionActorId, withRequestLog } from "@/server/ops/request-log";

/**
 * POST /api/auth/logout (same-origin)
 * Secured mode: revokes this browser's session, clears the cookie, audits
 * auth.signed_out and returns { ok: true, result: { signedOut, endSessionUrl } }
 * (endSessionUrl is the provider's RP-initiated logout URL when it advertises
 * one, else null). Demo mode: 404. Locked build: 401.
 *
 * One structured `http.request` log line per request (route template only, never the query string, and the
 * session's staff id resolved read-only before the handler runs).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withRequestLog("/api/auth/logout", (req: Request) => handleLogout(req), { actor: sessionActorId });
