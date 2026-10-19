import { handleSessionInfo } from "@/server/auth/flow";
import { sessionActorId, withRequestLog } from "@/server/ops/request-log";

/**
 * GET /api/auth/session
 * Secured mode: who is signed in, lock state, expiry and re-authentication
 * freshness, never patient data. A locked session reports { locked: true }
 * with no actor. Never counts as activity (safe to poll). 401 without a valid
 * session. Demo mode: { mode: "demo", signedIn: false }. Locked build: 401.
 * Response shape: src/server/auth/flow.ts handleSessionInfo.
 *
 * One structured `http.request` log line per request (route template only, never the query string, and the
 * session's staff id resolved read-only before the handler runs).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRequestLog("/api/auth/session", (req: Request) => handleSessionInfo(req), { actor: sessionActorId });
