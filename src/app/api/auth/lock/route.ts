import { handleLock } from "@/server/auth/flow";
import { sessionActorId, withRequestLog } from "@/server/ops/request-log";

/**
 * POST /api/auth/lock (same-origin)
 * Secured mode: locks this browser's session ("Lock" button or the client idle
 * timer). A locked session reads and writes nothing until the same person, or
 * someone else (workstation hand-over), signs in again.
 * Returns { ok: true, result: { locked: true } }. Demo mode: 404. Locked build: 401.
 *
 * One structured `http.request` log line per request (route template only, never the query string, and the
 * session's staff id resolved read-only before the handler runs).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withRequestLog("/api/auth/lock", (req: Request) => handleLock(req), { actor: sessionActorId });
