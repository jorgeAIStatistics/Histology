import { handleActivity } from "@/server/auth/flow";
import { sessionActorId, withRequestLog } from "@/server/ops/request-log";

/**
 * POST /api/auth/activity (same-origin)
 * Secured mode: user input on the open page (typing, pointer, scrolling) that
 * caused no request. Sent by the client at most about once a minute while the
 * person is working, so the server's idle lock follows real input. Background
 * polling never sends it. Returns { ok: true, result: { idleLocksAt } }, or
 * 401 SESSION_LOCKED / SESSION_EXPIRED / SIGN_IN_REQUIRED with no data.
 * Demo mode: 404. Locked build: 401.
 *
 * One structured `http.request` log line per request (route template only, never the query string, and the
 * session's staff id resolved read-only before the handler runs).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withRequestLog("/api/auth/activity", (req: Request) => handleActivity(req), { actor: sessionActorId });
