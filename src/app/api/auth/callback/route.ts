import { handleCallback } from "@/server/auth/flow";
import { withRequestLog } from "@/server/ops/request-log";

/**
 * GET /api/auth/callback?code=…&state=…
 * Secured mode: consumes the sign-in transaction once, validates the ID token
 * and signs in the LINKED staff member (links are never created here). Every
 * denial is audited (auth.denied) and lands on a plain page. See
 * src/server/auth/flow.ts. Demo mode: 404. Locked build: 401, no data.
 *
 * One structured `http.request` log line per request (route template only, never the query string; no actor id: the
 * person is not known until the sign-in completes, and the audit trail records it under the same correlation id).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRequestLog("/api/auth/callback", (req: Request) => handleCallback(req));
